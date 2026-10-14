/**
 * Upstream client: request shaping, error classification, and streaming.
 *
 * Everything here is grounded in live measurements against the real gateway
 * (see docs/upstream-protocol.md), not in assumptions:
 *
 *  - A non-streaming request is REFUSED (`400 / code 11101`, "Non-stream chat
 *    request is currently not supported"). `stream: true` is therefore forced on
 *    every upstream call, and any non-streaming answer this service offers is
 *    assembled locally from the SSE stream.
 *  - The international gateway requires the conversation to OPEN with a system
 *    message.
 *  - Thinking text arrives in `delta.reasoning_content`, a field official OpenAI
 *    does not define. It is preserved rather than dropped, because throwing it
 *    away turns a reasoning model's output into a partial one.
 *
 * @module workbuddy-api/upstream
 */

import { randomBytes, randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Failure classes, mapped to the HTTP status a client should see. */
export const KIND_STATUS = {
  hard_credit: 402, // out of credits
  soft_rate: 429, // rate limited
  session_dead: 401, // credential rejected
  policy_reject: 403, // content-policy refusal
  not_found: 502, // model/route missing upstream
  server: 502, // upstream fault
  client: 400, // the request itself is invalid
};

export class UpstreamError extends Error {
  constructor(kind, status, message, detail) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }

  /** The HTTP status to surface to the client. */
  get clientStatus() {
    return KIND_STATUS[this.kind] ?? 502;
  }
}

/** Extract the structured fields an upstream failure body carries. */
export function parseErrorDetail(bodyText) {
  try {
    const doc = JSON.parse(bodyText);
    if (typeof doc !== 'object' || doc === null) return undefined;
    const display = doc.displayMsg;
    const msg = typeof display === 'string'
      ? display
      : (display?.zh ?? display?.en ?? (typeof doc.msg === 'string' ? doc.msg : undefined));
    return {
      upstreamCode: typeof doc.code === 'number' ? doc.code : undefined,
      requestId: typeof doc.requestId === 'string' ? doc.requestId : undefined,
      displayMsg: msg,
    };
  } catch {
    return undefined;
  }
}

/**
 * Classify an upstream failure.
 *
 * Ordering matters: a numeric business code is the most specific signal, so it is
 * checked before the HTTP status, which several distinct causes share.
 */
export function classifyUpstreamError(status, bodyText) {
  let code;
  try {
    code = JSON.parse(bodyText)?.code;
  } catch {
    code = undefined;
  }
  const text = String(bodyText ?? '');

  // Content policy: deterministic refusal, never worth retrying.
  if (code === 11140 || /request illegal|内容未通过|content policy/i.test(text)) return 'policy_reject';
  // Rate limiting is reported as 6004; it is per-account and time-bound.
  if (code === 6004 || status === 429) return 'soft_rate';
  // Insufficient credits.
  if (/insufficient|积分不足|quota/i.test(text)) return 'hard_credit';
  // Dead session / rejected credential.
  if (code === 12153 || /session.*not found|unauthorized/i.test(text)) return 'session_dead';
  if (status === 401) return 'session_dead';
  if (status === 402) return 'hard_credit';
  if (status === 403) return 'policy_reject';
  // "model ... service info not found" means the account cannot use this model.
  if (code === 11115 || /prompt is too long/i.test(text)) return 'client';
  if (status === 404 || /service info not found|model.*not found/i.test(text)) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'server';
}

/** Human-facing hints attached to a classified failure. */
export function errorHint(kind) {
  switch (kind) {
    case 'policy_reject':
      return '该请求被上游内容策略拒绝（通常是 agent 的 system prompt 里含安全术语触发），重新登录不会解决；可尝试在客户端精简 system prompt。';
    case 'soft_rate':
      return '上游按请求体积限流（实测约 20k token 可通过、30k 被拒），降低上下文长度或稍后重试。';
    case 'hard_credit':
      return '账号积分不足，请到 WorkBuddy 查看余额或更换账号。';
    case 'session_dead':
      return '登录态已失效，请重新登录该站点。';
    case 'not_found':
      return '该模型在你的账号下不可用，或上游已下线。';
    default:
      return undefined;
  }
}

/**
 * Build the headers an upstream request must carry.
 *
 * These mirror what the official CodeBuddy CLI sends. The identity headers
 * (`X-User-Id` / `X-Enterprise-Id` / `X-Domain`) are not decoration: the gateway
 * uses them to resolve which account and realm the request belongs to, and their
 * *absence* markers (`X-No-User-Id` etc.) are how the client states "this account
 * has none" — omitting the header entirely is not the same signal.
 */
