#!/usr/bin/env node
/**
 * Figma CLI — Web UI
 *
 * Streams the full claude session to the browser — tool calls, thinking, everything.
 * Uses `claude -p --output-format stream-json --verbose` which streams all events
 * without needing a PTY. Sessions continue via `--resume SESSION_ID`.
 *
 * Flow:
 *   browser → SSE POST /chat → claude -p prompt --output-format stream-json [--resume id]
 *          ← streaming events (tool calls, text, results) ←
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';


const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR     = join(__dirname, '..');
const DEFAULT_PORT = 3700;
const CDP_PORT     = 9222;
const DAEMON_PORT  = 3456;
const ACTIVE_FILE  = join(homedir(), '.figma-ds-cli', 'active-file.json');
const TOKEN_FILE   = join(homedir(), '.figma-ds-cli', '.daemon-token');

const SRC = join(__dirname);
const read = (f) => readFileSync(join(SRC, f), 'utf8');

// ── Figma file helpers ─────────────────────────────────────────────────────────

function cleanTitle(t) {
  return (t || '').replace(/\s*[–-]\s*Figma\s*$/, '').trim();
}

async function getFigmaFiles() {
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) });
    const pages = await r.json();
    return pages
      .filter(p => p.url && (p.url.includes('/design/') || p.url.includes('/board/')))
      .map(p => ({ title: cleanTitle(p.title), id: p.id, url: p.url }));
  } catch {
    return [];
  }
}

function readActiveFile() {
  try { return JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')); }
  catch { return { mode: 'auto' }; }
}

function getDaemonToken() {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch { return null; }
}

async function daemonEval(code) {
  const token = getDaemonToken();
  if (!token) throw new Error('No daemon token');
  const r = await fetch(`http://localhost:${DAEMON_PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': token },
    body: JSON.stringify({ action: 'eval', code }),
    signal: AbortSignal.timeout(2000),
  });
  return r.json();
}

async function daemonHealth() {
  const token = getDaemonToken();
  if (!token) return null;
  try {
    const r = await fetch(`http://localhost:${DAEMON_PORT}/health`, {
      headers: { 'X-Daemon-Token': token },
      signal: AbortSignal.timeout(2000),
    });
    return r.json();
  } catch { return null; }
}

async function daemonReconnect() {
  const token = getDaemonToken();
  if (!token) return;
  await fetch(`http://localhost:${DAEMON_PORT}/reconnect`, {
    headers: { 'X-Daemon-Token': token },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(read('web-ui.html'));
    return;
  }

  if (url.pathname === '/web-ui.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(read('web-ui.css'));
    return;
  }

  if (url.pathname === '/web-ui.client.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(read('web-ui.client.js'));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    const file = join(REPO_DIR, url.pathname);
    const ext = extname(file);
    const mime = { '.avif': 'image/avif', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext] ?? 'application/octet-stream';
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // ── /debug — show what daemon is actually connected to ──
  if (url.pathname === '/debug' && req.method === 'GET') {
    const [health, files] = await Promise.all([daemonHealth(), getFigmaFiles()]);
    let daemonFile = null;
    try {
      const data = await daemonEval('return figma.root.name');
      daemonFile = cleanTitle(data.result ?? null);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeFile: readActiveFile(),
      daemonHealth: health,
      daemonConnectedTo: daemonFile,
      openFigmaFiles: files,
    }, null, 2));
    return;
  }

  // ── /files — list all open Figma design files via CDP ──
  if (url.pathname === '/files' && req.method === 'GET') {
    const files = await getFigmaFiles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // ── /figma-info — active file name ──
  if (url.pathname === '/figma-info' && req.method === 'GET') {
    try {
      const active = readActiveFile();

      if (active.mode === 'locked' && active.title) {
        // Locked mode: use stored title directly
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: active.title, mode: 'locked' }));
        return;
      }

      // Auto mode: query CDP directly for open files
      const files = await getFigmaFiles();
      if (files.length === 1) {
        // Only one file open — it must be the active one
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: files[0].title, mode: 'auto' }));
        return;
      }
      if (files.length > 1) {
        // Multiple files: ask daemon which tab it's connected to
        const data = await daemonEval('return figma.root.name');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: cleanTitle(data.result) ?? null, mode: 'auto' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: null, mode: 'auto' }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: null, mode: 'auto' }));
    }
    return;
  }

  // ── /switch — change active Figma file ──
  if (url.pathname === '/switch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { mode, title, url: fileUrl, id } = JSON.parse(body);
        mkdirSync(join(homedir(), '.figma-ds-cli'), { recursive: true });

        if (mode === 'auto') {
          writeFileSync(ACTIVE_FILE, JSON.stringify({ mode: 'auto' }, null, 2));
        } else {
          writeFileSync(ACTIVE_FILE, JSON.stringify({ mode: 'locked', title, url: fileUrl, id }, null, 2));
        }

        // Check daemon mode before attempting reconnect
        const health = await daemonHealth();
        const daemonMode = health?.mode ?? 'disconnected';

        let connectedName = null;
        let safeMode = false;

        if (daemonMode === 'safe') {
          // Safe Mode: plugin is bound to its file, can't switch remotely
          safeMode = true;
          try {
            const data = await daemonEval('return figma.root.name');
            connectedName = cleanTitle(data.result ?? null);
          } catch {}
        } else if (daemonMode === 'yolo') {
          // Yolo Mode: reconnect CDP to the newly selected file
          await daemonReconnect();
          try {
            const data = await daemonEval('return figma.root.name');
            connectedName = cleanTitle(data.result ?? null);
            safeMode = !!title && connectedName !== title;
          } catch {}
        }
        // If disconnected: active-file.json is written, CLI will use it on next connect

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !safeMode,
          connected: connectedName,
          daemonMode,
          safeMode,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      let prompt, sessionId, imageBase64, imageMimeType;
      try { ({ prompt, sessionId, imageBase64, imageMimeType } = JSON.parse(body)); }
      catch { sse({ t: 'err', v: 'Bad request' }); res.end(); return; }

      // When an image is attached, use --input-format stream-json to send multimodal content.
      // Otherwise use the simpler -p text mode.
      let args, stdinData;
      if (imageBase64) {
        args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
        if (sessionId) args.push('--resume', sessionId);
        stdinData = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: imageMimeType || 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          },
        }) + '\n';
      } else {
        args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
        if (sessionId) args.push('--resume', sessionId);
      }

      const claude = spawn('claude', args, {
        cwd: REPO_DIR,
        env: { ...process.env },
        stdio: stdinData ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });

      if (stdinData) {
        claude.stdin.write(stdinData);
        claude.stdin.end();
      }

      let lineBuf = '';

      function processLine(line) {
        line = line.trim();
        if (!line) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }

        // Session ID (for multi-turn --resume)
        if (evt.session_id && !sessionId) {
          sessionId = evt.session_id;
          sse({ t: 'sid', v: evt.session_id });
        }
        if (evt.type === 'result' && evt.session_id) {
          sse({ t: 'sid', v: evt.session_id });
        }

        // Assistant text or tool use
        if (evt.type === 'assistant') {
          for (const block of evt.message?.content || []) {
            if (block.type === 'text' && block.text) {
              sse({ t: 'text', v: block.text });
            }
            if (block.type === 'tool_use') {
              sse({ t: 'tool', name: block.name, input: block.input });
            }
          }
        }

        // Tool result
        if (evt.type === 'tool_result') {
          const content = Array.isArray(evt.content) ? evt.content : [];
          const text = content.map(c => c.text || '').join('').trim();
          sse({ t: 'result', v: text.slice(0, 300) || 'done', err: !!evt.is_error });
        }
      }

      claude.stdout.on('data', (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) processLine(line);
      });

      claude.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text && !text.startsWith('Loaded') && !text.startsWith('API')) {
          sse({ t: 'text', v: text + '\n' });
        }
      });

      claude.on('error', (err) => {
        sse({ t: 'err', v: 'Failed to run claude: ' + err.message });
        res.end();
      });

      claude.on('close', () => {
        if (lineBuf.trim()) processLine(lineBuf);
        res.end();
      });
    });
    return;
  }

  res.writeHead(404); res.end();
});

function listen(port) {
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Figma CLI Web UI  →  ${url}\n`);
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      detached: true, stdio: 'ignore',
    }).unref();
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') listen(port + 1);
    else { console.error('[web-ui]', err.message); process.exit(1); }
  });
}

listen(parseInt(process.env.WEB_PORT) || DEFAULT_PORT);
