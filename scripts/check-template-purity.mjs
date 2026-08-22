#!/usr/bin/env node
/**
 * Proves Parley is still a template.
 *
 * Two checks over the source tree (README, .env.example and this script excluded):
 *   1. No hardcoded absolute URLs, apart from a short allowlist of infrastructure
 *      hosts that are the same for every merchant.
 *   2. No occurrence of any business name passed as an argument.
 *
 * Usage:
 *   node scripts/check-template-purity.mjs
 *   node scripts/check-template-purity.mjs acme "acme corp"
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'out', 'scripts']);
const SKIP_FILES = new Set(['README.md', '.env.example', 'package-lock.json', 'LICENSE']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

/** Hosts that belong to shared infrastructure, not to any one merchant. */
const ALLOWED_HOSTS = [
  'api.razorpay.com',
  'localhost',
  '127.0.0.1',
  'example.com',
  'schema.org',
  'json-schema.org',
  'modelcontextprotocol.io',
  'nextjs.org',
  'vercel.com',
];

const URL_PATTERN = /https?:\/\/[^\s"'`)\]}>,]+/g;

const forbiddenNames = process.argv.slice(2).map((word) => word.toLowerCase()).filter(Boolean);
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(name)) continue;
    const ext = name.slice(name.lastIndexOf('.'));
    if (!SOURCE_EXTENSIONS.has(ext) && ext !== '.md') continue;
    inspect(full);
  }
}

function inspect(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    const where = `${rel}:${index + 1}`;

    for (const match of line.match(URL_PATTERN) ?? []) {
      // A URL built from a template expression is configuration, not a hardcoded host.
      if (match.includes('${')) continue;
      let host;
      try {
        host = new URL(match).hostname;
      } catch {
        continue;
      }
      const allowed = ALLOWED_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
      if (!allowed) {
        failures.push(`${where}  hardcoded URL: ${match}`);
      }
    }

    const lowered = line.toLowerCase();
    for (const word of forbiddenNames) {
      if (lowered.includes(word)) {
        failures.push(`${where}  merchant name "${word}" appears in source: ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

walk(ROOT);

if (failures.length) {
  console.error(`\nTemplate purity check FAILED with ${failures.length} issue(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nEvery merchant-specific value belongs in an environment variable. See lib/config.ts.\n',
  );
  process.exit(1);
}

console.log('Template purity check passed.');
console.log('  - No hardcoded merchant URLs in the source tree.');
if (forbiddenNames.length) {
  console.log(`  - No occurrences of: ${forbiddenNames.join(', ')}`);
} else {
  console.log('  - Pass business names as arguments to also scan for those.');
}
