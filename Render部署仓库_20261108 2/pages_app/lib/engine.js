'use strict';
/**
 * engine.js — 问津确定性分析引擎（Node 移植副本）。
 *
 * 移植来源（逐函数对应，不改逻辑、不改文案）：
 *   · 09_问津智能体/wenjin/extract.py   → 本文件前半部（抽取/定级/冲突/时长/三层/事件/缺口/行动/阶段）
 *   · 09_问津智能体/wenjin/service.py   → analyzeCase（validate_input/guess_title/_summary_text/组装）
 *   · 判据常量与 is_ticket               → lib/criteria.js（来自生成的 criteria.json）
 *
 * 一致性保证：04_构建脚本/build_wenjin_parity_fixtures.py 用 Python 引擎在固定语料上
 * 生成期望输出，pages_app/tests/parity.mjs 逐字段比对；两引擎输出必须完全一致
 * （仅剔除 request_id / elapsed_ms 这两个运行时字段）。Python 端判据一改即重生成 fixtures，
 * parity 不绿不得发布。
 *
 * 已知边界（如实）：字符 offset 按 UTF-16 码元计，与 Python 码点计数在 BMP 汉字上一致；
 * 输入含增补平面字符（如 emoji）时 locator 区间可能与 Python 版有偏差——公网页面在
 * 输入说明中已提示不要粘贴 emoji；本地 Python 服务不受此限制。
 */

const C = require('./criteria');

// ── 句式模式表（与 wenjin/extract.py 逐条对应；只做词面识别）────────────
const PLAN_PAT = /(计划|拟于|拟在|拟与|拟向|拟开展|拟进行|拟通过|拟采用|拟建设|拟投资|预计|将要|即将|筹备|正在推进|下一步|有望|意向|打算)/;
const DONE_PAT = /(已完成|已实现|已通过|已获得|已取得|已建成|已投运|已挂网|已量产|已交付|已应用|已签署|已授权|已受理|通过验收|验收通过|验收结论为通过|完成[^，。；]{0,8}(验收|测试|检测|中试|试制|标定)|出具[^，。；]{0,6}报告|已开展)/;
const DONE_STRONG = /(已完成|已实现|已通过|已获得|已取得|已建成|已投运|已挂网|已量产|已交付|通过验收|验收通过|验收结论为通过)/;
const NEG_SEARCH_PAT = /(未检索到|未见报道|未发现|未查询到|检索无结果)/;
const ABSENT_PAT = /(尚未取得|未取得|尚未获得|未获得|尚未通过|未通过|不具备|没有取得|暂无)/;

// 判据适用域提示（与 wenjin/extract.py 的 IN_DOMAIN_PAT／DOMAIN_NOTICE 逐字一致）。
// 不参与判定：stage／证据级／门票／第 6 维都不受影响，只追加一条 limitations 声明。
const IN_DOMAIN_PAT = /(气体|烟气|尾气|烟囱|甲烷|沼气|乙烷|丙烷|丁烷|天然气|液化气|可燃气体|可燃|有毒|有害|VOC|挥发性有机物|粉尘|气溶胶|PM2\.5|PM10|颗粒物|泄漏|逸散|无组织排放|排放浓度|硫化氢|二氧化硫|一氧化氮|氮氧化物|氨气|氢气|氯气|臭氧|一氧化碳|二氧化碳|CO2|CO\b|O2|瓦斯|矿井|隧道|管廊|有限空间|电子鼻|气味|嗅觉|气敏|光谱|色谱|NDIR|TDLAS|激光甲烷|计量器具|型式批准|防爆|本安|CPA|计量检定)/g;
const DOMAIN_NOTICE = '本材料的判据适用域提示：项目首个深入验证场景为「工业气体传感与检测」，第 6 维准入清单（计量器具型式批准 CPA／防爆合格证／GB 15322.1-2019／GB/T 3836）与 T2→T4 经验时长区间均按该品类校准；本次输入未命中该品类词表，判据适用性仍需人工核对，不得当作跨行业已验证的结论。';

function domainCheck(text, targetUse) {
  const hay = (text || '') + ' ' + (targetUse || '');
  IN_DOMAIN_PAT.lastIndex = 0;
  const set = new Set();
  let m;
  while ((m = IN_DOMAIN_PAT.exec(hay)) !== null) {
    set.add(m[0]);
    if (m.index === IN_DOMAIN_PAT.lastIndex) IN_DOMAIN_PAT.lastIndex += 1;   // 防空转
  }
  const hits = Array.from(set).sort().slice(0, 8);
  const inDomain = hits.length > 0;
  return {
    in_domain: inDomain,
    matched_terms: hits,
    notice: inDomain ? '' : DOMAIN_NOTICE,
    reason: inDomain ? '命中「工业气体传感与检测」品类词表' : '未命中品类词表，判据适用性待核对',
  };
}

const LEVEL_A_THIRD = /(第三方|检测中心|计量院|研究院|检验检测|认证机构|检测机构|实验室认可|CMA|CNAS|CNCA|SGS|TÜV|TUV|Intertek|UL实验室)/;
const LEVEL_A_DOC = /(检测报告|测试报告|检验报告|验收报告|验收意见|验收结论|现场验收|型式批准证书|防爆合格证|检定证书|校准证书)/;
const LEVEL_A_ID = /(报告编号|证书编号|证号|编号[:：]\s*[A-Za-z0-9\-]+|NO\.?\s*\d)/;
const LEVEL_B_OFFICIAL = /(工业和信息化部|工信部|科学技术部|科技部|国家发展改革委|发改委|市场监管总局|国家知识产权局|国家标准化管理委员会|省人民政府|市人民政府|省科技厅|市科技局|教育局|财政部|证监会|证券交易所|上市公司公告|年度报告|行业标准|国家标准|团体标准)/;
const LEVEL_B_CERT_BODY = /(起草单位|主要起草|归口单位|标准化技术委员会)/;

