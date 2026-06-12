import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkerCode, listPagesCode } from '../src/design-extract.js';

test('walkerCode produces syntactically valid JS', () => {
  const code = walkerCode('123:45');
  // Throws SyntaxError if invalid. Wrap in a function shell because the
  // code is an async IIFE expression.
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('walkerCode embeds page id and options', () => {
  const code = walkerCode('123:45', { maxDepth: 5, textLimit: 40 });
  assert.match(code, /"123:45"/);
  assert.match(code, /MAX_DEPTH = 5/);
  assert.match(code, /TEXT_LIMIT = 40/);
});

test('walkerCode defaults: depth 8, text 80', () => {
  const code = walkerCode('1:1');
  assert.match(code, /MAX_DEPTH = 8/);
  assert.match(code, /TEXT_LIMIT = 80/);
});

test('listPagesCode is valid JS', () => {
  assert.doesNotThrow(() => new Function(`return ${listPagesCode()}`));
});

test('walkerCode loads the page before reading children (dynamic-page mode)', () => {
  const code = walkerCode('1:1');
  assert.match(code, /loadAsync/);
  // loadAsync must appear BEFORE the first children access
  assert.ok(code.indexOf('loadAsync') < code.indexOf('count(page)'));
});

import { buildCensus, assignSemanticNames } from '../src/design-extract.js';

export const FIXTURE_PAGES = [
  {
    id: '1:1', name: 'Buttons', nodeCount: 10,
    frames: [
      { t: 'FRAME', n: 'Row', w: 400, h: 40, lm: 'HORIZONTAL', gap: 8, fills: ['#ffffff'], kids: [
        { t: 'COMPONENT', n: 'Primary', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#1f883d'], r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#ffffff'] },
        ] },
        { t: 'COMPONENT', n: 'Default', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#f6f8fa'], strokes: ['#d0d7de'], sw: 1, r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#1f2328'] },
        ] },
      ] },
    ],
  },
];

test('buildCensus counts colors from fills and strokes', () => {
  const census = buildCensus(FIXTURE_PAGES);
  assert.equal(census.colors.get('#ffffff'), 2);   // frame fill + text fill
  assert.equal(census.colors.get('#1f883d'), 1);
  assert.equal(census.colors.get('#d0d7de'), 1);   // stroke
});

test('buildCensus strips opacity suffix from paint strings', () => {
  const census = buildCensus([{ id: 'x', name: 'P', nodeCount: 1, frames: [
    { t: 'FRAME', n: 'F', w: 10, h: 10, fills: ['#000000@50'] },
  ] }]);
  assert.equal(census.colors.get('#000000'), 1);
});

test('assignSemanticNames classifies by lightness and chroma', () => {
  const colors = new Map([
    ['#ffffff', 50],  // near-white → background
    ['#1f2328', 40],  // dark, low sat → text-primary
    ['#0969da', 30],  // chromatic → accent
    ['#d0d7de', 20],  // light gray → border
    ['#59636e', 10],  // mid gray → text-*
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['background'], '#ffffff');
  assert.equal(named['text-primary'], '#1f2328');
  assert.equal(named['accent'], '#0969da');
  assert.ok(Object.values(named).includes('#d0d7de'));
  assert.equal(Object.keys(named).length, 5);
});

test('assignSemanticNames suffixes duplicates with -alt, -3, -4', () => {
  const colors = new Map([
    ['#0969da', 30], ['#d1242f', 20], ['#8250df', 10],
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['accent'], '#0969da');
  assert.equal(named['accent-alt'], '#d1242f');
  assert.equal(named['accent-3'], '#8250df');
});

import { buildTypeScale, inferBaseUnit, nameRadii } from '../src/design-extract.js';

test('buildTypeScale names styles by size rank (display > h1 > … > body > caption)', () => {
  const typo = new Map([
    ['Inter|Bold|40|48|', 5],
    ['Inter|Semi Bold|24|32|', 10],
    ['Inter|Regular|14|20|', 100],
    ['Inter|Regular|12|16|', 30],
  ]);
  const scale = buildTypeScale(typo);
  const names = Object.keys(scale);
  assert.ok(names.includes('display'));
  assert.ok(names.includes('body'));
  assert.ok(names.includes('caption'));
  assert.equal(scale['body'].fontSize, 14);
  assert.equal(scale['body'].fontFamily, 'Inter');
  assert.equal(scale['body'].fontWeight, 400);   // 'Regular' → 400
  assert.equal(scale['display'].fontWeight, 700); // 'Bold' → 700
});

test('inferBaseUnit picks the dominant grid from spacing counts', () => {
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [24, 20], [4, 10]])), 4);
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [32, 10]])), 8);
  assert.equal(inferBaseUnit(new Map()), 8); // sensible default
});

test('nameRadii produces sm/md/lg names sorted by value', () => {
  const named = nameRadii(new Map([[2, 50], [6, 80], [12, 20], [9999, 5]]));
  assert.equal(named['radius-sm'], 2);
  assert.equal(named['radius-md'], 6);
  assert.equal(named['radius-lg'], 12);
  assert.equal(named['radius-full'], 9999);
});

import { formatTree, dedupSiblings, variantMatrixTable } from '../src/design-extract.js';

test('formatTree emits the plugin tree notation', () => {
  const node = {
    t: 'FRAME', n: 'Button', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12],
    kids: [{ t: 'TEXT', n: 'Label', w: 47, h: 20, txt: { chars: 'Button' } }],
  };
  const lines = formatTree(node, 0);
  assert.match(lines[0], /\*\*Button\*\* · `FRAME` · 71×32 · horizontal row, gap 8px, padding 6\/12\/6\/12px · 1 children/);
  assert.match(lines[1], /^ {2}- \*\*Label\*\* · `TEXT` · 47×20 · “Button”/);
});

test('formatTree shows explicit omission counts (never silent)', () => {
  const node = { t: 'FRAME', n: 'Deep', w: 10, h: 10, more: 7 };
  const lines = formatTree(node, 0);
  assert.match(lines.join('\n'), /…and 7 more/);
});

test('dedupSiblings collapses identical siblings to one entry with ×N', () => {
  const btn = (name) => ({ t: 'INSTANCE', n: name, w: 71, h: 32, mc: 'Button' });
  const kids = [btn('Button'), btn('Button'), btn('Button'), btn('Other')];
  const deduped = dedupSiblings(kids);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].repeat, 3);
  assert.equal(deduped[1].n, 'Other');
});

test('variantMatrixTable renders a property/values table', () => {
  const md = variantMatrixTable({ trigger: { values: ['icon-button', 'button'] }, open: { values: ['true', 'false'] } });
  assert.match(md, /\| trigger \| icon-button, button \|/);
  assert.match(md, /\| open \| true, false \|/);
});
