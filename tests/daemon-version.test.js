import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionOlder } from '../src/lib/cli-core.js';

test('only an older daemon counts as stale, so two installs never restart each other', () => {
  assert.equal(versionOlder('2.2.3', '2.2.4'), true);
  assert.equal(versionOlder('2.2.4', '2.2.4'), false);
  assert.equal(versionOlder('2.3.0', '2.2.9'), false);
  assert.equal(versionOlder('2.10.0', '2.9.0'), false);
  assert.equal(versionOlder(undefined, '2.2.4'), true);
});
