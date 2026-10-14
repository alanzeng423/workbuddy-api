/**
 * Tests for config validation, site mapping, and the loopback guards.
 *
 * These cover the failure modes that are SILENT in production — a typo'd config
 * value that degrades quietly, or a guard that stops rejecting. A guard that
 * stops rejecting does not error; it just stops protecting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, siteForDomain, SITES, SITE_IDS, configWarnings } from '../src/config.mjs';
import { hostIsLoopback, originIsLoopback, apiKeyMatches, RateLimiter, hostnameOfHost } from '../src/server.mjs';
import { parseCreditMultiplier, isFreeModel, parseUpstreamModel, parseCatalogDocument } from '../src/models.mjs';
import { prepareChatBody, classifyUpstreamError, SseDecoder } from '../src/upstream.mjs';
import { UpstreamError } from '../src/upstream.mjs';

/* ------------------------------------------------------------------ config -- */

test('validateConfig degrades bad values and records a warning for each', () => {
  const cfg = validateConfig({
    port: 'nope',
    apiKey: 42,
    defaultSite: 'ghost',
    ensureSystemMessage: 'yes',
    context: { minKeepMessages: -3 },
    rateLimit: { max: 0 },
  });
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.ensureSystemMessage, true);
  assert.equal(cfg.context.minKeepMessages, 4);
  assert.equal(cfg.rateLimit.max, 600);
  const warnings = configWarnings();
  assert.ok(warnings.length >= 4, `expected several warnings, got ${warnings.length}`);
});

test('validateConfig leaves a valid config untouched', () => {
  const cfg = validateConfig({ port: 9001, apiKey: 'k', defaultSite: 'intl-work' });
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.apiKey, 'k');
  assert.equal(cfg.defaultSite, 'intl-work');
  assert.deepEqual(configWarnings(), []);
});

test('validateConfig accepts an array of API keys', () => {
  const cfg = validateConfig({ apiKey: ['a', 'b'] });
  assert.deepEqual(cfg.apiKey, ['a', 'b']);
});

test('siteForDomain maps the three products and rejects lookalikes', () => {
  assert.equal(siteForDomain('www.workbuddy.ai'), 'intl-work');
  assert.equal(siteForDomain('workbuddy.ai'), 'intl-work');
  assert.equal(siteForDomain('www.codebuddy.ai'), 'intl-cli');
  assert.equal(siteForDomain('copilot.tencent.com'), 'cn-cli');
  // A hostname that merely CONTAINS a known domain must not match.
  assert.equal(siteForDomain('workbuddy.ai.evil.com'), undefined);
  assert.equal(siteForDomain('notworkbuddy.ai'), undefined);
  assert.equal(siteForDomain(''), undefined);
});

test('every site declares the fields the client depends on', () => {
  for (const id of SITE_IDS) {
    const s = SITES[id];
    assert.ok(s.apiBase.startsWith('https://'), `${id} apiBase must be https`);
    assert.ok(typeof s.ua === 'string' && s.ua !== '', `${id} needs a User-Agent`);
    assert.ok(s.label && s.region, `${id} needs label and region`);
  }
});

/* ------------------------------------------------------------------ guards -- */

test('hostnameOfHost strips the port and handles IPv6 brackets', () => {
  assert.equal(hostnameOfHost('127.0.0.1:8788'), '127.0.0.1');
  assert.equal(hostnameOfHost('[::1]:8788'), '[::1]');
  assert.equal(hostnameOfHost('LOCALHOST'), 'localhost');
});

test('hostIsLoopback rejects a rebinding-style Host', () => {
  assert.equal(hostIsLoopback('127.0.0.1:8788'), true);
  assert.equal(hostIsLoopback('localhost'), true);
  assert.equal(hostIsLoopback('[::1]:9000'), true);
  // The DNS-rebinding case: attacker domain resolving to 127.0.0.1.
  assert.equal(hostIsLoopback('evil.example.com'), false);
  assert.equal(hostIsLoopback(undefined), false);
  assert.equal(hostIsLoopback(''), false);
});

