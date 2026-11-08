'use strict';
/**
 * server.js — 问津公网服务（QW Pages 动态页 · Node 22 · 零第三方依赖）。
 *
 * 接口与 09_问津智能体/wenjin/server.py 一一同名同参：
 *   GET  /                 首页
 *   GET  /api/health       版本、判据指纹、奇偶校验、库状态（不返回密钥，只返回布尔）
 *   GET  /api/cases?limit  精选案例（仅人工已核对原文；带链接实测状态）
 *   GET  /api/cases_extra  补充案例
 *   GET  /api/guides?topic 阶段指引（含来源与常用链接）
 *   GET  /api/links        常用链接（带实测访问状态与核对日期）
 *   POST /api/analyze      {text, target_use?, source_url?, as_of?}
 *   POST /api/references   {text|technology, target_use?, stage?, limit?}
 *   POST /api/guide        {topic}
 *
 * 分析核心 = lib/engine.js（Python 引擎的移植副本，fixtures 奇偶校验锁定）；
 * 本文件只做参数校验、调用与格式化，不实现任何判据。
 * 每次成功分析写一行 analyses 留痕（Supabase；未配置库时如实标注不落盘）。
 */

const HTTP = require('node:http');
const FS = require('node:fs');
const PATH = require('node:path');
const CRYPTO = require('node:crypto');

const engine = require('./lib/engine');
const criteria = require('./lib/criteria');
const websearch = require('./lib/websearch');
const references = require('./lib/references');
const data = require('./lib/data');

const APP_VERSION = '1.0.0-pages';
const MAX_BODY = 200_000;
const SAFE_NAME = /^[A-Za-z0-9_\-./]+$/;
const PUBLIC_DIR = PATH.join(__dirname, 'public');

// 判据与 fixtures 指纹（启动时读一次，页面如实展示）
const CRITERIA_META = criteria.CRITERIA._meta;
let FIXTURES_META = {};
try {
  FIXTURES_META = JSON.parse(FS.readFileSync(PATH.join(__dirname, 'fixtures', 'meta.json'), 'utf8'));
} catch (e) { FIXTURES_META = { note: 'fixtures 缺失——奇偶校验未运行，不得对外声称与 Python 引擎同源' }; }

function nowStamp() { return websearch.nowStamp(); }

function newRequestId() {
  const d = new Date();
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(/[-: ]/g, '').replace('T', '-');
  return `WJ-${p}-${CRYPTO.randomBytes(3).toString('hex')}`;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** resolve_as_of — config.resolve_as_of 的移植：给当天（Asia/Shanghai）；非法/未来回退当天。 */
function resolveAsOf(raw) {
  if (!raw) return [todayShanghai(), null];
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    return [todayShanghai(), `as_of 无法解析（${JSON.stringify(raw)}），已回退为今天 ${todayShanghai()}`];
  }
  if (s > todayShanghai()) {
    return [todayShanghai(), `as_of 晚于今天（${s}），已回退为今天 ${todayShanghai()}`];
  }
  return [s, null];
}

function modelStatus() {
  return {
    enabled: false, provider: 'deepseek', model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1', key_present: false,
    role: '只生成摘要措辞；阶段标签与证据分级由冻结判据给出，模型不得改写',
  };
}

function searchStatus() {
  const backend = (process.env.WENJIN_SEARCH_BACKEND || '').trim().toLowerCase();
  return {
    backend: backend || 'html(sogou→bing)',
    api_key_present: Boolean(process.env.WENJIN_SEARCH_API_KEY),
    note: '未配 key 时走 HTML 抓取；通道状态见每次返回的 search_status',
  };
}

// ── service 层（与 wenjin/service.py 同名同输出）───────────────────────
const TOPIC_ALIASES = {
  concept: ['概念验证', 'poc', '概念', 'proof of concept'],
  lab: ['实验室', '实验室验证', 'lab'],
  prototype: ['原型', '相关环境', 'prototype'],
  pilot: ['中试', '工程化', 'pilot', 'scale'],
  transfer: ['转移', '合作', '许可', '转让', '作价', 'transfer', 'license'],
  deployment: ['实施', '推广', '部署', '应用', 'deployment'],
};

function resolveTopic(topic) {
  const t = (topic || '').trim().toLowerCase();
  if (!t) return null;
  for (const [key, aliases] of Object.entries(TOPIC_ALIASES)) {
    if (t === key || aliases.some((a) => t.includes(a))) return key;
  }
  return null;
}

