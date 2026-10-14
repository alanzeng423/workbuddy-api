/**
 * Context fitting: keep requests inside the model's real input limit.
 *
 * The upstream enforces an input ceiling, and exceeding it is a hard 400 that the
 * user sees as a broken agent. Two measured facts shape this module:
 *
 *  1. **The catalog's limit is not the real limit.** It over-reports (a model
 *     listed at 200 000 was measured refusing well below that), so a learned value
 *     from an actual rejection must outrank the catalog.
 *  2. **Tool definitions consume the same budget as messages** but cannot be
 *     trimmed the way messages can, so their share has to be reserved up front.
 *     Compressing messages alone does nothing when tools are the bulk of the
 *     request — which is exactly the agent case that needs this most.
 *
 * Token counts here are ESTIMATES. A CJK-aware weighting is used because a
 * character-count heuristic calibrated on English under-estimates Chinese by
 * roughly 1.7x, and an under-estimate means "fits" is wrong.
 *
 * @module workbuddy-api/compress
 */

/** A tool call and its result must be dropped together, never split. */
function hasToolCall(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}
function isToolResult(message) {
  return String(message?.role ?? '').toLowerCase() === 'tool';
}

/**
 * Estimate the token cost of arbitrary JSON-able content.
 *
 * Weights are per-character and deliberately approximate: CJK is far denser than
 * Latin, so a single ratio cannot serve both. The numbers are calibrated to be
 * slightly PESSIMISTIC (over-estimate), because under-estimating means a request
 * is judged to fit, is sent, and is rejected.
 */
export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  let cjk = 0;
  let digits = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) // CJK unified ideographs
      || (code >= 0x3040 && code <= 0x30ff) // kana
      || (code >= 0xac00 && code <= 0xd7af) // hangul
      || (code >= 0x3400 && code <= 0x4dbf) // CJK extension A
    ) cjk += 1;
    else if (code >= 0x30 && code <= 0x39) digits += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.6 + digits * 0.3 + other * 0.26);
}

/** Estimated token cost of a message list. */
export function estimateMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, m) => sum + estimateTokens(m) + 4, 0);
}

/**
 * Estimated cost of the parts of a body that are NOT messages.
 *
 * Separated out because these cannot be trimmed by dropping messages, so they
 * must be subtracted from the budget before messages are fitted. Ignoring them
 * produces the reported failure mode where compression appears to work, the
 * request is still rejected, and every retry shrinks messages that were never the
 * problem.
 */
export function estimateSideTokens(body) {
  const parts = [];
  if (Array.isArray(body?.tools) && body.tools.length > 0) parts.push(body.tools);
  if (Array.isArray(body?.functions) && body.functions.length > 0) parts.push(body.functions);
  if (body?.tool_choice !== undefined) parts.push(body.tool_choice);
  return parts.length > 0 ? estimateTokens(parts) : 0;
}

/** Truncate one over-long string, keeping its head and tail. */
function truncateString(text, budgetTokens) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (estimateTokens(text) <= budgetTokens) return text;
  // Head and tail are both kept: a log or file dump usually carries the useful
  // signal at its start and its conclusion.
  const keepChars = Math.max(200, Math.floor(budgetTokens * 3));
  const head = Math.floor(keepChars * 0.7);
  const tail = keepChars - head;
  return `${text.slice(0, head)}\n\n…[已截断 ${text.length - keepChars} 字符]…\n\n${text.slice(-tail)}`;
}

/** Truncate one message's content in place, preserving its shape. */
function truncateMessage(message, budgetTokens) {
  const clone = { ...message };
  if (typeof clone.content === 'string') {
    clone.content = truncateString(clone.content, budgetTokens);
  } else if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((part) => {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return { ...part, text: truncateString(part.text, Math.max(64, Math.floor(budgetTokens / Math.max(1, clone.content.length)))) };
      }
      return part;
    });
  }
  return clone;
}

/**
 * Fit a message list into `maxInputTokens`.
 *
 * Rules, in order:
 *  - the system message is always kept (dropping it changes model behaviour)
 *  - the newest messages are kept; oldest are dropped first
 *  - at least `minKeepMessages` recent messages survive
 *  - a tool call and its result travel together
 *  - a single message that alone exceeds the budget is truncated, not dropped
 *
 * Returns the fitted list plus stats describing what happened.
 */