test('originIsLoopback allows absent Origin but rejects a foreign one', () => {
  assert.equal(originIsLoopback(undefined), true, 'non-browser clients send no Origin');
  assert.equal(originIsLoopback(''), true);
  assert.equal(originIsLoopback('http://127.0.0.1:3000'), true);
  assert.equal(originIsLoopback('https://evil.example.com'), false);
  assert.equal(originIsLoopback('not a url'), false);
});

test('apiKeyMatches accepts any configured key and rejects others', () => {
  assert.equal(apiKeyMatches('a', ['a', 'b']), true);
  assert.equal(apiKeyMatches('b', ['a', 'b']), true);
  assert.equal(apiKeyMatches('c', ['a', 'b']), false);
  assert.equal(apiKeyMatches('', ['a']), false);
  // An empty configuration means loopback-only access with no key required.
  assert.equal(apiKeyMatches(undefined, ''), true);
  assert.equal(apiKeyMatches(undefined, []), true);
});

test('RateLimiter allows up to the cap then reports a retry delay', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 3 });
  const now = 1_000_000;
  assert.equal(rl.hit('ip', now), 0);
  assert.equal(rl.hit('ip', now), 0);
  assert.equal(rl.hit('ip', now), 0);
  assert.ok(rl.hit('ip', now) > 0, 'the fourth hit in the window must be limited');
  // A different key is unaffected.
  assert.equal(rl.hit('other', now), 0);
  // After the window slides, it is allowed again.
  assert.equal(rl.hit('ip', now + 1001), 0);
});

test('RateLimiter stays memory-bounded under many distinct keys', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 2, maxKeys: 10 });
  const now = 5_000_000;
  for (let i = 0; i < 200; i += 1) rl.hit(`ip-${i}`, now + i);
  assert.ok(rl.hits.size <= 12, `map must stay bounded, saw ${rl.hits.size}`);
});

/* ------------------------------------------------------------------ models -- */

test('parseCreditMultiplier reads the observed spellings', () => {
  assert.equal(parseCreditMultiplier('x0.79 credits'), 0.79);
  assert.equal(parseCreditMultiplier('x0.00'), 0);
  assert.equal(parseCreditMultiplier('x0.05'), 0.05);
  assert.equal(parseCreditMultiplier(''), undefined);
  assert.equal(parseCreditMultiplier(undefined), undefined);
  assert.equal(parseCreditMultiplier('free'), undefined);
});

test('isFreeModel treats an explicit x0.00 as free, an empty string as unknown', () => {
  assert.equal(isFreeModel('x0.00'), true);
  // `default-model` carries an EMPTY credits string on live data and is NOT free.
  assert.equal(isFreeModel(''), false);
  assert.equal(isFreeModel('x0.34 credits'), false);
});

test('parseUpstreamModel maps the real live entry shape', () => {
  const m = parseUpstreamModel({
    id: 'fast-model',
    name: 'Fast',
    maxAllowedSize: 200000,
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    credits: 'x0.34 credits',
    supportsImages: true,
    onlyReasoning: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    supportsToolCall: true,
  });
  assert.equal(m.id, 'fast-model');
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.maxTokens, 32000);
  assert.equal(m.creditMultiplier, 0.34);
  assert.equal(m.free, false);
  // The live form is SINGULAR (`effort`), not `supportedEfforts`.
  assert.equal(m.reasoning.defaultEffort, 'medium');
});

test('parseUpstreamModel prefers contextWindow over maxAllowedSize', () => {
  const m = parseUpstreamModel({ id: 'x', maxAllowedSize: 200000, contextWindow: 1000000, maxInputTokens: 1000000, maxOutputTokens: 48000 });
  assert.equal(m.contextWindow, 1000000);
});

test('parseUpstreamModel drops entries with no id or no usable limits', () => {
  assert.equal(parseUpstreamModel({ name: 'no id', maxInputTokens: 100 }), undefined);
  assert.equal(parseUpstreamModel({ id: 'no-limits' }), undefined);
  assert.equal(parseUpstreamModel(null), undefined);
});

