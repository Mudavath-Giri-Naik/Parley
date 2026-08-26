#!/usr/bin/env node
/**
 * The scheduled appearance probe.
 *
 * Runs one round of buyer-style questions against whichever AI assistants expose a
 * programmatic, search-grounded interface, and records what came back. Intended for
 * a cron job — daily is plenty; these answers do not change hourly and each round
 * costs money at every provider that is configured.
 *
 *   node scripts/discovery-probe.mjs
 *   DISCOVERY_URL=https://your-deployment.example.com node scripts/discovery-probe.mjs
 *
 * Environment:
 *   DISCOVERY_URL     Deployment to probe. Default http://localhost:3000
 *   PARLEY_API_KEY    Bearer token, if the deployment sets one.
 *   PROBE_QUESTIONS   How many questions per platform (default 2).
 *
 * On Vercel this is a cron entry rather than a process:
 *
 *   { "crons": [{ "path": "/api/discovery/appearance", "schedule": "0 6 * * *" }] }
 *
 * but Vercel cron issues a GET, which only reads the log. Either call the POST from
 * an external scheduler, or run this script from one.
 *
 * What this cannot do is stated as loudly as what it can: it observes single answers
 * from single APIs at single moments. It is not a ranking, and no result here is a
 * commitment that the same question will be answered the same way tomorrow.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] !== undefined) continue; // real env always wins
    process.env[key] = value.trim().replace(/^["'](.*)["']$/, '$1');
  }
}

const BASE = (process.env.DISCOVERY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const QUESTIONS = Number(process.env.PROBE_QUESTIONS || 2);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const headers = { 'Content-Type': 'application/json' };
if (process.env.PARLEY_API_KEY) headers.Authorization = `Bearer ${process.env.PARLEY_API_KEY}`;

const url = `${BASE}/api/discovery/appearance?questions=${QUESTIONS}`;
console.log(`${DIM}POST ${url}${RESET}\n`);

let response;
try {
  response = await fetch(url, { method: 'POST', headers });
} catch (err) {
  console.error(`${RED}Could not reach the Discovery Service at ${BASE}: ${err.message}${RESET}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`${RED}HTTP ${response.status}${RESET}\n${(await response.text()).slice(0, 500)}`);
  process.exit(1);
}

const run = await response.json();

console.log(`${DIM}${run.disclaimer}${RESET}\n`);
console.log(`Questions asked:`);
for (const question of run.questions) console.log(`  - ${question}`);
console.log('');

for (const result of run.results) {
  if (!result.testable) {
    console.log(`  ${DIM}SKIP  ${result.platform} -- ${result.reason}${RESET}`);
    continue;
  }
  if (result.error) {
    console.log(`  ${RED}ERROR${RESET} ${result.platform} -- ${result.error}`);
    continue;
  }
  const marker = result.mentioned ? `${GREEN}NAMED${RESET}` : `${DIM}absent${RESET}`;
  console.log(`  ${marker} ${result.platform}  ${DIM}"${result.question}"${RESET}`);
  if (result.citations?.length) {
    console.log(`        ${DIM}cited: ${result.citations.slice(0, 3).join(', ')}${RESET}`);
  }
}

console.log(`\n${DIM}Stored in: ${run.storedIn}. Read the log at ${BASE}/discovery${RESET}`);

// A run where nothing could be tested is not a success worth reporting as one. Set the
// code rather than calling process.exit, which tears down sockets still closing from
// the fetch above and trips a libuv assertion on Windows.
const anyTested = run.results.some((result) => result.testable && !result.error);
if (!anyTested) {
  console.log(
    `${DIM}No platform returned an answer this run. Nothing was recorded as an observation.${RESET}`,
  );
}
process.exitCode = anyTested ? 0 : 1;
