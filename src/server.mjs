/**
 * Routing, request guards, and rate limiting.
 *
 * The endpoint is bound to loopback, but loopback is NOT a trust boundary: any
 * page in the user's browser can reach 127.0.0.1, and a DNS-rebinding page can
 * reach it under its own hostname. The guards below exist for exactly those
 * cases, and they are applied before routing so an unauthorised flood is rejected
 * cheaply rather than after the work has been done.
 *
 * @module workbuddy-api/server
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { SITES } from './config.mjs';
import { credentialStatus } from './auth.mjs';
import { toOpenAIModels } from './models.mjs';
import { errorHint } from './upstream.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Strip the optional :port from a Host header, IPv6-bracket aware. */
export function hostnameOfHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}

/** The Host header must name the loopback interface (defeats DNS rebinding). */
export function hostIsLoopback(host) {
  if (host === undefined || String(host).trim() === '') return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

/** A browser-sent Origin must be loopback; absent Origin (non-browser) passes. */
export function originIsLoopback(origin) {
  if (origin === undefined || String(origin).trim() === '') return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Constant-time API-key comparison, so a key cannot be probed byte by byte. */
export function apiKeyMatches(presented, expected) {
  const keys = Array.isArray(expected) ? expected : [expected];
  const valid = keys.filter((k) => typeof k === 'string' && k !== '');
  if (valid.length === 0) return true; // no key configured = open (loopback only)
  const a = Buffer.from(String(presented ?? ''));
  return valid.some((k) => {
    const b = Buffer.from(k);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Extract the presented API key from either accepted header. */
export function presentedKey(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x : undefined;
}

/**
 * Sliding-window rate limiter.
 *
 * Deliberately bounded: the key map is swept lazily and capped, because an
 * unbounded per-IP map is itself a denial-of-service vector (CWE-770). No timers
 * are used — a stray interval keeps the process alive and delays shutdown.
 */
export class RateLimiter {
  constructor({ windowMs = 10000, max = 600, maxKeys = 10000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /** Record a hit; returns the retry-after seconds when limited, else 0. */
  hit(key, now = Date.now()) {
    // Enforce the bound BEFORE inserting. Two distinct concerns: `sweep` drops
    // entries whose window has passed, but a burst of fresh keys within one
    // window leaves every entry live, so expiry alone cannot bound the map.
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      this.sweep(now);
      // Still full: evict oldest-inserted keys until there is room. Map preserves
      // insertion order, so iterating gives a deterministic LRU-ish victim and
      // the map can never grow past maxKeys.
      if (this.hits.size >= this.maxKeys) {
        const excess = this.hits.size - this.maxKeys + 1;
        let removed = 0;
        for (const k of this.hits.keys()) {
          this.hits.delete(k);
          removed += 1;
          if (removed >= excess) break;
        }
      }
    }
    let entry = this.hits.get(key);
    if (!entry) {
      entry = [];
      this.hits.set(key, entry);
    }
    const cutoff = now - this.windowMs;
    while (entry.length > 0 && entry[0] <= cutoff) entry.shift();
    if (entry.length >= this.max) {
      return Math.max(1, Math.ceil((entry[0] + this.windowMs - now) / 1000));
    }
    entry.push(now);
    return 0;
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.hits) {
      while (entry.length > 0 && entry[0] <= cutoff) entry.shift();
      if (entry.length === 0) this.hits.delete(key);
    }
  }
}

/* ------------------------------------------------------------ responses -- */

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** An error in the shape the calling protocol expects. */
export function sendError(res, status, message, { kind = 'error', code, protocol = 'openai' } = {}) {
  if (protocol === 'anthropic') {
    sendJson(res, status, { type: 'error', error: { type: kind, message } });
    return;
  }
  sendJson(res, status, { error: { message, type: kind, code: code ?? kind } });
}

/* --------------------------------------------------------------- server -- */

/**
 * Start the HTTP server.
 *
 * `deps` carries the collaborating pieces (catalog, credential resolution, chat
 * dispatch, config) so the server owns transport and policy only, and the route
 * handlers can be exercised without a live upstream.
 */
export function createApiServer({ config, catalog, resolveCredential, chat, log = console }) {
  const limiter = new RateLimiter(config.rateLimit);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error?.('[server] unhandled error:', err);
      if (!res.headersSent) sendError(res, 500, `internal error: ${err.message}`);
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // --- guards, before any routing or work ---------------------------------
    if (!hostIsLoopback(req.headers.host)) {
      sendError(res, 403, 'Host header must name the loopback interface', { kind: 'host_not_allowed' });
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      sendError(res, 403, 'Origin must be a loopback origin', { kind: 'origin_not_allowed' });
      return;
    }

    // /health is intentionally open so a supervisor can probe it without a key.
    if (path === '/health' || path === '/healthz') {
      return handleHealth(req, res);
    }

    if (config.rateLimit.enabled) {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const retryAfter = limiter.hit(ip);
      if (retryAfter > 0) {
        sendJson(res, 429, { error: { message: 'too many requests', type: 'rate_limited' } }, {
          'Retry-After': String(retryAfter),
        });
        return;
      }
    }

    if (!apiKeyMatches(presentedKey(req), config.apiKey)) {
      sendError(res, 401, 'missing or invalid API key', { kind: 'unauthorized' });
      return;
    }

    // --- routes -------------------------------------------------------------
    // A base URL may be configured with or without `/v1`, and clients append
    // paths inconsistently, so both spellings are accepted.
    const v1 = path.startsWith('/v1/') ? path.slice(3) : path;

    if (req.method === 'GET' && (v1 === '/models' || v1 === '/models/')) {
      return handleModels(req, res, url);
    }
    if (req.method === 'GET' && v1 === '/status') {
      return handleStatus(res);
    }
    if (req.method === 'POST' && v1 === '/chat/completions') {
      return chat.openai(req, res);
    }
    if (req.method === 'POST' && v1 === '/messages') {
      return chat.anthropic(req, res);
    }
    if (req.method === 'POST' && v1 === '/responses') {
      return chat.responses(req, res);
    }
    sendError(res, 404, `no such route: ${req.method} ${path}`, { kind: 'not_found' });
  }

  function handleHealth(req, res) {
    const sites = Object.keys(SITES).map((id) => credentialStatus(id));
    sendJson(res, 200, {
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      sites: sites.map((s) => ({ site: s.siteId, signed_in: s.signedIn, expired: s.expired ?? false })),
    });
  }

  async function handleStatus(res) {
    const sites = [];
    for (const id of Object.keys(SITES)) {
      const st = credentialStatus(id);
      const cached = catalog.peek(id);
      sites.push({
        site: id,
        label: SITES[id].label,
        signed_in: st.signedIn,
        uid: st.uid,
        nickname: st.nickname,
        expired: st.expired ?? false,
        models: cached?.models.length ?? 0,
        models_source: cached?.source,
      });
    }
    sendJson(res, 200, {
      default_site: config.defaultSite,
      sites,
    });
  }

  async function handleModels(req, res, url) {
    // Serve every signed-in site's roster, tagged with its site, so a client can
    // pick a model without knowing which region serves it.
    const seen = new Map();
    const errors = [];
    for (const id of Object.keys(SITES)) {
      const st = credentialStatus(id);
      if (!st.signedIn) continue;
      try {
        const cred = await resolveCredential(id);
        const roster = await catalog.get(SITES[id], cred, {
          force: url.searchParams.get('refresh') === '1',
        });
        for (const m of roster.models) {
          if (!seen.has(m.id)) seen.set(m.id, { ...m, site: id });
        }
      } catch (err) {
        errors.push({ site: id, error: err.message });
      }
    }
    const data = toOpenAIModels([...seen.values()]).map((m) => ({
      ...m,
      site: seen.get(m.id).site,
    }));
    sendJson(res, 200, { object: 'list', data, ...(errors.length > 0 ? { errors } : {}) });
  }

  return {
    server,
    /** Resolves once listening; rejects on a bind failure. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          resolve({ host: config.host, port: server.address().port });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

export { errorHint };
