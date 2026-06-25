import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('getCdpPort', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.FIGMA_PORT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FIGMA_PORT;
    } else {
      process.env.FIGMA_PORT = originalEnv;
    }
  });

  it('returns 9222 by default', async () => {
    delete process.env.FIGMA_PORT;
    const mod = await import(`../src/figma-patch.js?t=${Date.now()}`);
    assert.equal(mod.getCdpPort(), 9222);
  });

  it('returns FIGMA_PORT when set', async () => {
    process.env.FIGMA_PORT = '9333';
    const { getCdpPort } = await import(`../src/figma-patch.js?t=${Date.now()}`);
    assert.equal(getCdpPort(), 9333);
  });

  it('ignores invalid FIGMA_PORT values', async () => {
    process.env.FIGMA_PORT = 'abc';
    const { getCdpPort } = await import(`../src/figma-patch.js?t=${Date.now()}`);
    assert.equal(getCdpPort(), 9222);
  });
});
