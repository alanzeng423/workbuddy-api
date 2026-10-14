/**
 * Site table + configuration loading.
 *
 * WorkBuddy (CN, copilot.tencent.com), CodeBuddy international (codebuddy.ai) and
 * WorkBuddy AI international (workbuddy.ai) speak the SAME wire protocol. They
 * differ only in hostname, client identity headers, and which OAuth realm issues
 * the token. That is why one table drives all three, and why a single service can
 * proxy all of them at once.
 *
 * Quota is NOT shared between regions: CN and international are separate account
 * systems with separate balances. The table records that per site so routing can
 * prefer whichever site actually has the model.
 *
 * @module workbuddy-api/config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Upstream sites this service can talk to.
 *
 * `apiBase` is the chat/catalog host. `billingBase` answers the balance query,
 * which lives on a different host for the CN site (codebuddy.cn vs
 * copilot.tencent.com) — a real asymmetry, not an oversight.
 *
 * `ua` is the CLI identity the upstream keys its model catalog on: the catalog
 * service returns DIFFERENT rosters per client channel, so a wrong UA yields a
 * wrong (or empty) model list rather than an error.
 */
export const SITES = {
  'cn-cli': {
    id: 'cn-cli',
    label: '国内版 (CodeBuddy CLI)',
    region: 'cn',
    apiBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    // The CLI channel is the only CN channel whose roster carries the free models.
    ua: 'CLI/2.155.0 CodeBuddy/2.155.0',
    authFlow: 'device',
  },
  'intl-cli': {
    id: 'intl-cli',
    label: '国际版 (CodeBuddy CLI)',
    region: 'global',
    apiBase: 'https://www.codebuddy.ai',
    billingBase: 'https://www.codebuddy.ai',
    ua: 'CLI/2.155.0 CodeBuddy/2.155.0',
    authFlow: 'device',
  },
  'intl-work': {
    id: 'intl-work',
    label: '国际版 (WorkBuddy AI)',
    region: 'global',
    apiBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    // The desktop channel is the one that exposes the full international roster.
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy/5.5.2',
    authFlow: 'device',
  },
};

export const SITE_IDS = Object.freeze(Object.keys(SITES));

/** Map a credential's login domain onto a site id, or undefined when unknown. */
export function siteForDomain(domain) {
  const d = String(domain ?? '').toLowerCase().trim();
  if (d === '') return undefined;
  // Registrable-domain match so `www.workbuddy.ai` and a bare host both qualify,
  // while a lookalike such as `workbuddy.ai.evil.com` cannot.
  const matches = (host, suffix) => host === suffix || host.endsWith('.' + suffix);
  if (matches(d, 'workbuddy.ai')) return 'intl-work';
  if (matches(d, 'codebuddy.ai')) return 'intl-cli';
  if (matches(d, 'copilot.tencent.com') || matches(d, 'codebuddy.cn') || matches(d, 'tencent.com')) {
    return 'cn-cli';
  }
  return undefined;
}

/** Config directory: env override, else `~/.workbuddy-api`. */
export function configDir() {
  const override = process.env.WORKBUDDY_API_HOME;
  if (override && override.trim() !== '') return resolve(override.trim());
  return join(homedir(), '.workbuddy-api');
}

export function authFileFor(siteId) {
  return join(configDir(), `auth.${siteId}.json`);
}

export function modelsCacheFile() {
  return join(configDir(), 'models.cache.json');
}

export function configFile() {
  return join(configDir(), 'config.json');
}

/** Safe defaults; a missing config.json is normal and not an error. */
export function defaultConfig() {
  return {
    host: '127.0.0.1',
    port: 8788,
    apiKey: '',
    defaultSite: 'cn-cli',
    /**
     * Ask the upstream for a system message first. The international gateway
     * rejects a conversation that does not begin with one (400 `first message is
     * not system prompt`), so this is required there and harmless on CN.
     */
    ensureSystemMessage: true,
    defaultSystemPrompt: 'You are a helpful assistant.',
    /**
     * Strip client-identifying system-prompt fingerprints. The upstream refuses
     * requests whose system prompt it recognises as coming from an unapproved
     * channel (400 `Illegal API invocation from an unapproved channel`).
     */
    stripClientFingerprint: true,
    context: {
      enabled: true,
      reserveForOutput: 4096,
      minKeepMessages: 4,
      safetyRatio: 0.95,
    },
    rateLimit: {
      enabled: true,
      windowMs: 10000,
      max: 600,
    },
    timeouts: {
      /**
       * Bounds the wait for response HEADERS only. Cleared once fetch resolves,
       * so a slow-but-healthy model is not judged by the same clock as a dead
       * endpoint.
       */
      connectMs: 10000,
      /**
       * Bounds the gap BETWEEN body chunks, not total generation time.
       */
      readMs: 30000,
    },
    /**
     * Retry policy for TRANSPORT failures only.
     *
     * The international gateway was measured dropping a meaningful share of
     * connections, so a private retry here saves the turn. HTTP errors are never
     * retried: a 400 or a policy refusal is deterministic.
     */
    upstreamRetry: {
      attempts: 3,
      backoffMs: [400, 1000],
    },
  };
}

const CONFIG_WARNINGS = [];

