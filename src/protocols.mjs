/**
 * Wire-format projectors: turn protocol-neutral events into each client protocol.
 *
 * Each function is a pure translation, kept apart from transport so the shapes can
 * be unit-tested without a network or a live upstream.
 *
 * @module workbuddy-api/protocols
 */

import { openAIFinish, anthropicStop, normalizeUsage } from './adapters.mjs';

const now = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------- OpenAI chat ------ */

/** One OpenAI streaming chunk. */
export function openAIChunk({ id, model, delta, finishReason, usage }) {
  const chunk = {
    id: id || `chatcmpl-${now()}`,
    object: 'chat.completion.chunk',
    created: now(),
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason ?? null,
      },
    ],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

/** A complete non-streaming OpenAI chat completion. */
export function openAICompletion({ id, model, result }) {
  const message = { role: 'assistant', content: result.text || null };
  if (result.tools.length > 0) {
    message.tool_calls = result.tools.map((t, i) => ({
      id: t.id || `call_${i}_${now()}`,
      type: 'function',
      function: { name: t.name, arguments: t.arguments || '{}' },
    }));
    // OpenAI sets content to null when the turn is purely tool calls.
    if (result.text === '') message.content = null;
  }
  const out = {
    id: id || `chatcmpl-${now()}`,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: openAIFinish(result.finishReason),
      },
    ],
  };
  const usage = normalizeUsage(result.usage);
  if (usage) out.usage = usage;
  return out;
}

/* --------------------------------------------------- Anthropic messages --- */

/**
 * Anthropic stream events.
 *
 * Anthropic's event sequence is stateful — `message_start` then per-block
 * `content_block_start/delta/stop` then `message_delta`/`message_stop` — so this
 * is a state machine rather than a mapping. Anthropic uses a single monotonic
 * `index` across text and tool blocks, which is why the block index is tracked
 * here instead of being derived per block type.
 */
export class AnthropicStream {
  constructor({ id, model }) {
    this.id = id || `msg_${now()}`;
    this.model = model;
    this.blockIndex = -1;
    this.openBlock = null; // 'text' | 'thinking' | 'tool'
    this.started = false;
    this.toolIndexByOrigin = new Map();
  }

  *start() {
    this.started = true;
    yield {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  *closeBlock() {
    if (this.openBlock === null) return;
    yield { type: 'content_block_stop', index: this.blockIndex };
    this.openBlock = null;
  }

  *thinking(text) {
    if (this.openBlock !== 'thinking') {
      yield* this.closeBlock();
      this.blockIndex += 1;
      this.openBlock = 'thinking';
      yield {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'thinking', thinking: '' },
      };
    }
    yield {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'thinking_delta', thinking: text },
    };
  }

  *text(chunk) {
    if (this.openBlock !== 'text') {
      yield* this.closeBlock();
      this.blockIndex += 1;
      this.openBlock = 'text';
      yield {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'text', text: '' },
      };
    }
    yield {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text: chunk },
    };
  }

  /** Tool-call fragments become `input_json_delta` for the matching block. */
  *toolDelta(deltas) {
    for (const d of deltas) {
      const origin = Number.isInteger(d?.index) ? d.index : 0;
      let idx = this.toolIndexByOrigin.get(origin);
      if (idx === undefined) {
        // Opening a tool block must close whatever block was open, because
        // Anthropic requires blocks to be strictly nested, never interleaved.
        yield* this.closeBlock();
        this.blockIndex += 1;
        idx = this.blockIndex;
        this.toolIndexByOrigin.set(origin, idx);
        this.openBlock = 'tool';
        yield {
          type: 'content_block_start',
          index: idx,
          content_block: {
            type: 'tool_use',
            id: d.function?.name ? (d.id || `toolu_${now()}_${origin}`) : `toolu_${now()}_${origin}`,
            name: d.function?.name || '',
            input: {},
          },
        };
      }
      const args = d.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: args },
        };
      }
    }
  }

  *stop({ finishReason, usage }) {
    // A thinking block is not a content block Anthropic counts in stop_reason;
    // closing it first keeps the emitted sequence well formed.
    yield* this.closeBlock();
    const u = normalizeUsage(usage);
    yield {
      type: 'message_delta',
      delta: { stop_reason: anthropicStop(finishReason), stop_sequence: null },
      usage: u ? { output_tokens: u.completion_tokens } : { output_tokens: 0 },
    };
    yield { type: 'message_stop' };
  }
}

