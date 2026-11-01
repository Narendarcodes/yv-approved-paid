#!/usr/bin/env node
// Run an app's own ESLint (its version, its eslint.config.js) with --fix on the
// given files. Used by .lintstagedrc.cjs so apps/web (ESLint 9) and apps/api
// (ESLint 8, flat config) each lint with their own setup.
//   node scripts/eslint-in.cjs <appDir> <file...>
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const [appDir, ...files] = process.argv.slice(2);
const root = path.resolve(__dirname, '..');
const cwd = path.resolve(root, appDir);
const bin = path.join(cwd, 'node_modules', '.bin', 'eslint');
if (!fs.existsSync(bin)) {
  console.error(`[pre-commit] ${appDir}: eslint not installed. Run "npm ci" in ${appDir} first.`);
  process.exit(1);
}
// Generated contracts are ignored by the app configs; filter them here too so
// ESLint does not warn about explicitly passed ignored files.
const rel = files
  .map((f) => path.relative(cwd, path.resolve(root, f)))
  .filter((f) => !f.startsWith(`src${path.sep}contracts${path.sep}`));
if (!rel.length) process.exit(0);
const res = spawnSync(bin, ['--fix', ...rel], { cwd, stdio: 'inherit' });
process.exit(res.status ?? 1);
