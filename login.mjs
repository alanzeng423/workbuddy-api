#!/usr/bin/env node
/** Login CLI: `node login.mjs [--site <id>] [--no-open] [--list] [--logout]` */
import { runLogin } from './src/login.mjs';

try {
  process.exitCode = await runLogin(process.argv.slice(2));
} catch (err) {
  console.error(`\n  ❌ ${err.message}\n`);
  process.exitCode = 1;
}
