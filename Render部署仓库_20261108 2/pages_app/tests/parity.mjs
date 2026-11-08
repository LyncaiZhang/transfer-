#!/usr/bin/env node
'use strict';
/**
 * parity.mjs — 公网 Node 引擎 vs Python 引擎（fixtures）逐字段奇偶校验。
 *
 * fixtures 由 04_构建脚本/build_wenjin_parity_fixtures.py 用真实 Python 引擎生成；
 * 本脚本用 lib/engine.js 重放同一组输入，规范化后逐字段比对。任何不一致都判失败——
 * 判据或引擎一改必须重生成 fixtures 并让本测试全绿，否则公网页与 MCP/本机服务不同源。
 *
 * 用法：node tests/parity.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const FIXTURES = path.join(APP, 'fixtures');

const engine = require(path.join(APP, 'lib', 'engine.js'));

const inputs = JSON.parse(readFileSync(path.join(FIXTURES, 'inputs.json'), 'utf8'));
const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const meta = JSON.parse(readFileSync(path.join(FIXTURES, 'meta.json'), 'utf8'));

/** 规范化：request_id / elapsed_ms 是运行时字段，两侧都置空后比对。 */
function normalizeJS(out) {
  const copy = structuredClone(out);
  copy.request_id = '';
  copy.elapsed_ms = 0;
  return copy;
}

function pyNormalize(out) {
  const copy = structuredClone(out);
  copy.request_id = '';
  copy.elapsed_ms = 0;
  return copy;
}

/** 递归找第一处差异路径，便于定位。 */
function diffPath(a, b, p = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null ||
      Array.isArray(a) !== Array.isArray(b)) return `${p}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}.length: ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diffPath(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) return `${p}.${k}: <缺> !== ${JSON.stringify(b[k])}`;
      if (!(k in b)) return `${p}.${k}: ${JSON.stringify(a[k])} !== <缺>`;
      const d = diffPath(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${p}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
}

let pass = 0;
const failures = [];
for (const c of inputs) {
  const { text, target_use, source_url, as_of } = c.args;
  const got = normalizeJS(engine.analyzeCase(text, target_use, source_url, as_of,
    { requestId: '', appVersion: '1.0.0' }));
  const want = pyNormalize(expected[c.id]);
  const d = diffPath(want, got);
  if (d === null) {
    pass += 1;
    console.log(`  一致  ${c.id}`);
  } else {
    failures.push([c.id, d]);
    console.log(`  不一致  ${c.id}`);
    console.log(`    ${d}`);
  }
}

console.log(`\n奇偶校验：${pass}/${inputs.length} 通过`);
if (failures.length) {
  console.log('失败案例：' + failures.map((f) => f[0]).join('、'));
  process.exit(1);
}
console.log(`run_triage sha256: ${meta.run_triage_sha256.slice(0, 16)}…（fixtures 生成时）`);
