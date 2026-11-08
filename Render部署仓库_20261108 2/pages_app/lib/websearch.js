'use strict';
/**
 * websearch.js — 真实联网检索与访问状态判定（wenjin/search.py 的 Node 移植）。
 *
 * 纪律不变：
 * 1. 只返回真实返回的来源与 URL；解析不出真实 URL 的结果直接丢弃，不用域名拼 URL。
 * 2. 每条候选带 access_status（full / snippet_only / blocked / failed）与 retrieved_at。
 * 3. 搜索失败不清空已生成的分析；失败要区分 no_match 与 failed。
 * 4. 引擎与参数写进返回值，便于复核；不声称「全网已查全」。
 *
 * 实现差异（如实）：Python 版用系统 curl 发请求（TLS 指纹更易过拦截），本移植用 Node
 * 内置 fetch。数据中心的出口 IP 更容易被搜狗限频——状态机会如实报 blocked/failed，
 * 调用方（references.js）按同一套纪律保留分析结果。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT = Number(process.env.WENJIN_SEARCH_TIMEOUT || 12);
const FETCH_TIMEOUT = Number(process.env.WENJIN_FETCH_TIMEOUT || 10);
const SEARCH_MAX_BYTES = 3_000_000;
const FETCH_MAX_BYTES = 1_500_000;

const MIN_INTERVAL = 1.2;
let lastCall = 0.0;
const CACHE = new Map();
const CACHE_TTL = 600;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function throttle() {
  const dt = (Date.now() / 1000) - lastCall;
  if (dt < MIN_INTERVAL) await sleep((MIN_INTERVAL - dt) * 1000);
  lastCall = Date.now() / 1000;
}

function nowStamp() {
  // 以项目时区（Asia/Shanghai）生成 YYYY-MM-DDTHH:MM:SS
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  return p.replace(' ', 'T');
}

function decodeBody(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('gb18030').decode(buf); } catch (e2) { return ''; }
  }
}

/** http_get — fetch 取页面；绝不抛网络异常。 */
async function httpGet(url, opts = {}) {
  const timeout = opts.timeout || FETCH_TIMEOUT;
  const maxBytes = opts.maxBytes || FETCH_MAX_BYTES;
  await throttle();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout * 1000);
  try {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
    if (opts.referer) headers.Referer = opts.referer;
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return { code: 0, final_url: url, size: 0, body: '', error: 'Max filesize exceeded' };
    }
    return { code: res.status, final_url: res.url || url, size: buf.byteLength,
      body: decodeBody(buf), error: res.ok ? '' : `HTTP ${res.status}` };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`;
    return { code: 0, final_url: url, size: 0, body: '', error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** http_json — 发一次 JSON 请求，返回 {code, json, body, error}；不抛网络异常。 */
async function httpJson(method, url, headers, payload, opts = {}) {
  const timeout = opts.timeout || SEARCH_TIMEOUT;
  await throttle();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout * 1000);
  try {
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: Object.assign({ 'User-Agent': UA }, headers || {}),
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    let obj = null;
    try { obj = text.trim() ? JSON.parse(text) : null; } catch (e) { obj = null; }
    return { code: res.status, json: obj, body: text.slice(0, 500), error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`;
    return { code: 0, json: null, body: '', error: msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function clean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

function stripTags(html) {
  return clean(String(html || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, ' '));
}

function parseBing(html) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/li>/)[0];
    const h2m = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2m) continue;
    const am = h2m[1].match(/<a[^>]*href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!am) continue;
    const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const cm = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    out.push({
      title: clean(stripTags(am[2])),
      url: am[1].trim(),
      snippet: pm ? clean(stripTags(pm[1])) : '',
      display_domain: cm ? clean(stripTags(cm[1])) : '',
      engine: 'bing',
    });
  }
  return out;
}

function parseSogou(html) {
  const out = [];
  const h3s = [...String(html || '').matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)];
  for (const m of h3s) {
    const inner = m[1];
    const am = inner.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!am) continue;
    let href = am[1];
    if (href.startsWith('/')) href = 'https://www.sogou.com' + href;
    if (!href.includes('sogou.com/link') && !href.startsWith('http')) continue;
    // Python 取 h3.parent 的全文做摘要；无 DOM 时取 h3 之后的一段文本近似
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 700);
    out.push({
      title: clean(stripTags(am[2])),
      url: '',
      redirect: href,
      snippet: clean(stripTags(after)).slice(0, 400),
      display_domain: '',
      engine: 'sogou',
    });
  }
  return out;
}

async function resolveSogou(redirect) {
  const r = await httpGet(redirect, { timeout: 8, referer: 'https://www.sogou.com/', maxBytes: 200_000 });
  const body = r.body || '';
  let m = body.match(/location\.replace\("([^"]+)"\)/);
  if (!m) m = body.match(/URL='([^']+)'/);
  if (m) return m[1].trim();
  if ((r.final_url || '').startsWith('http') && !r.final_url.includes('sogou.com')) return r.final_url;
  return '';
}

