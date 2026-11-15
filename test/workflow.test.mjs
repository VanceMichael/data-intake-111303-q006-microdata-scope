import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractMicrodata } from '../src/microdata.mjs';
import { applyContribution, createLedger, markPageError, materialize, withdrawPage } from '../src/ledger.mjs';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

const PAGE_URL = 'http://source.test/page';
const extract = (html, pageKey = '/page') => extractMicrodata(html, { pageUrl: PAGE_URL, pageKey });
const valuesOf = (result, entityId, property) => {
  const entity = result.items.find(item => item.entity === entityId);
  assert.ok(entity, `缺少实体 ${entityId}`);
  return result.assertions.filter(a => a.subject === entityId && a.property === property);
};

test('取值规则：meta 取 content、a/link 取 href、time 取 datetime、其他取文本', () => {
  const result = extract(`<div itemscope itemid="urn:v">
    <meta itemprop="code" content="X-1">
    <a itemprop="manual" href="./m">说明</a>
    <link itemprop="related" href="/r?x=1">
    <a itemprop="external" href="https://other.test/x">外部</a>
    <time itemprop="since" datetime="2024-01-02">页面上的一月二日</time>
    <time itemprop="noted">2023 年记录</time>
    <span itemprop="name">探头</span>
  </div>`);
  assert.equal(valuesOf(result, 'urn:v', 'code')[0].value, 'X-1');
  assert.equal(valuesOf(result, 'urn:v', 'code')[0].via, 'content');
  // 相对 URL 按页面基址解析，本站输出绝对路径
  assert.equal(valuesOf(result, 'urn:v', 'manual')[0].value, '/m');
  assert.equal(valuesOf(result, 'urn:v', 'related')[0].value, '/r?x=1');
  // 站外 URL 保留完整地址
  assert.equal(valuesOf(result, 'urn:v', 'external')[0].value, 'https://other.test/x');
  assert.equal(valuesOf(result, 'urn:v', 'since')[0].value, '2024-01-02');
  assert.equal(valuesOf(result, 'urn:v', 'since')[0].via, 'datetime');
  assert.equal(valuesOf(result, 'urn:v', 'noted')[0].value, '2023 年记录');
  assert.equal(valuesOf(result, 'urn:v', 'name')[0].value, '探头');
});

test('base 元素改变相对 URL 的解析基址', () => {
  const result = extract(`<base href="/docs/"><div itemscope itemid="urn:b"><a itemprop="manual" href="m">说明</a></div>`);
  assert.equal(valuesOf(result, 'urn:b', 'manual')[0].value, '/docs/m');
});

test('嵌套实体作为关系保留：生产单位地址不进入仪器安装地点', () => {
  const result = extract(`<article itemscope itemtype="Instrument" itemid="urn:ins:1">
    <span itemprop="location">乙地</span>
    <div itemprop="manufacturer" itemscope itemtype="Organization"><span itemprop="address">甲地</span></div>
  </article>`);
  assert.deepEqual(valuesOf(result, 'urn:ins:1', 'location').map(a => a.value), ['乙地']);
  assert.equal(valuesOf(result, 'urn:ins:1', 'address').length, 0);
  const relation = result.assertions.find(a => a.subject === 'urn:ins:1' && a.property === 'manufacturer');
  assert.equal(relation.valueType, 'ref');
  assert.deepEqual(valuesOf(result, relation.target, 'address').map(a => a.value), ['甲地']);
  assert.equal(result.items.find(item => item.entity === relation.target).anonymous, true);
});

test('同页并列的推荐仪器各自成实体，互不串值', () => {
  const result = extract(`<section>
    <div itemscope itemid="urn:main"><span itemprop="name">主机</span><span itemprop="location">甲地</span></div>
    <aside><div itemscope itemid="urn:rec"><span itemprop="name">推荐机</span><span itemprop="location">乙地</span></div></aside>
  </section>`);
  assert.deepEqual(valuesOf(result, 'urn:main', 'name').map(a => a.value), ['主机']);
  assert.deepEqual(valuesOf(result, 'urn:main', 'location').map(a => a.value), ['甲地']);
  assert.deepEqual(valuesOf(result, 'urn:rec', 'location').map(a => a.value), ['乙地']);
});

