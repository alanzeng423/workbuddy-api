#!/usr/bin/env node
/**
 * workbuddy-api — expose WorkBuddy / CodeBuddy quota as a local OpenAI /
 * Anthropic compatible API.
 *
 * Wiring only: configuration, the credential resolver, the catalog, the chat
 * dispatcher, and the HTTP server are each separate modules so they can be tested
 * without a network or a live upstream.
 */
import { loadConfig, configWarnings, SITES, configDir, configFile } from './src/config.mjs';
import { resolveCredential, credentialStatus, ensureConfigDir } from './src/auth.mjs';
import { Catalog } from './src/models.mjs';
import { createApiServer } from './src/server.mjs';
import { createChatDispatcher } from './src/chat.mjs';
import { pathToFileURL } from 'node:url';

export async function startServer({ port, host } = {}) {
  const config = loadConfig();
  if (port !== undefined) config.port = port;
  if (host !== undefined) config.host = host;

  const catalog = new Catalog();
  const chat = createChatDispatcher({ config, catalog, resolveCredential });
  const api = createApiServer({ config, catalog, resolveCredential, chat });

  const address = await api.listen();
  return { api, address, config, catalog };
}

/** Startup banner: what is signed in, and what to do about what is not. */
export function printBanner(config, address) {
  const url = `http://${address.host}:${address.port}`;
  const line = (s = '') => console.log(s);

  line('');
  line('  workbuddy-api  ·  把 WorkBuddy / CodeBuddy 额度转成本机 API');
  line('');
  line(`  监听地址 : ${url}   ${address.host === '127.0.0.1' ? '（仅本机可达）' : '⚠️  非回环地址，已暴露到网络'}`);
  const key = Array.isArray(config.apiKey) ? config.apiKey[0] : config.apiKey;
  if (key) {
    line(`  API Key  : ${key.slice(0, 10)}…（完整值见 ${configFile()}）`);
  } else {
    line('  API Key  : （未设置 —— 任何本机程序都可调用，建议设置）');
  }
  line('');
  line('  可用端点 :');
  line(`    POST ${url}/v1/chat/completions   OpenAI 兼容`);
  line(`    POST ${url}/v1/messages           Anthropic Messages`);
  line(`    POST ${url}/v1/responses          OpenAI Responses (Codex CLI)`);
  line(`    GET  ${url}/v1/models             模型清单`);
  line(`    GET  ${url}/health                健康检查（免鉴权）`);
  line('');
  line('  站点登录状态 :');

  let anySignedIn = false;
  for (const id of Object.keys(SITES)) {
    const st = credentialStatus(id);
    if (st.signedIn) anySignedIn = true;
    const who = st.nickname || st.uid || '';
    line(`    ${st.signedIn ? '✅' : '  '} ${id.padEnd(11)} ${st.signedIn ? who : '未登录'}${st.expired ? '  (token 已过期，将在下次请求时自动刷新)' : ''}`);
  }
  if (!anySignedIn) {
    line('');
    line('  ⚠️  还没有任何站点登录，现在调用会返回 401。请先执行：');
    line('        node login.mjs');
  }
  line('');
  line(`  提示：客户端的 Base URL 填 ${url}/v1 ，API Key 填上面的值。`);
  line('');
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`用法: node server.mjs [--host 127.0.0.1] [--port 8788]

  环境变量:
    WORKBUDDY_API_HOME   配置与凭据目录（默认 ~/.workbuddy-api）

  运行前请先登录: node login.mjs`);
    return 0;
  }

  const portRaw = argOf('--port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (portRaw !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    console.error(`无效的端口: ${portRaw}`);
    return 1;
  }

  ensureConfigDir();
  const { api, address, config } = await startServer({ port, host: argOf('--host') });

  for (const warning of configWarnings()) console.warn(`  ⚠️  ${warning}`);
  printBanner(config, address);

  const shutdown = async (signal) => {
    console.log(`\n  收到 ${signal}，正在关闭…`);
    await api.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return undefined; // keep the process alive
}

// Only auto-start when executed directly, so tests can import startServer().
// `pathToFileURL` is required here: a hand-built `file://${path}` yields
// `file://C:/...` on Windows while `import.meta.url` is `file:///C:/...`, so the
// comparison silently fails and the server starts nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    if (typeof code === 'number') process.exit(code);
  }).catch((err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
}
