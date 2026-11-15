import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { removeBackground, LEONARDO_SYNC_URL } from '../src/lib/remove-bg.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function mockFetch(syncResponse) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === LEONARDO_SYNC_URL) return syncResponse();
    if (url === 'https://cdn.example/result.png') return new Response(PNG, { status: 200 });
    throw new Error('unexpected request to ' + url);
  };
  return calls;
}

test('sends the Leonardo remove-bg request and returns the downloaded PNG', async () => {
  const calls = mockFetch(() => json({ results: [{ url: 'https://cdn.example/result.png' }] }));
  const out = await removeBackground(Buffer.from('image bytes'), 'leo-key');

  assert.deepEqual(out, PNG);
  assert.equal(calls[0].url, 'https://cloud.leonardo.ai/api/rest/v2/generationssync');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer leo-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'remove-bg');
  assert.equal(body.ephemeral, true);
  assert.equal(body.parameters.format, 'png');
  assert.deepEqual(body.parameters.guidances.image_reference, [
    { image: { type: 'BASE64', data: Buffer.from('image bytes').toString('base64') } },
  ]);
  assert.equal(calls[1].url, 'https://cdn.example/result.png');
});

test('surfaces errors[] that Leonardo returns with HTTP 200', async () => {
  mockFetch(() => json({ errors: [{ message: 'Invalid image', extensions: { code: 'BAD_REQUEST' } }] }));
  await assert.rejects(removeBackground(Buffer.from('x'), 'leo-key'), /Invalid image/);
});

test('explains that old remove.bg keys no longer work on 401', async () => {
  mockFetch(() => json({ error: 'Invalid API key' }, 401));
  await assert.rejects(removeBackground(Buffer.from('x'), 'old-key'), /Leonardo\.Ai API key/);
});

test('fails clearly when no image comes back', async () => {
  mockFetch(() => json({ blockedCount: 1, results: [] }));
  await assert.rejects(removeBackground(Buffer.from('x'), 'leo-key'), /API request failed/);
});
