import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeWeight, buildStyleIndex, matchTextStyle } from '../src/lib/text-styles.js';

// A trimmed version of a real file's text styles (Fira Sans design system):
// slash-grouped names, three weights sharing one size, two families.
const s = (name, family, style, fontSize) => ({ id: 'S:' + name, name, fontName: { family, style }, fontSize });
const STYLES = [
  s('Display/XL', 'Fira Sans', 'ExtraBold', 72),
  s('Heading/H1', 'Fira Sans', 'Bold', 36),
  s('Heading/H4', 'Fira Sans', 'Bold', 18),
  s('Body/L', 'Fira Sans', 'Regular', 18),
  s('Body/M', 'Fira Sans', 'Regular', 16),
  s('Body/S', 'Fira Sans', 'Regular', 14),
  s('Label/L', 'Fira Sans', 'SemiBold', 16),
  s('Label/M', 'Fira Sans', 'SemiBold', 14),
  s('Code/M', 'Fira Mono', 'Regular', 14),
];

describe('normalizeWeight', () => {
  it('treats the spellings of one weight as equal', () => {
    assert.strictEqual(normalizeWeight('Semi Bold'), normalizeWeight('SemiBold'));
    assert.strictEqual(normalizeWeight('Extra Bold'), normalizeWeight('extrabold'));
    assert.strictEqual(normalizeWeight('Bold Italic'), 'bolditalic');
  });

  it('survives undefined', () => {
    assert.strictEqual(normalizeWeight(undefined), '');
  });
});

describe('buildStyleIndex', () => {
  const index = buildStyleIndex(STYLES);

  it('registers the full name', () => {
    assert.strictEqual(index['Heading/H1'].id, 'S:Heading/H1');
  });

  it('registers the tail as an alias, like var: does', () => {
    assert.strictEqual(index['H1'].id, 'S:Heading/H1');
    assert.strictEqual(index['XL'].id, 'S:Display/XL');
  });

  it('lets the full name win over a colliding tail', () => {
    const withCollision = [s('M', 'X', 'Regular', 10), ...STYLES];
    const i2 = buildStyleIndex(withCollision);
    assert.strictEqual(i2['M'].fontSize, 10, 'a style literally named M wins over Body/M');
  });

  it('handles an empty list', () => {
    assert.deepStrictEqual(buildStyleIndex([]), {});
    assert.deepStrictEqual(buildStyleIndex(undefined), {});
  });
});

describe('matchTextStyle', () => {
  it('matches on size + weight', () => {
    const r = matchTextStyle({ styles: STYLES, size: 36, weightStyle: 'Bold' });
    assert.strictEqual(r.match.name, 'Heading/H1');
  });

  it('accepts a differently spelled weight', () => {
    const r = matchTextStyle({ styles: STYLES, size: 16, weightStyle: 'Semi Bold' });
    assert.strictEqual(r.match.name, 'Label/L');
  });

  it('ignores the family when font= was not given', () => {
    const r = matchTextStyle({ styles: STYLES, size: 16, weightStyle: 'Regular', family: 'Inter' });
    assert.strictEqual(r.match.name, 'Body/M', 'the default family is a fallback, not an intent');
  });

  it('honors the family when font= was given', () => {
    const r = matchTextStyle({
      styles: STYLES, size: 14, weightStyle: 'Regular', family: 'Fira Mono', familyExplicit: true,
    });
    assert.strictEqual(r.match.name, 'Code/M');
  });

  it('applies nothing when several styles fit', () => {
    // 14px Regular exists twice: Body/S (Fira Sans) and Code/M (Fira Mono).
    const r = matchTextStyle({ styles: STYLES, size: 14, weightStyle: 'Regular' });
    assert.ok(!r.match);
    assert.deepStrictEqual(r.ambiguous, ['Body/S', 'Code/M']);
  });

  it('reports the nearest size at the same weight when nothing fits', () => {
    const r = matchTextStyle({ styles: STYLES, size: 15, weightStyle: 'Bold' });
    assert.ok(!r.match);
    assert.strictEqual(r.nearest.name, 'Heading/H4', '18px Bold is closer than 36px Bold');
  });

  it('returns nearest: null on an empty style set', () => {
    const r = matchTextStyle({ styles: [], size: 16, weightStyle: 'Regular' });
    assert.strictEqual(r.nearest, null);
  });
});
