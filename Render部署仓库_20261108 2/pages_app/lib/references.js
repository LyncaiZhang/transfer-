'use strict';
/**
 * references.js — 真实联网参考发现与匹配（wenjin/references.py 的 Node 移植）。
 *
 * 硬纪律不变：
 * · 每个候选必须有真实可取回的 url（搜狗跳转页解析不出真实 URL 的直接丢弃）；
 * · 只见摘要就标 snippet_only，不写「已核验全文」；
 * · 相似点来自可观察的文本特征，差异至少 1 条；
 * · 不满 3 条就返回 0–2 条，不凑数；
 * · 搜到的结果若与输入无共同锚点词，直接判为不相关并丢弃。
 */

const engine = require('./engine');
const websearch = require('./websearch');

const STAGE_WORDS = ['验收', '示范', '中试', '工程化', '量产', '挂网', '检测报告', '型式批准',
  '防爆', '试点', '投运', '现场应用'];

const ANCHOR_GASES = engine.GAS_TERMS.filter((g) => !['气体', '可燃气体', '有毒气体'].includes(g));

const JUNK_DOMAINS = ['baike.baidu.com', 'zhidao.baidu.com', 'mail.qq.com', 'hanyuguoxue.com',
  'zdic.net', 'gushici.net', 'zhihu.com/topic', 'wikipedia.org', 'dict.', 'cidian', 'zidian'];

const DOMAIN_KIND = [
  [/(cnki|wanfang|doi\.org|sciencedirect|springer|ieee|nature\.com|mdpi|arxiv)/, '论文/文献库'],
  [/(\.gov\.cn|\.gov$)/, '政府/监管'],
  [/(\.edu\.cn|\.edu$)/, '高校/科研机构'],
  [/(std\.samr)/, '标准'],
  [/(zhihu|baijiahao|sohu|163\.com|sina|csdn|docin|doc88)/, '媒体/自媒体/文库'],
  [/(公司|inc|corp|ltd|\.com\.cn|\.com)/, '企业站点'],
];

const INPUT_KIND = '用户输入的材料';

function kindOf(url, title) {
  const s = `${url} ${title}`.toLowerCase();
  for (const [pat, kind] of DOMAIN_KIND) {
    if (pat.test(s)) return kind;
  }
  return '其他公开网页';
}

function junk(url) {
  const u = url.toLowerCase();
  return JUNK_DOMAINS.some((j) => u.includes(j));
}

function features(text) {
  const up = (text || '').toUpperCase();
  const yr = (text || '').match(/(20\d{2})/);
  return {
    routes: engine.ROUTE_TERMS.filter((r) => up.includes(r.toUpperCase())),
    gases: ANCHOR_GASES.filter((g) => up.includes(g.toUpperCase())),
    stages: STAGE_WORDS.filter((w) => (text || '').includes(w)),
    year: yr ? yr[1] : null,
  };
}

function anchorsOf(text, kw) {
  let a = (kw.routes || []).concat((kw.gases || []).filter((g) => ANCHOR_GASES.includes(g)));
  if (!a.length) {
    a = (text.match(/[\u4e00-\u9fa5]{3,6}/g) || []).slice(0, 4);
  }
  return [...new Set(a)].filter(Boolean);
}

function buildQueries(text, kw, targetUse) {
  const routes = kw.routes || [];
  const gases = (kw.gases || []).filter((g) => ANCHOR_GASES.includes(g));
  let head = [routes[0], gases[0]].filter(Boolean).join(' ').trim();
  if (!head) {
    head = (targetUse || '').slice(0, 16) ||
      (text || '').replace(/[\s，。；：、]+/g, ' ').slice(0, 20).trim();
  }
  return [`${head} 中试 验收 示范应用`.trim(), `${head} 工程化 应用 案例`.trim()];
}

