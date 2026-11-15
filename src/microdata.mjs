import * as parse5 from 'parse5';

// 单页微数据抽取。只用 parse5 解析，不用正则拆标签。
// 契约取值规则：meta 取 content、a/link 取 href、time 取 datetime，其他元素取文本；
// 相对 URL 按页面基址解析，本站 URL 输出绝对路径，站外保留完整 URL。
const URL_VALUE_TAGS = new Set(['a', 'link']);
const MAX_DIAGNOSTICS = 100;

function tokens(value) {
  if (value === null) return [];
  return value.split(/[\t\n\f\r ]+/).filter(Boolean);
}

function attr(element, name) {
  const entry = element.attrs?.find(candidate => candidate.name === name);
  return entry === undefined ? null : entry.value;
}

function hasAttr(element, name) {
  return Boolean(element.attrs?.some(candidate => candidate.name === name));
}

function childElements(node) {
  const children = [];
  for (const child of node.childNodes ?? []) {
    if (child.tagName) children.push(child);
  }
  return children;
}

function textOf(node) {
  let text = '';
  const walk = current => {
    if (current.nodeName === '#text') {
      text += current.value;
      return;
    }
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);
  return text;
}

// 证据定位：同级标签序号路径 + 源码行列与偏移 + 原文片段。
function locate(element, html) {
  const segments = [];
  let node = element;
  while (node && node.tagName) {
    const parent = node.parentNode;
    let index = 0;
    let total = 0;
    for (const sibling of parent?.childNodes ?? []) {
      if (sibling.tagName === node.tagName) {
        total += 1;
        if (sibling === node) index = total;
      }
    }
    segments.unshift(total > 1 ? `${node.tagName}:nth-of-type(${index})` : node.tagName);
    node = parent ?? null;
  }
  const location = element.sourceCodeLocation;
  const offset = location?.startOffset ?? null;
  return {
    path: segments.join('>'),
    line: location?.startLine ?? null,
    column: location?.startCol ?? null,
    offset,
    snippet: offset === null ? undefined : html.slice(offset, offset + 120),
  };
}

// 文档基址：树序第一个有效 <base href>，否则用页面地址。
function findBaseUrl(document, pageUrl) {
  let base = null;
  const visit = node => {
    if (base !== null) return;
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      if (child.tagName === 'base') {
        const href = attr(child, 'href');
        if (href !== null) {
          try {
            base = new URL(href, pageUrl).href;
          } catch {
            base = null;
          }
          if (base !== null) return;
        }
      }
      visit(child);
      if (base !== null) return;
    }
  };
  visit(document);
  return base ?? pageUrl;
}

