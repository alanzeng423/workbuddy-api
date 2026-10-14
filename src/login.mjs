/**
 * OAuth device-authorization login.
 *
 * Flow (verified against the live gateway, 2026-10-12):
 *
 *   1. POST /v2/plugin/auth/state?platform=cli  -> { state, authUrl }
 *   2. the user opens authUrl in a browser and approves
 *   3. GET  /v2/plugin/auth/token?state=<state> -> 11217 while pending, 0 + tokens when done
 *
 * `platform` MUST be a query parameter. Sent in the JSON body the gateway answers
 * `10001:platform is empty` — a trap that costs an hour if you assume a body works.
 *
 * This is a genuine independent login: it needs no DSH, no WorkBuddy desktop app,
 * and no pre-existing sign-in, which is what makes this service distributable.
 *
 * @module workbuddy-api/login
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SITES } from './config.mjs';
import {
  normalizeCredential,
  saveCredential,
  credentialStatus,
  clearCredential,
  ensureConfigDir,
} from './auth.mjs';

/** How long a login attempt stays valid before the user must start over. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Gap between polls. */
const POLL_INTERVAL_MS = 2000;

/** Open a URL in the platform's default browser, best effort. */
function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the gateway for a state + authorization URL. */
export async function requestLoginState(site, { fetchImpl = fetch } = {}) {
  const url = `${site.apiBase}/v2/plugin/auth/state?platform=cli`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': site.ua,
    },
    body: '{}',
    signal: AbortSignal.timeout(20000),
  });
  const doc = await res.json().catch(() => undefined);
  const data = doc?.data;
  if (!res.ok || typeof data?.state !== 'string' || typeof data?.authUrl !== 'string') {
    throw new Error(
      `could not start sign-in for ${site.id}: ${doc?.msg ?? `http ${res.status}`}`,
    );
  }
  return { state: data.state, authUrl: data.authUrl };
}

/**
 * Poll once for the token.
 *
 * Returns `{ pending: true }` while the user has not finished, so the caller owns
 * the wait loop and its timeout. A non-zero code other than the documented
 * `11217` is a real failure and is surfaced rather than retried forever.
 */
export async function pollLoginToken(site, state, { fetchImpl = fetch } = {}) {
  const url = `${site.apiBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': site.ua },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    // A transport blip mid-poll is not fatal; the login is still in flight.
    return { pending: true, transient: err.message };
  }
  const doc = await res.json().catch(() => undefined);
  if (!doc) return { pending: true, transient: `http ${res.status}` };

  const code = typeof doc.code === 'number' ? doc.code : -1;
  // 11217 is the documented "still waiting" answer.
  if (code === 11217) return { pending: true };
  if (code !== 0 && code !== 200) {
    return { pending: false, error: `${code}: ${doc.msg ?? 'unknown error'}` };
  }
  const cred = normalizeCredential({
    auth: doc.data ?? {},
    account: doc.data?.account ?? doc.data?.user ?? {},
  });
  if (!cred) return { pending: false, error: 'the gateway returned no access token' };
  return { pending: false, credential: cred };
}

/**
 * Sign a site in, printing instructions and polling until done.
 *
 * The polling timeout exists because a state left open forever is a small
 * resource leak on the gateway and a confusing hang for the user.
 */
export async function loginSite(siteId, { open = true, log = console.log } = {}) {
  const site = SITES[siteId];
  if (!site) throw new Error(`unknown site "${siteId}"`);
  ensureConfigDir();

  const { state, authUrl } = await requestLoginState(site);
  log('');
  log(`  站点：${site.label}  (${site.id})`);
  log(`  请在浏览器中打开下面的链接并完成授权：`);
  log('');
  log(`    ${authUrl}`);
  log('');
  if (open) {
    const ok = openBrowser(authUrl);
    log(ok ? '  （已尝试自动打开浏览器；若没有反应，请手动复制上面的链接）' : '  （未能自动打开浏览器，请手动复制上面的链接）');
  }
  log('  等待授权中…（最多 10 分钟，Ctrl+C 取消）');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await pollLoginToken(site, state);
    if (result.pending) continue;
    if (result.error) throw new Error(`sign-in failed for ${site.id}: ${result.error}`);
    saveCredential(siteId, result.credential);
    log('');
    log(`  ✅ 登录成功：${result.credential.nickname || result.credential.uid || site.id}`);
    return result.credential;
  }
  throw new Error('sign-in timed out; run the login command again');
}

/** Interactive site picker for the CLI. */
async function promptSite() {
  const ids = Object.keys(SITES);
  console.log('请选择要登录的站点：');
  ids.forEach((id, i) => console.log(`  ${i + 1}) ${SITES[id].label}  [${id}]`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`序号 (默认 1): `, resolve));
  rl.close();
  const n = Number(answer.trim() || '1');
  if (!Number.isInteger(n) || n < 1 || n > ids.length) throw new Error('无效的序号');
  return ids[n - 1];
}

/** CLI entry point. */
export async function runLogin(argv) {
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, v && !v.startsWith('--') ? 2 : 1);
    return v && !v.startsWith('--') ? v : true;
  };

  const noOpen = flag('--no-open') !== undefined;
  const listOnly = flag('--list') !== undefined;
  const logout = flag('--logout') !== undefined;
  let siteId = flag('--site');

  if (listOnly) {
    for (const id of Object.keys(SITES)) {
      const st = credentialStatus(id);
      console.log(
        st.signedIn
          ? `  ${id.padEnd(11)} 已登录  ${st.nickname || st.uid}${st.expired ? '  (token 已过期，将自动刷新)' : ''}`
          : `  ${id.padEnd(11)} 未登录`,
      );
    }
    return 0;
  }

  if (logout) {
    if (!siteId) siteId = await promptSite();
    if (!SITES[siteId]) throw new Error(`unknown site "${siteId}"`);
    clearCredential(siteId);
    console.log(`  已清除 ${siteId} 的本地凭据（不影响上游账号本身）`);
    return 0;
  }

  if (!siteId || siteId === true) siteId = await promptSite();
  if (!SITES[siteId]) throw new Error(`unknown site "${siteId}"; 可选：${Object.keys(SITES).join(', ')}`);
  await loginSite(siteId, { open: !noOpen });
  return 0;
}