const EVENT_PATTERNS = [
  ['deployment', /(挂网运行|挂网|现场运行|实际工况|投运|投入运行|部署于|装机|上线运行|连续运行\s*\d+\s*(天|小时|月))/],
  ['scale_up', /(量产|规模化生产|批量交付|批量生产|产线|年产能)/],
  ['pilot', /(中试|工程化|示范工程|示范应用|放大试验|工业侧线)/],
  ['prototype', /(样机|原型|试制|研制出|首台)/],
  ['validation', /(实验|测试|标定|检定|校准|验证|比对|台架|性能考核)/],
  ['partnership', /(合作|联合|共建|签署.*协议|战略合作|产学研)/],
  ['license', /(许可|licence|license|专利许可|技术许可)/],
  ['transfer', /(转让|作价入股|技术入股|成果转化|落地转化)/],
  ['research', /(研究|论文|机理|理论|原理|提出|设计|仿真|模型)/],
];

const STAGE_HINTS = [
  ['T4', /(挂网运行|挂网|量产|规模化|批量交付|装机|实际工况运行|连续运行\s*\d+\s*(天|小时|月))/],
  ['T3', /(中试|示范应用|示范工程|工程化|现场应用|工业现场|投运|部署于|工业侧线)/],
  ['T2', /(样机|实验|测试|试制|研制|标定|台架|检出限|响应时间|选择性|重复性)/],
  ['T1', /(机理|原理|提出|设计|方案|仿真|理论|思路)/],
];

const ACCESS_PATTERNS = {
  '强制准入': /(型式批准|CPA|计量器具|强制检定|防爆合格证|防爆认证|防爆标志|Ex\s*[a-zA-Z]|矿用产品安全标志|MA标志|强制性认证|CCC认证|GB\s*15322|GB\s*3836|GB\/T\s*3836)/,
  '市场型认证': /(CE认证|CE\s*标志|ATEX|SIL\s*[1-4]|UL\s*\d{3,}|UL认证|IATF\s*16949|RoHS|REACH|功能安全认证)/,
  '标准与定期检定': /(标准.*起草|参与.*制修订|主持.*标准|检定证书|校准证书|计量检定|周期检定|定期检定)/,
};
const ACCESS_ABSENT = /(尚未取得|未取得|没有取得|尚未获得|未获得|尚未通过|未通过|不具备)/;

const METRIC_PAT_G = /(检出限|检测限|灵敏度|响应时间|恢复时间|精度|准确度|误差|选择性|寿命|功耗|量程|转化率|效率|产能)[^\d，。；]{0,8}?(\d+(?:\.\d+)?)\s*(ppm|ppb|%|s|秒|分钟|小时|年|吨|台|万元|亿元|mV|nA)?/g;
const YEAR_PAT_G = /(19\d{2}|20\d{2})\s*(?:年|-)?/g;

const REGULATED_USE = /(报警|检测仪|探测器|监测仪|安全仪表|爆炸性环境|矿井|燃气|有毒有害|易燃易爆|工业现场|在线监测)/;
const LAB_USE = /(实验室|科研|分析仪器|教学|方法研究|原理验证|预研)/;

const GAS_TERMS = ['甲烷', '氢气', '硫化氢', '一氧化碳', '二氧化碳', 'VOC', '氨气', '氮氧化物',
  '二氧化硫', '氧气', '可燃气体', '有毒气体', '气体'];
const ROUTE_TERMS = ['NDIR', '红外', '电化学', '半导体', '催化燃烧', '光离子化', 'PID', '激光',
  'TDLAS', '气相色谱', '电子鼻', 'MEMS', '光纤', '石英晶体', '表面声波', 'SAW',
  'MOS', 'MOX', '荧光', '拉曼', '质谱'];

const ACTUAL_ENV_PAT = /(挂网运行|挂网|现场运行|实际工况|实际环境|投运|投入运行|装机|工业现场运行|在线运行)/;
const DURATION_PAT = /((连续|累计|稳定)?运行\s*\d+\s*(小时|天|个月|月)|连续运行[^，。；]{0,8}\d+\s*(小时|天))/;
const ORGANISER_PAT = /(验收组织方|验收单位|验收主体|组织验收|由[^，。；]{2,20}(组织|主持|牵头)(现场)?验收)/;
const IDENTIFIER_PAT = /(报告编号|证书编号|证号|批准文号|备案号)\s*[:：]?\s*[A-Za-z0-9\-]+/;

// ── 基础工具 ────────────────────────────────────────────────────────────
function pyRound2(x) {
  // Python round(x, 2)＝十进制银行家舍入；对正数用浮点修正近似实现（语料内不触发边界）。
  const scaled = x * 100;
  const floorV = Math.floor(scaled);
  const diff = scaled - floorV;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = (floorV % 2 === 0) ? floorV : floorV + 1;
  else r = Math.round(scaled);
  return r / 100;
}

