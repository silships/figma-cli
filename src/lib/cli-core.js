// Shared CLI core: daemon plumbing, figma eval helpers, config, program.
// Extracted from index.js — all command modules import from here.
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { homedir, tmpdir } from 'os';
import { createServer } from 'http';
import { FigJamClient } from '../figjam-client.js';
import { FigmaClient } from '../figma-client.js';
import * as apiDocs from '../api-docs.js';
import { isPatched, patchFigma, unpatchFigma, getFigmaCommand, getCdpPort, getFigmaBinaryPath } from '../figma-patch.js';
import { listComponents, getComponent, getAllComponents, VISUAL_COMPONENTS } from '../shadcn.js';
import { listBlocks, getBlock } from '../blocks/index.js';
import { extractGradient, extractMesh, buildMeshFromColors, buildFigmaPaint, buildCssString } from '../gradient-extractor.js';
import {
  nullDevice, killPort, getPortPid, sleepAfterStop,
  startFigmaApp, killFigmaApp,
  getFigmaVersion, isFigmaRunning, platformName
} from '../platform.js';

// Fix zsh shell escaping: zsh escapes ! to \! even in single quotes
function unescapeShell(str) {
  if (!str) return str;
  return str.replace(/\\!/g, '!');
}

/**
 * If the JSX is a Frame whose role is "lay out N similar items in a row/col",
 * extract the children as independent JSX strings + the direction.
 *
 * Rationale: LLM callers regularly wrap "5 buttons" / "3 cards" in an outer
 * `<Frame flex="row">` which then becomes a single rendered Frame in Figma
 * instead of N standalone canvas items the user can move/use individually.
 * `render-batch` is the right primitive for this. This function lets `render`
 * detect the pattern at the CLI surface and reroute, so every caller (any LLM,
 * shell, IDE) benefits without each one needing its own rewriter.
 *
 * Returns `{ direction, children }` if a split is appropriate, `null` otherwise.
 *
 * Split conditions:
 *  - outer is a single <Frame ...> with a flex direction
 *  - outer contains ≥ 2 direct <Frame> children (depth-aware)
 *  - all direct children are <Frame>s (no orphan <Text>, <Icon>, etc.)
 *  - bg/fill on the outer is fine; the wrapper visual is dropped on purpose
 *    because the canonical pattern is "N standalone items", not "N items in a
 *    bag". Callers who really want the wrapper can pass --keep-wrapper.
 */
