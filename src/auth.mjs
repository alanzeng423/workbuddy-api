/**
 * Credential storage, OAuth device login, and token refresh.
 *
 * This service logs in INDEPENDENTLY (official device-authorization flow), so it
 * can be handed to other users without requiring DSH, the WorkBuddy desktop app,
 * or any pre-existing sign-in. That is the whole reason this module exists
 * instead of reusing a desktop credential file.
 *
 * Two rules shape everything here:
 *
 *  1. Tokens live in their own per-site file with mode 0600. A credential is
 *     equivalent to the account, so it is never logged, never echoed, and never
 *     returned to a client.
 *  2. Refresh is SINGLE-FLIGHT per site. OAuth refresh tokens are frequently
 *     rotated; two concurrent refreshes with the same token can invalidate each
 *     other, leaving a site permanently unusable until re-login. Concurrent
 *     callers therefore share one in-flight refresh rather than racing.
 *
 * @module workbuddy-api/auth
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { authFileFor, configDir, SITES } from './config.mjs';

/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class CredentialError extends Error {
  constructor(message, { siteId, reason } = {}) {
    super(message);
    this.name = 'CredentialError';
    this.siteId = siteId;
    this.reason = reason;
  }
}

/**
 * Normalize the several spellings an upstream uses for the same field.
 * The three sites are protocol-isomorphic but not spelling-identical, and a
 * missed alias shows up as "signed out" while the token is perfectly valid.
 */
