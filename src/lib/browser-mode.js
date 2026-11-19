// Browser Mode helpers: keep the debug browser, the last open file and the
// Figma font agent ready, so a user never has to set anything up twice.
//
// - The debug browser uses its own persistent profile, so the Figma login
//   survives closing the window.
// - The last file the user worked on is remembered and reopened.
// - Local fonts in the browser need Figma's font agent (port 44950). The
//   Figma desktop app ships it; without the app it has to be installed once.
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { detectBrowser, startBrowserApp } from '../platform.js';

export const FONT_AGENT_PORT = 44950;

// Which mode a bare `figma-cli connect` uses. Browser Mode is the default.
// Someone who already connected the Figma Desktop app (Yolo) keeps it, so an
// update never swaps their Figma app for a Chrome window.
export function pickConnectMode(options = {}, config = {}) {
  if (options.safe) return 'safe';
  if (options.desktop || options.yolo) return 'yolo';
  if (options.browser) return 'browser';
  if (config.patched && !config.browser) return 'yolo';
  return 'browser';
}
export const FONT_AGENT_INSTALLERS = {
  darwin: 'https://desktop.figma.com/agent/mac/InstallFigmaAgent.dmg',
  win32: 'https://desktop.figma.com/agent/win/InstallFigmaAgent.exe',
};

const FILE_RE = /figma\.com\/(design|file|slides)\//;
const DESIGN_RE = /figma\.com\/(design|file)\//;

export function isFigmaFileUrl(url) {
  return typeof url === 'string' && FILE_RE.test(url);
}

// Keep the file path (key + name), drop node-id and other query state so the
// file reopens on the canvas instead of a stale selection.
export function cleanFileUrl(url) {
  if (!isFigmaFileUrl(url)) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

// Design files first (same order as FigmaClient.connect), then Slides.
export function pickFileTab(pages = []) {
  const withUrl = pages.filter(p => p && typeof p.url === 'string' && (!p.type || p.type === 'page'));
  return withUrl.find(p => DESIGN_RE.test(p.url)) || withUrl.find(p => FILE_RE.test(p.url)) || null;
}

// Signed out: Figma shows /login, /signup or the marketing home (a signed-in
// user is redirected from figma.com/ to /files).
export function isLoginUrl(url) {
  if (typeof url !== 'string') return false;
  if (/figma\.com\/(login|signup)/.test(url)) return true;
  try {
    const u = new URL(url);
    return /(^|\.)figma\.com$/.test(u.hostname) && u.pathname === '/';
  } catch {
    return false;
  }
}

async function fetchJson(url, { timeoutMs = 1500, headers = {}, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, method });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// State of the debug browser on the CDP port.
export async function probeBrowserCdp(port) {
  try {
    const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
    const fileTab = pickFileTab(pages);
    const figmaTabs = pages.filter(p => p.url && p.url.includes('figma.com'));
    return {
      up: true,
      fileTab: fileTab ? fileTab.url : null,
      figmaTab: figmaTabs.length > 0,
      loginTab: figmaTabs.some(p => isLoginUrl(p.url)),
    };
  } catch {
    return { up: false, fileTab: null, figmaTab: false, loginTab: false };
  }
}

// Run one expression in a tab's page context. Resolves null on any failure.
export function evalInTab(wsUrl, expression, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })));
    ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.id === 1) finish(m.result?.result?.value ?? null); } catch { finish(null); } });
    ws.on('error', () => finish(null));
  });
}

// When the Figma desktop app is installed, figma.com hands a file off to it
// and shows "Opened … in Figma app / Open here instead". Click that link so
// the file loads in the browser. Returns 'loaded', 'handoff' or 'loading'.
const TAB_STATE_JS = `(() => {
  const link = document.querySelector('[class*="desktop_app_interstitial--link"]');
  if (link) { link.click(); return 'handoff'; }
  // The file browser also titles itself "… – Figma": require the editor canvas.
  const editor = !!document.querySelector('canvas') && ['design', 'file', 'slides'].includes(location.pathname.split('/')[1]);
  return editor && / – Figma$| - Figma$/.test(document.title) ? 'loaded:' + performance.timeOrigin : 'loading';
})()`;

