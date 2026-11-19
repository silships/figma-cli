// Unit tests for Browser Mode launch helpers (pure, no browser/Figma needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserDebugArgs, getBrowserCommand } from '../src/platform.js';

// ---------- browserDebugArgs ----------

test('browserDebugArgs enables remote debugging on the given port', () => {
  const args = browserDebugArgs(9222, '/tmp/prof');
  assert.ok(args.includes('--remote-debugging-port=9222'));
});

test('browserDebugArgs allows CDP WebSocket origins (Chrome 111+ requirement)', () => {
  const args = browserDebugArgs(9222, '/tmp/prof');
  assert.ok(args.includes('--remote-allow-origins=*'));
});

test('browserDebugArgs isolates the debug session in its own profile dir', () => {
  const args = browserDebugArgs(9222, '/home/u/.figma-ds-cli/chrome-profile');
  assert.ok(args.includes('--user-data-dir=/home/u/.figma-ds-cli/chrome-profile'));
});

test('browserDebugArgs opens Figma as the last (URL) argument', () => {
  const args = browserDebugArgs(9222, '/tmp/prof');
  assert.equal(args[args.length - 1], 'https://www.figma.com');
});

test('browserDebugArgs honors a custom port and url', () => {
  const args = browserDebugArgs(9333, '/tmp/prof', 'https://www.figma.com/design/abc');
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.equal(args[args.length - 1], 'https://www.figma.com/design/abc');
});

// ---------- getBrowserCommand ----------

test('getBrowserCommand quotes a profile dir that contains spaces', () => {
  const cmd = getBrowserCommand(9222, '/Users/Jane Doe/.figma-ds-cli/chrome-profile');
  assert.ok(cmd.includes('"--user-data-dir=/Users/Jane Doe/.figma-ds-cli/chrome-profile"'));
});

test('getBrowserCommand carries the debug flags for a copy-paste launch', () => {
  const cmd = getBrowserCommand(9222, '/tmp/prof');
  assert.ok(cmd.includes('--remote-debugging-port=9222'));
  assert.ok(cmd.includes('--remote-allow-origins=*'));
  assert.ok(cmd.trim().endsWith('https://www.figma.com'));
});

// ---------- browser-mode helpers (last file, tab pick, login) ----------
import { cleanFileUrl, pickFileTab, isLoginUrl, isFigmaFileUrl } from '../src/lib/browser-mode.js';

test('cleanFileUrl keeps file key and name, drops node-id and query', () => {
  assert.equal(
    cleanFileUrl('https://www.figma.com/design/AbC123/My-File?node-id=1-2&t=xyz'),
    'https://www.figma.com/design/AbC123/My-File'
  );
});

test('cleanFileUrl keeps Slides files and rejects home/feed', () => {
  assert.equal(cleanFileUrl('https://www.figma.com/slides/K/Deck?x=1'), 'https://www.figma.com/slides/K/Deck');
  assert.equal(cleanFileUrl('https://www.figma.com/files/recents'), null);
  assert.equal(cleanFileUrl(undefined), null);
});

test('pickFileTab prefers a design file over Slides and ignores service workers', () => {
  const pages = [
    { type: 'page', url: 'https://www.figma.com/files/recents' },
    { type: 'page', url: 'https://www.figma.com/slides/K/Deck' },
    { type: 'service_worker', url: 'https://www.figma.com/design/SW/x' },
    { type: 'page', url: 'https://www.figma.com/design/D/File' },
  ];
  assert.equal(pickFileTab(pages).url, 'https://www.figma.com/design/D/File');
});

test('pickFileTab finds a Slides-only session', () => {
  assert.equal(pickFileTab([{ type: 'page', url: 'https://www.figma.com/slides/K/Deck' }]).url,
    'https://www.figma.com/slides/K/Deck');
  assert.equal(pickFileTab([{ type: 'page', url: 'https://www.figma.com/files/recents' }]), null);
});

test('isLoginUrl / isFigmaFileUrl', () => {
  assert.ok(isLoginUrl('https://www.figma.com/login?cont=x'));
  assert.ok(!isLoginUrl('https://www.figma.com/design/D/File'));
  assert.ok(isFigmaFileUrl('https://www.figma.com/file/D/File'));
  assert.ok(!isFigmaFileUrl('https://www.figma.com/files/team/1'));
});

test('isLoginUrl treats the signed-out marketing home as login', () => {
  assert.ok(isLoginUrl('https://www.figma.com/'));
  assert.ok(!isLoginUrl('https://www.figma.com/files/team/1/recents'));
});

import { seedProfilePermissions, FIGMA_ORIGIN_PATTERN } from '../src/lib/browser-mode.js';
import { mkdtempSync, readFileSync as rf, writeFileSync as wf, mkdirSync as md } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pj } from 'node:path';

test('seedProfilePermissions allows figma.com local network access in a new profile', () => {
  const dir = mkdtempSync(pj(tmpdir(), 'fcli-prof-'));
  assert.equal(seedProfilePermissions(dir), true);
  const prefs = JSON.parse(rf(pj(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.profile.content_settings.exceptions.loopback_network[FIGMA_ORIGIN_PATTERN].setting, 1);
  assert.equal(seedProfilePermissions(dir), false); // idempotent
});

test('seedProfilePermissions keeps existing preferences', () => {
  const dir = mkdtempSync(pj(tmpdir(), 'fcli-prof-'));
  md(pj(dir, 'Default'), { recursive: true });
  wf(pj(dir, 'Default', 'Preferences'), JSON.stringify({ keep: 1, profile: { name: 'x', content_settings: { exceptions: { cookies: { a: 1 } } } } }));
  seedProfilePermissions(dir);
  const prefs = JSON.parse(rf(pj(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.keep, 1);
  assert.equal(prefs.profile.name, 'x');
  assert.deepEqual(prefs.profile.content_settings.exceptions.cookies, { a: 1 });
});

import { pickConnectMode } from '../src/lib/browser-mode.js';

test('pickConnectMode — Browser is the default, flags win, Desktop users keep Yolo', () => {
  assert.equal(pickConnectMode({}, {}), 'browser');
  assert.equal(pickConnectMode({}, { browser: true, patched: false }), 'browser');
  assert.equal(pickConnectMode({}, { patched: true }), 'yolo');
  assert.equal(pickConnectMode({ browser: true }, { patched: true }), 'browser');
  assert.equal(pickConnectMode({ desktop: true }, {}), 'yolo');
  assert.equal(pickConnectMode({ yolo: true }, {}), 'yolo');
  assert.equal(pickConnectMode({ safe: true }, { browser: true }), 'safe');
});