function normalize(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/[ \t\u3000]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function splitSentences(text) {
  const seps = '。！？；!?;\n';
  const out = [];
  let bufStart = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (seps.includes(ch)) {
      const seg = text.slice(bufStart, i + 1);
      if (seg.trim()) out.push({ idx: out.length + 1, start: bufStart, end: i + 1, text: seg.trim() });
      bufStart = i + 1;
    }
  }
  if (bufStart < n && text.slice(bufStart).trim()) {
    out.push({ idx: out.length + 1, start: bufStart, end: n, text: text.slice(bufStart).trim() });
  }
  return out.filter((s) => s.text.length >= 6);
}

function hasValue(seg) {
  const core = seg.replace(/(19|20)\d{2}\s*年(\s*\d{1,2}\s*月)?(份)?/g, '');
  if (/\d/.test(core)) return true;
  const pats = [DONE_PAT, PLAN_PAT, ABSENT_PAT, NEG_SEARCH_PAT, LEVEL_A_DOC, LEVEL_A_ID,
    LEVEL_A_THIRD, LEVEL_B_OFFICIAL, LEVEL_B_CERT_BODY];
  if (pats.some((p) => p.test(seg))) return true;
  return Object.values(ACCESS_PATTERNS).some((p) => p.test(seg));
}

function splitClauses(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    const pieces = [];
    let start = s.start;
    for (let i = s.start; i < s.end; i++) {
      if ('，,、'.includes(text[i])) {
        const seg = text.slice(start, i + 1);
        if (seg.trim()) pieces.push([start, i + 1]);
        start = i + 1;
      }
    }
    if (text.slice(start, s.end).trim()) pieces.push([start, s.end]);

    const chunks = [];
    let cur = null;
    for (const [a, b] of pieces) {
      if (cur === null) {
        cur = [a, b];
      } else {
        const segNow = text.slice(cur[0], cur[1]);
        if (!hasValue(segNow) && segNow.length < 40 && (b - cur[0]) <= 90) {
          cur[1] = b;
        } else {
          chunks.push([cur[0], cur[1]]);
          cur = [a, b];
        }
      }
    }
    if (cur) chunks.push([cur[0], cur[1]]);

    for (const [a, b] of chunks) {
      const seg = text.slice(a, b).trim();
      if (seg.length >= 4) out.push({ sentence_idx: s.idx, start: a, end: b, text: seg });
    }
  }
  return out;
}

function classifyLevel(sent) {
  const planned = PLAN_PAT.test(sent) && !DONE_PAT.test(sent);
  if (planned) return ['D', 'planned_item'];
  if (ACCESS_PATTERNS['强制准入'].test(sent) && LEVEL_A_ID.test(sent)) return ['A', 'market_access'];
  if ((LEVEL_A_THIRD.test(sent) && LEVEL_A_DOC.test(sent)) ||
      (LEVEL_A_DOC.test(sent) && LEVEL_A_ID.test(sent))) {
    return ['A', sent.includes('验收') ? 'acceptance' : 'test_record'];
  }
  if (LEVEL_B_CERT_BODY.test(sent)) return ['B', 'policy_or_standard'];
  if (LEVEL_B_OFFICIAL.test(sent)) {
    return ['B', /(上市|并购|投资|营收|中标|采购)/.test(sent) ? 'commercial_event' : 'policy_or_standard'];
  }
  if (/(验收|检测|测试)/.test(sent) && /(报告|记录|意见)/.test(sent)) {
    return ['C', sent.includes('验收') ? 'acceptance' : 'test_record'];
  }
  return ['C', 'institution_claim'];
}

function classifyWording(sent) {
  if (NEG_SEARCH_PAT.test(sent)) return C.WORDING.not_found;
  if (ABSENT_PAT.test(sent)) return C.WORDING.claimed;
  if (DONE_PAT.test(sent)) return C.WORDING.done;
  if (PLAN_PAT.test(sent)) return C.WORDING.planned;
  return C.WORDING.claimed;
}

function classifyEvent(sent) {
  for (const [name, pat] of EVENT_PATTERNS) {
    if (pat.test(sent)) return name;
  }
  return 'other';
}

function stageHint(sent) {
  for (const [st, pat] of STAGE_HINTS) {
    if (pat.test(sent)) return st;
  }
  return null;
}

function extractYears(sent) {
  const out = [];
  for (const m of sent.matchAll(YEAR_PAT_G)) out.push(parseInt(m[1], 10));
  return out;
}

function limitation(level, wording, etype, years) {
  const bits = [];
  if (level === 'A') bits.push('第三方记录，原文未核，编号需回查');
  else if (level === 'B') bits.push('单位披露，非检测记录');
  else if (level === 'C') bits.push('自述口径，最高支持 T2（须标“来源声称”）');
  else bits.push('计划/意向，不得提升阶段');
  if (wording === C.WORDING.not_found) bits.push('否定性表述，未给检索范围，不能推断事件不存在');
  if (!years.length) bits.push('未披露时间');
  if (etype === 'acceptance') bits.push('验收类须补组织方与连续运行时长');
  return bits.join('；');
}

