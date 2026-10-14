/**
 * Model catalog: fetch from upstream, parse, cache, and fall back.
 *
 * Both regions read `/v3/config` — the document the WorkBuddy client itself
 * consumes — so this service's roster and the app's agree. The response wraps the
 * roster under `data.models`, a LIST whose entries carry the fields parsed below.
 *
 * The parser is deliberately tolerant. On live data (checked against
 * `www.workbuddy.ai`, 2026-10-12) the entries are flat objects with `id`, `name`,
 * `maxInputTokens`, `maxOutputTokens`, `credits`, `supportsImages`,
 * `supportsToolCall`, `reasoning`, and friends — but several spellings and
 * optional fields vary by model and by site, so every read is defensive and an
 * entry without usable token limits is dropped rather than guessed at.
 *
 * @module workbuddy-api/models
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { modelsCacheFile } from './config.mjs';

/** Parse the upstream `credits` string (`"x0.79 credits"`, `"x0.00"`) into a number. */
export function parseCreditMultiplier(value) {
  if (typeof value !== 'string') return undefined;
  const m = /x\s*([0-9]*\.?[0-9]+)/i.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether an entry is free (an explicit zero multiplier, or no rate declared). */
export function isFreeModel(credits) {
  const mult = parseCreditMultiplier(credits);
  return mult === 0;
}

/**
 * Normalize the upstream `reasoning` declaration.
 *
 * Live data uses the SINGULAR form `{effort, summary}` as well as a plural
 * `supportedEfforts` array; both are folded into one shape so callers do not have
 * to know which site answered.
 */
export function parseReasoning(entry) {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const r = entry.reasoning;
  const supported = [];
  if (Array.isArray(r?.supportedEfforts)) {
    for (const e of r.supportedEfforts) if (typeof e === 'string' && e !== '') supported.push(e);
  }
  const single = r?.effort;
  if (typeof single === 'string' && single !== '' && !supported.includes(single)) supported.push(single);
  const defaultEffort = typeof r?.defaultEffort === 'string'
    ? r.defaultEffort
    : (typeof single === 'string' ? single : undefined);
  const canDisableThinking = entry.canDisableThinking === true;
  if (supported.length === 0 && defaultEffort === undefined && !canDisableThinking) return undefined;
  return {
    supportedEfforts: supported.length > 0 ? supported : undefined,
    defaultEffort,
    canDisableThinking,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Parse one catalog entry. Returns undefined when the entry has no id or no
 * usable token limits — a model the service cannot describe is worse than an
 * absent one, because it would be offered and then fail.
 */
export function parseUpstreamModel(entry) {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id === '') return undefined;

  const maxInput = num(entry.maxInputTokens) ?? num(entry.maxAllowedSize) ?? num(entry.contextWindow);
  const maxOutput = num(entry.maxOutputTokens) ?? num(entry.maxTokens);
  if (maxInput === undefined && maxOutput === undefined) return undefined;

  const contextWindow = num(entry.contextWindow) ?? num(entry.maxAllowedSize) ?? maxInput;
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id,
    contextWindow: contextWindow ?? maxInput ?? 0,
    maxInputTokens: maxInput ?? 0,
    maxTokens: maxOutput ?? 0,
    creditMultiplier: parseCreditMultiplier(entry.credits),
    credits: typeof entry.credits === 'string' ? entry.credits : '',
    free: isFreeModel(entry.credits),
    supportsImages: entry.supportsImages === true && entry.disabledMultimodal !== true,
    supportsToolCall: entry.supportsToolCall !== false,
    isDefault: entry.isDefault === true,
    reasoning: parseReasoning(entry),
    descriptionZh: typeof entry.descriptionZh === 'string' ? entry.descriptionZh : undefined,
    descriptionEn: typeof entry.descriptionEn === 'string' ? entry.descriptionEn : undefined,
  };
}

/** Extract the roster array from a `/v3/config` (or legacy) envelope. */
export function extractModelEntries(document) {
  if (typeof document !== 'object' || document === null) return [];
  const data = typeof document.data === 'object' && document.data !== null ? document.data : document;
  const models = data.models;
  if (Array.isArray(models)) return models;
  // A keyed object form has been observed too; accept it rather than failing.
  if (typeof models === 'object' && models !== null) return Object.values(models);
  return [];
}

/** Parse a full `/v3/config` document into a model list. */
export function parseCatalogDocument(document) {
  const out = [];
  for (const entry of extractModelEntries(document)) {
    const parsed = parseUpstreamModel(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Fetch the roster for one site.
 *
 * `/v3/config` is preferred. The CN site falls back to the legacy
 * `/v2/enterprises/personal/models` when `/v3` fails or yields nothing, because a
 * gateway that stops serving the modern document should degrade to a working
 * roster rather than an empty region. The fallback result is tagged so callers
 * can tell the two apart.
 */
export async function fetchCatalog(site, credential, { fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': site.ua,
  };
  if (credential?.accessToken) headers.Authorization = `Bearer ${credential.accessToken}`;
  if (credential?.domain) headers['X-Domain'] = credential.domain;

  const attempts = [`${site.apiBase}/v3/config`];
  if (site.id === 'cn-cli') attempts.push(`${site.apiBase}/v2/enterprises/personal/models`);

  let lastError;
  for (const url of attempts) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        lastError = new Error(`http ${res.status}`);
        continue;
      }
      const doc = await res.json();
      const models = parseCatalogDocument(doc);
      if (models.length > 0) {
        return {
          models,
          source: url.endsWith('/v3/config') ? 'upstream' : 'legacy',
          fetchedAtMs: Date.now(),
        };
      }
      lastError = new Error('upstream returned no usable models');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`could not fetch the model catalog for ${site.id}: ${lastError?.message}`);
}

/* ------------------------------------------------------------------ cache -- */

/** Snapshot cache so a cold start survives an unreachable upstream. */
export function readCache() {
  const file = modelsCacheFile();
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return typeof doc === 'object' && doc !== null ? doc : undefined;
  } catch {
    return undefined;
  }
}

export function writeCache(cache) {
  const file = modelsCacheFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Catalog accessor with a memory cache and a disk snapshot fallback.
 *
 * Freshness is decided lazily on read (not by a timer): a request arriving after
 * the TTL re-fetches, and one arriving before it is served from memory. A failed
 * fetch falls back to the previous live answer — memory first, then the on-disk
 * snapshot — so a restart during an upstream outage still serves a real roster.
 */
export class Catalog {
  constructor({ ttlMs = 3600 * 1000, fetchImpl = fetch } = {}) {
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.memory = new Map(); // siteId -> {models, source, fetchedAtMs}
    this.inflight = new Map();
  }

  /** Last known roster for a site, without any network access. */
  peek(siteId) {
    const mem = this.memory.get(siteId);
    if (mem) return mem;
    const disk = readCache()?.[siteId];
    if (disk && Array.isArray(disk.models)) {
      this.memory.set(siteId, disk);
      return disk;
    }
    return undefined;
  }

  /**
   * The roster for a site, refreshing when stale.
   *
   * Concurrent callers share one in-flight fetch, so a burst of requests after
   * the TTL expires does not fan out into a burst of upstream calls.
   */
  async get(site, credential, { force = false } = {}) {
    const cached = this.memory.get(site.id);
    const fresh = cached && !force && Date.now() - cached.fetchedAtMs < this.ttlMs;
    if (fresh) return { ...cached, stale: false, source: 'cache' };

    let inflight = this.inflight.get(site.id);
    if (!inflight) {
      inflight = fetchCatalog(site, credential, { fetchImpl: this.fetchImpl })
        .then((result) => {
          this.memory.set(site.id, result);
          try {
            writeCache({ ...(readCache() ?? {}), [site.id]: result });
          } catch {
            /* a cache write failure must never fail a request */
          }
          return { ...result, stale: false };
        })
        .finally(() => this.inflight.delete(site.id));
      this.inflight.set(site.id, inflight);
    }

    try {
      return await inflight;
    } catch (err) {
      const fallback = this.peek(site.id);
      if (fallback) return { ...fallback, stale: true, source: 'stale', error: err.message };
      throw err;
    }
  }
}

/** Build an OpenAI-style `/v1/models` payload from a roster. */
export function toOpenAIModels(models) {
  return models.map((m) => ({
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    ...(m.creditMultiplier === undefined ? {} : { credits_multiplier: m.creditMultiplier }),
    ...(m.credits === '' ? {} : { credits: m.credits }),
  }));
}
