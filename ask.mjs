#!/usr/bin/env node
/**
 * Command-line client for verifying a running server.
 *
 * Usage:
 *   node ask.mjs --list                     列出可用模型
 *   node ask.mjs hy3 "你好"                  提问（走 OpenAI 协议）
 *   node ask.mjs --protocol anthropic hy3 "你好"
 *   node ask.mjs --protocol responses hy3 "你好"
 *   node ask.mjs --stream hy3 "数到五"
 */
import { loadConfig } from './src/config.mjs';

/**
 * Parse flags out of argv in one pass, leaving only positional arguments.
 *
 * `--key` is declared in the same pass as the rest: parsing a flag AFTER reading
 * positionals leaves that flag's value sitting in the positional list, so
 * `... --key sk-x hy3 "hi"` would treat the key as the model name. Every flag must
 * be consumed before positionals are read.
 *
 * A value-taking flag requires a following token that is not itself a flag.
 */
const VALUE_FLAGS = new Set(['--protocol', '--url', '--key']);
const argv = [...process.argv.slice(2)];
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (!token.startsWith('--')) {
    positional.push(token);
    continue;
  }
  const next = argv[i + 1];
  if (VALUE_FLAGS.has(token) && next !== undefined && !next.startsWith('--')) {
    flags[token] = next;
    i += 1;
  } else {
    flags[token] = true;
  }
}

const protocol = typeof flags['--protocol'] === 'string' ? flags['--protocol'] : 'openai';
const wantStream = flags['--stream'] === true;
const listOnly = flags['--list'] === true;
const urlOverride = typeof flags['--url'] === 'string' ? flags['--url'] : undefined;
const model = positional[0];
const prompt = positional.slice(1).join(' ');

const config = loadConfig({ createIfMissing: false });
const base = (urlOverride ?? `http://${config.host}:${config.port}`).replace(/\/+$/, '');
const key = typeof flags['--key'] === 'string'
  ? flags['--key']
  : (Array.isArray(config.apiKey) ? config.apiKey[0] : config.apiKey);
const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };

if (listOnly || !model || !prompt) {
  const res = await fetch(`${base}/v1/models`, { headers });
  const doc = await res.json();
  if (!res.ok) {
    console.error('无法获取模型列表:', JSON.stringify(doc));
    process.exit(1);
  }
  console.log(`\n  可用模型（${doc.data.length}）\n`);
  for (const m of doc.data) {
    const rate = m.credits_multiplier === 0 ? '免费' : m.credits_multiplier === undefined ? '—' : `x${m.credits_multiplier}`;
    console.log(`    ${String(m.id).padEnd(26)} ${String(rate).padEnd(8)} ${m.site ?? ''}`);
  }
  console.log('');
  if (!model) {
    console.log('  用法: node ask.mjs <model> "你的问题"\n');
  }
  process.exit(0);
}

const path = protocol === 'anthropic' ? '/v1/messages' : protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
const body = protocol === 'anthropic'
  ? { model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }], stream: wantStream }
  : protocol === 'responses'
    ? { model, input: prompt, stream: wantStream }
    : { model, messages: [{ role: 'user', content: prompt }], stream: wantStream };

const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
if (!res.ok) {
  console.error(`\n  ❌ HTTP ${res.status}\n  ${(await res.text()).slice(0, 500)}\n`);
  process.exit(1);
}

if (!wantStream) {
  const doc = await res.json();
  let text = '';
  if (protocol === 'anthropic') {
    text = (doc.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else if (protocol === 'responses') {
    text = (doc.output ?? []).flatMap((i) => i.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  } else {
    text = doc.choices?.[0]?.message?.content ?? '';
  }
  console.log(`\n${text}\n`);
  const usage = doc.usage;
  if (usage) console.log(`  [usage] ${JSON.stringify(usage)}\n`);
  process.exit(0);
}

// Streamed: print deltas as they arrive.
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let printed = false;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let payload;
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) payload = (payload ?? '') + line.slice(5).trim();
    }
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    let piece = '';
    if (protocol === 'anthropic') piece = ev.delta?.text ?? ev.delta?.thinking ?? '';
    else if (protocol === 'responses') piece = ev.delta ?? '';
    else piece = ev.choices?.[0]?.delta?.content ?? '';
    if (piece) {
      process.stdout.write(piece);
      printed = true;
    }
  }
}
console.log(printed ? '\n' : '(无输出)\n');
