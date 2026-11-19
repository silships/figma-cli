// Timeout policy shared by the CLI and the daemon.
//
// Code sent to Figma keeps running after the caller stops waiting: CDP cannot
// cancel it. So a timeout is not a connection failure, and re-running the same
// code (a retry, or a fallback to the direct connection) can create a second
// copy of whatever the first run is still building.

export const EVAL_TIMEOUT_MS = 30000;
export const RENDER_TIMEOUT_MS = 90000;
export const MAX_EVAL_TIMEOUT_MS = 180000;

// Daemon side: the budget an eval request asked for, clamped to sane bounds.
export function evalTimeoutMs(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return EVAL_TIMEOUT_MS;
  return Math.min(Math.max(n, 1000), MAX_EVAL_TIMEOUT_MS);
}

// 'timeout'    — Figma did not answer in time; the code may still finish.
// 'connection' — the daemon or Figma could not be reached; nothing ran.
// 'code'       — the code ran and threw.
export function classifyDaemonError(err) {
  const msg = String((err && err.message) || err || '');
  if ((err && (err.name === 'TimeoutError' || err.name === 'AbortError')) || /\btime(d)?\s*out\b|timeout/i.test(msg)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|disconnected|Not connected|Plugin not connected/i.test(msg)) return 'connection';
  return 'code';
}

export function timeoutMessage(seconds) {
  return `Figma did not answer within ${seconds}s. The command may still be running in Figma and finish on its own: check the canvas before running it again (a second run can create a duplicate).`;
}