export async function settleFileTab(port, { waitMs = 30000, stable = true } = {}) {
  const start = Date.now();
  let handedOff = false;
  let lastLoaded = null;
  while (Date.now() - start < waitMs) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
      const tab = pickFileTab(pages);
      if (tab) {
        const st = await evalInTab(tab.webSocketDebuggerUrl, TAB_STATE_JS);
        if (st === 'handoff') handedOff = true;
        // Figma may hard-reload the tab right after an in-app route. Ready
        // only when the same document reports loaded on two polls in a row.
        if (typeof st === 'string' && st.startsWith('loaded:')) {
          if (!stable || st === lastLoaded) return { loaded: true, url: tab.url, handedOff };
          lastLoaded = st;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        lastLoaded = null;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return { loaded: false, url: null, handedOff };
}

// Opening a file URL directly makes figma.com hand the file to the desktop
// app (when installed), which then pops the file open there too. Loading the
// file browser first and routing to the file inside the web app does not.
export const FIGMA_HOME = 'https://www.figma.com/files/recents-and-sharing';

const routeJs = (path) => `(() => {
  if (!/ – Figma$| - Figma$/.test(document.title)) return 'wait';
  history.pushState({}, '', ${JSON.stringify(path)});
  dispatchEvent(new PopStateEvent('popstate'));
  return 'routed';
})()`;

export async function routeToFile(port, fileUrl, { waitMs = 20000 } = {}) {
  const path = new URL(fileUrl).pathname;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
      if (pickFileTab(pages)) return true;
      const home = pages.find(p => p.type === 'page' && /figma\.com\/files/.test(p.url || ''));
      if (home && (await evalInTab(home.webSocketDebuggerUrl, routeJs(path))) === 'routed') return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// While figma-cli waits, the designer looks at the browser, not the terminal
// (an agent shows no output until the command ends). Pin the next step on top
// of the Figma page itself. Idempotent: a navigation drops the banner and the
// next poll puts it back.
export function hintText(url) {
  return isLoginUrl(url)
    ? 'figma-cli: Sign in to Figma, then open a design file. figma-cli connects by itself'
    : 'figma-cli: Open a design file or create a new one. figma-cli connects by itself';
}

const hintJs = (text) => `(() => {
  let el = document.getElementById('figma-cli-hint');
  if (!el) {
    if (!document.body) return false;
    el = document.createElement('div');
    el.id = 'figma-cli-hint';
    document.body.appendChild(el);
  }
  // Bottom center: the top bar holds Figma's "new design file" button.
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0d99ff;color:#fff;font:600 15px/1.4 Inter,system-ui,sans-serif;padding:12px 20px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;max-width:90vw;text-align:center';
  el.textContent = ${JSON.stringify(text)};
  return true;
})()`;

export async function showWaitHint(port) {
  try {
    const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
    const tabs = pages.filter(p => p.type === 'page' && /figma\.com/.test(p.url || '') && !isFigmaFileUrl(p.url));
    await Promise.all(tabs.map(t => evalInTab(t.webSocketDebuggerUrl, hintJs(hintText(t.url)), 1500)));
  } catch {}
}

// Figma routes into a file without a page load, so the banner would stay.
export async function clearWaitHint(port) {
  try {
    const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
    const tabs = pages.filter(p => p.type === 'page' && /figma\.com/.test(p.url || ''));
    await Promise.all(tabs.map(t => evalInTab(t.webSocketDebuggerUrl, "document.getElementById('figma-cli-hint')?.remove()", 1500)));
  } catch {}
}

// Open a URL as a new tab in an already running debug browser.
async function openTab(port, url) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure the debug browser runs with a Figma file open.
 * Starts the browser (or opens a tab) with the last used file when needed.
 * Returns { ready, url, launched, needsLogin }.
 */
export async function ensureBrowserReady({ port, profileDir, lastUrl, waitMs = 30000, onLaunch, launch = true } = {}) {
  const settled = async (launched) => {
    await clearWaitHint(port);
    // Only a fresh launch can still be mid-reload; an open file is stable.
    const s = await settleFileTab(port, { waitMs, stable: launched });
    return s.loaded
      ? { ready: true, url: s.url, launched, needsLogin: false, handedOff: s.handedOff }
      : { ready: false, url: null, launched, needsLogin: false };
  };
  let state = await probeBrowserCdp(port);
  if (state.fileTab) return settled(false);

  const target = lastUrl ? FIGMA_HOME : 'https://www.figma.com';
  let launched = false;
  if (!launch) {
    // Only wait: the user is signing in or opening a file by hand.
  } else if (state.up) {
    // Browser runs but no file is open: reopen the last one.
    if (lastUrl && !state.loginTab) launched = await openTab(port, FIGMA_HOME);
  } else {
    const browser = detectBrowser();
    if (!browser) return { ready: false, url: null, launched: false, needsLogin: false, noBrowser: true };
    if (onLaunch) onLaunch(browser);
    try { seedProfilePermissions(profileDir); } catch {}
    startBrowserApp(browser.path, port, profileDir, target);
    launched = true;
  }
  if (launch && !launched && !lastUrl) return { ready: false, url: null, launched: false, needsLogin: state.loginTab };
  // Fallback when routing fails (e.g. Figma changed its file browser): open
  // the file directly; settleFileTab then clicks "Open here instead".
  if (launched && lastUrl && !(await routeToFile(port, lastUrl, { waitMs: Math.min(waitMs, 20000) }))) {
    const st = await probeBrowserCdp(port);
    if (!st.loginTab) await openTab(port, lastUrl);
  }

  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    state = await probeBrowserCdp(port);
    if (state.fileTab) return settled(launched);
    // Waiting on the designer: show the next step in the browser (every 2s).
    if (!launch && polls++ % 4 === 0) await showWaitHint(port);
    if (launch && state.loginTab) return { ready: false, url: null, launched, needsLogin: true };
  }
  return { ready: false, url: null, launched, needsLogin: state.loginTab };
}

// Figma's font agent answers on 127.0.0.1:44950 for figma.com origins.
export async function fontAgentStatus(port = FONT_AGENT_PORT) {
  try {
    const body = await fetchJson(`http://127.0.0.1:${port}/figma/version`, {
      timeoutMs: 1500,
      headers: { Origin: 'https://www.figma.com' },
    });
    return { running: true, version: body.version ?? null, package: body.package ?? null };
  } catch {
    return { running: false };
  }
}

/**
 * Install Figma's font agent with Figma's own installer.
 * macOS: download the DMG, copy "Install Figma Agent.app" out, open it.
 * Windows: download the EXE and run it. Linux: not supported by Figma.
 * Resolves once the agent answers or the wait runs out.
 */
export async function installFontAgent({ dir, platform = process.platform, waitMs = 120000, port = FONT_AGENT_PORT } = {}) {
  const url = FONT_AGENT_INSTALLERS[platform];
  if (!url) return { installed: false, reason: 'unsupported' };
  mkdirSync(dir, { recursive: true });

  const res = await fetch(url);
  if (!res.ok) return { installed: false, reason: `download failed (${res.status})` };
  const file = join(dir, platform === 'darwin' ? 'InstallFigmaAgent.dmg' : 'InstallFigmaAgent.exe');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  if (platform === 'darwin') {
    const mnt = join(dir, 'mnt');
    const app = join(dir, 'Install Figma Agent.app');
    rmSync(app, { recursive: true, force: true });
    execSync(`hdiutil attach -nobrowse -readonly -mountpoint "${mnt}" "${file}"`, { stdio: 'pipe' });
    try {
      cpSync(join(mnt, 'Install Figma Agent.app'), app, { recursive: true });
    } finally {
      try { execSync(`hdiutil detach "${mnt}"`, { stdio: 'pipe' }); } catch {}
    }
    execSync(`open "${app}"`, { stdio: 'pipe' });
  } else {
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  }

  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await fontAgentStatus(port);
    if (s.running) return { installed: true, version: s.version };
  }
  return { installed: false, reason: 'timeout' };
}

// Chrome asks before a site may reach localhost ("Local network access").
// Figma needs that for the font agent and shows its own dialog first. Allow
// it for figma.com in OUR debug profile only, so the dialog never appears.
// Chrome stores the grant as content setting `loopback_network` (seen in
// Chrome 157). Only write while the browser is closed: Chrome rewrites
// Preferences from memory and would drop the change.
export const FIGMA_ORIGIN_PATTERN = 'https://www.figma.com:443,*';

export function seedProfilePermissions(profileDir) {
  const dir = join(profileDir, 'Default');
  const file = join(dir, 'Preferences');
  let prefs = {};
  try { if (existsSync(file)) prefs = JSON.parse(readFileSync(file, 'utf8')); } catch { prefs = {}; }
  const ex = (((prefs.profile ||= {}).content_settings ||= {}).exceptions ||= {});
  const loop = (ex.loopback_network ||= {});
  if (loop[FIGMA_ORIGIN_PATTERN]?.setting === 1) return false;
  loop[FIGMA_ORIGIN_PATTERN] = { last_modified: '0', setting: 1 };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
  return true;
}

export function hasProfile(profileDir) {
  return existsSync(join(profileDir, 'Default'));
}
