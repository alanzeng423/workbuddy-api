#!/usr/bin/env node
/**
 * End-to-end self-check against a RUNNING server.
 *
 * Exercises every endpoint over real HTTP and prints a pass/fail line per check.
 * Requires a signed-in site; checks that need one are skipped (not failed) when
 * nothing is signed in, so this is safe to run before the first login.
 *
 * Usage:
 *   node smoke.mjs                        # uses config.json for host/port/key
 *   node smoke.mjs --url http://127.0.0.1:8788 --key sk-wb-...
 */
import { loadConfig } from './src/config.mjs';

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};

const config = loadConfig({ createIfMissing: false });
const base = (argOf('--url') ?? `http://${config.host}:${config.port}`).replace(/\/+$/, '');
const key = argOf('--key') ?? (Array.isArray(config.apiKey) ? config.apiKey[0] : config.apiKey);

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, detail = '') {
  pass += 1;
  console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`);
}
function bad(name, detail) {
  fail += 1;
  console.log(`  ❌ ${name}  — ${detail}`);
}
function skipped(name, why) {
  skip += 1;
  console.log(`  ⏭️  ${name}  — ${why}`);
}

async function req(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth && key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** Read an SSE body into a list of `{ type, data }`. */
async function sse(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) return { status: res.status, events: [], text: await res.text() };
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = { type: undefined, data: undefined };
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev.type = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          try {
            ev.data = JSON.parse(payload);
          } catch {
            ev.data = payload;
          }
        }
      }
      if (ev.data !== undefined) events.push(ev);
    }
  }
  return { status: res.status, events };
}

console.log(`\n  workbuddy-api 自检  →  ${base}\n`);

// ---------------------------------------------------------------- transport --
console.log('  [传输层]');
try {
  const health = await req('/health', { auth: false });
  if (health.status === 200 && health.json?.status === 'ok') {
    const signed = (health.json.sites ?? []).filter((s) => s.signed_in).map((s) => s.site);
    ok('/health', signed.length ? `已登录: ${signed.join(', ')}` : '无站点登录');
  } else bad('/health', `status=${health.status}`);
} catch (err) {
  bad('/health', err.message);
}

try {
  const unauth = await req('/v1/models', { auth: false });
  if (unauth.status === 401) ok('错误 API Key 被拒绝 (401)');
  else bad('鉴权', `期望 401，实际 ${unauth.status}`);
} catch (err) {
  bad('鉴权', err.message);
}

try {
  const notFound = await req('/v1/nope');
  if (notFound.status === 404) ok('未知路由返回 404');
  else bad('未知路由', `期望 404，实际 ${notFound.status}`);
} catch (err) {
  bad('未知路由', err.message);
}

// ------------------------------------------------------------------- models --
console.log('\n  [模型清单]');
let models = [];
try {
  const res = await req('/v1/models');
  if (res.status === 200 && Array.isArray(res.json?.data)) {
    models = res.json.data;
    const free = models.filter((m) => m.credits_multiplier === 0);
    ok('/v1/models', `${models.length} 个模型，免费 ${free.length} 个`);
  } else bad('/v1/models', `status=${res.status}`);
} catch (err) {
  bad('/v1/models', err.message);
}

if (models.length === 0) {
  skipped('协议端点', '没有可用模型（未登录？先运行 node login.mjs）');
  console.log(`\n  结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过\n`);
  process.exit(fail === 0 ? 1 : 1);
}

// Prefer a free model so the self-check does not spend the user's credits.
const model = (models.find((m) => m.credits_multiplier === 0) ?? models[0]).id;
console.log(`\n  [协议端点]  使用模型: ${model}${models.find((m) => m.id === model)?.credits_multiplier === 0 ? ' (免费)' : ''}`);

// -------------------------------------------------------- OpenAI chat ------ */
try {
  const res = await req('/v1/chat/completions', {
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'reply with exactly: hello' }], stream: false },
  });
  const text = res.json?.choices?.[0]?.message?.content ?? '';
  if (res.status === 200 && typeof text === 'string' && text.trim() !== '') {
    ok('OpenAI 非流式', `"${text.trim().slice(0, 40)}"`);
  } else bad('OpenAI 非流式', `status=${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
} catch (err) {
  bad('OpenAI 非流式', err.message);
}

try {
  const { status, events } = await sse('/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: 'count 1 to 3' }],
    stream: true,
  });
  const text = events
    .filter((e) => e.data?.choices)
    .map((e) => e.data.choices[0]?.delta?.content ?? '')
    .join('');
  const sawDone = events.some((e) => e.data === '[DONE]');
  if (status === 200 && text !== '' && sawDone) ok('OpenAI 流式', `${events.length} 帧, [DONE] 已收到`);
  else bad('OpenAI 流式', `status=${status} text="${text.slice(0, 40)}" done=${sawDone}`);
} catch (err) {
  bad('OpenAI 流式', err.message);
}

