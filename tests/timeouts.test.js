import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'fs';
import { evalTimeoutMs, classifyDaemonError, timeoutMessage, EVAL_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS } from '../src/lib/timeouts.js';
import { daemonExec, DAEMON_TOKEN_FILE } from '../src/lib/cli-core.js';

describe('timeout policy', () => {
  it('clamps the eval budget a caller asks for', () => {
    assert.strictEqual(evalTimeoutMs(undefined), EVAL_TIMEOUT_MS);
    assert.strictEqual(evalTimeoutMs('nope'), EVAL_TIMEOUT_MS);
    assert.strictEqual(evalTimeoutMs(90000), 90000);
    assert.strictEqual(evalTimeoutMs(10), 1000);
    assert.strictEqual(evalTimeoutMs(1e9), MAX_EVAL_TIMEOUT_MS);
  });

  it('never classifies a timeout as a connection error (no re-run fallback)', () => {
    assert.strictEqual(classifyDaemonError(new Error('Execution timeout (30s)')), 'timeout');
    assert.strictEqual(classifyDaemonError(new Error('Plugin execution timeout (25s)')), 'timeout');
    assert.strictEqual(classifyDaemonError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout');
    assert.strictEqual(classifyDaemonError(new Error('fetch failed')), 'connection');
    assert.strictEqual(classifyDaemonError(new Error('connect ECONNREFUSED 127.0.0.1:3456')), 'connection');
    assert.strictEqual(classifyDaemonError(new Error('No variant of "Tag" matches {"State":"x"}')), 'code');
  });

  it('says the command may still finish, so nobody re-runs it blindly', () => {
    const m = timeoutMessage(30);
    assert.match(m, /within 30s/);
    assert.match(m, /may still be running/);
  });
});

describe('daemonExec timeout reporting', () => {
  const hasToken = existsSync(DAEMON_TOKEN_FILE);
  it('keeps the daemon\'s own budget instead of relabelling it as 90s', { skip: !hasToken && 'no daemon token on this machine' }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'Execution timeout (30s)' }) });
    try {
      await assert.rejects(daemonExec('eval', { code: '1' }, 90000), (e) => {
        assert.match(e.message, /within 30s/);
        assert.doesNotMatch(e.message, /90s/);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