function extractClaims(text, asOf) {
  const sentLevel = new Map();
  for (const s of splitSentences(text)) sentLevel.set(s.idx, classifyLevel(s.text));
  const claims = [];
  for (const cl of splitClauses(text)) {
    const seg = cl.text;
    const sidx = cl.sentence_idx;
    let [level, etype] = sentLevel.get(sidx) || ['C', 'institution_claim'];
    if ((level === 'A' || level === 'B') && !(
      LEVEL_A_DOC.test(seg) || LEVEL_A_ID.test(seg) || LEVEL_A_THIRD.test(seg) ||
      LEVEL_B_OFFICIAL.test(seg) || LEVEL_B_CERT_BODY.test(seg))) {
      level = 'C';
      etype = 'institution_claim';
    }
    const wording = classifyWording(seg);
    if (wording === C.WORDING.planned) {
      level = 'D';
      etype = 'planned_item';
    }
    const event = classifyEvent(seg);
    const hint = stageHint(seg);
    const years = extractYears(seg);
    let supports = '支持';
    if (wording === C.WORDING.planned || wording === C.WORDING.not_found || ABSENT_PAT.test(seg)) {
      supports = '未支持';
    }
    const body = seg.length <= 160 ? seg : seg.slice(0, 160);
    claims.push({
      claim_id: 'IN-' + String(claims.length + 1).padStart(2, '0'),
      claim: body,
      source_id: 'USER_INPUT',
      locator: `输入第 ${sidx} 句·字符 ${cl.start}-${cl.end}`,
      published_at: years.length ? String(Math.max(...years)) : null,
      evidence_level: level,
      evidence_type: etype,
      wording,
      supports,
      stage_hint: hint,
      event_type: event,
      verification_status: '未核',
      draft_level: true,
      limitation: limitation(level, wording, etype, years),
    });
  }
  const seen = new Set();
  const dedup = [];
  for (const c of claims) {
    const key = c.claim.slice(0, 24) + '|' + c.wording;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }
  dedup.forEach((c, i) => { c.claim_id = 'IN-' + String(i + 1).padStart(2, '0'); });
  return dedup;
}

function detectConflicts(claims) {
  const buckets = new Map();
  for (const c of claims) {
    for (const m of c.claim.matchAll(METRIC_PAT_G)) {
      const metric = m[1];
      const val = m[2] + (m[3] || '');
      if (!buckets.has(metric)) buckets.set(metric, []);
      buckets.get(metric).push([c.claim_id, val, c.claim]);
    }
  }
  const out = [];
  for (const [metric, items] of buckets) {
    const values = [...new Set(items.map((it) => it[1]))];
    if (values.length > 1) {
      const sv = values.slice().sort();
      out.push({
        metric,
        values: sv,
        claim_ids: items.map((it) => it[0]),
        note: `同一输入内「${metric}」出现 ${values.length} 个不同取值（${sv.join('、')}），` +
          '按纪律单列冲突，数值进禁止引用清单，不取平均、不静默选一个。',
      });
    }
  }
  return out;
}

function detectDuration(claims, asOf) {
  const years = [];
  for (const c of claims) years.push(...extractYears(c.claim));
  years.sort((a, b) => a - b);
  const earliest = years.length ? years[0] : null;
  let elapsed = null;
  if (earliest !== null) {
    try {
      const asOfMs = Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1, +asOf.slice(8, 10));
      const eMs = Date.UTC(earliest, 0, 1);
      const days = Math.round((asOfMs - eMs) / 86400000);
      elapsed = pyRound2(days / 365.0);
    } catch (e) { elapsed = null; }
  }
  let red = false;
  let belowBand = false;
  let reason = '输入未披露可定位的年份，无法计算时长';
  if (elapsed !== null) {
    const highDone = claims.some((c) => (c.stage_hint === 'T3' || c.stage_hint === 'T4') &&
      c.wording === C.WORDING.done);
    const fastClaim = /(一年内|当年|半年内|数月内|个月内投产)/.test(claims.map((c) => c.claim).join(''));
    red = highDone && (elapsed < 1 || fastClaim);
    belowBand = elapsed < C.DURATION_BAND[0];
    if (red) {
      reason = `最早年份 ${earliest}，距评估截止日 ${asOf} 约 ${elapsed} 年，却有已完成的 T3/T4 级表述；` +
        `已回源的成功案例 T2→T4 经验区间为 ${C.DURATION_BAND[0]}–${C.DURATION_BAND[1]} 年，` +
        '按纪律标红并要求补验收与连续运行记录';
    } else if (highDone && belowBand) {
      reason = `最早年份 ${earliest}，距评估截止日 ${asOf} 约 ${elapsed} 年，短于经验区间 ` +
        `${C.DURATION_BAND[0]}–${C.DURATION_BAND[1]} 年；未达冻结 R6 的标红阈值（<1 年），` +
        '但时长本身偏短，核对验收文件时须一并看连续运行时长';
    } else {
      reason = `最早年份 ${earliest}，距评估截止日 ${asOf} 约 ${elapsed} 年；未触发标红` +
        '（冻结 R6 阈值：已完成高阶段表述且 elapsed<1 年）';
    }
  }
  return { earliest_year: earliest, elapsed_years: elapsed, red_flag: red,
    below_band: belowBand, reason };
}

function assessAccess(text, targetUse) {
  const rows = [];
  for (const layer of C.ACCESS_LAYERS) {
    const pat = ACCESS_PATTERNS[layer];
    const hitSentences = splitSentences(text).filter((s) => pat.test(s.text));
    const absent = hitSentences.filter((s) => ACCESS_ABSENT.test(s.text));
    let state = 'unknown';
    let reason = '输入材料未提及该层';
    if (absent.length) {
      state = 'adverse';
      reason = `材料明确表示未取得：「${absent[0].text.slice(0, 60)}」`;
    } else if (hitSentences.length) {
      const withId = hitSentences.filter((s) =>
        LEVEL_A_ID.test(s.text) || /\d+\s*(年|个月)/.test(s.text));
      if (withId.length) {
        state = 'supported';
        reason = `材料给出可回查要素：「${withId[0].text.slice(0, 60)}」`;
      } else {
        state = 'insufficient';
        reason = '提到该层但缺型号/证书编号/有效期，无法按型号粒度核实';
      }
    } else if (layer === '强制准入') {
      const use = `${targetUse} ${text}`;
      if (LAB_USE.test(use) && !REGULATED_USE.test(use)) {
        state = 'not_applicable';
        reason = '当前用途指向实验室分析/科研，未落入强制准入覆盖场景；' +
          '**用途一变、门槛即变**：同一器件若按气体报警或爆炸性环境用途上市，' +
          '即触发计量器具型式批准与防爆合格证要求';
      }
    }
    rows.push({ dim_no: 6, access_layer: layer, state, reason,
      samples: hitSentences.slice(0, 2).map((s) => s.text.slice(0, 80)) });
  }
  return rows;
}