test('itemref 引用卡片外元素：直接属性与容器后代都并入引用实体', () => {
  const result = extract(`<div itemscope itemid="urn:r" itemref="extra direct"><span itemprop="name">甲</span></div>
    <div id="extra"><a itemprop="manual" href="./manual">说明</a></div>
    <b id="direct" itemprop="tag">水质</b>`);
  assert.deepEqual(valuesOf(result, 'urn:r', 'manual').map(a => a.value), ['/manual']);
  assert.deepEqual(valuesOf(result, 'urn:r', 'tag').map(a => a.value), ['水质']);
});

test('重复引用只处理一次，多值不丢；诊断可解释', () => {
  const result = extract(`<div itemscope itemid="urn:i" itemref="x x"><span itemprop="tag">甲</span></div>
    <div id="x"><span itemprop="tag">乙</span></div>`);
  assert.deepEqual(valuesOf(result, 'urn:i', 'tag').map(a => a.value), ['甲', '乙']);
  assert.ok(result.diagnostics.some(d => d.kind === 'itemref-dedup'));
});

test('引用环终止：itemref 指回祖先时每个元素只处理一次', () => {
  const result = extract(`<div id="wrap"><div itemscope itemid="urn:c" itemref="wrap"><span itemprop="name">甲</span></div></div>`);
  assert.deepEqual(valuesOf(result, 'urn:c', 'name').map(a => a.value), ['甲']);
  assert.ok(result.diagnostics.some(d => d.kind === 'itemref-dedup'));
});

test('itemref 指向不存在的 id：记录诊断，不影响其余属性', () => {
  const result = extract(`<div itemscope itemid="urn:m" itemref="missing"><span itemprop="name">甲</span></div>`);
  assert.deepEqual(valuesOf(result, 'urn:m', 'name').map(a => a.value), ['甲']);
  assert.ok(result.diagnostics.some(d => d.kind === 'itemref-unresolved' && d.id === 'missing'));
});

test('一个元素上的多个属性名分别落值，共享同一证据位置', () => {
  const result = extract(`<div itemscope itemid="urn:multi" itemref="e"><span id="e" itemprop="tag category">水质</span></div>`);
  const tag = valuesOf(result, 'urn:multi', 'tag')[0];
  const category = valuesOf(result, 'urn:multi', 'category')[0];
  assert.equal(tag.value, '水质');
  assert.equal(category.value, '水质');
  assert.equal(tag.locator.path, category.locator.path);
});

test('匿名实体不因属性相同而合并：同页两个同值实体各自独立', () => {
  const result = extract(`<div itemscope><span itemprop="name">同名</span></div><div itemscope><span itemprop="name">同名</span></div>`);
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].entity, result.items[1].entity);
  assert.ok(result.items.every(item => item.anonymous));
});

test('无效 itemid 降级为匿名实体并记录诊断', () => {
  const result = extract(`<div itemscope itemid="http://[bad"><span itemprop="name">甲</span></div>`);
  assert.equal(result.items[0].anonymous, true);
  assert.ok(result.diagnostics.some(d => d.kind === 'itemid-invalid'));
});

test('证据定位：每个值带页面内路径、行列与原文片段', () => {
  const result = extract(`<div itemscope itemid="urn:loc"><span itemprop="name">探头</span></div>`);
  const assertion = valuesOf(result, 'urn:loc', 'name')[0];
  assert.equal(assertion.page, '/page');
  assert.ok(assertion.locator.path.endsWith('span'));
  assert.equal(assertion.locator.line, 1);
  assert.ok(assertion.locator.snippet.includes('探头'));
});

