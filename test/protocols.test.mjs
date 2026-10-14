/**
 * Tests for the protocol projectors.
 *
 * The tool-call fixtures are the REAL frames captured from the live gateway
 * (2026-10-12): the first frame carries id+name with empty arguments, and each
 * following frame carries an argument fragment keyed by `index`. Reproducing that
 * shape exactly is the point — a synthetic "one clean delta" fixture would hide
 * the aggregation bug this test exists to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ToolCallAccumulator,
  openAIFinish,
  anthropicStop,
  normalizeUsage,
} from '../src/adapters.mjs';
import {
  openAIChunk,
  openAICompletion,
  anthropicMessage,
  AnthropicStream,
  ResponsesStream,
} from '../src/protocols.mjs';

/** The exact fragment sequence observed from the upstream. */
const REAL_TOOL_FRAMES = [
  [{ index: 0, id: 'chatcmpl-tool-b1f926ebe56a744e', type: 'function', function: { name: 'get_weather', arguments: '' } }],
  [{ function: { name: '', arguments: '{' }, index: 0 }],
  [{ function: { name: '', arguments: '"city": "' }, index: 0 }],
  [{ function: { name: '', arguments: 'Beijing' }, index: 0 }],
  [{ function: { name: '', arguments: '"}' }, index: 0 }],
];

test('ToolCallAccumulator reassembles fragmented arguments into one call', () => {
  const acc = new ToolCallAccumulator();
  for (const frame of REAL_TOOL_FRAMES) acc.add(frame);
  const calls = acc.list();
  assert.equal(calls.length, 1, 'fragments must not produce one call each');
  assert.equal(calls[0].name, 'get_weather');
  assert.equal(calls[0].id, 'chatcmpl-tool-b1f926ebe56a744e');
  assert.equal(calls[0].arguments, '{"city": "Beijing"}');
  assert.doesNotThrow(() => JSON.parse(calls[0].arguments));
});

test('ToolCallAccumulator keeps parallel calls separate and ordered', () => {
  const acc = new ToolCallAccumulator();
  acc.add([{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } }]);
  acc.add([{ index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } }]);
  acc.add([{ index: 0, function: { arguments: '1}' } }]);
  acc.add([{ index: 1, function: { arguments: '2}' } }]);
  const calls = acc.list();
  assert.deepEqual(calls.map((c) => c.name), ['one', 'two']);
  assert.equal(calls[0].arguments, '{"x":1}');
  assert.equal(calls[1].arguments, '{"y":2}');
});

test('ToolCallAccumulator ignores deltas with no function name', () => {
  const acc = new ToolCallAccumulator();
  acc.add([{ index: 0, function: { arguments: '{}' } }]);
  assert.equal(acc.list().length, 0, 'a nameless call is not usable');
});

test('openAIFinish maps upstream reasons onto the OpenAI vocabulary', () => {
  assert.equal(openAIFinish('stop'), 'stop');
  assert.equal(openAIFinish('length'), 'length');
  assert.equal(openAIFinish('tool_calls'), 'tool_calls');
  assert.equal(openAIFinish('something_new'), 'stop');
});

test('anthropicStop maps upstream reasons onto Anthropic stop_reason', () => {
  assert.equal(anthropicStop('stop'), 'end_turn');
  assert.equal(anthropicStop('length'), 'max_tokens');
  assert.equal(anthropicStop('tool_calls'), 'tool_use');
});

test('normalizeUsage passes real credit through', () => {
  const u = normalizeUsage({ prompt_tokens: 23, completion_tokens: 5, total_tokens: 28, credit: 0 });
  assert.equal(u.credit, 0, 'a zero credit is meaningful and must survive');
  assert.equal(u.total_tokens, 28);
  assert.equal(normalizeUsage(undefined), undefined);
});

test('normalizeUsage derives a missing total instead of reporting zero', () => {
  const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 4 });
  assert.equal(u.total_tokens, 14);
});

