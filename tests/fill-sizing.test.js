import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveLeafSizing, resolveRootFill } from '../src/lib/fill-sizing.js';

describe('resolveLeafSizing', () => {
  it('keeps a numeric size and fills nothing', () => {
    assert.deepStrictEqual(
      resolveLeafSizing({ w: 200, h: 2 }),
      { resizeW: 200, resizeH: 2, fillH: false, fillV: false }
    );
  });

  it('never passes the "fill" keyword into resize()', () => {
    const r = resolveLeafSizing({ w: 'fill', h: 2 });
    assert.strictEqual(r.resizeW, 100);
    assert.strictEqual(r.resizeH, 2);
    assert.strictEqual(r.fillH, true);
    assert.strictEqual(r.fillV, false);
  });

  it('handles fill on both axes', () => {
    const r = resolveLeafSizing({ w: 'fill', h: 'fill', defaultW: 200, defaultH: 150 });
    assert.deepStrictEqual(r, { resizeW: 200, resizeH: 150, fillH: true, fillV: true });
  });

  it('ignores fill in a parent without auto-layout', () => {
    const r = resolveLeafSizing({ w: 'fill', h: 4, parentIsNone: true });
    assert.strictEqual(r.fillH, false);
    assert.strictEqual(r.resizeW, 100);
  });

  it('treats "hug" as unset — a leaf has nothing to hug', () => {
    const r = resolveLeafSizing({ w: 'hug', defaultW: 42 });
    assert.strictEqual(r.resizeW, 42);
    assert.strictEqual(r.fillH, false);
  });

  it('falls back to the per-element defaults', () => {
    assert.deepStrictEqual(
      resolveLeafSizing({ defaultW: 200, defaultH: 150 }),
      { resizeW: 200, resizeH: 150, fillH: false, fillV: false }
    );
  });
});

describe('resolveRootFill', () => {
  it('is a no-op without fill', () => {
    assert.deepStrictEqual(
      resolveRootFill({ hasParent: true }),
      { applyAfterAppend: false, warnings: [] }
    );
  });

  it('defers the assignment until after appendChild when a parent exists', () => {
    const r = resolveRootFill({ fillWidth: true, hasParent: true });
    assert.strictEqual(r.applyAfterAppend, true);
    assert.deepStrictEqual(r.warnings, []);
  });

  it('warns instead of throwing when there is no parent', () => {
    const r = resolveRootFill({ fillWidth: true, hasParent: false, name: 'A' });
    assert.strictEqual(r.applyAfterAppend, false);
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0], /^"A" fills width/);
    assert.match(r.warnings[0], /--parent/);
  });

  it('names both axes in one warning', () => {
    const r = resolveRootFill({ fillWidth: true, fillHeight: true, name: 'B' });
    assert.match(r.warnings[0], /fills width and height/);
  });
});