export function extractMicrodata(html, { pageUrl, pageKey }) {
  const diagnostics = [];
  const note = (kind, detail) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ kind, ...detail });
  };
  const document = parse5.parse(String(html), { sourceCodeLocationInfo: true });
  const baseUrl = findBaseUrl(document, pageUrl);
  let pageOrigin = null;
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    note('page-url-invalid', { pageUrl });
  }

  const resolveUrl = raw => {
    let absolute;
    try {
      absolute = new URL(raw, baseUrl);
    } catch {
      note('url-invalid', { value: raw });
      return raw;
    }
    if (pageOrigin !== null && absolute.origin === pageOrigin) {
      return absolute.pathname + absolute.search + absolute.hash;
    }
    return absolute.href;
  };

  // id 索引按页面独立建立：跨页同名 DOM id 互不影响；页内重复 id 取树序第一个并记录。
  const idIndex = new Map();
  const itemscopeElements = [];
  const scan = node => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      const id = attr(child, 'id');
      if (id !== null && id !== '') {
        if (idIndex.has(id)) note('duplicate-id', { id });
        else idIndex.set(id, child);
      }
      if (hasAttr(child, 'itemscope')) itemscopeElements.push(child);
      scan(child);
    }
  };
  scan(document);

  const items = [];
  const itemByElement = new Map();
  const entityIdOf = item => item.itemid ?? `page:${pageKey}#item${item.index}`;

  function createItem(element) {
    const existing = itemByElement.get(element);
    if (existing) return existing;
    const item = {
      index: items.length,
      topLevel: !hasAttr(element, 'itemprop'),
      itemtypes: tokens(attr(element, 'itemtype')),
      itemid: null,
      properties: [],
    };
    const rawId = attr(element, 'itemid');
    if (rawId !== null && rawId.trim() !== '') {
      try {
        item.itemid = new URL(rawId, baseUrl).href;
      } catch {
        note('itemid-invalid', { item: item.index, value: rawId });
      }
    }
    // 先登记再遍历属性，itemref 环在递归中回到同一元素时直接复用，不会死循环。
    itemByElement.set(element, item);
    items.push(item);
    walkProperties(item, element);
    return item;
  }

  function scalarValue(element) {
    const tag = element.tagName;
    if (tag === 'meta') return { kind: 'string', value: attr(element, 'content') ?? '', via: 'content' };
    if (URL_VALUE_TAGS.has(tag)) {
      const href = attr(element, 'href');
      if (href === null) return { kind: 'string', value: '', via: 'href' };
      return { kind: 'url', value: resolveUrl(href), via: 'href' };
    }
    if (tag === 'time') {
      const datetime = attr(element, 'datetime');
      if (datetime !== null) return { kind: 'string', value: datetime, via: 'datetime' };
      return { kind: 'string', value: textOf(element), via: 'text' };
    }
    return { kind: 'string', value: textOf(element), via: 'text' };
  }

  // 规范遍历模型：子元素先入队，itemref 引用的元素随后；memory 去重，
  // 重复引用与引用环中每个元素对每个实体只处理一次，结果可解释。
  function walkProperties(item, root) {
    const memory = new Set([root]);
    const pending = [...childElements(root)];
    const refSpec = attr(root, 'itemref');
    if (refSpec !== null) {
      for (const token of tokens(refSpec)) {
        const target = idIndex.get(token);
        if (!target) {
          note('itemref-unresolved', { item: item.index, id: token });
          continue;
        }
        pending.push(target);
      }
    }
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const current = pending[cursor];
      if (memory.has(current)) {
        note('itemref-dedup', { item: item.index, at: locate(current, html).path });
        continue;
      }
      memory.add(current);
      const names = tokens(attr(current, 'itemprop'));
      if (names.length > 0) {
        if (hasAttr(current, 'itemscope')) {
          // 嵌套实体作为关系保留，其属性不进入父实体，子树不再向父实体展开。
          const child = createItem(current);
          for (const name of names) item.properties.push({ name, kind: 'item', item: child, element: current });
        } else {
          const value = scalarValue(current);
          for (const name of names) item.properties.push({ name, kind: value.kind, value: value.value, via: value.via, element: current });
        }
      }
      if (!hasAttr(current, 'itemscope')) pending.push(...childElements(current));
    }
  }

  for (const element of itemscopeElements) createItem(element);

  // 断言是账本的最小单位：主体、属性、值或关系目标、来源页与证据定位。
  const assertions = [];
  const seen = new Set();
  for (const item of items) {
    const subject = entityIdOf(item);
    for (const property of item.properties) {
      const locator = locate(property.element, html);
      const assertion = property.kind === 'item'
        ? { subject, property: property.name, valueType: 'ref', target: entityIdOf(property.item), via: 'item', page: pageKey, locator }
        : { subject, property: property.name, valueType: property.kind, value: property.value, via: property.via, page: pageKey, locator };
      const key = [assertion.subject, assertion.property, assertion.valueType, assertion.value ?? assertion.target, locator.path].join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      assertions.push(assertion);
    }
  }

  return {
    baseUrl,
    items: items.map(item => ({
      entity: entityIdOf(item),
      anonymous: item.itemid === null,
      itemid: item.itemid,
      itemtypes: item.itemtypes,
      topLevel: item.topLevel,
    })),
    assertions,
    diagnostics,
  };
}