/** A complete non-streaming Anthropic message. */
export function anthropicMessage({ id, model, result }) {
  const content = [];
  if (result.thinking) content.push({ type: 'thinking', thinking: result.thinking });
  if (result.text) content.push({ type: 'text', text: result.text });
  for (const [i, t] of result.tools.entries()) {
    let input = {};
    try {
      input = t.arguments ? JSON.parse(t.arguments) : {};
    } catch {
      // Anthropic requires an object here; a malformed fragment becomes empty
      // rather than a string, because a string is rejected outright.
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: t.id || `toolu_${now()}_${i}`,
      name: t.name,
      input,
    });
  }
  const usage = normalizeUsage(result.usage);
  return {
    id: id || `msg_${now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStop(result.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

/* ------------------------------------------------------ OpenAI responses -- */

/**
 * OpenAI Responses API events.
 *
 * The Responses wire format is event-typed with monotonically increasing
 * `sequence_number`. Codex CLI consumes this shape, and it differs from chat
 * completions enough (output items, not choices) that it needs its own projector.
 */
export class ResponsesStream {
  constructor({ id, model }) {
    this.id = id || `resp_${now()}`;
    this.model = model;
    this.seq = 0;
    this.itemIndex = -1;
    this.openItem = null;
    this.textBuffer = '';
  }

  next() {
    this.seq += 1;
    return this.seq;
  }

  *start() {
    yield {
      type: 'response.created',
      sequence_number: this.next(),
      response: {
        id: this.id,
        object: 'response',
        status: 'in_progress',
        model: this.model,
        output: [],
      },
    };
  }

  *closeItem() {
    if (this.openItem === null) return;
    if (this.openItem === 'message') {
      yield {
        type: 'response.output_text.done',
        sequence_number: this.next(),
        item_id: `${this.id}_msg`,
        output_index: this.itemIndex,
        content_index: 0,
        text: this.textBuffer,
      };
      yield {
        type: 'response.output_item.done',
        sequence_number: this.next(),
        output_index: this.itemIndex,
        item: {
          id: `${this.id}_msg`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: this.textBuffer, annotations: [] }],
        },
      };
    } else {
      yield {
        type: 'response.output_item.done',
        sequence_number: this.next(),
        output_index: this.itemIndex,
        item: this.openItem,
      };
    }
    this.openItem = null;
  }

  *text(chunk) {
    if (this.openItem !== 'message') {
      yield* this.closeItem();
      this.itemIndex += 1;
      this.openItem = 'message';
      this.textBuffer = '';
      yield {
        type: 'response.output_item.added',
        sequence_number: this.next(),
        output_index: this.itemIndex,
        item: { id: `${this.id}_msg`, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      };
      yield {
        type: 'response.content_part.added',
        sequence_number: this.next(),
        item_id: `${this.id}_msg`,
        output_index: this.itemIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      };
    }
    this.textBuffer += chunk;
    yield {
      type: 'response.output_text.delta',
      sequence_number: this.next(),
      item_id: `${this.id}_msg`,
      output_index: this.itemIndex,
      content_index: 0,
      delta: chunk,
    };
  }

  /** Function calls surface as their own output items. */
  *toolDelta(deltas) {
    for (const d of deltas) {
      if (!d.function?.name) continue;
      yield* this.closeItem();
      this.itemIndex += 1;
      this.openItem = {
        id: d.id || `fc_${now()}`,
        type: 'function_call',
        status: 'in_progress',
        name: d.function.name,
        arguments: '',
        call_id: d.id || `call_${now()}`,
      };
      yield {
        type: 'response.output_item.added',
        sequence_number: this.next(),
        output_index: this.itemIndex,
        item: this.openItem,
      };
    }
    // Argument fragments extend the currently open call.
    if (this.openItem && typeof this.openItem === 'object') {
      for (const d of deltas) {
        const args = d.function?.arguments;
        if (typeof args === 'string' && args !== '') {
          this.openItem.arguments += args;
          yield {
            type: 'response.function_call_arguments.delta',
            sequence_number: this.next(),
            item_id: this.openItem.id,
            output_index: this.itemIndex,
            delta: args,
          };
        }
      }
    }
  }

  *stop({ finishReason, usage }) {
    yield* this.closeItem();
    const u = normalizeUsage(usage);
    yield {
      type: 'response.completed',
      sequence_number: this.next(),
      response: {
        id: this.id,
        object: 'response',
        status: 'completed',
        model: this.model,
        output: [],
        ...(u
          ? {
            usage: {
              input_tokens: u.prompt_tokens,
              output_tokens: u.completion_tokens,
              total_tokens: u.total_tokens,
            },
          }
          : {}),
      },
    };
  }
}
