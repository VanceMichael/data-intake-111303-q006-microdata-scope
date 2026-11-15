import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from './src/source.mjs';
import { run } from './src/workflow.mjs';

// 增量贡献账本演示：同一仪器（itemid=urn:ins:9）由两页供稿。
// /a 三次访问依次给出：甲地（初值）→ 丙地（更正）→ 404（撤下）；/b 始终是乙地并附生产单位。
setTimeout(() => { console.error('运行超过 70 秒，停止并保留失败状态'); process.exit(124); }, 70000).unref();

const manufacturer = '<div itemprop="manufacturer" itemscope itemtype="Organization"><span itemprop="name">乙厂</span><span itemprop="address">乙地工业园</span></div>';
const instrument = (location, extra = '') =>
  `<div itemscope itemtype="Instrument" itemid="urn:ins:9"><span itemprop="name">巡检仪</span><span itemprop="location">${location}</span>${extra}</div>`;

const scenario = {
  name: '页面更正与撤下的增量演示',
  routes: [
    { path: '/a', replies: [
      { body: instrument('甲地'), contentType: 'text/html' },
      { body: instrument('丙地'), contentType: 'text/html' },
      { status: 404, body: '页面已撤下' },
    ] },
    { path: '/b', body: instrument('乙地', manufacturer), contentType: 'text/html' },
  ],
};

function show(result) {
  const entity = result.entities.find(item => item.id === 'urn:ins:9');
  console.log('  页面状态: ' + result.pages.map(p => `${p.path}=${p.status}`).join(' ') + '  complete=' + result.complete);
  console.log('  urn:ins:9 location = ' + JSON.stringify(entity?.properties.location));
  for (const line of result.evidence.filter(e => e.entity === 'urn:ins:9' && e.property === 'location')) {
    console.log(`    证据: "${line.value}" 来自 ${line.page} 的 ${line.locator.path}（第 ${line.locator.line} 行第 ${line.locator.column} 列）`);
  }
  console.log('  关系图: ' + JSON.stringify(result.relations));
  console.log('  匿名实体=' + result.anonymousCount + '  跨页误连=' + result.crossPageEdges);
}

const source = await startSource(scenario);
const stateDir = await mkdtemp(path.join(tmpdir(), 'material-incremental-'));
try {
  console.log('—— 第一次接收：/a 与 /b 对同一仪器给出矛盾安装地点，应带来源并存 ——');
  show(await run({ source: source.url, stateDir, input: { pages: ['/a', '/b'] } }));
  console.log('—— 第二次接收：/a 更正为丙地，只替换 /a 的贡献，/b 的乙地保留 ——');
  show(await run({ source: source.url, stateDir, input: { pages: ['/a', '/b'] } }));
  console.log('—— 第三次接收：/a 撤下（404），只撤销 /a 的贡献，/b 的值与生产单位关系保留 ——');
  show(await run({ source: source.url, stateDir, input: { pages: ['/a', '/b'] } }));
} finally {
  await source.close();
  await rm(stateDir, { recursive: true, force: true });
}
