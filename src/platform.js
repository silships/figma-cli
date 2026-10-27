/**
 * Platform-specific helpers.
 * Only defines functions for the current platform — no Windows code loaded on Mac, etc.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const PLATFORM = process.platform;

// --- Null device ---
export const nullDevice = PLATFORM === 'win32' ? 'NUL' : '/dev/null';

// --- Port cleanup ---
function killPortUnix(port) {
  const portCheck = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' });
  if (portCheck.trim()) {
    try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' }); } catch {}
    try { execSync('sleep 0.3', { stdio: 'pipe' }); } catch {}
  }
}

function killPortWindows(port) {
  try {
    const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = result.split('\n').filter(l => l.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) {
        execSync(`taskkill /PID ${pid} /F 2>nul`, { stdio: 'pipe' });
      }
    }
    try { execSync('ping -n 1 127.0.0.1 >nul', { stdio: 'pipe' }); } catch {}
  } catch {}
}

export const killPort = PLATFORM === 'win32' ? killPortWindows : killPortUnix;

// --- Get PID listening on port ---
function getPortPidUnix(port) {
  return execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' }).trim() || null;
}

function getPortPidWindows(port) {
  const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
  const line = result.split('\n').find(l => l.includes('LISTENING'));
  if (line) {
    const parts = line.trim().split(/\s+/);
    return parts[parts.length - 1] || null;
  }
  return null;
}

export const getPortPid = PLATFORM === 'win32' ? getPortPidWindows : getPortPidUnix;

// --- Sleep after daemon stop ---
export function sleepAfterStop() {
  if (PLATFORM === 'win32') {
    try { execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'pipe' }); } catch {}
  } else {
    try { execSync('sleep 0.5', { stdio: 'pipe' }); } catch {}
  }
}

// --- Start Figma ---
export function startFigmaApp(figmaPath, port) {
  if (PLATFORM === 'darwin') {
    execSync(`open -a Figma --args --remote-debugging-port=${port}`, { stdio: 'pipe' });
  } else {
    spawn(figmaPath, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// --- Browser Mode (drive Figma via CDP in a normal browser) ---
//
// Browser Mode is the "never touch the local app" alternative to the Yolo
// patch. Instead of modifying Figma Desktop's app.asar to re-enable the
// remote-debugging port, we launch a Chromium-based browser the user already
// has, with remote debugging turned on. The existing CDP client (figma-client.js)
// then discovers the figma.com design tab and drives it exactly as it would the
// desktop app — same Runtime.evaluate path, no binary modification.
//
// We use a dedicated persistent profile dir so (a) the user's Figma login
// survives across sessions and (b) their everyday browser profile is left
// untouched (Chrome refuses --remote-debugging-port on an already-running
// default profile, so a separate profile is required anyway).

const MAC_BROWSERS = [
  { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
];

function detectBrowserMac() {
  for (const b of MAC_BROWSERS) if (existsSync(b.path)) return b;
  return null;
}

function detectBrowserWindows() {
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA || '';
  const candidates = [
    ['Google Chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Google Chrome', join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Google Chrome', lad && join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Microsoft Edge', join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Brave', join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
  ];
  for (const [name, p] of candidates) if (p && existsSync(p)) return { name, path: p };
  return null;
}

function detectBrowserLinux() {
  const candidates = [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome', 'google-chrome-stable'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Brave', 'brave-browser']
  ];
  for (const [name, bin] of candidates) {
    try {
      const p = execSync(`command -v ${bin} 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (p) return { name, path: p };
    } catch {}
  }
  return null;
}

// Detect an installed Chromium-family browser, or null if none is found.
export function detectBrowser() {
  if (PLATFORM === 'darwin') return detectBrowserMac();
  if (PLATFORM === 'win32') return detectBrowserWindows();
  return detectBrowserLinux();
}

// The remote-debugging flags shared by the launcher and the printed command.
// Kept as an ordered array so the exact invocation is deterministic + testable.
// --remote-allow-origins=* is required for CDP WebSocket connects on Chrome 111+.
export function browserDebugArgs(port = 9222, profileDir, url = 'https://www.figma.com') {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url
  ];
}

// Launch the browser with remote debugging enabled (detached).
export function startBrowserApp(browserPath, port, profileDir, url = 'https://www.figma.com') {
  const args = browserDebugArgs(port, profileDir, url);
  spawn(browserPath, args, { detached: true, stdio: 'ignore' }).unref();
}

// A copy-pasteable launch command for the setup instructions. Quotes any
// argument containing whitespace so it survives a shell paste.
export function getBrowserCommand(port = 9222, profileDir, url = 'https://www.figma.com') {
  const browser = detectBrowser();
  const bin = browser ? browser.path : (PLATFORM === 'win32' ? 'chrome.exe' : 'google-chrome');
  const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return [bin, ...browserDebugArgs(port, profileDir, url)].map(quote).join(' ');
}

// --- Kill Figma ---
export function killFigmaApp() {
  try {
    if (PLATFORM === 'darwin') {
      execSync('pkill -x Figma 2>/dev/null || true', { stdio: 'pipe' });
    } else if (PLATFORM === 'win32') {
      execSync('taskkill /IM Figma.exe /F 2>nul', { stdio: 'pipe' });
    } else {
      execSync('pkill -x figma 2>/dev/null || true', { stdio: 'pipe' });
    }
  } catch {}
}

// --- Figma paths (asar, binary, command) ---

// Windows-only helpers (only defined on Windows)
let findWindowsFigmaPath, findWindowsFigmaExe;

// Newest first, numerically: a plain sort ranks app-126.9.16 above app-126.10.13
const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

if (PLATFORM === 'win32') {
  findWindowsFigmaPath = function() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;

    const figmaBase = join(localAppData, 'Figma');
    if (!existsSync(figmaBase)) return null;

    try {
      const entries = readdirSync(figmaBase);
      const appFolders = entries
        .filter(e => e.startsWith('app-'))
        .sort(byVersionDesc);

      for (const folder of appFolders) {
        const asarPath = join(figmaBase, folder, 'resources', 'app.asar');
        if (existsSync(asarPath)) return asarPath;
      }

      const oldPath = join(figmaBase, 'resources', 'app.asar');
      if (existsSync(oldPath)) return oldPath;
    } catch {}

    return null;
  };

  findWindowsFigmaExe = function() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;

    const figmaBase = join(localAppData, 'Figma');
    const mainExe = join(figmaBase, 'Figma.exe');
    if (existsSync(mainExe)) return mainExe;

    try {
      const entries = readdirSync(figmaBase);
      const appFolders = entries
        .filter(e => e.startsWith('app-'))
        .sort(byVersionDesc);

      for (const folder of appFolders) {
        const exePath = join(figmaBase, folder, 'Figma.exe');
        if (existsSync(exePath)) return exePath;
      }
    } catch {}

    return null;
  };
}

const ASAR_PATHS = {
  darwin: '/Applications/Figma.app/Contents/Resources/app.asar',
  linux: '/opt/figma/resources/app.asar'
};

export function getAsarPath() {
  if (PLATFORM === 'win32') return findWindowsFigmaPath();
  return ASAR_PATHS[PLATFORM] || null;
}

export function getFigmaBinaryPath() {
  switch (PLATFORM) {
    case 'darwin':
      return '/Applications/Figma.app/Contents/MacOS/Figma';
    case 'win32':
      return findWindowsFigmaExe() || `${process.env.LOCALAPPDATA}\\Figma\\Figma.exe`;
    case 'linux':
      return '/usr/bin/figma';
    default:
      return null;
  }
}

export function getFigmaCommand(port = 9222) {
  switch (PLATFORM) {
    case 'darwin':
      return `open -a Figma --args --remote-debugging-port=${port}`;
    case 'win32': {
      const exePath = findWindowsFigmaExe();
      if (exePath) return `"${exePath}" --remote-debugging-port=${port}`;
      return `"%LOCALAPPDATA%\\Figma\\Figma.exe" --remote-debugging-port=${port}`;
    }
    case 'linux':
      return `figma --remote-debugging-port=${port}`;
    default:
      return null;
  }
}

// --- Doctor helpers ---
export function getFigmaVersion() {
  if (PLATFORM === 'darwin') {
    return execSync('defaults read /Applications/Figma.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null', { encoding: 'utf8' }).trim();
  } else if (PLATFORM === 'win32') {
    return execSync('powershell -command "(Get-Item \\"$env:LOCALAPPDATA\\Figma\\Figma.exe\\").VersionInfo.ProductVersion" 2>nul', { encoding: 'utf8' }).trim() || 'unknown';
  }
  return 'unknown';
}

export function isFigmaRunning() {
  if (PLATFORM === 'darwin' || PLATFORM === 'linux') {
    const ps = execSync('pgrep -f Figma 2>/dev/null || true', { encoding: 'utf8' });
    return ps.trim().length > 0;
  } else if (PLATFORM === 'win32') {
    const ps = execSync('tasklist /FI "IMAGENAME eq Figma.exe" 2>nul', { encoding: 'utf8' });
    return ps.includes('Figma.exe');
  }
  return false;
}

export const platformName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[PLATFORM] || PLATFORM;