function relevance(item, inFeat, strict = false) {
  const blob = `${item.title || ''} ${item.snippet || ''} ${item.page_text || ''}`;
  const f = features(blob);
  const routeHit = f.routes.some((r) => inFeat.routes.includes(r));
  const gasHit = f.gases.some((g) => inFeat.gases.includes(g));
  const stageHit = f.stages.some((s) => STAGE_WORDS.includes(s));
  if (!routeHit && !gasHit) return [false, null];
  if (!strict) return [true, routeHit ? '技术路线相近' : '应用场景相近'];
  const authority = websearch.isAuthority(item.url || '');
  const sensorCtx = /(传感器|探测器|检测仪|气敏|敏感元件|分析仪|监测仪|仪表|测量装置)/.test(blob);
  if (stageHit) return [true, '阶段任务相近'];
  if (routeHit && gasHit && sensorCtx) return [true, '技术路线相近'];
  if ((routeHit || gasHit) && authority) return [true, routeHit ? '技术路线相近' : '应用场景相近'];
  return [false, null];
}

function score(cand, inFeat) {
  const blob = `${cand.title || ''} ${cand.snippet || ''} ${cand.page_text || ''}`;
  const f = features(blob);
  let s = 0.0;
  s += 3.0 * f.routes.filter((r) => inFeat.routes.includes(r)).length;
  s += 2.5 * f.gases.filter((g) => inFeat.gases.includes(g)).length;
  s += 1.5 * Math.min(f.stages.length, 3);
  if (websearch.isAuthority(cand.url || '')) s += 1.5;
  if (f.year && inFeat.year) {
    s += Math.max(0.0, 1.0 - Math.abs(parseInt(f.year, 10) - parseInt(inFeat.year, 10)) / 6.0);
  }
  if (cand.access_status === 'full') s += 1.0;
  if ((cand.title || '').length < 8) s -= 1.0;
  return Math.round(s * 100) / 100;
}

function similarities(cand, inFeat, dimension) {
  const blob = `${cand.title || ''} ${cand.snippet || ''} ${cand.page_text || ''}`;
  const f = features(blob);
  const sims = [];
  const rHit = f.routes.find((r) => inFeat.routes.includes(r));
  if (rHit) sims.push(`技术路线同含「${rHit}」，可对照其验证方法与指标口径`);
  const gHit = f.gases.find((g) => inFeat.gases.includes(g));
  if (gHit) sims.push(`目标气体同含「${gHit}」，量程与干扰条件具备可比性`);
  const shared = f.stages.filter((s) => STAGE_WORDS.includes(s));
  if (shared.length) sims.push(`同处「${shared[0]}」环节，可对照其需要哪些证据`);
  if (!sims.length && dimension) sims.push(`按「${dimension}」匹配到该来源，细节需人工判断`);
  return sims.slice(0, 3);
}

function differences(cand, inFeat) {
  const blob = `${cand.title || ''} ${cand.snippet || ''} ${cand.page_text || ''}`;
  const f = features(blob);
  const diffs = [];
  if (['snippet_only', 'blocked', 'failed'].includes(cand.access_status)) {
    diffs.push('仅取到摘要或正文受限，未核验全文，不可据此判断其工程验证深度');
  }
  if (!f.stages.length) {
    diffs.push('候选未出现验收/检测报告类表述，只能作技术路线参考，不能当阶段证据');
  }
  if (f.year && inFeat.year && f.year !== inFeat.year) {
    diffs.push(`候选时间为 ${f.year}，与输入材料相隔 ${Math.abs(parseInt(f.year, 10) - parseInt(inFeat.year, 10))} 年，` +
      '器件工艺与适用标准可能已变化');
  }
  const kind = kindOf(cand.url || '', cand.title || '');
  if (kind === '媒体/自媒体/文库' || kind === '企业站点') {
    diffs.push(`来源类型为${kind}（宣传/二手口径），与${INPUT_KIND}的证据等级不同`);
  }
  if (f.gases.length && inFeat.gases.length && !f.gases.some((g) => inFeat.gases.includes(g))) {
    diffs.push(`候选主讨论「${f.gases[0]}」，与输入目标气体不同，量程与干扰条件不可直接迁移`);
  }
  if (!diffs.length) {
    diffs.push('候选与输入的应用工况（温度/压力/粉尘/维护条件）未披露，不可直接迁移');
  }
  return diffs.slice(0, 2);
}