async function guidesLoad() {
  const raw = await data.getGuidesRaw();
  const out = [];
  for (const g of raw) {
    const item = Object.assign({}, g);
    const sources = [];
    for (const cid of g.case_ids || []) {
      const c = await data.getCaseById(cid);
      if (!c) {
        sources.push({ case_id: cid, resolved: false, note: '库内无此案例（内容与库不一致，需修正）' });
        continue;
      }
      sources.push({
        case_id: cid, resolved: true, title: c.tech, institution: c.institution,
        kind: c.kind, url: c.source_url, published_at: c.published_at,
        retrieved_at: c.retrieved_at, verification_status: c.verification_status,
        quote: (c.quote || '').slice(0, 160),
      });
    }
    item.sources = sources;
    item.anchors = g.anchors || [];
    out.push(item);
  }
  return out;
}

function guidesMeta() {
  try {
    return (JSON.parse(FS.readFileSync(PATH.join(__dirname, 'db', 'seed_snapshot.json'), 'utf8'))
      .guides || {})._meta || {};
  } catch (e) { return {}; }
}

async function getTransferGuide(topic) {
  const rid = newRequestId();
  const all = await guidesLoad();
  const key = resolveTopic(topic || '');
  if (topic && !key) {
    return Object.assign({
      request_id: rid, status: 'failed',
      error: { type: 'unknown_topic',
        message: `未识别的主题「${topic}」。可用主题：` +
          all.map((g) => `${g.title}（${g.topic}）`).join('、') },
      human_review: 'required',
    }, { topics: all.map((g) => ({ topic: g.topic, title: g.title })) });
  }
  const items = all.filter((g) => key === null || g.topic === key);
  return {
    request_id: rid, status: 'success', topic: key, guides: items,
    review_status: 'source_checked', verified_at: guidesMeta().verified_at || null,
    topics: all.map((g) => ({ topic: g.topic, title: g.title })),
    human_review: 'required',
    disclaimers: ['指引为方法与材料清单，不构成对具体项目阶段的判定。',
      '案例来源见每条 case_ids，回源地址在 /api/cases 中可查。'],
    elapsed_ms: 0,
  };
}

async function featuredCases(limit = 4) {
  const rows = await data.getCases(true, 60);
  const cl = await data.getCaseLinkStatus();
  const links = cl.cases || {};
  const checkedAt = cl.checked_at || null;
  for (const r of rows) {
    const st = links[r.case_id] || {};
    r.link_status = st.kind || 'unchecked';
    r.link_http = st.status;
    r.link_checked_at = checkedAt;
  }
  const order = ['领域A 气体传感', '领域B 能源环保', '领域C 医疗传感', '跨校对照'];
  const rank = { ok: 0, blocked: 1, unchecked: 2, unreachable: 3, dead: 4 };
  rows.sort((a, b) => {
    const ra = rank[a.link_status] === undefined ? 2 : rank[a.link_status];
    const rb = rank[b.link_status] === undefined ? 2 : rank[b.link_status];
    if (ra !== rb) return ra - rb;
    const oa = order.includes(a.domain) ? order.indexOf(a.domain) : 9;
    const ob = order.includes(b.domain) ? order.indexOf(b.domain) : 9;
    if (oa !== ob) return oa - ob;
    const ka = a.kind === '成功跃迁' ? 0 : 1;
    const kb = b.kind === '成功跃迁' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0;
  });
  const picked = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.domain)) continue;
    picked.push(r);
    seen.add(r.domain);
    if (picked.length >= limit) break;
  }
  if (picked.length < limit) {
    for (const r of rows) {
      if (!picked.includes(r)) picked.push(r);
      if (picked.length >= limit) break;
    }
  }
  return { status: 'success', count: picked.length, cases: picked.slice(0, limit),
    label: '已核对公开来源',
    note: '仅列出 verification_status=人工已核对原文 的案例；构造数据（SIM-）一律不列。' };
}

async function extraCases() {
  const rows = await data.getExtraCases();
  const cl = await data.getCaseLinkStatus();
  const links = cl.cases || {};
  for (const c of rows) {
    const st = links[c.case_id] || {};
    c.link_status = st.kind || 'unchecked';
    c.link_http = st.status;
  }
  return { status: 'success', count: rows.length, cases: rows,
    meta: { source: `cases_extra 表（${data.dataSource()}）`, count: rows.length },
    note: '全网检索补充案例，独立于证据库 31 席；不参与覆盖率/一致率等效果指标' };
}