function firstString(source, keys) {
  if (typeof source !== 'object' || source === null) return '';
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/** The envelope's `data` object; anything else is treated as an empty one. */
function envelopeData(document) {
  if (typeof document !== 'object' || document === null) return {};
  const d = document.data;
  return typeof d === 'object' && d !== null && !Array.isArray(d) ? d : {};
}

/** Epoch-ms expiry from either an absolute stamp or a relative TTL. */
function expiryMs(source, absKeys, relKeys) {
  for (const key of absKeys) {
    const v = Number(source?.[key]);
    // Heuristic: a value below this is seconds, above it is milliseconds.
    if (Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  for (const key of relKeys) {
    const v = Number(source?.[key]);
    if (Number.isFinite(v) && v > 0) return Date.now() + Math.round(v * 1000);
  }
  return undefined;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/** Write a credential file atomically with owner-only permissions. */
function writeCredential(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** A credential as persisted. `expiresAtMs` is epoch ms. */
export function normalizeCredential(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;
  // Accept both the wrapped form written by this service and a flat blob.
  const auth = typeof raw.auth === 'object' && raw.auth !== null ? raw.auth : raw;
  const account = typeof raw.account === 'object' && raw.account !== null ? raw.account : {};
  const accessToken = firstString(auth, ['accessToken', 'access_token', 'AccessToken']);
  if (accessToken === '') return undefined;
  const refreshToken = firstString(auth, ['refreshToken', 'refresh_token', 'RefreshToken']);
  const domain = firstString(auth, ['domain', 'Domain']) || firstString(account, ['domain', 'Domain']);
  const expiresAtMs =
    expiryMs(auth, ['expiresAt', 'expires_at', 'ExpiresAt'], ['expiresIn', 'expires_in']) ?? 0;
  const refreshExpiresAtMs = expiryMs(
    auth,
    ['refreshExpiresAt', 'refresh_expires_at'],
    ['refreshExpiresIn', 'refresh_expires_in'],
  );
  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    refreshExpiresAtMs,
    domain,
    uid: firstString(account, ['uid', 'Uid', 'userId', 'UserID']),
    nickname: firstString(account, ['nickname', 'NickName', 'ScreenName']),
    uin: firstString(account, ['uin', 'Uin']),
    enterpriseId: firstString(account, ['enterpriseId', 'EnterpriseId']),
  };
}

/** Read a site's stored credential, or undefined when absent/unreadable. */
export function loadCredential(siteId) {
  return normalizeCredential(readJsonFile(authFileFor(siteId)));
}

export function saveCredential(siteId, cred) {
  writeCredential(authFileFor(siteId), {
    version: 1,
    siteId,
    savedAtMs: Date.now(),
    auth: {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAtMs ? Math.round(cred.expiresAtMs / 1000) : undefined,
      refreshExpiresAt: cred.refreshExpiresAtMs ? Math.round(cred.refreshExpiresAtMs / 1000) : undefined,
      domain: cred.domain || undefined,
    },
    account: {
      uid: cred.uid || undefined,
      nickname: cred.nickname || undefined,
      uin: cred.uin || undefined,
      enterpriseId: cred.enterpriseId || undefined,
    },
  });
}

export function clearCredential(siteId) {
  const file = authFileFor(siteId);
  for (const f of [file, `${file}.tmp`]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}

/** Whether a stored credential is inside the refresh margin (or already dead). */
export function needsRefresh(cred, now = Date.now()) {
  if (!cred) return false;
  if (!cred.expiresAtMs) return false; // Unknown expiry: trust it until a 401.
  return cred.expiresAtMs - now <= REFRESH_MARGIN_MS;
}

/** One shared in-flight refresh per site; see the module note. */
const refreshInflight = new Map();

/**
 * The credential to send upstream for `siteId`, refreshed on demand.
 *
 * A FAILED refresh still returns the existing token when it has not actually
 * expired yet: an unreachable refresh endpoint must not take down a session that
 * is still perfectly usable. Only a genuinely expired token turns into an error,
 * because at that point there is nothing left to try.
 */
export async function resolveCredential(siteId, { force = false } = {}) {
  const site = SITES[siteId];
  if (!site) throw new CredentialError(`unknown site "${siteId}"`, { siteId, reason: 'unknown-site' });

  const cred = loadCredential(siteId);
  if (!cred) {
    throw new CredentialError(
      `site "${siteId}" is not signed in; run: node login.mjs --site ${siteId}`,
      { siteId, reason: 'not-signed-in' },
    );
  }

  const wantRefresh = force || needsRefresh(cred);
  if (!wantRefresh) return cred;

  let inflight = refreshInflight.get(siteId);
  if (!inflight) {
    inflight = doRefresh(siteId, cred).finally(() => refreshInflight.delete(siteId));
    refreshInflight.set(siteId, inflight);
  }
  try {
    return await inflight;
  } catch (err) {
    if (cred.expiresAtMs && cred.expiresAtMs > Date.now()) return cred;
    throw err;
  }
}

/**
 * Perform one token refresh and persist the result.
 *
 * CRITICAL: the refresh token travels in the `X-Refresh-Token` HEADER, not in
 * the request body. Verified against the live gateway (2026-10-12): every body
 * spelling — `refreshToken`, `refresh_token`, nested `data`/`auth`, query params,
 * `Authorization: Bearer`, `Refresh-Token`, `X-RefreshToken` — returns
 * `10001:refreshToken is empty`, while the `X-Refresh-Token` header alone
 * succeeds. Changing this to a body field silently breaks all refreshes.
 *
 * The response ROTATES the refresh token, so the new one must be persisted;
 * dropping it makes the next refresh fail permanently. That rotation is also why
 * callers must go through `resolveCredential` (single-flight) rather than
 * refreshing concurrently.
 */
async function doRefresh(siteId, cred) {
  const site = SITES[siteId];
  if (!cred.refreshToken) {
    throw new CredentialError(`site "${siteId}" has no refresh token; sign in again`, {
      siteId,
      reason: 'no-refresh-token',
    });
  }
  const url = `${site.apiBase}/v2/plugin/auth/token/refresh`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': site.ua,
        'X-Refresh-Token': cred.refreshToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new CredentialError(`token refresh failed for "${siteId}": ${err.message}`, {
      siteId,
      reason: 'network',
    });
  }
  if (!res.ok) {
    throw new CredentialError(
      `token refresh rejected for "${siteId}" (http ${res.status}); sign in again if this persists`,
      { siteId, reason: 'rejected' },
    );
  }
  const doc = await res.json().catch(() => undefined);
  // The gateway answers 200 with a non-zero business code for some failures.
  if (typeof doc?.code === 'number' && doc.code !== 0) {
    throw new CredentialError(
      `token refresh rejected for "${siteId}" (code ${doc.code}: ${doc.msg ?? ''})`,
      { siteId, reason: 'rejected' },
    );
  }
  const data = envelopeData(doc);
  const merged = normalizeCredential({
    auth: {
      ...data,
      // The refresh answer carries no domain; keep the one we already had.
      domain: firstString(data, ['domain', 'Domain']) || cred.domain,
    },
    account: { uid: cred.uid, nickname: cred.nickname, uin: cred.uin, enterpriseId: cred.enterpriseId },
  });
  if (!merged) {
    throw new CredentialError(`token refresh for "${siteId}" returned no access token`, {
      siteId,
      reason: 'malformed',
    });
  }
  // The upstream rotates this; keep the old one only when it returned none.
  if (!merged.refreshToken) merged.refreshToken = cred.refreshToken;
  saveCredential(siteId, merged);
  return merged;
}

/** Token-free sign-in summary for `status`. */
export function credentialStatus(siteId) {
  const cred = loadCredential(siteId);
  if (!cred) return { siteId, signedIn: false };
  const now = Date.now();
  return {
    siteId,
    signedIn: true,
    uid: cred.uid,
    nickname: cred.nickname,
    domain: cred.domain,
    expiresAtMs: cred.expiresAtMs || undefined,
    expired: Boolean(cred.expiresAtMs && cred.expiresAtMs <= now),
  };
}

/** Ensure the config dir exists before the first write. */
export function ensureConfigDir() {
  mkdirSync(configDir(), { recursive: true });
}

export { REFRESH_MARGIN_MS };