function buildTransferEvents(claims) {
  const keep = new Set(['research', 'validation', 'prototype', 'pilot', 'partnership',
    'license', 'transfer', 'deployment', 'scale_up']);
  const statusMap = { [C.WORDING.done]: 'confirmed_in_source', [C.WORDING.planned]: 'planned',
    [C.WORDING.not_found]: 'unknown' };
  const events = new Map();
  for (const c of claims) {
    const et = c.event_type;
    if (!keep.has(et)) continue;
    const status = statusMap[c.wording] || 'source_claim';
    if (!events.has(et)) {
      events.set(et, { event_type: et, summary: c.claim.slice(0, 90),
        event_date: c.published_at, status, source_ids: [], limitations: [] });
    }
    const e = events.get(et);
    e.source_ids.push(c.claim_id);
    if (status === 'planned') e.status = 'planned';
    if (e.limitations.length < 2) e.limitations.push(c.limitation.slice(0, 70));
  }
  const order = ['research', 'validation', 'prototype', 'pilot', 'partnership',
    'license', 'transfer', 'deployment', 'scale_up'];
  return order.filter((k) => events.has(k)).map((k) => events.get(k));
}

function buildGaps(claims, accessRows, tickets, conflicts, duration, transferEvents) {
  const gaps = [];
  if (tickets.candidates.length && !tickets.confirmed.length) {
    gaps.push({ gap: `门票候选 ${tickets.candidates.length} 条（${tickets.candidates.join(', ')}）` +
      '只差人工核对原文',
    why_it_matters: '冻结判据要求 A/B 级验收类证据且「人工已核对原文」才能支撑 T3/T4；' +
      '未核对前阶段只能算初筛草稿' });
  }
  if (!tickets.candidates.length && !tickets.confirmed.length) {
    gaps.push({ gap: '无第三方现场验收/检测记录',
      why_it_matters: '跃迁门票是第三方现场验收而非论文或专利；缺失时 T3/T4 前提不成立' });
  }
  for (const row of accessRows) {
    if (['unknown', 'insufficient', 'adverse'].includes(row.state)) {
      gaps.push({ gap: `第 6 维·${row.access_layer}＝${row.state}`, why_it_matters: row.reason });
    }
  }
  if (!claims.some((c) => c.evidence_level === 'A')) {
    gaps.push({ gap: '缺 A 级（第三方检测/核验）证据',
      why_it_matters: '现有材料全部为自述、官方披露或计划，C 级最高只支持 T2' });
  }
  const deployed = transferEvents.some((e) => e.event_type === 'deployment' || e.event_type === 'scale_up');
  if (claims.some((c) => c.stage_hint === 'T4') && !deployed) {
    gaps.push({ gap: '有 T4 级表述但缺实际运行对象与环境描述',
      why_it_matters: 'T4 须可核查的实际运行对象、环境、持续时长与验收主体' });
  }
  if (conflicts.length) {
    gaps.push({ gap: `${conflicts.length} 组同指标数值冲突`,
      why_it_matters: '冲突值一律进禁止引用清单，对外材料不得出现，需回到原始报告确认' });
  }
  if (duration.red_flag) {
    gaps.push({ gap: '时长异常（短于经验区间却声称高阶段）', why_it_matters: duration.reason });
  }
  if (!claims.some((c) => c.wording === C.WORDING.done)) {
    gaps.push({ gap: '材料以计划/意向为主，缺已完成事项',
      why_it_matters: '计划与意向不得提升阶段，仅可进「待核验线索」' });
  }
  return gaps;
}