/**
 * findReferences — references.find_references 的移植。
 * @param {string} text
 * @param {object} opts {targetUse, stage, limit, maxQueries=2, maxFetch=3, fetchPages=true}
 */
async function findReferences(text, opts = {}) {
  const targetUse = opts.targetUse || null;
  const limit = Math.max(1, Math.min(parseInt(opts.limit || 3, 10) || 3, 3));
  const maxQueries = opts.maxQueries || 2;
  const maxFetch = opts.maxFetch || 3;
  const fetchPages = opts.fetchPages !== false;

  const kw = engine.keywords(text);
  const inFeat = features(text);
  inFeat._anchors = anchorsOf(text, kw);
  const queries = buildQueries(text, kw, targetUse).slice(0, maxQueries);

  const log = [];
  const pool = new Map();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (i > 0 && pool.size >= 2) {
      log.push({ query: q, status: 'skipped', reason: '已有足够候选，未发第二次检索' });
      break;
    }
    const r = await websearch.search(q, 10);
    log.push({ query: q, status: r.status, engine: r.engine || null,
      returned: (r.results || []).length, errors: r.errors || null,
      cached: !!r.cached, retrieved_at: r.retrieved_at });
    for (const item of r.results || []) {
      const url = (item.url || '').trim();
      if (!url.startsWith('http') || pool.has(url) || junk(url)) continue;
      const [ok, dim] = relevance(item, inFeat);
      if (!ok) continue;
      pool.set(url, Object.assign({}, item, { access_status: 'snippet_only', page_text: '',
        page_title: null, match_dimension: dim }));
    }
  }

  if (!pool.size) {
    const ok = log.some((l) => l.status === 'success');
    const blocked = !ok && log.some((l) =>
      (JSON.stringify(l.errors) || '').includes('验证码') || (JSON.stringify(l.errors) || '').includes('频率'));
    const status = !ok ? 'failed' : (blocked ? 'blocked' : 'no_match');
    return {
      references: [], search_status: status, queries: log,
      note: status === 'blocked' ? '检索通道被限频或不可用，本轮未取得参考；分析结果不受影响'
        : status === 'no_match' ? '检索正常但没有与输入相关的来源（按纪律不凑数）'
        : '检索引擎全部失败；分析结果不受影响',
      retrieved_at: websearch.nowStamp(),
    };
  }

  // 每个域名最多 1 条
  const byDomain = new Map();
  const dedup = [];
  const sorted = [...pool.values()].sort((a, b) => score(b, inFeat) - score(a, inFeat));
  for (const c of sorted) {
    const d = websearch.domainOf(c.url);
    if ((byDomain.get(d) || 0) >= 1) continue;
    byDomain.set(d, (byDomain.get(d) || 0) + 1);
    dedup.push(c);
  }
  const cands = dedup.slice(0, Math.max(limit, 3));

  if (fetchPages) {
    for (const c of cands.slice(0, maxFetch)) {
      const page = await websearch.fetchText(c.url);
      c.access_status = page.access_status;
      c.http_code = page.http_code;
      c.page_text = (page.text || '').slice(0, 6000);
      c.page_title = page.title;
      c.fetched_at = page.retrieved_at;
      c.fetch_error = page.error;
    }
  }

  const strict = [];
  for (const c of cands) {
    const [ok, dim] = relevance(c, inFeat, true);
    if (ok) {
      c.match_dimension = dim;
      strict.push(c);
    }
  }
  strict.sort((a, b) => score(b, inFeat) - score(a, inFeat));
  if (!strict.length) {
    return { references: [], search_status: 'no_match', queries: log,
      note: '有候选来源，但正文与输入的技术路线/验证环节相关度不足，按纪律不凑数',
      retrieved_at: websearch.nowStamp() };
  }
  const refs = [];
  for (const c of strict) {
    if (refs.length >= limit) break;
    refs.push({
      title: ((c.title || c.page_title || '（标题未取到）')).slice(0, 120),
      organization: c.display_domain || websearch.domainOf(c.url),
      url: c.url,
      published_at: features(`${c.title || ''} ${c.snippet || ''}`).year,
      similarities: similarities(c, inFeat, c.match_dimension),
      differences: differences(c, inFeat),
      access_status: c.access_status || 'snippet_only',
      retrieved_at: websearch.nowStamp(),
      http_code: c.http_code,
      source_kind: kindOf(c.url, c.title || ''),
      match_dimension: c.match_dimension,
      snippet: (c.snippet || '').slice(0, 260),
      relevance_score: score(c, inFeat),
    });
  }
  const statuses = new Set(refs.map((r) => r.access_status));
  let st;
  if ([...statuses].every((s) => s === 'blocked')) st = 'blocked';
  else if (statuses.has('full')) st = 'success';
  else if ([...statuses].every((s) => ['snippet_only', 'blocked', 'failed'].includes(s))) st = 'snippet_only';
  else st = 'success';
  return { references: refs, search_status: st, queries: log,
    note: '外部参考只用于借鉴，不是当前项目达到同阶段的证据',
    retrieved_at: websearch.nowStamp() };
}

