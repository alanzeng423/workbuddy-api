/**
 * Shared helpers for the live-probe tools.
 *
 * These tools talk to the REAL upstream to establish protocol facts. They are
 * deliberately separate from the test suite: the tests must run offline and
 * deterministically, while these exist to answer "what does the gateway actually
 * do today?".
 *
 * Credentials are read from a file path given on the command line and are never
 * logged. Only an access token is needed, so either this project's own
 * `auth.<site>.json` or another client's credential file works.
 *
 * @module tools/probe-lib
 */

import { readFileSync } from 'node:fs';
import { SITES } from '../src/config.mjs';

/** Load an access token + domain from a credential file of either known shape. */
export function loadCredential(filePath) {
  if (!filePath) throw new Error('用法: <script> <credential.json>');
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const auth = raw.auth ?? raw;
  const token = auth.accessToken ?? auth.access_token;
  if (!token) throw new Error(`${filePath} 里没有 accessToken`);
  return {
    accessToken: token,
    domain: auth.domain ?? raw.account?.domain ?? '',
    uid: raw.account?.uid ?? auth.uid ?? '',
  };
}

/** The site to probe against; overridable so CN can be checked too. */
export function siteFromArgv(argv, fallback = 'intl-work') {
  const i = argv.indexOf('--site');
  const id = i === -1 ? fallback : argv[i + 1];
  const site = SITES[id];
  if (!site) throw new Error(`未知站点 "${id}"；可选: ${Object.keys(SITES).join(', ')}`);
  return site;
}

/**
 * Send one minimal streamed chat request and report what came back.
 *
 * `stream: true` is not optional: the gateway refuses non-streaming outright, so
 * a probe with `stream: false` would measure the wrong thing entirely.
 */
export async function probeChat(site, credential, { system, user = 'say ok', model = 'deepseek-v4.1-flash', maxTokens = 16 } = {}) {
  const messages = [];
  if (system !== undefined) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const res = await fetch(`${site.apiBase}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      'User-Agent': site.ua,
      Accept: 'text/event-stream',
      ...(credential.domain ? { 'X-Domain': credential.domain } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  let code;
  let msg = '';
  try {
    const doc = JSON.parse(text);
    code = doc.code;
    msg = doc.msg ?? '';
  } catch { /* a success answer is SSE, not JSON */ }

  return { ok: res.ok, status: res.status, code, msg };
}

/** Print one probe result as a pass/fail line. */
export function report(label, result, width = 46) {
  const mark = result.ok ? '✅' : '❌';
  const detail = result.ok ? '' : `  code=${result.code ?? '-'} ${String(result.msg).slice(0, 44)}`;
  console.log(`  ${mark} ${label.padEnd(width)} HTTP ${String(result.status).padEnd(4)}${detail}`);
  return result.ok;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Print a summary block. */
export function summarize(conclusion) {
  console.log('\n  === 结论 ===');
  console.log(`  ${conclusion}\n`);
}