function buildActions(gaps, accessRows, tickets, claims) {
  const pool = [];
  if (tickets.candidates.length && !tickets.confirmed.length) {
    pool.push({
      action: '取得验收/检测报告原件的可核对副本（含报告编号、出具机构、日期、结论页）',
      ask_from: '项目方或验收组织单位',
      resolves: '把「门票候选」转为「已确认门票」，决定能否支撑 T3',
      completion_evidence: '报告编号可在出具机构查询到，且结论页写明验收对象、环境与结论',
    });
  } else if (!tickets.candidates.length) {
    pool.push({
      action: '安排一次第三方现场验收或第三方检测，并留存验收组织方与连续运行时长记录',
      ask_from: '业主单位／第三方检测机构',
      resolves: '缺第三方现场验收，T3/T4 前提不成立',
      completion_evidence: '验收意见书含组织方、日期、连续运行小时数、结论',
    });
  }

  const l1 = accessRows.find((r) => r.access_layer === '强制准入') || null;
  if (l1 && (l1.state === 'unknown' || l1.state === 'insufficient')) {
    pool.push({
      action: '按「型号＋量程＋证书编号＋有效期」登记强制准入凭据（计量器具型式批准、防爆合格证）',
      ask_from: '项目方质量/注册负责人',
      resolves: `第 6 维·强制准入＝${l1.state}（论文与专利里不体现，却能一票否决）`,
      completion_evidence: '每个在售型号一条记录，证书编号可在发证机构公开渠道查到',
    });
  } else if (l1 && l1.state === 'adverse') {
    pool.push({
      action: '在取得强制准入前，明确对外只表述为实验室/科研用途，不进入报警或防爆场景销售',
      ask_from: '项目方负责人',
      resolves: '材料已明示未取得强制准入，按纪律封顶 T2',
      completion_evidence: '对外材料、报价单与说明书都不出现报警/防爆用途表述',
    });
  } else if (l1 && l1.state === 'not_applicable') {
    pool.push({
      action: '书面固化当前用途边界，并在用途变更评审中同步复核 CPA 与防爆要求',
      ask_from: '项目方产品负责人',
      resolves: '当前用途不触发强制准入，但用途一变门槛即变',
      completion_evidence: '用途边界写入产品定义文件，含变更触发条件',
    });
  }

  if (!claims.some((c) => c.evidence_level === 'A')) {
    pool.push({
      action: '就核心性能指标（检出限、响应时间、选择性、漂移）取得第三方检测报告',
      ask_from: '具备 CMA/CNAS 资质的检测机构',
      resolves: '现有性能数据全部为自述，最高只支持 T2',
      completion_evidence: '报告含样品型号、测试条件、方法与逐项结果',
    });
  }
  if (!claims.some((c) => ['partnership', 'license', 'transfer'].includes(c.event_type))) {
    pool.push({
      action: '补充权属与转化路径材料（专利法律状态、发明人归属、合作或许可意向文件）',
      ask_from: '项目方或高校技术转移中心',
      resolves: '权属与合规维度缺证据，转化路径无法判断',
      completion_evidence: '专利登记簿副本或技术转移中心出具的权利状态说明',
    });
  }

  const out = [];
  const seen = new Set();
  for (const a of pool) {
    if (seen.has(a.action)) continue;
    seen.add(a.action);
    out.push(a);
    if (out.length === 3) break;
  }
  return out;
}

function ticketElements(claims, ticketIds) {
  const cls = claims.filter((c) => ticketIds.includes(c.claim_id));
  const acceptance = cls.filter((c) => c.evidence_type === 'acceptance');
  const actual = claims.filter((c) => ACTUAL_ENV_PAT.test(c.claim));
  const duration = claims.filter((c) => DURATION_PAT.test(c.claim));
  const organiser = claims.filter((c) => ORGANISER_PAT.test(c.claim));
  const identifier = claims.filter((c) => IDENTIFIER_PAT.test(c.claim));
  return {
    acceptance_ticket: acceptance.length > 0,
    actual_environment: actual.length > 0,
    duration_stated: duration.length > 0,
    organiser_named: organiser.length > 0,
    verifiable_identifier: identifier.length > 0,
    ids: {
      acceptance_ticket: acceptance.map((c) => c.claim_id),
      actual_environment: actual.map((c) => c.claim_id),
      duration_stated: duration.map((c) => c.claim_id),
      organiser_named: organiser.map((c) => c.claim_id),
      verifiable_identifier: identifier.map((c) => c.claim_id),
    },
  };
}

function decideStage(claims, tickets, accessRows, conflicts) {
  const active = claims.filter((c) => c.supports === '支持' && c.wording !== C.WORDING.planned);
  if (!claims.length) {
    return { label: 'U', reason: '输入中抽不出可核查论断（可能是材料过短或非技术描述）',
      capped_by: 'R0 可跑性' };
  }
  if (!active.length) {
    return { label: 'U', reason: '抽出的论断全部为计划/意向或否定性表述，不能支撑任何阶段',
      capped_by: 'D 级不得提升阶段' };
  }
  const l1 = accessRows.find((r) => r.access_layer === '强制准入') || null;
  const cap6 = !!(l1 && l1.state === 'adverse');
  const ticketIds = tickets.confirmed.length ? tickets.confirmed : tickets.candidates;
  const el = ticketIds.length ? ticketElements(claims, ticketIds) : null;

  if (ticketIds.length) {
    if (!el.verifiable_identifier && !el.organiser_named) {
      return { label: 'T2',
        reason: '材料有验收/检测类表述，但未给出报告编号或验收组织方等可回查要素，' +
          '按裁决（OPEN-4）停在 T2，并单列为待补要素',
        capped_by: '缺可回查要素',
        missing_ticket_elements: ['verifiable_identifier', 'organiser_named'] };
    }
    if (cap6) {
      return { label: 'T2', reason: '①强制准入已证实缺失，按纪律封顶 T2', capped_by: '①层封顶' };
    }
    const t4Missing = ['acceptance_ticket', 'actual_environment', 'duration_stated', 'organiser_named']
      .filter((k) => !el[k]);
    if (!t4Missing.length) {
      return { label: 'T4',
        reason: '验收类门票＋实际环境运行＋连续运行时长＋验收组织方四项齐备，' +
          '按裁决（OPEN-1）判 T4；结论仍为草稿，须人工核对原文',
        capped_by: null, t4_elements: el.ids,
        pending_review: !tickets.confirmed.length };
    }
    const nameMap = { acceptance_ticket: '验收类门票', actual_environment: '实际环境运行',
      duration_stated: '连续运行时长', organiser_named: '验收组织方' };
    const why = '门票结构合格且有可回查要素，但 T4 四要素缺 ' +
      t4Missing.map((k) => nameMap[k]).join('、') + '，故判 T3';
    return { label: 'T3', reason: why, capped_by: null,
      t4_elements: el.ids, t4_missing: t4Missing,
      pending_review: !tickets.confirmed.length };
  }

  const lab = claims.filter((c) => ['validation', 'prototype', 'pilot'].includes(c.event_type) ||
    ['T2', 'T3', 'T4'].includes(c.stage_hint));
  if (lab.length) {
    return { label: 'T2', reason: '有实验/样机类证据但无合格门票，按证据级封顶停在 T2',
      capped_by: '无门票' };
  }
  return { label: 'T1', reason: '只有原理/方案/研究材料，未见对象与实验条件记录',
    capped_by: '无实验证据' };
}

