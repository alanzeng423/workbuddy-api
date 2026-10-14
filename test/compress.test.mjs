/**
 * Tests for context fitting and limit learning.
 *
 * The behaviours guarded here are the ones that fail silently: a fit that reports
 * success while the request is still too big, a tool call separated from its
 * result, or a learned limit that gets loosened by a later, less reliable sample.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  estimateMessages,
  estimateSideTokens,
  fitMessages,
  learnedLimit,
  rememberLimit,
  calibrationFactor,
  calibrateEstimate,
  isTooLongError,
  parseLimitFromError,
} from '../src/compress.mjs';

const big = (chars) => 'x'.repeat(chars);

test('estimateTokens charges CJK far more than Latin per character', () => {
  const latin = estimateTokens(big(1000));
  const cjk = estimateTokens('中'.repeat(1000));
  assert.ok(cjk > latin, 'CJK must not be estimated on a Latin ratio');
  // A Latin-ratio estimator under-counts Chinese, which is what makes a fit
  // look sufficient while the request is still over the limit.
  assert.ok(cjk / latin > 1.5, `expected a large gap, got ${cjk}/${latin}`);
});

test('estimateMessages counts every message plus a per-message overhead', () => {
  const one = estimateMessages([{ role: 'user', content: 'hi' }]);
  const two = estimateMessages([{ role: 'user', content: 'hi' }, { role: 'user', content: 'hi' }]);
  assert.ok(two > one);
  assert.equal(estimateMessages([]), 0);
});

test('estimateSideTokens counts tool definitions, which messages cannot absorb', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', description: big(4000), parameters: { type: 'object' } } }],
  };
  assert.ok(estimateSideTokens(body) > 500, 'a large tool schema must be visible in the estimate');
  assert.equal(estimateSideTokens({ messages: [] }), 0);
});

test('fitMessages keeps the system message and the newest turns', () => {
  const messages = [{ role: 'system', content: 'rules' }];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'user', content: `message ${i} ${big(2000)}` });
  }
  const { messages: fitted, stats } = fitMessages(messages, { maxInputTokens: 6000, reserveForOutput: 500 });

  assert.ok(stats.applied, 'a large list must be fitted');
  assert.equal(fitted[0].role, 'system', 'the system message is never dropped');
  assert.equal(fitted[0].content, 'rules');
  // The newest message must survive; the oldest are the ones dropped.
  assert.match(fitted.at(-1).content, /message 39/);
  assert.ok(stats.dropped > 0);
  assert.ok(stats.after < stats.before);
});

test('fitMessages leaves a small list completely untouched', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'short question' },
  ];
  const { messages: fitted, stats } = fitMessages(messages, { maxInputTokens: 100000 });
  assert.equal(stats.applied, false);
  assert.equal(fitted, messages, 'an untouched list should be returned as-is');
});

test('fitMessages honours minKeepMessages even when the budget is tiny', () => {
  const messages = [{ role: 'system', content: 'rules' }];
  for (let i = 0; i < 10; i += 1) messages.push({ role: 'user', content: `m${i} ${big(5000)}` });

  const { messages: fitted, stats } = fitMessages(messages, {
    maxInputTokens: 3000,
    reserveForOutput: 0,
    minKeepMessages: 4,
  });
  // system + at least 4 recent messages must remain.
  assert.ok(fitted.length >= 5, `expected >= 5 messages, got ${fitted.length}`);
  assert.ok(stats.truncated > 0, 'tight budgets must truncate rather than drop everything');
});

test('fitMessages never separates a tool result from its call', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: `old ${big(3000)}` },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: `result ${big(3000)}` },
    { role: 'user', content: 'newest' },
  ];
  const { messages: fitted } = fitMessages(messages, { maxInputTokens: 1500, reserveForOutput: 0, minKeepMessages: 0 });

  const keptCallIds = fitted.filter((m) => Array.isArray(m.tool_calls)).flatMap((m) => m.tool_calls.map((c) => c.id));
  const keptResultIds = fitted.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  for (const id of keptResultIds) {
    assert.ok(keptCallIds.includes(id), `tool result ${id} survived without its call`);
  }
  for (const id of keptCallIds) {
    assert.ok(keptResultIds.includes(id), `tool call ${id} survived without its result`);
  }
});

test('fitMessages truncates an over-long single message instead of dropping it', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: big(200000) },
  ];
  const { messages: fitted, stats } = fitMessages(messages, { maxInputTokens: 2000, reserveForOutput: 200, minKeepMessages: 1 });
  assert.equal(fitted.length, 2, 'the newest message must survive in some form');
  assert.ok(fitted[1].content.length < 200000);
  assert.match(fitted[1].content, /已截断/, 'a truncation marker must be present');
  assert.ok(stats.truncated >= 1);
});

test('rememberLimit only ever tightens', () => {
  rememberLimit('s1', 'm1', 100000);
  assert.equal(learnedLimit('s1', 'm1'), 100000);
  // A larger later value must not loosen the known ceiling.
  rememberLimit('s1', 'm1', 200000);
  assert.equal(learnedLimit('s1', 'm1'), 100000);
  // A smaller one is more informative and wins.
  rememberLimit('s1', 'm1', 50000);
  assert.equal(learnedLimit('s1', 'm1'), 50000);
  // Unknown pairs stay unknown rather than defaulting to a guess.
  assert.equal(learnedLimit('nope', 'nope'), null);
});

test('calibrateEstimate moves the factor toward the observed ratio', () => {
  assert.equal(calibrationFactor('s2', 'm2'), 1);
  // An underestimate: the upstream counted twice what we estimated.
  calibrateEstimate('s2', 'm2', 2000, 1000);
  assert.ok(calibrationFactor('s2', 'm2') > 1.4, 'the factor must rise to reflect under-counting');
  // Smoothing means one sample does not jump all the way to 2.0.
  assert.ok(calibrationFactor('s2', 'm2') < 2.0);
});

test('calibrateEstimate ignores unusable samples', () => {
  calibrateEstimate('s3', 'm3', 100, 0);
  assert.equal(calibrationFactor('s3', 'm3'), 1, 'a zero estimate carries no information');
  calibrateEstimate('s3', 'm3', Number.NaN, 100);
  assert.equal(calibrationFactor('s3', 'm3'), 1);
});

test('isTooLongError recognises the measured rejections only', () => {
  assert.equal(isTooLongError(400, '{"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}'), true);
  assert.equal(isTooLongError(400, 'maximum context length exceeded'), true);
  // Not a length problem: must not trigger compression.
  assert.equal(isTooLongError(400, '{"code":11140,"msg":"request illegal"}'), false);
  assert.equal(isTooLongError(429, 'too long'), false, 'only 400 is a length rejection');
  assert.equal(isTooLongError(200, 'too long'), false);
});

test('parseLimitFromError survives the JSON-escaped \\u003e form', () => {
  // The upstream escapes `>` as \u003e, so a literal match silently fails.
  const escaped = '{"code":11115,"msg":"prompt is too long: 100001 tokens \\u003e 100000 maximum"}';
  assert.equal(parseLimitFromError(escaped), 100000);
  assert.equal(parseLimitFromError('prompt is too long: 100001 tokens > 100000 maximum'), 100000);
  assert.equal(parseLimitFromError('no numbers here'), null);
});