async function health() {
  const store = await data.health();
  return {
    status: 'ok', app_version: APP_VERSION,
    rule_version: criteria.RULE_VERSION,
    model: modelStatus(),
    search: searchStatus(),
    store,
    parity: {
      fixtures_cases: FIXTURES_META.cases || null,
      fixtures_generated_at: FIXTURES_META.generated_at || null,
      run_triage_sha256: FIXTURES_META.run_triage_sha256 || CRITERIA_META.run_triage_sha256,
      criteria_json_sha256: CRYPTO.createHash('sha256')
        .update(FS.readFileSync(PATH.join(__dirname, 'lib', 'criteria.json'))).digest('hex'),
      note: 'lib/engine.js 是 07_证据库/run_triage.py 冻结判据与 wenjin 抽取逻辑的移植副本，' +
        '输出与 Python 引擎逐字段一致（fixtures 奇偶校验锁定，见 tests/parity.mjs）',
    },
    paths: { web: 'public/', log: 'stdout（jsonl）' },
    time: nowStamp(),
  };
}

async function findReferenceCases(text, technology, targetUse, stage, limit) {
  const rid = newRequestId();
  const src = ((text || '').trim() || (technology || '').trim());
  if (!src) {
    return { request_id: rid, status: 'failed',
      error: { type: 'empty_input', message: 'text 与 technology 不能同时为空；请给出技术描述或技术关键词。' },
      human_review: 'required' };
  }
  if (src.length < 8) {
    return { request_id: rid, status: 'failed',
      error: { type: 'input_too_short', message: '技术描述过短（<8 字），无法构造有效检索式。' },
      human_review: 'required' };
  }
  const clipped = src.slice(0, 12000);
  const r = await references.findReferences(clipped, {
    targetUse, stage, limit: parseInt(limit, 10) || 3,
  });
  const libCases = await data.getCases(true, 60);
  const lib = references.libraryMatches(libCases, clipped, 2);
  return {
    request_id: rid,
    status: (r.references && r.references.length) || lib.length ? 'success' : 'partial',
    search_status: r.search_status,
    references: r.references,
    library_references: lib,
    library_note: '库内已核对原文的案例，按词面共现匹配；不是当次联网检索结果，来源 URL 来自证据库记录',
    queries: r.queries,
    note: r.note || null,
    retrieved_at: r.retrieved_at,
    human_review: 'required',
    disclaimers: ['外部参考只用于借鉴，不是当前项目达到同阶段的证据。',
      '未见全文即标 snippet_only；不声称“全网已查全”。'],
    elapsed_ms: 0,
  };
}

// ── HTTP 层 ────────────────────────────────────────────────────────────
function send(res, code, body, ctype = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(code, {
    'Content-Type': ctype,
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(buf);
}

function jsonOut(obj) { return JSON.stringify(obj, null, 2); }

function errJson(code, etype, message) {
  return [code, jsonOut({ status: 'failed', error: { type: etype, message } })];
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve([null, '请求体过大']); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve([null, '请求体为空']);
      try {
        const obj = JSON.parse(raw);
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
          return resolve([null, '请求体必须是 JSON 对象']);
        }
        resolve([obj, null]);
      } catch (e) {
        resolve([null, 'JSON 解析失败']);
      }
    });
    req.on('error', () => resolve([null, '请求读取失败']));
  });
}