function keywords(text) {
  const up = text.toUpperCase();
  return {
    gases: GAS_TERMS.filter((g) => up.includes(g.toUpperCase())),
    routes: ROUTE_TERMS.filter((r) => up.includes(r.toUpperCase())),
  };
}

// ── service 层（analyze_case 确定性核心）──────────────────────────────
const MIN_INPUT_CHARS = 30;
const MAX_INPUT_CHARS = 12000;
const MAX_TARGET_USE_CHARS = 200;
const MAX_URL_CHARS = 500;

function validateInput(text) {
  const t = String(text || '').trim();
  if (!t) {
    return ['', { type: 'empty_input',
      message: '输入为空：请粘贴专利摘要、论文摘要或成果介绍正文（≥30 字）。' }];
  }
  if (t.length < MIN_INPUT_CHARS) {
    return [t, { type: 'input_too_short',
      message: `输入过短（${t.length} 字，下限 ${MIN_INPUT_CHARS} 字）：请补充技术对象、` +
        '用途或验证结果的正文片段，否则无法形成可核查论断。' }];
  }
  if (t.length > MAX_INPUT_CHARS) return [t.slice(0, MAX_INPUT_CHARS), null];
  return [t, null];
}

function guessTitle(text) {
  const m = text.match(/《([^》]{4,40})》/);
  if (m) return m[1];
  let first = text.trim().split(/[。！？\n]/)[0].trim();
  first = first.replace(/^(本发明|本实用新型|本申请|本公开|该专利|该|本)\s*(公开|涉及|提供|提出)?\s*(了)?\s*/, '');
  first = first.replace(/^(一种|一类|一套)\s*/, '');
  const m2 = first.match(/(已(完成|通过|取得|获得|实现|建成)|计划|拟于|拟在|预计|目前)/);
  if (m2 && m2.index >= 4) first = first.slice(0, m2.index).replace(/[，,、 ]+$/, '');
  return first.length > 34 ? first.slice(0, 34) + '…' : (first || '（未命名材料）');
}

function summaryText(stage, claims, tickets, gaps, accessRows, cap6, nActions) {
  const n = {};
  for (const k of ['A', 'B', 'C', 'D']) {
    n[k] = claims.filter((c) => c.evidence_level === k).length;
  }
  const nDone = claims.filter((c) => c.wording === C.WORDING.done).length;
  const nPlan = claims.filter((c) => c.wording === C.WORDING.planned).length;
  const parts = [`从材料中抽出 ${claims.length} 条可核查论断（A${n.A}/B${n.B}/C${n.C}/D${n.D}），` +
    `其中「已完成」表述 ${nDone} 条、计划或意向 ${nPlan} 条。`];
  if (tickets.confirmed.length) {
    parts.push('存在已确认门票，材料支持到 T3。');
  } else if (tickets.candidates.length) {
    parts.push(`有 ${tickets.candidates.length} 条门票候选（结构合格，只差人工核对原文），` +
      '按材料所述判 T3，核对后可确认或降级。');
  } else {
    parts.push('未见第三方验收/检测门票，阶段停在 T2 及以下。');
  }
  const l1 = accessRows.find((r) => r.access_layer === '强制准入') || null;
  if (l1) {
    parts.push(`第 6 维强制准入＝${l1.state}` + (cap6 ? '，已按纪律封顶 T2。' : '（材料未提及不当作已证实缺失）。'));
  }
  parts.push(`共 ${gaps.length} 项缺口，给出 ${nActions} 项补证行动。`);
  return parts.join('');
}

/**
 * analyzeCase — 与 wenjin.service.analyze_case 的确定性路径逐字段一致。
 * @param {string} text      原始输入
 * @param {string|null} targetUse
 * @param {string|null} sourceUrl
 * @param {string} asOf      评估截止日（ISO 日期；调用方负责解析与回退）
 * @param {object} opts      {requestId, appVersion} 运行时注入
 */