/**
 * libraryMatches — 库内可比案例（词面共现；来源 URL 均来自库内记录）。
 * @param {Array} cases 已人工核对原文的案例行（来自数据层）
 */
function libraryMatches(cases, text, limit = 2) {
  const kw = engine.keywords(text);
  const feat = features(text);
  const out = [];
  for (const c of cases) {
    const blob = ['tech', 'institution', 'claimed', 'outcome', 'blocking_evidence',
      'maps_to_dim', 'clears_gap', 'note'].map((k) => String(c[k] || '')).join(' ');
    const f = features(blob);
    const s = 3.0 * f.routes.filter((r) => feat.routes.includes(r)).length +
      2.0 * f.gases.filter((g) => feat.gases.includes(g)).length +
      1.0 * f.stages.filter((x) => feat.stages.includes(x)).length;
    if (s <= 0) continue;
    const why = [];
    const rShared = f.routes.filter((r) => feat.routes.includes(r));
    if (rShared.length) why.push('同技术路线：' + [...new Set(rShared)].sort().join('、'));
    const gShared = f.gases.filter((g) => feat.gases.includes(g));
    if (gShared.length) why.push('同目标气体：' + [...new Set(gShared)].sort().join('、'));
    const sShared = f.stages.filter((x) => feat.stages.includes(x));
    if (sShared.length) why.push('同验证环节：' + [...new Set(sShared)].join('、'));
    out.push({
      case_id: c.case_id, kind: c.kind, tech: c.tech, institution: c.institution,
      evidence_level: c.evidence_level, verification_status: c.verification_status,
      why_comparable: why.length ? why : ['词面相近'],
      takeaway: c.clears_gap, limitations: c.blocking_evidence,
      url: c.source_url, published_at: c.published_at,
      retrieved_at: c.retrieved_at, score: Math.round(s * 100) / 100,
    });
  }
  out.sort((a, b) => b.score - a.score);
  const seenInst = new Set();
  const dedup = [];
  for (const x of out) {
    const inst = (x.institution || '').split(/[（(]/)[0];
    const key = inst.replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|公司|研究所|研究院)$/, '').trim();
    if (key && seenInst.has(key)) continue;
    seenInst.add(key);
    dedup.push(x);
  }
  return dedup.slice(0, limit);
}

module.exports = { findReferences, libraryMatches, features, relevance, score };