test('openAICompletion marks a tool-only turn with null content', () => {
  const out = openAICompletion({
    id: 'x',
    model: 'hy3',
    result: {
      text: '',
      thinking: '',
      finishReason: 'tool_calls',
      tools: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  });
  const msg = out.choices[0].message;
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('openAIChunk carries finish_reason only when set', () => {
  const mid = openAIChunk({ model: 'hy3', delta: { content: 'hi' } });
  assert.equal(mid.choices[0].finish_reason, null);
  const last = openAIChunk({ model: 'hy3', delta: {}, finishReason: 'stop' });
  assert.equal(last.choices[0].finish_reason, 'stop');
});

test('anthropicMessage emits thinking, text and tool_use blocks in order', () => {
  const out = anthropicMessage({
    id: 'm1',
    model: 'hy3',
    result: {
      text: 'done',
      thinking: 'reasoning here',
      finishReason: 'tool_calls',
      tools: [{ id: 't1', name: 'get_weather', arguments: '{"city":"Beijing"}' }],
      usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
    },
  });
  assert.deepEqual(out.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(out.content[2].input, { city: 'Beijing' });
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.usage.input_tokens, 7);
});

test('anthropicMessage never emits a malformed tool input as a string', () => {
  const out = anthropicMessage({
    id: 'm2',
    model: 'hy3',
    result: { text: '', thinking: '', finishReason: 'stop', tools: [{ name: 'f', arguments: '{not json' }], usage: undefined },
  });
  const tool = out.content.find((b) => b.type === 'tool_use');
  assert.equal(typeof tool.input, 'object', 'Anthropic rejects a string input');
  assert.deepEqual(tool.input, {});
});

test('AnthropicStream opens blocks lazily and closes them before switching', () => {
  const s = new AnthropicStream({ id: 'msg_1', model: 'hy3' });
  const events = [...s.start(), ...s.thinking('a'), ...s.text('hello')];
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
  ]);
  // Anthropic requires strictly increasing, gap-free indices.
  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.deepEqual(starts.map((e) => e.index), [0, 1]);
});

test('AnthropicStream assigns one tool block index per upstream call', () => {
  const s = new AnthropicStream({ id: 'msg_2', model: 'hy3' });
  const events = [...s.start()];
  for (const frame of REAL_TOOL_FRAMES) events.push(...s.toolDelta(frame));
  events.push(...s.stop({ finishReason: 'tool_calls', usage: undefined }));

  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.equal(starts.length, 1, 'fragments must not open one block each');
  const args = events
    .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
    .map((e) => e.delta.partial_json)
    .join('');
  assert.equal(args, '{"city": "Beijing"}');
  // Every opened block must be closed exactly once.
  const opened = starts.length;
  const closed = events.filter((e) => e.type === 'content_block_stop').length;
  assert.equal(opened, closed);
  assert.equal(events.at(-1).type, 'message_stop');
});

test('ResponsesStream emits sequenced events and one completed response', () => {
  const s = new ResponsesStream({ id: 'resp_1', model: 'hy3' });
  const events = [...s.start(), ...s.text('hello '), ...s.text('world'), ...s.stop({ finishReason: 'stop' })];
  const seqs = events.map((e) => e.sequence_number);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence numbers must ascend');
  assert.equal(new Set(seqs).size, seqs.length, 'sequence numbers must be unique');

  const completed = events.at(-1);
  assert.equal(completed.type, 'response.completed');
  const textDone = events.find((e) => e.type === 'response.output_text.done');
  assert.equal(textDone.text, 'hello world', 'text deltas must accumulate');
});

test('ResponsesStream keeps a single message item across many text deltas', () => {
  const s = new ResponsesStream({ id: 'resp_2', model: 'hy3' });
  const events = [...s.start(), ...s.text('a'), ...s.text('b'), ...s.text('c')];
  const added = events.filter((e) => e.type === 'response.output_item.added');
  assert.equal(added.length, 1, 'three deltas are one item, not three');
});

test('ResponsesStream records function call arguments in the final item', () => {
  const s = new ResponsesStream({ id: 'resp_3', model: 'hy3' });
  const events = [...s.start()];
  for (const frame of REAL_TOOL_FRAMES) events.push(...s.toolDelta(frame));
  events.push(...s.stop({ finishReason: 'tool_calls', usage: undefined }));

  const done = events.filter((e) => e.type === 'response.output_item.done');
  const fn = done.map((e) => e.item).find((i) => i.type === 'function_call');
  assert.ok(fn, 'a function_call item must be emitted');
  assert.equal(fn.name, 'get_weather');
  assert.equal(fn.arguments, '{"city": "Beijing"}');
});
