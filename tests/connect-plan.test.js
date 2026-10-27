// Unit tests for the connect decision (pure, no Figma/CDP needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectAction } from '../src/lib/connect-plan.js';

test('a reachable CDP port means Figma is left alone', () => {
  assert.equal(resolveConnectAction({ cdpReachable: true, figmaRunning: true }), 'reuse');
});

test('CDP wins even if the process probe missed Figma', () => {
  // A reachable port proves a debuggable Figma exists, whatever pgrep says.
  assert.equal(resolveConnectAction({ cdpReachable: true, figmaRunning: false }), 'reuse');
});

test('Figma running without the debug port asks the user to quit', () => {
  assert.equal(resolveConnectAction({ cdpReachable: false, figmaRunning: true }), 'needs-quit');
});

test('no Figma at all means we start it ourselves', () => {
  assert.equal(resolveConnectAction({ cdpReachable: false, figmaRunning: false }), 'start-fresh');
});