test('disabledMultimodal vetoes supportsImages', () => {
  const m = parseUpstreamModel({ id: 'x', maxInputTokens: 100, supportsImages: true, disabledMultimodal: true });
  assert.equal(m.supportsImages, false);
});

test('parseCatalogDocument reads the data.models array shape', () => {
  const doc = { code: 0, data: { models: [{ id: 'a', maxInputTokens: 100, maxOutputTokens: 10 }, { id: 'b', maxInputTokens: 200, maxOutputTokens: 20 }] } };
  const list = parseCatalogDocument(doc);
  assert.deepEqual(list.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(parseCatalogDocument({ data: { models: null } }), []);
});

/* ---------------------------------------------------------------- upstream -- */

test('prepareChatBody forces stream, flattens tool_choice, adds a system message', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'function', function: { name: 'f' } },
    stream: false,
  })));
  assert.equal(out.stream, true, 'the upstream refuses non-streaming');
  assert.equal(out.tool_choice, 'f', 'the upstream wants a string');
  assert.equal(out.messages[0].role, 'system');
});

test('prepareChatBody preserves an existing non-empty system message', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: 'custom' }, { role: 'user', content: 'hi' }],
  })));
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, 'custom');
});

test('prepareChatBody replaces an empty system message rather than duplicating it', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: '  ' }, { role: 'user', content: 'hi' }],
  }), { defaultSystemPrompt: 'fallback' }));
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, 'fallback');
});

test('prepareChatBody drops fields the upstream does not accept', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    n: 2,
    store: true,
    stream_options: { include_usage: true },
  })));
  assert.equal(out.n, undefined);
  assert.equal(out.store, undefined);
  assert.equal(out.stream_options, undefined);
});

test('prepareChatBody rejects a non-object or message-less body', () => {
  assert.throws(() => prepareChatBody('[]'), UpstreamError);
  assert.throws(() => prepareChatBody('not json'), UpstreamError);
  assert.throws(() => prepareChatBody('{"model":"m"}'), UpstreamError);
});

test('classifyUpstreamError identifies the measured failure codes', () => {
  assert.equal(classifyUpstreamError(403, '{"code":11140,"msg":"request illegal"}'), 'policy_reject');
  assert.equal(classifyUpstreamError(429, '{"code":6004,"msg":"limit"}'), 'soft_rate');
  assert.equal(classifyUpstreamError(400, '{"code":11101}'), 'client');
  assert.equal(classifyUpstreamError(401, '{}'), 'session_dead');
  assert.equal(classifyUpstreamError(502, 'oops'), 'server');
  assert.equal(classifyUpstreamError(400, '{"code":12153,"msg":"Offline user session not found"}'), 'session_dead');
});

test('UpstreamError maps its kind onto a client status', () => {
  assert.equal(new UpstreamError('soft_rate', 429, 'x').clientStatus, 429);
  assert.equal(new UpstreamError('hard_credit', 402, 'x').clientStatus, 402);
  assert.equal(new UpstreamError('policy_reject', 403, 'x').clientStatus, 403);
  assert.equal(new UpstreamError('client', 400, 'x').clientStatus, 400);
});

/* -------------------------------------------------------------- SSE decode -- */

test('SseDecoder joins data lines and tolerates a split tail', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push('data: {"a":'), []);
  assert.deepEqual(d.push('1}\n\n'), ['{"a":1}']);
});

test('SseDecoder ignores comments and handles CRLF', () => {
  const d = new SseDecoder();
  const out = d.push(': keep-alive\r\n\r\ndata: hello\r\n\r\n');
  assert.deepEqual(out, ['hello']);
});

test('SseDecoder handles several frames in one chunk', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push('data: a\n\ndata: b\n\ndata: c\n\n'), ['a', 'b', 'c']);
});

test('SseDecoder flush recovers a frame with no trailing blank line', () => {
  const d = new SseDecoder();
  d.push('data: tail');
  assert.deepEqual(d.flush(), ['tail']);
});

test('SseDecoder passes the [DONE] sentinel through verbatim', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push('data: [DONE]\n\n'), ['[DONE]']);
});