const BLOCK_HINT = /(验证码|安全验证|访问过于频繁|请输入验证码|antispider)/;

async function searchSogou(query, limit) {
  const q = encodeURIComponent(query);
  const r = await httpGet(`https://www.sogou.com/web?query=${q}`,
    { timeout: SEARCH_TIMEOUT, maxBytes: SEARCH_MAX_BYTES, referer: 'https://www.sogou.com/' });
  if (r.code !== 200 || !r.body) {
    return { ok: false, error: `sogou: HTTP ${r.code} ${r.error || ''}`.trim(), items: [], blocked: false };
  }
  if (BLOCK_HINT.test(r.body.slice(0, 4000)) || r.size < 20000) {
    return { ok: false, error: `sogou: 疑似验证码/频率限制（${r.size} 字节）`, items: [], blocked: true };
  }
  const cand = parseSogou(r.body);
  const items = [];
  const seen = new Set();
  for (const c of cand.slice(0, Math.max(limit * 2, 6))) {
    const real = c.redirect ? await resolveSogou(c.redirect) : '';
    if (!real.startsWith('http') || seen.has(real)) continue;
    seen.add(real);
    items.push({ title: c.title, url: real, snippet: c.snippet,
      display_domain: domainOf(real), engine: 'sogou' });
    if (items.length >= limit) break;
  }
  return { ok: items.length > 0, items, blocked: false,
    error: items.length ? null : 'sogou: 200 但真实 URL 解析 0 条' };
}

async function searchBing(query, limit) {
  const q = encodeURIComponent(query);
  const r = await httpGet(`https://cn.bing.com/search?q=${q}&form=QBLH&setlang=zh-CN`,
    { timeout: SEARCH_TIMEOUT, maxBytes: SEARCH_MAX_BYTES });
  if (r.code !== 200 || !r.body) {
    return { ok: false, error: `bing: HTTP ${r.code} ${r.error || ''}`.trim(), items: [], blocked: false };
  }
  const items = parseBing(r.body).slice(0, limit);
  return { ok: items.length > 0, items, blocked: false,
    error: items.length ? null : 'bing: 200 但解析出 0 条' };
}