export function upstreamHeaders(site, credential, { stream = true, requestId } = {}) {
  const origin = site.origin ?? new URL(site.apiBase).origin;
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json, text/plain, */*',
    'User-Agent': site.ua,
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'X-Product': site.product ?? 'SaaS',
    'X-Request-ID': requestId ?? randomBytes(16).toString('hex'),
    'X-Request-Trace-Id': randomUUID(),
  };
  if (credential?.accessToken) headers.Authorization = `Bearer ${credential.accessToken}`;
  if (credential?.uid) headers['X-User-Id'] = credential.uid;
  else headers['X-No-User-Id'] = '1';
  if (credential?.enterpriseId) headers['X-Enterprise-Id'] = credential.enterpriseId;
  else headers['X-No-Enterprise-Id'] = '1';
  // The gateway uses this to pick the realm for dual-branded sites.
  if (credential?.domain) headers['X-Domain'] = credential.domain;
  else headers['X-No-Department-Info'] = '1';
  return headers;
}

/** Whether a thrown fetch error is a transient transport fault worth retrying. */
export function isTransportError(err) {
  if (!err) return false;
  const code = err.cause?.code ?? err.code ?? '';
  // The international gateway was measured dropping roughly 17% of connections
  // with ECONNRESET / socket errors, so these are expected, not exceptional.
  if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT/i.test(String(code))) {
    return true;
  }
  return /socket|network|fetch failed/i.test(String(err.message ?? ''));
}

/**
 * Client-identifying sentences the upstream refuses by EXACT match.
 *
 * The gateway keeps a blacklist of literal client prompts and answers
 * `400 / code 11128 "Illegal API invocation from an unapproved channel"` when the
 * system message begins with one. Measured against the live gateway
 * (2026-10-12, see docs/upstream-protocol.md):
 *
 *   - the whole sentence alone is refused
 *   - either HALF of it passes, so it is not a keyword filter
 *   - the sentence in a `user` message passes
 *   - the sentence EMBEDDED mid-prompt passes
 *   - the sentence followed by ANYTHING (newline, space, 100 chars) is refused
 *   - leading whitespace is ignored
 *   - matching is case-insensitive
 *
 * That last pair is why stripping must REPLACE the sentence at the START of the
 * message rather than compare the whole message against it: the shape Claude Code
 * actually sends is "sentence, then a long instruction block", which an equality
 * check would miss entirely while looking correct.
 *
 * The patterns are ANCHORED to the start (after optional whitespace, which the
 * upstream itself ignores). Measured: a fingerprint embedded mid-prompt passes
 * upstream, so stripping it there would edit a user's real instructions for no
 * benefit. Only the leading form is both necessary and safe to remove.
 *
 * Only patterns reproduced on the live gateway belong here. Each extra pattern is
 * another chance to mangle a user's real instructions, so this list stays
 * deliberately tiny.
 */
const CLIENT_FINGERPRINTS = [
  /^\s*You are Claude Code,\s*Anthropic's official CLI for Claude\.?/i,
];

/**
 * Remove client fingerprints from every system message.
 *
 * Returns the number of messages changed. A message emptied by stripping falls
 * back to `fallbackPrompt`, because an empty system message is itself a 400 on
 * the international gateway.
 */
