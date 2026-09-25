import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isNewer, decide, isDisabled, runUpdateCheck, DAY_MS } from '../src/lib/update-check.js';

test('isNewer compares x.y.z numerically and ignores pre-releases', () => {
  assert.equal(isNewer('2.2.1', '2.2.0'), true);
  assert.equal(isNewer('2.10.0', '2.9.9'), true);
  assert.equal(isNewer('2.2.0', '2.2.0'), false);
  assert.equal(isNewer('2.1.9', '2.2.0'), false);
  assert.equal(isNewer('3.0.0-beta.1', '2.2.0'), false);
});

test('decide: notice only when outdated and not shown in the last day', () => {
  const now = 10 * DAY_MS;
  assert.equal(decide({ current: '2.2.0', cache: { latest: '2.2.0', checkedAt: now }, now }).notice, null);
  const d = decide({ current: '2.2.0', cache: { latest: '2.3.0', checkedAt: now }, now });
  assert.match(d.notice, /2\.3\.0 is available .*npm install -g figma-ds-cli@latest/);
  assert.equal(d.refresh, false);
  assert.equal(decide({ current: '2.2.0', cache: { latest: '2.3.0', checkedAt: now, notifiedAt: now - 1000, notifiedFor: '2.3.0' }, now }).notice, null);
  // a newer release than the one announced is announced right away
  assert.ok(decide({ current: '2.2.0', cache: { latest: '2.4.0', checkedAt: now, notifiedAt: now - 1000, notifiedFor: '2.3.0' }, now }).notice);
});

test('decide: refresh when never checked or older than a day', () => {
  assert.equal(decide({ current: '2.2.0', cache: {}, now: DAY_MS }).refresh, true);
  assert.equal(decide({ current: '2.2.0', cache: { checkedAt: 0 }, now: DAY_MS + 1 }).refresh, true);
  assert.equal(decide({ current: '2.2.0', cache: { checkedAt: DAY_MS }, now: DAY_MS + 1 }).refresh, false);
});

test('CI, tests and the opt-out variable disable the check', () => {
  assert.equal(isDisabled({ CI: '1' }), true);
  assert.equal(isDisabled({ FIGMA_CLI_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(isDisabled({ NODE_TEST_CONTEXT: 'child' }), true);
  assert.equal(isDisabled({}), false);
});

test('runUpdateCheck prints once and records it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'upd-')), 'c.json');
  const now = Date.now();
  writeFileSync(file, JSON.stringify({ latest: '999.0.0', checkedAt: now }));
  const printed = [];
  runUpdateCheck({ file, env: {}, now, print: m => printed.push(m) });
  runUpdateCheck({ file, env: {}, now: now + 1000, print: m => printed.push(m) });
  assert.equal(printed.length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).notifiedFor, '999.0.0');
});
