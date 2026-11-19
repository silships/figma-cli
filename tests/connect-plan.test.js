// Unit tests for the Yolo connect decision (pure, no Figma/CDP needed). PR #40.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectAction, cdpOwner } from '../src/lib/connect-plan.js';

test('a debuggable Figma Desktop is left alone', () => {
  assert.equal(resolveConnectAction({ cdp: 'desktop', figmaRunning: true }), 'reuse');
});

test('CDP wins even if the process probe missed Figma', () => {
  assert.equal(resolveConnectAction({ cdp: 'desktop', figmaRunning: false }), 'reuse');
});

test('the Browser Mode Chrome on the port is not mistaken for Figma Desktop', () => {
  assert.equal(resolveConnectAction({ cdp: 'other', figmaRunning: false }), 'port-busy');
  assert.equal(resolveConnectAction({ cdp: 'other', figmaRunning: true }), 'port-busy');
});

test('Figma running without the debug port asks the user to quit', () => {
  assert.equal(resolveConnectAction({ cdp: null, figmaRunning: true }), 'needs-quit');
});

test('no Figma at all means we start it ourselves', () => {
  assert.equal(resolveConnectAction({ cdp: null, figmaRunning: false }), 'start-fresh');
});

test('cdpOwner tells Figma Desktop (Electron) from Chrome', () => {
  assert.equal(cdpOwner(null), null);
  assert.equal(cdpOwner({ Browser: 'Chrome/128.0.0.0', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.6.4 Chrome/128.0.0.0 Electron/32.2.0 Safari/537.36' }), 'desktop');
  assert.equal(cdpOwner({ Browser: 'Chrome/131.0.6778.86', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }), 'other');
});