test('账本：跨页相同 itemid 汇入同一实体，矛盾值带来源并存', () => {
  const ledger = createLedger();
  applyContribution(ledger, '/a', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">甲地</span></div>`, { pageUrl: PAGE_URL, pageKey: '/a' }));
  applyContribution(ledger, '/b', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">乙地</span></div>`, { pageUrl: PAGE_URL, pageKey: '/b' }));
  const graph = materialize(ledger);
  const entity = graph.entities.find(item => item.id === 'urn:x');
  assert.deepEqual([...entity.properties.location].sort(), ['乙地', '甲地'].sort());
  const sources = graph.evidence.filter(e => e.entity === 'urn:x' && e.property === 'location').map(e => `${e.page}:${e.value}`).sort();
  assert.deepEqual(sources, ['/a:甲地', '/b:乙地']);
  assert.equal(graph.crossPageEdges, 0);
});

test('账本：页面更正只替换该页贡献，其他页的值与关系保留', () => {
  const ledger = createLedger();
  const org = '<div itemprop="manufacturer" itemscope itemtype="Organization"><span itemprop="name">乙厂</span></div>';
  applyContribution(ledger, '/a', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">甲地</span></div>`, { pageUrl: PAGE_URL, pageKey: '/a' }));
  applyContribution(ledger, '/b', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">乙地</span>${org}</div>`, { pageUrl: PAGE_URL, pageKey: '/b' }));
  // /a 更正：甲地 -> 丙地
  applyContribution(ledger, '/a', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">丙地</span></div>`, { pageUrl: PAGE_URL, pageKey: '/a' }));
  let graph = materialize(ledger);
  let entity = graph.entities.find(item => item.id === 'urn:x');
  assert.deepEqual([...entity.properties.location].sort(), ['丙地', '乙地'].sort());
  // /a 撤下：只撤销 /a 的贡献
  withdrawPage(ledger, '/a', { httpStatus: 404 });
  graph = materialize(ledger);
  entity = graph.entities.find(item => item.id === 'urn:x');
  assert.deepEqual(entity.properties.location, ['乙地']);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].property, 'manufacturer');
  assert.equal(graph.anonymousCount, 1);
});

test('账本：读取失败不等于不存在，保留既有贡献并标记未刷新', () => {
  const ledger = createLedger();
  applyContribution(ledger, '/a', extractMicrodata(`<div itemscope itemid="urn:x"><span itemprop="location">甲地</span></div>`, { pageUrl: PAGE_URL, pageKey: '/a' }));
  const { kept } = markPageError(ledger, '/a', { error: 'HTTP 500' });
  assert.equal(kept, true);
  const graph = materialize(ledger);
  assert.deepEqual(graph.entities.find(item => item.id === 'urn:x').properties.location, ['甲地']);
});

test('账本：跨页同名 DOM id 互不影响，匿名实体不跨页串联', () => {
  const ledger = createLedger();
  applyContribution(ledger, '/one', extractMicrodata(`<div itemscope itemref="x"><span itemprop="name">一号</span></div><b id="x" itemprop="tag">甲</b>`, { pageUrl: PAGE_URL, pageKey: '/one' }));
  applyContribution(ledger, '/two', extractMicrodata(`<div itemscope itemref="x"><span itemprop="name">二号</span></div><b id="x" itemprop="tag">乙</b>`, { pageUrl: PAGE_URL, pageKey: '/two' }));
  const graph = materialize(ledger);
  assert.equal(graph.anonymousCount, 2);
  assert.equal(graph.crossPageEdges, 0);
  const one = graph.entities.find(item => item.id === 'page:/one#item0');
  const two = graph.entities.find(item => item.id === 'page:/two#item0');
  assert.deepEqual(one.properties.tag, ['甲']);
  assert.deepEqual(two.properties.tag, ['乙']);
});

async function withSource(scenario, fn) {
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-test-'));
  try {
    return await fn(source, stateDir);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('工作流：单页错误被隔离，不拖垮整批，结果不伪称完成', async () => {
  await withSource({
    name: '错误隔离',
    routes: [
      { path: '/good', body: '<div itemscope itemid="urn:ok"><span itemprop="name">好页</span></div>', contentType: 'text/html' },
      { path: '/bad', status: 500, body: '来源内部错误' },
    ],
  }, async (source, stateDir) => {
    const result = await run({ source: source.url, stateDir, input: { pages: ['/good', '/bad'] } });
    assert.equal(result.complete, false);
    assert.equal(result.pages.find(p => p.path === '/bad').status, 'error');
    assert.deepEqual(result.entities.find(item => item.id === 'urn:ok').properties.name, ['好页']);
  });
});

test('工作流：页面先成功后失败，既有贡献保留为未刷新', async () => {
  await withSource({
    name: '失败保留',
    routes: [
      { path: '/a', replies: [
        { body: '<div itemscope itemid="urn:x"><span itemprop="location">甲地</span></div>', contentType: 'text/html' },
        { status: 500, body: '暂时故障' },
      ] },
    ],
  }, async (source, stateDir) => {
    const first = await run({ source: source.url, stateDir, input: { pages: ['/a'] } });
    assert.equal(first.complete, true);
    const second = await run({ source: source.url, stateDir, input: { pages: ['/a'] } });
    assert.equal(second.complete, false);
    assert.equal(second.pages[0].keptPrevious, true);
    assert.deepEqual(second.entities.find(item => item.id === 'urn:x').properties.location, ['甲地']);
    assert.equal(second.trackedPages['/a'].status, 'stale');
  });
});

test('工作流：页面撤下（404）只撤销该页贡献', async () => {
  await withSource({
    name: '撤下',
    routes: [
      { path: '/a', replies: [
        { body: '<div itemscope itemid="urn:x"><span itemprop="location">甲地</span></div>', contentType: 'text/html' },
        { status: 404, body: '已撤下' },
      ] },
      { path: '/b', body: '<div itemscope itemid="urn:x"><span itemprop="location">乙地</span></div>', contentType: 'text/html' },
    ],
  }, async (source, stateDir) => {
    const first = await run({ source: source.url, stateDir, input: { pages: ['/a', '/b'] } });
    assert.deepEqual([...first.entities.find(item => item.id === 'urn:x').properties.location].sort(), ['乙地', '甲地'].sort());
    const second = await run({ source: source.url, stateDir, input: { pages: ['/a', '/b'] } });
    assert.equal(second.pages.find(p => p.path === '/a').status, 'withdrawn');
    assert.deepEqual(second.entities.find(item => item.id === 'urn:x').properties.location, ['乙地']);
    const sources = second.evidence.filter(e => e.entity === 'urn:x' && e.property === 'location').map(e => e.page);
    assert.deepEqual(sources, ['/b']);
  });
});

test('工作流：结果与账本落盘，重启后仅凭磁盘状态恢复', async () => {
  await withSource({
    name: '持久化',
    routes: [
      { path: '/page', body: '<div itemscope itemid="urn:p"><span itemprop="name">探头</span></div>', contentType: 'text/html' },
    ],
  }, async (source, stateDir) => {
    const result = await run({ source: source.url, stateDir, input: { pages: ['/page'] } });
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
    assert.deepEqual(saved, result);
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'ledger.json'), 'utf8'));
    assert.equal(ledger.pages['/page'].assertions.length, 1);
    // 模拟重启：新一次运行不抓页面，实体仍从落盘账本恢复
    const recovered = await run({ source: source.url, stateDir, input: { pages: [] } });
    assert.deepEqual(recovered.entities.find(item => item.id === 'urn:p').properties.name, ['探头']);
    assert.equal(recovered.trackedPages['/page'].status, 'ok');
  });
});
