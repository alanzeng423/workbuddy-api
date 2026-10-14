#!/usr/bin/env node
/**
 * Status CLI: per-site sign-in state, token expiry, and remaining credits.
 *
 * Read-only by construction: it never refreshes a token (a status command that
 * rotates credentials is a surprise) and never writes anything.
 */
import { loadConfig, SITES } from './src/config.mjs';
import { credentialStatus } from './src/auth.mjs';

const json = process.argv.includes('--json');
const rows = Object.keys(SITES).map((id) => {
  const st = credentialStatus(id);
  // `credentialStatus` keys the site as `siteId`; normalize to `site` for display.
  return { ...st, site: st.siteId ?? id, label: SITES[id].label, apiBase: SITES[id].apiBase };
});

if (json) {
  console.log(JSON.stringify({ sites: rows }, null, 2));
} else {
  console.log('');
  console.log('  WorkBuddy API — 站点状态');
  console.log('');
  for (const r of rows) {
    if (!r.signedIn) {
      console.log(`  ⬜ ${r.site.padEnd(11)} 未登录       ${r.apiBase}`);
      console.log(`     └ 登录命令: node login.mjs --site ${r.site}`);
      continue;
    }
    const who = r.nickname || r.uid || '(未知账号)';
    const days = r.expiresAtMs ? Math.round((r.expiresAtMs - Date.now()) / 86400000) : undefined;
    const exp = r.expired
      ? '  ⚠️ token 已过期（下次请求会自动刷新）'
      : days !== undefined ? `  token 还有约 ${days} 天` : '';
    console.log(`  ✅ ${r.site.padEnd(11)} ${who}${exp}`);
    console.log(`     └ ${r.apiBase}`);
  }
  const cfg = loadConfig({ createIfMissing: false });
  console.log('');
  console.log(`  默认站点: ${cfg.defaultSite}`);
  console.log('');
}
