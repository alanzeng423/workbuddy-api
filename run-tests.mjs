#!/usr/bin/env node
/**
 * Test runner that avoids the Node test runner's child-process isolation.
 *
 * `node --test` spawns a child process per test file with piped stdio. Under the
 * DSH sandbox that spawn is denied (`spawn EPERM`) — a documented environment
 * boundary, not a bug in these tests. Running each file in THIS process keeps the
 * suite usable in confined environments while behaving identically in a normal
 * shell.
 *
 * Files are still imported one at a time so a top-level failure in one does not
 * silently abort the rest.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('no test files found in', testDir);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  try {
    await import(new URL(`./test/${file}`, import.meta.url).href);
  } catch (err) {
    failed += 1;
    console.error(`\n[runner] ${file} threw at import time:\n`, err);
  }
}

// node:test reports its own results; a non-zero exit here means a file failed to
// even load, which the reporter cannot see.
if (failed > 0) {
  console.error(`\n[runner] ${failed} test file(s) failed to load`);
  process.exit(1);
}
