/**
 * Chat dispatch: one upstream call, three client protocols.
 *
 * Each handler does the same four things, so the shared work is factored out:
 *
 *   1. read and validate the client body
 *   2. choose the site (explicit prefix, else auto-route by which site serves the model)
 *   3. translate the body to the upstream's OpenAI-ish wire format
 *   4. translate the upstream's SSE stream back to the client's protocol
 *
 * Translation in both directions is needed because the upstream speaks one
 * dialect (forced streaming, string `tool_choice`, `reasoning_content`) while
 * clients speak three others.
 *
 * @module workbuddy-api/chat
 */

import { SITES } from './config.mjs';
import { credentialStatus } from './auth.mjs';
import { UpstreamError, chatStream, prepareChatBody, errorHint } from './upstream.mjs';
import {
  fitMessages,
  estimateMessages,
  estimateSideTokens,
  learnedLimit,
  rememberLimit,
  calibrateEstimate,
  calibrationFactor,
  isTooLongError,
  parseLimitFromError,
} from './compress.mjs';
import { collectCompletion, toEvents } from './adapters.mjs';
import {
  openAIChunk,
  openAICompletion,
  anthropicMessage,
  AnthropicStream,
  ResponsesStream,
} from './protocols.mjs';

/** Bodies are capped so a runaway client cannot exhaust memory. */
const BODY_LIMIT = 64 * 1024 * 1024;

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new UpstreamError('client', 413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Whether the client asked for a streamed answer. */
function wantsStream(body, protocol) {
  return body?.stream === true;
}

/**
 * Resolve which site should serve a model.
 *
 * Priority: an explicit `site/model` prefix (or `site:model`), then a site that
 * actually lists the model, then the configured default. Auto-routing by roster
 * matters because the same model id can exist on several sites with different
 * rates, and a client that sends a bare id should still reach a working one.
 */
export function resolveRoute(modelId, { catalog, config, signedInSites }) {
  const raw = String(modelId ?? '').trim() || 'default-model';

  for (const sep of ['/', ':']) {
    const idx = raw.indexOf(sep);
    if (idx > 0) {
      const maybe = raw.slice(0, idx);
      if (SITES[maybe]) return { siteId: maybe, model: raw.slice(idx + 1) };
    }
  }

  for (const id of signedInSites) {
    const roster = catalog.peek(id);
    if (roster?.models.some((m) => m.id === raw)) return { siteId: id, model: raw };
  }

  if (signedInSites.includes(config.defaultSite)) return { siteId: config.defaultSite, model: raw };
  if (signedInSites.length > 0) return { siteId: signedInSites[0], model: raw };
  return { siteId: config.defaultSite, model: raw };
}

/** Map an upstream failure onto the client's error vocabulary. */
function fail(res, err, protocol) {
  const kind = err instanceof UpstreamError ? err.kind : 'server';
  const status = err instanceof UpstreamError ? err.clientStatus : 502;
  const hint = errorHint(kind);
  const message = hint ? `${err.message}（${hint}）` : err.message;
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type: kind, message } }
    : { error: { message, type: kind, code: kind } };
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function beginSse(res, protocol) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (obj) => {
    if (!res.writableEnded) res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };
  const writeData = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  return { write, writeData, protocol };
}

/* ----------------------------------------------------------- conversions -- */

/**
 * Convert Anthropic Messages input into an OpenAI chat body.
 *
 * Anthropic puts the system prompt in a top-level field and represents tool
 * results as content blocks inside a `user` turn, whereas OpenAI uses a `system`
 * message and separate `tool` messages. Both differences must be bridged or the
 * conversation is silently wrong.
 */
