#!/usr/bin/env node

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
import { FigJamClient } from './figjam-client.js';
import { FigmaClient } from './figma-client.js';
import * as apiDocs from './api-docs.js';
import { isPatched, patchFigma, unpatchFigma, getFigmaCommand, getCdpPort, getFigmaBinaryPath } from './figma-patch.js';
import { listComponents, getComponent, getAllComponents, VISUAL_COMPONENTS } from './shadcn.js';
import { listBlocks, getBlock } from './blocks/index.js';
import { extractGradient, extractMesh, buildMeshFromColors, buildFigmaPaint, buildCssString } from './gradient-extractor.js';
import {
  nullDevice, killPort, getPortPid, sleepAfterStop,
  startFigmaApp, killFigmaApp,
  getFigmaVersion, isFigmaRunning, platformName
} from './platform.js';

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

// Check if daemon is running (returns object with details, or false)
function isDaemonRunning(returnDetails = false) {
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
    return statusCode === '200';
  } catch (e) {
    if (returnDetails) {
      return {
        running: false,
        error: e.message,
        hasToken: !!getDaemonToken()
      };
    }
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

// Fast eval via daemon (falls back to direct connection)
async function fastEval(code) {
  // Try daemon first
  if (isDaemonRunning()) {
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
  // Try daemon first
  if (isDaemonRunning()) {
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

  const daemonScript = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
  const child = spawn('node', [daemonScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DAEMON_PORT: String(DAEMON_PORT), DAEMON_MODE: mode }
  });
  child.unref();

  // Save PID
  writeFileSync(DAEMON_PID_FILE, String(child.pid));
  return true;
}

// Stop daemon
function stopDaemon() {
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const CONFIG_DIR = join(homedir(), '.figma-ds-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const program = new Command();

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
    await _figmaClient.connect();
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

  // Use file:// URL for ESM import (cross-platform)
  const clientUrl = pathToFileURL(join(process.cwd(), 'src/figma-client.js')).href;
  const resultPath = resultFile.replace(/\\/g, '\\\\');

  const script = `
    import { FigmaClient } from '${clientUrl}';
    import { writeFileSync } from 'fs';

    (async () => {
      try {
        const client = new FigmaClient();
        await client.connect();
        const result = await client.eval(${JSON.stringify(code)});
        writeFileSync('${resultPath}', JSON.stringify({ success: true, result }));
        client.close();
      } catch (e) {
        writeFileSync('${resultPath}', JSON.stringify({ success: false, error: e.message }));
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
      const col = figma.variables.createVariableCollection('${name}');
      col.id
    `);
    if (!options.silent) console.log(chalk.green('✓ Created collection: ' + name));
    return result;
  }

  if (args.startsWith('variable find ')) {
    const pattern = args.replace('variable find ', '').replace(/"/g, '');
    const result = figmaEvalSync(`(async () => {
      const pattern = '${pattern}'.replace('*', '.*');
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
      const node = await figma.getNodeByIdAsync('${nodeId}');
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
      code: `${nodeVar}.${property} = [boundFill(vars['${varName}'])];`,
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
      code: `${nodeVar}.strokes = [boundFill(vars['${varName}'])]; ${nodeVar}.strokeWeight = ${weight};`,
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

program
  .name('figma-ds-cli')
  .description('CLI for managing Figma design systems')
  .version(pkg.version);

// Top-level shortcut: `figma-cli import <file>` — auto-detects what the file
// is and routes to the right importer. Today: DESIGN.md (figma extraction
// format) is the only recognized type, but the dispatcher leaves room for
// other formats (tokens.json, .figmavars, etc.) without breaking the UX.
program
  .command('import <file>')
  .description('Auto-import a design file. Currently supports DESIGN.md (Figma extraction format).')
  .option('-c, --collection <name>', 'Collection name (DESIGN.md only)')
  .option('--print-context', 'Print figmachat context summary without creating variables')
  .action(async (file, options) => {
    const fs = await import('fs');
    if (!fs.existsSync(file)) {
      console.error(chalk.red('✗'), `not found: ${file}`);
      process.exit(1);
    }
    // Sniff the file. We don't trust the extension alone — a `.md` that
    // doesn't have the machine-readable token block isn't a design system.
    // The block usually sits at the END of the file, so read the whole thing
    // (these files are typically a few hundred KB max — cheap).
    const content = fs.readFileSync(file, 'utf-8');
    // Format A: YAML frontmatter with `colors:` / `typography:` (Stitch / getdesign.md style)
    const hasFrontmatterTokens = /^---\s*\n[\s\S]*?(^colors:|^color:|^typography:)/m.test(content);
    // Format B: our DESIGN.md extraction with `## Machine-readable tokens` JSON block
    const hasJsonBlock = /```json\s+design-tokens/.test(content) || /^##\s+\d+\.\s+Machine-readable tokens/m.test(content);
    const isDesignMd = hasFrontmatterTokens || hasJsonBlock;
    if (isDesignMd) {
      // Forward to the existing implementation via Commander's own machinery.
      const args = ['tokens', 'import-design-md', file];
      if (options.collection) args.push('-c', options.collection);
      if (options.printContext) args.push('--print-context');
      await program.parseAsync(args, { from: 'user' });
      return;
    }
    console.error(chalk.red('✗'), `Unrecognized format: ${file}`);
    console.error(chalk.yellow('  Currently `figma-cli import` understands:'));
    console.error('    • DESIGN.md (must contain "## Machine-readable tokens" + `json design-tokens` block)');
    console.error(chalk.gray('  For other formats use the dedicated importers:'));
    console.error(chalk.gray('    figma-cli tokens import <file.json>   (raw JSON tokens)'));
    process.exit(1);
  });

// Default action when no command is given
program.action(async () => {
  // If user passed an unknown subcommand as first arg, suggest from API docs
  const argv = process.argv.slice(2);
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const attempted = argv[0];
    console.error(chalk.red(`✗ unknown command: ${attempted}\n`));
    apiDocs.suggest(attempted);
    process.exit(1);
  }

  const config = loadConfig();

  // First time? Run init
  if (!config.patched) {
    showBanner();
    console.log(chalk.white('  Welcome! Let\'s get you set up.\n'));
    console.log(chalk.gray('  This takes about 30 seconds. No API key needed.\n'));

    // Step 1: Check Node version
    console.log(chalk.blue('Step 1/3: ') + 'Checking Node.js...');
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor < 18) {
      console.log(chalk.red(`  ✗ Node.js ${nodeVersion} is too old. Please upgrade to Node 18+`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Node.js ${nodeVersion}`));

    // Step 2: Patch Figma
    console.log(chalk.blue('\nStep 2/3: ') + 'Patching Figma Desktop...');
    if (config.patched) {
      console.log(chalk.green('  ✓ Figma already patched'));
    } else {
      console.log(chalk.gray('  (This allows CLI to connect to Figma)'));
      const spinner = ora('  Patching...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma already patched');
        } else if (patchStatus === false) {
          patchFigma();
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma patched');
        } else {
          // Can't determine - assume it's fine (old Figma version)
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma ready (no patch needed)');
        }
      } catch (error) {
        spinner.fail('Patch failed: ' + error.message);
        if ((error.message.includes('EPERM') || error.message.includes('permission') || error.message.includes('Full Disk Access')) && process.platform === 'darwin') {
          console.log(chalk.yellow('\n  ⚠️  Your Terminal needs "Full Disk Access" permission.\n'));
          console.log(chalk.gray('  1. Open System Settings → Privacy & Security → Full Disk Access'));
          console.log(chalk.gray('  2. Click + and add your Terminal app'));
          console.log(chalk.gray('  3. Quit Terminal completely (Cmd+Q)'));
          console.log(chalk.gray('  4. Reopen Terminal and try again\n'));
        } else if (error.message.includes('EPERM') || error.message.includes('permission')) {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
        }
      }
    }

    // Step 3: Start Figma
    console.log(chalk.blue('\nStep 3/3: ') + 'Starting Figma...');
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 1000));
      startFigma();
      console.log(chalk.green('  ✓ Figma started'));

      // Wait for connection
      const spinner = ora('  Waiting for connection...').start();
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        connected = await FigmaClient.isConnected();
        if (connected) break;
      }

      if (connected) {
        spinner.succeed('Connected to Figma');
      } else {
        spinner.warn('Connection pending - open a file in Figma');
      }
    } catch (error) {
      console.log(chalk.yellow('  ! Could not start Figma automatically'));
      console.log(chalk.gray('    Start manually: ' + getManualStartCommand()));
    }

    // Done!
    console.log(chalk.green('\n  ✓ Setup complete!\n'));
    showQuickStart();
    return;
  }

  // Already set up - check connection and show status
  showBanner();

  const connected = await FigmaClient.isConnected();
  if (connected) {
    console.log(chalk.green('  ✓ Connected to Figma\n'));
    try {
      const client = new FigmaClient();
      await client.connect();
      const info = await client.getPageInfo();
      console.log(chalk.gray(`  File: ${client.pageTitle.replace(' – Figma', '')}`));
      console.log(chalk.gray(`  Page: ${info.name}`));
      client.close();
    } catch {}
    console.log();
    showQuickStart();
  } else {
    console.log(chalk.yellow('  ⚠ Figma not connected\n'));
    console.log(chalk.white('  Starting Figma...'));
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 500));
      startFigma();
      console.log(chalk.green('  ✓ Figma started\n'));

      const spinner = ora('  Waiting for connection...').start();
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await FigmaClient.isConnected()) {
          spinner.succeed('Connected to Figma\n');
          showQuickStart();
          return;
        }
      }
      spinner.warn('Open a file in Figma to connect\n');
      showQuickStart();
    } catch {
      console.log(chalk.gray('  Start manually: ' + getManualStartCommand() + '\n'));
    }
  }
});

function showQuickStart() {
  console.log(chalk.white('  Just ask Claude:\n'));
  console.log(chalk.white('    "Add shadcn colors to my project"'));
  console.log(chalk.white('    "Create a blue card with rounded corners"'));
  console.log(chalk.white('    "Show me what\'s on the canvas"'));
  console.log(chalk.white('    "Export this frame as PNG"'));
  console.log();
  console.log(chalk.gray('  Learn more: ') + chalk.cyan('https://intodesignsystems.com\n'));
}

// ============ WELCOME BANNER ============

function showBanner() {
  console.log(chalk.cyan(`
  ███████╗██╗ ██████╗ ███╗   ███╗ █████╗       ██████╗ ███████╗       ██████╗██╗     ██╗
  ██╔════╝██║██╔════╝ ████╗ ████║██╔══██╗      ██╔══██╗██╔════╝      ██╔════╝██║     ██║
  █████╗  ██║██║  ███╗██╔████╔██║███████║█████╗██║  ██║███████╗█████╗██║     ██║     ██║
  ██╔══╝  ██║██║   ██║██║╚██╔╝██║██╔══██║╚════╝██║  ██║╚════██║╚════╝██║     ██║     ██║
  ██║     ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║      ██████╔╝███████║      ╚██████╗███████╗██║
  ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝       ╚═════╝╚══════╝╚═╝
`));
  console.log(chalk.white(`  Design System CLI for Figma ${chalk.gray('v' + pkg.version)}`));
  console.log(chalk.gray(`  by Sil Bormüller • intodesignsystems.com\n`));
}

// ============ INIT (Interactive Onboarding) ============

program
  .command('init')
  .description('Interactive setup wizard')
  .action(async () => {
    showBanner();

    console.log(chalk.white('  Welcome! Let\'s get you set up.\n'));
    console.log(chalk.gray('  This takes about 30 seconds. No API key needed.\n'));

    // Step 1: Check Node version
    console.log(chalk.blue('Step 1/4: ') + 'Checking Node.js...');
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor < 18) {
      console.log(chalk.red(`  ✗ Node.js ${nodeVersion} is too old. Please upgrade to Node 18+`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Node.js ${nodeVersion}`));

    // Step 2: Patch Figma
    console.log(chalk.blue('\nStep 2/3: ') + 'Patching Figma Desktop...');
    const config = loadConfig();
    if (config.patched) {
      console.log(chalk.green('  ✓ Figma already patched'));
    } else {
      console.log(chalk.gray('  (This allows CLI to connect to Figma)'));
      const spinner = ora('  Patching...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma already patched');
        } else if (patchStatus === false) {
          patchFigma();
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma patched');
        } else {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma ready (no patch needed)');
        }
      } catch (error) {
        spinner.fail('Patch failed: ' + error.message);
        if ((error.message.includes('EPERM') || error.message.includes('permission') || error.message.includes('Full Disk Access')) && process.platform === 'darwin') {
          console.log(chalk.yellow('\n  ⚠️  Your Terminal needs "Full Disk Access" permission.\n'));
          console.log(chalk.gray('  1. Open System Settings → Privacy & Security → Full Disk Access'));
          console.log(chalk.gray('  2. Click + and add your Terminal app'));
          console.log(chalk.gray('  3. Quit Terminal completely (Cmd+Q)'));
          console.log(chalk.gray('  4. Reopen Terminal and try again\n'));
        } else if (error.message.includes('EPERM') || error.message.includes('permission')) {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
        }
      }
    }

    // Step 3: Start Figma
    console.log(chalk.blue('\nStep 3/3: ') + 'Starting Figma...');
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 1000));
      startFigma();
      console.log(chalk.green('  ✓ Figma started'));

      // Wait for connection
      const spinner = ora('  Waiting for connection...').start();
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        connected = await FigmaClient.isConnected();
        if (connected) break;
      }

      if (connected) {
        spinner.succeed('Connected to Figma');
      } else {
        spinner.warn('Connection pending - open a file in Figma');
      }
    } catch (error) {
      console.log(chalk.yellow('  ! Could not start Figma automatically'));
      console.log(chalk.gray('    Start manually: ' + getManualStartCommand()));
    }

    // Done!
    console.log(chalk.green('\n  ✓ Setup complete!\n'));

    console.log(chalk.white('  Just ask Claude:\n'));
    console.log(chalk.white('    "Add shadcn colors to my project"'));
    console.log(chalk.white('    "Create a blue card with rounded corners"'));
    console.log(chalk.white('    "Show me what\'s on the canvas"'));
    console.log(chalk.white('    "Export this frame as PNG"'));
    console.log();
    console.log(chalk.gray('  Learn more: ') + chalk.cyan('https://intodesignsystems.com\n'));
  });

// ============ SETUP (alias for init) ============

program
  .command('setup')
  .description('Setup Figma for CLI access (alias for init)')
  .action(() => {
    // Redirect to init
    execSync('figma-ds-cli init', { stdio: 'inherit' });
  });

// ============ STATUS ============

program
  .command('status')
  .description('Check connection to Figma (CDP) AND the local daemon')
  .action(() => {
    // Check if first run
    const config = loadConfig();
    if (!config.patched && !checkDependencies(true)) {
      console.log(chalk.yellow('\n⚠ First time? Run the setup wizard:\n'));
      console.log(chalk.cyan('  figma-ds-cli init\n'));
      return;
    }
    figmaUse('status');
    // The CDP-side "Connected to Figma" line above only tells half the story.
    // Most CLI commands (render, set-batch, eval …) need the LOCAL daemon
    // running too. Surface its state right here so the user doesn't get a
    // misleading green check while every subsequent command fails with
    // "fetch failed".
    const daemonInfo = isDaemonRunning(true);
    if (daemonInfo && daemonInfo.running) {
      console.log(chalk.green('  ✓ Daemon running') + chalk.gray(` (port ${DAEMON_PORT})`));
    } else if (daemonInfo && daemonInfo.authFailed) {
      console.log(chalk.yellow('  ⚠ Daemon running but token mismatch (auth failed).'));
      console.log(chalk.gray('    Restart with:  figma-cli daemon restart'));
    } else {
      console.log(chalk.yellow('  ⚠ Daemon NOT running'));
      console.log(chalk.gray('    Most commands (render, set-batch, eval) will fail with "fetch failed".'));
      console.log(chalk.gray('    Start it with:  figma-cli daemon start'));
    }
  });

// ============ UNPATCH ============

program
  .command('unpatch')
  .description('Restore Figma to original state (removes remote debugging patch)')
  .action(() => {
    const spinner = ora('Checking Figma patch status...').start();

    try {
      const patchStatus = isPatched();

      if (patchStatus === false) {
        spinner.succeed('Figma is already in original state (not patched)');
        return;
      }

      if (patchStatus === null) {
        spinner.warn('Cannot determine patch status. Figma version may be incompatible.');
        return;
      }

      spinner.text = 'Restoring Figma to original state...';
      unpatchFigma();

      // Update config
      const config = loadConfig();
      config.patched = false;
      saveConfig(config);

      spinner.succeed('Figma restored to original state');
      console.log(chalk.gray('  Remote debugging is now blocked by default.'));
      console.log(chalk.gray('  Run "node src/index.js connect" to re-enable it.'));
    } catch (err) {
      spinner.fail(`Failed to unpatch: ${err.message}`);
    }
  });

// ============ CONNECT ============

program
  .command('connect')
  .description('Connect to Figma Desktop')
  .option('--safe', 'Use Safe Mode (plugin-based, no patching required)')
  .action(async (options) => {
    // Fun welcome message
    console.log(chalk.hex('#FF6B35')('\n  ✨ Hey designer! ') + chalk.white("Don't be afraid of the terminal!"));
    console.log(chalk.hex('#4ECDC4')('  🎨 Happy vibe coding! ') + chalk.gray('— Sil · ') + chalk.hex('#FF6B35')('intodesignsystems.com\n'));

    const config = loadConfig();

    // Safe Mode: Plugin-based connection (no patching, no CDP)
    if (options.safe) {
      console.log(chalk.hex('#4ECDC4')('  🔒 Safe Mode ') + chalk.gray('(plugin-based, no patching required)\n'));

      // Stop any existing daemon
      stopDaemon();

      // Start daemon in plugin mode
      const daemonSpinner = ora('Starting daemon in Safe Mode...').start();
      try {
        startDaemon(true, 'plugin');  // Force restart in plugin mode
        await new Promise(r => setTimeout(r, 1000));
        if (isDaemonRunning()) {
          daemonSpinner.succeed('Daemon running in Safe Mode');
        } else {
          daemonSpinner.fail('Daemon failed to start');
          return;
        }
      } catch (e) {
        daemonSpinner.fail('Daemon failed: ' + e.message);
        return;
      }

      // Show plugin setup instructions
      console.log(chalk.hex('#FF6B35')('\n  ┌─────────────────────────────────────────────────────┐'));
      console.log(chalk.hex('#FF6B35')('  │') + chalk.white.bold('  Setup the FigCli plugin                           ') + chalk.hex('#FF6B35')('│'));
      console.log(chalk.hex('#FF6B35')('  └─────────────────────────────────────────────────────┘\n'));

      console.log(chalk.white.bold('  ONE-TIME SETUP:\n'));
      console.log(chalk.cyan('  1. ') + chalk.white('Open Figma Desktop and any design file'));
      console.log(chalk.cyan('  2. ') + chalk.white('Go to ') + chalk.yellow('Plugins → Development → Import plugin from manifest'));
      console.log(chalk.cyan('  3. ') + chalk.white('Navigate to: ') + chalk.yellow(process.cwd() + '/plugin/manifest.json'));
      console.log(chalk.cyan('  4. ') + chalk.white('Click ') + chalk.yellow('Open') + chalk.white(' — plugin is now installed!\n'));

      console.log(chalk.white.bold('  EACH SESSION:\n'));
      console.log(chalk.cyan('  → ') + chalk.white('In Figma: ') + chalk.yellow('Plugins → Development → FigCli\n'));

      console.log(chalk.gray('  💡 Tip: Right-click plugin → "Add to toolbar" for one-click access\n'));

      // Wait for plugin connection. The daemon stays alive after we exit,
      // so the user can run commands the moment they actually launch the
      // plugin — but we still want to give them a confirmation when it
      // happens during onboarding. Bumped 30→90s after user feedback that
      // 30s wasn't enough time to find the plugin in Figma's menu.
      const pluginSpinner = ora('Waiting for plugin connection...').start();
      let pluginConnected = false;
      const PLUGIN_CONNECT_MAX_WAIT_S = 90;
      for (let i = 0; i < PLUGIN_CONNECT_MAX_WAIT_S; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const pluginToken = getDaemonToken();
          const pluginHeader = pluginToken ? ` -H "X-Daemon-Token: ${pluginToken}"` : '';
          const healthRes = execSync(`curl -s${pluginHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8' });
          const health = JSON.parse(healthRes);
          if (health.plugin) {
            pluginSpinner.succeed('Plugin connected!');
            console.log(chalk.green('\n  ✓ Ready! Safe Mode active.\n'));
            pluginConnected = true;
            break;
          }
        } catch {}
        // Hint at the halfway mark so users know they can still finish setup.
        if (i === Math.floor(PLUGIN_CONNECT_MAX_WAIT_S / 2)) {
          pluginSpinner.text = `Waiting for plugin connection (${PLUGIN_CONNECT_MAX_WAIT_S - i}s left)…`;
        }
      }

      if (!pluginConnected) {
        pluginSpinner.warn('Plugin not detected yet — daemon is still listening.');
        console.log(chalk.gray('\n  The daemon stays running in the background.'));
        console.log(chalk.gray('  Open ') + chalk.yellow('Plugins → Development → FigCli') + chalk.gray(' in Figma whenever you\'re ready —'));
        console.log(chalk.gray('  the next CLI command will connect automatically.\n'));
      }
      return;
    }

    // Yolo Mode: CDP-based connection (default)
    console.log(chalk.hex('#FF6B35')('  🚀 Yolo Mode ') + chalk.gray('(direct CDP connection)\n'));

    // Patch Figma if needed
    if (!config.patched) {
      const patchSpinner = ora('Setting up Figma connection...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          patchSpinner.succeed('Figma ready');
        } else if (patchStatus === false) {
          patchFigma();
          patchSpinner.succeed('Figma configured');
        } else {
          patchSpinner.succeed('Figma ready');
        }
        config.patched = true;
        saveConfig(config);
      } catch (err) {
        patchSpinner.fail('Setup failed');

        // macOS Full Disk Access needed
        if (process.platform === 'darwin') {
          console.log(chalk.hex('#FF6B35')('\n  ┌─────────────────────────────────────────────────────┐'));
          console.log(chalk.hex('#FF6B35')('  │') + chalk.white.bold('  One-time setup required                           ') + chalk.hex('#FF6B35')('│'));
          console.log(chalk.hex('#FF6B35')('  └─────────────────────────────────────────────────────┘\n'));

          console.log(chalk.white('  Your Terminal needs permission to configure Figma.\n'));

          console.log(chalk.cyan('  Step 1: ') + chalk.white('Open ') + chalk.yellow('System Settings'));
          console.log(chalk.cyan('  Step 2: ') + chalk.white('Go to ') + chalk.yellow('Privacy & Security → Full Disk Access'));
          console.log(chalk.cyan('  Step 3: ') + chalk.white('Click ') + chalk.yellow('+') + chalk.white(' and add ') + chalk.yellow('Terminal'));
          console.log(chalk.cyan('  Step 4: ') + chalk.white('Quit Terminal completely ') + chalk.gray('(Cmd+Q)'));
          console.log(chalk.cyan('  Step 5: ') + chalk.white('Reopen Terminal and try again\n'));

          console.log(chalk.gray('  Or use Safe Mode: ') + chalk.cyan('node src/index.js connect --safe\n'));
        } else {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
          console.log(chalk.gray('  Or use Safe Mode: ') + chalk.cyan('node src/index.js connect --safe\n'));
        }
        return;
      }
    }

    // Stop any existing daemon
    stopDaemon();

    console.log(chalk.blue('Starting Figma...'));
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 500));
    } catch {}

    startFigma();
    console.log(chalk.green('✓ Figma started\n'));

    // Wait and check connection
    const spinner = ora('Waiting for connection...').start();
    let connected = false;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const result = figmaUse('status', { silent: true });
      if (result && result.includes('Connected')) {
        spinner.succeed('Connected to Figma');
        console.log(chalk.gray(result.trim()));
        connected = true;
        break;
      }
    }

    if (!connected) {
      spinner.warn('Open a file in Figma to connect');
      return;
    }

    // Start daemon for fast commands (force restart to get fresh connection)
    const daemonSpinner = ora('Starting speed daemon...').start();
    try {
      startDaemon(true, 'auto');  // Auto mode: uses plugin if connected, otherwise CDP
      await new Promise(r => setTimeout(r, 1500));
      if (isDaemonRunning()) {
        daemonSpinner.succeed('Speed daemon running (commands are now 10x faster)');
      } else {
        daemonSpinner.warn('Daemon failed to start, commands will be slower');
      }
    } catch (e) {
      daemonSpinner.warn('Daemon failed: ' + e.message);
    }
  });

// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

variables
  .command('list')
  .description('List all variables')
  .action(() => {
    checkConnection();
    figmaUse('variable list');
  });

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN')
  .option('-v, --value <value>', 'Initial value')
  .action((name, options) => {
    checkConnection();
    const type = options.type.toUpperCase();
    const code = `(async () => {
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === '${options.collection}' || c.name === '${options.collection}');
if (!col) return 'Collection not found: ${options.collection}';
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : null;
}

const v = figma.variables.createVariable('${name}', col, '${type}');
${options.value ? `
let figmaValue = '${options.value}';
if ('${type}' === 'COLOR') figmaValue = hexToRgb('${options.value}');
else if ('${type}' === 'FLOAT') figmaValue = parseFloat('${options.value}');
else if ('${type}' === 'BOOLEAN') figmaValue = '${options.value}' === 'true';
v.setValueForMode(modeId, figmaValue);
` : ''}
return 'Created ${type.toLowerCase()} variable: ${name}';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .action((pattern) => {
    checkConnection();
    figmaUse(`variable find "${pattern}"`);
  });

variables
  .command('visualize [collection]')
  .description('Create color swatches on canvas (shadcn-style layout)')
  .action(async (collection, options) => {
    checkConnection();
    const spinner = ora('Creating color palette...').start();

    const code = `(async () => {
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const colorVars = await figma.variables.getLocalVariablesAsync('COLOR');

const targetCols = ${collection ? `collections.filter(c => c.name.toLowerCase().includes('${collection}'.toLowerCase()))` : 'collections'};
if (targetCols.length === 0) return 'No collections found';

// Skip semantic collections (they're aliases, colors already shown in primitives)
const filteredCols = targetCols.filter(c => !c.name.toLowerCase().includes('semantic'));
if (filteredCols.length === 0) return 'No color collections found (only semantic)';

let startX = 0;
figma.currentPage.children.forEach(n => {
  startX = Math.max(startX, n.x + (n.width || 0));
});
startX += 100;

let totalSwatches = 0;

// shadcn color order
const colorOrder = ['slate','gray','zinc','neutral','stone','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose','white','black'];

for (const col of filteredCols) {
  const colVars = colorVars.filter(v => v.variableCollectionId === col.id);
  if (colVars.length === 0) continue;

  // Group by prefix (handles both "blue/500" and semantic names)
  const groups = {};
  const semanticGroups = {
    'background': 'base', 'foreground': 'base', 'border': 'base', 'input': 'base', 'ring': 'base',
    'primary': 'primary', 'primary-foreground': 'primary',
    'secondary': 'secondary', 'secondary-foreground': 'secondary',
    'muted': 'muted', 'muted-foreground': 'muted',
    'accent': 'accent', 'accent-foreground': 'accent',
    'card': 'card', 'card-foreground': 'card',
    'popover': 'popover', 'popover-foreground': 'popover',
    'destructive': 'destructive', 'destructive-foreground': 'destructive',
    'chart-1': 'chart', 'chart-2': 'chart', 'chart-3': 'chart', 'chart-4': 'chart', 'chart-5': 'chart',
  };
  colVars.forEach(v => {
    const parts = v.name.split('/');
    let prefix;
    if (parts.length > 1) {
      prefix = parts[0];
    } else if (v.name.startsWith('sidebar-')) {
      prefix = 'sidebar';
    } else {
      prefix = semanticGroups[v.name] || 'other';
    }
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(v);
  });

  // Sort groups
  const semanticOrder = ['base','primary','secondary','muted','accent','card','popover','destructive','chart','sidebar'];
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    const aColorIdx = colorOrder.indexOf(a[0]);
    const bColorIdx = colorOrder.indexOf(b[0]);
    const aSemanticIdx = semanticOrder.indexOf(a[0]);
    const bSemanticIdx = semanticOrder.indexOf(b[0]);
    if (aColorIdx !== -1 && bColorIdx !== -1) return aColorIdx - bColorIdx;
    if (aColorIdx !== -1) return -1;
    if (bColorIdx !== -1) return 1;
    if (aSemanticIdx !== -1 && bSemanticIdx !== -1) return aSemanticIdx - bSemanticIdx;
    return a[0].localeCompare(b[0]);
  });

  // Create container
  const container = figma.createFrame();
  container.name = col.name;
  container.x = startX;
  container.y = 0;
  container.layoutMode = 'VERTICAL';
  container.primaryAxisSizingMode = 'AUTO';
  container.counterAxisSizingMode = 'AUTO';
  container.itemSpacing = 8;
  container.paddingTop = 32;
  container.paddingBottom = 32;
  container.paddingLeft = 32;
  container.paddingRight = 32;
  container.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  container.cornerRadius = 16;

  // Title
  const title = figma.createText();
  title.characters = col.name;
  title.fontSize = 20;
  title.fontName = { family: 'Inter', style: 'Medium' };
  title.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
  container.appendChild(title);

  // Spacer
  const spacer = figma.createFrame();
  spacer.resize(1, 16);
  spacer.fills = [];
  container.appendChild(spacer);

  const modeId = col.modes[0].modeId;
  const swatchesToBind = [];

  for (const [groupName, vars] of sortedGroups) {
    // Row container with label
    const rowContainer = figma.createFrame();
    rowContainer.name = groupName;
    rowContainer.layoutMode = 'HORIZONTAL';
    rowContainer.primaryAxisSizingMode = 'AUTO';
    rowContainer.counterAxisSizingMode = 'AUTO';
    rowContainer.itemSpacing = 16;
    rowContainer.counterAxisAlignItems = 'CENTER';
    rowContainer.fills = [];
    container.appendChild(rowContainer);

    // Label
    const label = figma.createText();
    label.characters = groupName;
    label.fontSize = 13;
    label.fontName = { family: 'Inter', style: 'Medium' };
    label.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
    label.resize(80, label.height);
    label.textAlignHorizontal = 'RIGHT';
    rowContainer.appendChild(label);

    // Swatches row
    const swatchRow = figma.createFrame();
    swatchRow.layoutMode = 'HORIZONTAL';
    swatchRow.primaryAxisSizingMode = 'AUTO';
    swatchRow.counterAxisSizingMode = 'AUTO';
    swatchRow.itemSpacing = 0;
    swatchRow.fills = [];
    swatchRow.cornerRadius = 6;
    swatchRow.clipsContent = true;
    rowContainer.appendChild(swatchRow);

    // Sort shades
    vars.sort((a, b) => {
      const aNum = parseInt(a.name.split('/').pop()) || 0;
      const bNum = parseInt(b.name.split('/').pop()) || 0;
      return aNum - bNum;
    });

    for (const v of vars) {
      const swatch = figma.createFrame();
      swatch.name = v.name;
      swatch.resize(48, 32);
      swatch.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
      swatchRow.appendChild(swatch);
      swatchesToBind.push({ swatch, variable: v, modeId });
      totalSwatches++;
    }
  }

  // Bind after appending
  for (const { swatch, variable, modeId } of swatchesToBind) {
    try {
      let value = variable.valuesByMode[modeId];
      if (value && value.type === 'VARIABLE_ALIAS') {
        const resolved = figma.variables.getVariableById(value.id);
        if (resolved) value = resolved.valuesByMode[Object.keys(resolved.valuesByMode)[0]];
      }
      if (value && value.r !== undefined) {
        swatch.fills = [figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: value.r, g: value.g, b: value.b } }, 'color', variable
        )];
      }
    } catch (e) {}
  }

  startX += container.width + 60;
}

figma.viewport.scrollAndZoomIntoView(figma.currentPage.children.slice(-filteredCols.length));
return 'Created ' + totalSwatches + ' color swatches';
})()`;

    try {
      const result = await fastEval(code);
      spinner.succeed(result || 'Created color palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(chalk.red(error.message));
    }
  });

variables
  .command('create-batch <json>')
  .description('Create multiple variables at once (faster than individual calls)')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .action((json, options) => {
    checkConnection();
    let vars;
    try {
      vars = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"name": "color/red", "type": "COLOR", "value": "#ff0000"}, ...]'));
      return;
    }
    if (!Array.isArray(vars)) {
      console.log(chalk.red('Expected JSON array'));
      return;
    }

    const code = `(async () => {
const vars = ${JSON.stringify(vars)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === '${options.collection}' || c.name === '${options.collection}');
if (!col) return 'Collection not found: ${options.collection}';
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16) / 255, g: parseInt(result[2], 16) / 255, b: parseInt(result[3], 16) / 255 } : null;
}

