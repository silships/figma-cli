#!/usr/bin/env node

/**
 * Figma CLI Daemon
 *
 * Keeps a persistent connection to Figma for fast command execution.
 * Started automatically by `connect` command.
 */

import { createServer } from 'http';
import { FigmaClient } from './figma-client.js';

const PORT = parseInt(process.env.DAEMON_PORT) || 3456;

let client = null;
let isConnecting = false;

// Check if connection is healthy (WebSocket open + figma object exists)
async function isConnectionHealthy() {
  if (!client || !client.ws) return false;
  if (client.ws.readyState !== 1) return false; // 1 = OPEN

  // Make/Board files are "connected" but don't have the Plugin API
  if (client.isMakeFile) return true;

  try {
    // Quick check if figma object exists
    const result = await Promise.race([
      client.send('Runtime.evaluate', { expression: 'typeof figma !== "undefined"', returnByValue: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
    ]);
    return result?.result?.result?.value === true;
  } catch {
    return false;
  }
}

// Get or create FigmaClient
async function getClient() {
  // Check if existing connection is healthy
  if (client) {
    const healthy = await isConnectionHealthy();
    if (healthy) return client;

    // Connection is stale, close and reconnect
    console.log('[daemon] Connection stale, reconnecting...');
    try { client.close(); } catch {}
    client = null;
  }

  if (isConnecting) {
    // Wait for connection
    while (isConnecting) {
      await new Promise(r => setTimeout(r, 100));
    }
    return client;
  }

  isConnecting = true;
  try {
    client = new FigmaClient();
    await client.connect();
    const typeLabel = client.fileType === 'make' ? 'Make' : client.fileType === 'board' ? 'Board' : 'Design';
    console.log(`[daemon] Connected to Figma ${typeLabel} file: ${client.pageTitle || 'untitled'}`);
  } finally {
    isConnecting = false;
  }
  return client;
}

// Handle requests
async function handleRequest(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check - actually test the connection
  if (req.url === '/health') {
    const healthy = await isConnectionHealthy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: healthy ? 'ok' : 'stale',
      connected: !!client,
      healthy,
      fileType: client?.fileType || null,
      pageTitle: client?.pageTitle || null
    }));
    return;
  }

  // Force reconnect
  if (req.url === '/reconnect') {
    try {
      if (client) {
        try { client.close(); } catch {}
        client = null;
      }
      await getClient();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'reconnected' }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Execute command with retry
  if (req.url === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const MAX_RETRIES = 2;
      let lastError;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const { action, code, jsx, jsxArray } = JSON.parse(body);
          const figma = await getClient();
          let result;

          // Wrap in timeout
          const execWithTimeout = async (fn) => {
            return Promise.race([
              fn(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Execution timeout')), 30000)
              )
            ]);
          };

          switch (action) {
            case 'eval':
              result = await execWithTimeout(() => figma.eval(code));
              break;
            case 'render':
              result = await execWithTimeout(() => figma.render(jsx));
              break;
            case 'render-batch':
              result = [];
              for (const j of jsxArray) {
                result.push(await execWithTimeout(() => figma.render(j)));
              }
              break;
            default:
              throw new Error(`Unknown action: ${action}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
          return; // Success, exit retry loop
        } catch (error) {
          lastError = error;
          console.log(`[daemon] Attempt ${attempt + 1} failed: ${error.message}`);

          // Force reconnect before retry
          if (attempt < MAX_RETRIES) {
            console.log('[daemon] Reconnecting before retry...');
            try { client.close(); } catch {}
            client = null;
            await new Promise(r => setTimeout(r, 500)); // Brief pause
          }
        }
      }

      // All retries failed
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: lastError.message }));
    });
    return;
  }

  // Not found
  res.writeHead(404);
  res.end('Not found');
}

// Start server
const server = createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[daemon] Figma CLI daemon running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[daemon] Shutting down...');
  if (client) client.close();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[daemon] Shutting down...');
  if (client) client.close();
  server.close(() => process.exit(0));
});

// Pre-connect to Figma
getClient().catch(err => {
  console.error('[daemon] Initial connection failed:', err.message);
});