function serveStatic(rel) {
  rel = (rel || 'index.html').split('?')[0];
  if (rel.includes('..') || !SAFE_NAME.test(rel)) return [400, 'bad_path', '非法路径'];
  const p = PATH.join(PUBLIC_DIR, rel);
  if (!p.startsWith(PUBLIC_DIR) || !FS.existsSync(p) || !FS.statSync(p).isFile()) {
    return [404, 'not_found', `文件不存在：${rel}`];
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const ctype = types[PATH.extname(p).toLowerCase()] || 'application/octet-stream';
  return [200, null, FS.readFileSync(p), ctype];
}

async function handle(req, res) {
  const t0 = Date.now();
  const path = (req.url || '/').split('?')[0];
  const q = new URL(req.url || '/', 'http://x').searchParams;
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/' || path === '/index.html') {
        const [code, , body, ctype] = serveStatic('index.html');
        return send(res, code, body, ctype);
      }
      if (path === '/api/health') return send(res, 200, jsonOut(await health()));
      if (path === '/api/cases') return send(res, 200, jsonOut(await featuredCases(parseInt(q.get('limit') || '4', 10) || 4)));
      if (path === '/api/cases_extra') return send(res, 200, jsonOut(await extraCases()));
      if (path === '/api/guides') {
        const g = await getTransferGuide(q.get('topic'));
        const l = await data.getLinksRaw();
        g.links = l.links;
        g.links_meta = l.meta;
        return send(res, 200, jsonOut(g));
      }
      if (path === '/api/links') {
        const l = await data.getLinksRaw();
        return send(res, 200, jsonOut({ status: 'success', links: l.links, meta: l.meta }));
      }
      if (path.startsWith('/static/')) {
        const [code, etype, body, ctype] = serveStatic(path.slice('/static/'.length));
        if (etype) return send(res, code, jsonOut({ status: 'failed', error: { type: etype, message: body } }));
        return send(res, code, body, ctype);
      }
      if (path === '/favicon.ico') return send(res, 204, '');
      return send(res, 404, jsonOut({ status: 'failed', error: { type: 'not_found', message: `没有这个路径：${path}` } }));
    }

    if (req.method === 'POST') {
      const [body, perr] = await readBody(req);
      if (perr) {
        const [code, payload] = errJson(400, 'bad_request', perr);
        return send(res, code, payload);
      }
      if (path === '/api/analyze') {
        const rid = newRequestId();
        const tA = Date.now();
        const [asof] = resolveAsOf(body.as_of);
        const r = engine.analyzeCase(body.text, body.target_use, body.source_url, asof,
          { requestId: rid, appVersion: APP_VERSION });
        r.elapsed_ms = Math.max(0, Date.now() - tA);
        if (r.status !== 'failed') {
          try {
            await data.insertAnalysis({
              request_id: r.request_id, case_title: r.case_title,
              stage: r.technical_stage.label, input_chars: r.input.chars,
              target_use: r.input.target_use, source_url: r.input.source_url,
              app_version: r.app_version, rule_version: r.rule_version,
              result: r, client: 'pages',
            });
            r.persistence = { ok: true, backend: data.dataSource() };
          } catch (e) {
            r.persistence = { ok: false, error: String(e.message || e).slice(0, 160) };
          }
        }
        return send(res, r.status === 'failed' ? 400 : 200, jsonOut(r));
      }
      if (path === '/api/references') {
        const r = await findReferenceCases(body.text, body.technology, body.target_use,
          body.stage, body.limit || 3);
        return send(res, r.status === 'failed' ? 400 : 200, jsonOut(r));
      }
      if (path === '/api/guide') {
        const r = await getTransferGuide(body.topic);
        return send(res, r.status === 'failed' ? 400 : 200, jsonOut(r));
      }
      const [code, payload] = errJson(404, 'not_found', `没有这个接口：${path}`);
      return send(res, code, payload);
    }

    const [code, payload] = errJson(405, 'method_not_allowed', '不支持的请求方法');
    return send(res, code, payload);
  } catch (e) {
    const [code, payload] = errJson(500, 'internal_error', `服务内部错误：${String(e.message || e).slice(0, 200)}`);
    try { send(res, code, payload); } catch (e2) { /* 连接已断 */ }
  } finally {
    console.log(JSON.stringify({ ts: nowStamp(), path, method: req.method, ms: Date.now() - t0 }));
  }
}

const server = HTTP.createServer((req, res) => { handle(req, res); });

const PORT = parseInt(process.env.PORT || '8081', 10);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`问津公网服务已启动：http://${HOST}:${PORT}/`);
  console.log(`  判据：${criteria.RULE_VERSION}（run_triage sha256 ${CRITERIA_META.run_triage_sha256.slice(0, 16)}…）`);
  console.log(`  奇偶校验 fixtures：${FIXTURES_META.cases || '?'} 例（${FIXTURES_META.generated_at || '未知'}）`);
  console.log(`  数据：${data.dataSource()}；检索：${searchStatus().backend}`);
  const bp = websearch.backendProblem();
  if (bp) console.log(`  注意：${bp}`);
});
