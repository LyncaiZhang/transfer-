'use strict';
/**
 * criteria.js — 判据适配层（Node 移植副本）。
 *
 * 纪律（与 09_问津智能体/wenjin/criteria.py 头注一致）：
 * · 本文件不定义任何新判据阈值。全部常量来自生成的 criteria.json
 *   （生成器：04_构建脚本/export_criteria_json.py；唯一权威：07_证据库/run_triage.py）。
 * · is_ticket 是 run_triage.is_ticket 的逐行移植；行为一致性由
 *   04_构建脚本/build_wenjin_parity_fixtures.py 生成的 fixtures 奇偶校验锁定。
 * · run_triage.py 一改：必须重跑导出器 + fixtures 生成器，并让 parity 重新全绿。
 */

const CRITERIA = require('./criteria.json');

const STAGES = CRITERIA.stages;
const TICKET_LEVELS = CRITERIA.ticket_levels;          // ["A","B"]
const TICKET_TYPES = CRITERIA.ticket_types;            // ["acceptance","test_record","test_report"]
const ACCESS_BLOCKING = CRITERIA.access_blocking;      // ["adverse"]
const ACCESS_UNVERIFIABLE = CRITERIA.access_unverifiable; // ["insufficient"]
const DURATION_BAND = CRITERIA.duration_band;          // [3, 15]
const DIM_NAMES = CRITERIA.dim_names;
const CLAIM_WORDS = CRITERIA.claim_words;
const TICKET_EXCLUDE_WORDS = CRITERIA.ticket_exclude_words;
const WORDING = CRITERIA.wording;                      // {done, planned, claimed, not_found}
const ACCESS_LAYERS = CRITERIA.access_layers;          // ["强制准入","市场型认证","标准与定期检定"]
const LEVEL_MEANING = CRITERIA.level_meaning;
const CLASSIFICATION_NOTICE = CRITERIA._meta.classification_notice;
const DRAFT_NOTICE = CRITERIA._meta.draft_notice;
const RULE_VERSION = CRITERIA._meta.rule_version;

/**
 * is_ticket — run_triage.is_ticket 的逐行移植（condition 固定用 "A"）。
 * e: {wording, supports, evidence_level, evidence_type, verification_status, scope, claim}
 */
function isTicket(e, condition = 'A') {
  if (condition === 'D') return false;
  if (e.wording !== WORDING.done || e.supports !== '支持') return false;
  if (condition === 'C') return true;
  if (!TICKET_LEVELS.includes(e.evidence_level)) return false;
  if (!TICKET_TYPES.includes(e.evidence_type)) return false;
  if ((condition === 'A' || condition === 'B') && e.verification_status !== '人工已核对原文') return false;
  if (condition === 'A' || condition === 'B') {
    const blob = (e.scope || '') + (e.claim || '');
    if (TICKET_EXCLUDE_WORDS.some((k) => blob.includes(k))) return false;
  }
  return true;
}

/** to_evidence_row — criteria.to_evidence_row 的移植（新输入侧行形状）。 */
function toEvidenceRow(claim) {
  return {
    evidence_id: claim.claim_id || null,
    claim: claim.claim || '',
    scope: claim.locator || '',
    wording: claim.wording || WORDING.claimed,
    evidence_level: claim.evidence_level || 'C',
    evidence_type: claim.evidence_type || 'institution_claim',
    verification_status: claim.verification_status || '未核',
    supports: claim.supports || '支持',
  };
}

/** ticket_state — 同一行跑两次 is_ticket 的差集给出「只差人工核对」的候选。 */
function ticketState(claim) {
  const row = toEvidenceRow(claim);
  const confirmed = isTicket(row, 'A');
  if (confirmed) return { confirmed: true, candidate: true, missing: [] };
  const probe = Object.assign({}, row);
  probe.verification_status = '人工已核对原文';
  const structural = isTicket(probe, 'A');
  const missing = [];
  if (structural) missing.push('人工已核对原文');
  return { confirmed: false, candidate: structural, missing };
}

function ticketSummary(claims) {
  const confirmed = [];
  const candidates = [];
  for (const c of claims) {
    const st = ticketState(c);
    if (st.confirmed) confirmed.push(c.claim_id);
    else if (st.candidate) candidates.push(c.claim_id);
  }
  return {
    confirmed,
    candidates,
    levels: TICKET_LEVELS.slice().sort(),
    types: TICKET_TYPES.slice().sort(),
  };
}

module.exports = {
  CRITERIA, STAGES, TICKET_LEVELS, TICKET_TYPES, ACCESS_BLOCKING, ACCESS_UNVERIFIABLE,
  DURATION_BAND, DIM_NAMES, CLAIM_WORDS, TICKET_EXCLUDE_WORDS, WORDING, ACCESS_LAYERS,
  LEVEL_MEANING, CLASSIFICATION_NOTICE, DRAFT_NOTICE, RULE_VERSION,
  isTicket, toEvidenceRow, ticketState, ticketSummary,
};
