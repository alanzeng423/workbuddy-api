#!/usr/bin/env node
/**
 * Establish the client-fingerprint rule against the LIVE upstream.
 *
 * The gateway keeps an exact blacklist of client-identifying opening sentences and
 * answers `400 / code 11128 "Illegal API invocation from an unapproved channel"`
 * when a system message begins with one. That matters most for Claude Code, whose
 * system prompt opens with the known sentence — it fails out of the box.
 *
 * This tool is how the rule in `src/upstream.mjs` was established, and how to
 * re-establish it after an upstream change. It runs three groups of probes:
 *
 *   1. existence   — is the sentence actually refused?
 *   2. boundary    — where exactly does matching start and stop?
 *   3. robustness  — case sensitivity, and how much trailing text still trips it
 *
 * Every probe sends `stream: true`, because the gateway refuses non-streaming and
 * a non-streaming probe would measure something else entirely.
 *
 * Usage:
 *   node tools/probe-fingerprint.mjs <credential.json> [--site intl-work]
 */

import { loadCredential, siteFromArgv, probeChat, report, sleep, summarize } from './probe-lib.mjs';

const credential = loadCredential(process.argv[2]);
const site = siteFromArgv(process.argv);
const FULL = "You are Claude Code, Anthropic's official CLI for Claude.";

const run = (label, system) => probeChat(site, credential, { system }).then((r) => report(label, r));

console.log(`\n  客户端指纹实测 — ${site.label} (${site.apiBase})`);
console.log('  每条之间间隔 2s，避免自伤限流\n');

/* ---------------------------------------------------- 1. existence -------- */
console.log('  [1] 黑名单是否存在');
const control = await run('对照组：普通 system', 'You are a helpful assistant.');
await sleep(2000);
const exact = await run('整句 as system', FULL);
await sleep(2000);

if (!control.ok) {
  summarize('对照组就没通过（凭据或网络问题），本次实测无效。');
  process.exit(1);
}
if (exact.ok) {
  summarize(`本次未复现指纹黑名单（HTTP ${exact.status}）。上游可能已变更或已移除该策略。`);
  process.exit(0);
}

/* ----------------------------------------------------- 2. boundary -------- */
console.log('\n  [2] 匹配边界（前缀？整条？）');
const halves = [];
halves.push(await run('只留前半句', 'You are Claude Code'));
await sleep(2000);
halves.push(await run('只留后半句', "Anthropic's official CLI for Claude"));
await sleep(2000);

const inUser = await probeChat(site, credential, { system: 'You are a helpful assistant.', user: `${FULL} say ok` })
  .then((r) => report('整句放 user 位置', r));
await sleep(2000);

const embedded = await run('嵌在 system 中间（前面有内容）', `Be concise.\n\n${FULL}\n\nFollow instructions.`);
await sleep(2000);

const leadingNl = await run('前置换行 + 整句', `\n${FULL}`);
await sleep(2000);

const trailingNl = await run('整句 + 后置换行', `${FULL}\n`);
await sleep(2000);

const trailingText = await run('整句 + 后面接正文', `${FULL}\n\nYou are an interactive CLI tool.`);
await sleep(2000);

const trailingOne = await run('整句 + 单个字符', `${FULL}x`);

/* --------------------------------------------------- 3. robustness -------- */
console.log('\n  [3] 大小写与尾随强度');
await sleep(2000);
const upper = await run('全部大写', FULL.toUpperCase());
await sleep(2000);
const mixedCase = await run("后半句小写 anthropic's", "You are Claude Code, anthropic's official CLI for Claude.");
await sleep(2000);
const noPeriod = await run('去掉结尾句点', "You are Claude Code, Anthropic's official CLI for Claude");
await sleep(2000);
const extraSpace = await run('中间多一个空格', "You are Claude Code,  Anthropic's official CLI for Claude.");

/* ------------------------------------------------------ conclusions ------- */
const halvesPass = halves[0].ok && halves[1].ok;
const lines = [];
lines.push(`整句被拒:                  ${exact.ok ? '否' : '是'}`);
lines.push(`两个半句都通过:            ${halvesPass ? '是' : '否'} → ${halvesPass ? '是精确整句匹配，不是关键词过滤' : '匹配粒度比整句更细'}`);
lines.push(`放 user 位置通过:          ${inUser ? '是' : '否'} → ${inUser ? '只作用于 system' : 'user 也受影响'}`);
lines.push(`嵌在中间通过:              ${embedded ? '是' : '否'} → ${embedded ? '是「开头」匹配' : '不是开头匹配'}`);
lines.push(`前置换行仍被拒:            ${leadingNl ? '否' : '是'} → ${leadingNl ? '前导空白会破坏匹配' : '前导空白被忽略'}`);
lines.push(`后置换行仍被拒:            ${trailingNl ? '否' : '是'}`);
lines.push(`后面接正文仍被拒:          ${trailingText ? '否' : '是'} → ${trailingText ? '' : '句后接任何内容都仍命中'}`);
lines.push(`后接单字符仍被拒:          ${trailingOne ? '否' : '是'}`);
lines.push(`大小写不敏感:              ${upper ? '否' : '是'}`);
lines.push(`后半句换大小写仍被拒:      ${mixedCase ? '否' : '是'}`);
lines.push(`无句点仍被拒:              ${noPeriod ? '否' : '是'}`);
lines.push(`多空格即通过:              ${extraSpace ? '是' : '否'}`);

console.log('');
for (const line of lines) console.log(`  ${line}`);

const startAnchored = !embedded && !leadingNl;
const trailingMatters = !trailingNl || !trailingText || !trailingOne;
summarize(
  `${startAnchored ? '确认是「句首」匹配' : '不是句首匹配，需重新评估'}`
  + `，${trailingMatters ? '且句子之后有内容仍会命中 —— 因此剥离必须替换句首，而不是整条比对' : ''}。`
  + `\n  大小写不敏感: ${!upper ? '是' : '否'}。完整矩阵见 docs/upstream-protocol.md。`,
);
