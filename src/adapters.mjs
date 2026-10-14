/**
 * Protocol adapters: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses.
 *
 * All three are projections of the SAME upstream SSE stream, so the translation
 * lives in one place per direction:
 *
 *   upstream chunk -> "events" -> the client's wire format
 *
 * The intermediate `events` shape is deliberately small (`text`, `thinking`,
 * `tool_call`, `finish`, `usage`). Adding a fourth protocol means writing one
 * projector, not another stream parser.
 *
 * Measured upstream facts that shape this file (docs/upstream-protocol.md):
 *   - thinking arrives as `delta.reasoning_content`, separate from `content`
 *   - `delta.tool_calls[].function.arguments` arrives as FRAGMENTS keyed by
 *     `index`; the first fragment also carries `id` and `name`
 *   - `usage` is only present on the final chunk, and carries real `credit`
 *
 * @module workbuddy-api/adapters
 */

import { iterateChatChunks } from './upstream.mjs';

/**
 * Accumulate a tool-call stream into whole calls.
 *
 * The upstream sends the id/name once and then the JSON arguments in pieces, so
 * assembling by `index` is required — concatenating per frame would emit one
 * truncated call per fragment.
 */
export class ToolCallAccumulator {
  constructor() {
    this.calls = new Map(); // index -> {id, name, arguments}
    this.order = [];
  }

  add(deltas) {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas) {
      const index = Number.isInteger(d?.index) ? d.index : 0;
      let entry = this.calls.get(index);
      if (!entry) {
        entry = { id: '', name: '', arguments: '' };
        this.calls.set(index, entry);
        this.order.push(index);
      }
      if (typeof d.id === 'string' && d.id !== '') entry.id = d.id;
      const fn = d.function;
      if (fn) {
        if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name;
        if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
      }
    }
  }

  /** Complete calls in the order the upstream introduced them. */
  list() {
    return this.order.map((i) => this.calls.get(i)).filter((c) => c && c.name !== '');
  }

  get size() {
    return this.list().length;
  }
}

/**
 * Convert upstream chunks into a protocol-neutral event stream.
 *
 * `includeThinking` is a policy choice rather than a constant: OpenAI clients
 * have no field for reasoning text, so it is discarded there (keeping it would
 * require inventing a field), while Anthropic has a real `thinking` block to map
 * onto.
 */
export async function* toEvents(response, { signal, includeThinking = false } = {}) {
  const tools = new ToolCallAccumulator();
  let sawFinish = false;
  let usage;
  let id = '';
  let model = '';

  for await (const chunk of iterateChatChunks(response, { signal })) {
    if (typeof chunk.id === 'string' && chunk.id !== '' && id === '') id = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (!delta) continue;

    if (includeThinking && typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      yield { type: 'thinking', text: delta.reasoning_content };
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      yield { type: 'text', text: delta.content };
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      tools.add(delta.tool_calls);
      yield { type: 'tool_call_delta', deltas: delta.tool_calls };
    }
    if (choice.finish_reason) {
      sawFinish = true;
      yield { type: 'finish', reason: choice.finish_reason };
    }
  }

  if (!sawFinish) yield { type: 'finish', reason: 'stop' };
  yield { type: 'end', tools: tools.list(), usage, id, model };
}

/**
 * Assemble a complete (non-streaming) answer from the event stream.
 *
 * The upstream cannot answer non-streaming at all (`code 11101`), so every
 * non-streaming response this service serves is assembled here. Buffering is the
 * price of the upstream's constraint, not a design preference.
 */
export async function collectCompletion(response, opts = {}) {
  let text = '';
  let thinking = '';
  let finishReason = 'stop';
  let tools = [];
  let usage;
  let id = '';
  let model = '';

  for await (const ev of toEvents(response, opts)) {
    switch (ev.type) {
      case 'text': text += ev.text; break;
      case 'thinking': thinking += ev.text; break;
      case 'finish': finishReason = ev.reason; break;
      case 'end':
        tools = ev.tools;
        usage = ev.usage;
        id = ev.id;
        model = ev.model;
        break;
      default: break;
    }
  }
  return { text, thinking, finishReason, tools, usage, id, model };
}

/** Map an upstream finish_reason onto OpenAI's vocabulary. */
export function openAIFinish(reason) {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

/** Map an upstream finish_reason onto Anthropic's `stop_reason`. */
export function anthropicStop(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'end_turn';
}

/**
 * Real usage numbers when the upstream supplied them.
 *
 * `credit` is passed through because it is the ACTUAL amount charged, which is
 * more truthful than any token-derived estimate.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
  };
  if (Number.isFinite(Number(usage.credit))) out.credit = Number(usage.credit);
  if (Number.isFinite(Number(usage.completion_thinking_tokens))) {
    out.completion_thinking_tokens = Number(usage.completion_thinking_tokens);
  }
  return out;
}