export function anthropicToOpenAI(body, { defaultSystemPrompt = '' } = {}) {
  const messages = [];
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n')
      : '';
  messages.push({ role: 'system', content: systemText || defaultSystemPrompt || 'You are a helpful assistant.' });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const content = msg.content;
    if (typeof content === 'string') {
      messages.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts = [];
    const toolResults = [];
    const toolUses = [];
    for (const block of content) {
      if (block?.type === 'text') parts.push({ type: 'text', text: block.text ?? '' });
      else if (block?.type === 'image' && block.source) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: block.source.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.url,
          },
        });
      } else if (block?.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block?.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (c?.type === 'text' ? c.text : '')).join('')
          : typeof block.content === 'string' ? block.content : '';
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
      }
    }

    if (toolUses.length > 0) {
      const textOnly = parts.map((p) => p.text ?? '').join('');
      messages.push({
        role: 'assistant',
        content: textOnly || null,
        tool_calls: toolUses,
      });
    } else if (parts.length > 0) {
      messages.push({ role: msg.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
    // Tool results become their own `tool` messages, in the order declared.
    messages.push(...toolResults);
  }

  const out = {
    model: body.model,
    messages,
    stream: true,
  };
  if (Number.isFinite(body.max_tokens)) out.max_tokens = body.max_tokens;
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} } },
    }));
    if (body.tool_choice) {
      if (body.tool_choice.type === 'tool') out.tool_choice = body.tool_choice.name;
      else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
      else out.tool_choice = 'auto';
    }
  }
  return out;
}

/**
 * Convert an OpenAI Responses request into a chat body.
 *
 * Codex CLI sends `instructions` plus an `input` list whose items are messages or
 * function-call/function-call-output pairs; the latter are OpenAI's *Responses*
 * spelling of tool calls, which differ from chat completions enough that a naive
 * passthrough loses the tool round trip entirely.
 */
export function responsesToOpenAI(body, { defaultSystemPrompt = '' } = {}) {
  const messages = [{ role: 'system', content: body.instructions || defaultSystemPrompt || 'You are a helpful assistant.' }];
  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === 'message' || item?.role) {
        const text = Array.isArray(item.content)
          ? item.content.map((c) => (c?.type === 'input_text' || c?.type === 'output_text' ? c.text : c?.text ?? '')).join('')
          : typeof item.content === 'string' ? item.content : '';
        messages.push({ role: item.role ?? 'user', content: text });
      } else if (item?.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments ?? '{}' },
          }],
        });
      } else if (item?.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      }
    }
  }

  const out = { model: body.model, messages, stream: true };
  if (Number.isFinite(body.max_output_tokens)) out.max_tokens = body.max_output_tokens;
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Responses tools are flat ({type:'function', name, parameters}); chat wants
    // them nested under `function`.
    out.tools = body.tools
      .filter((t) => t?.type === 'function' && typeof t.name === 'string')
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } },
      }));
  }
  return out;
}

/* --------------------------------------------------------------- handlers -- */