let created = 0;
for (const v of vars) {
  const type = (v.type || 'COLOR').toUpperCase();
  const variable = figma.variables.createVariable(v.name, col, type);
  if (v.value !== undefined) {
    let figmaValue = v.value;
    if (type === 'COLOR') figmaValue = hexToRgb(v.value);
    else if (type === 'FLOAT') figmaValue = parseFloat(v.value);
    else if (type === 'BOOLEAN') figmaValue = v.value === true || v.value === 'true';
    variable.setValueForMode(modeId, figmaValue);
  }
  created++;
}
return 'Created ' + created + ' variables';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Created ${vars.length} variables`));
  });

variables
  .command('delete-all')
  .description('Delete all local variables and collections')
  .option('-c, --collection <name>', 'Only delete variables in this collection')
  .action((options) => {
    checkConnection();
    const spinner = ora('Deleting variables...').start();

    const filterCode = options.collection
      ? `cols = cols.filter(c => c.name.includes('${options.collection}'));`
      : '';

    const code = `(async () => {
let cols = await figma.variables.getLocalVariableCollectionsAsync();
${filterCode}
let deleted = 0;
for (const col of cols) {
  const vars = await figma.variables.getLocalVariablesAsync();
  const colVars = vars.filter(v => v.variableCollectionId === col.id);
  for (const v of colVars) {
    v.remove();
    deleted++;
  }
  col.remove();
}
return 'Deleted ' + deleted + ' variables and ' + cols.length + ' collections';
})()`;

    try {
      const result = figmaEvalSync(code);
      spinner.succeed(result);
    } catch (error) {
      spinner.fail('Failed to delete variables');
      console.error(chalk.red(error.message));
    }
  });

// ============ BATCH OPERATIONS ============

program
  .command('delete-batch <nodeIds>')
  .description('Delete multiple nodes at once (comma-separated IDs or JSON array)')
  .action((nodeIds) => {
    checkConnection();
    let ids;
    try {
      ids = JSON.parse(nodeIds);
    } catch {
      ids = nodeIds.split(',').map(s => s.trim());
    }

    const code = `(async () => {
const ids = ${JSON.stringify(ids)};
let deleted = 0;
for (const id of ids) {
  const node = await figma.getNodeByIdAsync(id);
  if (node) {
    node.remove();
    deleted++;
  }
}
return 'Deleted ' + deleted + ' nodes';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Deleted nodes`));
  });

program
  .command('bind-batch <json>')
  .description('Bind variables to multiple nodes at once')
  .action((json) => {
    checkConnection();
    let bindings;
    try {
      bindings = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"nodeId": "1:234", "property": "fill", "variable": "primary/500"}, ...]'));
      return;
    }

    const code = `(async () => {
const bindings = ${JSON.stringify(bindings)};
const vars = await figma.variables.getLocalVariablesAsync();
let bound = 0;

for (const b of bindings) {
  const node = await figma.getNodeByIdAsync(b.nodeId);
  if (!node) continue;

  const variable = vars.find(v => v.name === b.variable || v.name.endsWith('/' + b.variable));
  if (!variable) continue;

  const prop = b.property.toLowerCase();

  if (prop === 'fill' && 'fills' in node && node.fills.length > 0) {
    const newFill = figma.variables.setBoundVariableForPaint(node.fills[0], 'color', variable);
    node.fills = [newFill];
    bound++;
  } else if (prop === 'stroke' && 'strokes' in node && node.strokes.length > 0) {
    const newStroke = figma.variables.setBoundVariableForPaint(node.strokes[0], 'color', variable);
    node.strokes = [newStroke];
    bound++;
  } else if (prop === 'radius' && 'cornerRadius' in node) {
    node.setBoundVariable('cornerRadius', variable);
    bound++;
  } else if (prop === 'gap' && 'itemSpacing' in node) {
    node.setBoundVariable('itemSpacing', variable);
    bound++;
  } else if (prop === 'padding' && 'paddingTop' in node) {
    node.setBoundVariable('paddingTop', variable);
    node.setBoundVariable('paddingBottom', variable);
    node.setBoundVariable('paddingLeft', variable);
    node.setBoundVariable('paddingRight', variable);
    bound++;
  }
}
return 'Bound ' + bound + ' properties';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Bound variables`));
  });

program
  .command('set-batch <json>')
  .description('Set properties on multiple nodes at once. Each entry: {id|nodeId, fill?, stroke?, strokeWidth?, radius?, opacity?, name?, visible?, x?, y?, width?, height?}. fill/stroke accept hex ("#ff0000") OR variable references ("var:primary", "var:colors/brand-blue", "var:miro:primary") — variable references stay BOUND so theme switches work later.')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this collection (same as render --collection).')
  .action(async (json, options) => {
    await checkConnection();
    let operations;
    try {
      operations = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"id": "1:234", "fill": "#ff0000" OR "var:primary", ...}, ...]'));
      return;
    }
    // Normalize id/nodeId (LLMs reach for `id`). Also tolerate `newName`/`label` for `name`.
    operations = operations.map(op => ({
      ...op,
      nodeId: op.nodeId ?? op.id,
      name: op.name ?? op.newName ?? op.label,
    }));
    const colFilter = options.collection || null;

    const code = `(async () => {
const operations = ${JSON.stringify(operations)};
const colFilter = ${JSON.stringify(colFilter)};

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16) / 255, g: parseInt(result[2], 16) / 255, b: parseInt(result[3], 16) / 255 } : null;
}

// Load the variable map once, with the same scoping rules as render.
const [allCols, allVars] = await Promise.all([
  figma.variables.getLocalVariableCollectionsAsync(),
  figma.variables.getLocalVariablesAsync(),
]);
let scoped = null;
if (colFilter) {
  const fl = colFilter.toLowerCase();
  const cols = allCols.filter(c => c.name.toLowerCase() === fl || c.name.toLowerCase().includes(fl));
  scoped = new Set(cols.map(c => c.id));
}
const shadcnIds = new Set(allCols.filter(c => c.name.startsWith('shadcn')).map(c => c.id));
const varCache = {};
const register = (v) => {
  if (!varCache[v.name]) varCache[v.name] = v;
  const slash = v.name.lastIndexOf('/');
  if (slash >= 0) {
    const tail = v.name.slice(slash + 1);
    if (tail && !varCache[tail]) varCache[tail] = v;
  }
};
const qualified = {};
for (const v of allVars) {
  const col = allCols.find(c => c.id === v.variableCollectionId);
  if (!col) continue;
  qualified[col.name.toLowerCase() + ':' + v.name] = v;
  const slash = v.name.lastIndexOf('/');
  if (slash >= 0) qualified[col.name.toLowerCase() + ':' + v.name.slice(slash + 1)] = v;
}
if (scoped) {
  for (const v of allVars) if (scoped.has(v.variableCollectionId)) register(v);
} else {
  for (const v of allVars) if (shadcnIds.has(v.variableCollectionId)) register(v);
  for (const v of allVars) if (!shadcnIds.has(v.variableCollectionId)) register(v);
}
const lookupVar = (ref) => {
  // Accept "primary", "colors/primary", "miro:primary" — return Variable or null
  if (ref.includes(':')) {
    const [cn, vn] = ref.split(':', 2);
    return qualified[cn.toLowerCase() + ':' + vn] || varCache[vn] || null;
  }
  return varCache[ref] || null;
};
const setPaintColor = (input) => {
  // Returns a Paint with a SOLID color, either hex (frozen) or variable-bound.
  if (typeof input === 'string' && input.startsWith('var:')) {
    const ref = input.slice(4);
    const v = lookupVar(ref);
    if (!v) return { _err: 'variable not found: ' + ref };
    return figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v
    );
  }
  const rgb = hexToRgb(input);
  return rgb ? { type: 'SOLID', color: rgb } : { _err: 'invalid color: ' + input };
};

let updated = 0;
const notFound = [];
const errors = [];

for (const op of operations) {
  const node = await figma.getNodeByIdAsync(op.nodeId);
  if (!node) { notFound.push(op.nodeId); continue; }
  let touched = false;

  if (op.fill !== undefined && 'fills' in node) {
    const paint = setPaintColor(op.fill);
    if (paint._err) errors.push(op.nodeId + ': ' + paint._err);
    else { node.fills = [paint]; touched = true; }
  }
  if (op.stroke !== undefined && 'strokes' in node) {
    const paint = setPaintColor(op.stroke);
    if (paint._err) errors.push(op.nodeId + ': ' + paint._err);
    else { node.strokes = [paint]; touched = true; }
  }
  if (op.strokeWidth !== undefined && 'strokeWeight' in node) { node.strokeWeight = op.strokeWidth; touched = true; }
  if (op.radius !== undefined && 'cornerRadius' in node) { node.cornerRadius = op.radius; touched = true; }
  if (op.opacity !== undefined && 'opacity' in node) { node.opacity = op.opacity; touched = true; }
  if (op.name && 'name' in node) { node.name = op.name; touched = true; }
  if (op.visible !== undefined && 'visible' in node) { node.visible = op.visible; touched = true; }
  if (op.x !== undefined) { node.x = op.x; touched = true; }
  if (op.y !== undefined) { node.y = op.y; touched = true; }
  if (op.width !== undefined && op.height !== undefined && 'resize' in node) {
    node.resize(op.width, op.height); touched = true;
  }
  if (touched) updated++;
}
return { updated, notFound, errors };
})()`;

    try {
      const r = await daemonExec('eval', { code });
      const data = typeof r === 'string' ? (() => { try { return JSON.parse(r); } catch { return null; } })() : r;
      if (data && typeof data === 'object' && 'updated' in data) {
        console.log(chalk.green(`✓ Updated ${data.updated} node(s)`));
        if (data.notFound && data.notFound.length) {
          console.log(chalk.yellow(`  ⚠ ${data.notFound.length} ID(s) not found: ${data.notFound.join(', ')}`));
        }
        if (data.errors && data.errors.length) {
          for (const e of data.errors) console.log(chalk.yellow('  ⚠ ' + e));
        }
      } else {
        console.log(chalk.green(r || `✓ Updated nodes`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

program
  .command('rename-batch <json>')
  .description('Rename multiple nodes at once. Accepts [{id|nodeId,name}, …] or {"<id>": "<name>", …}.')
  .action((json) => {
    checkConnection();
    let renames;
    try {
      renames = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"id": "1:234", "name": "New Name"}, ...] or {"1:234": "New Name", ...}'));
      return;
    }

    // Support both array and object format. Array form: accept BOTH "id" and
    // "nodeId" as the ID key — LLMs reach for "id" more naturally and were
    // silently getting 0 renames before.
    let pairs;
    if (Array.isArray(renames)) {
      pairs = renames.map(r => ({ id: r.id ?? r.nodeId, name: r.name ?? r.newName }));
    } else {
      pairs = Object.entries(renames).map(([id, name]) => ({ id, name }));
    }
    const missing = pairs.filter(p => !p.id || !p.name);
    if (missing.length) {
      console.log(chalk.red(`✗ ${missing.length} entr${missing.length === 1 ? 'y is' : 'ies are'} missing id or name. Expected each entry to have both.`));
      return;
    }

    const code = `(async () => {
const pairs = ${JSON.stringify(pairs)};
let renamed = 0;
const notFound = [];
for (const p of pairs) {
  const node = await figma.getNodeByIdAsync(p.id);
  if (node) {
    node.name = p.name;
    renamed++;
  } else {
    notFound.push(p.id);
  }
}
return { renamed, notFound };
})()`;

    const result = figmaEvalSync(code);
    let parsed;
    try { parsed = typeof result === 'string' ? JSON.parse(result.trim()) : result; } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      console.log(chalk.green(`✓ Renamed ${parsed.renamed} node(s)`));
      if (parsed.notFound && parsed.notFound.length) {
        console.log(chalk.yellow(`  ⚠ ${parsed.notFound.length} ID(s) not found: ${parsed.notFound.join(', ')}`));
      }
    } else {
      console.log(chalk.green(result || `✓ Renamed nodes`));
    }
  });

// ============ DAEMON ============

const daemon = program
  .command('daemon')
  .description('Manage the speed daemon');

daemon
  .command('status')
  .description('Check if daemon is running')
  .option('--debug', 'Show detailed token and connection info')
  .action((options) => {
    const details = isDaemonRunning(true);
    const tokenStatus = getTokenStatus();

    if (options.debug) {
      console.log(chalk.bold('\nDaemon Status'));
      console.log(chalk.gray('─'.repeat(50)));

      // Connection status
      if (details.running) {
        console.log(chalk.green('✓ Daemon:    ') + 'Running on port ' + DAEMON_PORT);
      } else if (details.authFailed) {
        console.log(chalk.red('✗ Daemon:    ') + 'Running but authentication failed (403)');
      } else if (details.error) {
        console.log(chalk.yellow('○ Daemon:    ') + 'Not responding');
      } else {
        console.log(chalk.yellow('○ Daemon:    ') + 'Not running');
      }

      // Token status
      console.log();
      console.log(chalk.bold('Token Info'));
      console.log(chalk.gray('  Config dir:   ') + tokenStatus.configDir);
      console.log(chalk.gray('  Token file:   ') + tokenStatus.tokenPath);
      console.log(chalk.gray('  Dir exists:   ') + (tokenStatus.configDirExists ? chalk.green('Yes') : chalk.red('No')));
      console.log(chalk.gray('  File exists:  ') + (tokenStatus.tokenFileExists ? chalk.green('Yes') : chalk.red('No')));

      if (tokenStatus.tokenPreview) {
        console.log(chalk.gray('  Token:        ') + tokenStatus.tokenPreview);
      } else if (tokenStatus.readError) {
        console.log(chalk.red('  Read error:   ') + tokenStatus.readError);
      }

      // Troubleshooting
      if (details.authFailed) {
        console.log();
        console.log(chalk.yellow('⚠ Token mismatch detected'));
        console.log(chalk.gray('  The daemon has a different token than the CLI.'));
        console.log(chalk.gray('  Fix: ') + chalk.cyan('node src/index.js daemon restart'));
      } else if (!tokenStatus.tokenFileExists && !details.running) {
        console.log();
        console.log(chalk.yellow('⚠ No token file found'));
        console.log(chalk.gray('  Fix: ') + chalk.cyan('node src/index.js connect'));
      }

      console.log();
    } else {
      // Simple output
      if (details.running) {
        console.log(chalk.green('✓ Daemon is running on port ' + DAEMON_PORT));
      } else if (details.authFailed) {
        console.log(chalk.red('✗ Daemon running but auth failed (token mismatch)'));
        console.log(chalk.gray('  Fix: node src/index.js daemon restart'));
        console.log(chalk.gray('  Debug: node src/index.js daemon status --debug'));
      } else {
        console.log(chalk.yellow('○ Daemon is not running'));
        console.log(chalk.gray('  Run "node src/index.js connect" to start it'));
      }
    }
  });

daemon
  .command('start')
  .description('Start the daemon manually')
  .option('--force', 'Force restart even if already running')
  .action(async (options) => {
    const details = isDaemonRunning(true);

    if (details.running && !options.force) {
      console.log(chalk.green('✓ Daemon already running'));
      return;
    }

    if (details.authFailed) {
      console.log(chalk.yellow('⚠ Daemon running but auth failed, forcing restart...'));
      options.force = true;
    }

    console.log(chalk.blue('Starting daemon...'));
    startDaemon(options.force, 'auto');
    await new Promise(r => setTimeout(r, 1500));

    const newDetails = isDaemonRunning(true);
    if (newDetails.running) {
      console.log(chalk.green('✓ Daemon started on port ' + DAEMON_PORT));
    } else if (newDetails.authFailed) {
      console.log(chalk.red('✗ Daemon started but auth failed'));
      console.log(chalk.gray('  Run: node src/index.js daemon diagnose'));
    } else {
      console.log(chalk.red('✗ Failed to start daemon'));
      console.log(chalk.gray('  Run: node src/index.js daemon diagnose'));
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    console.log(chalk.blue('Stopping daemon...'));
    stopDaemon();
    console.log(chalk.green('✓ Daemon stopped'));
  });

daemon
  .command('restart')
  .description('Restart the daemon (regenerates token)')
  .action(async () => {
    console.log(chalk.blue('Restarting daemon...'));
    // Use forceRestart=true to ensure clean restart with new token
    startDaemon(true, 'auto');
    await new Promise(r => setTimeout(r, 1500));

    const details = isDaemonRunning(true);
    if (details.running) {
      console.log(chalk.green('✓ Daemon restarted with fresh token'));
    } else if (details.authFailed) {
      console.log(chalk.red('✗ Daemon running but auth failed'));
      console.log(chalk.gray('  Try: node src/index.js daemon diagnose'));
    } else {
      console.log(chalk.red('✗ Failed to restart daemon'));
      console.log(chalk.gray('  Try: node src/index.js daemon diagnose'));
    }
  });

daemon
  .command('reconnect')
  .description('Reconnect to Figma (use if connection is stale)')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log(chalk.yellow('○ Daemon is not running'));
      console.log(chalk.gray('  Run "figma-ds-cli connect" first'));
      return;
    }
    console.log(chalk.blue('Reconnecting to Figma...'));
    try {
      const reconnToken = getDaemonToken();
      const reconnHeaders = {};
      if (reconnToken) reconnHeaders['X-Daemon-Token'] = reconnToken;
      const response = await fetch(`http://localhost:${DAEMON_PORT}/reconnect`, { headers: reconnHeaders });
      const result = await response.json();
      if (result.error) {
        console.log(chalk.red('✗ Reconnect failed: ' + result.error));
      } else {
        console.log(chalk.green('✓ Reconnected to Figma'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

daemon
  .command('diagnose')
  .description('Diagnose daemon connection issues')
  .action(async () => {
    console.log(chalk.bold('\n🔍 Daemon Diagnostics\n'));

    const tokenStatus = getTokenStatus();
    const details = isDaemonRunning(true);

    // Step 1: Check token file
    console.log(chalk.bold('1. Token File'));
    console.log(chalk.gray('   Path: ') + tokenStatus.tokenPath);

    if (!tokenStatus.configDirExists) {
      console.log(chalk.red('   ✗ Config directory does not exist'));
      console.log(chalk.gray('     Fix: Run "node src/index.js connect"'));
    } else if (!tokenStatus.tokenFileExists) {
      console.log(chalk.red('   ✗ Token file does not exist'));
      console.log(chalk.gray('     Fix: Run "node src/index.js connect"'));
    } else if (tokenStatus.readError) {
      console.log(chalk.red('   ✗ Cannot read token: ' + tokenStatus.readError));
    } else {
      console.log(chalk.green('   ✓ Token exists: ') + tokenStatus.tokenPreview);
    }

    // Step 2: Check if port is in use
    console.log();
    console.log(chalk.bold('2. Port ' + DAEMON_PORT));

    let portPid = null;
    try {
      portPid = getPortPid(DAEMON_PORT);
    } catch {}

    if (portPid) {
      console.log(chalk.green('   ✓ Port in use by PID: ') + portPid);

      // Check if it matches our PID file
      let savedPid = null;
      try {
        savedPid = readFileSync(DAEMON_PID_FILE, 'utf8').trim();
      } catch {}

      if (savedPid && savedPid === portPid) {
        console.log(chalk.green('   ✓ PID matches saved daemon PID'));
      } else if (savedPid) {
        console.log(chalk.yellow('   ⚠ PID mismatch! Saved: ' + savedPid + ', Actual: ' + portPid));
        console.log(chalk.gray('     This may cause auth issues. Fix: "node src/index.js daemon restart"'));
      }
    } else {
      console.log(chalk.yellow('   ○ Port not in use (daemon not running)'));
    }

    // Step 3: Test authentication
    console.log();
    console.log(chalk.bold('3. Authentication'));

    if (!details.running && !details.authFailed) {
      console.log(chalk.yellow('   ○ Daemon not responding, cannot test auth'));
    } else if (details.authFailed) {
      console.log(chalk.red('   ✗ Auth failed (403 Unauthorized)'));
      console.log(chalk.gray('     The daemon has a different token than the CLI.'));
      console.log(chalk.gray('     This happens when the daemon was started with an old token.'));
      console.log(chalk.gray('     Fix: "node src/index.js daemon restart"'));
    } else if (details.running) {
      console.log(chalk.green('   ✓ Authentication successful'));
    }

    // Step 4: Test eval
    console.log();
    console.log(chalk.bold('4. Eval Test'));

    if (details.running) {
      try {
        const result = await daemonExec('eval', { code: 'return "pong"' }, 5000);
        if (result === 'pong') {
          console.log(chalk.green('   ✓ Eval working: ping → pong'));
        } else {
          console.log(chalk.yellow('   ⚠ Unexpected result: ' + JSON.stringify(result)));
        }
      } catch (e) {
        console.log(chalk.red('   ✗ Eval failed: ' + e.message.split('\n')[0]));
      }
    } else {
      console.log(chalk.yellow('   ○ Skipped (daemon not running)'));
    }

    // Summary
    console.log();
    console.log(chalk.gray('─'.repeat(50)));

    if (details.running) {
      console.log(chalk.green('✓ Daemon is healthy'));
    } else if (details.authFailed) {
      console.log(chalk.red('✗ Token mismatch - run: node src/index.js daemon restart'));
    } else if (!tokenStatus.tokenFileExists) {
      console.log(chalk.red('✗ No token - run: node src/index.js connect'));
    } else {
      console.log(chalk.yellow('○ Daemon not running - run: node src/index.js connect'));
    }

    console.log();
  });

// ============ COLLECTIONS ============

const collections = program
  .command('collections')
  .alias('col')
  .description('Manage variable collections');

collections
  .command('list')
  .description('List all collections')
  .action(() => {
    checkConnection();
    figmaUse('collection list');
  });

collections
  .command('create <name>')
  .description('Create a collection')
  .action((name) => {
    checkConnection();
    figmaUse(`collection create "${name}"`);
  });

// ============ TOKENS (PRESETS) ============

const tokens = program
  .command('tokens')
  .description('Create design token presets');

tokens
  .command('tailwind')
  .description('Create Tailwind CSS color palette')
  .option('-c, --collection <name>', 'Collection name', 'Color - Primitive')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating Tailwind color palette...').start();

    const tailwindColors = {
      slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
      zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
      stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
      red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
      orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
      amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
      yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
      lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
      green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
      emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
      teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
      cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
      sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
      blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
      violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
      purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
      fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
      pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
      rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' }
    };

    const code = `(async () => {
const colors = ${JSON.stringify(tailwindColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return 'Created ' + count + ' color variables in ${options.collection}';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created Tailwind palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(error.message);
    }
  });

tokens
  .command('preset <name>')
  .description('Add color presets: shadcn, radix')
  .action(async (preset) => {
    checkConnection();

    const presetLower = preset.toLowerCase();

    if (presetLower === 'shadcn') {
      // shadcn/ui colors: primitives + semantic tokens (Light/Dark)
      const spinner = ora('Adding shadcn colors...').start();

      // Tailwind primitives (same as shadcn uses)
      const primitives = {
        slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
        gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
        zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
        neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
        stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
        red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
        orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
        amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
        yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
        lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
        green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
        emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
        teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
        cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
        sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
        blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
        indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
        violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
        purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
        fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
        pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
        rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' },
        white: { DEFAULT: '#ffffff' },
        black: { DEFAULT: '#000000' }
      };

      // Semantic tokens with Light/Dark mode values (references to primitives)
      // Based on shadcn/ui default zinc theme
      const semanticTokens = {
        'background':           { light: 'white',  dark: 'zinc/950' },
        'foreground':           { light: 'zinc/950',       dark: 'zinc/50' },
        'card':                 { light: 'white',  dark: 'zinc/950' },
        'card-foreground':      { light: 'zinc/950',       dark: 'zinc/50' },
        'popover':              { light: 'white',  dark: 'zinc/950' },
        'popover-foreground':   { light: 'zinc/950',       dark: 'zinc/50' },
        'primary':              { light: 'zinc/900',       dark: 'zinc/50' },
        'primary-foreground':   { light: 'zinc/50',        dark: 'zinc/900' },
        'secondary':            { light: 'zinc/100',       dark: 'zinc/800' },
        'secondary-foreground': { light: 'zinc/900',       dark: 'zinc/50' },
        'muted':                { light: 'zinc/100',       dark: 'zinc/800' },
        'muted-foreground':     { light: 'zinc/500',       dark: 'zinc/400' },
        'accent':               { light: 'zinc/100',       dark: 'zinc/800' },
        'accent-foreground':    { light: 'zinc/900',       dark: 'zinc/50' },
        'destructive':          { light: 'red/500',        dark: 'red/900' },
        'destructive-foreground': { light: 'zinc/50',      dark: 'zinc/50' },
        'border':               { light: 'zinc/200',       dark: 'zinc/800' },
        'input':                { light: 'zinc/200',       dark: 'zinc/800' },
        'ring':                 { light: 'zinc/950',       dark: 'zinc/300' },
        'chart-1':              { light: 'orange/500',     dark: 'blue/500' },
        'chart-2':              { light: 'teal/500',       dark: 'emerald/500' },
        'chart-3':              { light: 'blue/500',       dark: 'amber/500' },
        'chart-4':              { light: 'amber/500',      dark: 'rose/500' },
        'chart-5':              { light: 'rose/500',       dark: 'violet/500' },
        'sidebar-background':   { light: 'zinc/50',        dark: 'zinc/950' },
        'sidebar-foreground':   { light: 'zinc/900',       dark: 'zinc/50' },
        'sidebar-primary':      { light: 'zinc/900',       dark: 'zinc/50' },
        'sidebar-primary-foreground': { light: 'zinc/50', dark: 'zinc/900' },
        'sidebar-accent':       { light: 'zinc/100',       dark: 'zinc/800' },
        'sidebar-accent-foreground': { light: 'zinc/900', dark: 'zinc/50' },
        'sidebar-border':       { light: 'zinc/200',       dark: 'zinc/800' },
        'sidebar-ring':         { light: 'zinc/950',       dark: 'zinc/300' }
      };

      const code = `(async () => {
const primitives = ${JSON.stringify(primitives)};
const semanticTokens = ${JSON.stringify(semanticTokens)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 } : null;
}

// Step 1: Create primitives collection
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let primCol = cols.find(c => c.name === 'shadcn/primitives');
if (!primCol) primCol = figma.variables.createVariableCollection('shadcn/primitives');
const primModeId = primCol.modes[0].modeId;

// Create primitive variables
const existingVars = await figma.variables.getLocalVariablesAsync('COLOR');
const primVarMap = {};
let primCount = 0;

for (const [colorName, shades] of Object.entries(primitives)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const varName = shade === 'DEFAULT' ? colorName : colorName + '/' + shade;
    let v = existingVars.find(ev => ev.name === varName && ev.variableCollectionId === primCol.id);
    if (!v) {
      v = figma.variables.createVariable(varName, primCol, 'COLOR');
      v.setValueForMode(primModeId, hexToRgb(hex));
      primCount++;
    }
    primVarMap[varName] = v;
  }
}

// Step 2: Create semantic collection with Light/Dark modes
let semCol = cols.find(c => c.name === 'shadcn/semantic');
if (!semCol) semCol = figma.variables.createVariableCollection('shadcn/semantic');

// Ensure we have Light and Dark modes
let lightModeId = semCol.modes.find(m => m.name === 'Light')?.modeId;
let darkModeId = semCol.modes.find(m => m.name === 'Dark')?.modeId;

if (!lightModeId) {
  semCol.renameMode(semCol.modes[0].modeId, 'Light');
  lightModeId = semCol.modes[0].modeId;
}
if (!darkModeId) {
  darkModeId = semCol.addMode('Dark');
}

// Create semantic variables with aliases
let semCount = 0;
for (const [name, refs] of Object.entries(semanticTokens)) {
  let v = existingVars.find(ev => ev.name === name && ev.variableCollectionId === semCol.id);
  if (!v) {
    v = figma.variables.createVariable(name, semCol, 'COLOR');
    semCount++;
  }

  // Set Light mode (alias to primitive)
  const lightPrim = primVarMap[refs.light];
  if (lightPrim) {
    v.setValueForMode(lightModeId, { type: 'VARIABLE_ALIAS', id: lightPrim.id });
  }

  // Set Dark mode (alias to primitive)
  const darkPrim = primVarMap[refs.dark];
  if (darkPrim) {
    v.setValueForMode(darkModeId, { type: 'VARIABLE_ALIAS', id: darkPrim.id });
  }
}

return 'Created ' + primCount + ' primitives + ' + semCount + ' semantic tokens (Light/Dark)';
})()`;

      try {
        const result = await fastEval(code);
        spinner.succeed(result || 'Added shadcn colors');
        console.log(chalk.gray('\n  Collections created:'));
        console.log(chalk.gray('    • shadcn/primitives - 244 color primitives'));
        console.log(chalk.gray('    • shadcn/semantic   - 32 semantic tokens (Light/Dark mode)\n'));
        console.log(chalk.gray('  Usage: Apply "Light" or "Dark" mode to any frame'));
      } catch (error) {
        spinner.fail('Failed to add shadcn');
        console.error(chalk.red(error.message));
      }

    } else if (presetLower === 'radix') {
      // Radix UI Colors - 12 color families with 12 steps each
      const spinner = ora('Adding Radix UI colors...').start();

      const radixColors = {
        gray: { 1: '#fcfcfc', 2: '#f9f9f9', 3: '#f0f0f0', 4: '#e8e8e8', 5: '#e0e0e0', 6: '#d9d9d9', 7: '#cecece', 8: '#bbbbbb', 9: '#8d8d8d', 10: '#838383', 11: '#646464', 12: '#202020' },
        slate: { 1: '#fcfcfd', 2: '#f9f9fb', 3: '#f0f0f3', 4: '#e8e8ec', 5: '#e0e1e6', 6: '#d9d9e0', 7: '#cdced6', 8: '#b9bbc6', 9: '#8b8d98', 10: '#80838d', 11: '#60646c', 12: '#1c2024' },
        red: { 1: '#fffcfc', 2: '#fff7f7', 3: '#feebec', 4: '#ffdbdc', 5: '#ffcdce', 6: '#fdbdbe', 7: '#f4a9aa', 8: '#eb8e90', 9: '#e5484d', 10: '#dc3e42', 11: '#ce2c31', 12: '#641723' },
        orange: { 1: '#fefcfb', 2: '#fff7ed', 3: '#ffefd6', 4: '#ffdfb5', 5: '#ffd19a', 6: '#ffc182', 7: '#f5ae73', 8: '#ec9455', 9: '#f76b15', 10: '#ef5f00', 11: '#cc4e00', 12: '#582d1d' },
        amber: { 1: '#fefdfb', 2: '#fefbe9', 3: '#fff7c2', 4: '#ffee9c', 5: '#fbe577', 6: '#f3d673', 7: '#e9c162', 8: '#e2a336', 9: '#ffc53d', 10: '#ffba18', 11: '#ab6400', 12: '#4f3422' },
        yellow: { 1: '#fdfdf9', 2: '#fefce9', 3: '#fffab8', 4: '#fff394', 5: '#ffe770', 6: '#f3d768', 7: '#e4c767', 8: '#d5ae39', 9: '#ffe629', 10: '#ffdc00', 11: '#9e6c00', 12: '#473b1f' },
        green: { 1: '#fbfefc', 2: '#f4fbf6', 3: '#e6f6eb', 4: '#d6f1df', 5: '#c4e8d1', 6: '#adddc0', 7: '#8eceaa', 8: '#5bb98b', 9: '#30a46c', 10: '#2b9a66', 11: '#218358', 12: '#193b2d' },
        teal: { 1: '#fafefd', 2: '#f3fbf9', 3: '#e0f8f3', 4: '#ccf3ea', 5: '#b8eae0', 6: '#a1ded2', 7: '#83cdc1', 8: '#53b9ab', 9: '#12a594', 10: '#0d9b8a', 11: '#008573', 12: '#0d3d38' },
        cyan: { 1: '#fafdfe', 2: '#f2fafb', 3: '#def7f9', 4: '#caf1f6', 5: '#b5e9f0', 6: '#9ddde7', 7: '#7dcedc', 8: '#3db9cf', 9: '#00a2c7', 10: '#0797b9', 11: '#107d98', 12: '#0d3c48' },
        blue: { 1: '#fbfdff', 2: '#f4faff', 3: '#e6f4fe', 4: '#d5efff', 5: '#c2e5ff', 6: '#acd8fc', 7: '#8ec8f6', 8: '#5eb1ef', 9: '#0090ff', 10: '#0588f0', 11: '#0d74ce', 12: '#113264' },
        indigo: { 1: '#fdfdfe', 2: '#f7f9ff', 3: '#edf2fe', 4: '#e1e9ff', 5: '#d2deff', 6: '#c1d0ff', 7: '#abbdf9', 8: '#8da4ef', 9: '#3e63dd', 10: '#3358d4', 11: '#3a5bc7', 12: '#1f2d5c' },
        violet: { 1: '#fdfcfe', 2: '#faf8ff', 3: '#f4f0fe', 4: '#ebe4ff', 5: '#e1d9ff', 6: '#d4cafe', 7: '#c2b5f5', 8: '#aa99ec', 9: '#6e56cf', 10: '#654dc4', 11: '#6550b9', 12: '#2f265f' },
        pink: { 1: '#fffcfe', 2: '#fef7fb', 3: '#fee9f5', 4: '#fbdcef', 5: '#f6cee7', 6: '#efbfdd', 7: '#e7acd0', 8: '#dd93c2', 9: '#d6409f', 10: '#cf3897', 11: '#c2298a', 12: '#651249' }
      };

      const code = `(async () => {
const colors = ${JSON.stringify(radixColors)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 } : null;
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'radix/colors');
if (!col) col = figma.variables.createVariableCollection('radix/colors');
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync('COLOR');
let count = 0;

for (const [colorName, steps] of Object.entries(colors)) {
  for (const [step, hex] of Object.entries(steps)) {
    const varName = colorName + '/' + step;
    let v = existingVars.find(ev => ev.name === varName && ev.variableCollectionId === col.id);
    if (!v) {
      v = figma.variables.createVariable(varName, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}

return 'Created ' + count + ' Radix color variables';
})()`;

      try {
        const result = await fastEval(code);
        spinner.succeed(result || 'Added Radix UI colors');
        console.log(chalk.gray('\n  Collection created:'));
        console.log(chalk.gray('    • radix/colors - 156 colors (13 families × 12 steps)\n'));
        console.log(chalk.gray('  Colors: gray, slate, red, orange, amber, yellow,'));
        console.log(chalk.gray('          green, teal, cyan, blue, indigo, violet, pink'));
      } catch (error) {
        spinner.fail('Failed to add Radix colors');
        console.error(chalk.red(error.message));
      }

    } else if (presetLower === 'material') {
      console.log(chalk.yellow('Material Design preset coming soon!'));
      console.log(chalk.gray('Available now: shadcn, radix'));

    } else {
      console.log(chalk.red(`Unknown preset: ${preset}`));
      console.log(chalk.gray('Available presets: shadcn, radix, material (coming soon)'));
    }
  });

tokens
  .command('shadcn')
  .description('Create shadcn/ui color primitives (from v3.shadcn.com/colors)')
  .option('-c, --collection <name>', 'Collection name', 'shadcn/primitives')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating shadcn color primitives...').start();

    // All colors from https://v3.shadcn.com/colors
    const shadcnColors = {
      slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
      zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
      stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
      red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
      orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
      amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
      yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
      lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
      green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
      emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
      teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
      cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
      sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
      blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
      violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
      purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
      fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
      pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
      rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' }
    };

    const code = `(async () => {
const colors = ${JSON.stringify(shadcnColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return 'Created ' + count + ' shadcn color variables in ${options.collection}';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created shadcn primitives (231 colors)');
    } catch (error) {
      spinner.fail('Failed to create shadcn colors');
      console.error(error.message);
    }
  });

tokens
  .command('spacing')
  .description('Create spacing scale (4px base)')
  .option('-c, --collection <name>', 'Collection name', 'Spacing')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating spacing scale...').start();

    const spacings = {
      '0': 0, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10,
      '3': 12, '3.5': 14, '4': 16, '5': 20, '6': 24, '7': 28,
      '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
      '14': 56, '16': 64, '20': 80, '24': 96, '28': 112,
      '32': 128, '36': 144, '40': 160, '44': 176, '48': 192
    };

    const code = `(async () => {
const spacings = ${JSON.stringify(spacings)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(spacings)) {
  const existing = existingVars.find(v => v.name === 'spacing/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('spacing/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' spacing variables';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created spacing scale');
    } catch (error) {
      spinner.fail('Failed to create spacing scale');
    }
  });

tokens
  .command('radii')
  .description('Create border radius scale')
  .option('-c, --collection <name>', 'Collection name', 'Radii')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating border radii...').start();

    const radii = {
      'none': 0, 'sm': 2, 'default': 4, 'md': 6, 'lg': 8,
      'xl': 12, '2xl': 16, '3xl': 24, 'full': 9999
    };

    const code = `(async () => {
const radii = ${JSON.stringify(radii)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(radii)) {
  const existing = existingVars.find(v => v.name === 'radius/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('radius/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' radius variables';
})()
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created border radii');
    } catch (error) {
      spinner.fail('Failed to create radii');
    }
  });

tokens
  .command('import <file>')
  .description('Import tokens from JSON file')
  .option('-c, --collection <name>', 'Collection name')
  .option('--force-slash', 'Allow "/" in --collection (bypasses the LLM-mistake guard)')
  .action((file, options) => {
    checkConnection();
    // Guard against LLM-style mistakes: a "/" in the collection name almost
    // always means the caller split one DESIGN.md across multiple `tokens
    // import` runs (e.g. -c "stripe/colors", -c "stripe/radius"). Figma
    // treats "/" as a normal character — it does NOT nest collections — so
    // the result is fake siblings, not a hierarchy.
    if (options.collection && options.collection.includes('/')) {
      console.error(chalk.yellow(`⚠ Collection name "${options.collection}" contains "/".`));
      console.error(chalk.yellow('  Figma does not nest collections. "/" creates flat sibling collections.'));
      console.error(chalk.gray('  If this is a DESIGN.md file, use `figma-cli import <path>` instead — it imports the whole system into one collection atomically.'));
      console.error(chalk.gray('  To proceed anyway, re-run with --force-slash.'));
      if (!options.forceSlash) process.exit(1);
    }

    // Read JSON file
    let tokensData;
    try {
      const content = readFileSync(file, 'utf8');
      tokensData = JSON.parse(content);
    } catch (error) {
      console.log(chalk.red(`✗ Could not read file: ${file}`));
      process.exit(1);
    }

    const spinner = ora('Importing tokens...').start();

    // Detect format and convert
    // Support: { "colors": { "primary": "#xxx" } } or { "primary": { "value": "#xxx", "type": "color" } }
    const collectionName = options.collection || 'Imported Tokens';

    const code = `(async () => {
const data = ${JSON.stringify(tokensData)};
const collectionName = '${collectionName}';

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

function detectType(value) {
  if (typeof value === 'string' && value.startsWith('#')) return 'COLOR';
  if (typeof value === 'number') return 'FLOAT';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'STRING';
}

function flattenTokens(obj, prefix = '') {
  const result = [];
  for (const [key, val] of Object.entries(obj)) {
    const name = prefix ? prefix + '/' + key : key;
    if (val && typeof val === 'object' && !val.value && !val.type) {
      result.push(...flattenTokens(val, name));
    } else {
      const value = val?.value ?? val;
      const type = val?.type?.toUpperCase() || detectType(value);
      result.push({ name, value, type });
    }
  }
  return result;
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
const tokens = flattenTokens(data);
let count = 0;

for (const { name, value, type } of tokens) {
  // Scoped to the target collection — overlapping names across collections OK
  const existing = existingVars.find(v => v.name === name && v.variableCollectionId === col.id);
  if (!existing) {
    try {
      const figmaType = type === 'COLOR' ? 'COLOR' : type === 'FLOAT' || type === 'NUMBER' ? 'FLOAT' : type === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';
      const v = figma.variables.createVariable(name, col, figmaType);
      let figmaValue = value;
      if (figmaType === 'COLOR') figmaValue = hexToRgb(value);
      if (figmaValue !== null) {
        v.setValueForMode(modeId, figmaValue);
        count++;
      }
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
    }
  });

tokens
  .command('overlap <collections...>')
  .description('Compare token names across N local variable collections. Shows common core (switchable subset) + per-collection unique names. Useful before `figma-cli use` to know which tokens swap cleanly.')
  .option('--json', 'Output as JSON')
  .action(async (collectionNames, options) => {
    await checkConnection();
    if (collectionNames.length < 2) {
      console.error(chalk.red('✗'), 'Pass at least two collection names. Example: figma-cli tokens overlap airbnb cursor stripe');
      process.exit(1);
    }
    const code = `(async () => {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      const allVars = await figma.variables.getLocalVariablesAsync();
      const targets = ${JSON.stringify(collectionNames)};
      const resolved = [];
      const missing = [];
      for (const q of targets) {
        const ql = q.toLowerCase();
        const c = cols.find(c => c.name.toLowerCase() === ql)
              || cols.find(c => c.name.toLowerCase().includes(ql));
        if (!c) { missing.push(q); continue; }
        const names = new Set(allVars.filter(v => v.variableCollectionId === c.id).map(v => v.name));
        resolved.push({ query: q, name: c.name, names: [...names] });
      }
      if (missing.length) {
        return { error: 'collections not found: ' + missing.join(', '),
                 available: cols.map(c => c.name) };
      }
      // Intersection: names present in EVERY resolved collection
      const sets = resolved.map(r => new Set(r.names));
      const intersection = [...sets[0]].filter(n => sets.every(s => s.has(n))).sort();
      // Per-collection: unique to this collection (in this set, not in any other)
      const unique = resolved.map((r, i) => ({
        collection: r.name,
        total: r.names.length,
        only_here: r.names.filter(n => resolved.every((r2, j) => i === j || !sets[j].has(n))).sort(),
        missing_here: [...intersection.length > 0 ? new Set() : new Set()].sort(),
      }));
      // For each collection, also compute "missing here that others have"
      const allNames = new Set();
      for (const r of resolved) for (const n of r.names) allNames.add(n);
      for (let i = 0; i < unique.length; i++) {
        const have = sets[i];
        unique[i].missing_here = [...allNames].filter(n => !have.has(n)).sort();
      }
      return { collections: resolved.map(r => r.name), commonCore: intersection, perCollection: unique };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (r.error) {
        console.error(chalk.red('✗'), r.error);
        console.error(chalk.gray('  Available: ' + (r.available || []).join(', ')));
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log();
      console.log(chalk.cyan(`Comparing ${r.collections.length} collections: ${r.collections.join(', ')}`));
      console.log();
      console.log(chalk.green(`✓ Common core — ${r.commonCore.length} tokens (switch cleanly across all):`));
      if (r.commonCore.length === 0) {
        console.log(chalk.gray('  (none — no shared token names)'));
      } else {
        console.log('  ' + r.commonCore.join(', '));
      }
      console.log();
      for (const c of r.perCollection) {
        console.log(chalk.cyan(`${c.collection}`) + chalk.gray(` (${c.total} tokens)`));
        if (c.only_here.length > 0) {
          console.log(chalk.yellow(`  only here (${c.only_here.length}):`));
          console.log('    ' + c.only_here.join(', '));
        }
        if (c.missing_here.length > 0) {
          console.log(chalk.gray(`  missing here (${c.missing_here.length}) — won't switch INTO this collection:`));
          console.log(chalk.gray('    ' + c.missing_here.join(', ')));
        }
        console.log();
      }
      console.log(chalk.gray('Tip: design with the common-core tokens for cleanest theme switching.'));
    } catch (e) {
      handleEvalError(e);
    }
  });

tokens
  .command('import-design-md <file>')
  .description('Import tokens from a DESIGN.md (Figma extraction format with `## 11. Machine-readable tokens` JSON block). Creates color, radius, and typography variables. Also prints a context summary for figmachat.')
  .option('-c, --collection <name>', 'Collection name (defaults to the design system name)')
  .option('--print-context', 'Just print the figmachat context summary, do not create variables')
  .action(async (file, options) => {
    let parsed;
    try {
      const { parseDesignMd } = await import('./design-md.js');
      parsed = parseDesignMd(file);
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }

    if (options.printContext) {
      const { summarizeForLLM } = await import('./design-md.js');
      console.log(summarizeForLLM(parsed));
      return;
    }

    checkConnection();
    const { toTokensImportJson, summarizeForLLM } = await import('./design-md.js');
    const tokensData = toTokensImportJson(parsed);
    const collectionName = options.collection || parsed.meta.source || 'Imported Design System';
    const colorCount = Object.keys(tokensData.color || {}).length;
    const radiusCount = Object.keys(tokensData.radius || {}).length;
    const typoCount = Object.keys(tokensData.typography || {}).length;

    const spinner = ora(`Importing ${colorCount} colors, ${radiusCount} radii, ${typoCount} type styles from ${file}...`).start();

    const code = `(async () => {
const data = ${JSON.stringify({ ...tokensData.color, _radii: tokensData.radius })};
const collectionName = ${JSON.stringify(collectionName)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;

// Colors. Skip-check scoped to the TARGET collection so multiple design
// systems can coexist with overlapping token names (Airbnb's primary AND
// Cursor's primary, switchable via "Apply variable mode" in Figma).
for (const [name, entry] of Object.entries(data)) {
  if (name === '_radii') continue;
  const value = entry?.value ?? entry;
  const rgb = typeof value === 'string' ? hexToRgb(value) : null;
  if (!rgb) continue;
  if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
  try {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(modeId, rgb);
    count++;
  } catch (e) {}
}
// Radii
if (data._radii) {
  for (const [name, entry] of Object.entries(data._radii)) {
    const num = typeof entry === 'object' ? entry.value : entry;
    if (typeof num !== 'number') continue;
    if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
    try {
      const v = figma.variables.createVariable(name, col, 'FLOAT');
      v.setValueForMode(modeId, num);
      count++;
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = await daemonExec('eval', { code });
      spinner.succeed(result || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
      process.exit(1);
    }

    console.log();
    console.log(chalk.cyan('─── figmachat context (drop into /design) ───'));
    console.log(summarizeForLLM(parsed));
    console.log(chalk.cyan('──────────────────────────────────────────────'));
  });

tokens
  .command('ds')
  .description('Create IDS Base Design System (complete starter kit)')
  .action(async () => {
    checkConnection();

    console.log(chalk.cyan('\n  IDS Base Design System'));
    console.log(chalk.gray('  by Into Design Systems\n'));

    // IDS Base values
    const idsColors = {
      gray: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      primary: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      accent: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' }
    };

    const idsSemanticColors = {
      'background/default': '#ffffff',
      'background/muted': '#f4f4f5',
      'background/emphasis': '#18181b',
      'foreground/default': '#18181b',
      'foreground/muted': '#71717a',
      'foreground/emphasis': '#ffffff',
      'border/default': '#e4e4e7',
      'border/focus': '#3b82f6',
      'action/primary': '#3b82f6',
      'action/primary-hover': '#2563eb',
      'feedback/success': '#22c55e',
      'feedback/success-muted': '#dcfce7',
      'feedback/warning': '#f59e0b',
      'feedback/warning-muted': '#fef3c7',
      'feedback/error': '#ef4444',
      'feedback/error-muted': '#fee2e2'
    };

    const idsSpacing = {
      'xs': 4, 'sm': 8, 'md': 16, 'lg': 24, 'xl': 32, '2xl': 48, '3xl': 64
    };

    const idsTypography = {
      'size/xs': 12, 'size/sm': 14, 'size/base': 16, 'size/lg': 18,
      'size/xl': 20, 'size/2xl': 24, 'size/3xl': 30, 'size/4xl': 36,
      'weight/normal': 400, 'weight/medium': 500, 'weight/semibold': 600, 'weight/bold': 700
    };

    const idsRadii = {
      'none': 0, 'sm': 4, 'md': 8, 'lg': 12, 'xl': 16, 'full': 9999
    };

    // Create Color - Primitives
    let spinner = ora('Creating Color - Primitives...').start();
    const primitivesCode = `(async () => {
const colors = ${JSON.stringify(idsColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Color - Primitives');
if (!col) col = figma.variables.createVariableCollection('Color - Primitives');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${primitivesCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Primitives (${result?.trim() || '33'} variables)`);
    } catch { spinner.fail('Color - Primitives failed'); }

    // Create Color - Semantic
    spinner = ora('Creating Color - Semantic...').start();
    const semanticCode = `(async () => {
const colors = ${JSON.stringify(idsSemanticColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Color - Semantic');
if (!col) col = figma.variables.createVariableCollection('Color - Semantic');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, hex] of Object.entries(colors)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(modeId, hexToRgb(hex));
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${semanticCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Semantic (${result?.trim() || '13'} variables)`);
    } catch { spinner.fail('Color - Semantic failed'); }

    // Create Spacing
    spinner = ora('Creating Spacing...').start();
    const spacingCode = `(async () => {
const spacings = ${JSON.stringify(idsSpacing)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Spacing');
if (!col) col = figma.variables.createVariableCollection('Spacing');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(spacings)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${spacingCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Spacing (${result?.trim() || '7'} variables)`);
    } catch { spinner.fail('Spacing failed'); }

    // Create Typography
    spinner = ora('Creating Typography...').start();
    const typographyCode = `(async () => {
const typography = ${JSON.stringify(idsTypography)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Typography');
if (!col) col = figma.variables.createVariableCollection('Typography');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(typography)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${typographyCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Typography (${result?.trim() || '12'} variables)`);
    } catch { spinner.fail('Typography failed'); }

    // Create Border Radii
    spinner = ora('Creating Border Radii...').start();
    const radiiCode = `(async () => {
const radii = ${JSON.stringify(idsRadii)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Border Radii');
if (!col) col = figma.variables.createVariableCollection('Border Radii');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(radii)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${radiiCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Border Radii (${result?.trim() || '6'} variables)`);
    } catch { spinner.fail('Border Radii failed'); }

    // Small delay to let spinner render
    await new Promise(r => setTimeout(r, 100));

    // Summary
    console.log(chalk.green('\n  ✓ IDS Base Design System created!\n'));
    console.log(chalk.white('  Collections:'));
    console.log(chalk.gray('    • Color - Primitives (gray, primary, accent)'));
    console.log(chalk.gray('    • Color - Semantic (background, foreground, border, action, feedback)'));
    console.log(chalk.gray('    • Spacing (xs to 3xl, 4px base)'));
    console.log(chalk.gray('    • Typography (sizes + weights)'));
    console.log(chalk.gray('    • Border Radii (none to full)'));
    console.log();
    console.log(chalk.gray('  Total: ~74 variables across 5 collections\n'));
    console.log(chalk.gray('  Next: ') + chalk.cyan('figma-ds-cli tokens components') + chalk.gray(' to add UI components\n'));
  });

tokens
  .command('components')
  .description('Create IDS Base Components (Button, Input, Card, Badge)')
  .action(async () => {
    checkConnection();

    console.log(chalk.cyan('\n  IDS Base Components'));
    console.log(chalk.gray('  by Into Design Systems\n'));

    // Component colors (using IDS Base values)
    const colors = {
      primary500: '#3b82f6',
      primary600: '#2563eb',
      gray100: '#f4f4f5',
      gray200: '#e4e4e7',
      gray500: '#71717a',
      gray900: '#18181b',
      white: '#ffffff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444'
    };

    // First, clean up any existing IDS components
    let spinner = ora('Cleaning up existing components...').start();
    const cleanupCode = `
const names = ['Button / Primary', 'Button / Secondary', 'Button / Outline', 'Input', 'Card', 'Badge / Default', 'Badge / Success', 'Badge / Warning', 'Badge / Error'];
let removed = 0;
figma.currentPage.children.forEach(n => {
  if (names.includes(n.name)) { n.remove(); removed++; }
});
removed
`;
    try {
      const removed = figmaUse(`eval "${cleanupCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Cleaned up ${removed?.trim() || '0'} old elements`);
    } catch { spinner.succeed('Ready'); }

    // Step 1: Create frames using JSX render (handles fonts)
    spinner = ora('Creating frames...').start();
    const jsxComponents = [
      { jsx: `<Frame name="Button / Primary" bg="${colors.primary500}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="#ffffff">Button</Text></Frame>` },
      { jsx: `<Frame name="Button / Secondary" bg="${colors.gray100}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="${colors.gray900}">Button</Text></Frame>` },
      { jsx: `<Frame name="Button / Outline" bg="#ffffff" stroke="${colors.gray200}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="${colors.gray900}">Button</Text></Frame>` },
      { jsx: `<Frame name="Input" w={200} bg="#ffffff" stroke="${colors.gray200}" px={12} py={10} rounded={8} flex="row"><Text size={14} color="${colors.gray500}">Placeholder</Text></Frame>` },
      { jsx: `<Frame name="Card" bg="#ffffff" stroke="${colors.gray200}" p={24} rounded={12} flex="col" gap={8}><Text size={18} weight="semibold" color="${colors.gray900}">Card Title</Text><Text size={14} color="${colors.gray500}">Card description goes here.</Text></Frame>` },
      { jsx: `<Frame name="Badge / Default" bg="${colors.gray100}" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="${colors.gray900}">Badge</Text></Frame>` },
      { jsx: `<Frame name="Badge / Success" bg="#dcfce7" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#166534">Success</Text></Frame>` },
      { jsx: `<Frame name="Badge / Warning" bg="#fef3c7" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#92400e">Warning</Text></Frame>` },
      { jsx: `<Frame name="Badge / Error" bg="#fee2e2" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#991b1b">Error</Text></Frame>` }
    ];

    try {
      const client = await getFigmaClient();
      for (const { jsx } of jsxComponents) {
        await client.render(jsx);
      }
      spinner.succeed('9 frames created');
    } catch (e) { spinner.fail('Frame creation failed: ' + e.message); }

    // Step 2: Convert to components one by one with positioning
    spinner = ora('Converting to components...').start();

    const componentOrder = [
      { name: 'Button / Primary', row: 0, width: 80, varFill: 'action/primary' },
      { name: 'Button / Secondary', row: 0, width: 80, varFill: 'background/muted' },
      { name: 'Button / Outline', row: 0, width: 80, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Input', row: 0, width: 200, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Card', row: 0, width: 240, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Badge / Default', row: 1, width: 60, varFill: 'background/muted' },
      { name: 'Badge / Success', row: 1, width: 70, varFill: 'feedback/success-muted' },
      { name: 'Badge / Warning', row: 1, width: 70, varFill: 'feedback/warning-muted' },
      { name: 'Badge / Error', row: 1, width: 50, varFill: 'feedback/error-muted' }
    ];

    let row0X = 0, row1X = 0;
    const gap = 32;

    for (const comp of componentOrder) {
      const convertSingle = `
const f = figma.currentPage.children.find(n => n.name === '${comp.name}' && n.type === 'FRAME');
if (f) {
  const vars = figma.variables.getLocalVariables();
  const findVar = (name) => vars.find(v => v.name === name);
  ${comp.varFill ? `
  const vFill = findVar('${comp.varFill}');
  if (vFill && f.fills && f.fills.length > 0) {
    const fills = JSON.parse(JSON.stringify(f.fills));
    fills[0] = figma.variables.setBoundVariableForPaint(fills[0], 'color', vFill);
    f.fills = fills;
  }` : ''}
  ${comp.varStroke ? `
  const vStroke = findVar('${comp.varStroke}');
  if (vStroke && f.strokes && f.strokes.length > 0) {
    const strokes = JSON.parse(JSON.stringify(f.strokes));
    strokes[0] = figma.variables.setBoundVariableForPaint(strokes[0], 'color', vStroke);
    f.strokes = strokes;
  }` : ''}
  const c = figma.createComponentFromNode(f);
  c.x = ${comp.row === 0 ? row0X : row1X};
  c.y = ${comp.row === 0 ? 0 : 80};
}
`;
      try {
        figmaUse(`eval "${convertSingle.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
        if (comp.row === 0) row0X += comp.width + gap;
        else row1X += comp.width + 24;
      } catch {}
    }
    spinner.succeed('9 components with variables');

    await new Promise(r => setTimeout(r, 100));

    console.log(chalk.green('\n  ✓ IDS Base Components created!\n'));
    console.log(chalk.white('  Components:'));
    console.log(chalk.gray('    • Button (Primary, Secondary, Outline)'));
    console.log(chalk.gray('    • Input'));
    console.log(chalk.gray('    • Card'));
    console.log(chalk.gray('    • Badge (Default, Success, Warning, Error)'));
    console.log();
    console.log(chalk.gray('  Total: 9 components on canvas\n'));
  });

tokens
  .command('add <name> <value>')
  .description('Add a single token')
  .option('-c, --collection <name>', 'Collection name', 'Tokens')
  .option('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN (auto-detected if not set)')
  .action((name, value, options) => {
    checkConnection();

    const code = `(async () => {
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const value = '${value}';
let type = '${options.type || ''}';
if (!type) {
  if (value.startsWith('#')) type = 'COLOR';
  else if (!isNaN(parseFloat(value))) type = 'FLOAT';
  else if (value === 'true' || value === 'false') type = 'BOOLEAN';
  else type = 'STRING';
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;

const v = figma.variables.createVariable('${name}', col, type);
let figmaValue = value;
if (type === 'COLOR') figmaValue = hexToRgb(value);
else if (type === 'FLOAT') figmaValue = parseFloat(value);
else if (type === 'BOOLEAN') figmaValue = value === 'true';
v.setValueForMode(modeId, figmaValue);

return 'Created ' + type.toLowerCase() + ' token: ${name}';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      console.log(chalk.green(result?.trim() || `✓ Created token: ${name}`));
    } catch (error) {
      console.log(chalk.red(`✗ Failed to create token: ${name}`));
    }
  });

// ============ GRADIENT ============

const gradient = program
  .command('gradient')
  .description('Extract gradients from images and apply them to nodes');

gradient
  .command('extract <image>')
  .description('Extract a gradient or mesh-like gradient from an image (PNG/JPG)')
  .option('--mode <mode>', 'linear (1D, two/three-stop) or mesh (blur-stack approximation)', 'linear')
  .option('--apply-to <nodeId>', 'Apply the extracted gradient to this node. linear: sets fills. mesh: populates the frame with blur-blob children.')
  .option('--direction <dir>', '[linear] Force direction: auto|vertical|horizontal', 'auto')
  .option('--stops <n>', '[linear] Number of color stops (2, 3, or 5)', '3')
  .option('--blur <frac>', '[mesh] Blur radius as fraction of min(W, H). Default 0.38.')
  .option('--no-trim', "Don't auto-trim solid/transparent image borders")
  .option('--json', 'Output JSON instead of human-readable')
  .action(async (imagePath, options) => {
    const path = imagePath.startsWith('~')
      ? join(homedir(), imagePath.slice(1))
      : imagePath;
    if (!existsSync(path)) {
      console.error(chalk.red(`Image not found: ${path}`));
      process.exit(1);
    }

    const mode = (options.mode || 'linear').toLowerCase();
    if (mode !== 'linear' && mode !== 'mesh') {
      console.error(chalk.red(`Unknown mode "${mode}". Use linear or mesh.`));
      process.exit(1);
    }

    // ─── LINEAR mode ───
    if (mode === 'linear') {
      let result;
      try {
        result = extractGradient(path, {
          direction: options.direction,
          stops: Math.max(2, Math.min(5, parseInt(options.stops, 10) || 3)),
          trim: options.trim !== false,
        });
      } catch (e) {
        console.error(chalk.red(`Extraction failed: ${e.message}`));
        process.exit(1);
      }

      const css = buildCssString(result);
      const hexes = result.stops.map((s) =>
        '#' + s.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
      );

      if (options.json) {
        console.log(JSON.stringify({
          mode: 'linear',
          direction: result.direction,
          angle: result.angle,
          stops: result.stops.map((s, i) => ({ position: s.position, hex: hexes[i], rgb: s.rgb })),
          css,
          innerBox: result.box,
        }, null, 2));
      } else {
        console.log();
        console.log(chalk.cyan('  Gradient extracted (linear)'));
        console.log(chalk.gray('  ─────────────────────────────────────────'));
        console.log(chalk.white(`  Direction: ${result.direction} (${result.angle}deg)`));
        console.log(chalk.white(`  Stops:`));
        result.stops.forEach((s, i) => {
          const pct = Math.round(s.position * 100);
          console.log(chalk.gray(`    ${String(pct).padStart(3)}%  `) + chalk.white(hexes[i]) + chalk.gray(`  rgb(${s.rgb.join(', ')})`));
        });
        console.log(chalk.white(`  CSS:`));
        console.log(chalk.gray(`    ${css}`));
      }

      if (options.applyTo) {
        checkConnection();
        const paint = buildFigmaPaint(result);
        const code = `
          (async () => {
            await figma.loadAllPagesAsync();
            const __wantId = ${JSON.stringify(options.applyTo)};
            let __gNode;
            if (/^selected$/i.test(__wantId)) {
              __gNode = figma.currentPage.selection[0];
              if (!__gNode) throw new Error('Nothing selected in Figma');
            } else {
              __gNode = await figma.getNodeByIdAsync(__wantId);
              if (!__gNode) throw new Error('Node not found: ' + __wantId);
            }
            if (!('fills' in __gNode)) throw new Error('Node does not support fills: ' + __gNode.type);
            __gNode.fills = [${JSON.stringify(paint)}];
            return JSON.stringify({ name: __gNode.name, type: __gNode.type });
          })()
        `;
        const spinner = options.json ? null : ora('Applying gradient...').start();
        try {
          const res = await fastEval(code);
          const info = JSON.parse(res);
          if (spinner) spinner.succeed(`Applied to ${info.name} (${info.type})`);
          else if (!options.json) console.log(chalk.green(`  ✓ Applied to ${info.name}`));
        } catch (e) {
          if (spinner) spinner.fail(`Apply failed: ${e.message}`);
          else console.error(chalk.red(`Apply failed: ${e.message}`));
          process.exit(1);
        }
      }
      return;
    }

    // ─── MESH mode ───
    let recipe;
    try {
      recipe = extractMesh(path, { trim: options.trim !== false });
      if (options.blur) recipe.blurFraction = Math.max(0.05, Math.min(0.8, parseFloat(options.blur)));
    } catch (e) {
      console.error(chalk.red(`Mesh extraction failed: ${e.message}`));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(recipe, null, 2));
    } else {
      console.log();
      console.log(chalk.cyan('  Mesh gradient extracted (blur-stack recipe)'));
      console.log(chalk.gray('  ─────────────────────────────────────────'));
      console.log(chalk.white(`  Base:  `) + chalk.gray(recipe.base));
      console.log(chalk.white(`  Blobs: `) + chalk.gray(`${recipe.blobs.length} ellipses, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`));
      recipe.blobs.forEach((b, i) => {
        const pos = `(${b.fx.toFixed(2)}, ${b.fy.toFixed(2)})`;
        console.log(chalk.gray(`    ${i + 1}.  ${pos.padEnd(18)} r=${b.r.toFixed(2)}  `) + chalk.white(b.color));
      });
    }

    if (options.applyTo) {
      checkConnection();
      const code = `
        (async () => {
          await figma.loadAllPagesAsync();
          const __wantId = ${JSON.stringify(options.applyTo)};
          let __target;
          if (/^selected$/i.test(__wantId)) {
            __target = figma.currentPage.selection[0];
            if (!__target) throw new Error('Nothing selected in Figma');
          } else {
            __target = await figma.getNodeByIdAsync(__wantId);
            if (!__target) throw new Error('Node not found: ' + __wantId);
          }
          if (__target.type !== 'FRAME') throw new Error('Mesh mode requires a FRAME target; got ' + __target.type);
          const W = __target.width, H = __target.height;
          const D = Math.min(W, H);
          // Clear existing children
          for (const c of [...__target.children]) c.remove();
          __target.clipsContent = true;
          const __base = ${JSON.stringify(recipe.base)};
          const __hex = (h) => { h = h.replace('#', ''); return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 }; };
          __target.fills = [{ type:'SOLID', color: __hex(__base), opacity:1, visible:true, blendMode:'NORMAL' }];
          const __blobs = ${JSON.stringify(recipe.blobs)};
          const __blur = Math.round(D * ${recipe.blurFraction});
          for (const b of __blobs) {
            const e = figma.createEllipse();
            const R = Math.round(D * b.r);
            e.resize(R * 2, R * 2);
            e.x = b.fx * W - R;
            e.y = b.fy * H - R;
            e.fills = [{ type:'SOLID', color: __hex(b.color), opacity:1, visible:true, blendMode:'NORMAL' }];
            e.effects = [{ type:'LAYER_BLUR', radius: __blur, visible: true }];
            __target.appendChild(e);
          }
          return JSON.stringify({ name: __target.name, blobs: __blobs.length, blur: __blur });
        })()
      `;
      const spinner = options.json ? null : ora('Building blur-stack...').start();
      try {
        const res = await fastEval(code);
        const info = JSON.parse(res);
        if (spinner) spinner.succeed(`Mesh built on ${info.name} (${info.blobs} blobs, blur ${info.blur}px)`);
        else if (!options.json) console.log(chalk.green(`  ✓ Mesh built on ${info.name}`));
      } catch (e) {
        if (spinner) spinner.fail(`Apply failed: ${e.message}`);
        else console.error(chalk.red(`Apply failed: ${e.message}`));
        process.exit(1);
      }
    }
  });

gradient
  .command('mesh <colors>')
  .description('Generate a mesh-gradient wallpaper from a color palette (no image needed)')
  .option('--apply-to <frameId>', 'Populate an existing Frame instead of creating a new one')
  .option('--base <hex>', 'Base fill behind the blobs (default: palette average)')
  .option('--size <WxH>', 'Frame size for a new wallpaper', '1920x1080')
  .option('--blur <frac>', 'Blur radius as fraction of min(W, H). Default 0.42.')
  .option('--name <name>', 'Name for the created frame', 'Mesh Wallpaper')
  .option('--json', 'Output JSON instead of human-readable')
  .action(async (colorsArg, options) => {
    const colors = colorsArg.split(',').map((c) => c.trim()).filter(Boolean);
    let recipe;
    try {
      recipe = buildMeshFromColors(colors, {
        base: options.base,
        blur: options.blur != null ? Math.max(0.05, Math.min(0.8, parseFloat(options.blur))) : undefined,
      });
    } catch (e) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }

    if (!options.json) {
      console.log();
      console.log(chalk.cyan('  Mesh wallpaper recipe'));
      console.log(chalk.gray('  ─────────────────────────────────────────'));
      console.log(chalk.white(`  Base:  `) + chalk.gray(recipe.base));
      console.log(chalk.white(`  Blobs: `) + chalk.gray(`${recipe.blobs.length}, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`));
      recipe.blobs.forEach((b, i) => {
        const pos = `(${b.fx.toFixed(2)}, ${b.fy.toFixed(2)})`;
        console.log(chalk.gray(`    ${i + 1}.  ${pos.padEnd(18)} r=${b.r.toFixed(2)}  `) + chalk.white(b.color));
      });
    } else {
      console.log(JSON.stringify(recipe, null, 2));
    }

    checkConnection();
    let W = 1920, H = 1080;
    const m = (options.size || '').match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (m) { W = parseInt(m[1], 10); H = parseInt(m[2], 10); }

    const code = `
      (async () => {
        await figma.loadAllPagesAsync();
        const __hex = (h) => { h = h.replace('#', ''); return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 }; };
        let __target;
        ${options.applyTo ? `
        const __wantId = ${JSON.stringify(options.applyTo)};
        if (/^selected$/i.test(__wantId)) {
          __target = figma.currentPage.selection[0];
          if (!__target) throw new Error('Nothing selected in Figma');
        } else {
          __target = await figma.getNodeByIdAsync(__wantId);
          if (!__target) throw new Error('Node not found: ' + __wantId);
        }
        if (__target.type !== 'FRAME') throw new Error('Mesh requires a FRAME target; got ' + __target.type);
        for (const c of [...__target.children]) c.remove();
        ` : `
        __target = figma.createFrame();
        __target.name = ${JSON.stringify(options.name || 'Mesh Wallpaper')};
        __target.resize(${W}, ${H});
        let __x = 0;
        figma.currentPage.children.forEach(n => { __x = Math.max(__x, n.x + (n.width || 0)); });
        __target.x = __x + 100;
        __target.y = 0;
        `}
        const W = __target.width, H = __target.height, D = Math.min(W, H);
        __target.clipsContent = true;
        __target.fills = [{ type:'SOLID', color: __hex(${JSON.stringify(recipe.base)}), opacity:1, visible:true, blendMode:'NORMAL' }];
        const __blobs = ${JSON.stringify(recipe.blobs)};
        const __blur = Math.round(D * ${recipe.blurFraction});
        for (const b of __blobs) {
          const e = figma.createEllipse();
          const R = Math.round(D * b.r);
          e.resize(R * 2, R * 2);
          e.x = b.fx * W - R;
          e.y = b.fy * H - R;
          e.fills = [{ type:'SOLID', color: __hex(b.color), opacity:1, visible:true, blendMode:'NORMAL' }];
          e.effects = [{ type:'LAYER_BLUR', radius: __blur, visible: true }];
          __target.appendChild(e);
        }
        figma.viewport.scrollAndZoomIntoView([__target]);
        return JSON.stringify({ id: __target.id, name: __target.name, blobs: __blobs.length, blur: __blur, w: W, h: H });
      })()
    `;
    const spinner = options.json ? null : ora('Building wallpaper...').start();
    try {
      const res = await fastEval(code);
      const info = JSON.parse(res);
      if (spinner) spinner.succeed(`${options.applyTo ? 'Built on' : 'Created'} ${info.name} (${info.w}x${info.h}, ${info.blobs} blobs)`);
      else if (!options.json) console.log(chalk.green(`  ✓ ${info.name} (${info.id})`));
    } catch (e) {
      if (spinner) spinner.fail(`Build failed: ${e.message}`);
      else console.error(chalk.red(`Build failed: ${e.message}`));
      process.exit(1);
    }
  });

// ============ CREATE ============

const create = program
  .command('create')
  .description('Create Figma elements');

create
  .command('frame <name>')
  .description('Create a frame')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--smart', 'Auto-position to avoid overlaps (default if no -x)')
  .option('-g, --gap <n>', 'Gap for smart positioning', '100')
  .action(async (name, options) => {
    checkConnection();
    const useSmartPos = options.smart || options.x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.gap) : `const smartX = ${options.x};`}
const frame = figma.createFrame();
frame.name = '${name}';
frame.x = smartX;
frame.y = ${options.y};
frame.resize(${options.width}, ${options.height});
${fillCode ? fillCode.code : ''}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
return '${name} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('icon <name>')
  .description('Create an icon from Iconify (e.g., lucide:star, mdi:home) - auto-positions')
  .option('-s, --size <n>', 'Size', '24')
  .option('-c, --color <color>', 'Color (hex or var:name)', '#000000')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (name, options) => {
    checkConnection();
    const spinner = ora(`Fetching icon ${name}...`).start();

    try {
      // Parse icon name (prefix:name format)
      const [prefix, iconName] = name.includes(':') ? name.split(':') : ['lucide', name];

      // Fetch SVG from Iconify API (use black for var: refs, actual color otherwise)
      const size = parseInt(options.size) || 24;
      const usesVar = isVarRef(options.color);
      const fetchColor = usesVar ? '#000000' : (options.color || '#000000');
      const url = `https://api.iconify.design/${prefix}/${iconName}.svg?width=${size}&height=${size}&color=${encodeURIComponent(fetchColor)}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Icon not found: ${name}`);
      }
      const svgContent = await response.text();

      if (!svgContent.includes('<svg')) {
        throw new Error(`Invalid icon: ${name}`);
      }

      spinner.text = 'Creating in Figma...';

      // Create SVG in Figma via daemon
      const posX = options.x !== undefined ? parseInt(options.x) : null;
      const posY = parseInt(options.y) || 0;
      const spacing = parseInt(options.spacing) || 100;

      // If using var: syntax, we need to bind after creation
      const varName = usesVar ? getVarName(options.color) : null;

      const code = `
(async () => {
  ${usesVar ? varLoadingCode() : ''}

  // Smart positioning
  let x = ${posX};
  if (x === null) {
    x = 0;
    figma.currentPage.children.forEach(n => {
      x = Math.max(x, n.x + (n.width || 0));
    });
    x += ${spacing};
  }

  // Create SVG node
  const node = figma.createNodeFromSvg(${JSON.stringify(svgContent)});
  node.name = "${name}";
  node.x = x;
  node.y = ${posY};

  // Flatten to vector for cleaner result
  let finalNode = node;
  if (node.type === 'FRAME' && node.children.length > 0) {
    finalNode = figma.flatten([node]);
    finalNode.name = "${name}";
  }

  ${usesVar ? `
  // Bind variable to fills
  if ('fills' in finalNode && vars['${varName}']) {
    finalNode.fills = [boundFill(vars['${varName}'])];
  }
  ` : ''}

  return { id: finalNode.id, x: finalNode.x, y: finalNode.y, width: finalNode.width, height: finalNode.height };
})()`;

      const result = await daemonExec('eval', { code });
      spinner.succeed(`Created icon: ${name}`);
      console.log(chalk.gray(`  Position: (${result.x}, ${result.y}), Size: ${result.width}x${result.height}px`));
    } catch (error) {
      spinner.fail('Error creating icon');
      console.error(chalk.red(error.message));
    }
  });

create
  .command('image <url>')
  .description('Create an image from URL (PNG, JPG, GIF, WebP)')
  .option('-w, --width <n>', 'Width (auto if not set)')
  .option('-h, --height <n>', 'Height (auto if not set)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-n, --name <name>', 'Node name', 'Image')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (url, options) => {
    checkConnection();
    const spinner = ora('Loading image...').start();

    const code = `
(async () => {
  try {
    // Smart positioning
    let smartX = 0;
    if (${options.x === undefined}) {
      figma.currentPage.children.forEach(n => {
        smartX = Math.max(smartX, n.x + (n.width || 0));
      });
      smartX += ${options.spacing || 100};
    } else {
      smartX = ${options.x || 0};
    }

    // Create image from URL
    const image = await figma.createImageAsync("${url}");
    const { width, height } = await image.getSizeAsync();

    // Calculate dimensions
    let w = ${options.width || 'null'};
    let h = ${options.height || 'null'};
    if (w && !h) h = Math.round(height * (w / width));
    if (h && !w) w = Math.round(width * (h / height));
    if (!w && !h) { w = width; h = height; }

    // Create rectangle with image fill
    const rect = figma.createRectangle();
    rect.name = "${options.name}";
    rect.resize(w, h);
    rect.x = smartX;
    rect.y = ${options.y};
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([rect]);

    return 'Image created: ' + w + 'x' + h + ' at (' + smartX + ', ${options.y})';
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed('Image created from URL');
      if (result) console.log(chalk.gray(result.trim()));
    } catch (e) {
      spinner.fail('Failed to create image: ' + e.message);
    }
  });

// ============ SCREENSHOT URL ============

program
  .command('screenshot-url <url>')
  .alias('screenshot')
  .description('Screenshot a website and import into Figma as reference')
  .option('-w, --width <n>', 'Viewport width', '1280')
  .option('-h, --height <n>', 'Viewport height', '800')
  .option('--full', 'Capture full page (not just viewport)')
  .option('-n, --name <name>', 'Node name', 'Screenshot')
  .option('--scale <n>', 'Scale factor (1 or 2 for retina)', '2')
  .action(async (url, options) => {
    checkConnection();

    const spinner = ora('Taking screenshot of ' + url + '...').start();

    try {
      const tempFile = join(tmpdir(), 'figma-cli-screenshot.png');

      // Build capture-website command
      let cmd = `npx --yes capture-website-cli "${url}" --output="${tempFile}" --width=${options.width} --height=${options.height} --scale-factor=${options.scale}`;
      if (options.full) cmd += ' --full-page';
      cmd += ' --overwrite';

      // Take screenshot
      execSync(cmd, { stdio: 'ignore', timeout: 60000 });

      if (!existsSync(tempFile)) {
        throw new Error('Screenshot failed');
      }

      spinner.text = 'Importing into Figma...';

      // Read as base64
      const buffer = readFileSync(tempFile);
      const base64 = buffer.toString('base64');
      const dataUrl = 'data:image/png;base64,' + base64;

      // Import into Figma with smart positioning
      const code = `
(async () => {
  try {
    // Smart positioning
    let smartX = 0;
    figma.currentPage.children.forEach(n => {
      smartX = Math.max(smartX, n.x + (n.width || 0));
    });
    smartX += 100;

    // Create image from base64
    const image = await figma.createImageAsync("${dataUrl}");
    const { width, height } = await image.getSizeAsync();

    // Create rectangle with image fill
    const rect = figma.createRectangle();
    rect.name = "${options.name} - ${url}";
    rect.resize(width, height);
    rect.x = smartX;
    rect.y = 0;
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([rect]);

    return 'Screenshot imported: ' + width + 'x' + height;
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed('Screenshot imported into Figma');
      if (result) console.log(chalk.gray(result.trim()));

      // Cleanup
      try { unlinkSync(tempFile); } catch {}
    } catch (e) {
      spinner.fail('Failed: ' + e.message);
    }
  });

// ============ ANALYZE URL (Playwright) ============

program
  .command('analyze-url <url>')
  .description('Analyze a webpage with Playwright and extract exact CSS values')
  .option('-w, --width <n>', 'Viewport width', '1440')
  .option('-h, --height <n>', 'Viewport height', '900')
  .option('--screenshot', 'Also save a screenshot')
  .action(async (url, options) => {
    const spinner = ora('Analyzing ' + url + ' with Playwright...').start();

    try {
      // Create analysis script
      const script = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: ${options.width}, height: ${options.height} } });

  await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const rgbToHex = (rgb) => {
      if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return 'transparent';
      const match = rgb.match(/\\d+/g);
      if (!match || match.length < 3) return rgb;
      const [r, g, b] = match.map(Number);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    };

    const getStyles = (el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: rgbToHex(cs.color),
        bgColor: rgbToHex(cs.backgroundColor),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(),
        borderRadius: cs.borderRadius,
        border: cs.border,
        padding: cs.padding
      };
    };

    const results = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyBg: rgbToHex(window.getComputedStyle(document.body).backgroundColor),
      elements: []
    };

    document.querySelectorAll('h1, h2, h3, h4, button, [role="button"], input, label, [class*="btn"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.placeholder || '').slice(0, 80).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    return results;
  });

  console.log(JSON.stringify(data, null, 2));
  ${options.screenshot ? `await page.screenshot({ path: '${join(tmpdir(), 'analyze-screenshot.png').replace(/\\/g, '\\\\')}' });` : ''}
  await browser.close();
})();
`;

      // Write and run script
      const scriptPath = join(tmpdir(), 'figma-analyze-url.js');
      writeFileSync(scriptPath, script);

      const result = execSync(`node "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      });

      spinner.succeed('Page analyzed');
      console.log(result);

      if (options.screenshot) {
        console.log(chalk.gray('Screenshot saved: /tmp/analyze-screenshot.png'));
      }

      // Cleanup
      try { unlinkSync(scriptPath); } catch {}
    } catch (e) {
      spinner.fail('Analysis failed: ' + e.message);
    }
  });

// ============ RECREATE URL (Playwright + Figma) ============

program
  .command('recreate-url <url>')
  .alias('recreate')
  .description('Analyze a webpage and recreate it in Figma (desktop 1440px)')
  .option('-w, --width <n>', 'Viewport width', '1440')
  .option('-h, --height <n>', 'Viewport height', '900')
  .option('--name <name>', 'Frame name', 'Recreated Page')
  .action(async (url, options) => {
    checkConnection();

    const spinner = ora('Analyzing ' + url + ' with Playwright...').start();

    try {
      // Step 1: Analyze with Playwright
      const analyzeScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: ${options.width}, height: ${options.height} } });

  await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const rgbToHex = (rgb) => {
      if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return 'transparent';
      const match = rgb.match(/\\d+/g);
      if (!match || match.length < 3) return rgb;
      const [r, g, b] = match.map(Number);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    };

    const getStyles = (el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: rgbToHex(cs.color),
        bgColor: rgbToHex(cs.backgroundColor),
        fontSize: parseInt(cs.fontSize) || 16,
        fontWeight: parseInt(cs.fontWeight) || 400,
        fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(),
        borderRadius: parseInt(cs.borderRadius) || 0,
        borderWidth: parseInt(cs.borderWidth) || 0,
        borderColor: rgbToHex(cs.borderColor),
        paddingTop: parseInt(cs.paddingTop) || 0,
        paddingRight: parseInt(cs.paddingRight) || 0,
        paddingBottom: parseInt(cs.paddingBottom) || 0,
        paddingLeft: parseInt(cs.paddingLeft) || 0
      };
    };

    const results = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyBg: rgbToHex(window.getComputedStyle(document.body).backgroundColor),
      elements: []
    };

    // Get headings
    document.querySelectorAll('h1, h2, h3').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'heading',
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').slice(0, 200).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], a[class*="btn"], [class*="button"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 30 && rect.height > 20 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'button',
          text: (el.innerText || el.value || '').slice(0, 80).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get inputs
    document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], textarea').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 20 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'input',
          placeholder: el.placeholder || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get paragraphs/labels
    document.querySelectorAll('p, label, span').forEach(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').trim();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50 && text.length > 2 && text.length < 500) {
        results.elements.push({
          type: 'text',
          text: text.slice(0, 200),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    return results;
  });

  console.log(JSON.stringify(data));
  await browser.close();
})();
`;

      const scriptPath = join(tmpdir(), 'figma-recreate-analyze.js');
      writeFileSync(scriptPath, analyzeScript);

      const analysisResult = execSync(`node "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      });

      const data = JSON.parse(analysisResult);
      spinner.text = 'Generating Figma code...';

      // Step 2: Generate Figma code
      const hexToRgb = (hex) => {
        if (!hex || hex === 'transparent') return '{ r: 1, g: 1, b: 1 }';
        const h = hex.replace('#', '');
        const r = (parseInt(h.slice(0, 2), 16) / 255).toFixed(3);
        const g = (parseInt(h.slice(2, 4), 16) / 255).toFixed(3);
        const b = (parseInt(h.slice(4, 6), 16) / 255).toFixed(3);
        return `{ r: ${r}, g: ${g}, b: ${b} }`;
      };

      // Normalize font family name (Playwright returns lowercase)
      const normalizeFontFamily = (family) => {
        if (!family) return 'Inter';
        const f = family.toLowerCase();
        if (f.includes('inter')) return 'Inter';
        if (f.includes('roboto')) return 'Roboto';
        if (f.includes('arial')) return 'Arial';
        if (f.includes('helvetica')) return 'Helvetica';
        if (f.includes('georgia')) return 'Georgia';
        if (f.includes('times')) return 'Times New Roman';
        if (f.includes('verdana')) return 'Verdana';
        if (f.includes('open sans')) return 'Open Sans';
        if (f.includes('lato')) return 'Lato';
        if (f.includes('montserrat')) return 'Montserrat';
        if (f.includes('poppins')) return 'Poppins';
        if (f.includes('source sans')) return 'Source Sans Pro';
        // Capitalize first letter of each word
        return family.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      };

      // Get font style based on weight (handles different font naming conventions)
      const getFontStyle = (weight, family) => {
        const w = weight || 400;
        const f = (family || '').toLowerCase();

        // Inter uses "Semi Bold" with space
        if (f.includes('inter')) {
          if (w >= 700) return 'Bold';
          if (w >= 600) return 'Semi Bold';
          if (w >= 500) return 'Medium';
          return 'Regular';
        }

        // Most other fonts use "SemiBold" without space
        if (w >= 700) return 'Bold';
        if (w >= 600) return 'SemiBold';
        if (w >= 500) return 'Medium';
        return 'Regular';
      };

      // Collect unique font family + style combinations
      const fonts = new Set();
      data.elements.forEach(el => {
        const family = normalizeFontFamily(el.fontFamily);
        const style = getFontStyle(el.fontWeight, el.fontFamily);
        fonts.add(JSON.stringify({ family, style }));
      });
      // Always include a fallback
      fonts.add(JSON.stringify({ family: 'Inter', style: 'Regular' }));

      // Build Figma script
      let figmaCode = `(async function() {
  // Font fallback map: requested font → available font
  const fontMap = new Map();
  const fallbackFont = { family: 'Inter', style: 'Regular' };

  // Load font with fallback chain
  const loadFont = async (family, style) => {
    const key = family + '|' + style;

    // Try exact match
    try {
      await figma.loadFontAsync({ family, style });
      fontMap.set(key, { family, style });
      return;
    } catch {}

    // Try Regular style
    try {
      await figma.loadFontAsync({ family, style: 'Regular' });
      fontMap.set(key, { family, style: 'Regular' });
      return;
    } catch {}

    // Fall back to Inter
    await figma.loadFontAsync(fallbackFont);
    fontMap.set(key, fallbackFont);
  };

  // Get available font (with fallback)
  const getFont = (family, style) => {
    const key = family + '|' + style;
    return fontMap.get(key) || fallbackFont;
  };

${[...fonts].map(f => {
  const { family, style } = JSON.parse(f);
  return `  await loadFont("${family}", "${style}");`;
}).join('\n')}

  // Smart positioning
  let smartX = 0;
  figma.currentPage.children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
  smartX += 100;

  // Main desktop frame
  const main = figma.createFrame();
  main.name = "${options.name}";
  main.resize(${options.width}, ${options.height});
  main.fills = [{ type: "SOLID", color: ${hexToRgb(data.bodyBg)} }];
  main.x = smartX;
  main.y = 0;
  main.clipsContent = true;

`;

      // Add elements
      data.elements.forEach((el, i) => {
        const fontFamily = normalizeFontFamily(el.fontFamily);
        const fontStyle = getFontStyle(el.fontWeight, el.fontFamily);

        if (el.type === 'heading' || el.type === 'text') {
          const text = (el.text || '').replace(/"/g, '\\"').replace(/\n/g, '\\n');
          if (!text) return;
          figmaCode += `
  // ${el.type}: ${text.slice(0, 30)}
  const t${i} = figma.createText();
  t${i}.fontName = getFont("${fontFamily}", "${fontStyle}");
  t${i}.characters = "${text}";
  t${i}.fontSize = ${el.fontSize || 16};
  t${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.color)} }];
  t${i}.x = ${el.x};
  t${i}.y = ${el.y};
  main.appendChild(t${i});
`;
        } else if (el.type === 'button') {
          const text = (el.text || '').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
          if (!text) return;
          figmaCode += `
  // Button: ${text.slice(0, 30)}
  const btn${i} = figma.createFrame();
  btn${i}.name = "${text.slice(0, 20)}";
  btn${i}.resize(${el.w}, ${el.h});
  btn${i}.x = ${el.x};
  btn${i}.y = ${el.y};
  btn${i}.cornerRadius = ${el.borderRadius || 0};
  btn${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.bgColor)} }];
  ${el.borderWidth > 0 ? `btn${i}.strokes = [{ type: "SOLID", color: ${hexToRgb(el.borderColor)} }]; btn${i}.strokeWeight = ${el.borderWidth};` : ''}
  btn${i}.layoutMode = "HORIZONTAL";
  btn${i}.primaryAxisAlignItems = "CENTER";
  btn${i}.counterAxisAlignItems = "CENTER";
  const btnTxt${i} = figma.createText();
  btnTxt${i}.fontName = getFont("${fontFamily}", "${fontStyle}");
  btnTxt${i}.characters = "${text}";
  btnTxt${i}.fontSize = ${el.fontSize || 14};
  btnTxt${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.color)} }];
  btn${i}.appendChild(btnTxt${i});
  main.appendChild(btn${i});
`;
        } else if (el.type === 'input') {
          const placeholder = (el.placeholder || 'Enter text...').replace(/"/g, '\\"');
          figmaCode += `
  // Input
  const input${i} = figma.createFrame();
  input${i}.name = "Input";
  input${i}.resize(${el.w}, ${el.h});
  input${i}.x = ${el.x};
  input${i}.y = ${el.y};
  input${i}.cornerRadius = ${el.borderRadius || 4};
  input${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.bgColor)} }];
  ${el.borderWidth > 0 ? `input${i}.strokes = [{ type: "SOLID", color: ${hexToRgb(el.borderColor)} }]; input${i}.strokeWeight = ${el.borderWidth};` : ''}
  input${i}.layoutMode = "HORIZONTAL";
  input${i}.counterAxisAlignItems = "CENTER";
  input${i}.paddingLeft = ${el.paddingLeft || 12};
  const ph${i} = figma.createText();
  ph${i}.fontName = getFont("${fontFamily}", "Regular");
  ph${i}.characters = "${placeholder}";
  ph${i}.fontSize = ${el.fontSize || 14};
  ph${i}.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }];
  input${i}.appendChild(ph${i});
  main.appendChild(input${i});
`;
        }
      });

      figmaCode += `
  figma.viewport.scrollAndZoomIntoView([main]);
  return "Recreated ${data.elements.length} elements from ${url}";
})()`;

      // Step 3: Execute via daemon (fast) or direct connection (fallback)
      spinner.text = 'Creating in Figma...';
      await fastEval(figmaCode);

      spinner.succeed('Page recreated in Figma');
      console.log(chalk.green('✓ ') + chalk.white(`Created ${data.elements.length} elements`));
      console.log(chalk.gray(`  Frame: "${options.name}" (${options.width}x${options.height})`));
      console.log(chalk.gray(`  Source: ${url}`));

      // Cleanup
      try { unlinkSync(scriptPath); } catch {}
    } catch (e) {
      spinner.fail('Recreation failed: ' + e.message);
      if (process.env.DEBUG) console.error(e);
    }
  });

// ============ REMOVE BACKGROUND ============

program
  .command('remove-bg [nodeId]')
  .alias('removebg')
  .description('Remove background from selected image (uses remove.bg API)')
  .option('--api-key <key>', 'Remove.bg API key')
  .action(async (nodeId, options) => {
    checkConnection();

    // Get API key from option, env var, or config
    const config = loadConfig();
    const apiKey = options.apiKey || process.env.REMOVEBG_API_KEY || config.removebgApiKey;

    if (!apiKey) {
      console.log(chalk.red('✗ Remove.bg API key required\n'));
      console.log(chalk.white.bold('How to get your API key (free, 50 images/month):\n'));
      console.log(chalk.gray('  1. Go to ') + chalk.cyan('https://www.remove.bg/api'));
      console.log(chalk.gray('  2. Click "Get API Key" and sign up'));
      console.log(chalk.gray('  3. Copy your API key from the dashboard\n'));
      console.log(chalk.white.bold('Then use one of these methods:\n'));
      console.log(chalk.cyan('  Option A: ') + chalk.gray('Save permanently'));
      console.log(chalk.white('    node src/index.js config set removebgApiKey YOUR_KEY\n'));
      console.log(chalk.cyan('  Option B: ') + chalk.gray('Use once'));
      console.log(chalk.white('    node src/index.js remove-bg --api-key YOUR_KEY\n'));
      console.log(chalk.cyan('  Option C: ') + chalk.gray('Environment variable'));
      console.log(chalk.white('    export REMOVEBG_API_KEY=YOUR_KEY'));
      return;
    }

    const spinner = ora('Exporting selected image...').start();

    try {
      const tempInput = join(tmpdir(), 'figma-cli-removebg-input.png');

      // Export selected node as PNG
      let exportCmd = 'export png --scale 2 --output "' + tempInput + '"';
      if (nodeId) exportCmd += ' --node "' + nodeId + '"';
      const exportResult = figmaUse(exportCmd, { silent: true });

      if (!existsSync(tempInput)) {
        throw new Error('Export failed. Select an image or frame first.');
      }

      spinner.text = 'Removing background via remove.bg...';

      // Read image and send to Remove.bg API
      const imageBuffer = readFileSync(tempInput);
      const base64Image = imageBuffer.toString('base64');

      const response = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_file_b64: base64Image,
          size: 'auto',
          format: 'png',
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const errorMsg = error.errors?.[0]?.title || 'API request failed';
        if (response.status === 402) {
          throw new Error('API credits exhausted. Get more at remove.bg/api');
        }
        if (response.status === 403) {
          throw new Error('Invalid API key. Check your key at remove.bg/api');
        }
        throw new Error(errorMsg);
      }

      // Get result as base64
      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const resultBase64 = resultBuffer.toString('base64');
      const dataUrl = 'data:image/png;base64,' + resultBase64;

      spinner.text = 'Updating image in Figma...';

      // Replace the selected node's fill with the new image
      const code = `
(async () => {
  try {
    const node = figma.currentPage.selection[0];
    if (!node) return 'Error: No node selected';

    // Create new image from base64
    const image = await figma.createImageAsync("${dataUrl}");

    // Replace fills with new image
    if ('fills' in node) {
      node.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
      return 'Background removed from ' + node.name;
    } else {
      return 'Error: Selected node cannot have image fills';
    }
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });

      if (result && result.includes('Error:')) {
        spinner.fail(result.trim());
      } else {
        spinner.succeed('Background removed!');
        if (result) console.log(chalk.gray(result.trim()));
      }

      // Cleanup
      try { unlinkSync(tempInput); } catch {}
    } catch (e) {
      spinner.fail('Failed: ' + e.message);
    }
  });

// ============ CONFIG ============

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g., removebgApiKey)')
  .action((key, value) => {
    const config = loadConfig();
    config[key] = value;
    saveConfig(config);
    console.log(chalk.green('✓ Config saved: ') + chalk.gray(key + ' = ' + value.substring(0, 10) + '...'));
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    const config = loadConfig();
    if (config[key]) {
      console.log(config[key]);
    } else {
      console.log(chalk.gray('Not set'));
    }
  });

create
  .command('rect [name]')
  .alias('rectangle')
  .description('Create a rectangle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity 0-1')
  .action(async (name, options) => {
    checkConnection();
    const rectName = name || 'Rectangle';
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'rect');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'rect') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const rect = figma.createRectangle();
rect.name = '${rectName}';
rect.x = smartX;
rect.y = ${options.y};
rect.resize(${options.width}, ${options.height});
${fillCode.code}
${options.radius ? `rect.cornerRadius = ${options.radius};` : ''}
${options.opacity ? `rect.opacity = ${options.opacity};` : ''}
${strokeCode ? strokeCode.code : ''}
figma.currentPage.selection = [rect];
return '${rectName} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('ellipse [name]')
  .alias('circle')
  .description('Create an ellipse/circle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width (diameter)', '100')
  .option('-h, --height <n>', 'Height (same as width for circle)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .action(async (name, options) => {
    checkConnection();
    const ellipseName = name || 'Ellipse';
    const height = options.height || options.width;
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'ellipse');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'ellipse') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const ellipse = figma.createEllipse();
ellipse.name = '${ellipseName}';
ellipse.x = smartX;
ellipse.y = ${options.y};
ellipse.resize(${options.width}, ${height});
${fillCode.code}
${strokeCode ? strokeCode.code : ''}
figma.currentPage.selection = [ellipse];
return '${ellipseName} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('text <content>')
  .description('Create a text layer (smart positions by default)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .option('-c, --color <color>', 'Text color (hex or var:name)', '#000000')
  .option('-w, --weight <weight>', 'Font weight: regular, medium, semibold, bold', 'regular')
  .option('--font <family>', 'Font family', 'Inter')
  .option('--width <n>', 'Text box width (auto-width if not set)')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (content, options) => {
    checkConnection();
    const weightMap = { regular: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' };
    const fontStyle = weightMap[options.weight.toLowerCase()] || 'Regular';
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.color);

    const fillCode = generateFillCode(options.color, 'text');

    let code = `
(async function() {
  ${usesVars ? varLoadingCode() : ''}
  ${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
  await figma.loadFontAsync({ family: '${options.font}', style: '${fontStyle}' });
  const text = figma.createText();
  text.fontName = { family: '${options.font}', style: '${fontStyle}' };
  text.characters = '${content.replace(/'/g, "\\'")}';
  text.fontSize = ${options.size};
  ${fillCode.code}
  text.x = smartX;
  text.y = ${options.y};
  ${options.width ? `text.resize(${options.width}, text.height); text.textAutoResize = 'HEIGHT';` : ''}
  figma.currentPage.selection = [text];
  return 'Text created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('line')
  .description('Create a line (smart positions by default)')
  .option('--x1 <n>', 'Start X (auto if not set)')
  .option('--y1 <n>', 'Start Y', '0')
  .option('--x2 <n>', 'End X (auto + length if x1 not set)')
  .option('--y2 <n>', 'End Y', '0')
  .option('-l, --length <n>', 'Line length', '100')
  .option('-c, --color <color>', 'Line color (hex or var:name)', '#000000')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (options) => {
    checkConnection();
    const useSmartPos = options.x1 === undefined;
    const lineLength = parseFloat(options.length);
    const usesVars = isVarRef(options.color);

    const strokeCode = generateStrokeCode(options.color, 'line', options.weight);

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x1};`}
const line = figma.createLine();
line.x = smartX;
line.y = ${options.y1};
line.resize(${useSmartPos ? lineLength : `Math.abs(${options.x2 || options.x1 + '+' + lineLength} - ${options.x1}) || ${lineLength}`}, 0);
${options.x2 && options.x1 ? `line.rotation = Math.atan2(${options.y2} - ${options.y1}, ${options.x2} - ${options.x1}) * 180 / Math.PI;` : ''}
${strokeCode.code}
figma.currentPage.selection = [line];
return 'Line created at (' + smartX + ', ${options.y1}) with length ${lineLength}';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('component [name]')
  .description('Convert selection to component')
  .action((name) => {
    checkConnection();
    const compName = name || 'Component';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else if (sel.length === 1) {
  const comp = figma.createComponentFromNode(sel[0]);
  comp.name = '${compName}';
  figma.currentPage.selection = [comp];
  'Component created: ' + comp.name;
} else {
  const group = figma.group(sel, figma.currentPage);
  const comp = figma.createComponentFromNode(group);
  comp.name = '${compName}';
  figma.currentPage.selection = [comp];
  'Component created from ' + sel.length + ' elements: ' + comp.name;
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('group [name]')
  .description('Group current selection')
  .action((name) => {
    checkConnection();
    const groupName = name || 'Group';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length < 2) 'Select 2+ elements to group';
else {
  const group = figma.group(sel, figma.currentPage);
  group.name = '${groupName}';
  figma.currentPage.selection = [group];
  'Grouped ' + sel.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('autolayout [name]')
  .alias('al')
  .description('Create an auto-layout frame (smart positions by default)')
  .option('-d, --direction <dir>', 'Direction: row, col', 'row')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Padding', '16')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (name, options) => {
    checkConnection();
    const frameName = name || 'Auto Layout';
    const layoutMode = options.direction === 'col' ? 'VERTICAL' : 'HORIZONTAL';
    const useSmartPos = options.x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
const frame = figma.createFrame();
frame.name = '${frameName}';
frame.x = smartX;
frame.y = ${options.y};
frame.layoutMode = '${layoutMode}';
frame.primaryAxisSizingMode = 'AUTO';
frame.counterAxisSizingMode = 'AUTO';
frame.itemSpacing = ${options.gap};
frame.paddingTop = ${options.padding};
frame.paddingRight = ${options.padding};
frame.paddingBottom = ${options.padding};
frame.paddingLeft = ${options.padding};
${fillCode ? fillCode.code : 'frame.fills = [];'}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
return 'Auto-layout frame created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

// ============ CANVAS ============

const canvas = program
  .command('canvas')
  .description('Canvas awareness and smart positioning');

canvas
  .command('info')
  .description('Show canvas info (bounds, element count, free space)')
  .action(() => {
    checkConnection();
    let code = `(function() {
const children = figma.currentPage.children;
if (children.length === 0) {
  return JSON.stringify({ empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 });
} else {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  children.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  return JSON.stringify({
    elements: children.length,
    bounds: { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
    nextX: Math.round(maxX + 100),
    nextY: 0,
    frames: children.filter(n => n.type === 'FRAME').length,
    components: children.filter(n => n.type === 'COMPONENT').length
  }, null, 2);
}
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

canvas
  .command('next')
  .description('Get next free position on canvas (no overlap)')
  .option('-g, --gap <n>', 'Gap from existing elements', '100')
  .option('-d, --direction <dir>', 'Direction: right, below', 'right')
  .action((options) => {
    checkConnection();
    let code = `
const children = figma.currentPage.children;
const gap = ${options.gap};
if (children.length === 0) {
  JSON.stringify({ x: 0, y: 0 });
} else {
  ${options.direction === 'below' ? `
  let maxY = -Infinity;
  children.forEach(n => { maxY = Math.max(maxY, n.y + n.height); });
  JSON.stringify({ x: 0, y: Math.round(maxY + gap) });
  ` : `
  let maxX = -Infinity;
  children.forEach(n => { maxX = Math.max(maxX, n.x + n.width); });
  JSON.stringify({ x: Math.round(maxX + gap), y: 0 });
  `}
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ BIND (Variables) ============

const bind = program
  .command('bind')
  .description('Bind variables to node properties');

bind
  .command('fill <varName>')
  .description('Bind color variable to fill')
  .option('-n, --node <id>', 'Node ID (uses selection if not set)')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('fills' in n && n.fills.length > 0) {
    const newFill = figma.variables.setBoundVariableForPaint(n.fills[0], 'color', v);
    n.fills = [newFill];
  }
});
return 'Bound ' + v.name + ' to fill on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('stroke <varName>')
  .description('Bind color variable to stroke')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('strokes' in n) {
    const stroke = n.strokes[0] || { type: 'SOLID', color: {r:0,g:0,b:0} };
    const newStroke = figma.variables.setBoundVariableForPaint(stroke, 'color', v);
    n.strokes = [newStroke];
  }
});
return 'Bound ' + v.name + ' to stroke on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('radius <varName>')
  .description('Bind number variable to corner radius')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('cornerRadius' in n) n.setBoundVariable('cornerRadius', v);
});
return 'Bound ' + v.name + ' to radius on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('gap <varName>')
  .description('Bind number variable to auto-layout gap')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('itemSpacing' in n) n.setBoundVariable('itemSpacing', v);
});
return 'Bound ' + v.name + ' to gap on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('padding <varName>')
  .description('Bind number variable to padding')
  .option('-n, --node <id>', 'Node ID')
  .option('-s, --side <side>', 'Side: top, right, bottom, left, all', 'all')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    const sides = options.side === 'all'
      ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
      : [`padding${options.side.charAt(0).toUpperCase() + options.side.slice(1)}`];
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
const sides = ${JSON.stringify(sides)};
nodes.forEach(n => {
  sides.forEach(side => { if (side in n) n.setBoundVariable(side, v); });
});
return 'Bound ' + v.name + ' to padding on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('list')
  .description('List available variables for binding')
  .option('-t, --type <type>', 'Filter: COLOR, FLOAT')
  .action((options) => {
    checkConnection();
    let code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
const filtered = vars${options.type ? `.filter(v => v.resolvedType === '${options.type.toUpperCase()}')` : ''};
return filtered.map(v => v.resolvedType.padEnd(8) + ' ' + v.name).join('\\n') || 'No variables';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ SIZING ============

const sizing = program
  .command('sizing')
  .description('Control sizing in auto-layout');

sizing
  .command('hug')
  .description('Set to hug contents')
  .option('-a, --axis <axis>', 'Axis: both, h, v', 'both')
  .action((options) => {
    checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    ${options.axis === 'h' || options.axis === 'both' ? `if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'HUG';` : ''}
    ${options.axis === 'v' || options.axis === 'both' ? `if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'HUG';` : ''}
    if (n.layoutMode) { n.primaryAxisSizingMode = 'AUTO'; n.counterAxisSizingMode = 'AUTO'; }
  });
  'Set hug on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

sizing
  .command('fill')
  .description('Set to fill container')
  .option('-a, --axis <axis>', 'Axis: both, h, v', 'both')
  .action((options) => {
    checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    ${options.axis === 'h' || options.axis === 'both' ? `if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'FILL';` : ''}
    ${options.axis === 'v' || options.axis === 'both' ? `if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'FILL';` : ''}
  });
  'Set fill on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

sizing
  .command('fixed <width> [height]')
  .description('Set to fixed size')
  .action((width, height) => {
    checkConnection();
    const h = height || width;
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'FIXED';
    if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'FIXED';
    if ('resize' in n) n.resize(${width}, ${h});
  });
  'Set fixed ${width}x${h} on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ LAYOUT SHORTCUTS ============

program
  .command('padding <value> [r] [b] [l]')
  .alias('pad')
  .description('Set padding (CSS-style: 1-4 values)')
  .action((value, r, b, l) => {
    checkConnection();
    let top = value, right = r || value, bottom = b || value, left = l || r || value;
    if (!r) { right = value; bottom = value; left = value; }
    else if (!b) { bottom = value; left = r; }
    else if (!l) { left = r; }
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('paddingTop' in n) {
      n.paddingTop = ${top}; n.paddingRight = ${right};
      n.paddingBottom = ${bottom}; n.paddingLeft = ${left};
    }
  });
  'Set padding on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

program
  .command('gap <value>')
  .description('Set auto-layout gap')
  .action((value) => {
    checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => { if ('itemSpacing' in n) n.itemSpacing = ${value}; });
  'Set gap ${value} on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

program
  .command('align <alignment>')
  .description('Align items: start, center, end, stretch')
  .action((alignment) => {
    checkConnection();
    const map = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
    const val = map[alignment.toLowerCase()] || 'CENTER';
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('primaryAxisAlignItems' in n) n.primaryAxisAlignItems = '${val}';
    if ('counterAxisAlignItems' in n) n.counterAxisAlignItems = '${val}';
  });
  'Aligned ' + nodes.length + ' elements to ${alignment}';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ SELECT ============

program
  .command('select <nodeId>')
  .description('Select a node by ID')
  .action((nodeId) => {
    checkConnection();
    figmaUse(`select "${nodeId}"`);
  });

// ============ DELETE ============

program
  .command('delete [nodeId]')
  .alias('remove')
  .description('Delete node by ID or current selection')
  .action((nodeId) => {
    checkConnection();
    if (nodeId) {
      let code = `(async () => {
const node = await figma.getNodeByIdAsync('${nodeId}');
if (node) { node.remove(); return 'Deleted: ${nodeId}'; } else { return 'Node not found: ${nodeId}'; }
})()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    } else {
      let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else { const count = sel.length; sel.forEach(n => n.remove()); 'Deleted ' + count + ' elements'; }
`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

// ============ DUPLICATE ============

program
  .command('duplicate [nodeId]')
  .alias('dup')
  .description('Duplicate node by ID or current selection')
  .option('--offset <n>', 'Offset from original', '20')
  .action((nodeId, options) => {
    checkConnection();
    if (nodeId) {
      let code = `(async () => {
const node = await figma.getNodeByIdAsync('${nodeId}');
if (node) { const clone = node.clone(); clone.x += ${options.offset}; clone.y += ${options.offset}; figma.currentPage.selection = [clone]; return 'Duplicated: ' + clone.id; } else { return 'Node not found'; }
})()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    } else {
      let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else { const clones = sel.map(n => { const c = n.clone(); c.x += ${options.offset}; c.y += ${options.offset}; return c; }); figma.currentPage.selection = clones; 'Duplicated ' + clones.length + ' elements'; }
`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

// ============ SET ============

const set = program
  .command('set')
  .description('Set properties on selection or node');

set
  .command('fill <color>')
  .description('Set fill color (hex or var:name) on selection, --node, or all nodes matching --query')
  .option('-n, --node <id>', 'Node ID (uses selection if not set)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern> (case-insensitive)')
  .action(async (color, options) => {
    checkConnection();
    // For fill, after the standard selector runs we walk into matched
    // containers (Groups, Frames) and expand to their fillable descendants
    // when they don't have fills themselves.
    const nodeSelector = buildNodeSelector(options) + `
       const __expanded = [];
       for (const __m of nodes) {
         if ('fills' in __m) { __expanded.push(__m); continue; }
         if (typeof __m.findAll === 'function') {
           __expanded.push(...__m.findAll(c => 'fills' in c));
         }
       }
       const __fillNodes = __expanded;`;
    // Code below will reference __fillNodes instead of nodes for the actual mutation.

    let code;
    if (color.startsWith('var:')) {
      // Variable binding — search ALL local collections so user-imported
      // design systems (Carbon, Material, custom) resolve, not only shadcn.
      const varName = color.slice(4);
      code = `(async () => {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const allVars = await figma.variables.getLocalVariablesAsync();
        // Prefer an exact name match in a shadcn collection, then any other.
        let variable = null;
        for (const v of allVars) {
          if (v.name !== ${JSON.stringify(varName)}) continue;
          const col = collections.find(c => c.id === v.variableCollectionId);
          if (col && col.name.startsWith('shadcn')) { variable = v; break; }
        }
        if (!variable) variable = allVars.find(v => v.name === ${JSON.stringify(varName)});
        if (!variable) return 'Variable ${varName} not found in any local collection';
        ${nodeSelector}
        if (__fillNodes.length === 0) return 'No node found';
        const boundFill = (v) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v);
        __fillNodes.forEach(n => { if ('fills' in n) n.fills = [boundFill(variable)]; });
        return 'Bound ' + variable.name + ' to fill on ' + __fillNodes.length + ' elements';
      })()`;
      const result = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (result || 'Done')));
    } else {
      // Hex color
      const { r, g, b } = hexToRgb(color);
      code = `(async () => {
        ${nodeSelector}
        if (__fillNodes.length === 0) return 'No node found';
        __fillNodes.forEach(n => { if ('fills' in n) n.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; });
        return 'Fill set on ' + __fillNodes.length + ' elements';
      })()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

set
  .command('stroke <color>')
  .description('Set stroke color (hex or var:name)')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .action(async (color, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);

    let code;
    if (color.startsWith('var:')) {
      // Variable binding — search ALL local collections so user-imported
      // design systems (Carbon, Material, custom) resolve, not only shadcn.
      const varName = color.slice(4);
      code = `(async () => {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const allVars = await figma.variables.getLocalVariablesAsync();
        let variable = null;
        for (const v of allVars) {
          if (v.name !== ${JSON.stringify(varName)}) continue;
          const col = collections.find(c => c.id === v.variableCollectionId);
          if (col && col.name.startsWith('shadcn')) { variable = v; break; }
        }
        if (!variable) variable = allVars.find(v => v.name === ${JSON.stringify(varName)});
        if (!variable) return 'Variable ${varName} not found in any local collection';
        ${nodeSelector}
        if (nodes.length === 0) return 'No node found';
        const boundFill = (v) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v);
        nodes.forEach(n => { if ('strokes' in n) { n.strokes = [boundFill(variable)]; n.strokeWeight = ${options.weight}; } });
        return 'Bound ' + variable.name + ' to stroke on ' + nodes.length + ' elements';
      })()`;
      const result = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (result || 'Done')));
    } else {
      // Hex color
      const { r, g, b } = hexToRgb(color);
      code = `(async () => {
        ${nodeSelector}
        if (nodes.length === 0) return 'No node found';
        nodes.forEach(n => { if ('strokes' in n) { n.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; n.strokeWeight = ${options.weight}; } });
        return 'Stroke set on ' + nodes.length + ' elements';
      })()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

set
  .command('radius <value>')
  .description('Set corner radius')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action((value, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('cornerRadius' in n) n.cornerRadius = ${value}; }); 'Radius set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('size <width> <height>')
  .description('Set size')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action((width, height, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('resize' in n) n.resize(${width}, ${height}); }); 'Size set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('scale <factor>')
  .description('Scale node(s) by a factor (e.g. 1.2 = 120%, 0.5 = half). Uses node.rescale() — also scales fontSize, stroke, radius. For multi-node selections, the SPACING between nodes is scaled too so they don\'t overlap (pass --keep-spacing to disable).')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('--keep-spacing', 'Only scale each node\'s size — do NOT reposition siblings to preserve relative spacing')
  .action(async (factor, options) => {
    await checkConnection();
    // Accept "1.2", "1.2x", "120%"
    let raw = String(factor).trim().toLowerCase();
    let f;
    if (raw.endsWith('%')) f = parseFloat(raw.slice(0, -1)) / 100;
    else if (raw.endsWith('x')) f = parseFloat(raw.slice(0, -1));
    else f = parseFloat(raw);
    if (!Number.isFinite(f) || f <= 0) {
      console.error(chalk.red('✗'), `Invalid scale factor: ${factor}. Use e.g. 1.2, 1.2x, or 120%.`);
      process.exit(1);
    }
    const scaleSpacing = !options.keepSpacing;
    const nodeSelector = buildNodeSelector(options);
    const code = `(async () => {
      ${nodeSelector}
      if (nodes.length === 0) return 'No node found';
      // Capture original positions BEFORE rescaling so we can scale the
      // sibling-spacing too. Without this, rescale() doubles the size but
      // leaves x/y untouched and the items overlap each other.
      const scaleSpacing = ${scaleSpacing};
      const origin = scaleSpacing && nodes.length > 1
        ? { x: Math.min(...nodes.map(n => n.x || 0)), y: Math.min(...nodes.map(n => n.y || 0)) }
        : null;
      const orig = nodes.map(n => ({ x: n.x || 0, y: n.y || 0 }));
      let count = 0;
      for (const n of nodes) {
        if (typeof n.rescale === 'function') { n.rescale(${f}); count++; }
        else if ('resize' in n && 'width' in n && 'height' in n) { n.resize(n.width * ${f}, n.height * ${f}); count++; }
      }
      if (origin) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (typeof n.x !== 'number') continue;
          n.x = origin.x + (orig[i].x - origin.x) * ${f};
          n.y = origin.y + (orig[i].y - origin.y) * ${f};
        }
      }
      return 'Scaled ' + count + ' element(s) by ${f}' + (origin ? ' (spacing scaled too)' : '');
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

set
  .command('pos <x> <y>')
  .alias('position')
  .description('Set position')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action((x, y, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { n.x = ${x}; n.y = ${y}; }); 'Position set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('opacity <value>')
  .description('Set opacity (0-1)')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action((value, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('opacity' in n) n.opacity = ${value}; }); 'Opacity set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('name <name>')
  .description('Rename node')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action((name, options) => {
    checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { n.name = '${name}'; }); 'Renamed ' + nodes.length + ' elements to ${name}'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('text <text>')
  .description('Change the text content of a text node (or all text children of a node)')
  .option('-n, --node <id>', 'Node ID (text node directly, or container whose text descendants to update)')
  .option('-q, --query <pattern>', 'Update text on all text nodes whose name OR text contains <pattern>')
  .action(async (text, options) => {
    await checkConnection();
    if (!options.node && !options.query) {
      console.error(chalk.red('✗'), 'Provide either --node <id> or --query <pattern>');
      process.exit(1);
    }
    const selectorCode = options.query
      ? `const pattern = ${JSON.stringify(options.query.toLowerCase())};
         const matchesByName = (n) => n && n.name && n.name.toLowerCase().includes(pattern);
         const matchesAncestor = (n) => {
           let p = n.parent;
           while (p && p.type !== 'PAGE') { if (matchesByName(p)) return true; p = p.parent; }
           return false;
         };
         const all = figma.currentPage.findAll(n => n.type === 'TEXT');
         let targets = all.filter(t =>
           matchesByName(t) ||
           (t.characters && t.characters.toLowerCase().includes(pattern)) ||
           matchesAncestor(t));`
      : `const root = await figma.getNodeByIdAsync(${JSON.stringify(options.node)});
         if (!root) throw new Error('Node not found: ${options.node}');
         const targets = root.type === 'TEXT' ? [root] :
           (typeof root.findAll === 'function' ? root.findAll(n => n.type === 'TEXT') : []);`;
    const code = `(async () => {
      ${selectorCode}
      if (targets.length === 0) throw new Error('No text nodes matched');
      const results = [];
      for (const t of targets) {
        await figma.loadFontAsync(t.fontName);
        t.characters = ${JSON.stringify(text)};
        results.push({ id: t.id, name: t.name });
      }
      return results;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Updated text on ${r.length} node(s):`);
      r.forEach(n => console.log(chalk.gray(`  ${n.name || '(unnamed)'} (${n.id})`)));
    } catch (e) {
      handleEvalError(e);
    }
  });

set
  .command('autolayout <direction>')
  .alias('al')
  .description('Apply auto-layout (row/col) with optional sizing, align, and wrap')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Uniform padding')
  .option('--px <n>', 'Horizontal padding (overrides --padding for left/right)')
  .option('--py <n>', 'Vertical padding (overrides --padding for top/bottom)')
  .option('-n, --node <id>', 'Apply to this node ID (or comma-separated list of IDs)')
  .option('-q, --query <pattern>', 'Apply to all FRAME/COMPONENT nodes whose name contains <pattern>')
  .option('--sizing <mode>', 'Container sizing: hug (default), fill, fixed', 'hug')
  .option('--align <a>', 'Children alignment: start | center | end | space-between', 'start')
  .option('--wrap', 'Enable layout wrap (for row direction)')
  .option('--fill-children', 'Set every child to FILL on the counter axis (good for cards with wrapping text)')
  .action(async (direction, options) => {
    await checkConnection();
    const isCol = direction === 'col' || direction === 'vertical' || direction === 'column';
    const layoutMode = isCol ? 'VERTICAL' : 'HORIZONTAL';
    const sizingMode = ({
      hug: 'AUTO', fill: 'FIXED', fixed: 'FIXED'
    })[options.sizing] || 'AUTO';
    const alignMap = {
      start: 'MIN', center: 'CENTER', end: 'MAX', 'space-between': 'SPACE_BETWEEN'
    };
    const primaryAxisAlign = alignMap[options.align] || 'MIN';
    const counterAxisAlign = options.align === 'center' ? 'CENTER' : 'MIN';
    const px = options.px ?? options.padding;
    const py = options.py ?? options.padding;
    // The standard helper produces `const nodes = [...]`; for autolayout we
    // also want to scope --query to FRAME/COMPONENT only (it's pointless
    // to apply auto-layout to text or vector nodes).
    const baseSelector = buildNodeSelector(options, { filterExpr: "(n.type === 'FRAME' || n.type === 'COMPONENT')" });
    const code = `
(async () => {
${baseSelector}
const sel = nodes.filter(n => n.type === 'FRAME' || n.type === 'COMPONENT');
if (sel.length === 0) { return 'No frame/component to apply autolayout to'; }
let count = 0;
for (const n of sel) {
  n.layoutMode = '${layoutMode}';
  n.primaryAxisSizingMode = ${JSON.stringify(sizingMode)};
  n.counterAxisSizingMode = ${JSON.stringify(sizingMode)};
  n.primaryAxisAlignItems = ${JSON.stringify(primaryAxisAlign)};
  n.counterAxisAlignItems = ${JSON.stringify(counterAxisAlign)};
  n.itemSpacing = ${parseInt(options.gap) || 0};
  ${px !== undefined ? `n.paddingLeft = n.paddingRight = ${parseInt(px) || 0};` : ''}
  ${py !== undefined ? `n.paddingTop = n.paddingBottom = ${parseInt(py) || 0};` : ''}
  ${options.wrap && !isCol ? `if ('layoutWrap' in n) n.layoutWrap = 'WRAP';` : ''}
  ${options.fillChildren ? `
  for (const c of n.children) {
    if ('layoutSizingHorizontal' in c) c.layoutSizingHorizontal = ${isCol ? "'FILL'" : "'HUG'"};
    if ('layoutSizingVertical' in c) c.layoutSizingVertical = ${isCol ? "'HUG'" : "'FILL'"};
  }` : ''}
  count++;
}
return 'Auto-layout applied to ' + count + ' frame(s)';
})()
`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ PIN (edge-anchored absolute positioning) ============
//
// Implements the directededges "Absolute Positioning" spec:
// https://directededges.github.io/specs/guides/absolute-positioning/
//
// Figma stores absolutely-positioned elements as raw x/y from the parent's
// top-left, plus a `constraints` object that records the anchor edge.
// Designers think in terms of edges ("16 from right"), but figma's API
// forces you to compute raw x = parent.width - node.width - 16 yourself.
// `pin` does the math AND sets the matching constraint so the element
// stays anchored when the parent resizes.

program
  .command('pin <edge>')
  .description('Pin node(s) to a parent edge with an edge-relative offset. Edges: left | right | top | bottom | top-left | top-right | bottom-left | bottom-right | center-x | center-y | stretch-x | stretch-y | scale-x | scale-y')
  .option('-n, --node <id>', 'Node ID (or comma-separated list)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-o, --offset <n>', 'Offset from the edge in px (default: 0). For top-right etc. it applies to the FIRST edge; use --offset-x / --offset-y to split.')
  .option('--offset-x <n>', 'Horizontal offset (overrides --offset on the horizontal axis)')
  .option('--offset-y <n>', 'Vertical offset (overrides --offset on the vertical axis)')
  .option('--start <v>', 'For stretch-x/stretch-y/scale-x/scale-y: start offset (px) or percentage string for scale')
  .option('--end <v>', 'For stretch-x/stretch-y/scale-x/scale-y: end offset (px) or percentage string for scale')
  .action(async (edge, options) => {
    await checkConnection();
    const validEdges = new Set([
      'left', 'right', 'top', 'bottom',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
      'center-x', 'center-y',
      'stretch-x', 'stretch-y',
      'scale-x', 'scale-y',
    ]);
    if (!validEdges.has(edge)) {
      console.error(chalk.red('✗'), `Unknown edge "${edge}". Valid: ${[...validEdges].join(', ')}`);
      process.exit(1);
    }
    const off = parseFloat(options.offset ?? 0);
    const offX = options.offsetX !== undefined ? parseFloat(options.offsetX) : off;
    const offY = options.offsetY !== undefined ? parseFloat(options.offsetY) : off;
    const start = options.start;
    const end = options.end;

    // Build the per-node mutation. Runs inside the eval, so it can read each
    // node's parent dimensions and compute the raw x/y per the Spec formulas.
    // Constraints are set so Figma keeps the anchor when the parent resizes.
    const pinExpr = `
      function pinOne(n) {
        if (!n || typeof n.x !== 'number' || !('constraints' in n)) return false;
        const p = n.parent;
        if (!p || typeof p.width !== 'number') return false;
        const pw = p.width, ph = p.height;
        const c = { ...n.constraints };
        const edge = ${JSON.stringify(edge)};
        const offX = ${offX}, offY = ${offY};
        if (edge === 'left')        { n.x = offX;                          c.horizontal = 'MIN'; }
        else if (edge === 'right')  { n.x = pw - n.width - offX;            c.horizontal = 'MAX'; }
        else if (edge === 'top')    { n.y = offY;                          c.vertical = 'MIN'; }
        else if (edge === 'bottom') { n.y = ph - n.height - offY;           c.vertical = 'MAX'; }
        else if (edge === 'top-left')     { n.x = offX; n.y = offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MIN'; }
        else if (edge === 'top-right')    { n.x = pw - n.width - offX; n.y = offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MIN'; }
        else if (edge === 'bottom-left')  { n.x = offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MAX'; }
        else if (edge === 'bottom-right') { n.x = pw - n.width - offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MAX'; }
        else if (edge === 'center-x') { n.x = (pw - n.width) / 2 + offX; c.horizontal = 'CENTER'; }
        else if (edge === 'center-y') { n.y = (ph - n.height) / 2 + offY; c.vertical = 'CENTER'; }
        else if (edge === 'stretch-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.x = sNum;
          n.resize(Math.max(1, pw - sNum - eNum), n.height);
          c.horizontal = 'STRETCH';
        }
        else if (edge === 'stretch-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.y = sNum;
          n.resize(n.width, Math.max(1, ph - sNum - eNum));
          c.vertical = 'STRETCH';
        }
        else if (edge === 'scale-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / pw;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / pw;
          n.x = pw * sPct;
          n.resize(Math.max(1, pw - n.x - pw * ePct), n.height);
          c.horizontal = 'SCALE';
        }
        else if (edge === 'scale-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / ph;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / ph;
          n.y = ph * sPct;
          n.resize(n.width, Math.max(1, ph - n.y - ph * ePct));
          c.vertical = 'SCALE';
        }
        n.constraints = c;
        return true;
      }
    `;

    const selector = buildNodeSelector(options);
    const code = `(async () => {
      ${selector}
      if (nodes.length === 0) return 'No node found';
      ${pinExpr}
      let count = 0;
      for (const n of nodes) if (pinOne(n)) count++;
      return 'Pinned ' + count + ' element(s) to ' + ${JSON.stringify(edge)};
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ UNWRAP (rescue a falsely-wrapped group of items) ============
//
// LLM callers sometimes create N similar items inside a single wrapper
// component when the user actually wanted N independent top-level items.
// `unwrap` rescues that: it takes a node, lifts every direct child up to
// the wrapper's parent (preserving canvas position), and deletes the
// wrapper. Works for FRAME, COMPONENT, GROUP, SECTION.

program
  .command('unwrap <nodeId>')
  .description('Lift the children of a wrapper node up to its parent, then delete the wrapper. Use when an LLM accidentally bundled N items into one component.')
  .option('--keep-wrapper', 'Move children out but keep the (now-empty) wrapper around')
  .action(async (nodeId, options) => {
    await checkConnection();
    const keepWrapper = !!options.keepWrapper;
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('children' in n) || !Array.isArray(n.children)) {
        return 'Node ' + n.id + ' has no children to unwrap';
      }
      const parent = n.parent;
      if (!parent) throw new Error('Wrapper has no parent (is it the page root?)');
      const isOnPage = parent.type === 'PAGE';
      const offsetX = isOnPage ? n.x : 0;
      const offsetY = isOnPage ? n.y : 0;
      const moved = [];
      // Snapshot children first — appendChild mutates the live array.
      const kids = n.children.slice();
      for (const c of kids) {
        const cx = c.x, cy = c.y;
        parent.appendChild(c);
        if (isOnPage && 'x' in c) {
          c.x = offsetX + cx;
          c.y = offsetY + cy;
        }
        moved.push(c.id);
      }
      const wrapperId = n.id;
      const wrapperName = n.name;
      if (!${keepWrapper}) n.remove();
      return { unwrapped: wrapperId, name: wrapperName, children: moved, deletedWrapper: !${keepWrapper} };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (typeof r === 'string') {
        console.log(chalk.yellow(r));
        return;
      }
      console.log(chalk.green(`✓ Unwrapped "${r.name}" (${r.unwrapped}) — ${r.children.length} child(ren) lifted to parent`));
      console.log(chalk.gray('  children: ' + r.children.join(', ')));
      if (r.deletedWrapper) console.log(chalk.gray('  wrapper deleted'));
      else console.log(chalk.gray('  wrapper kept (--keep-wrapper)'));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ USE (switch theme / rebind variables to a target collection) ============
//
// Solves the parallel-design-systems case: when the user has multiple
// collections with overlapping token names (e.g. airbnb and cursor both
// define primary / body / ink), `use <collection>` walks all variable
// bindings on the selection (or a node, or the whole page) and rebinds them
// to the target collection's variables — name-matched.
//
// Example: design a card bound to var:primary from the airbnb collection,
// run `figma-cli use cursor` while the card is selected → the same card
// now renders with Cursor's primary color. No re-design needed.

program
  .command('use <collection>')
  .alias('theme')
  .description('Switch variable bindings to a target collection. Re-binds every bound variable on the selection (or --node, or --all) to the same-named variable in <collection>.')
  .option('-n, --node <id>', 'Node ID (or comma-separated list of IDs)')
  .option('-a, --all', 'Apply to every node on the current page (not just selection)')
  .option('--dry-run', 'Print what would be rebound, don\'t modify anything')
  .action(async (collectionName, options) => {
    await checkConnection();
    const dryRun = !!options.dryRun;
    const target = collectionName;
    const baseSelector = options.all
      ? `const roots = figma.currentPage.children.slice();`
      : options.node
        ? (() => {
            const ids = String(options.node).split(/[\s,]+/).filter(Boolean);
            if (ids.length === 1) return `const __n = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const roots = __n ? [__n] : [];`;
            return `const __ids = ${JSON.stringify(ids)};
                    const __res = await Promise.all(__ids.map(id => figma.getNodeByIdAsync(id)));
                    const roots = __res.filter(Boolean);`;
          })()
        : `const roots = figma.currentPage.selection.slice();`;

    const code = `(async () => {
      ${baseSelector}
      if (roots.length === 0) return 'No node found (selection / --node / --all all empty)';

      // Resolve target collection (case-insensitive substring match)
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const targetQ = ${JSON.stringify(target.toLowerCase())};
      const targetCol = collections.find(c => c.name.toLowerCase() === targetQ)
                     || collections.find(c => c.name.toLowerCase().includes(targetQ));
      if (!targetCol) {
        return 'Collection not found: ${target}. Available: ' + collections.map(c => c.name).join(', ');
      }

      // Build name → variable map for the target collection
      const allVars = await figma.variables.getLocalVariablesAsync();
      const targetMap = {};
      for (const v of allVars) {
        if (v.variableCollectionId === targetCol.id) targetMap[v.name] = v;
      }
      if (Object.keys(targetMap).length === 0) {
        return 'Target collection "' + targetCol.name + '" has no variables';
      }

      // Walk every node recursively and find bindings to rebind
      const walked = [];
      const seen = new Set();
      function walk(n) {
        if (!n || seen.has(n.id)) return;
        seen.add(n.id);
        walked.push(n);
        if ('children' in n && n.children) for (const c of n.children) walk(c);
      }
      for (const r of roots) walk(r);

      let reboundCount = 0;
      const reboundNames = new Set();
      const missing = new Set();
      const dryRun = ${dryRun};

      // For each paint-bearing node, swap variable bindings on fills/strokes
      for (const n of walked) {
        for (const prop of ['fills', 'strokes']) {
          if (!(prop in n)) continue;
          const paints = n[prop];
          if (!Array.isArray(paints) || paints.length === 0) continue;
          let changed = false;
          const newPaints = paints.map(paint => {
            if (!paint.boundVariables || !paint.boundVariables.color) return paint;
            const oldRef = paint.boundVariables.color;
            const oldVar = oldRef && oldRef.id ? allVars.find(v => v.id === oldRef.id) : null;
            if (!oldVar) return paint;
            // Already in target collection → leave alone
            if (oldVar.variableCollectionId === targetCol.id) return paint;
            const newVar = targetMap[oldVar.name];
            if (!newVar) { missing.add(oldVar.name); return paint; }
            reboundCount++;
            reboundNames.add(oldVar.name);
            changed = true;
            if (dryRun) return paint;
            return figma.variables.setBoundVariableForPaint(paint, 'color', newVar);
          });
          if (changed && !dryRun) n[prop] = newPaints;
        }
        // Also handle scalar bindings (cornerRadius, opacity, strokeWeight, …)
        // via the generic boundVariables map.
        if ('boundVariables' in n && n.boundVariables) {
          for (const [field, ref] of Object.entries(n.boundVariables)) {
            if (!ref || !ref.id) continue;
            // Some fields are arrays (fills/strokes already handled above)
            if (Array.isArray(ref)) continue;
            const oldVar = allVars.find(v => v.id === ref.id);
            if (!oldVar) continue;
            if (oldVar.variableCollectionId === targetCol.id) continue;
            const newVar = targetMap[oldVar.name];
            if (!newVar) { missing.add(oldVar.name); continue; }
            reboundCount++;
            reboundNames.add(oldVar.name);
            if (!dryRun) {
              try { n.setBoundVariable(field, newVar); } catch (e) { /* unsupported field */ }
            }
          }
        }
      }

      return {
        targetCollection: targetCol.name,
        nodesWalked: walked.length,
        rebindings: reboundCount,
        uniqueTokens: [...reboundNames].sort(),
        missingInTarget: [...missing].sort(),
        dryRun,
      };
    })()`;

    try {
      const r = await daemonExec('eval', { code });
      if (typeof r === 'string') {
        console.error(chalk.yellow(r));
        return;
      }
      const verb = r.dryRun ? 'Would rebind' : 'Rebound';
      console.log(chalk.green(`✓ ${verb} ${r.rebindings} binding(s) on ${r.nodesWalked} node(s) → ${r.targetCollection}`));
      if (r.uniqueTokens.length > 0) {
        console.log(chalk.gray(`  tokens: ${r.uniqueTokens.join(', ')}`));
      }
      if (r.missingInTarget.length > 0) {
        console.log(chalk.yellow(`  ⚠ not found in ${r.targetCollection}: ${r.missingInTarget.join(', ')}`));
        console.log(chalk.gray(`    (those bindings were left pointing at the original collection)`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ INSPECT (reverse: Figma → Spec) ============

program
  .command('inspect <nodeId>')
  .description('Inspect a node and emit its position as Spec-canonical properties (start/end/centerOffset/etc.). JSON output via --json.')
  .option('--json', 'Output as JSON (machine-readable)')
  .option('--spec', 'Output only the absolute-positioning spec block (compact)')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      const p = n.parent;
      const out = {
        id: n.id,
        name: n.name,
        type: n.type,
        width: 'width' in n ? n.width : null,
        height: 'height' in n ? n.height : null,
      };
      // Absolute-positioning spec output. Mirrors the directededges spec:
      // active keys carry computed values, inactive ones are null (so a
      // consumer can diff variants reliably).
      if (n.layoutPositioning === 'ABSOLUTE' && p && 'width' in p) {
        const c = n.constraints || { horizontal: 'MIN', vertical: 'MIN' };
        const pw = p.width, ph = p.height;
        const pos = {
          position: 'ABSOLUTE',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: n.width, height: n.height,
          layoutSizingHorizontal: null, layoutSizingVertical: null,
        };
        const pct = (v) => {
          const p2 = Math.round(v * 10000) / 100;
          return (p2 % 1 === 0 ? p2.toFixed(0) : (p2 % 0.1 === 0 ? p2.toFixed(1) : p2.toFixed(2))) + '%';
        };
        switch (c.horizontal) {
          case 'MIN':     pos.start = n.x; break;
          case 'MAX':     pos.end = pw - n.x - n.width; break;
          case 'CENTER':  pos.centerHorizontalOffset = n.x + n.width / 2 - pw / 2; break;
          case 'STRETCH': pos.start = n.x; pos.end = pw - n.x - n.width; pos.width = null; break;
          case 'SCALE':   pos.start = pct(n.x / pw); pos.end = pct((pw - n.x - n.width) / pw); pos.width = null; break;
        }
        switch (c.vertical) {
          case 'MIN':     pos.top = n.y; break;
          case 'MAX':     pos.bottom = ph - n.y - n.height; break;
          case 'CENTER':  pos.centerVerticalOffset = n.y + n.height / 2 - ph / 2; break;
          case 'STRETCH': pos.top = n.y; pos.bottom = ph - n.y - n.height; pos.height = null; break;
          case 'SCALE':   pos.top = pct(n.y / ph); pos.bottom = pct((ph - n.y - n.height) / ph); pos.height = null; break;
        }
        out.absolutePositioning = pos;
      } else if (n.layoutPositioning === 'AUTO' || p?.layoutMode !== 'NONE') {
        out.absolutePositioning = {
          position: 'AUTO',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: null, height: null,
          layoutSizingHorizontal: n.layoutSizingHorizontal ?? null,
          layoutSizingVertical: n.layoutSizingVertical ?? null,
        };
      }
      // Raw geometry alongside, useful for debugging the spec output
      if ('x' in n) {
        out.raw = { x: n.x, y: n.y, constraints: n.constraints };
      }
      return out;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (options.spec) {
        console.log(JSON.stringify(r.absolutePositioning, null, 2));
      } else {
        console.log(chalk.cyan(`${r.name || '(unnamed)'} (${r.id}) — ${r.type}`));
        console.log(chalk.gray(`  size: ${r.width}×${r.height}`));
        if (r.absolutePositioning) {
          console.log(chalk.cyan('  Absolute Positioning spec:'));
          for (const [k, v] of Object.entries(r.absolutePositioning)) {
            if (v !== null) console.log(`    ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
          }
        }
        if (r.raw) {
          console.log(chalk.gray(`  raw: x=${r.raw.x}, y=${r.raw.y}, constraints=${JSON.stringify(r.raw.constraints)}`));
        }
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ ARRANGE ============

program
  .command('unstack')
  .description('Find top-level nodes overlapping at the same position and spread them out. Keeps the first one in place, moves the rest. Non-destructive: leaves laid-out designs alone.')
  .option('-g, --gap <n>', 'Gap between unstacked items', '100')
  .option('--dry-run', 'Report what would move, do not modify anything')
  .action(async (options) => {
    await checkConnection();
    const gap = parseInt(options.gap) || 100;
    const dryRun = !!options.dryRun;
    const code = `(async () => {
      // Bucket every top-level node by its current (x,y) rounded to the nearest
      // integer. Anything with >1 entry in a bucket is overlapping at that origin.
      const top = figma.currentPage.children.filter(n =>
        typeof n.x === 'number' && typeof n.y === 'number');
      const buckets = new Map();
      for (const n of top) {
        const key = Math.round(n.x) + ',' + Math.round(n.y);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(n);
      }
      const moves = [];
      let xCursor = -Infinity;
      // Find the rightmost edge to start unstacking past existing layout
      for (const n of top) {
        xCursor = Math.max(xCursor, n.x + (n.width || 0));
      }
      if (!isFinite(xCursor)) xCursor = 0;
      xCursor += ${gap};
      for (const [key, group] of buckets) {
        if (group.length < 2) continue;
        // Keep the first one; move the rest to the right of everything else
        for (let i = 1; i < group.length; i++) {
          const n = group[i];
          moves.push({ id: n.id, name: n.name, from: { x: n.x, y: n.y }, to: { x: xCursor, y: 0 } });
          if (!${dryRun}) { n.x = xCursor; n.y = 0; }
          xCursor += (n.width || 100) + ${gap};
        }
      }
      return { moved: moves.length, moves: moves.slice(0, 12), totalOverlaps: moves.length, dryRun: ${dryRun} };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (!r || r.moved === 0) {
        console.log(chalk.green('✓ No overlapping top-level nodes found'));
        return;
      }
      const verb = r.dryRun ? 'Would move' : 'Moved';
      console.log(chalk.green(`✓ ${verb} ${r.moved} overlapping node(s)`));
      for (const m of r.moves) {
        console.log(chalk.gray(`  ${m.name} (${m.id}): (${m.from.x},${m.from.y}) → (${m.to.x},${m.to.y})`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

program
  .command('arrange')
  .description('Arrange ALL top-level frames on canvas — destructive, sorts alphabetically. For just-fix-overlaps use `unstack` instead.')
  .option('-g, --gap <n>', 'Gap between frames', '100')
  .option('-c, --cols <n>', 'Number of columns (0 = single row)', '0')
  .action((options) => {
    checkConnection();
    let code = `
const frames = figma.currentPage.children.filter(n => n.type === 'FRAME' || n.type === 'COMPONENT');
if (frames.length === 0) 'No frames to arrange';
else {
  frames.sort((a, b) => a.name.localeCompare(b.name));
  let x = 0, y = 0, rowHeight = 0, col = 0;
  const gap = ${options.gap};
  const cols = ${options.cols};
  frames.forEach((f, i) => {
    f.x = x;
    f.y = y;
    rowHeight = Math.max(rowHeight, f.height);
    if (cols > 0 && ++col >= cols) {
      col = 0;
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    } else {
      x += f.width + gap;
    }
  });
  'Arranged ' + frames.length + ' frames';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ GET ============

program
  .command('get [nodeId]')
  .description('Get properties of node or selection')
  .action((nodeId) => {
    checkConnection();
    const nodeSelector = nodeId
      ? `const node = await figma.getNodeByIdAsync('${nodeId}');`
      : `const node = figma.currentPage.selection[0];`;
    let code = `(async () => {
${nodeSelector}
if (!node) return 'No node found';
return JSON.stringify({
  id: node.id,
  name: node.name,
  type: node.type,
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  visible: node.visible,
  locked: node.locked,
  opacity: node.opacity,
  rotation: node.rotation,
  cornerRadius: node.cornerRadius,
  layoutMode: node.layoutMode,
  fills: node.fills?.length,
  strokes: node.strokes?.length,
  children: node.children?.length
}, null, 2);
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ FIND ============

program
  .command('find <name>')
  .description('Find nodes by name (partial match)')
  .option('-t, --type <type>', 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)')
  .option('-l, --limit <n>', 'Limit results', '20')
  .action((name, options) => {
    checkConnection();
    let code = `(function() {
const results = [];
function search(node) {
  if (node.name && node.name.toLowerCase().includes('${name.toLowerCase()}')) {
    ${options.type ? `if (node.type === '${options.type.toUpperCase()}')` : ''}
    results.push({ id: node.id, name: node.name, type: node.type });
  }
  if (node.children && results.length < ${options.limit}) {
    node.children.forEach(search);
  }
}
search(figma.currentPage);
return results.length === 0 ? 'No nodes found matching "${name}"' : results.slice(0, ${options.limit}).map(r => r.id + ' [' + r.type + '] ' + r.name).join('\\n');
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ RENDER ============

// Helper: Get next free X position for smart positioning (horizontal)
function getNextFreeX(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxX = 0;
      figma.currentPage.children.forEach(n => {
        maxX = Math.max(maxX, n.x + n.width);
      });
      return maxX;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

// Helper: Get next free Y position for smart positioning (vertical)
function getNextFreeY(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxY = 0;
      figma.currentPage.children.forEach(n => {
        maxY = Math.max(maxY, n.y + n.height);
      });
      return maxY;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

// Helper: Extract properties that figma-use doesn't handle correctly
// Returns array of fixes to apply after render
function extractPostProcessFixes(jsx) {
  const fixes = [];

  // Match ALL Frame elements with wrapGap (counterAxisSpacing) - including nested
  const wrapGapRegex = /<Frame[^>]*\bwrapGap=\{(\d+)\}[^>]*>/g;
  let wrapMatch;
  while ((wrapMatch = wrapGapRegex.exec(jsx)) !== null) {
    const tag = wrapMatch[0];
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/);
    fixes.push({
      type: 'wrapGap',
      name: nameMatch ? nameMatch[1] : null,
      value: parseInt(wrapMatch[1])
    });
  }

  // Match absolute positioned children with x/y
  const absRegex = /<Frame[^>]*\bposition=["']absolute["'][^>]*>/g;
  let match;
  while ((match = absRegex.exec(jsx)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/);
    const xMatch = tag.match(/\bx=\{(\d+)\}/);
    const yMatch = tag.match(/\by=\{(\d+)\}/);

    if (nameMatch && (xMatch || yMatch)) {
      fixes.push({
        type: 'absolutePosition',
        name: nameMatch[1],
        x: xMatch ? parseInt(xMatch[1]) : null,
        y: yMatch ? parseInt(yMatch[1]) : null
      });
    }
  }

  return fixes;
}

// Helper: Apply post-process fixes to rendered node
async function applyPostProcessFixes(nodeId, fixes) {
  const code = `(async function() {
    const root = await figma.getNodeByIdAsync('${nodeId}');
    if (!root) return { error: 'Node not found' };

    const results = [];

    // Helper to find node by name recursively
    const findByName = (node, name) => {
      if (node.name === name) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findByName(child, name);
          if (found) return found;
        }
      }
      return null;
    };

    // Helper to find all nodes with layoutWrap
    const findAllWrap = (node, results = []) => {
      if (node.layoutWrap === 'WRAP') results.push(node);
      if (node.children) {
        for (const child of node.children) {
          findAllWrap(child, results);
        }
      }
      return results;
    };

    ${fixes.map((fix, i) => {
      if (fix.type === 'wrapGap') {
        if (fix.name) {
          // Named element - find by name
          return `
            // Fix wrapGap for "${fix.name}"
            const wrapNode${i} = findByName(root, '${fix.name}');
            if (wrapNode${i} && wrapNode${i}.layoutWrap === 'WRAP') {
              wrapNode${i}.counterAxisSpacing = ${fix.value};
              results.push({ type: 'wrapGap', name: '${fix.name}', value: ${fix.value}, applied: true });
            }
          `;
        } else {
          // No name - apply to first wrap element (root or first found)
          return `
            // Fix wrapGap on first wrap element
            const wrapNodes${i} = findAllWrap(root);
            if (wrapNodes${i}.length > 0) {
              wrapNodes${i}[0].counterAxisSpacing = ${fix.value};
              results.push({ type: 'wrapGap', value: ${fix.value}, applied: true });
            }
          `;
        }
      } else if (fix.type === 'absolutePosition') {
        return `
          // Fix absolute position for "${fix.name}"
          const absNode${i} = findByName(root, '${fix.name}');
          if (absNode${i} && absNode${i}.layoutPositioning === 'ABSOLUTE') {
            ${fix.x !== null ? `absNode${i}.x = ${fix.x};` : ''}
            ${fix.y !== null ? `absNode${i}.y = ${fix.y};` : ''}
            results.push({ type: 'absolutePosition', name: '${fix.name}', x: ${fix.x}, y: ${fix.y}, applied: true });
          }
        `;
      }
      return '';
    }).join('\n')}

    return { fixes: results };
  })()`;

  try {
    if (isDaemonRunning()) {
      await daemonExec('eval', { code });
    } else {
      figmaEvalSync(code);
    }
  } catch (e) {
    // Silent fail - fixes are best-effort
  }
}

// Fast JSX parser for simple frames (daemon-based, 4x faster)
function parseSimpleJsx(jsx) {
  // Only handles single Frame element, no nesting
  const frameMatch = jsx.match(/^<Frame\s+([^>]+)\s*\/?>(?:<\/Frame>)?$/);
  if (!frameMatch) return null;

  const propsStr = frameMatch[1];
  const props = {};

  // Parse props: name="X" or name={X} or name='X'
  const propRegex = /(\w+)=(?:\{([^}]+)\}|"([^"]+)"|'([^']+)')/g;
  let match;
  while ((match = propRegex.exec(propsStr)) !== null) {
    const key = match[1];
    const value = match[2] || match[3] || match[4];
    props[key] = value;
  }

  return props;
}

function generateFigmaCode(props, x, y) {
  const name = props.name || 'Frame';
  const w = parseInt(props.w || props.width || 100);
  const h = parseInt(props.h || props.height || 100);
  const bg = props.bg || props.fill;
  const rounded = parseInt(props.rounded || props.cornerRadius || 0);
  const opacity = props.opacity ? parseFloat(props.opacity) : null;

  let code = `(function() {
    const f = figma.createFrame();
    f.name = '${name}';
    f.resize(${w}, ${h});
    f.x = ${x};
    f.y = ${y};`;

  if (rounded > 0) code += `\n    f.cornerRadius = ${rounded};`;
  if (opacity !== null) code += `\n    f.opacity = ${opacity};`;

  if (bg) {
    // Parse hex color
    const hex = bg.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    code += `\n    f.fills = [{type:'SOLID', color:{r:${r.toFixed(3)},g:${g.toFixed(3)},b:${b.toFixed(3)}}}];`;
  }

  code += `\n    return { id: f.id, name: f.name };
  })()`;

  return code;
}

program
  .command('render <jsx>')
  .description('Render JSX to Figma (use --as-component to also convert result to a Figma component)')
  .option('--parent <id>', 'Parent node ID')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .option('--fast', 'Use fast daemon-based rendering (simple frames only)')
  .option('--as-component', 'After rendering, convert the resulting frame to a Figma component')
  .option('--keep-wrapper', 'Keep an outer flex Frame as a parent — disables the auto-split that turns "N items in a flex wrapper" into independent canvas items')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .action(async (rawJsx, options) => {
    const jsx = unescapeShell(rawJsx);
    await checkConnection();

    // Auto-split: if the caller passed a layout-only outer Frame with N child
    // Frames, treat it as render-batch. This is the canonical "N buttons / N
    // cards" intent — independent items, not a single bagged Frame. Opt out
    // with --keep-wrapper.
    if (!options.keepWrapper) {
      const split = detectWrapperSplit(jsx);
      if (split) {
        console.log(chalk.gray(`↳ outer flex wrapper detected — splitting to ${split.children.length} standalone items (--keep-wrapper to opt out)`));
        const args = [
          'render-batch',
          JSON.stringify(split.children),
          '--direction', split.direction,
        ];
        if (options.asComponent) args.push('--as-component');
        if (options.collection) args.push('--collection', options.collection);
        await program.parseAsync(args, { from: 'user' });
        return;
      }
    }

    try {
      // Helper: convert a rendered frame to a Figma component if --as-component was passed
      const maybeAsComponent = async (id) => {
        if (!options.asComponent) return;
        try {
          const r = await daemonExec('eval', { code:
            `(async () => {
              const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
              if (!n) throw new Error('Node not found after render: ${id}');
              const c = figma.createComponentFromNode(n);
              return { id: c.id, name: c.name };
            })()`
          });
          if (r && r.id) {
            console.log(chalk.green('✓ Converted to component: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
          }
        } catch (e) {
          console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
        }
      };

      // Calculate smart position if not specified
      let posX = options.x;
      let posY = options.y !== undefined ? options.y : 0;

      if (!options.parent && options.x === undefined && options.smartPosition !== false) {
        posX = getNextFreeX();
      }

      // Check if JSX uses features that require our own renderer:
      // - var:name syntax for variable binding
      // - <Slot> elements for component slots
      // - <Icon> elements
      // - gradient/effects/blur (needs full parser, fast-path doesn't handle them)
      if (jsx.includes('var:') || jsx.includes('<Slot') || jsx.includes('<Icon') ||
          /-gradient\s*\(/i.test(jsx) || jsx.includes('shadow=') || jsx.includes('innerShadow=') ||
          jsx.includes('blur=') || jsx.includes('bgBlur=') || jsx.includes('image=')) {
        const { FigmaClient } = await import('./figma-client.js');
        const client = new FigmaClient();
        if (options.collection) client.setCollection(options.collection);
        const code = await client.parseJSX(jsx);
        const result = await daemonExec('eval', { code });
        if (result && result.id) {
          console.log(chalk.green('✓ Rendered: ' + result.id));
          if (result.name) console.log(chalk.gray('  name: ' + result.name));
          await maybeAsComponent(result.id);
          return;
        }
      }

      // Try fast path for simple frames
      if (options.fast || (!jsx.includes('><') && !jsx.includes('</Frame><'))) {
        const simpleProps = parseSimpleJsx(jsx.trim());
        if (simpleProps && isDaemonRunning()) {
          const code = generateFigmaCode(simpleProps, posX || 0, posY);
          const result = await daemonExec('eval', { code });
          if (result && result.id) {
            console.log(chalk.green('✓ Rendered: ' + result.id));
            if (result.name) console.log(chalk.gray('  name: ' + result.name));
            await maybeAsComponent(result.id);
            return;
          }
        }
      }

      // Extract props that figma-use doesn't handle correctly
      const postProcessFixes = extractPostProcessFixes(jsx);

      // Check if we're in Safe Mode (plugin only, no CDP)
      let useDaemonRender = false;
      try {
        const healthToken = getDaemonToken();
        const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
        const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
        const health = JSON.parse(healthRes);
        useDaemonRender = health.plugin && !health.cdp; // Safe Mode
      } catch {}

      let result;
      if (useDaemonRender) {
        // Safe Mode: use daemon render (works via plugin)
        result = await daemonExec('render', { jsx });
        // Position the frame after creation
        if (result && result.id && (posX !== undefined || posY !== undefined)) {
          await fastEval(`(async () => {
            const n = await figma.getNodeByIdAsync("${result.id}");
            if (n) { ${posX !== undefined ? `n.x = ${posX};` : ''} n.y = ${posY}; }
          })()`);
        }
      } else {
        // Yolo Mode: use figma-use (full JSX support, faster)
        let cmd = 'figma-use render --stdin --json';
        if (options.parent) cmd += ` --parent "${options.parent}"`;
        if (posX !== undefined) cmd += ` --x ${posX}`;
        cmd += ` --y ${posY}`;

        const output = execSync(cmd, {
          input: jsx,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000
        });
        result = JSON.parse(output.trim());
      }

      console.log(chalk.green('✓ Rendered: ' + result.id));
      if (result.name) console.log(chalk.gray('  name: ' + result.name));

      // Post-process to fix properties figma-use doesn't set correctly
      if (postProcessFixes.length > 0) {
        await applyPostProcessFixes(result.id, postProcessFixes);
      }

      await maybeAsComponent(result.id);
    } catch (e) {
      const msg = e.stderr || e.message || String(e);
      // Extract node context from error if available
      const nodeMatch = msg.match(/\[Node: ([^\]]+)\]/);
      if (nodeMatch) {
        console.log(chalk.red('✗ Render failed at ' + chalk.yellow(nodeMatch[1]) + ':'));
        console.log(chalk.red('  ' + msg.replace(/\[Node: [^\]]+\]\s*/, '')));
      } else {
        console.log(chalk.red('✗ Render failed: ' + msg));
      }
      // Hint for common errors
      if (msg.includes('FILL can only be set on children of auto-layout')) {
        console.log(chalk.yellow('  💡 Hint: w="fill" requires the parent Frame to have flex="row" or flex="col"'));
      }
      if (msg.includes('Cannot read properties of null')) {
        console.log(chalk.yellow('  💡 Hint: A variable binding (var:name) may not exist. Check with: var list'));
      }
    }
  });

program
  .command('render-batch')
  .description('Render multiple JSX frames in a single call (fast). Pass --as-component to promote each rendered frame to a Figma Component.')
  .argument('<jsxArray>', 'JSON array of JSX strings, e.g. \'["<Frame>...</Frame>","<Frame>...</Frame>"]\'')
  .option('-g, --gap <n>', 'Gap between frames', '40')
  .option('-d, --direction <dir>', 'Layout direction: row (horizontal) or col (vertical)', 'row')
  .option('--as-component', 'After rendering, convert each resulting frame to a Figma component')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .action(async (jsxArrayStr, options) => {
    await checkConnection();
    try {
      const jsxArray = JSON.parse(jsxArrayStr);
      if (!Array.isArray(jsxArray)) {
        throw new Error('Argument must be a JSON array of JSX strings');
      }

      const gap = parseInt(options.gap) || 40;
      const vertical = options.direction === 'col' || options.direction === 'column' || options.direction === 'vertical';

      // Single daemon call for ALL frames (10x faster)
      let results = await daemonExec('render-batch', {
        jsxArray,
        gap,
        vertical,
        collection: options.collection || undefined,
      });
      // Unwrap the wrapped form returned when there are unresolved vars.
      let unresolvedVars = null;
      if (results && !Array.isArray(results) && Array.isArray(results.frames)) {
        unresolvedVars = results.unresolved;
        results = results.frames;
      }

      if (Array.isArray(results)) {
        results.forEach(r => {
          console.log(chalk.green('✓ Rendered: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
        });
        console.log(chalk.cyan(`\n${results.length} frames created`));
        if (unresolvedVars && unresolvedVars.length > 0) {
          console.log(chalk.yellow(`\n⚠ ${unresolvedVars.length} variable reference(s) could not be resolved:`));
          console.log(chalk.yellow('  ' + unresolvedVars.join(', ')));
          console.log(chalk.gray('  These bindings rendered as grey placeholders. Check `figma-cli var list` (optionally with --collection).'));
        }

        if (options.asComponent) {
          const ids = results.map(r => r.id).filter(Boolean);
          if (ids.length > 0) {
            try {
              const compInfo = await daemonExec('eval', { code:
                `(async () => {
                  const ids = ${JSON.stringify(ids)};
                  const out = [];
                  for (const id of ids) {
                    const n = await figma.getNodeByIdAsync(id);
                    if (!n) continue;
                    const c = figma.createComponentFromNode(n);
                    out.push({ id: c.id, name: c.name });
                  }
                  return out;
                })()`
              });
              if (Array.isArray(compInfo)) {
                compInfo.forEach(c => {
                  console.log(chalk.green('✓ Converted to component: ' + c.id + (c.name ? ' (' + c.name + ')' : '')));
                });
                console.log(chalk.cyan(`\n${compInfo.length} components created`));
              }
            } catch (e) {
              console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
            }
          }
        }
      } else {
        console.log(chalk.green('✓ Rendered'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Batch render failed: ' + (e.stderr || e.message)));
    }
  });

// ============ DIAGNOSE ============

program
  .command('diagnose')
  .description('Check system compatibility and connection status')
  .action(async () => {
    console.log(chalk.cyan('\n🔍 Figma CLI Diagnostics\n'));

    // 1. Node version
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor >= 18) {
      console.log(chalk.green(`✓ Node.js ${nodeVersion}`));
    } else {
      console.log(chalk.red(`✗ Node.js ${nodeVersion} (need 18+)`));
    }

    // 2. Platform
    console.log(chalk.gray(`  Platform: ${platformName}`));

    // 3. Figma version
    try {
      const figmaVersion = getFigmaVersion();
      const major = parseInt(figmaVersion.split('.')[0]);
      if (major >= 126) {
        console.log(chalk.yellow(`⚠ Figma ${figmaVersion} (126+ blocks remote debugging by default)`));
      } else {
        console.log(chalk.green(`✓ Figma ${figmaVersion}`));
      }
    } catch {
      console.log(chalk.red('✗ Figma not found'));
    }

    // 4. Figma running?
    try {
      if (isFigmaRunning()) {
        console.log(chalk.green('✓ Figma is running'));
      } else {
        console.log(chalk.red('✗ Figma is not running'));
      }
    } catch {
      console.log(chalk.gray('  Could not check if Figma is running'));
    }

    // 5. Remote debugging port
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        console.log(chalk.green('✓ Remote debugging enabled (port 9222)'));
      } else {
        console.log(chalk.red('✗ Remote debugging port not responding'));
      }
    } catch {
      console.log(chalk.red('✗ Remote debugging not available (port 9222 closed)'));
      console.log(chalk.gray('  → Run: node src/index.js connect'));
    }

    // 6. Daemon status
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon running on port 3456'));
    } else {
      console.log(chalk.yellow('○ Daemon not running (optional, speeds up commands)'));
    }

    // 7. figma-use availability
    try {
      execSync('which figma-use 2>/dev/null || where figma-use 2>nul', { encoding: 'utf8' });
      console.log(chalk.green('✓ figma-use installed'));
    } catch {
      console.log(chalk.yellow('○ figma-use not in PATH (some features limited)'));
    }

    // 8. Connection test
    console.log(chalk.gray('\n  Testing connection...'));
    try {
      const client = await getFigmaClient();
      const result = await client.eval('({ file: figma.root.name, page: figma.currentPage.name })');
      console.log(chalk.green(`✓ Connected to "${result.file}" / "${result.page}"`));
    } catch (e) {
      console.log(chalk.red('✗ Connection failed: ' + e.message));
    }

    console.log('');
  });

// ============ EXPORT ============

const exp = program
  .command('export')
  .description('Export from Figma');

exp
  .command('screenshot')
  .description('Take a screenshot of selected node or current page')
  .option('-o, --output <file>', 'Output file', 'screenshot.png')
  .option('-s, --scale <number>', 'Export scale (1-4)', '2')
  .option('-f, --format <format>', 'Format: png, jpg, svg, pdf', 'png')
  .action((options) => {
    checkConnection();
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
    const code = `(async () => {
const sel = figma.currentPage.selection;
const node = sel.length > 0 ? sel[0] : figma.currentPage;
if (!node) return { error: 'No page or selection' };
if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
const bytes = await node.exportAsync({ format: '${format}', constraint: { type: 'SCALE', value: ${scale} } });
return {
  name: node.name,
  id: node.id,
  width: Math.round(node.width * ${scale}),
  height: Math.round(node.height * ${scale}),
  bytes: Array.from(bytes)
};
})()`;
    const result = figmaEvalSync(code);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }
    const buffer = Buffer.from(result.bytes);
    const outputFile = options.output === 'screenshot.png' && format !== 'PNG'
      ? `screenshot.${format.toLowerCase()}`
      : options.output;
    writeFileSync(outputFile, buffer);
    console.log(chalk.green('✓'), `Screenshot: ${result.name} (${result.width}x${result.height}) → ${outputFile}`);
  });

exp
  .command('node <nodeId>')
  .description('Export a node by ID as PNG')
  .option('-o, --output <file>', 'Output file', 'node-export.png')
  .option('-s, --scale <number>', 'Export scale', '2')
  .option('-f, --format <format>', 'Format: png, svg, pdf, jpg', 'png')
  .action((nodeId, options) => {
    checkConnection();
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
    const code = `(async () => {
const node = await figma.getNodeByIdAsync('${nodeId}');
if (!node) return { error: 'Node not found: ${nodeId}' };
if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
const bytes = await node.exportAsync({ format: '${format}', constraint: { type: 'SCALE', value: ${scale} } });
return {
  name: node.name,
  id: node.id,
  width: node.width,
  height: node.height,
  bytes: Array.from(bytes)
};
})()`;
    const result = figmaEvalSync(code);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }
    const buffer = Buffer.from(result.bytes);
    const outputFile = options.output === 'node-export.png' && format !== 'PNG'
      ? `node-export.${format.toLowerCase()}`
      : options.output;
    writeFileSync(outputFile, buffer);
    console.log(chalk.green('✓'), `Exported ${result.name} (${result.width}x${result.height}) to ${outputFile}`);
  });

exp
  .command('css')
  .description('Export variables as CSS custom properties')
  .action(() => {
    checkConnection();
    const code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
const css = vars.map(v => {
  const val = Object.values(v.valuesByMode)[0];
  if (v.resolvedType === 'COLOR') {
    const hex = '#' + [val.r, val.g, val.b].map(n => Math.round(n*255).toString(16).padStart(2,'0')).join('');
    return '  --' + v.name.replace(/\\//g, '-') + ': ' + hex + ';';
  }
  return '  --' + v.name.replace(/\\//g, '-') + ': ' + val + (v.resolvedType === 'FLOAT' ? 'px' : '') + ';';
}).join('\\n');
return ':root {\\n' + css + '\\n}';
})()`;
    const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
    console.log(result);
  });

exp
  .command('tailwind')
  .description('Export color variables as Tailwind config')
  .action(() => {
    checkConnection();
    const code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
const colorVars = vars.filter(v => v.resolvedType === 'COLOR');
const colors = {};
colorVars.forEach(v => {
  const val = Object.values(v.valuesByMode)[0];
  const hex = '#' + [val.r, val.g, val.b].map(n => Math.round(n*255).toString(16).padStart(2,'0')).join('');
  const parts = v.name.split('/');
  if (parts.length === 2) {
    if (!colors[parts[0]]) colors[parts[0]] = {};
    colors[parts[0]][parts[1]] = hex;
  } else {
    colors[v.name.replace(/\\//g, '-')] = hex;
  }
});
return JSON.stringify({ theme: { extend: { colors } } }, null, 2);
})()`;
    const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
    console.log(result);
  });

// ============ VERIFY (AI Screenshot Check) ============

program
  .command('verify [nodeId]')
  .description('Take a small screenshot for AI verification (returns base64 or saves to file)')
  .option('-s, --scale <number>', 'Export scale (default: 0.5 for small size)', '0.5')
  .option('--max <pixels>', 'Max dimension in pixels (default: 2000)', '2000')
  .option('--save [path]', 'Save as PNG file (default: /tmp/figma-verify-{id}.png)')
  .action((nodeId, options) => {
    checkConnection();
    const scale = parseFloat(options.scale);
    const maxDim = parseInt(options.max);

    const code = `(async () => {
      let node;
      ${nodeId ? `node = await figma.getNodeByIdAsync('${nodeId}');` : `
      const sel = figma.currentPage.selection;
      node = sel.length > 0 ? sel[0] : null;
      `}
      if (!node) return { error: 'No node selected or found' };
      if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };

      // Calculate optimal scale to stay under max dimension
      const nodeWidth = node.width || 100;
      const nodeHeight = node.height || 100;
      let finalScale = ${scale};
      const maxNodeDim = Math.max(nodeWidth, nodeHeight);
      if (maxNodeDim * finalScale > ${maxDim}) {
        finalScale = ${maxDim} / maxNodeDim;
      }
      // Ensure we don't exceed 8000px (API limit)
      if (maxNodeDim * finalScale > 7500) {
        finalScale = 7500 / maxNodeDim;
      }

      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: finalScale }
      });

      // Convert to base64
      const base64 = figma.base64Encode(bytes);

      return {
        name: node.name,
        id: node.id,
        width: Math.round(nodeWidth * finalScale),
        height: Math.round(nodeHeight * finalScale),
        scale: finalScale,
        base64: base64
      };
    })()`;

    const result = figmaEvalSync(code);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }

    // Save to file if --save option provided
    if (options.save !== undefined) {
      const safeId = result.id.replace(/:/g, '-');
      const savePath = typeof options.save === 'string'
        ? options.save
        : `/tmp/figma-verify-${safeId}.png`;

      const buffer = Buffer.from(result.base64, 'base64');
      writeFileSync(savePath, buffer);

      console.log(JSON.stringify({
        name: result.name,
        id: result.id,
        width: result.width,
        height: result.height,
        saved: savePath
      }));
    } else {
      // Output as JSON for easy parsing
      console.log(JSON.stringify({
        name: result.name,
        id: result.id,
        width: result.width,
        height: result.height,
        base64: result.base64
      }));
    }
  });

// ============ EVAL ============

program
  .command('eval [code]')
  .description('Execute JavaScript in Figma plugin context')
  .option('-f, --file <path>', 'Run code from file instead of argument')
  .action(async (code, options) => {
    checkConnection();
    let jsCode = code ? unescapeShell(code) : code;

    // If --file option provided, read code from file
    if (options.file) {
      if (!existsSync(options.file)) {
        console.log(chalk.red('✗ File not found: ' + options.file));
        return;
      }
      jsCode = readFileSync(options.file, 'utf8');
    }

    if (!jsCode) {
      console.log(chalk.red('✗ No code provided. Use: eval "code" or eval --file /path/to/script.js'));
      return;
    }

    // Always prefer async daemon (more reliable, no shell timeout issues)
    if (isDaemonRunning()) {
      try {
        const result = await daemonExec('eval', { code: jsCode });
        if (result !== undefined && result !== null) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
        return;
      } catch (e) {
        // Check if this is a connection/daemon error vs user code error
        const isConnectionError = e.message.includes('ECONNREFUSED') ||
                                  e.message.includes('fetch failed') ||
                                  e.message.includes('network') ||
                                  e.message.includes('timeout') ||
                                  e.message.includes('disconnected');
        if (isConnectionError) {
          // Connection/daemon error - fall back to sync path
          console.log(chalk.yellow('⚠ Daemon error, trying sync path...'));
        } else {
          // User code error - display directly, don't fall back
          console.log(chalk.red('✗ ' + e.message));
          return;
        }
      }
    }

    // Sync fallback (when daemon not running)
    try {
      const result = figmaEvalSync(jsCode);
      if (result !== undefined && result !== null) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (error) {
      console.log(chalk.red('✗ ' + error.message));
    }
  });

// Run command - alias for eval --file (uses async for better performance)
program
  .command('run <file>')
  .description('Run JavaScript file in Figma (alias for eval --file)')
  .action(async (file) => {
    checkConnection();
    if (!existsSync(file)) {
      console.log(chalk.red('✗ File not found: ' + file));
      return;
    }
    const code = readFileSync(file, 'utf8');
    try {
      // Use async daemon path for better performance with long scripts
      if (isDaemonRunning()) {
        const result = await daemonExec('eval', { code });
        if (result !== undefined) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
      } else {
        // Fallback to sync path
        figmaUse(`eval "${code.replace(/"/g, '\\"')}"`);
      }
    } catch (e) {
      console.log(chalk.red('✗ ' + e.message));
    }
  });

// ============ PASSTHROUGH ============

program
  .command('raw <command...>')
  .description('Run raw figma-use command')
  .action((command) => {
    checkConnection();
    figmaUse(command.join(' '));
  });

// ============ DESIGN ANALYSIS ============

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

program
  .command('lint')
  .description('Lint design for issues')
  .option('--fix', 'Auto-fix issues where possible')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      // Safe Mode: native implementation
      const code = `(async () => {
        const issues = [];
        const page = figma.currentPage;

        function checkNode(node, depth = 0) {
          // Check for missing names
          if (node.name.startsWith('Frame') || node.name.startsWith('Rectangle') || node.name.startsWith('Group')) {
            issues.push({ type: 'naming', severity: 'warning', node: node.id, name: node.name, message: 'Generic name, consider renaming' });
          }

          // Check for hardcoded colors (not bound to variables)
          if (node.fills && Array.isArray(node.fills)) {
            const hasFillBinding = node.boundVariables && node.boundVariables.fills;
            if (!hasFillBinding && node.fills.some(f => f.type === 'SOLID')) {
              issues.push({ type: 'color', severity: 'info', node: node.id, name: node.name, message: 'Hardcoded fill color' });
            }
          }

          // Check text for missing styles
          if (node.type === 'TEXT' && !node.textStyleId) {
            issues.push({ type: 'typography', severity: 'info', node: node.id, name: node.name, message: 'Text without style' });
          }

          // Check for tiny text
          if (node.type === 'TEXT' && node.fontSize < 12) {
            issues.push({ type: 'accessibility', severity: 'warning', node: node.id, name: node.name, message: 'Text size < 12px may be hard to read' });
          }

          // Recurse
          if ('children' in node) {
            node.children.forEach(c => checkNode(c, depth + 1));
          }
        }

        page.children.forEach(c => checkNode(c));
        return { total: issues.length, issues: issues.slice(0, 50) }; // Limit output
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan(`\nFound ${result.total} issues:\n`));
          result.issues.forEach(i => {
            const color = i.severity === 'warning' ? chalk.yellow : chalk.gray;
            console.log(color(`  [${i.type}] ${i.name}: ${i.message}`));
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Lint failed: ' + e.message));
      }
    } else {
      // Yolo Mode: use figma-use
      let cmd = 'npx figma-use lint';
      if (options.fix) cmd += ' --fix';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

const analyze = program
  .command('analyze')
  .description('Analyze design (colors, typography, spacing, clusters)');

analyze
  .command('colors')
  .description('Analyze color usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const colors = new Map();
        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }
        function checkNode(node) {
          if (node.fills && Array.isArray(node.fills)) {
            node.fills.forEach(f => {
              if (f.type === 'SOLID' && f.color) {
                const hex = rgbToHex(f.color.r, f.color.g, f.color.b);
                colors.set(hex, (colors.get(hex) || 0) + 1);
              }
            });
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(colors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([hex, count]) => ({ hex, count }));
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nTop colors used:\n'));
          result.forEach(c => {
            console.log(`  ${chalk.hex(c.hex)('██')} ${c.hex} (${c.count}x)`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze colors';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('typography')
  .alias('type')
  .description('Analyze typography usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const styles = new Map();
        function checkNode(node) {
          if (node.type === 'TEXT') {
            const key = node.fontName.family + '/' + node.fontSize + '/' + node.fontName.style;
            styles.set(key, (styles.get(key) || 0) + 1);
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(styles.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([key, count]) => {
            const [family, size, style] = key.split('/');
            return { family, size: parseInt(size), style, count };
          });
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nTypography usage:\n'));
          result.forEach(t => {
            console.log(`  ${t.family} ${t.size}px ${t.style} (${t.count}x)`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze typography';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('spacing')
  .description('Analyze spacing (gap/padding) usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const gaps = new Map();
        const paddings = new Map();
        function checkNode(node) {
          if (node.layoutMode && node.layoutMode !== 'NONE') {
            if (node.itemSpacing !== undefined) {
              gaps.set(node.itemSpacing, (gaps.get(node.itemSpacing) || 0) + 1);
            }
            const p = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].filter(x => x > 0);
            p.forEach(v => paddings.set(v, (paddings.get(v) || 0) + 1));
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return {
          gaps: Array.from(gaps.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({ value: v, count: c })),
          paddings: Array.from(paddings.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({ value: v, count: c }))
        };
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nGap values:\n'));
          result.gaps.forEach(g => console.log(`  ${g.value}px (${g.count}x)`));
          console.log(chalk.cyan('\nPadding values:\n'));
          result.paddings.forEach(p => console.log(`  ${p.value}px (${p.count}x)`));
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze spacing';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('clusters')
  .description('Find repeated patterns (potential components)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const patterns = new Map();
        function getSignature(node) {
          if (node.type === 'FRAME' || node.type === 'GROUP') {
            const childTypes = ('children' in node) ? node.children.map(c => c.type).sort().join(',') : '';
            return node.type + ':' + childTypes;
          }
          return node.type;
        }
        function checkNode(node) {
          if (node.type === 'FRAME' || node.type === 'GROUP') {
            const sig = getSignature(node);
            if (!patterns.has(sig)) patterns.set(sig, []);
            patterns.get(sig).push({ id: node.id, name: node.name });
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(patterns.entries())
          .filter(([_, nodes]) => nodes.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 10)
          .map(([sig, nodes]) => ({ pattern: sig, count: nodes.length, examples: nodes.slice(0, 3) }));
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nRepeated patterns (potential components):\n'));
          result.forEach(p => {
            console.log(`  ${p.count}x: ${p.examples.map(e => e.name).join(', ')}`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze clusters';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

// ============ ACCESSIBILITY (a11y) ============

const a11y = program
  .command('a11y')
  .description('Accessibility checks (contrast, vision, touch targets, audit)');

a11y
  .command('contrast [nodeId]')
  .description('Check WCAG contrast ratios for all text/background pairs')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const level = options.level.toUpperCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }

      function contrastRatio(l1, l2) {
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      function getSolidColor(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              const o = fill.opacity !== undefined ? fill.opacity : 1;
              return { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: o };
            }
          }
        }
        return null;
      }

      function getBgColor(node) {
        let current = node.parent;
        while (current) {
          const color = getSolidColor(current);
          if (color && color.a > 0.01) return color;
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1, a: 1 };
      }

      function blendOnWhite(fg, bg) {
        const a = fg.a;
        return {
          r: fg.r * a + bg.r * (1 - a),
          g: fg.g * a + bg.g * (1 - a),
          b: fg.b * a + bg.b * (1 - a)
        };
      }

      function toHex(c) {
        const r = Math.round(c.r * 255).toString(16).padStart(2, '0');
        const g = Math.round(c.g * 255).toString(16).padStart(2, '0');
        const b = Math.round(c.b * 255).toString(16).padStart(2, '0');
        return '#' + r + g + b;
      }

      const results = [];

      function traverse(node) {
        if (node.type === 'TEXT' && node.visible !== false) {
          const textColor = getSolidColor(node);
          if (!textColor) return;
          const bgColor = getBgColor(node);
          const fg = blendOnWhite(textColor, { r: 1, g: 1, b: 1 });
          const bg = blendOnWhite(bgColor, { r: 1, g: 1, b: 1 });
          const l1 = luminance(fg.r, fg.g, fg.b);
          const l2 = luminance(bg.r, bg.g, bg.b);
          const ratio = contrastRatio(l1, l2);
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 16;
          const fontWeight = node.fontWeight || 400;
          const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
          const aaPass = isLarge ? ratio >= 3 : ratio >= 4.5;
          const aaaPass = isLarge ? ratio >= 4.5 : ratio >= 7;
          results.push({
            id: node.id,
            name: node.name,
            text: node.characters ? node.characters.substring(0, 50) : '',
            fontSize: fontSize,
            isLarge: isLarge,
            fgColor: toHex(fg),
            bgColor: toHex(bg),
            ratio: Math.round(ratio * 100) / 100,
            aa: aaPass,
            aaa: aaaPass
          });
        }
        if ('children' in node) {
          for (const child of node.children) {
            if (child.visible !== false) traverse(child);
          }
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      } else {
        traverse(root);
      }

      const level = "${level}";
      const passing = results.filter(r => level === 'AAA' ? r.aaa : r.aa);
      const failing = results.filter(r => level === 'AAA' ? !r.aaa : !r.aa);
      return { level, total: results.length, passing: passing.length, failing: failing.length, issues: failing, all: results };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Contrast Check (WCAG ${result.level})\n`));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Fail:')} ${result.failing}/${result.total}\n`);

      if (result.issues.length > 0) {
        console.log(chalk.red('  Failing elements:\n'));
        result.issues.forEach(issue => {
          const ratioStr = issue.ratio.toFixed(2) + ':1';
          const needed = issue.isLarge ? (result.level === 'AAA' ? '4.5:1' : '3:1') : (result.level === 'AAA' ? '7:1' : '4.5:1');
          console.log(`  ${chalk.red('✗')} ${chalk.white(issue.name)} ${chalk.gray('- "' + issue.text + '"')}`);
          console.log(`    ${chalk.gray('Ratio:')} ${chalk.yellow(ratioStr)} ${chalk.gray('(need ' + needed + ')')}  ${chalk.gray('FG:')} ${issue.fgColor}  ${chalk.gray('BG:')} ${issue.bgColor}  ${chalk.gray('Size:')} ${issue.fontSize}px${issue.isLarge ? ' (large)' : ''}`);
          console.log(`    ${chalk.gray('ID:')} ${issue.id}\n`);
        });
      } else {
        console.log(chalk.green('  All text passes WCAG ' + result.level + '! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Contrast check failed: ' + e.message));
    }
  });

a11y
  .command('vision [nodeId]')
  .description('Simulate color blindness (protanopia, deuteranopia, tritanopia, achromatopsia)')
  .option('--type <type>', 'Type: protanopia, deuteranopia, tritanopia, achromatopsia, all', 'all')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const simType = options.type.toLowerCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage.selection[0];
      if (!root) return { error: 'Select a frame or provide a node ID' };

      // Color blindness simulation matrices (Brettel/Vienot models)
      const matrices = {
        protanopia: [
          0.152286, 1.052583, -0.204868,
          0.114503, 0.786281, 0.099216,
          -0.003882, -0.048116, 1.051998
        ],
        deuteranopia: [
          0.367322, 0.860646, -0.227968,
          0.280085, 0.672501, 0.047413,
          -0.011820, 0.042940, 0.968881
        ],
        tritanopia: [
          1.255528, -0.076749, -0.178779,
          -0.078411, 0.930809, 0.147602,
          0.004733, 0.691367, 0.303900
        ],
        achromatopsia: [
          0.2126, 0.7152, 0.0722,
          0.2126, 0.7152, 0.0722,
          0.2126, 0.7152, 0.0722
        ]
      };

      function applyMatrix(r, g, b, matrix) {
        return {
          r: Math.max(0, Math.min(1, matrix[0] * r + matrix[1] * g + matrix[2] * b)),
          g: Math.max(0, Math.min(1, matrix[3] * r + matrix[4] * g + matrix[5] * b)),
          b: Math.max(0, Math.min(1, matrix[6] * r + matrix[7] * g + matrix[8] * b))
        };
      }

      function toHex(c) {
        const r = Math.round(c.r * 255).toString(16).padStart(2, '0');
        const g = Math.round(c.g * 255).toString(16).padStart(2, '0');
        const b = Math.round(c.b * 255).toString(16).padStart(2, '0');
        return '#' + r + g + b;
      }

      const types = "${simType}" === 'all' ? Object.keys(matrices) : ["${simType}"];
      if (!types.every(t => matrices[t])) return { error: 'Unknown type. Use: protanopia, deuteranopia, tritanopia, achromatopsia, all' };

      // Collect all unique colors used in the selection
      const colorMap = new Map();
      function collectColors(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              const hex = toHex(fill.color);
              if (!colorMap.has(hex)) colorMap.set(hex, { ...fill.color });
            }
          }
        }
        if (node.strokes && Array.isArray(node.strokes)) {
          for (const stroke of node.strokes) {
            if (stroke.type === 'SOLID' && stroke.visible !== false) {
              const hex = toHex(stroke.color);
              if (!colorMap.has(hex)) colorMap.set(hex, { ...stroke.color });
            }
          }
        }
        if ('children' in node) {
          for (const child of node.children) collectColors(child);
        }
      }
      collectColors(root);

      // Simulate each type
      const simulations = {};
      for (const type of types) {
        const matrix = matrices[type];
        const colors = [];
        for (const [hex, color] of colorMap) {
          const sim = applyMatrix(color.r, color.g, color.b, matrix);
          colors.push({ original: hex, simulated: toHex(sim) });
        }
        // Find confusable pairs (colors that become too similar after simulation)
        const confusable = [];
        const entries = Array.from(colorMap.entries());
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const [hex1, c1] = entries[i];
            const [hex2, c2] = entries[j];
            const s1 = applyMatrix(c1.r, c1.g, c1.b, matrix);
            const s2 = applyMatrix(c2.r, c2.g, c2.b, matrix);
            const diff = Math.sqrt(
              Math.pow(s1.r - s2.r, 2) + Math.pow(s1.g - s2.g, 2) + Math.pow(s1.b - s2.b, 2)
            );
            if (diff < 0.05 && Math.sqrt(
              Math.pow(c1.r - c2.r, 2) + Math.pow(c1.g - c2.g, 2) + Math.pow(c1.b - c2.b, 2)
            ) > 0.1) {
              confusable.push({ color1: hex1, color2: hex2, simulated1: toHex(s1), simulated2: toHex(s2) });
            }
          }
        }
        simulations[type] = { colors, confusable };
      }

      // Create visual simulation copies
      const clones = [];
      const rootX = root.x;
      const rootWidth = root.width;
      let offsetX = rootX + rootWidth + 100;

      for (const type of types) {
        const clone = root.clone();
        clone.name = root.name + ' (' + type.charAt(0).toUpperCase() + type.slice(1) + ')';
        clone.x = offsetX;
        clone.y = root.y;

        function transformColors(node) {
          const matrix = matrices[type];
          if (node.fills && Array.isArray(node.fills)) {
            const newFills = node.fills.map(fill => {
              if (fill.type === 'SOLID' && fill.visible !== false) {
                const sim = applyMatrix(fill.color.r, fill.color.g, fill.color.b, matrix);
                return { ...fill, color: { r: sim.r, g: sim.g, b: sim.b } };
              }
              return fill;
            });
            node.fills = newFills;
          }
          if (node.strokes && Array.isArray(node.strokes)) {
            const newStrokes = node.strokes.map(stroke => {
              if (stroke.type === 'SOLID' && stroke.visible !== false) {
                const sim = applyMatrix(stroke.color.r, stroke.color.g, stroke.color.b, matrix);
                return { ...stroke, color: { r: sim.r, g: sim.g, b: sim.b } };
              }
              return stroke;
            });
            node.strokes = newStrokes;
          }
          if ('children' in node) {
            for (const child of node.children) transformColors(child);
          }
        }
        transformColors(clone);
        clones.push({ id: clone.id, name: clone.name, type });
        offsetX += rootWidth + 60;
      }

      return { original: root.name, totalColors: colorMap.size, types, simulations, clones };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Color Blindness Simulation\n'));
      console.log(`  Source: ${chalk.white(result.original)} (${result.totalColors} unique colors)\n`);
      console.log('  Created simulation copies:\n');

      for (const clone of result.clones) {
        const sim = result.simulations[clone.type];
        const issues = sim.confusable.length;
        const icon = issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
        console.log(`  ${icon} ${chalk.white(clone.name)}`);
        if (issues > 0) {
          console.log(`    ${chalk.yellow(issues + ' confusable color pair(s):')}`);
          sim.confusable.forEach(pair => {
            console.log(`    ${pair.color1} ↔ ${pair.color2} → both appear as ~${pair.simulated1}`);
          });
        } else {
          console.log(`    ${chalk.green('No confusable colors')}`);
        }
        console.log(`    ${chalk.gray('ID: ' + clone.id)}\n`);
      }
    } catch (e) {
      console.log(chalk.red('✗ Vision simulation failed: ' + e.message));
    }
  });

a11y
  .command('touch [nodeId]')
  .description('Check touch target sizes (WCAG 2.5.8: min 24x24, recommended 44x44)')
  .option('--min <size>', 'Minimum target size in px', '44')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const minSize = parseInt(options.min) || 44;
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const minSize = ${minSize};
      const results = [];
      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;

      function traverse(node) {
        if (node.visible === false) return;
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );

        if (isInteractive) {
          const w = Math.round(node.width);
          const h = Math.round(node.height);
          const pass = w >= minSize && h >= minSize;
          const wcag248 = w >= 24 && h >= 24;
          results.push({
            id: node.id,
            name: node.name,
            type: node.type,
            width: w,
            height: h,
            pass: pass,
            wcag248: wcag248,
            issue: !pass ? (w < minSize && h < minSize ? 'both' : w < minSize ? 'width' : 'height') : null
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const passing = results.filter(r => r.pass);
      const failing = results.filter(r => !r.pass);
      const critical = results.filter(r => !r.wcag248);
      return { minSize, total: results.length, passing: passing.length, failing: failing.length, critical: critical.length, issues: failing };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Touch Target Check (min ${result.minSize}x${result.minSize}px)\n`));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Fail:')} ${result.failing}/${result.total}   ${chalk.red('⚠ Critical (<24px):')} ${result.critical}\n`);

      if (result.issues.length > 0) {
        console.log(chalk.red('  Undersized targets:\n'));
        result.issues.forEach(issue => {
          const icon = !issue.wcag248 ? chalk.red('⚠') : chalk.yellow('✗');
          const sizeStr = `${issue.width}x${issue.height}px`;
          console.log(`  ${icon} ${chalk.white(issue.name)} ${chalk.gray('(' + issue.type + ')')}  ${chalk.yellow(sizeStr)}  ${chalk.gray('ID: ' + issue.id)}`);
        });
        console.log('');
      } else {
        console.log(chalk.green('  All interactive elements meet minimum size! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Touch target check failed: ' + e.message));
    }
  });

a11y
  .command('text [nodeId]')
  .description('Check text accessibility (min sizes, line height, paragraph spacing)')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const results = [];

      function traverse(node) {
        if (node.visible === false) return;
        if (node.type === 'TEXT') {
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : null;
          const lineHeight = node.lineHeight;
          let lineHeightValue = null;
          let lineHeightRatio = null;

          if (lineHeight && lineHeight.unit === 'PIXELS') {
            lineHeightValue = lineHeight.value;
            if (fontSize) lineHeightRatio = lineHeight.value / fontSize;
          } else if (lineHeight && lineHeight.unit === 'PERCENT') {
            lineHeightRatio = lineHeight.value / 100;
            if (fontSize) lineHeightValue = fontSize * lineHeightRatio;
          }

          const issues = [];

          // WCAG 1.4.4: text should be readable
          if (fontSize && fontSize < 12) {
            issues.push({ rule: 'min-size', message: 'Font size < 12px (hard to read)', severity: 'error' });
          } else if (fontSize && fontSize < 14) {
            issues.push({ rule: 'min-size', message: 'Font size < 14px (consider increasing for body text)', severity: 'warning' });
          }

          // WCAG 1.4.12: line height >= 1.5x for body text
          if (fontSize && fontSize <= 18 && lineHeightRatio && lineHeightRatio < 1.5) {
            issues.push({ rule: 'line-height', message: 'Line height < 1.5x for body text (WCAG 1.4.12)', severity: 'warning' });
          }

          // WCAG 1.4.12: paragraph spacing >= 2x font size
          if (node.paragraphSpacing !== undefined && fontSize) {
            if (node.paragraphSpacing > 0 && node.paragraphSpacing < fontSize * 2) {
              issues.push({ rule: 'paragraph-spacing', message: 'Paragraph spacing < 2x font size (WCAG 1.4.12)', severity: 'warning' });
            }
          }

          // WCAG 1.4.12: letter spacing >= 0.12x font size
          if (node.letterSpacing && node.letterSpacing.unit === 'PIXELS' && fontSize) {
            if (node.letterSpacing.value < fontSize * 0.12 && node.letterSpacing.value !== 0) {
              issues.push({ rule: 'letter-spacing', message: 'Letter spacing < 0.12x font size (WCAG 1.4.12)', severity: 'warning' });
            }
          }

          // Check for ALL CAPS on long text (readability concern)
          if (node.textCase === 'UPPER' && node.characters && node.characters.length > 20) {
            issues.push({ rule: 'all-caps', message: 'Long ALL CAPS text (> 20 chars) reduces readability', severity: 'warning' });
          }

          results.push({
            id: node.id,
            name: node.name,
            text: node.characters ? node.characters.substring(0, 40) : '',
            fontSize: fontSize,
            lineHeight: lineHeightValue ? Math.round(lineHeightValue * 10) / 10 : null,
            lineHeightRatio: lineHeightRatio ? Math.round(lineHeightRatio * 100) / 100 : null,
            issues: issues
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const withIssues = results.filter(r => r.issues.length > 0);
      const errors = withIssues.filter(r => r.issues.some(i => i.severity === 'error'));
      const warnings = withIssues.filter(r => r.issues.some(i => i.severity === 'warning') && !r.issues.some(i => i.severity === 'error'));
      return { total: results.length, errors: errors.length, warnings: warnings.length, passing: results.length - withIssues.length, issues: withIssues };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Text Accessibility Check\n'));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Errors:')} ${result.errors}   ${chalk.yellow('⚠ Warnings:')} ${result.warnings}\n`);

      if (result.issues.length > 0) {
        result.issues.forEach(item => {
          const icon = item.issues.some(i => i.severity === 'error') ? chalk.red('✗') : chalk.yellow('⚠');
          console.log(`  ${icon} ${chalk.white(item.name)} ${chalk.gray('- "' + item.text + '"')}  ${chalk.gray(item.fontSize + 'px')}${item.lineHeightRatio ? chalk.gray(' / ' + item.lineHeightRatio + 'x') : ''}`);
          item.issues.forEach(issue => {
            const color = issue.severity === 'error' ? chalk.red : chalk.yellow;
            console.log(`    ${color(issue.message)}`);
          });
          console.log(`    ${chalk.gray('ID: ' + item.id)}\n`);
        });
      } else {
        console.log(chalk.green('  All text passes accessibility checks! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Text check failed: ' + e.message));
    }
  });

a11y
  .command('focus [nodeId]')
  .description('Show reading/focus order of interactive elements')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage.selection[0] || figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;
      const elements = [];

      function getAbsolutePosition(node) {
        let x = node.x, y = node.y;
        let current = node.parent;
        while (current && current.type !== 'PAGE') {
          x += current.x;
          y += current.y;
          current = current.parent;
        }
        return { x, y };
      }

      function traverse(node) {
        if (node.visible === false) return;
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );
        const isText = node.type === 'TEXT';

        if (isInteractive || isText) {
          const pos = getAbsolutePosition(node);
          elements.push({
            id: node.id,
            name: node.name,
            type: node.type,
            role: isInteractive ? 'interactive' : 'text',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            width: Math.round(node.width),
            height: Math.round(node.height)
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      // Sort by reading order: top-to-bottom, then left-to-right (with 20px row tolerance)
      elements.sort((a, b) => {
        const rowDiff = Math.abs(a.y - b.y);
        if (rowDiff < 20) return a.x - b.x;
        return a.y - b.y;
      });

      // Add order numbers
      let interactiveOrder = 0;
      elements.forEach(el => {
        if (el.role === 'interactive') {
          interactiveOrder++;
          el.tabOrder = interactiveOrder;
        }
      });

      // Check for reading order issues
      const issues = [];
      for (let i = 1; i < elements.length; i++) {
        const prev = elements[i - 1];
        const curr = elements[i];
        // Check if visual order matches DOM order (large backward jumps)
        if (curr.y < prev.y - 50 && curr.role === 'interactive' && prev.role === 'interactive') {
          issues.push({
            element: curr.name,
            message: 'May be reached before visually higher element "' + prev.name + '"',
            severity: 'warning'
          });
        }
      }

      const interactive = elements.filter(e => e.role === 'interactive');
      return { total: elements.length, interactive: interactive.length, order: elements, issues };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Focus / Reading Order\n'));
      console.log(`  Total elements: ${result.total}   Interactive: ${result.interactive}\n`);

      let tabIdx = 0;
      result.order.forEach(el => {
        if (el.role === 'interactive') {
          tabIdx++;
          console.log(`  ${chalk.cyan(String(tabIdx).padStart(3))}  ${chalk.white(el.name)} ${chalk.gray('(' + el.type + ')')}  ${chalk.gray('at ' + el.x + ',' + el.y)}  ${chalk.gray(el.width + 'x' + el.height + 'px')}`);
        } else {
          console.log(`  ${chalk.gray('  -')}  ${chalk.gray(el.name)}  ${chalk.gray('at ' + el.x + ',' + el.y)}`);
        }
      });

      if (result.issues.length > 0) {
        console.log(chalk.yellow('\n  Potential order issues:\n'));
        result.issues.forEach(issue => {
          console.log(`  ${chalk.yellow('⚠')} ${issue.message}`);
        });
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red('✗ Focus order check failed: ' + e.message));
    }
  });

a11y
  .command('audit [nodeId]')
  .description('Full accessibility audit (contrast + touch targets + text + focus order)')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const level = options.level.toUpperCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      // --- Helpers ---
      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function contrastRatio(l1, l2) {
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function getSolidColor(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              return { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: fill.opacity !== undefined ? fill.opacity : 1 };
            }
          }
        }
        return null;
      }
      function getBgColor(node) {
        let current = node.parent;
        while (current) {
          const color = getSolidColor(current);
          if (color && color.a > 0.01) return color;
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1, a: 1 };
      }
      function toHex(c) {
        return '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
      }

      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;
      const level = "${level}";
      const issues = [];
      let textCount = 0, interactiveCount = 0;

      function traverse(node) {
        if (node.visible === false) return;

        // Contrast check
        if (node.type === 'TEXT') {
          textCount++;
          const textColor = getSolidColor(node);
          if (textColor) {
            const bgColor = getBgColor(node);
            const l1 = luminance(textColor.r * textColor.a + (1 - textColor.a), textColor.g * textColor.a + (1 - textColor.a), textColor.b * textColor.a + (1 - textColor.a));
            const l2 = luminance(bgColor.r, bgColor.g, bgColor.b);
            const ratio = contrastRatio(l1, l2);
            const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 16;
            const fontWeight = node.fontWeight || 400;
            const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
            const aaReq = isLarge ? 3 : 4.5;
            const aaaReq = isLarge ? 4.5 : 7;
            const req = level === 'AAA' ? aaaReq : aaReq;
            if (ratio < req) {
              issues.push({
                category: 'contrast',
                severity: ratio < (isLarge ? 3 : 4.5) ? 'error' : 'warning',
                id: node.id,
                name: node.name,
                message: 'Contrast ' + ratio.toFixed(2) + ':1 (need ' + req + ':1)',
                details: { ratio: Math.round(ratio * 100) / 100, required: req, fg: toHex(textColor), bg: toHex(bgColor), fontSize }
              });
            }
          }

          // Text size
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : null;
          if (fontSize && fontSize < 12) {
            issues.push({ category: 'text', severity: 'error', id: node.id, name: node.name, message: 'Font size ' + fontSize + 'px < 12px minimum' });
          }

          // Line height
          if (fontSize && fontSize <= 18 && node.lineHeight) {
            let ratio = null;
            if (node.lineHeight.unit === 'PIXELS') ratio = node.lineHeight.value / fontSize;
            else if (node.lineHeight.unit === 'PERCENT') ratio = node.lineHeight.value / 100;
            if (ratio && ratio < 1.5) {
              issues.push({ category: 'text', severity: 'warning', id: node.id, name: node.name, message: 'Line height ' + (ratio).toFixed(2) + 'x < 1.5x (WCAG 1.4.12)' });
            }
          }

          // ALL CAPS
          if (node.textCase === 'UPPER' && node.characters && node.characters.length > 20) {
            issues.push({ category: 'text', severity: 'warning', id: node.id, name: node.name, message: 'Long ALL CAPS text reduces readability' });
          }
        }

        // Touch targets
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );
        if (isInteractive) {
          interactiveCount++;
          const w = Math.round(node.width);
          const h = Math.round(node.height);
          if (w < 24 || h < 24) {
            issues.push({ category: 'touch', severity: 'error', id: node.id, name: node.name, message: 'Touch target ' + w + 'x' + h + 'px < 24x24 minimum (WCAG 2.5.8)' });
          } else if (w < 44 || h < 44) {
            issues.push({ category: 'touch', severity: 'warning', id: node.id, name: node.name, message: 'Touch target ' + w + 'x' + h + 'px < 44x44 recommended' });
          }
        }

        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');
      const contrastIssues = issues.filter(i => i.category === 'contrast');
      const textIssues = issues.filter(i => i.category === 'text');
      const touchIssues = issues.filter(i => i.category === 'touch');

      const score = issues.length === 0 ? 'A+' : errors.length === 0 ? 'B' : errors.length <= 3 ? 'C' : 'D';

      return {
        score,
        level,
        summary: { textNodes: textCount, interactiveElements: interactiveCount, errors: errors.length, warnings: warnings.length },
        breakdown: {
          contrast: { issues: contrastIssues.length, errors: contrastIssues.filter(i => i.severity === 'error').length },
          text: { issues: textIssues.length, errors: textIssues.filter(i => i.severity === 'error').length },
          touch: { issues: touchIssues.length, errors: touchIssues.filter(i => i.severity === 'error').length }
        },
        issues
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const scoreColor = result.score === 'A+' ? chalk.green : result.score === 'B' ? chalk.yellow : chalk.red;

      console.log(chalk.cyan(`\n  Accessibility Audit (WCAG ${result.level})\n`));
      console.log(`  Score: ${scoreColor(result.score)}   ${chalk.gray('(' + result.summary.textNodes + ' text nodes, ' + result.summary.interactiveElements + ' interactive elements)')}\n`);

      // Breakdown
      const bd = result.breakdown;
      const contrastIcon = bd.contrast.errors > 0 ? chalk.red('✗') : bd.contrast.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
      const textIcon = bd.text.errors > 0 ? chalk.red('✗') : bd.text.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
      const touchIcon = bd.touch.errors > 0 ? chalk.red('✗') : bd.touch.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');

      console.log(`  ${contrastIcon} Contrast     ${bd.contrast.issues === 0 ? chalk.green('Pass') : chalk.red(bd.contrast.errors + ' errors') + (bd.contrast.issues - bd.contrast.errors > 0 ? ', ' + chalk.yellow((bd.contrast.issues - bd.contrast.errors) + ' warnings') : '')}`);
      console.log(`  ${textIcon} Text         ${bd.text.issues === 0 ? chalk.green('Pass') : chalk.red(bd.text.errors + ' errors') + (bd.text.issues - bd.text.errors > 0 ? ', ' + chalk.yellow((bd.text.issues - bd.text.errors) + ' warnings') : '')}`);
      console.log(`  ${touchIcon} Touch Target ${bd.touch.issues === 0 ? chalk.green('Pass') : chalk.red(bd.touch.errors + ' errors') + (bd.touch.issues - bd.touch.errors > 0 ? ', ' + chalk.yellow((bd.touch.issues - bd.touch.errors) + ' warnings') : '')}`);

      if (result.issues.length > 0) {
        console.log(chalk.red('\n  Issues:\n'));
        // Group by category
        const categories = ['contrast', 'text', 'touch'];
        const categoryLabels = { contrast: 'Contrast', text: 'Text', touch: 'Touch Targets' };
        for (const cat of categories) {
          const catIssues = result.issues.filter(i => i.category === cat);
          if (catIssues.length === 0) continue;
          console.log(chalk.white('  ' + categoryLabels[cat] + ':\n'));
          catIssues.forEach(issue => {
            const icon = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
            console.log(`  ${icon} ${chalk.white(issue.name)} - ${issue.message}  ${chalk.gray('ID: ' + issue.id)}`);
          });
          console.log('');
        }
      } else {
        console.log(chalk.green('\n  Perfect score! No accessibility issues found. ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Audit failed: ' + e.message));
    }
  });

// ============ NODE OPERATIONS (figma-use) ============

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const maxDepth = parseInt(options.depth) || 3;
      const code = `(async () => {
        const maxDepth = ${maxDepth};
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
        const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
        if (!root) return 'Node not found';

        const lines = [];
        function printNode(node, indent = 0, depth = 0) {
          if (depth > maxDepth) return;
          const prefix = '  '.repeat(indent);
          const size = node.width && node.height ? \` (\${Math.round(node.width)}x\${Math.round(node.height)})\` : '';
          lines.push(prefix + node.type + ': ' + node.name + size);
          if ('children' in node && depth < maxDepth) {
            node.children.forEach(c => printNode(c, indent + 1, depth + 1));
          }
        }
        printNode(root);
        return lines.join('\\n');
      })()`;

      try {
        const result = await fastEval(code);
        console.log(result);
      } catch (e) {
        console.log(chalk.red('✗ Tree failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use node tree';
      if (nodeId) cmd += ` "${nodeId}"`;
      cmd += ` --depth ${options.depth}`;
      runFigmaUse(cmd);
    }
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .action(async (nodeId) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
        const nodes = targetId
          ? [await figma.getNodeByIdAsync(targetId)]
          : figma.currentPage.selection;

        if (!nodes.length) return 'No node selected';

        const results = [];
        for (const node of nodes) {
          if (!node) continue;
          const bindings = {};
          if (node.boundVariables) {
            for (const [prop, binding] of Object.entries(node.boundVariables)) {
              const b = Array.isArray(binding) ? binding[0] : binding;
              if (b && b.id) {
                const variable = figma.variables.getVariableById(b.id);
                bindings[prop] = variable ? variable.name : b.id;
              }
            }
          }
          results.push({ id: node.id, name: node.name, bindings });
        }
        return results;
      })()`;

      try {
        const result = await fastEval(code);
        if (typeof result === 'string') {
          console.log(result);
        } else {
          result.forEach(r => {
            console.log(chalk.cyan(`\n${r.name} (${r.id}):`));
            if (Object.keys(r.bindings).length === 0) {
              console.log(chalk.gray('  No variable bindings'));
            } else {
              Object.entries(r.bindings).forEach(([prop, varName]) => {
                console.log(`  ${prop}: ${chalk.green(varName)}`);
              });
            }
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Bindings failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use node bindings';
      if (nodeId) cmd += ` "${nodeId}"`;
      runFigmaUse(cmd);
    }
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .action(async (nodeIds) => {
    await checkConnection();

    // Check if we're in Safe Mode (plugin only, no CDP)
    let useDaemon = false;
    try {
      const healthToken = getDaemonToken();
      const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
      const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
      const health = JSON.parse(healthRes);
      useDaemon = health.plugin && !health.cdp;
    } catch {}

    if (useDaemon) {
      // Safe Mode: use native Figma API
      const code = `(async () => {
        const ids = ${JSON.stringify(nodeIds)};
        const results = [];
        for (const id of ids) {
          const node = await figma.getNodeByIdAsync(id);
          if (node && (node.type === 'FRAME' || node.type === 'GROUP')) {
            const comp = figma.createComponentFromNode(node);
            results.push({ id: comp.id, name: comp.name });
          }
        }
        return results;
      })()`;
      try {
        const result = await fastEval(code);
        if (result && result.length > 0) {
          result.forEach(r => console.log(chalk.green(`✓ Converted: ${r.id} (${r.name})`)));
        }
      } catch (e) {
        console.log(chalk.red('✗ Convert failed: ' + e.message));
      }
    } else {
      // Yolo Mode: use figma-use
      const cmd = `npx figma-use node to-component "${nodeIds.join(' ')}"`;
      runFigmaUse(cmd);
    }
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action(async (nodeIds) => {
    await checkConnection();

    // Check if we're in Safe Mode
    let useDaemon = false;
    try {
      const healthToken = getDaemonToken();
      const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
      const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
      const health = JSON.parse(healthRes);
      useDaemon = health.plugin && !health.cdp;
    } catch {}

    if (useDaemon) {
      // Safe Mode: use native Figma API
      const code = `(async () => {
        const ids = ${JSON.stringify(nodeIds)};
        let deleted = 0;
        for (const id of ids) {
          const node = await figma.getNodeByIdAsync(id);
          if (node) { node.remove(); deleted++; }
        }
        return deleted;
      })()`;
      try {
        const result = await fastEval(code);
        console.log(chalk.green(`✓ Deleted ${result} node(s)`));
      } catch (e) {
        console.log(chalk.red('✗ Delete failed: ' + e.message));
      }
    } else {
      // Yolo Mode: use figma-use
      const cmd = `npx figma-use node delete "${nodeIds.join(' ')}"`;
      runFigmaUse(cmd);
    }
  });

// ============ SLOT COMMANDS ============

const slot = program
  .command('slot')
  .description('Slot operations (create, list, preferred, reset, convert)');

slot
  .command('create <name>')
  .description('Create a slot on selected component')
  .option('-f, --flex <direction>', 'Layout direction: row or col', 'col')
  .option('-g, --gap <value>', 'Gap between items', '0')
  .option('-p, --padding <value>', 'Padding')
  .action(async (name, options) => {
    await checkConnection();

    const flex = options.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
    const gap = parseInt(options.gap) || 0;
    const padding = options.padding ? parseInt(options.padding) : 0;

    const code = `(async () => {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) return { error: 'No component selected' };

      const comp = selection[0];
      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Selected node is not a component. Select a component first.' };
      }

      const slot = comp.createSlot(${JSON.stringify(name)});
      slot.layoutMode = '${flex}';
      slot.itemSpacing = ${gap};
      slot.paddingTop = ${padding};
      slot.paddingBottom = ${padding};
      slot.paddingLeft = ${padding};
      slot.paddingRight = ${padding};

      return {
        success: true,
        slotId: slot.id,
        slotName: slot.name,
        componentName: comp.name
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Created slot "${result.slotName}" in component "${result.componentName}"`));
        console.log(chalk.gray(`  ID: ${result.slotId}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('list [nodeId]')
  .description('List slots in a component')
  .action(async (nodeId) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let comp;

      if (targetId) {
        comp = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No component selected' };
        comp = selection[0];
      }

      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Node is not a component' };
      }

      const propDefs = comp.componentPropertyDefinitions;
      const slots = [];

      for (const [key, def] of Object.entries(propDefs)) {
        if (def.type === 'SLOT') {
          slots.push({
            key,
            description: def.description,
            preferredCount: def.preferredValues ? def.preferredValues.length : 0
          });
        }
      }

      // Also find SLOT nodes in children
      const slotNodes = [];
      function findSlots(node) {
        if (node.type === 'SLOT') {
          slotNodes.push({ id: node.id, name: node.name });
        }
        if ('children' in node) {
          node.children.forEach(findSlots);
        }
      }
      findSlots(comp);

      return {
        componentName: comp.name,
        componentId: comp.id,
        properties: slots,
        slotNodes
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.cyan(`\nSlots in "${result.componentName}" (${result.componentId}):`));

        if (result.properties.length === 0) {
          console.log(chalk.gray('  No slot properties found'));
        } else {
          console.log(chalk.white('\nSlot Properties:'));
          result.properties.forEach(s => {
            console.log(`  ${chalk.green(s.key)}`);
            if (s.description) console.log(chalk.gray(`    Description: ${s.description}`));
            console.log(chalk.gray(`    Preferred values: ${s.preferredCount}`));
          });
        }

        if (result.slotNodes.length > 0) {
          console.log(chalk.white('\nSlot Nodes:'));
          result.slotNodes.forEach(s => {
            console.log(`  ${chalk.yellow(s.name)} (${s.id})`);
          });
        }
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('preferred <slotKey> <componentIds...>')
  .description('Set preferred components for a slot')
  .option('-n, --node <nodeId>', 'Component ID to modify (otherwise uses selection)')
  .action(async (slotKey, componentIds, options) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${options.node ? `"${options.node}"` : 'null'};
      let comp;

      if (targetId) {
        comp = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No component selected' };
        comp = selection[0];
      }

      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Node is not a component' };
      }

      const propDefs = comp.componentPropertyDefinitions;

      // Find the slot property (might need to match partially)
      let slotPropKey = null;
      for (const key of Object.keys(propDefs)) {
        if (key === ${JSON.stringify(slotKey)} || key.startsWith(${JSON.stringify(slotKey)} + '#')) {
          slotPropKey = key;
          break;
        }
      }

      if (!slotPropKey) {
        return { error: 'Slot property not found: ' + ${JSON.stringify(slotKey)} };
      }

      // Get component keys for preferred values
      const preferredValues = [];
      const compIds = ${JSON.stringify(componentIds)};

      for (const id of compIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')) {
          preferredValues.push({ type: 'COMPONENT', key: node.key });
        }
      }

      if (preferredValues.length === 0) {
        return { error: 'No valid components found' };
      }

      comp.editComponentProperty(slotPropKey, { preferredValues });

      return {
        success: true,
        slotKey: slotPropKey,
        preferredCount: preferredValues.length
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Set ${result.preferredCount} preferred component(s) for slot "${result.slotKey}"`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('reset [nodeId]')
  .description('Reset slot in instance to defaults')
  .action(async (nodeId) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let node;

      if (targetId) {
        node = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No slot selected' };
        node = selection[0];
      }

      if (node.type !== 'SLOT') {
        // Try to find slot in instance
        if (node.type === 'INSTANCE') {
          const slots = node.children.filter(c => c.type === 'SLOT');
          if (slots.length === 0) return { error: 'No slots found in instance' };
          if (slots.length === 1) {
            node = slots[0];
          } else {
            return { error: 'Multiple slots found. Select a specific slot or provide its ID.' };
          }
        } else {
          return { error: 'Node is not a slot. Select a slot node or instance.' };
        }
      }

      const beforeCount = node.children.length;
      node.resetSlot();
      const afterCount = node.children.length;

      return {
        success: true,
        slotName: node.name,
        beforeCount,
        afterCount
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Reset slot "${result.slotName}"`));
        console.log(chalk.gray(`  Children: ${result.beforeCount} → ${result.afterCount}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('convert [nodeId]')
  .description('Convert a frame to a slot (must be inside a component)')
  .option('-n, --name <name>', 'Slot name')
  .action(async (nodeId, options) => {
    await checkConnection();

    const slotName = options.name || 'Slot';

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let frame;

      if (targetId) {
        frame = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No frame selected' };
        frame = selection[0];
      }

      if (frame.type !== 'FRAME') {
        return { error: 'Node is not a frame' };
      }

      // Find parent component
      let parent = frame.parent;
      let component = null;
      while (parent) {
        if (parent.type === 'COMPONENT' || parent.type === 'COMPONENT_SET') {
          component = parent;
          break;
        }
        parent = parent.parent;
      }

      if (!component) {
        return { error: 'Frame is not inside a component' };
      }

      // Store frame properties
      const frameProps = {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        layoutMode: frame.layoutMode,
        itemSpacing: frame.itemSpacing,
        paddingTop: frame.paddingTop,
        paddingBottom: frame.paddingBottom,
        paddingLeft: frame.paddingLeft,
        paddingRight: frame.paddingRight,
        fills: frame.fills,
        children: [...frame.children]
      };

      // Create slot
      const slot = component.createSlot(${JSON.stringify(slotName)});

      // Apply frame properties to slot
      slot.layoutMode = frameProps.layoutMode;
      slot.itemSpacing = frameProps.itemSpacing;
      slot.paddingTop = frameProps.paddingTop;
      slot.paddingBottom = frameProps.paddingBottom;
      slot.paddingLeft = frameProps.paddingLeft;
      slot.paddingRight = frameProps.paddingRight;
      slot.fills = frameProps.fills;
      slot.resize(frameProps.width, frameProps.height);
      slot.x = frameProps.x;
      slot.y = frameProps.y;

      // Move children to slot
      frameProps.children.forEach(child => {
        slot.appendChild(child);
      });

      // Remove original frame
      frame.remove();

      return {
        success: true,
        slotId: slot.id,
        slotName: slot.name,
        componentName: component.name
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Converted frame to slot "${result.slotName}" in "${result.componentName}"`));
        console.log(chalk.gray(`  Slot ID: ${result.slotId}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('add <nodeId>')
  .description('Add content to a slot in an instance')
  .option('-c, --component <componentId>', 'Component to instantiate')
  .option('-f, --frame', 'Add empty frame')
  .option('-t, --text <content>', 'Add text')
  .action(async (nodeId, options) => {
    await checkConnection();

    let addCode = '';
    if (options.component) {
      addCode = `
        const comp = await figma.getNodeByIdAsync(${JSON.stringify(options.component)});
        if (comp && comp.type === 'COMPONENT') {
          const inst = comp.createInstance();
          slot.appendChild(inst);
          added = { type: 'instance', name: inst.name };
        } else {
          return { error: 'Component not found' };
        }`;
    } else if (options.frame) {
      addCode = `
        const newFrame = figma.createFrame();
        newFrame.name = 'Content';
        newFrame.resize(100, 50);
        slot.appendChild(newFrame);
        added = { type: 'frame', name: newFrame.name };`;
    } else if (options.text) {
      addCode = `
        await figma.loadFontAsync({family:'Inter',style:'Regular'});
        const newText = figma.createText();
        newText.characters = ${JSON.stringify(options.text)};
        slot.appendChild(newText);
        added = { type: 'text', content: ${JSON.stringify(options.text)} };`;
    } else {
      console.log(chalk.red('✗ Specify --component, --frame, or --text'));
      return;
    }

    const code = `(async () => {
      const slot = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!slot) return { error: 'Node not found' };
      if (slot.type !== 'SLOT') return { error: 'Node is not a slot' };

      let added = null;
      ${addCode}

      return {
        success: true,
        slotName: slot.name,
        added,
        childCount: slot.children.length
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Added ${result.added.type} to slot "${result.slotName}"`));
        console.log(chalk.gray(`  Children: ${result.childCount}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

// ============ EXPORT ============

program
  .command('export-jsx [nodeId]')
  .description('Export node as JSX/React code')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .option('--pretty', 'Format output')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
        const nodes = targetId
          ? [await figma.getNodeByIdAsync(targetId)]
          : figma.currentPage.selection;

        if (!nodes.length || !nodes[0]) return 'No node selected';

        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }

        function nodeToJsx(node, indent = 0) {
          const prefix = '  '.repeat(indent);
          const props = [];

          // Name
          if (node.name && !node.name.startsWith('Frame') && !node.name.startsWith('Rectangle')) {
            props.push('name="' + node.name.replace(/"/g, '\\\\"') + '"');
          }

          // Size
          if (node.width) props.push('w={' + Math.round(node.width) + '}');
          if (node.height) props.push('h={' + Math.round(node.height) + '}');

          // Fill
          if (node.fills && node.fills.length > 0 && node.fills[0].type === 'SOLID') {
            const c = node.fills[0].color;
            props.push('bg="' + rgbToHex(c.r, c.g, c.b) + '"');
          }

          // Corner radius
          if (node.cornerRadius && node.cornerRadius > 0) {
            props.push('rounded={' + Math.round(node.cornerRadius) + '}');
          }

          // Auto-layout
          if (node.layoutMode === 'HORIZONTAL') props.push('flex="row"');
          if (node.layoutMode === 'VERTICAL') props.push('flex="col"');
          if (node.itemSpacing) props.push('gap={' + Math.round(node.itemSpacing) + '}');
          if (node.paddingTop) props.push('p={' + Math.round(node.paddingTop) + '}');

          // Text
          if (node.type === 'TEXT') {
            const textProps = [];
            if (node.fontSize) textProps.push('size={' + Math.round(node.fontSize) + '}');
            if (node.fills && node.fills[0] && node.fills[0].color) {
              const c = node.fills[0].color;
              textProps.push('color="' + rgbToHex(c.r, c.g, c.b) + '"');
            }
            return prefix + '<Text ' + textProps.join(' ') + '>' + (node.characters || '') + '</Text>';
          }

          // Frame with children
          if ('children' in node && node.children.length > 0) {
            const childJsx = node.children.map(c => nodeToJsx(c, indent + 1)).join('\\n');
            return prefix + '<Frame ' + props.join(' ') + '>\\n' + childJsx + '\\n' + prefix + '</Frame>';
          }

          return prefix + '<Frame ' + props.join(' ') + ' />';
        }

        return nodeToJsx(nodes[0]);
      })()`;

      try {
        const result = await fastEval(code);
        if (options.output) {
          writeFileSync(options.output, result);
          console.log(chalk.green(`✓ Exported to ${options.output}`));
        } else {
          console.log(result);
        }
      } catch (e) {
        console.log(chalk.red('✗ Export failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use export jsx';
      if (nodeId) cmd += ` "${nodeId}"`;
      if (options.pretty) cmd += ' --pretty';
      if (options.output) {
        cmd += ` > "${options.output}"`;
        runFigmaUse(cmd, { stdio: 'inherit' });
      } else {
        runFigmaUse(cmd);
      }
    }
  });

program
  .command('export-storybook [nodeId]')
  .description('Export components as Storybook stories')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const components = [];
        function findComponents(node) {
          if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
            components.push({
              id: node.id,
              name: node.name,
              type: node.type,
              width: Math.round(node.width),
              height: Math.round(node.height)
            });
          }
          if ('children' in node) node.children.forEach(c => findComponents(c));
        }
        figma.currentPage.children.forEach(c => findComponents(c));
        return components;
      })()`;

      try {
        const components = await fastEval(code);
        if (!components.length) {
          console.log(chalk.yellow('No components found on current page'));
          return;
        }

        let output = '// Storybook stories generated from Figma\n';
        output += 'import React from "react";\n\n';

        components.forEach(c => {
          const safeName = c.name.replace(/[^a-zA-Z0-9]/g, '');
          output += `export const ${safeName} = () => (\n`;
          output += `  <div style={{ width: ${c.width}, height: ${c.height} }}>\n`;
          output += `    {/* ${c.name} - ID: ${c.id} */}\n`;
          output += `  </div>\n`;
          output += `);\n\n`;
        });

        if (options.output) {
          writeFileSync(options.output, output);
          console.log(chalk.green(`✓ Exported ${components.length} components to ${options.output}`));
        } else {
          console.log(output);
        }
      } catch (e) {
        console.log(chalk.red('✗ Export failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use export storybook';
      if (nodeId) cmd += ` "${nodeId}"`;
      if (options.output) {
        cmd += ` > "${options.output}"`;
        runFigmaUse(cmd, { stdio: 'inherit' });
      } else {
        runFigmaUse(cmd);
      }
    }
  });

// ============ FIGJAM ============

const figjam = program
  .command('figjam')
  .alias('fj')
  .description('FigJam commands (sticky notes, shapes, connectors)');

// Helper: Get FigJam client
async function getFigJamClient(pageTitle) {
  const client = new FigJamClient();
  try {
    const pages = await FigJamClient.listPages();
    if (pages.length === 0) {
      console.log(chalk.red('\n✗ No FigJam pages open\n'));
      console.log(chalk.gray('  Open a FigJam file in Figma Desktop first.\n'));
      process.exit(1);
    }

    const targetPage = pageTitle || pages[0].title;
    await client.connect(targetPage);
    return client;
  } catch (error) {
    console.log(chalk.red('\n✗ ' + error.message + '\n'));
    process.exit(1);
  }
}

figjam
  .command('list')
  .description('List open FigJam pages')
  .action(async () => {
    try {
      const pages = await FigJamClient.listPages();
      if (pages.length === 0) {
        console.log(chalk.yellow('\n  No FigJam pages open\n'));
        return;
      }
      console.log(chalk.cyan('\n  Open FigJam Pages:\n'));
      pages.forEach((p, i) => {
        console.log(chalk.white(`  ${i + 1}. ${p.title}`));
      });
      console.log();
    } catch (error) {
      console.log(chalk.red('\n✗ Could not connect to Figma\n'));
      console.log(chalk.gray('  Make sure Figma is running with: figma-ds-cli connect\n'));
    }
  });

figjam
  .command('info')
  .description('Show current FigJam page info')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const info = await client.getPageInfo();
      console.log(chalk.cyan('\n  FigJam Page Info:\n'));
      console.log(chalk.white(`  Name: ${info.name}`));
      console.log(chalk.white(`  ID: ${info.id}`));
      console.log(chalk.white(`  Elements: ${info.childCount}`));
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('nodes')
  .description('List nodes on current FigJam page')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-l, --limit <n>', 'Limit number of nodes', '20')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const nodes = await client.listNodes(parseInt(options.limit));
      if (nodes.length === 0) {
        console.log(chalk.yellow('\n  No elements on this page\n'));
        return;
      }
      console.log(chalk.cyan('\n  FigJam Elements:\n'));
      nodes.forEach(n => {
        const type = n.type.padEnd(16);
        const name = (n.name || '(unnamed)').substring(0, 30);
        console.log(chalk.gray(`  ${n.id.padEnd(8)}`), chalk.white(type), chalk.gray(name), chalk.gray(`(${n.x}, ${n.y})`));
      });
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('sticky <text>')
  .description('Create a sticky note')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-c, --color <hex>', 'Background color')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating sticky note...').start();
    try {
      const result = await client.createSticky(text, parseFloat(options.x), parseFloat(options.y), options.color);
      spinner.succeed(`Sticky created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create sticky: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('shape <text>')
  .description('Create a shape with text')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-w, --width <n>', 'Width', '200')
  .option('-h, --height <n>', 'Height', '100')
  .option('-t, --type <type>', 'Shape type (ROUNDED_RECTANGLE, RECTANGLE, ELLIPSE, DIAMOND)', 'ROUNDED_RECTANGLE')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating shape...').start();
    try {
      const result = await client.createShape(
        text,
        parseFloat(options.x),
        parseFloat(options.y),
        parseFloat(options.width),
        parseFloat(options.height),
        options.type
      );
      spinner.succeed(`Shape created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create shape: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('text <content>')
  .description('Create a text node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .action(async (content, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating text...').start();
    try {
      const result = await client.createText(content, parseFloat(options.x), parseFloat(options.y), parseFloat(options.size));
      spinner.succeed(`Text created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('connect <startId> <endId>')
  .description('Create a connector between two nodes')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (startId, endId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating connector...').start();
    try {
      const result = await client.createConnector(startId, endId);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Connector created: ${result.id}`);
      }
    } catch (error) {
      spinner.fail('Failed to create connector: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('delete <nodeId>')
  .description('Delete a node by ID')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Deleting node...').start();
    try {
      const result = await client.deleteNode(nodeId);
      if (result.deleted) {
        spinner.succeed(`Node ${nodeId} deleted`);
      } else {
        spinner.fail(result.error || 'Node not found');
      }
    } catch (error) {
      spinner.fail('Failed to delete node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('move <nodeId> <x> <y>')
  .description('Move a node to a new position')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, x, y, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Moving node...').start();
    try {
      const result = await client.moveNode(nodeId, parseFloat(x), parseFloat(y));
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} moved to (${result.x}, ${result.y})`);
      }
    } catch (error) {
      spinner.fail('Failed to move node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('update <nodeId> <text>')
  .description('Update text content of a node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Updating text...').start();
    try {
      const result = await client.updateText(nodeId, text);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} text updated`);
      }
    } catch (error) {
      spinner.fail('Failed to update text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('eval <code>')
  .description('Execute JavaScript in FigJam context')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (code, options) => {
    const client = await getFigJamClient(options.page);
    try {
      const result = await client.eval(code);
      if (result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (error) {
      console.log(chalk.red('Error: ' + error.message));
    } finally {
      client.close();
    }
  });

// List open Figma design files (used by fig-start script)
program
  .command('files')
  .description('List open Figma design files as JSON')
  .action(async () => {
    try {
      const pages = await FigmaClient.listPages();
      // Filter to actual design/board files only (exclude blobs, webpack, feed, tabs)
      const designFiles = pages.filter(p =>
        p.url && (p.url.includes('/design/') || p.url.includes('/board/'))
      );
      console.log(JSON.stringify(designFiles));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });

// ============ SIZES ============

program
  .command('sizes [nodeId]')
  .description('Generate Small/Medium/Large size variants from a component')
  .option('-b, --base <size>', 'Which size is the source: small, medium, large', 'medium')
  .option('-g, --gap <n>', 'Gap between variants', '40')
  .action(async (nodeId, options) => {
    await checkConnection();
    const spinner = ora('Analyzing component...').start();

    try {
      const nodeIdStr = nodeId || '';
      const baseSize = options.base.toLowerCase();
      const gap = parseInt(options.gap) || 40;

      // Size multipliers relative to medium
      const sizeConfig = {
        small:  { scale: 0.85, fontSize: 0.85, padding: 0.75, radius: 0.85 },
        medium: { scale: 1.0,  fontSize: 1.0,  padding: 1.0,  radius: 1.0 },
        large:  { scale: 1.2,  fontSize: 1.15, padding: 1.25, radius: 1.1 }
      };

      // Adjust multipliers based on which size is the source
      let multipliers = {};
      const baseConfig = sizeConfig[baseSize];
      for (const [size, cfg] of Object.entries(sizeConfig)) {
        multipliers[size] = {
          scale: cfg.scale / baseConfig.scale,
          fontSize: cfg.fontSize / baseConfig.fontSize,
          padding: cfg.padding / baseConfig.padding,
          radius: cfg.radius / baseConfig.radius
        };
      }

      const code = `(async () => {
        let node;
        if ('${nodeIdStr}') {
          node = await figma.getNodeByIdAsync('${nodeIdStr}');
        } else {
          node = figma.currentPage.selection[0];
        }

        if (!node) {
          return { error: 'No component selected. Select a component or frame.' };
        }

        // Get the component to clone
        let sourceComponent = null;
        if (node.type === 'COMPONENT') {
          sourceComponent = node;
        } else if (node.type === 'INSTANCE') {
          sourceComponent = await node.getMainComponentAsync();
        } else if (node.type === 'FRAME') {
          // Convert frame to component first
          sourceComponent = figma.createComponentFromNode(node.clone());
          sourceComponent.name = node.name;
        }

        if (!sourceComponent) {
          return { error: 'Could not get source component.' };
        }

        // Load common Inter font styles
        const styles = ['Regular', 'Medium', 'Semi Bold', 'Bold'];
        for (const style of styles) {
          try { await figma.loadFontAsync({ family: 'Inter', style }); } catch (e) {}
        }

        const multipliers = ${JSON.stringify(multipliers)};
        const sizes = ['small', 'medium', 'large'];
        const baseSize = '${baseSize}';
        const gap = ${gap};

        // Find position for new components
        let startX = 0;
        figma.currentPage.children.forEach(n => { startX = Math.max(startX, n.x + n.width); });
        startX += 200;
        const startY = sourceComponent.y;

        const baseName = sourceComponent.name.replace(/\\/(Small|Medium|Large)/gi, '').replace(/\\s*(Small|Medium|Large)\\s*/gi, '').trim() || 'Component';
        const createdComponents = [];

        function scaleNode(node, mult) {
          // Scale frame/rectangle dimensions
          if (node.resize && typeof node.width === 'number') {
            const newW = Math.round(node.width * mult.scale);
            const newH = Math.round(node.height * mult.scale);
            node.resize(newW, newH);
          }

          // Scale corner radius
          if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
            node.cornerRadius = Math.round(node.cornerRadius * mult.radius);
          }

          // Scale padding
          if (node.paddingLeft !== undefined) {
            node.paddingLeft = Math.round(node.paddingLeft * mult.padding);
            node.paddingRight = Math.round(node.paddingRight * mult.padding);
            node.paddingTop = Math.round(node.paddingTop * mult.padding);
            node.paddingBottom = Math.round(node.paddingBottom * mult.padding);
          }

          // Scale gap
          if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
            node.itemSpacing = Math.round(node.itemSpacing * mult.padding);
          }

          // Scale text
          if (node.type === 'TEXT') {
            const newSize = Math.round(node.fontSize * mult.fontSize);
            node.fontSize = newSize;
          }

          // Recurse into children
          if (node.children) {
            for (const child of node.children) {
              scaleNode(child, mult);
            }
          }
        }

        let x = startX;
        for (const size of sizes) {
          const mult = multipliers[size];

          // Clone the source component
          const clone = sourceComponent.clone();

          // Scale all elements
          scaleNode(clone, mult);

          // Convert to component with size name
          const sizeLabel = size.charAt(0).toUpperCase() + size.slice(1);

          let comp;
          if (clone.type === 'COMPONENT') {
            comp = clone;
            comp.name = baseName + '/' + sizeLabel;
          } else {
            comp = figma.createComponentFromNode(clone);
            comp.name = baseName + '/' + sizeLabel;
          }

          comp.x = x;
          comp.y = startY;
          x += comp.width + gap;

          createdComponents.push({ id: comp.id, name: comp.name, w: comp.width, h: comp.height });
        }

        figma.currentPage.selection = createdComponents.map(c => figma.getNodeById(c.id)).filter(Boolean);
        figma.viewport.scrollAndZoomIntoView(figma.currentPage.selection);

        return { count: createdComponents.length, components: createdComponents };
      })()`;

      const result = await fastEval(code);

      if (result.error) {
        spinner.fail(result.error);
        return;
      }

      spinner.succeed(`Created ${result.count} size variants`);

      result.components.forEach(c => {
        console.log(chalk.gray(`  ${c.name} (${c.w}×${c.h})`));
      });

    } catch (error) {
      spinner.fail('Failed: ' + error.message);
    }
  });

// ============ VARIANTS ============
// Turn a set of frames OR components into a real Figma Component Set
// (variant set) with a named variant property. Solves the common case:
// "I have N frames that should be variants of one component."
//
// Usage:
//   figma-cli variants from 1:2,1:3,1:4 \
//     --property Size --values Small,Medium,Large --name Button
//
// Accepts FRAMEs (auto-promoted to components), GROUPs, or existing
// COMPONENTs. INSTANCEs are rejected with a clear error.

const variantsCmd = program
  .command('variants')
  .description('Build variant sets from frames or components');

variantsCmd
  .command('from <ids>')
  .description('Combine frames/components (comma-separated IDs) into a Variant Set')
  .requiredOption('-p, --property <name>', 'Variant property name (e.g., Size, State, Color)')
  .requiredOption('-v, --values <values>', 'Comma-separated variant values matching the IDs (e.g., Small,Medium,Large)')
  .option('-n, --name <name>', 'Name for the resulting Component Set (defaults to first node\'s base name)')
  .action(async (ids, options) => {
    await checkConnection();

    const idArr = ids.split(',').map(s => s.trim()).filter(Boolean);
    const valueArr = options.values.split(',').map(s => s.trim()).filter(Boolean);

    if (idArr.length < 2) {
      console.error(chalk.red('✗'), 'Need at least 2 IDs to create a Variant Set.');
      process.exit(1);
    }
    if (idArr.length !== valueArr.length) {
      console.error(chalk.red('✗'), `ID count (${idArr.length}) must equal --values count (${valueArr.length}).`);
      console.error(chalk.gray(`  ids:    ${idArr.join(', ')}`));
      console.error(chalk.gray(`  values: ${valueArr.join(', ')}`));
      process.exit(1);
    }

    const property = options.property;
    const setNameArg = options.name || '';
    const spinner = ora('Building Variant Set...').start();

    const code = `(async () => {
      const ids = ${JSON.stringify(idArr)};
      const values = ${JSON.stringify(valueArr)};
      const property = ${JSON.stringify(property)};
      const setNameArg = ${JSON.stringify(setNameArg)};

      const components = [];
      const promoted = [];
      let baseName = setNameArg;

      for (let i = 0; i < ids.length; i++) {
        const node = await figma.getNodeByIdAsync(ids[i]);
        if (!node) {
          return { error: 'Node not found: ' + ids[i] };
        }
        let comp;
        if (node.type === 'COMPONENT') {
          if (node.parent && node.parent.type === 'COMPONENT_SET') {
            return { error: 'Node ' + ids[i] + ' is already a variant inside a Component Set. Pass the source frames or standalone components.' };
          }
          comp = node;
        } else if (node.type === 'FRAME' || node.type === 'GROUP') {
          comp = figma.createComponentFromNode(node);
          promoted.push(ids[i]);
        } else if (node.type === 'INSTANCE') {
          return { error: 'Node ' + ids[i] + ' is an INSTANCE. Pass the source frame or main component instead.' };
        } else {
          return { error: 'Unsupported type for ' + ids[i] + ': ' + node.type + '. Must be FRAME, GROUP, or COMPONENT.' };
        }
        if (!baseName) {
          // Derive base name from first node: strip "/Variant", ", Prop=Val", or trailing size words.
          let n = (comp.name || 'Component');
          n = n.replace(/\\s*,\\s*[^,=]+=[^,]+(?:,\\s*[^,=]+=[^,]+)*\\s*$/, '');
          n = n.replace(/\\s*\\/.*$/, '');
          n = n.trim() || 'Component';
          baseName = n;
        }
        components.push({ comp, value: values[i] });
      }

      // Rename so Figma's combineAsVariants creates exactly one variant
      // property. "BaseName, Size=Small" would parse as TWO properties
      // (the bare prefix becomes an unnamed "Property 1"), so we use
      // pure "Property=Value" naming and let the Component Set carry the
      // BaseName separately.
      for (const { comp, value } of components) {
        comp.name = property + '=' + value;
      }

      // combineAsVariants requires all components to belong to the same parent.
      // We hoist them to currentPage to guarantee this regardless of where the
      // source frames lived (e.g. nested inside a layout frame).
      const page = figma.currentPage;
      for (const { comp } of components) {
        if (comp.parent !== page) {
          page.appendChild(comp);
        }
      }

      let set;
      try {
        set = figma.combineAsVariants(components.map(c => c.comp), page);
      } catch (err) {
        return { error: 'combineAsVariants failed: ' + (err && err.message ? err.message : String(err)) };
      }
      set.name = baseName;

      figma.currentPage.selection = [set];
      figma.viewport.scrollAndZoomIntoView([set]);

      return {
        id: set.id,
        name: set.name,
        property,
        values,
        promotedCount: promoted.length,
        count: components.length,
        variantIds: components.map(c => c.comp.id)
      };
    })()`;

    try {
      const r = await fastEval(code);
      if (r && r.error) {
        spinner.fail(r.error);
        process.exit(1);
      }
      spinner.succeed(`Created Variant Set "${r.name}"`);
      if (r.promotedCount > 0) {
        console.log(chalk.gray(`  Promoted ${r.promotedCount} frame(s) to components`));
      }
      console.log(chalk.gray(`  Property: ${chalk.white(r.property)}`));
      r.values.forEach(v => console.log(chalk.gray(`    ${r.property}=${v}`)));
      console.log(chalk.cyan(`  ${r.id}`));
    } catch (e) {
      spinner.fail('Failed: ' + (e.message || String(e)));
      process.exit(1);
    }
  });

// ============ COMBOS ============

program
  .command('combos [nodeId]')
  .description('Generate all component variant combinations in a labeled grid')
  .option('-g, --gap <n>', 'Gap between instances', '40')
  .option('--no-labels', 'Skip row/column labels')
  .option('--no-boolean', 'Skip boolean properties')
  .option('--dry-run', 'Show combinations without creating instances')
  .action(async (nodeId, options) => {
    await checkConnection();
    const spinner = ora('Analyzing component properties...').start();

    try {
      const includeBoolean = options.boolean !== false;
      const nodeIdStr = nodeId || '';

      const analysisCode = `(async () => {
        let node;
        if ('${nodeIdStr}') {
          node = await figma.getNodeByIdAsync('${nodeIdStr}');
        } else {
          node = figma.currentPage.selection[0];
        }

        if (!node) {
          return { error: 'No component selected. Select a component set or provide a node ID.' };
        }

        let componentSet = null;
        if (node.type === 'COMPONENT_SET') {
          componentSet = node;
        } else if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
          componentSet = node.parent;
        } else if (node.type === 'INSTANCE') {
          const main = await node.getMainComponentAsync();
          if (main?.parent?.type === 'COMPONENT_SET') {
            componentSet = main.parent;
          }
        }

        if (!componentSet) {
          return { error: 'Selected node is not a component set or variant. Select a component with variants.' };
        }

        const propDefs = componentSet.componentPropertyDefinitions;
        if (!propDefs || Object.keys(propDefs).length === 0) {
          return { error: 'Component has no properties defined.' };
        }

        const properties = [];
        for (const [name, def] of Object.entries(propDefs)) {
          if (def.type === 'VARIANT') {
            properties.push({ name, type: 'VARIANT', options: def.variantOptions || [] });
          } else if (def.type === 'BOOLEAN' && ${includeBoolean}) {
            properties.push({ name, type: 'BOOLEAN', options: [true, false] });
          }
        }

        if (properties.length === 0) {
          return { error: 'No variant or boolean properties found.' };
        }

        const defaultVariant = componentSet.defaultVariant;
        if (!defaultVariant) {
          return { error: 'Could not find default variant.' };
        }

        // Find max size across all variants (for proper grid spacing)
        let maxW = 0, maxH = 0;
        for (const child of componentSet.children) {
          if (child.type === 'COMPONENT') {
            maxW = Math.max(maxW, child.width);
            maxH = Math.max(maxH, child.height);
          }
        }

        return {
          componentSetId: componentSet.id,
          componentSetName: componentSet.name,
          defaultVariantId: defaultVariant.id,
          properties,
          instanceSize: { w: maxW || defaultVariant.width, h: maxH || defaultVariant.height }
        };
      })()`;

      const analysis = await fastEval(analysisCode);

      if (analysis.error) {
        spinner.fail(analysis.error);
        return;
      }

      // Calculate cartesian product of all options
      function cartesian(arrays) {
        return arrays.reduce((a, b) => a.flatMap(x => b.map(y => [...x, y])), [[]]);
      }

      const optionArrays = analysis.properties.map(p => p.options);
      const combinations = cartesian(optionArrays);
      const totalCombos = combinations.length;

      spinner.text = `Found ${totalCombos} combinations for ${analysis.properties.length} properties`;

      if (options.dryRun) {
        spinner.succeed(`${totalCombos} combinations (dry run)`);
        console.log(chalk.cyan('\nProperties:'));
        analysis.properties.forEach(p => {
          console.log(`  ${p.name}: ${p.options.join(', ')}`);
        });
        console.log(chalk.cyan(`\nWould create ${totalCombos} instances`));
        return;
      }

      // Determine grid layout
      const gap = parseInt(options.gap) || 40;
      const labelHeight = options.labels !== false ? 30 : 0;
      const labelWidth = options.labels !== false ? 120 : 0;
      const colProp = analysis.properties[analysis.properties.length - 1];
      const rowProps = analysis.properties.slice(0, -1);
      const numCols = colProp.options.length;
      const numRows = rowProps.length > 0 ? rowProps.reduce((acc, p) => acc * p.options.length, 1) : 1;
      const instanceW = analysis.instanceSize.w;
      const instanceH = analysis.instanceSize.h;
      const showLabels = options.labels !== false;

      spinner.text = `Creating ${totalCombos} components in ${numRows}x${numCols} grid...`;

      const createCode = `(async () => {
        const componentSet = await figma.getNodeByIdAsync('${analysis.componentSetId}');
        const defaultVariant = await figma.getNodeByIdAsync('${analysis.defaultVariantId}');

        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
        await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

        let startX = 0;
        figma.currentPage.children.forEach(n => { startX = Math.max(startX, n.x + n.width); });
        startX += 200;
        const startY = 100;

        const gap = ${gap};
        const instanceW = ${instanceW};
        const instanceH = ${instanceH};
        const baseName = '${analysis.componentSetName.replace(/'/g, "\\'")}';
        const showLabels = ${showLabels};
        const labelOffset = showLabels ? 120 : 0;
        const headerOffset = showLabels ? 40 : 0;

        const properties = ${JSON.stringify(analysis.properties)};
        const combinations = ${JSON.stringify(combinations)};
        const colProp = properties[properties.length - 1];
        const rowProps = properties.slice(0, -1);

        const createdComponents = [];
        const createdLabels = [];
        const rowCombos = new Map();
        for (const combo of combinations) {
          const rowKey = combo.slice(0, -1).join('|');
          if (!rowCombos.has(rowKey)) rowCombos.set(rowKey, []);
          rowCombos.get(rowKey).push(combo);
        }

        // Create column headers (last property values)
        if (showLabels) {
          for (let colIndex = 0; colIndex < colProp.options.length; colIndex++) {
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Medium' };
            label.characters = String(colProp.options[colIndex]);
            label.fontSize = 14;
            label.fills = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }];
            label.x = startX + labelOffset + colIndex * (instanceW + gap) + instanceW / 2 - label.width / 2;
            label.y = startY;
            createdLabels.push(label);
          }
        }

        let rowIndex = 0;
        for (const [rowKey, combos] of rowCombos) {
          // Create row label (all properties except last)
          if (showLabels && rowProps.length > 0) {
            const rowValues = rowKey.split('|');
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Regular' };
            label.characters = rowValues.join(' / ');
            label.fontSize = 12;
            label.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
            label.x = startX;
            label.y = startY + headerOffset + rowIndex * (instanceH + gap) + instanceH / 2 - label.height / 2;
            createdLabels.push(label);
          }

          for (let colIndex = 0; colIndex < combos.length; colIndex++) {
            const combo = combos[colIndex];

            // Create instance and set properties
            const instance = defaultVariant.createInstance();
            const propsToSet = {};
            for (let i = 0; i < properties.length; i++) {
              propsToSet[properties[i].name] = combo[i];
            }
            try {
              instance.setProperties(propsToSet);
            } catch (e) {
              instance.remove();
              continue;
            }

            // Detach from component to get a frame
            const detached = instance.detachInstance();

            // Convert to component with proper name
            const compName = baseName + '/' + combo.join('/');
            const component = figma.createComponentFromNode(detached);
            component.name = compName;

            // Position on canvas (offset for labels)
            component.x = startX + labelOffset + colIndex * (instanceW + gap);
            component.y = startY + headerOffset + rowIndex * (instanceH + gap);

            createdComponents.push({ id: component.id, name: component.name });
          }
          rowIndex++;
        }

        const allNodes = [...createdComponents.map(c => figma.getNodeById(c.id)), ...createdLabels].filter(Boolean);
        figma.currentPage.selection = allNodes;
        if (allNodes.length > 0) {
          figma.viewport.scrollAndZoomIntoView(allNodes);
        }

        return { count: createdComponents.length, labels: createdLabels.length, gridSize: rowIndex + 'x' + colProp.options.length, components: createdComponents.slice(0, 3) };
      })()`;

      const result = await fastEval(createCode);

      if (result.error) {
        spinner.fail(result.error);
        return;
      }

      const labelInfo = result.labels > 0 ? ` with ${result.labels} labels` : '';
      spinner.succeed(`Created ${result.count} components in ${result.gridSize} grid${labelInfo}`);
      if (result.components && result.components.length > 0) {
        console.log(chalk.gray(`  ${result.components.map(c => c.name).join(', ')}${result.count > 3 ? ', ...' : ''}`));
      }

    } catch (error) {
      spinner.fail('Failed: ' + error.message);
    }
  });

// ─── shadcn/ui Component Package ───────────────────────────────────
const shadcn = program
  .command('shadcn')
  .description('Generate shadcn/ui components in Figma (requires: tokens preset shadcn)');

shadcn
  .command('list')
  .description('List all available shadcn/ui components')
  .action(() => {
    const { available, interactive } = listComponents();
    console.log(chalk.bold('\n  Available components:\n'));
    available.forEach(name => {
      const variants = getComponent(name);
      console.log(`  ${chalk.green('●')} ${chalk.white(name)} ${chalk.gray(`(${variants.length} variant${variants.length > 1 ? 's' : ''})`)}`);
    });
    console.log(chalk.bold('\n  Interactive only (not generated):\n'));
    console.log(`  ${chalk.gray(interactive.join(', '))}`);
    console.log();
  });

shadcn
  .command('add [names...]')
  .description('Add shadcn/ui component(s) to Figma canvas. Use --count to add multiple copies of the same component.')
  .option('--all', 'Add all components')
  .option('-c, --count <n>', 'Add this many copies of each named component (e.g. --count 3 for 3 cards)', '1')
  .action(async (names, options) => {
    checkConnection();
    const count = Math.max(1, parseInt(options.count) || 1);

    let items;
    if (options.all) {
      items = getAllComponents();
    } else if (names && names.length > 0) {
      items = [];
      const userPassedCount = options.count !== undefined && options.count !== '1';
      for (const name of names) {
        const comp = getComponent(name);
        if (!comp) {
          console.log(chalk.red(`  ✗ Unknown component: ${name}`));
          console.log(chalk.gray(`  Available: ${VISUAL_COMPONENTS.join(', ')}`));
          return;
        }
        // Semantics:
        //   `shadcn add button`           → all 9 variants once (the variant gallery)
        //   `shadcn add button --count 4` → 4 copies of the DEFAULT variant (= comp[0])
        //                                   (the user asked for 4 buttons, not 4×9=36)
        if (userPassedCount) {
          const defaultVariant = comp[0];
          for (let i = 0; i < count; i++) items.push(defaultVariant);
        } else {
          items.push(...comp);
        }
      }
    } else {
      console.log(chalk.yellow('  Specify component names or use --all'));
      console.log(chalk.gray(`  Example: node src/index.js shadcn add card --count 3`));
      console.log(chalk.gray(`  Available: ${VISUAL_COMPONENTS.join(', ')}`));
      return;
    }

    const label = count > 1 ? ` (${count}x)` : '';
    const spinner = ora(`Creating ${items.length} shadcn/ui component(s)${label}...`).start();
    let created = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const result = await fastRender(item.jsx);
        if (result && result.id) {
          created++;
          spinner.text = `Created ${created}/${items.length}: ${item.name}`;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        spinner.text = `Failed: ${item.name} (${err.message})`;
      }
    }

    if (failed === 0) {
      spinner.succeed(`Created ${created} shadcn/ui component(s)`);
    } else {
      spinner.warn(`Created ${created}, failed ${failed}`);
    }
  });

// ============ BLOCKS ============

const blocksCmd = program
  .command('blocks')
  .description('Pre-built UI blocks (dashboards, pages, etc.)');

blocksCmd
  .command('list')
  .description('List available blocks')
  .action(() => {
    const blocks = listBlocks();
    if (blocks.length === 0) {
      console.log(chalk.yellow('No blocks available yet.'));
      return;
    }
    console.log(chalk.bold('\nAvailable Blocks:\n'));
    for (const b of blocks) {
      console.log(`  ${chalk.cyan(b.id.padEnd(20))} ${b.description}`);
    }
    console.log(`\nUsage: ${chalk.green('node src/index.js blocks create <id>')}\n`);
  });

blocksCmd
  .command('create <id>')
  .description('Create a block in Figma')
  .action(async (id) => {
    await checkConnection();
    const block = getBlock(id);
    if (!block) {
      console.log(chalk.red(`✗ Block "${id}" not found.`));
      console.log(`Run ${chalk.cyan('blocks list')} to see available blocks.`);
      return;
    }

    const spinner = ora(`Creating ${block.name}...`).start();

    try {
      // Context helpers for block scripts
      const context = {
        // Render JSX via the existing render pipeline
        renderJsx: async (jsx) => {
          // Calculate smart position
          let posX = 0;
          try {
            const canvasInfo = await daemonExec('eval', {
              code: 'var nodes = figma.currentPage.children; var maxX = 0; for (var i = 0; i < nodes.length; i++) { var right = nodes[i].x + nodes[i].width; if (right > maxX) maxX = right; } return maxX;'
            });
            if (typeof canvasInfo === 'number' && canvasInfo > 0) posX = canvasInfo + 100;
          } catch (e) { /* use 0 */ }

          const result = await daemonExec('render', { jsx, x: posX, y: 0 }, 120000);
          return result;
        },

        // Eval code from a file path
        evalFile: async (filePath) => {
          const code = readFileSync(filePath, 'utf8');
          return await daemonExec('eval', { code }, 120000);
        },

        // Write temp file and return path
        writeTemp: (name, content) => {
          const tmpDir = join(homedir(), '.figma-ds-cli', 'tmp');
          if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
          const tmpPath = join(tmpDir, name);
          writeFileSync(tmpPath, content);
          return tmpPath;
        }
      };

      const nodeId = await block.create(context);
      spinner.succeed(`Created ${block.name} (${nodeId})`);
    } catch (e) {
      spinner.fail(`Failed to create ${block.name}: ${e.message}`);
    }
  });

// Shared error handler for commands that hit Figma's API via daemonExec.
// Prints the error, then tries to surface relevant Figma Plugin API docs.
function handleEvalError(e) {
  console.error(chalk.red('✗'), e.message);
  try { apiDocs.suggestFromError(e.message); } catch { /* docs not installed, no-op */ }
  process.exit(1);
}

// ============ DEV RESOURCES ============
// Link Figma nodes to dev artifacts (Storybook, GitHub, docs, etc.)

const devCmd = program
  .command('dev')
  .description('Manage dev resources (Storybook/GitHub/doc links on nodes)');

devCmd
  .command('link <nodeId> <url>')
  .description('Add a dev resource link to a node')
  .option('-n, --name <name>', 'Display name for the link')
  .action(async (nodeId, url, options) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.addDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.addDevResourceAsync(${JSON.stringify(url)}, ${JSON.stringify(options.name || '')});
      const all = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, count: all.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Linked: ${r.name} (${r.id}) → ${url}`);
      console.log(chalk.gray(`  Total dev resources: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('list [nodeId]')
  .description('List dev resources on a node (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (typeof n.getDevResourcesAsync !== 'function') throw new Error('Node does not support dev resources');
      const r = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, resources: r };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.resources || r.resources.length === 0) {
        console.log(chalk.gray('  (no dev resources)'));
        return;
      }
      r.resources.forEach((res, i) => {
        console.log(`  ${i + 1}. ${res.name || '(unnamed)'}`);
        console.log(chalk.gray(`     ${res.url}`));
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('unlink <nodeId> <url>')
  .description('Remove a dev resource link from a node')
  .action(async (nodeId, url) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.deleteDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.deleteDevResourceAsync(${JSON.stringify(url)});
      const all = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, count: all.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Unlinked from ${r.name} (${r.id})`);
      console.log(chalk.gray(`  Remaining dev resources: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('edit <nodeId> <currentUrl> <newUrl>')
  .description('Edit an existing dev resource (replace URL and/or name)')
  .option('-n, --name <name>', 'New display name')
  .action(async (nodeId, currentUrl, newUrl, options) => {
    await checkConnection();
    const updateObj = { url: newUrl };
    if (options.name) updateObj.name = options.name;
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.editDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.editDevResourceAsync(${JSON.stringify(currentUrl)}, ${JSON.stringify(updateObj)});
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Edited dev resource on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ SECTIONS ============
// Group frames into named Figma sections for canvas organization.

const sectionCmd = program
  .command('section')
  .description('Manage Figma sections (organize frames into named groups)');

sectionCmd
  .command('create <name> [nodeIds]')
  .description('Create a section, optionally moving comma-separated node IDs into it')
  .action(async (name, nodeIds) => {
    await checkConnection();
    const ids = nodeIds ? JSON.stringify(nodeIds.split(',').map(s => s.trim())) : '[]';
    const code = `(async () => {
      const section = figma.createSection();
      section.name = ${JSON.stringify(name)};
      const ids = ${ids};
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        section.appendChild(n);
      }
      return { id: section.id, name: section.name, count: ids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Created section "${r.name}" (${r.id}) with ${r.count} child(ren)`);
    } catch (e) {
      handleEvalError(e);
    }
  });

sectionCmd
  .command('list')
  .description('List all sections on the current page')
  .action(async () => {
    await checkConnection();
    const code = `(async () => {
      const sections = figma.currentPage.findAll(n => n.type === 'SECTION');
      return sections.map(s => ({ id: s.id, name: s.name, count: s.children.length }));
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (!r || r.length === 0) {
        console.log(chalk.gray('(no sections on this page)'));
        return;
      }
      r.forEach(s => {
        console.log(`  ${s.name}  ${chalk.gray('(' + s.id + ')')}  ${chalk.gray(s.count + ' children')}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

sectionCmd
  .command('add <sectionId> <nodeIds>')
  .description('Add comma-separated nodes into an existing section')
  .action(async (sectionId, nodeIds) => {
    await checkConnection();
    const ids = JSON.stringify(nodeIds.split(',').map(s => s.trim()));
    const code = `(async () => {
      const s = await figma.getNodeByIdAsync(${JSON.stringify(sectionId)});
      if (!s) throw new Error('Section not found: ${sectionId}');
      if (s.type !== 'SECTION') throw new Error('Not a section: ${sectionId}');
      const ids = ${ids};
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        s.appendChild(n);
      }
      return { id: s.id, name: s.name, count: s.children.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Added to section "${r.name}" (${r.id}). Total children: ${r.count}`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ LAYOUT GRIDS ============
// Manage column/row grids on frames (12-col grids, baseline grids, etc.)

const gridCmd = program
  .command('grid')
  .description('Manage layout grids on frames (columns, rows, gutters)');

gridCmd
  .command('set <nodeId>')
  .description('Set a column or row grid on a frame')
  .option('-c, --columns <n>', 'Number of columns', parseInt)
  .option('-r, --rows <n>', 'Number of rows', parseInt)
  .option('-g, --gutter <n>', 'Gutter size in px', parseInt, 16)
  .option('-m, --margin <n>', 'Outer margin in px', parseInt, 0)
  .option('-a, --alignment <align>', 'Alignment: stretch|min|center|max', 'stretch')
  .option('--color <hex>', 'Grid color (hex)', '#FF008B')
  .option('--opacity <n>', 'Grid opacity (0-1)', parseFloat, 0.1)
  .option('--append', 'Append to existing grids instead of replacing')
  .action(async (nodeId, options) => {
    await checkConnection();
    if (!options.columns && !options.rows) {
      console.error(chalk.red('✗'), 'Specify at least --columns or --rows');
      process.exit(1);
    }
    const alignmentMap = { stretch: 'STRETCH', min: 'MIN', center: 'CENTER', max: 'MAX' };
    const alignment = alignmentMap[options.alignment.toLowerCase()] || 'STRETCH';
    const hex = options.color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const colorObj = `{r:${r.toFixed(4)},g:${g.toFixed(4)},b:${b.toFixed(4)},a:${options.opacity}}`;

    const grids = [];
    if (options.columns) {
      grids.push(`{pattern:'COLUMNS',alignment:'${alignment}',count:${options.columns},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    if (options.rows) {
      grids.push(`{pattern:'ROWS',alignment:'${alignment}',count:${options.rows},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids (must be FRAME, COMPONENT, or COMPONENT_SET)');
      const newGrids = [${grids.join(',')}];
      n.layoutGrids = ${options.append ? '[...n.layoutGrids, ...newGrids]' : 'newGrids'};
      return { id: n.id, name: n.name, count: n.layoutGrids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Set grid on ${r.name} (${r.id})`);
      console.log(chalk.gray(`  Total grids: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

gridCmd
  .command('list [nodeId]')
  .description('List layout grids on a frame (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids');
      return { id: n.id, name: n.name, grids: n.layoutGrids };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.grids || r.grids.length === 0) {
        console.log(chalk.gray('  (no layout grids)'));
        return;
      }
      r.grids.forEach((g, i) => {
        if (g.pattern === 'GRID') {
          console.log(`  ${i + 1}. GRID  size=${g.sectionSize}px`);
        } else {
          console.log(`  ${i + 1}. ${g.pattern}  count=${g.count}  gutter=${g.gutterSize}  offset=${g.offset}  align=${g.alignment}`);
        }
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

gridCmd
  .command('clear <nodeId>')
  .description('Remove all layout grids from a frame')
  .action(async (nodeId) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids');
      n.layoutGrids = [];
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Cleared grids on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ COMPONENT PROPERTIES ============
// Manage variant/boolean/text/instance-swap properties on Figma components.

const componentCmd = program
  .command('component')
  .description('Manage component properties and variants');

const propCmd = componentCmd
  .command('prop')
  .description('Manage component properties (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT)');

propCmd
  .command('add <componentId> <name> <type> <defaultValue>')
  .description('Add a property. Type: boolean | text | instance-swap | variant')
  .option('-o, --options <opts>', 'Comma-separated VARIANT options (e.g. "Small,Medium,Large")')
  .action(async (componentId, name, type, defaultValue, options) => {
    await checkConnection();
    const typeMap = { boolean: 'BOOLEAN', text: 'TEXT', 'instance-swap': 'INSTANCE_SWAP', variant: 'VARIANT' };
    const apiType = typeMap[type.toLowerCase()] || type.toUpperCase();
    if (!['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT'].includes(apiType)) {
      console.error(chalk.red('✗'), `Invalid type "${type}". Use: boolean, text, instance-swap, variant`);
      process.exit(1);
    }
    let parsedDefault = defaultValue;
    if (apiType === 'BOOLEAN') parsedDefault = defaultValue === 'true' || defaultValue === '1';
    if (apiType === 'VARIANT') {
      console.error(chalk.red('✗'), 'VARIANT properties cannot be added directly. Create variants by:');
      console.error('  1. Render multiple components (one per variant)');
      console.error('  2. Convert each: figma-cli node to-component <id>');
      console.error('  3. Combine: figma-cli component combine <id1,id2,id3> --name "MyComponent"');
      process.exit(1);
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(componentId)});
      if (!n) throw new Error('Node not found: ${componentId}');
      if (typeof n.addComponentProperty !== 'function') throw new Error('Node is not a component or component set');
      const propName = n.addComponentProperty(${JSON.stringify(name)}, ${JSON.stringify(apiType)}, ${JSON.stringify(parsedDefault)});
      return { id: n.id, name: n.name, propName };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Added property "${r.propName}" on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

propCmd
  .command('list [componentId]')
  .description('List component properties on a component (or current selection)')
  .action(async (componentId) => {
    await checkConnection();
    const target = componentId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(componentId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('componentPropertyDefinitions' in n)) throw new Error('Node has no component properties');
      return { id: n.id, name: n.name, props: n.componentPropertyDefinitions };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      const entries = Object.entries(r.props || {});
      if (entries.length === 0) {
        console.log(chalk.gray('  (no component properties)'));
        return;
      }
      entries.forEach(([propName, def]) => {
        const tail = def.type === 'VARIANT' && Array.isArray(def.variantOptions)
          ? ` [${def.variantOptions.join(', ')}]`
          : '';
        console.log(`  ${propName}  ${chalk.gray(def.type)}  default=${JSON.stringify(def.defaultValue)}${tail}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

propCmd
  .command('delete <componentId> <propName>')
  .description('Delete a component property (use full name including #suffix)')
  .action(async (componentId, propName) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(componentId)});
      if (!n) throw new Error('Node not found: ${componentId}');
      if (typeof n.deleteComponentProperty !== 'function') throw new Error('Node is not a component or component set');
      n.deleteComponentProperty(${JSON.stringify(propName)});
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Deleted "${propName}" on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

componentCmd
  .command('combine <ids>')
  .description('Combine components (comma-separated IDs) into a single variant set')
  .option('-n, --name <name>', 'Name for the resulting component set', 'ComponentSet')
  .action(async (ids, options) => {
    await checkConnection();
    const idArr = ids.split(',').map(s => s.trim());
    const code = `(async () => {
      const components = [];
      for (const id of ${JSON.stringify(idArr)}) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        if (n.type !== 'COMPONENT') throw new Error('Not a component: ' + id + ' (type=' + n.type + ')');
        components.push(n);
      }
      const set = figma.combineAsVariants(components, figma.currentPage);
      set.name = ${JSON.stringify(options.name)};
      return { id: set.id, name: set.name, count: components.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Combined ${r.count} components into "${r.name}" (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ ANNOTATIONS ============
// Inline notes / specs on Figma nodes (tokens, usage rules, etc.)

const annotateCmd = program
  .command('annotate')
  .description('Manage annotations (inline notes) on nodes');

annotateCmd
  .command('add')
  .description('Add an annotation. Pass --node <id> for one, or --query <pattern> for all matches.')
  .argument('<text>', 'Annotation text (or markdown if --markdown)')
  .option('-m, --markdown', 'Treat text as markdown')
  .option('-n, --node <id>', 'Node ID to annotate')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern> (case-insensitive)')
  .action(async (text, options) => {
    await checkConnection();
    if (!options.node && !options.query) {
      console.error(chalk.red('✗'), 'Provide either --node <id> or --query <pattern>');
      process.exit(1);
    }
    const labelKey = options.markdown ? 'labelMarkdown' : 'label';
    const targetSelector = options.query
      ? `(figma.currentPage.findAll(n => 'annotations' in n && typeof n.name === 'string' && n.name.toLowerCase().includes(${JSON.stringify(options.query.toLowerCase())})))`
      : `[await figma.getNodeByIdAsync(${JSON.stringify(options.node)})].filter(Boolean)`;
    const code = `(async () => {
      const nodes = ${targetSelector};
      if (nodes.length === 0) throw new Error(${options.query ? `'No nodes matched query: ${options.query}'` : `'Node not found: ${options.node}'`});
      const results = [];
      for (const n of nodes) {
        if (!('annotations' in n)) continue;
        const existing = (n.annotations || []).map(a => {
          const c = {};
          if (a.labelMarkdown) c.labelMarkdown = a.labelMarkdown;
          else if (a.label) c.label = a.label;
          if (a.categoryId) c.categoryId = a.categoryId;
          if (a.properties) c.properties = a.properties;
          return c;
        });
        n.annotations = [...existing, { ${labelKey}: ${JSON.stringify(text)} }];
        results.push({ id: n.id, name: n.name });
      }
      return results;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Annotated ${r.length} node(s):`);
      r.forEach(n => console.log(chalk.gray(`  ${n.name} (${n.id})`)));
    } catch (e) {
      handleEvalError(e);
    }
  });

annotateCmd
  .command('list [nodeId]')
  .description('List annotations on a node (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('annotations' in n)) throw new Error('Node does not support annotations');
      return { id: n.id, name: n.name, annotations: n.annotations || [] };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.annotations || r.annotations.length === 0) {
        console.log(chalk.gray('  (no annotations)'));
        return;
      }
      r.annotations.forEach((a, i) => {
        const label = a.label || a.labelMarkdown || '(empty)';
        console.log(`  ${i + 1}. ${label}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

annotateCmd
  .command('clear <nodeId>')
  .description('Remove all annotations from a node')
  .action(async (nodeId) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('annotations' in n)) throw new Error('Node does not support annotations');
      n.annotations = [];
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Cleared annotations on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ PLUGINS ============

import { listPlugins, installPlugin, uninstallPlugin, setupPlugin, loadPlugins } from './plugins.js';

const plugins = program
  .command('plugins')
  .description('Manage plugins (voice, etc.)');

plugins
  .command('list')
  .description('List available plugins')
  .action(() => listPlugins());

// Default action when just "figma-cli plugins" is typed
plugins.action(() => listPlugins());

plugins
  .command('install <name>')
  .description('Install a plugin')
  .action(async (name) => { await installPlugin(name); });

plugins
  .command('uninstall <name>')
  .description('Uninstall a plugin')
  .action((name) => uninstallPlugin(name));

plugins
  .command('setup <name>')
  .description('Set up API keys for a plugin (run in regular Terminal, not AI chat)')
  .action(async (name) => { await setupPlugin(name); });

// Load installed plugin commands
try {
  loadPlugins(program, { daemonExec, checkConnection, getDaemonToken });
} catch {}

// === API docs (offline Figma Plugin API reference) ===
const apiCmd = program
  .command('api [name]')
  .description('Look up Figma Plugin API interface or type (offline). Run `api setup` first.')
  .action((name) => apiDocs.show(name));

apiCmd
  .command('setup')
  .description('Download Figma Plugin API docs locally (~5 MB, one-time). Use --update to pull the latest version instead of re-cloning.')
  .option('--update', 'git pull the docs repo instead of re-cloning (faster, keeps the dir)')
  .action((options) => apiDocs.setup({ update: !!options.update }));

apiCmd
  .command('index')
  .description('Build/refresh the compact "what APIs exist" index (~5 KB). LLM-friendly first-fetch handle.')
  .action(() => apiDocs.buildIndex());

apiCmd
  .command('context [topic]')
  .description('Print an LLM-ready context block. Without topic: the compact index. With topic: index + relevant interface bodies.')
  .action((topic) => {
    process.stdout.write(apiDocs.getContext(topic || ''));
  });

apiCmd
  .command('age')
  .description('Days since the docs repo was last updated. Used by figmachat to decide auto-refresh.')
  .action(() => {
    const days = apiDocs.ageInDays();
    if (days === Infinity) {
      console.log('not installed');
      process.exit(1);
    }
    console.log(days.toFixed(1));
  });

apiCmd
  .command('list [filter]')
  .description('List all interfaces and types (optional substring filter)')
  .action((filter) => apiDocs.list(filter));

apiCmd
  .command('gap')
  .description('Show Figma Plugin API capabilities not yet exposed by figma-cli')
  .action(() => apiDocs.gap());

apiCmd
  .command('search <keyword>')
  .description('Find Plugin API methods/properties whose name contains <keyword> (e.g. "scale", "resize")')
  .option('--json', 'Output as JSON (used by figmachat for the auto-fallback)')
  .option('-l, --limit <n>', 'Max results', '8')
  .action((keyword, options) => {
    const results = apiDocs.searchMethods(keyword);
    if (results.length === 0) {
      if (options.json) {
        console.log('[]');
      } else {
        console.error(`No Plugin API method matching "${keyword}".`);
      }
      return;
    }
    const top = results.slice(0, parseInt(options.limit) || 8);
    if (options.json) {
      console.log(JSON.stringify(top.map(r => ({
        method: r.method, signature: r.signature, interface: r.interface
      })), null, 2));
      return;
    }
    console.log(`Top Plugin API matches for "${keyword}":\n`);
    for (const r of top) {
      console.log(`  ${chalk.cyan(r.method)}  ${chalk.dim('on ' + r.interface)}`);
      if (r.signature) console.log(`    ${chalk.gray(r.signature)}`);
    }
    console.log('\nTip: use these inside a `figma-cli eval "..."` call when no subcommand fits.');
  });

// (Unknown-command handling lives inside the default program.action)
program.parse();