export function fitMessages(messages, {
  maxInputTokens,
  reserveForOutput = 4096,
  minKeepMessages = 4,
  safetyRatio = 0.95,
} = {}) {
  const stats = { applied: false, dropped: 0, truncated: 0, before: 0, after: 0, limit: maxInputTokens };
  if (!Array.isArray(messages) || messages.length === 0) return { messages, stats };

  stats.before = estimateMessages(messages);
  const budget = Math.floor((maxInputTokens - reserveForOutput) * safetyRatio);
  if (!Number.isFinite(budget) || budget <= 0) return { messages, stats };
  if (stats.before <= budget) {
    stats.after = stats.before;
    return { messages, stats };
  }

  const system = messages[0] && String(messages[0].role ?? '').toLowerCase() === 'system'
    ? [messages[0]]
    : [];
  const rest = messages.slice(system.length);

  // Walk from the newest backwards, accumulating until the budget is reached.
  const kept = [];
  let used = estimateMessages(system);
  // `rest.length - minKeepMessages` is the earliest index we may cut down to.
  const protectedFrom = Math.max(0, rest.length - Math.max(0, minKeepMessages));

  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const message = rest[i];
    const cost = estimateTokens(message) + 4;
    const mustKeep = i >= protectedFrom;

    if (used + cost <= budget) {
      kept.unshift(message);
      used += cost;
      continue;
    }
    if (mustKeep) {
      // Cannot drop it, so shrink it to whatever room is left.
      const room = Math.max(64, budget - used);
      const shrunk = truncateMessage(message, room);
      kept.unshift(shrunk);
      used += estimateTokens(shrunk) + 4;
      stats.truncated += 1;
      continue;
    }
    // Droppable. A tool result must not outlive its call, and vice versa, so
    // drop the pair together — a lone half is rejected by the upstream with a
    // missing tool_call_id error.
    stats.dropped += 1;
    if (isToolResult(message)) {
      const prev = rest[i - 1];
      if (prev && hasToolCall(prev)) {
        stats.dropped += 1;
        i -= 1;
      }
    } else if (hasToolCall(message)) {
      const next = rest[i + 1];
      if (next && isToolResult(next) && i + 1 < protectedFrom) {
        stats.dropped += 1;
      }
    }
  }

  const fitted = [...system, ...kept];
  stats.after = estimateMessages(fitted);
  stats.applied = stats.dropped > 0 || stats.truncated > 0;
  return { messages: fitted, stats };
}

/**
 * Learned real input limits, per site+model.
 *
 * The catalog over-reports, so a limit proven by an actual rejection must win.
 * Kept in memory only: it is a property of the upstream's current deployment, not
 * of the user's configuration, and a restart should re-learn rather than trust a
 * stale number forever.
 */
const learnedLimits = new Map();
const CALIBRATION = new Map();

const keyOf = (site, model) => `${site ?? ''}\u0000${model ?? ''}`;

export function learnedLimit(site, model) {
  return learnedLimits.get(keyOf(site, model)) ?? null;
}

export function rememberLimit(site, model, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const key = keyOf(site, model);
  const existing = learnedLimits.get(key);
  // Only ever tighten: a smaller proven limit is strictly more informative.
  if (existing === undefined || limit < existing) learnedLimits.set(key, Math.floor(limit));
}

/**
 * How much the local estimator under-counts for this model.
 *
 * Long mixed text is under-estimated, so "estimated <= limit" does not imply
 * "actual <= limit". Calibrating against a real reported token count lets the
 * budget be scaled so the two agree.
 */
export function calibrationFactor(site, model) {
  return CALIBRATION.get(keyOf(site, model)) ?? 1;
}

export function calibrateEstimate(site, model, actualTokens, estimatedTokens) {
  if (!Number.isFinite(actualTokens) || !Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return;
  const ratio = actualTokens / estimatedTokens;
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const key = keyOf(site, model);
  // Seed from the NEUTRAL factor 1, not from the raw sample. Seeding with the
  // sample itself would let one observation set the budget outright, and a single
  // rejection is a noisy estimate of the true ratio — the first sample is exactly
  // the one most likely to be unrepresentative.
  const previous = CALIBRATION.get(key) ?? 1;
  CALIBRATION.set(key, previous * 0.5 + ratio * 0.5);
}

/** Whether an upstream failure is an input-too-long rejection. */
export function isTooLongError(status, bodyText) {
  if (status !== 400) return false;
  return /too long|too many tokens|maximum context|context length|exceed.*(token|context|limit)|prompt is too long/i.test(String(bodyText ?? ''));
}

/**
 * Pull the real input limit out of an upstream error message.
 *
 * The number is treated as a HINT, not a fact: the message's own figure was
 * measured contradicting itself (reporting a 100 000 limit on a model that
 * accepted 180 030 tokens), so callers shrink relative to the current size rather
 * than jumping to this value.
 */
export function parseLimitFromError(bodyText) {
  const text = String(bodyText ?? '');
  // `>` arrives JSON-escaped as `\u003e`, so a literal-`>` match silently fails.
  const decoded = text.replace(/\\u003e/gi, '>').replace(/\\u003c/gi, '<');
  const m = /(\d{2,})\s*tokens?\s*>\s*(\d{2,})\s*(?:maximum|max|limit)/i.exec(decoded)
    ?? /(?:maximum|limit)\D{0,20}(\d{2,})/i.exec(decoded);
  if (!m) return null;
  const value = Number(m[2] ?? m[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