// ── API 型检索（配置了 key 才启用；与 search.py 同名同参）────────────────
async function searchSerper(query, limit) {
  const key = process.env.WENJIN_SEARCH_API_KEY || '';
  const base = (process.env.WENJIN_SERPER_BASE || 'https://google.serper.dev').replace(/\/+$/, '');
  const r = await httpJson('POST', `${base}/search`,
    { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    { q: query, num: limit, hl: 'zh-cn' });
  if (r.code !== 200 || !r.json || typeof r.json !== 'object') {
    return { ok: false, items: [], blocked: [401, 403, 429].includes(r.code),
      error: `serper: HTTP ${r.code} ${r.error || ''}`.trim() };
  }
  const items = [];
  for (const o of (r.json.organic || []).slice(0, limit)) {
    const url = (o.link || '').trim();
    if (url.startsWith('http')) {
      items.push({ title: clean(o.title || ''), url, snippet: clean(o.snippet || ''),
        display_domain: domainOf(url), engine: 'serper' });
    }
  }
  return { ok: items.length > 0, items, blocked: false,
    error: items.length ? null : 'serper: 200 但 organic 为空' };
}

async function searchTavily(query, limit) {
  const key = process.env.WENJIN_SEARCH_API_KEY || '';
  const base = (process.env.WENJIN_TAVILY_BASE || 'https://api.tavily.com').replace(/\/+$/, '');
  const r = await httpJson('POST', `${base}/search`,
    { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    { query, max_results: Math.max(1, Math.min(limit, 10)), search_depth: 'basic', include_answer: false });
  if (r.code !== 200 || !r.json || typeof r.json !== 'object') {
    return { ok: false, items: [], blocked: [401, 403, 429].includes(r.code),
      error: `tavily: HTTP ${r.code} ${r.error || ''}`.trim() };
  }
  const items = [];
  for (const o of (r.json.results || []).slice(0, limit)) {
    const url = (o.url || '').trim();
    if (url.startsWith('http')) {
      items.push({ title: clean(o.title || ''), url, snippet: clean(o.content || ''),
        display_domain: domainOf(url), engine: 'tavily' });
    }
  }
  return { ok: items.length > 0, items, blocked: false,
    error: items.length ? null : 'tavily: 200 但 results 为空' };
}

async function searchBocha(query, limit) {
  const key = process.env.WENJIN_SEARCH_API_KEY || '';
  const base = (process.env.WENJIN_BOCHA_BASE || 'https://api.bochaai.com').replace(/\/+$/, '');
  const r = await httpJson('POST', `${base}/v1/web-search`,
    { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    { query, count: Math.max(1, Math.min(limit, 10)), summary: true, page: 1 });
  if (r.code !== 200 || !r.json || typeof r.json !== 'object') {
    return { ok: false, items: [], blocked: [401, 403, 429].includes(r.code),
      error: `bocha: HTTP ${r.code} ${r.error || ''}`.trim() };
  }
  const j = r.json;
  const data = (j.data && typeof j.data === 'object') ? j.data : {};
  const pages = ((data.webPages || {}).value) || data.results || j.results || [];
  const items = [];
  for (const o of pages.slice(0, limit)) {
    const url = (o.url || '').trim();
    if (url.startsWith('http')) {
      items.push({ title: clean(o.name || o.title || ''), url,
        snippet: clean(o.summary || o.snippet || ''),
        display_domain: domainOf(url), engine: 'bocha' });
    }
  }
  return { ok: items.length > 0, items, blocked: false,
    error: items.length ? null : 'bocha: 200 但 webPages 为空' };
}

const HTML_ENGINES = [['sogou', searchSogou], ['bing', searchBing]];
const API_ENGINES = { serper: searchSerper, tavily: searchTavily, bocha: searchBocha };
const RETIRED = { bing_api: 'Bing Search API 已于 2025-08-11 停售（微软官方公告），请改用 serper/tavily/bocha' };

function engineChain() {
  const chain = [];
  const backend = (process.env.WENJIN_SEARCH_BACKEND || '').trim().toLowerCase();
  if ((process.env.WENJIN_SEARCH_API_KEY || '') && backend in API_ENGINES) {
    chain.push([backend, API_ENGINES[backend]]);
  }
  return chain.concat(HTML_ENGINES);
}

function backendProblem() {
  const backend = (process.env.WENJIN_SEARCH_BACKEND || '').trim().toLowerCase();
  if (backend in RETIRED) return RETIRED[backend];
  if (backend && !(backend in API_ENGINES)) {
    return `未知的检索后端「${backend}」。可用：${Object.keys(API_ENGINES).join(', ')}（留空则只走 HTML 抓取：搜狗→Bing）`;
  }
  if (backend && !process.env.WENJIN_SEARCH_API_KEY) {
    return `已选后端「${backend}」但缺少 WENJIN_SEARCH_API_KEY，将只走 HTML 引擎`;
  }
  return null;
}

async function search(query, limit = 10, useCache = true) {
  const key = query + '|' + limit;
  const hit = CACHE.get(key);
  if (useCache && hit && (Date.now() / 1000 - hit.t) < CACHE_TTL) {
    const res = Object.assign({}, hit.res, { cached: true });
    return res;
  }
  const errors = [];
  const tried = [];
  for (const [name, fn] of engineChain()) {
    tried.push(name);
    const r = await fn(query, limit);
    if (r.ok) {
      const out = { status: 'success', engine: name, query, results: r.items.slice(0, limit),
        http_code: 200, engines_tried: tried, cached: false, retrieved_at: nowStamp() };
      CACHE.set(key, { t: Date.now() / 1000, res: out });
      cacheWrite(query, { engine: name, n: out.results.length, urls: out.results.map((x) => x.url) });
      return out;
    }
    errors.push(r.error);
    if (r.blocked) continue;
  }
  const out = { status: 'failed', engine: null, query, results: [], errors,
    engines_tried: tried, cached: false, retrieved_at: nowStamp() };
  cacheWrite(query, { engine: null, errors, n: 0 });
  return out;
}

async function fetchText(url) {
  const r = await httpGet(url, { timeout: FETCH_TIMEOUT, maxBytes: FETCH_MAX_BYTES });
  const code = r.code;
  const body = r.body || '';
  if (code === 0) {
    return { access_status: 'failed', http_code: 0, error: r.error, title: null, text: '',
      retrieved_at: nowStamp() };
  }
  if (code >= 400) {
    return { access_status: 'blocked', http_code: code, error: `HTTP ${code}`, title: null, text: '',
      retrieved_at: nowStamp() };
  }
  const stripped = body
    .replace(/<(script|style|noscript|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ');
  const tm = stripped.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? clean(stripTags(tm[1])) : null;
  const text = stripTags(stripped);
  const status = text.length >= 600 ? 'full' : 'snippet_only';
  return { access_status: status, http_code: code, error: null, title,
    text: text.slice(0, 20000), chars: text.length, retrieved_at: nowStamp() };
}

const AUTHORITY_HINTS = ['.gov.cn', '.edu.cn', '.org.cn', 'cnipa', 'samr', 'std.samr',
  'cnki', 'wanfang', 'doi.org', 'sciencedirect', 'nature.com', 'ieee', 'springer', 'cnki.net'];

function domainOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
}

function isAuthority(url) {
  const d = domainOf(url);
  return AUTHORITY_HINTS.some((h) => d.includes(h));
}

function cacheWrite(key, payload) {
  try {
    const dir = process.env.WENJIN_CACHE_DIR || '/tmp';
    const p = `${dir}/wenjin_pages_${Math.abs(hashStr(key)) % 10 ** 12}.json`;
    require('node:fs').writeFileSync(p, JSON.stringify({ key, payload }), 'utf-8');
  } catch (e) { /* 留痕失败不影响结果 */ }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

module.exports = {
  httpGet, httpJson, search, fetchText, domainOf, isAuthority, backendProblem,
  parseBing, parseSogou, stripTags, nowStamp, engineChain, RETIRED,
};