export function createChatDispatcher({ config, catalog, resolveCredential, log = console }) {
  /** Shared setup: read the body, pick a site, resolve a credential. */
  async function prepare(req, body, protocol) {
    const signedInSites = Object.keys(SITES).filter((id) => credentialStatus(id).signedIn);
    const route = resolveRoute(body.model, { catalog, config, signedInSites });
    const site = SITES[route.siteId];
    if (!site) throw new UpstreamError('client', 400, `unknown site "${route.siteId}"`);
    const credential = await resolveCredential(route.siteId);
    const upstreamBody = { ...body, model: route.model };
    return { site, siteId: route.siteId, credential, upstreamBody };
  }

  /**
   * Run one upstream call, returning the live response.
   *
   * When the request is rejected as too long, the real limit is learned, the
   * messages are shrunk, and the call is retried — up to a few times. This exists
   * because the catalog's limit is over-reported, so the first rejection is often
   * the only place the true ceiling is stated. Without the retry the user sees a
   * raw 400 in the middle of a long agent turn.
   *
   * Compression applies ONLY to messages; the tool definitions are subtracted from
   * the budget instead, because they cannot be trimmed without breaking the
   * client's tool contract.
   */
  async function callUpstream(req, upstreamBody, site, credential, res) {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const stripFingerprint = config.stripClientFingerprint !== false;
    const maxCompressAttempts = 3;
    let body = { ...upstreamBody };

    const applyFit = (limitOverride) => {
      const catalogLimit = limitOverride
        ?? learnedLimit(site.id, body.model)
        ?? null;
      if (catalogLimit === null || config.context?.enabled === false) return null;
      // The estimator under-counts, so the budget is scaled so that
      // "estimate <= scaled limit" approximates "actual <= limit".
      const factor = calibrationFactor(site.id, body.model) || 1;
      const scaled = Math.floor(catalogLimit / factor);
      const side = estimateSideTokens(body);
      const messageBudget = Math.floor(scaled * (config.context?.safetyRatio ?? 0.95)) - side;
      if (messageBudget <= 0) return null;
      const { messages, stats } = fitMessages(body.messages, {
        maxInputTokens: messageBudget + (config.context?.reserveForOutput ?? 4096),
        reserveForOutput: config.context?.reserveForOutput ?? 4096,
        minKeepMessages: config.context?.minKeepMessages ?? 4,
        safetyRatio: config.context?.safetyRatio ?? 0.95,
      });
      if (!stats.applied) return null;
      body = { ...body, messages };
      return { stats, side };
    };

    // Pre-emptive fit when a limit is already known.
    const pre = applyFit();
    if (pre) {
      log.warn?.(`[${site.id}] ${body.model} 上下文预压缩：丢弃 ${pre.stats.dropped} 条、截断 ${pre.stats.truncated} 条（${pre.stats.before} → ${pre.stats.after} tokens）`
        + (pre.side ? `；另有工具定义约 ${pre.side} tokens 不参与裁剪` : ''));
    }

    for (let attempt = 0; ; attempt += 1) {
      const prepared = prepareChatBody(JSON.stringify(body), {
        defaultSystemPrompt: config.defaultSystemPrompt,
        ensureSystem: config.ensureSystemMessage,
        stripFingerprint,
      });
      try {
        return await chatStream(site, credential, prepared, {
          signal: controller.signal,
          timeouts: config.timeouts,
          retry: config.upstreamRetry,
        });
      } catch (err) {
        if (!(err instanceof UpstreamError) || attempt >= maxCompressAttempts) throw err;
        const raw = `${err.message} ${err.detail?.displayMsg ?? ''}`;
        if (!isTooLongError(err.status, raw)) throw err;

        const reported = parseLimitFromError(raw);
        const estimated = estimateMessages(body.messages) + estimateSideTokens(body);
        if (reported !== null) {
          rememberLimit(site.id, body.model, reported);
          calibrateEstimate(site.id, body.model, reported, estimated);
        }
        // Whether or not a number was reported, shrink relative to the CURRENT
        // size: the reported figure was measured contradicting itself, so it is a
        // signal that we are too big, not a trustworthy ceiling.
        const fit = applyFit(learnedLimit(site.id, body.model));
        if (!fit) throw err;
        log.warn?.(`[${site.id}] ${body.model} 输入超限，已压缩后重试（第 ${attempt + 1} 次，丢弃 ${fit.stats.dropped} 条）：${raw.slice(0, 100)}`);
      }
    }
  }

  return {
    /** POST /v1/chat/completions */
    async openai(req, res) {
      let parsed;
      try {
        const raw = await readBody(req);
        parsed = JSON.parse(raw);
      } catch (err) {
        return fail(res, new UpstreamError('client', 400, `invalid request body: ${err.message}`), 'openai');
      }
      try {
        const { site, credential, upstreamBody } = await prepare(req, parsed, 'openai');
        const upstream = await callUpstream(req, upstreamBody, site, credential, res);

        if (!wantsStream(parsed, 'openai')) {
          const result = await collectCompletion(upstream);
          const payload = openAICompletion({ id: result.id, model: result.model || upstreamBody.model, result });
          return sendJsonResponse(res, payload);
        }

        const sse = beginSse(res, 'openai');
        let first = true;
        for await (const ev of toEvents(upstream)) {
          if (ev.type === 'text') {
            sse.writeData(openAIChunk({ model: upstreamBody.model, delta: first ? { role: 'assistant', content: ev.text } : { content: ev.text } }));
            first = false;
          } else if (ev.type === 'tool_call_delta') {
            sse.writeData(openAIChunk({ model: upstreamBody.model, delta: { tool_calls: ev.deltas } }));
            first = false;
          } else if (ev.type === 'finish') {
            sse.writeData(openAIChunk({ model: upstreamBody.model, delta: {}, finishReason: ev.reason === 'stop' ? 'stop' : ev.reason }));
          } else if (ev.type === 'end') {
            sse.writeData({ ...openAIChunk({ model: upstreamBody.model, delta: {}, finishReason: null }), usage: undefined, choices: [] });
            if (!res.writableEnded) res.write('data: [DONE]\n\n');
          }
        }
        if (!res.writableEnded) res.end();
      } catch (err) {
        if (res.headersSent) {
          log.warn?.('[openai] stream failed after headers:', err.message);
          res.end();
          return;
        }
        fail(res, err, 'openai');
      }
    },

    /** POST /v1/messages */
    async anthropic(req, res) {
      let parsed;
      try {
        const raw = await readBody(req);
        parsed = JSON.parse(raw);
      } catch (err) {
        return fail(res, new UpstreamError('client', 400, `invalid request body: ${err.message}`), 'anthropic');
      }
      try {
        const upstreamBody = anthropicToOpenAI(parsed, { defaultSystemPrompt: config.defaultSystemPrompt });
        const { site, credential } = await prepare(req, upstreamBody, 'anthropic');
        const upstream = await callUpstream(req, upstreamBody, site, credential, res);
        const model = parsed.model;

        if (parsed.stream !== true) {
          const result = await collectCompletion(upstream);
          return sendJsonResponse(res, anthropicMessage({ id: result.id, model, result }));
        }

        const sse = beginSse(res, 'anthropic');
        const projector = new AnthropicStream({ id: '', model });
        for (const ev of projector.start()) sse.write(ev);
        for await (const ev of toEvents(upstream, { includeThinking: true })) {
          if (ev.type === 'thinking') {
            for (const out of projector.thinking(ev.text)) sse.write(out);
          } else if (ev.type === 'text') {
            for (const out of projector.text(ev.text)) sse.write(out);
          } else if (ev.type === 'tool_call_delta') {
            for (const out of projector.toolDelta(ev.deltas)) sse.write(out);
          } else if (ev.type === 'end') {
            for (const out of projector.stop({ finishReason: ev.finishReason ?? 'stop', usage: ev.usage })) sse.write(out);
          }
        }
        if (!res.writableEnded) res.end();
      } catch (err) {
        if (res.headersSent) {
          log.warn?.('[anthropic] stream failed after headers:', err.message);
          res.end();
          return;
        }
        fail(res, err, 'anthropic');
      }
    },

    /** POST /v1/responses */
    async responses(req, res) {
      let parsed;
      try {
        const raw = await readBody(req);
        parsed = JSON.parse(raw);
      } catch (err) {
        return fail(res, new UpstreamError('client', 400, `invalid request body: ${err.message}`), 'openai');
      }
      try {
        const upstreamBody = responsesToOpenAI(parsed, { defaultSystemPrompt: config.defaultSystemPrompt });
        const { site, credential } = await prepare(req, upstreamBody, 'responses');
        const upstream = await callUpstream(req, upstreamBody, site, credential, res);

        const sse = beginSse(res, 'openai');
        const projector = new ResponsesStream({ id: '', model: parsed.model });
        for (const out of projector.start()) sse.write(out);
        for await (const ev of toEvents(upstream)) {
          if (ev.type === 'text') {
            for (const out of projector.text(ev.text)) sse.write(out);
          } else if (ev.type === 'tool_call_delta') {
            for (const out of projector.toolDelta(ev.deltas)) sse.write(out);
          } else if (ev.type === 'end') {
            for (const out of projector.stop({ finishReason: ev.finishReason ?? 'stop', usage: ev.usage })) sse.write(out);
          }
        }
        if (!res.writableEnded) res.end();
      } catch (err) {
        if (res.headersSent) {
          log.warn?.('[responses] stream failed after headers:', err.message);
          res.end();
          return;
        }
        fail(res, err, 'openai');
      }
    },
  };
}

function sendJsonResponse(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
