#!/usr/bin/env node
/**
 * Prove the fingerprint fix is SUFFICIENT, against the live gateway.
 *
 * `npm test` proves the transformation does what it claims. This proves the
 * transformed request is actually ACCEPTED — the two are different claims, and
 * only the second one matters to a user whose Claude Code session was failing.
 *
 * The first probe is the control: the same request, unprepared, must still fail.
 * Without it a passing second probe would not show the fix did anything.
 *
 * Usage:
 *   node tools/verify-fix.mjs <credential.json> [--site intl-work]
 */

import { loadCredential, siteFromArgv, probeChat, sleep } from './probe-lib.mjs';
import { prepareChatBody } from '../src/upstream.mjs';

const credential = loadCredential(process.argv[2]);
const site = siteFromArgv(process.argv);

// The realistic Claude Code opener followed by real instructions — the shape an
// equality-based strip would miss.
const SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
  + 'You are an interactive CLI tool that helps users with software engineering tasks. '
  + 'IMPORTANT: Assist with defensive security tasks only.';

console.log('\n  验证指纹修复是否真的让请求通过\n');

const before = await probeChat(site, credential, { system: SYSTEM });
if (before.ok) {
  console.log(`  ⚠️  未处理的请求竟然通过了（HTTP ${before.status}）——上游行为可能已变更`);
} else {
  console.log(`  ✅ 对照组：未处理的原样请求被拒  HTTP ${before.status} code=${before.code} ${String(before.msg).slice(0, 40)}`);
}

await sleep(2000);

// Run it through the real preparation path, exactly as the server does.
const prepared = prepareChatBody(JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'reply with exactly: fixed' },
  ],
  stream: false, // the server forces this; preparation must too
}), { defaultSystemPrompt: 'You are a helpful assistant.' });

const preparedSystem = JSON.parse(prepared).messages.find((m) => m.role === 'system').content;
console.log(`\n  处理后 system 开头: ${JSON.stringify(preparedSystem.slice(0, 58))}…`);
console.log(`  仍含指纹:        ${/Claude Code,\s*Anthropic/i.test(preparedSystem) ? '是 ❌' : '否 ✅'}`);
console.log(`  保留实质指令:    ${/interactive CLI tool/.test(preparedSystem) ? '是 ✅' : '否 ❌'}`);
console.log(`  首条仍是 system: ${JSON.parse(prepared).messages[0].role === 'system' ? '是 ✅' : '否 ❌'}`);

await sleep(2000);

const after = await probeChat(site, credential, { system: preparedSystem });
console.log('');
if (after.ok) {
  console.log(`  ✅ 处理后的请求成功  HTTP ${after.status}`);
  console.log('\n  → 修复有效：同一个 system 内容，处理前被拒、处理后通过。\n');
  process.exit(0);
}
console.log(`  ❌ 处理后的请求仍失败  HTTP ${after.status} code=${after.code} ${after.msg}`);
console.log('\n  → 修复不充分，需要重新检查剥离规则。\n');
process.exit(1);
