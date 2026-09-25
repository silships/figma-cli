// Tell people when a newer figma-cli is on npm.
//
// npm never updates a global install on its own, so without a hint users stay
// on the version they first installed and never get new commands or fixes. The
// hint goes to stderr (stdout stays clean for scripts and agents that parse
// JSON) and shows at most once a day. An agent that sees it can run the update
// command itself.
//
// Startup stays fast: the registry is never awaited. The notice is decided from
// a cached answer, and a stale cache is refreshed by a detached child process
// that outlives this command, at most once a day.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CACHE_FILE = join(homedir(), '.figma-ds-cli', 'update-check.json');
const REGISTRY_URL = 'https://registry.npmjs.org/figma-ds-cli/latest';

// true when version a is newer than b (plain x.y.z; a pre-release never wins)
export function isNewer(a, b) {
  const parse = v => String(v || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  if (String(a || '').includes('-')) return false;
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return true;
    if ((x[i] || 0) < (y[i] || 0)) return false;
  }
  return false;
}

export function isDisabled(env = process.env) {
  return !!(env.FIGMA_CLI_NO_UPDATE_CHECK || env.CI || env.NODE_TEST_CONTEXT);
}

// Pure decision: what to print and whether to refresh the cache.
export function decide({ current, cache = {}, now = Date.now() }) {
  const refresh = !cache.checkedAt || now - cache.checkedAt > DAY_MS;
  const outdated = cache.latest && isNewer(cache.latest, current);
  const due = !cache.notifiedAt || now - cache.notifiedAt > DAY_MS || cache.notifiedFor !== cache.latest;
  const notice = outdated && due
    ? `figma-cli ${cache.latest} is available (you have ${current}). Update: npm install -g figma-ds-cli@latest`
    : null;
  return { notice, refresh };
}

function readCache(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeCache(file, data) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)); } catch {}
}

// Fetch the latest version in a detached process that writes the cache.
function refreshInBackground(file) {
  const script = `
    const fs = require('fs');
    const file = ${JSON.stringify(file)};
    let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    fetch(${JSON.stringify(REGISTRY_URL)}, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(j => { cache.checkedAt = Date.now(); if (j && j.version) cache.latest = j.version; fs.writeFileSync(file, JSON.stringify(cache)); })
      .catch(() => { cache.checkedAt = Date.now(); try { fs.writeFileSync(file, JSON.stringify(cache)); } catch {} });`;
  try {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function currentVersion() {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch { return null; }
}

export function runUpdateCheck({ file = CACHE_FILE, env = process.env, now = Date.now(), print = m => process.stderr.write(m + '\n') } = {}) {
  if (isDisabled(env)) return;
  const current = currentVersion();
  if (!current) return;
  const cache = readCache(file);
  const { notice, refresh } = decide({ current, cache, now });
  if (notice) {
    print(notice);
    writeCache(file, { ...cache, notifiedAt: now, notifiedFor: cache.latest });
  }
  if (refresh) {
    // claim today's check first, so a burst of commands spawns one refresh
    writeCache(file, { ...readCache(file), checkedAt: now });
    refreshInBackground(file);
  }
}