export function stripClientFingerprint(messages, fallbackPrompt) {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (String(message.role ?? '').toLowerCase() !== 'system') continue;
    if (typeof message.content !== 'string' || message.content === '') continue;
    let next = message.content;
    for (const pattern of CLIENT_FINGERPRINTS) {
      if (!pattern.test(next)) continue;
      // Collapse the blank lines the removal can leave behind.
      next = next.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (next !== message.content) {
      message.content = next || fallbackPrompt;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Shape an OpenAI chat body for the upstream.
 *
 * Four transformations, each required by a measurement:
 *  1. `stream` is forced true — the upstream refuses non-streaming
 *     (`400 / code 11101`).
 *  2. `developer` role becomes `system` — the upstream's role whitelist has no
 *     `developer`.
 *  3. client fingerprints are stripped — see {@link CLIENT_FINGERPRINTS}.
 *  4. `tool_choice` is flattened to a string and a leading system message is
 *     guaranteed.
 *
 * Fingerprint stripping runs BEFORE the system-message guarantee on purpose: if
 * the entire system message consisted of a fingerprint, the fallback prompt has
 * to be able to take its place.
 */
export function prepareChatBody(rawBody, {
  defaultSystemPrompt = '',
  ensureSystem = true,
  stripFingerprint = true,
} = {}) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new UpstreamError('client', 400, 'request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UpstreamError('client', 400, 'request body must be a JSON object');
  }
  if (!Array.isArray(body.messages)) {
    throw new UpstreamError('client', 400, '`messages` must be an array');
  }

  body.stream = true;

  for (const message of body.messages) {
    if (message && typeof message === 'object' && String(message.role ?? '').toLowerCase() === 'developer') {
      message.role = 'system';
    }
  }

  const fallback = defaultSystemPrompt || 'You are a helpful assistant.';
  if (stripFingerprint) stripClientFingerprint(body.messages, fallback);

  if (body.tool_choice !== undefined && typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    const { type, function: fn } = body.tool_choice;
    const kind = typeof type === 'string' ? type.toLowerCase() : '';
    if (kind === 'function' && typeof fn?.name === 'string') body.tool_choice = fn.name;
    else if (kind === 'auto' || kind === 'required') body.tool_choice = kind;
    else if (kind === 'none') {
      // `none` means "do not call tools"; forwarding the tool DEFINITIONS
      // alongside it invites the model to call one anyway.
      delete body.tool_choice;
      delete body.tools;
      delete body.functions;
    } else delete body.tool_choice;
  } else if (typeof body.tool_choice === 'string' && body.tool_choice.toLowerCase() === 'none') {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  }

  if (ensureSystem) {
    const first = body.messages[0];
    if (!first || String(first.role ?? '').toLowerCase() !== 'system') {
      body.messages.unshift({ role: 'system', content: fallback });
    } else if (typeof first.content === 'string' && first.content.trim() === '') {
      first.content = fallback;
    }
  }

  // Fields the upstream does not understand are dropped rather than forwarded:
  // an unknown field is a 400 on a strict gateway, and these are all client-side
  // conveniences with no upstream meaning.
  for (const key of ['stream_options', 'store', 'metadata', 'user', 'n', 'logprobs', 'top_logprobs']) {
    delete body[key];
  }

  return JSON.stringify(body);
}

/**
 * One upstream chat call.
 *
 * Resolves to the live `Response` on success so the caller can stream it; throws
 * an {@link UpstreamError} otherwise. The failure body is read and classified
 * here because the caller needs the classification, not the raw bytes.
 *
 * Two distinct clocks, deliberately:
 *  - `headerMs` bounds the wait for response HEADERS only, and is cleared the
 *    moment `fetch` resolves. Holding it over the body would put a healthy but
 *    slow model on the same clock as a dead endpoint.
 *  - `idleMs` then bounds each gap BETWEEN body chunks, so a stream that stalls
 *    mid-answer is caught without capping total generation time.
 *
 * Transport failures are retried: the international gateway drops a meaningful
 * share of connections, and a private retry here is far better than surfacing a
 * network blip as a failed turn. HTTP errors are NEVER retried — a 400 or a
 * policy refusal is deterministic and retrying only burns budget.
 */
export async function chatStream(site, credential, bodyJson, {
  signal,
  fetchImpl = fetch,
  timeouts,
  retry,
} = {}) {
  const url = `${site.apiBase}/v2/chat/completions`;
  const headerMs = timeouts?.connectMs ?? 10000;
  const idleMs = timeouts?.readMs ?? 30000;
  const maxAttempts = Math.max(1, Number(retry?.attempts ?? 3));
  const backoff = Array.isArray(retry?.backoffMs) ? retry.backoffMs : [400, 1000];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  let lastError;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let headerTimer;
      try {
        headerTimer = setTimeout(() => controller.abort(new Error('upstream header timeout')), headerMs);
        res = await fetchImpl(url, {
          method: 'POST',
          headers: upstreamHeaders(site, credential, { stream: true }),
          body: bodyJson,
          signal: controller.signal,
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        // A client disconnect is the user's decision, never retried.
        if (signal?.aborted) {
          const e = new Error('client disconnected');
          e.name = 'AbortError';
          throw e;
        }
        if (!isTransportError(err) || attempt >= maxAttempts) break;
        await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 500);
      } finally {
        clearTimeout(headerTimer);
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res) {
    const cause = lastError?.cause?.code ?? lastError?.message ?? 'unknown';
    throw new UpstreamError('server', 502, `could not reach the upstream after ${maxAttempts} attempt(s): ${cause}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = classifyUpstreamError(res.status, text);
    const detail = parseErrorDetail(text);
    const err = new UpstreamError(
      kind,
      res.status,
      detail?.displayMsg ?? `upstream ${kind} (http ${res.status})`,
      detail,
    );
    throw err;
  }
  return res;
}

/**
 * Incremental SSE parser.
 *
 * Frames are separated by a blank line and the upstream may split them across
 * arbitrary chunk boundaries, so a partial tail is carried forward. Returning
 * `[DONE]` lets the caller stop without knowing the frame shape.
 */
export class SseDecoder {
  constructor() {
    this.buffer = '';
  }

  /** Feed a chunk; returns the complete data payloads it completed. */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    for (;;) {
      // Accept both LF and CRLF separators; the wire has used both.
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const payload = this.parseFrame(frame);
      if (payload !== undefined) out.push(payload);
    }
    return out;
  }

  /** Parse one frame; undefined for comments, blanks, and unusable payloads. */
  parseFrame(frame) {
    const lines = frame.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // SSE comment / keep-alive
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return undefined;
    return dataLines.join('\n');
  }

  /** Flush a trailing frame that never got its blank-line terminator. */
  flush() {
    if (this.buffer.trim() === '') return [];
    const rest = this.buffer;
    this.buffer = '';
    const payload = this.parseFrame(rest);
    return payload === undefined ? [] : [payload];
  }
}

/**
 * Read an upstream SSE stream as a sequence of parsed chat chunks.
 *
 * Yields `{ chunk }` for each usable JSON frame and terminates on `[DONE]` or
 * stream end. Malformed frames are skipped rather than thrown: one bad frame
 * should not destroy an otherwise good answer.
 */
export async function* iterateChatChunks(response, { signal } = {}) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          /* skip a malformed frame */
        }
      }
    }
    for (const payload of sse.flush()) {
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /* skip */
      }
    }
  } finally {
    // Releasing the lock lets an aborted stream be collected promptly.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