function analyzeCase(text, targetUse, sourceUrl, asOf, opts = {}) {
  const rid = opts.requestId || 'WJ-UNKNOWN';
  const clean = String(text || '').trim();
  const [t, err] = validateInput(clean);
  if (err) {
    return { request_id: rid, status: 'failed',
      error: { type: err.type, message: err.message }, human_review: 'required' };
  }
  let tu = targetUse || null;
  if (tu && tu.length > MAX_TARGET_USE_CHARS) tu = tu.slice(0, MAX_TARGET_USE_CHARS);
  let su = sourceUrl || null;
  if (su && su.length > MAX_URL_CHARS) su = su.slice(0, MAX_URL_CHARS);
  const asof = asOf;

  const claims = extractClaims(t, asof);
  const conflicts = detectConflicts(claims);
  const duration = detectDuration(claims, asof);
  const accessRows = assessAccess(t, tu || '');
  const tickets = C.ticketSummary(claims);
  const events = buildTransferEvents(claims);
  const stage = decideStage(claims, tickets, accessRows, conflicts);
  const gaps = buildGaps(claims, accessRows, tickets, conflicts, duration, events);
  const actions = buildActions(gaps, accessRows, tickets, claims);

  const l1 = accessRows.find((r) => r.access_layer === '强制准入') || null;
  const cap6 = !!(l1 && l1.state === 'adverse');

  const byLevel = {};
  for (const k of ['A', 'B', 'C', 'D']) byLevel[k] = claims.filter((c) => c.evidence_level === k).length;
  const byWording = {};
  for (const k of [C.WORDING.done, C.WORDING.claimed, C.WORDING.planned, C.WORDING.not_found]) {
    byWording[k] = claims.filter((c) => c.wording === k).length;
  }

  const limitations = [
    '输入为单份材料，未做原文回查；所有 claim 均标注为草稿并给出字符区间，供人工逐条复核。',
    '证据分级按句式与来源标记给出草稿判断，人工可改判。',
    '评估截止日 as_of=' + asof + '，晚于该日的证据不得使用。',
  ];
  if (conflicts.length) {
    limitations.push(`${conflicts.length} 组同指标数值冲突，已列入禁止引用清单，不取平均、不静默选一个。`);
  }
  if (stage.t4_gate) limitations.push(stage.t4_gate);
  if (!claims.some((c) => c.evidence_level === 'A' || c.evidence_level === 'B')) {
    limitations.push('材料中无 A/B 级证据：按纪律 C 级最高只支持 T2，且须标注“来源声称”。');
  }
  // 判据适用域提示：只追加声明，不参与判定（与 Python service.analyze_case 同位置）
  const dom = domainCheck(t, targetUse);
  if (dom.notice) limitations.push(dom.notice);

  const summary = summaryText(stage, claims, tickets, gaps, accessRows, cap6, actions.length);

  const out = {
    request_id: rid,
    case_title: guessTitle(t),
    as_of: asof,
    status: claims.length ? 'success' : 'partial',
    technical_stage: {
      label: stage.label,
      summary,
      reason: stage.reason,
      supporting_claim_ids: claims
        .filter((c) => c.supports === '支持' && c.wording === C.WORDING.done)
        .map((c) => c.claim_id).slice(0, 6),
      limitations,
      classification_notice: C.CLASSIFICATION_NOTICE,
      draft: true,
      pending_review: Boolean(tickets.candidates.length && !tickets.confirmed.length),
      capped_by: stage.capped_by !== undefined ? stage.capped_by : null,
      t4_elements: stage.t4_elements !== undefined ? stage.t4_elements : null,
      t4_missing: stage.t4_missing !== undefined ? stage.t4_missing : null,
      missing_ticket_elements: stage.missing_ticket_elements !== undefined ? stage.missing_ticket_elements : null,
    },
    transfer_events: events,
    claims: claims.map((c) => ({
      claim_id: c.claim_id,
      claim: c.claim,
      source_id: c.source_id,
      locator: c.locator,
      published_at: c.published_at,
      evidence_level: c.evidence_level,
      evidence_type: c.evidence_type,
      wording: c.wording,
      supports: c.supports,
      limitation: c.limitation,
      draft_level: c.draft_level,
      stage_hint: c.stage_hint,
      event_type: c.event_type,
    })),
    gaps,
    actions,
    references: [],
    search_status: 'not_requested',
    human_review: 'required',
    input: {
      chars: t.length,
      target_use: targetUse || null,
      source_url: sourceUrl || null,
      source_url_verified: false,
      truncated: String(text || '').trim().length > t.length,
      char_range_note: 'locator 的字符区间基于清洗后的正文（合并连续空白）',
    },
    extraction: {
      claims_total: claims.length,
      by_level: byLevel,
      by_wording: byWording,
      events: events.map((e) => e.event_type),
      input_claims_verified_verbatim: true,
    },
    ticket: {
      confirmed: tickets.confirmed,
      candidates: tickets.candidates,
      levels: tickets.levels,
      types: tickets.types,
      note: '已确认门票须 A/B 级＋验收/检测类＋已完成＋支持＋人工已核对原文；候选只差最后一项',
    },
    access_compliance: {
      dim_no: 6,
      dim_name: C.DIM_NAMES['6'],
      layers: accessRows,
      capped_t2: cap6,
      rule: '缺①层（强制准入）已证实缺失时封顶 T2；“材料未提及”记 unknown，不当作已证实缺失',
    },
    duration_check: duration,
    conflicts,
    banned_values: conflicts.map((c) => ({ metric: c.metric, values: c.values })),
    model_status: {
      enabled: false, provider: 'deepseek', model: 'deepseek-chat',
      base_url: 'https://api.deepseek.com/v1', key_present: false,
      role: '只生成摘要措辞；阶段标签与证据分级由冻结判据给出，模型不得改写',
      used: false, error: null, narrative: null,
    },
    rule_version: C.RULE_VERSION,
    app_version: opts.appVersion || '1.0.0-pages',
    disclaimers: [
      '问津简化初筛分类，不等价于官方技术成熟度分级。',
      'AI 初筛草稿，待人工复核；不预测成败、不输出估值/成功率、不构成 FTO 或法律意见。',
      '判定结论须人工对照原文复核后才可用于决策。',
    ],
    elapsed_ms: 0,
  };
  return out;
}

module.exports = {
  normalize, splitSentences, splitClauses, extractClaims, detectConflicts, detectDuration,
  assessAccess, buildTransferEvents, buildGaps, buildActions, ticketElements, decideStage,
  keywords, validateInput, guessTitle, analyzeCase,
  GAS_TERMS, ROUTE_TERMS,
};