/** Warnings raised by the last validateConfig call, for the startup banner. */
export function configWarnings() {
  return [...CONFIG_WARNINGS];
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Coerce a loaded config into the documented shape.
 *
 * Deliberately tolerant: a hand-edited config.json with a bad type degrades to
 * the default AND records a warning, rather than crashing the service or
 * silently ignoring the field. Silent ignoring is what makes a typo look like
 * "the setting does nothing".
 */
export function validateConfig(raw) {
  CONFIG_WARNINGS.length = 0;
  const base = defaultConfig();
  if (!isPlainObject(raw)) {
    CONFIG_WARNINGS.push('config.json is not a JSON object; using defaults');
    return base;
  }

  // DEEP-copy the nested groups. A shallow `{...base}` would alias
  // `context`/`rateLimit`/`timeouts`, so rejecting a bad value and restoring it
  // from `base` would restore the very value just written into that shared
  // object — the default would appear to be ignored.
  const out = {
    ...base,
    context: { ...base.context },
    rateLimit: { ...base.rateLimit },
    timeouts: { ...base.timeouts },
    upstreamRetry: { ...base.upstreamRetry, backoffMs: [...base.upstreamRetry.backoffMs] },
  };

  if (raw.host !== undefined) {
    if (typeof raw.host === 'string' && raw.host.trim() !== '') out.host = raw.host.trim();
    else CONFIG_WARNINGS.push('host must be a non-empty string; using default');
  }
  if (raw.port !== undefined) {
    const p = Number(raw.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) out.port = p;
    else CONFIG_WARNINGS.push('port must be an integer 1-65535; using default');
  }
  if (raw.apiKey !== undefined) {
    // A string or an array of strings is accepted; anything else is rejected.
    if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey;
    else if (Array.isArray(raw.apiKey) && raw.apiKey.every((k) => typeof k === 'string')) {
      out.apiKey = raw.apiKey.filter((k) => k !== '');
    } else CONFIG_WARNINGS.push('apiKey must be a string or an array of strings; using default');
  }
  if (raw.defaultSite !== undefined) {
    if (SITES[raw.defaultSite]) out.defaultSite = raw.defaultSite;
    else CONFIG_WARNINGS.push(`defaultSite "${raw.defaultSite}" is not a known site; using default`);
  }
  for (const key of ['ensureSystemMessage', 'stripClientFingerprint']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
      else CONFIG_WARNINGS.push(`${key} must be a boolean; using default`);
    }
  }
  if (raw.defaultSystemPrompt !== undefined) {
    if (typeof raw.defaultSystemPrompt === 'string') out.defaultSystemPrompt = raw.defaultSystemPrompt;
    else CONFIG_WARNINGS.push('defaultSystemPrompt must be a string; using default');
  }

  for (const group of ['context', 'rateLimit', 'timeouts', 'upstreamRetry']) {
    if (raw[group] === undefined) continue;
    if (!isPlainObject(raw[group])) {
      CONFIG_WARNINGS.push(`${group} must be an object; using defaults`);
      continue;
    }
    for (const [k, v] of Object.entries(raw[group])) {
      if (!(k in out[group])) continue;
      const want = typeof out[group][k];
      // `backoffMs` is the one array-valued setting; validate its elements.
      if (want === 'object' && Array.isArray(out[group][k])) {
        if (Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
          out[group][k] = [...v];
        } else {
          CONFIG_WARNINGS.push(`${group}.${k} must be an array of non-negative numbers; using default`);
        }
        continue;
      }
      if (typeof v !== want) {
        CONFIG_WARNINGS.push(`${group}.${k} must be a ${want}; using default`);
        continue;
      }
      // A number that is negative (or NaN) satisfies the type check but breaks
      // the behaviour it configures, so positivity is validated too. Without this
      // `minKeepMessages: -3` would be accepted and then produce a nonsensical
      // keep-count at runtime.
      if (want === 'number' && !(Number.isFinite(v) && v >= 0)) {
        CONFIG_WARNINGS.push(`${group}.${k} must be a non-negative finite number; using default`);
        continue;
      }
      out[group][k] = v;
    }
  }
  // Normalize the two limit fields that must stay positive integers.
  if (!(Number.isFinite(out.context.minKeepMessages) && out.context.minKeepMessages >= 0)) {
    out.context.minKeepMessages = base.context.minKeepMessages;
    CONFIG_WARNINGS.push('context.minKeepMessages must be >= 0; using default');
  }
  if (!(Number.isFinite(out.rateLimit.max) && out.rateLimit.max > 0)) {
    out.rateLimit.max = base.rateLimit.max;
    CONFIG_WARNINGS.push('rateLimit.max must be > 0; using default');
  }
  return out;
}

/** Load config.json, creating a default one (with a generated key) when absent. */
export function loadConfig({ createIfMissing = true } = {}) {
  const file = configFile();
  if (!existsSync(file)) {
    if (!createIfMissing) return validateConfig(null);
    const cfg = defaultConfig();
    cfg.apiKey = 'sk-wb-' + randomBytes(16).toString('hex');
    saveConfig(cfg);
    return cfg;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    CONFIG_WARNINGS.length = 0;
    CONFIG_WARNINGS.push(`config.json is not valid JSON (${err.message}); using defaults`);
    return defaultConfig();
  }
  return validateConfig(parsed);
}

export function saveConfig(cfg) {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  // Atomic write: a crash mid-write must not leave an unparseable config behind.
  // rename() replaces on both POSIX and Windows (libuv uses MoveFileEx), so the
  // reader never observes a partial file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}
