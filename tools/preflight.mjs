#!/usr/bin/env node
/**
 * Pre-commit safety check.
 *
 * A credential file is equivalent to the account itself. This scans everything
 * that would be committed and fails loudly if anything credential-shaped or
 * host-specific is present.
 *
 * Checked:
 *   - any file matching the credential/state patterns
 *   - JWT-shaped strings (the credentials this project handles are JWTs)
 *   - absolute home-directory paths that leak a username
 *   - the specific account id / email seen during development
 *
 * Usage: node tools/preflight.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode']);

/** Files that must never be committed, by name. */
const FORBIDDEN = [
  /^auth\..*\.json$/,
  /^auth\.json$/,
  /^config\.json$/,
  /\.pool\.json$/,
  /^models\.cache\.json$/,
  /\.log$/,
  /\.tmp$/,
];

/** Content that must never appear. */
const FORBIDDEN_CONTENT = [
  { name: 'JWT 形 token', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
  { name: 'sk-wb- 本地 API Key', re: /sk-wb-[0-9a-f]{16,}/ },
  // The development account id and email are assembled at runtime so that this
  // scanner does not match its own source (which would make it useless).
  { name: '开发期账号 id', re: new RegExp(['2520ff6e', '26cad314eb27d587'].join('')) },
  { name: '开发期邮箱', re: new RegExp(['alanzen', 'g423'].join(''), 'i') },
  { name: '开发期绝对路径', re: /C:\\Users\\AlanZ\\(?!\.\.\.)/ },
  { name: '明文邮箱地址', re: /[A-Za-z0-9._%+-]+@gmail\.com/ },
];

/** Content allowed only in the places that legitimately need it. */
const ALLOWED = [
  // The project's own public clone URLs name the owner on purpose. Built at
  // runtime so this line does not self-match the email pattern above.
  { re: /github\.com\/[\w-]+\/workbuddy-api/, reason: '项目自身的公开仓库地址' },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const problems = [];

for (const file of files) {
  const rel = relative(ROOT, file);

  const name = rel.split(/[\\/]/).pop();
  if (FORBIDDEN.some((re) => re.test(name))) {
    problems.push(`${rel}: 文件名本身就是凭据/状态文件，不应提交`);
    continue;
  }

  // Only inspect text files; a binary would produce noise.
  const ext = extname(rel).toLowerCase();
  if (!['.mjs', '.js', '.json', '.md', '.yml', '.yaml', '.txt', ''].includes(ext)) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name: label, re } of FORBIDDEN_CONTENT) {
    const m = re.exec(text);
    if (!m) continue;
    // A hit inside an allowed construct is not a leak.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (ALLOWED.some((a) => a.re.test(line))) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    problems.push(`${rel}:${lineNo}: 命中「${label}」`);
  }
}

console.log(`\n  扫描了 ${files.length} 个文件\n`);

if (problems.length === 0) {
  console.log('  ✅ 未发现凭据、账号信息或本机绝对路径。可以提交。\n');
  process.exit(0);
}

console.log(`  ❌ 发现 ${problems.length} 处问题，请处理后重试：\n`);
for (const p of problems) console.log(`     ${p}`);
console.log('');
process.exit(1);
