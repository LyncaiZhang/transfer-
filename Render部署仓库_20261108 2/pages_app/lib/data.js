'use strict';
/**
 * data.js — 案例库 / 指引 / 链接 / 分析留痕的数据层。
 *
 * 数据来源（二选一，自动回退）：
 *  1. Supabase（Page 运行时注入 SUPABASE_URL / SUPABASE_ANON_KEY）——生产路径；
 *  2. db/seed_snapshot.json（由 04_构建脚本/build_wenjin_seed_sql.py 生成）——
 *     本机开发或库暂不可用时回退，内容与种子 SQL 完全一致。
 *
 * 纪律：只读种子数据；labels / disagreements / results / runs 永不出现在本层。
 * 写入只有一张表 analyses（每次真实分析的留痕，供台账核对）。
 */

const FS = require('node:fs');
const PATH = require('node:path');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';
const HAS_DB = Boolean(SB_URL && SB_KEY);

const SNAPSHOT_PATH = PATH.join(__dirname, '..', 'db', 'seed_snapshot.json');
const CACHE_TTL = 300; // 秒
const cache = new Map();

function loadSnapshot() {
  if (cache.has('snapshot')) return cache.get('snapshot');
  const raw = JSON.parse(FS.readFileSync(SNAPSHOT_PATH, 'utf8'));
  cache.set('snapshot', raw);
  return raw;
}

async function sbFetch(pathname, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (opts.timeoutSec || 10) * 1000);
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
      method: opts.method || 'GET',
      headers: Object.assign({
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Accept: 'application/json',
      }, opts.headers || {}),
      body: opts.body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`supabase ${res.status}: ${t.slice(0, 160)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function sbSelect(table, query) {
  const key = `sel:${table}:${query}`;
  const hit = cache.get(key);
  if (hit && (Date.now() / 1000 - hit.t) < CACHE_TTL) return hit.data;
  const res = await sbFetch(`${table}?${query}`);
  const data = await res.json();
  cache.set(key, { t: Date.now() / 1000, data });
  return data;
}

async function sbCount(table) {
  const res = await sbFetch(`${table}?select=*`, {
    method: 'HEAD',
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = res.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function sbInsert(table, row) {
  const res = await sbFetch(table, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  return true;
}

// ── 与 Python store/guide 同形状的读取接口 ─────────────────────────────
async function getCases(onlyVerified = true, limit = 60) {
  let rows;
  if (HAS_DB) {
    try {
      rows = await sbSelect('cases',
        'select=*&order=domain.asc,case_id.asc&limit=200');
    } catch (e) {
      rows = null;
    }
  }
  if (!rows) rows = loadSnapshot().cases;
  if (onlyVerified) rows = rows.filter((r) => r.verification_status === '人工已核对原文');
  return rows.slice(0, limit);
}

async function getCaseById(caseId) {
  if (HAS_DB) {
    try {
      const rows = await sbSelect('cases',
        `select=*&case_id=eq.${encodeURIComponent(caseId)}&limit=1`);
      if (rows && rows.length) return rows[0];
    } catch (e) { /* 回退 */ }
  }
  return (loadSnapshot().cases || []).find((c) => c.case_id === caseId) || null;
}

async function getExtraCases() {
  let rows;
  if (HAS_DB) {
    try {
      rows = await sbSelect('cases_extra', 'select=*&order=case_id.asc&limit=100');
    } catch (e) {
      rows = null;
    }
  }
  if (!rows || !rows.length) rows = loadSnapshot().cases_extra;
  return rows.map((r) => {
    const rr = Object.assign({}, r);
    try { rr.maps_to = JSON.parse(rr.maps_to || '[]'); } catch (e) { rr.maps_to = []; }
    return rr;
  });
}

async function getGuidesRaw() {
  if (HAS_DB) {
    try {
      const rows = await sbSelect('guides', 'select=*&order=ord.asc&limit=20');
      if (rows && rows.length) {
        return rows.map((g) => ({
          topic: g.topic, title: g.title, question: g.question, summary: g.summary,
          typical_evidence: g.typical_evidence || [], pitfalls: g.pitfalls || [],
          next_steps: g.next_steps || [], case_ids: g.case_ids || [], anchors: g.anchors || [],
        }));
      }
    } catch (e) { /* 回退 */ }
  }
  return (loadSnapshot().guides || {}).guides || [];
}

async function getLinksRaw() {
  if (HAS_DB) {
    try {
      const rows = await sbSelect('links', 'select=*&order=ord.asc&limit=50');
      if (rows && rows.length) {
        return {
          links: rows.map((l) => ({ group: l.group, name: l.name, url: l.url,
            purpose: l.purpose, status: l.status, note: l.note })),
          meta: (loadSnapshot().links || {})._meta || {},
        };
      }
    } catch (e) { /* 回退 */ }
  }
  const raw = loadSnapshot().links || {};
  return { links: raw.links || [], meta: raw._meta || {} };
}

async function getCaseLinkStatus() {
  if (HAS_DB) {
    try {
      const rows = await sbSelect('case_link_status', 'select=*&limit=200');
      if (rows && rows.length) {
        const map = {};
        for (const r of rows) {
          map[r.case_id] = { status: r.status, final_url: r.final_url, url: r.url, kind: r.kind };
        }
        return { cases: map, checked_at: (rows[0] && rows[0].checked_at) || null };
      }
    } catch (e) { /* 回退 */ }
  }
  const cl = loadSnapshot().case_links || {};
  return { cases: cl.cases || {}, checked_at: cl.checked_at || null };
}

async function insertAnalysis(row) {
  if (!HAS_DB) throw new Error('未配置 Supabase（本机快照模式不写库）');
  return sbInsert('analyses', row);
}

async function health() {
  if (!HAS_DB) {
    const snap = loadSnapshot();
    return { ok: true, source: 'snapshot（未配置数据库，回退到构建期快照）',
      cases: (snap.cases || []).length, cases_extra: (snap.cases_extra || []).length,
      analyses: null };
  }
  try {
    const [c1, c2, c3] = await Promise.all([
      sbCount('cases'), sbCount('cases_extra'), sbCount('analyses'),
    ]);
    return { ok: true, source: 'supabase', cases: c1, cases_extra: c2, analyses: c3 };
  } catch (e) {
    const snap = loadSnapshot();
    return { ok: true, source: `snapshot（数据库不可达：${String(e.message).slice(0, 80)}）`,
      cases: (snap.cases || []).length, cases_extra: (snap.cases_extra || []).length,
      analyses: null };
  }
}

function dataSource() {
  return HAS_DB ? 'supabase' : 'snapshot';
}

module.exports = {
  HAS_DB, getCases, getCaseById, getExtraCases, getGuidesRaw, getLinksRaw,
  getCaseLinkStatus, insertAnalysis, health, dataSource,
};