function detectWrapperSplit(jsx) {
  const text = jsx.trim();
  const outerMatch = text.match(/^<Frame\b([^>]*)>([\s\S]*)<\/Frame>\s*$/);
  if (!outerMatch) return null;
  const outerAttrs = outerMatch[1];
  const inner = outerMatch[2];
  const flexMatch = outerAttrs.match(/flex\s*=\s*["']?(row|col|column|vertical|horizontal)["']?/);
  if (!flexMatch) return null;
  // CRITICAL: only split when the outer is PURE layout. If the outer carries
  // any visual property (bg, fill, stroke, rounded, shadow, blur, image), it's
  // a real composite component (Card, Modal, Banner…) and splitting destroys
  // the design. Layout-only attrs like gap, padding, justify, items are fine.
  const visualAttrs = /\b(bg|fill|stroke|rounded|radius|shadow|innerShadow|blur|bgBlur|image)\s*=/;
  if (visualAttrs.test(outerAttrs)) return null;
  const direction = /col|vertical|column/.test(flexMatch[1]) ? 'col' : 'row';
  // Walk inner with depth tracking, capture every depth-1 element
  const children = [];
  let depth = 0;
  let chunkStart = -1;
  let i = 0;
  let nonFrameChildSeen = false;
  while (i < inner.length) {
    if (inner[i] === '<' && inner[i + 1] !== '/') {
      // Identify tag name
      const tagMatch = inner.slice(i).match(/^<([A-Za-z][A-Za-z0-9]*)\b/);
      if (!tagMatch) { i++; continue; }
      const tagName = tagMatch[1];
      if (depth === 0) {
        if (tagName !== 'Frame') { nonFrameChildSeen = true; return null; }
        chunkStart = i;
      }
      // Self-closing tag like <Icon ... />
      const selfClose = inner.slice(i).match(/^<[A-Za-z][^>]*\/>/);
      if (selfClose) {
        if (depth === 0) {
          // Self-closing direct child — only allowed if it's a Frame
          if (tagName !== 'Frame') { nonFrameChildSeen = true; return null; }
          children.push(selfClose[0]);
          chunkStart = -1;
        }
        i += selfClose[0].length;
        continue;
      }
      // Regular opening tag
      const open = inner.slice(i).match(/^<[A-Za-z][^>]*>/);
      if (!open) { i++; continue; }
      depth++;
      i += open[0].length;
      continue;
    }
    if (inner[i] === '<' && inner[i + 1] === '/') {
      const close = inner.slice(i).match(/^<\/[A-Za-z]+>/);
      if (!close) { i++; continue; }
      depth--;
      i += close[0].length;
      if (depth === 0 && chunkStart !== -1) {
        children.push(inner.slice(chunkStart, i));
        chunkStart = -1;
      }
      continue;
    }
    i++;
  }
  if (nonFrameChildSeen) return null;
  if (children.length < 2) return null;
  // Don't split distinct-child composites. A real "N items in a row" pattern
  // has children that share a base name (Button 1/2/3, Card A/B/C) or are
  // structurally interchangeable. A composite has children with unrelated
  // names (TabBar + Panel, Header + Body + Footer, Body + Close) — splitting
  // would scatter the pieces. Heuristic: extract a base from each child's
  // name=, strip trailing numbers/letters/slashes. If <50% share the same
  // base, it's a composite — bail out.
  const childNames = children.map(c => {
    const m = c.match(/\bname\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : '';
  });
  // Strip a trailing differentiator that's clearly a sibling-index: requires
  // a separator (space, dash, slash, underscore) before the suffix so that
  // distinct names like "TabBar" / "Panel" stay distinct.
  const bases = childNames.map(n => {
    let b = n.replace(/[\s\-/_][A-Za-z0-9]+$/, ''); // "Button 1" → "Button", "Btn/Primary" → "Btn"
    return (b || n).toLowerCase().trim();
  });
  // If children have more than one distinct base, this is a composite
  // (TabBar + Panel, Header + Body + Footer, Body + Close) and splitting
  // would scatter the design. Only allow split when EVERY child shares the
  // same base name (the "N items" pattern).
  const distinctBases = new Set(bases);
  if (distinctBases.size > 1) return null;
  return { direction, children };
}

// Patterns that aren't worth running as --query because they match Figma's
// default auto-names — they'd select every unnamed node in the whole tree.
const GENERIC_NAME_PATTERNS = new Set([
  'frame', 'component', 'instance', 'group', 'rectangle', 'rect',
  'ellipse', 'line', 'text', 'vector', 'star', 'polygon', 'section',
]);

/**
 * Build the JS snippet that resolves a target `nodes` list inside an eval.
 * One source-of-truth for all `set <subcommand>` selectors. Supports:
 *  - --query "pattern"     fuzzy name match (rejects generic defaults)
 *  - --node "id"           single node
 *  - --node "id1,id2,id3"  multiple comma-separated nodes
 *  - (none)                figma.currentPage.selection
 *
 * `filterExpr` is optional and lets a caller scope --query to nodes that
 * actually support the property (e.g. `'fills' in n`).
 */
function buildNodeSelector(options, { filterExpr = '' } = {}) {
  if (options.query) {
    const q = String(options.query).trim();
    if (GENERIC_NAME_PATTERNS.has(q.toLowerCase())) {
      console.error(chalk.red('✗'),
        `--query "${q}" matches Figma's default node name and would select every unnamed ${q.toLowerCase()} in the file.`);
      console.error(chalk.yellow('  Use --node <id> with specific IDs, or rename your targets first.'));
      process.exit(1);
    }
    const filter = filterExpr ? `(${filterExpr}) && ` : '';
    return `const __pat = ${JSON.stringify(q.toLowerCase())};
       const nodes = figma.currentPage.findAll(n => ${filter}typeof n.name === 'string' && n.name.toLowerCase().includes(__pat));`;
  }
  if (options.node) {
    const ids = String(options.node).split(/[\s,]+/).filter(Boolean);
    if (ids.length === 1) {
      return `const __n = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const nodes = __n ? [__n] : [];`;
    }
    return `const __ids = ${JSON.stringify(ids)};
       const __res = await Promise.all(__ids.map(id => figma.getNodeByIdAsync(id)));
       const nodes = __res.filter(Boolean);`;
  }
  return `const nodes = figma.currentPage.selection;`;
}

// Daemon configuration
const DAEMON_PORT = 3456;
const DAEMON_PID_FILE = join(homedir(), '.figma-cli-daemon.pid');
const DAEMON_TOKEN_FILE = join(homedir(), '.figma-ds-cli', '.daemon-token');

// Generate and save a new session token for daemon authentication
function generateDaemonToken() {
  const configDir = join(homedir(), '.figma-ds-cli');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(DAEMON_TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// Read the current daemon session token
function getDaemonToken() {
  try {
    return readFileSync(DAEMON_TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

// Get detailed token status for debugging
function getTokenStatus() {
  const configDir = join(homedir(), '.figma-ds-cli');
  const tokenPath = DAEMON_TOKEN_FILE;
  const status = {
    configDir,
    tokenPath,
    configDirExists: existsSync(configDir),
    tokenFileExists: existsSync(tokenPath),
    token: null,
    tokenPreview: null
  };

  if (status.tokenFileExists) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      status.token = token;
      status.tokenPreview = token.slice(0, 8) + '...' + token.slice(-8);
    } catch (e) {
      status.readError = e.message;
    }
  }

  return status;
}

// Process-level health cache. A single CLI command checks daemon health 3-4
// times across checkConnection/fastRender/command-internal guards — each was a
// fresh `curl` subprocess spawn. Since a CLI process is short-lived, caching the
// boolean result for a brief window collapses those to one spawn. `force` and
// the detail form always bypass the cache (used by retry/fallback logic that
// must see the live state after a failure).
let _daemonHealthCache = { time: 0, value: null };
const DAEMON_HEALTH_TTL_MS = 2000;
function invalidateDaemonHealthCache() { _daemonHealthCache = { time: 0, value: null }; }

// Check if daemon is running (returns object with details, or false)
function isDaemonRunning(returnDetails = false, force = false) {
  if (!returnDetails && !force && _daemonHealthCache.value !== null &&
      Date.now() - _daemonHealthCache.time < DAEMON_HEALTH_TTL_MS) {
    return _daemonHealthCache.value;
  }
  try {
    const token = getDaemonToken();
    const tokenHeader = token ? ` -H "X-Daemon-Token: ${token}"` : '';
    const response = execSync(`curl -s -o ${nullDevice} -w "%{http_code}"${tokenHeader} http://localhost:${DAEMON_PORT}/health`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 1000
    });
    const statusCode = response.trim();

    if (returnDetails) {
      return {
        running: statusCode === '200',
        statusCode,
        hasToken: !!token,
        authFailed: statusCode === '403'
      };
    }
    const ok = statusCode === '200';
    _daemonHealthCache = { time: Date.now(), value: ok };
    return ok;
  } catch (e) {
    if (returnDetails) {
      return {
        running: false,
        error: e.message,
        hasToken: !!getDaemonToken()
      };
    }
    _daemonHealthCache = { time: Date.now(), value: false };
    return false;
  }
}

// Send command to daemon (uses native fetch in Node 18+)
async function daemonExec(action, data = {}, timeoutMs = 90000) {
  const token = getDaemonToken();
  const headers = { 'Content-Type': 'application/json' };

  // Fail fast with clear error if token is missing
  if (!token) {
    const status = getTokenStatus();
    if (!status.tokenFileExists) {
      throw new Error(
        `Daemon token not found at ${DAEMON_TOKEN_FILE}\n` +
        `Run "node src/index.js connect" to start the daemon and generate a token.`
      );
    }
    throw new Error(
      `Failed to read daemon token from ${DAEMON_TOKEN_FILE}\n` +
      `${status.readError || 'Unknown error'}`
    );
  }

  headers['X-Daemon-Token'] = token;

  try {
    const response = await fetch(`http://localhost:${DAEMON_PORT}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...data }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const text = await response.text();
      // Try to parse as JSON error from daemon
      try {
        const errObj = JSON.parse(text);
        if (errObj.error) {
          // Enhance auth errors with helpful info
          if (errObj.error.includes('Unauthorized') || errObj.error.includes('token')) {
            throw new Error(
              `${errObj.error}\n` +
              `Token file: ${DAEMON_TOKEN_FILE}\n` +
              `Try: node src/index.js daemon restart`
            );
          }
          // Safe Mode: plugin tab was closed → guide the user back to it
          // instead of just dumping the raw error.
          if (/Plugin not connected/i.test(errObj.error)) {
            throw new Error(
              'Plugin not connected.\n' +
              'In Figma: Plugins → Development → FigCli (keep that tab open).\n' +
              'Or switch to Yolo Mode: node src/index.js connect'
            );
          }
          // Clean up error: remove stack trace line numbers for cleaner output
          const cleanError = errObj.error.split('\n')[0];
          throw new Error(cleanError);
        }
      } catch (parseErr) {
        if (parseErr.message && !parseErr.message.includes('JSON')) {
          throw parseErr; // Re-throw our clean error
        }
      }
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return result.result;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
      throw new Error(`Execution timeout (${timeoutMs/1000}s). Try reconnecting: node src/index.js connect`);
    }
    throw e;
  }
}

// Ensure the daemon is up before sending it work. The daemon idle-shuts-down
// after a while, so a command issued after a quiet stretch would otherwise find
// it dead and limp along on the slow direct-connection path for the rest of the
// session. Here we transparently respawn it and wait briefly for health, so the
// fast path self-heals. Only auto-restarts when the user has connected before
// (PID file present) — never spawns a daemon on a fresh, never-connected setup.
async function ensureDaemonRunning(maxWaitMs = 5000) {
  if (isDaemonRunning()) return true;
  // Guard: only resurrect a daemon the user actually set up — either a PID file
  // is present (idle-shutdown leaves it) or Figma is patched for Yolo Mode (so
  // the daemon is the intended fast path even after an explicit stop).
  if (!existsSync(DAEMON_PID_FILE) && !isFigmaPatched()) return false;
  try {
    startDaemon();
  } catch {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 200));
    if (isDaemonRunning(false, true)) return true; // force: bypass the "false" we just cached
  }
  return false;
}

// Fast eval via daemon (falls back to direct connection)
async function fastEval(code) {
  // Try daemon first (auto-restarting it if it idle-shut-down)
  if (await ensureDaemonRunning()) {
    try {
      return await daemonExec('eval', { code });
    } catch (e) {
      // Continue to fallback
    }
  }

  // Fall back to direct connection
  const client = await getFigmaClient();
  return await client.eval(code);
}

// Fast render via daemon (falls back to direct connection)
async function fastRender(jsx) {
  // Try daemon first (auto-restarting it if it idle-shut-down)
  if (await ensureDaemonRunning()) {
    try {
      return await daemonExec('render', { jsx });
    } catch (e) {
      // Continue to fallback
    }
  }

  // Fall back to direct connection
  const client = await getFigmaClient();
  return await client.render(jsx);
}

// Helper: run figma-use commands with Node 20+ compatibility warning
function runFigmaUse(cmd, options = {}) {
  try {
    execSync(cmd, { stdio: options.stdio || 'inherit', timeout: options.timeout || 60000 });
  } catch (error) {
    if (error.message?.includes('enableCompileCache')) {
      console.log(chalk.red('\n✗ figma-use is broken on Node.js ' + process.version));
      console.log(chalk.yellow('  This is a known upstream bug (enableCompileCache not available in ESM).'));
      console.log(chalk.gray('  Workaround: use Node.js 18.x, or wait for a figma-use update.\n'));
    } else {
      throw error;
    }
  }
}

// Start daemon in background
function startDaemon(forceRestart = false, mode = 'auto') {
  // If force restart, always kill existing daemon first
  if (forceRestart) {
    stopDaemon();
    sleepAfterStop();

    // Double-check port is free
    try {
      killPort(DAEMON_PORT);
    } catch {}
  } else if (isDaemonRunning()) {
    return true; // Already running
  }

  // Generate session token before spawning daemon
  const newToken = generateDaemonToken();

  const daemonScript = join(__dirname, 'daemon.js');
  const child = spawn('node', [daemonScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DAEMON_PORT: String(DAEMON_PORT), DAEMON_MODE: mode }
  });
  child.unref();

  // Save PID
  writeFileSync(DAEMON_PID_FILE, String(child.pid));
  invalidateDaemonHealthCache(); // state changed — don't serve a stale "down"
  return true;
}

// Stop daemon
function stopDaemon() {
  invalidateDaemonHealthCache(); // state changed — don't serve a stale "up"
  try {
    if (existsSync(DAEMON_PID_FILE)) {
      const pid = readFileSync(DAEMON_PID_FILE, 'utf8').trim();
      try {
        process.kill(parseInt(pid), 'SIGTERM');
      } catch {}
      unlinkSync(DAEMON_PID_FILE);
    }
    // Also try to kill by port
    try { killPort(DAEMON_PORT); } catch {}
  } catch {}
}

// Platform-specific Figma paths and commands
function getFigmaPath() {
  // Use centralized path detection from figma-patch.js
  return getFigmaBinaryPath();
}

function startFigma() {
  const port = getCdpPort();
  const figmaPath = getFigmaPath();
  startFigmaApp(figmaPath, port);
}

function killFigma() {
  killFigmaApp();
}

function getManualStartCommand() {
  // Use centralized command from figma-patch.js
  return getFigmaCommand(getCdpPort());
}

// NOTE: this file lives in src/lib/ — keep __dirname pointing at src/ so
// daemon.js / figma-client.js / package.json resolve as before the split.
const __dirname = join(dirname(fileURLToPath(import.meta.url)), '..');
const __filename = join(__dirname, 'index.js');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const CONFIG_DIR = join(homedir(), '.figma-ds-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const program = new Command();

program.option('--port <number>', 'CDP port for Figma connection (default: 9222, env: FIGMA_PORT)');

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.port) {
    process.env.FIGMA_PORT = String(opts.port);
  }
});

// Helper: Prompt user
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

// Helper: Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// Helper: Save config
function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Singleton FigmaClient instance
let _figmaClient = null;

// Helper: Get or create FigmaClient
async function getFigmaClient() {
  if (!_figmaClient) {
    _figmaClient = new FigmaClient();
    // Short timeout: this is the per-command direct fallback (daemon couldn't be
    // used). If Figma's CDP isn't reachable we want to fail in ~4s, not hang for
    // 15s on every command. The explicit `connect` command keeps the 15s default
    // because Figma may still be booting then.
    try {
      await _figmaClient.connect(null, { timeoutMs: 4000 });
    } catch (e) {
      _figmaClient = null;
      throw e;
    }
  }
  return _figmaClient;
}

// Helper: Run code in Figma (replaces figma-use eval)
async function figmaEval(code) {
  const client = await getFigmaClient();
  return await client.eval(code);
}

// Sync wrapper for figmaEval - uses daemon via curl (fast) or fallback to direct connection
function figmaEvalSync(code) {
  // Try daemon first (fast path)
  const daemonRunning = isDaemonRunning();
  if (daemonRunning) {
    try {
      // Wrap code to ensure return value for plugin mode
      // CDP returns last expression automatically, plugin needs explicit return
      let wrappedCode = code.trim();
      // Don't wrap if already an IIFE or starts with return - plugin handles these
      // For simple expressions and multi-statement code, just pass through
      // The plugin will add return to the last statement
      const payload = JSON.stringify({ action: 'eval', code: wrappedCode });
      const payloadFile = join(tmpdir(), `figma-payload-${Date.now()}.json`);
      writeFileSync(payloadFile, payload);
      const daemonToken = getDaemonToken();
      const tokenHeader = daemonToken ? ` -H "X-Daemon-Token: ${daemonToken}"` : '';
      const result = execSync(
        `curl -s -X POST http://127.0.0.1:${DAEMON_PORT}/exec -H "Content-Type: application/json"${tokenHeader} -d @"${payloadFile}"`,
        { encoding: 'utf8', timeout: 60000 }
      );
      try { unlinkSync(payloadFile); } catch {}
      if (!result || result.trim() === '') {
        throw new Error('Empty response from daemon');
      }
      const data = JSON.parse(result);
      if (data.error) throw new Error(data.error);
      return data.result;
    } catch (e) {
      // Check if we're in Safe Mode (plugin only) - don't fall through to CDP
      try {
        const healthToken = getDaemonToken();
        const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
        const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
        const health = JSON.parse(healthRes);
        if (health.plugin && !health.cdp) {
          // Safe Mode - re-throw the error, don't try CDP fallback
          throw e;
        }
      } catch {}
      // Fall through to direct CDP connection
    }
  }

  // Fallback: direct connection via temp script
  const tempFile = join(tmpdir(), `figma-eval-${Date.now()}.mjs`);
  const resultFile = join(tmpdir(), `figma-result-${Date.now()}.json`);

  // Use file:// URL for ESM import (cross-platform). Resolve relative to
  // this file, not process.cwd(), so the CLI works from any directory.
  const clientUrl = pathToFileURL(join(__dirname, 'figma-client.js')).href;

  const script = `
    import { FigmaClient } from ${JSON.stringify(clientUrl)};
    import { writeFileSync } from 'fs';

    (async () => {
      try {
        const client = new FigmaClient();
        await client.connect();
        const result = await client.eval(${JSON.stringify(code)});
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ success: true, result }));
        client.close();
      } catch (e) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ success: false, error: e.message }));
      }
    })();
  `;

  writeFileSync(tempFile, script);
  try {
    execSync(`node "${tempFile}"`, { stdio: 'pipe', timeout: 60000 });
    if (existsSync(resultFile)) {
      const data = JSON.parse(readFileSync(resultFile, 'utf8'));
      try { unlinkSync(tempFile); } catch {}
      try { unlinkSync(resultFile); } catch {}
      if (data.success) return data.result;
      throw new Error(data.error);
    }
  } catch (e) {
    try { unlinkSync(tempFile); } catch {}
    try { unlinkSync(resultFile); } catch {}
    throw e;
  }
  return null;
}

// Compatibility wrapper for old figmaUse calls
function figmaUse(args, options = {}) {
  // Parse eval command
  const evalMatch = args.match(/^eval\s+"(.+)"$/s) || args.match(/^eval\s+'(.+)'$/s);

  if (evalMatch) {
    // Only unescape quotes, NOT \n (which would break string literals like .join('\n'))
    const code = evalMatch[1].replace(/\\"/g, '"');
    try {
      const result = figmaEvalSync(code);
      if (!options.silent && result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
      return typeof result === 'object' ? JSON.stringify(result) : String(result || '');
    } catch (error) {
      if (options.silent) return null;
      throw error;
    }
  }

  if (args === 'status' || args.startsWith('status')) {
    try {
      const port = getCdpPort();
      const result = execSync(`curl -s http://localhost:${port}/json`, { encoding: 'utf8', stdio: 'pipe' });
      const pages = JSON.parse(result);
      const figmaPage = pages.find(p => p.url?.includes('figma.com/design') || p.url?.includes('figma.com/file'));
      if (figmaPage) {
        const status = `Connected to Figma\n  File: ${figmaPage.title.replace(' – Figma', '')}`;
        if (!options.silent) console.log(status);
        return status;
      }
      return 'Not connected';
    } catch {
      return 'Not connected';
    }
  }

  if (args === 'variable list') {
    const result = figmaEvalSync(`(async () => {
      const vars = await figma.variables.getLocalVariablesAsync();
      return vars.map(v => v.name + ' (' + v.resolvedType + ')').join('\\n');
    })()`);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args === 'collection list') {
    const result = figmaEvalSync(`(async () => {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      return cols.map(c => c.name + ' (' + c.variableIds.length + ' vars)').join('\\n');
    })()`);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args.startsWith('collection create ')) {
    const name = args.replace('collection create ', '').replace(/"/g, '');
    const result = figmaEvalSync(`
      const col = figma.variables.createVariableCollection(${JSON.stringify(name)});
      col.id
    `);
    if (!options.silent) console.log(chalk.green('✓ Created collection: ' + name));
    return result;
  }

  if (args.startsWith('variable find ')) {
    const pattern = args.replace('variable find ', '').replace(/"/g, '');
    const result = figmaEvalSync(`(async () => {
      const pattern = ${JSON.stringify(pattern)}.replace('*', '.*');
      const re = new RegExp(pattern, 'i');
      const vars = await figma.variables.getLocalVariablesAsync();
      return vars.filter(v => re.test(v.name)).map(v => v.name).join('\\n');
    })()`);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args.startsWith('select ')) {
    const nodeId = args.replace('select ', '').replace(/"/g, '');
    figmaEvalSync(`(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (node) figma.currentPage.selection = [node];
    })()`);
    return 'Selected';
  }

  // Fallback warning
  if (!options.silent) {
    console.log(chalk.yellow('Command not fully supported: ' + args));
  }
  return null;
}

// Helper: Check connection
async function checkConnection() {
  // Self-heal: if the daemon idle-shut-down, bring it back BEFORE any command
  // tries to talk to it. Several command paths (e.g. render-batch) call
  // daemonExec directly with no fallback, so a dead daemon would hard-error
  // rather than just run slow. Resurrecting it here keeps the fast path alive.
  await ensureDaemonRunning();

  // First check daemon (works for both CDP and Plugin modes)
  try {
    const connToken = getDaemonToken();
    const connHeader = connToken ? ` -H "X-Daemon-Token: ${connToken}"` : '';
    const health = execSync(`curl -s${connHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
    const data = JSON.parse(health);
    if (data.status === 'ok' && (data.plugin || data.cdp)) {
      return true;
    }
  } catch {}

  // Fallback: check CDP directly
  const connected = await FigmaClient.isConnected();
  if (!connected) {
    console.log(chalk.red('\n✗ Not connected to Figma\n'));
    console.log(chalk.white('  Make sure Figma is running:'));
    console.log(chalk.cyan('  figma-ds-cli connect') + chalk.gray(' (Yolo Mode)'));
    console.log(chalk.cyan('  figma-ds-cli connect --safe') + chalk.gray(' (Safe Mode)\n'));
    process.exit(1);
  }
  return true;
}

// Helper: Check connection (sync version for backwards compat)
function checkConnectionSync() {
  // First check daemon (works for both CDP and Plugin modes)
  try {
    const syncToken = getDaemonToken();
    const syncHeader = syncToken ? ` -H "X-Daemon-Token: ${syncToken}"` : '';
    const health = execSync(`curl -s${syncHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
    const data = JSON.parse(health);
    if (data.status === 'ok' && (data.plugin || data.cdp)) {
      return true;
    }
  } catch {}

  // Fallback: check CDP directly
  try {
    const port = getCdpPort();
    execSync(`curl -s http://localhost:${port}/json`, { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    console.log(chalk.red('\n✗ Not connected to Figma\n'));
    console.log(chalk.white('  Make sure Figma is running:'));
    console.log(chalk.cyan('  figma-ds-cli connect') + chalk.gray(' (Yolo Mode)'));
    console.log(chalk.cyan('  figma-ds-cli connect --safe') + chalk.gray(' (Safe Mode)\n'));
    process.exit(1);
  }
}

// Helper: Check if Figma is patched
function isFigmaPatched() {
  const config = loadConfig();
  return config.patched === true;
}

// Helper: Hex to Figma RGB (handles both #RGB and #RRGGBB)
function hexToRgb(hex) {
  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Expand 3-char hex to 6-char
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    throw new Error(`Invalid hex color: #${hex}`);
  }
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  };
}

// Helper: Check if value is a variable reference (var:name)
function isVarRef(value) {
  return typeof value === 'string' && value.startsWith('var:');
}

// Helper: Extract variable name from var:name syntax
function getVarName(value) {
  return value.slice(4);
}

// Helper: Generate fill code (hex or variable binding)
function generateFillCode(color, nodeVar = 'node', property = 'fills') {
  if (isVarRef(color)) {
    const varName = getVarName(color);
    return {
      code: `${nodeVar}.${property} = [boundFill(vars[${JSON.stringify(varName)}])];`,
      usesVars: true
    };
  }
  const { r, g, b } = hexToRgb(color);
  return {
    code: `${nodeVar}.${property} = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];`,
    usesVars: false
  };
}

// Helper: Generate stroke code (hex or variable binding)
function generateStrokeCode(color, nodeVar = 'node', weight = 1) {
  if (isVarRef(color)) {
    const varName = getVarName(color);
    return {
      code: `${nodeVar}.strokes = [boundFill(vars[${JSON.stringify(varName)}])]; ${nodeVar}.strokeWeight = ${weight};`,
      usesVars: true
    };
  }
  const { r, g, b } = hexToRgb(color);
  return {
    code: `${nodeVar}.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; ${nodeVar}.strokeWeight = ${weight};`,
    usesVars: false
  };
}

// Helper: Variable loading code for shadcn collection
function varLoadingCode() {
  return `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const vars = {};
// Load variables from shadcn collections (shadcn/semantic and shadcn/primitives)
for (const col of collections) {
  if (col.name.startsWith('shadcn')) {
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) vars[v.name] = v;
    }
  }
}
const boundFill = (variable) => figma.variables.setBoundVariableForPaint(
  { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable
);
`;
}

// Helper: Smart positioning code (returns JS to get next free X position)
function smartPosCode(gap = 100) {
  return `
const children = figma.currentPage.children;
let smartX = 0;
if (children.length > 0) {
  children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
  smartX += ${gap};
}
`;
}


// Shared error handler for commands that hit Figma's API via daemonExec.
// Prints the error, then tries to surface relevant Figma Plugin API docs.
function handleEvalError(e) {
  console.error(chalk.red('✗'), e.message);
  try { apiDocs.suggestFromError(e.message); } catch { /* docs not installed, no-op */ }
  process.exit(1);
}

// Helper: Check if Safe Mode (plugin only)
async function isInSafeMode() {
  try {
    const healthToken = getDaemonToken();
    const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
    const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
    const health = JSON.parse(healthRes);
    return health.plugin && !health.cdp;
  } catch {
    return false;
  }
}

export {
  CONFIG_DIR,
  CONFIG_FILE,
  DAEMON_PID_FILE,
  DAEMON_PORT,
  DAEMON_TOKEN_FILE,
  GENERIC_NAME_PATTERNS,
  __dirname,
  __filename,
  _figmaClient,
  buildNodeSelector,
  checkConnection,
  checkConnectionSync,
  daemonExec,
  detectWrapperSplit,
  fastEval,
  fastRender,
  figmaEval,
  figmaEvalSync,
  figmaUse,
  generateDaemonToken,
  generateFillCode,
  generateStrokeCode,
  getDaemonToken,
  getFigmaClient,
  getFigmaPath,
  getManualStartCommand,
  getTokenStatus,
  getVarName,
  handleEvalError,
  hexToRgb,
  isDaemonRunning,
  isFigmaPatched,
  isInSafeMode,
  isVarRef,
  killFigma,
  loadConfig,
  pkg,
  program,
  prompt,
  runFigmaUse,
  saveConfig,
  smartPosCode,
  startDaemon,
  startFigma,
  stopDaemon,
  unescapeShell,
  varLoadingCode
};
