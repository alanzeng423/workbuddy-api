/**
 * Tests for client-fingerprint stripping.
 *
 * Every case here corresponds to a row in the measured matrix in
 * docs/upstream-protocol.md. The "followed by body text" case is the important
 * one: it is the shape Claude Code actually sends, and an equality-based
 * implementation would pass the simpler cases while failing this one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripClientFingerprint, prepareChatBody } from '../src/upstream.mjs';

const FULL = "You are Claude Code, Anthropic's official CLI for Claude.";

const systems = (body) => JSON.parse(body).messages.filter((m) => m.role === 'system');

test('strips the fingerprint when it is the entire system message', () => {
  const messages = [{ role: 'system', content: FULL }, { role: 'user', content: 'hi' }];
  const changed = stripClientFingerprint(messages, 'fallback');
  assert.equal(changed, 1);
  // The whole message was the fingerprint, so the fallback must take over.
  assert.equal(messages[0].content, 'fallback');
});

test('strips the fingerprint when body text FOLLOWS it (the Claude Code shape)', () => {
  const messages = [{
    role: 'system',
    content: `${FULL}\n\nYou are an interactive CLI tool that helps users with software engineering tasks.`,
  }];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 1);
  assert.ok(!messages[0].content.includes('Anthropic'), 'fingerprint must be gone');
  assert.match(messages[0].content, /interactive CLI tool/, 'real instructions must survive');
});

test('leaves a system message whose fingerprint is not at the start', () => {
  // Measured: embedded mid-prompt PASSES upstream, so stripping is unnecessary.
  const content = `You are a helpful agent.\n\n${FULL}\n\nBe concise.`;
  const messages = [{ role: 'system', content }];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 0);
  assert.equal(messages[0].content, content, 'content must be untouched');
});

test('strips a leading-whitespace fingerprint (upstream ignores leading space)', () => {
  const messages = [{ role: 'system', content: `\n\n   ${FULL}\n\nMore instructions.` }];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 1);
  assert.ok(!messages[0].content.includes('Claude Code'));
});

test('strips case-insensitively', () => {
  const messages = [{ role: 'system', content: "YOU ARE CLAUDE CODE, ANTHROPIC'S OFFICIAL CLI FOR CLAUDE.\n\nDo things." }];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 1);
  assert.ok(!/claude code/i.test(messages[0].content));
});

test('strips without the trailing period too', () => {
  const messages = [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude\n\nDo things." }];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 1);
});

test('never touches non-system messages', () => {
  const messages = [
    { role: 'user', content: FULL },
    { role: 'assistant', content: FULL },
  ];
  assert.equal(stripClientFingerprint(messages, 'fallback'), 0);
  assert.equal(messages[0].content, FULL, 'a user message is not in scope');
});

test('tolerates a messages array that is not an array', () => {
  assert.equal(stripClientFingerprint(undefined, 'x'), 0);
  assert.equal(stripClientFingerprint([null, 'str', {}], 'x'), 0);
});

test('prepareChatBody strips fingerprints before guaranteeing a system message', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm',
    messages: [{ role: 'system', content: FULL }, { role: 'user', content: 'hi' }],
  }), { defaultSystemPrompt: 'You are helpful.' }));
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'You are helpful.');
});

test('prepareChatBody rewrites the developer role to system', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }],
  })));
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'rules');
  // Rewriting must not add a second system message.
  assert.equal(systems(JSON.stringify(out)).length, 1);
});

test('tool_choice "none" drops the tool definitions as well', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
    tool_choice: 'none',
  })));
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.tools, undefined, 'leaving tools in invites a call the client forbade');
});

test('tool_choice object forms map onto the string the upstream accepts', () => {
  const req = (tc) => JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
    tool_choice: tc,
  }))).tool_choice;

  assert.equal(req({ type: 'auto' }), 'auto');
  assert.equal(req({ type: 'required' }), 'required');
  assert.equal(req({ type: 'function', function: { name: 'f' } }), 'f');
  assert.equal(req({ type: 'none' }), undefined);
});

test('prepareChatBody can be told to skip fingerprint stripping', () => {
  const out = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: FULL }, { role: 'user', content: 'hi' }],
  }), { stripFingerprint: false }));
  assert.equal(out.messages[0].content, FULL);
});