// ---------------------------------------------------- Anthropic messages --- */
try {
  const res = await req('/v1/messages', {
    method: 'POST',
    body: { model, max_tokens: 100, messages: [{ role: 'user', content: 'reply with exactly: hello' }] },
  });
  const text = (res.json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (res.status === 200 && res.json?.type === 'message' && text.trim() !== '') {
    ok('Anthropic 非流式', `"${text.trim().slice(0, 40)}", stop=${res.json.stop_reason}`);
  } else bad('Anthropic 非流式', `status=${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
} catch (err) {
  bad('Anthropic 非流式', err.message);
}

try {
  const { status, events } = await sse('/v1/messages', {
    model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'count 1 to 3' }],
    stream: true,
  });
  const types = events.map((e) => e.type);
  const hasStart = types.includes('message_start');
  const hasStop = types.includes('message_stop');
  const text = events
    .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  if (status === 200 && hasStart && hasStop && text !== '') {
    ok('Anthropic 流式', `${events.length} 事件, 事件序列完整`);
  } else bad('Anthropic 流式', `status=${status} start=${hasStart} stop=${hasStop} text="${text.slice(0, 40)}"`);
} catch (err) {
  bad('Anthropic 流式', err.message);
}

// -------------------------------------------------- OpenAI responses ------- */
try {
  const { status, events } = await sse('/v1/responses', {
    model,
    input: 'reply with exactly: hello',
  });
  const types = events.map((e) => e.type);
  const hasCreated = types.includes('response.created');
  const hasCompleted = types.includes('response.completed');
  const text = events
    .filter((e) => e.type === 'response.output_text.delta')
    .map((e) => e.data?.delta ?? '')
    .join('');
  if (status === 200 && hasCreated && hasCompleted && text !== '') {
    ok('Responses 流式', `${events.length} 事件, 文本 "${text.trim().slice(0, 40)}"`);
  } else bad('Responses 流式', `status=${status} created=${hasCreated} completed=${hasCompleted} text="${text.slice(0, 40)}"`);
} catch (err) {
  bad('Responses 流式', err.message);
}

// ------------------------------------------------------- tool_choice ------- */
try {
  const res = await req('/v1/chat/completions', {
    method: 'POST',
    body: {
      model,
      messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      // Object form on purpose: the upstream only accepts a string, so this
      // proves the flattening in prepareChatBody actually runs.
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      stream: false,
    },
  });
  const calls = res.json?.choices?.[0]?.message?.tool_calls ?? [];
  if (res.status === 200 && calls.length > 0 && calls[0].function?.name === 'get_weather') {
    let argsOk = false;
    try {
      JSON.parse(calls[0].function.arguments);
      argsOk = true;
    } catch { /* arguments must be valid JSON */ }
    if (argsOk) ok('工具调用', `name=${calls[0].function.name}, arguments 是合法 JSON`);
    else bad('工具调用', `arguments 不是合法 JSON: ${calls[0].function.arguments}`);
  } else bad('工具调用', `status=${res.status} calls=${JSON.stringify(calls).slice(0, 120)}`);
} catch (err) {
  bad('工具调用', err.message);
}

console.log(`\n  结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过\n`);
process.exitCode = fail === 0 ? 0 : 1;
