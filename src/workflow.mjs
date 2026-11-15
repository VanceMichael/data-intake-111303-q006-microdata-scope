import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractMicrodata } from './microdata.mjs';
import { applyContribution, createLedger, markPageError, materialize, withdrawPage } from './ledger.mjs';

const LEDGER_FILE = 'ledger.json';
const RESULT_FILE = 'result.json';

async function writeJsonAtomic(file, data) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(data, null, 2));
  await rename(temporary, file);
}

// 恢复只依赖已落盘且可追溯的状态：账本损坏时隔离并从空账本重新开始，绝不沿用内存。
async function loadLedger(stateDir) {
  const file = path.join(stateDir, LEDGER_FILE);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pages !== 'object' || parsed.pages === null) {
      throw new Error('账本结构无效');
    }
    return { ledger: parsed, warning: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { ledger: createLedger(), warning: null };
    await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return { ledger: createLedger(), warning: `账本文件损坏，已隔离并重新开始：${error.message}` };
  }
}

// 单页摄取：抓取、解析、抽取、登记贡献。任何一步失败都只影响本页。
async function ingestPage(source, pagePath, ledger, stateDir) {
  const pageKey = pagePath;
  const pageUrl = new URL(pagePath, source).href;
  let response;
  try {
    response = await fetch(pageUrl, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
  } catch (error) {
    const { kept } = markPageError(ledger, pageKey, { error: `读取失败：${error.message}`, url: pageUrl });
    return { path: pagePath, status: 'error', error: `读取失败：${error.message}`, keptPrevious: kept };
  }
  // 404/410 视为页面已撤下：只撤销该页自己的贡献。
  if (response.status === 404 || response.status === 410) {
    const { revoked } = withdrawPage(ledger, pageKey, { url: pageUrl, httpStatus: response.status });
    return { path: pagePath, status: 'withdrawn', httpStatus: response.status, revokedAssertions: revoked };
  }
  if (!response.ok) {
    const { kept } = markPageError(ledger, pageKey, { error: `HTTP ${response.status}`, url: pageUrl });
    return { path: pagePath, status: 'error', error: `来源返回 HTTP ${response.status}`, keptPrevious: kept };
  }
  try {
    const finalUrl = response.url || pageUrl;
    const html = await response.text();
    const contentHash = 'sha256:' + createHash('sha256').update(html, 'utf8').digest('hex');
    const extraction = extractMicrodata(html, { pageUrl: finalUrl, pageKey });
    // 原始页面快照落盘，作为断言的可追溯依据。
    const snapshotName = encodeURIComponent(pageKey) + '.html';
    await mkdir(path.join(stateDir, 'snapshots'), { recursive: true });
    await writeFile(path.join(stateDir, 'snapshots', snapshotName), html);
    applyContribution(ledger, pageKey, {
      url: finalUrl,
      contentHash,
      fetchedAt: new Date().toISOString(),
      snapshot: 'snapshots/' + snapshotName,
      contentType: response.headers.get('content-type') ?? null,
      items: extraction.items,
      assertions: extraction.assertions,
      diagnostics: extraction.diagnostics,
    });
    return {
      path: pagePath,
      status: 'ok',
      items: extraction.items.length,
      assertions: extraction.assertions.length,
      contentHash,
      ...(extraction.diagnostics.length > 0 ? { diagnostics: extraction.diagnostics } : {}),
    };
  } catch (error) {
    const { kept } = markPageError(ledger, pageKey, { error: `页面处理失败：${error.message}`, url: pageUrl });
    return { path: pagePath, status: 'error', error: `页面处理失败：${error.message}`, keptPrevious: kept };
  }
}

export async function run({ source, stateDir, input }) {
  if (!source) throw new Error('缺少来源地址 source');
  if (!stateDir) throw new Error('缺少状态目录 stateDir');
  await mkdir(stateDir, { recursive: true });
  const { ledger, warning } = await loadLedger(stateDir);
  const pages = Array.isArray(input?.pages) ? [...new Set(input.pages)] : [];
  const pageReports = [];
  for (const pagePath of pages) {
    pageReports.push(await ingestPage(source, pagePath, ledger, stateDir));
  }
  const graph = materialize(ledger);
  // 完整性承诺：任何一页未能取得确定状态（ok/撤下）时，结果不伪称完成。
  const complete = pageReports.every(report => report.status === 'ok' || report.status === 'withdrawn');
  const result = {
    source,
    complete,
    pages: pageReports,
    trackedPages: Object.fromEntries(Object.entries(ledger.pages).map(([key, record]) => [key, {
      status: record.status,
      assertions: record.assertions?.length ?? 0,
      ...(record.contentHash ? { contentHash: record.contentHash } : {}),
    }])),
    entities: graph.entities,
    relations: graph.relations,
    evidence: graph.evidence,
    anonymousCount: graph.anonymousCount,
    crossPageEdges: graph.crossPageEdges,
    ...(warning ? { warnings: [warning] } : {}),
  };
  await writeJsonAtomic(path.join(stateDir, LEDGER_FILE), ledger);
  await writeJsonAtomic(path.join(stateDir, RESULT_FILE), result);
  return result;
}
