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

test('walkerCode captures the default-variant reuse handle on a COMPONENT_SET', () => {
  const code = walkerCode('1:1');
  assert.match(code, /defaultVariant/);
  assert.match(code, /o\.id = dv\.id/);
  assert.match(code, /o\.key = dv\.key/);
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

test('buildCensus carries key/id from a COMPONENT_SET walker node', () => {
  const pages = [{ id: '1:1', name: 'P', nodeCount: 1, frames: [
    { t: 'COMPONENT_SET', n: 'Button', vp: { Size: { values: ['S', 'M'] } },
      kidCount: 2, key: 'abc123', id: '10:5', kids: [{ t: 'COMPONENT', n: 'Size=S' }] },
  ] }];
  const census = buildCensus(pages);
  assert.equal(census.componentSets.length, 1);
  assert.equal(census.componentSets[0].key, 'abc123');
  assert.equal(census.componentSets[0].id, '10:5');
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

import { generateDesignMd, ALL_SECTIONS } from '../src/design-extract.js';
import { parseDesignMd } from '../src/design-md.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTRACTION = {
  fileName: 'Test File',
  date: '2026-06-12',
  pages: FIXTURE_PAGES,
};

test('generateDesignMd emits all 12 sections by default', () => {
  const md = generateDesignMd(EXTRACTION);
  for (const [i, title] of [
    [1, 'Identity'], [2, 'Structure'], [3, 'Color'], [4, 'Variables'],
    [5, 'Typography'], [6, 'Spacing & Layout'], [7, 'Depth & Motion'],
    [8, 'Components'], [9, 'States'], [10, 'Rules'],
    [11, 'Extending this system'], [12, 'Machine-readable tokens'],
  ]) {
    assert.match(md, new RegExp(`^## ${i}\\. ${title.replace(/[&]/g, '\\$&')}`, 'm'), `missing section ${i} ${title}`);
  }
});

test('Variables section degrades gracefully when the file has no variables', () => {
  const md = generateDesignMd(EXTRACTION); // fixture has no `variables`
  assert.match(md, /^## 4\. Variables/m);
  assert.match(md, /no local variables found/);
});

test('generateDesignMd respects --sections selection and renumbers', () => {
  const md = generateDesignMd(EXTRACTION, { sections: ['color', 'tokens'] });
  assert.match(md, /^## 1\. Color/m);
  assert.match(md, /^## 2\. Machine-readable tokens/m);
  assert.doesNotMatch(md, /## \d+\. Structure/);
});

test('roundtrip: parseDesignMd reads generateDesignMd output', () => {
  const md = generateDesignMd(EXTRACTION);
  const dir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file);
  assert.equal(parsed.meta.source, 'Test File');
  // every census color appears in the parsed token map
  const parsedColors = Object.values(parsed.tokens.color);
  assert.ok(parsedColors.includes('#ffffff'));
  assert.ok(parsedColors.includes('#1f883d'));
  // typography roundtrips with family + size
  const tNames = Object.keys(parsed.tokens.typography);
  assert.ok(tNames.length >= 1);
});

test('structure section contains untruncated page trees', () => {
  const md = generateDesignMd(EXTRACTION);
  assert.match(md, /### Page: Buttons/);
  assert.match(md, /\*\*Primary\*\* · `COMPONENT` · 71×32/);
});

import { estimateStructureTokens } from '../src/design-extract.js';

test('estimateStructureTokens returns a positive token estimate', () => {
  const tokens = estimateStructureTokens(FIXTURE_PAGES);
  assert.ok(tokens > 10, `expected >10, got ${tokens}`);
  assert.ok(tokens < 1000, `fixture is small, got ${tokens}`);
});

test('estimateStructureTokens skips errored pages and handles empty input', () => {
  assert.equal(estimateStructureTokens([]), 0);
  assert.equal(estimateStructureTokens([{ id: 'x', name: 'E', error: 'boom' }]), 0);
});

import { reuseHandleLine } from '../src/design-extract.js';

test('reuseHandleLine: key + id', () => {
  assert.equal(reuseHandleLine({ key: 'abc', id: '1:2' }),
    'Reuse: import existing — key `abc` · node `1:2`');
});
test('reuseHandleLine: id only', () => {
  assert.equal(reuseHandleLine({ id: '1:2' }), 'Reuse: import existing — node `1:2`');
});
test('reuseHandleLine: neither → null', () => {
  assert.equal(reuseHandleLine({}), null);
  assert.equal(reuseHandleLine(), null);
});

test('generateDesignMd components section emits the Reuse line', () => {
  const pages = [{ id: '1:1', name: 'P', nodeCount: 1, frames: [
    { t: 'COMPONENT_SET', n: 'Button', vp: { Size: { values: ['S', 'M'] } },
      kidCount: 2, key: 'abc123', id: '10:5', kids: [{ t: 'COMPONENT', n: 'Size=S' }] },
  ] }];
  const md = generateDesignMd({ fileName: 'F', date: '2026-06-16', pages }, { sections: ['components'] });
  assert.match(md, /Reuse: import existing — key `abc123` · node `10:5`/);
});

// ============ Variables capture ============

import { variablesCode, variableCollectionsCode, variableChunkCode, resolveAliases, formatVarValue, buildVariableTokens, mdCell } from '../src/design-extract.js';

const FIXTURE_VARS = [
  {
    id: 'VC:1', name: 'Primer Primitives',
    modes: [{ id: 'm1', name: 'Light' }, { id: 'm2', name: 'Dark' }],
    variables: [
      { id: 'V:1', name: 'fgColor-default', type: 'COLOR', values: { Light: '#1f2328', Dark: '#e6edf3' } },
      { id: 'V:2', name: 'button-primary-bgColor-rest', type: 'COLOR', values: { Light: '#1f883d', Dark: '#238636' } },
      { id: 'V:3', name: 'control-medium-size', type: 'FLOAT', values: { Light: 32, Dark: 32 } },
      // alias to another variable, captured as an id by the walker
      { id: 'V:4', name: 'button-default-fgColor', type: 'COLOR', values: { Light: { alias: 'V:1' }, Dark: { alias: 'V:1' } } },
    ],
  },
];

test('variablesCode is valid JS and uses the dynamic-page variable APIs', () => {
  const code = variablesCode();
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /getLocalVariableCollectionsAsync/);
  assert.match(code, /getVariableByIdAsync/);
  assert.match(code, /VARIABLE_ALIAS/);
});

test('variablesCode resolves alias names in-Figma (handles library/remote refs)', () => {
  const code = variablesCode();
  // Alias targets are looked up to their name via a cache so even imported
  // library variable ids resolve to a readable name, not a raw VariableID.
  assert.match(code, /nameCache/);
  assert.match(code, /aliasName/);
  assert.match(code, /alias: await aliasName\(raw\.id\)/);
});

test('variableCollectionsCode lists collections without reading values', () => {
  const code = variableCollectionsCode();
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /getLocalVariableCollectionsAsync/);
  assert.match(code, /variableIds/);
  // it must NOT pull every value (that's the chunked path's job)
  assert.doesNotMatch(code, /valuesByMode/);
});

test('variableChunkCode embeds the id slice + modes and is valid JS', () => {
  const code = variableChunkCode(['V:1', 'V:2'], [{ id: 'm1', name: 'Light' }]);
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /"V:1"/);
  assert.match(code, /"V:2"/);
  assert.match(code, /"Light"/);
  // shares the same alias-resolution helper as the one-shot path
  assert.match(code, /alias: await aliasName\(raw\.id\)/);
});

test('resolveAliases swaps alias ids for the referenced variable name', () => {
  const resolved = resolveAliases(FIXTURE_VARS);
  const aliasVar = resolved[0].variables.find(v => v.name === 'button-default-fgColor');
  assert.deepEqual(aliasVar.values.Light, { alias: 'fgColor-default' });
  assert.deepEqual(resolved[0].modes, ['Light', 'Dark']);
});

test('resolveAliases leaves unknown alias ids untouched (cross-library refs)', () => {
  const resolved = resolveAliases([{ name: 'C', modes: [{ id: 'm', name: 'M' }], variables: [
    { id: 'V:9', name: 'x', type: 'COLOR', values: { M: { alias: 'EXTERNAL:42' } } },
  ] }]);
  assert.deepEqual(resolved[0].variables[0].values.M, { alias: 'EXTERNAL:42' });
});

test('formatVarValue renders hex, alias, number and string cells', () => {
  assert.equal(formatVarValue('#1f883d'), '`#1f883d`');
  assert.equal(formatVarValue({ alias: 'fgColor-default' }), '→ var:fgColor-default');
  assert.equal(formatVarValue(32), '32');
  assert.equal(formatVarValue('auto'), '"auto"');
  assert.equal(formatVarValue(undefined), '—');
});

test('buildVariableTokens keys by collection name with modes + variable map', () => {
  const tokens = buildVariableTokens(resolveAliases(FIXTURE_VARS));
  assert.deepEqual(tokens['Primer Primitives'].modes, ['Light', 'Dark']);
  assert.equal(tokens['Primer Primitives'].variables['button-primary-bgColor-rest'].values.Light, '#1f883d');
  assert.equal(tokens['Primer Primitives'].variables['button-primary-bgColor-rest'].type, 'COLOR');
});

test('generateDesignMd emits the Variables section with a per-collection table', () => {
  const md = generateDesignMd({ ...EXTRACTION, variables: FIXTURE_VARS });
  assert.match(md, /### Collection: Primer Primitives {2}· {2}4 variables {2}· {2}modes: Light, Dark/);
  assert.match(md, /\| button-primary-bgColor-rest \| COLOR \| `#1f883d` \| `#238636` \|/);
  // alias resolved to a name, not an id
  assert.match(md, /\| button-default-fgColor \| COLOR \| → var:fgColor-default \| → var:fgColor-default \|/);
});

// These guard generality across ARBITRARY design systems, not just Primer:
// names/modes/values can contain markdown-hostile characters, and collection
// names are not unique in Figma.

test('mdCell escapes pipes and flattens newlines', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
  assert.equal(mdCell('line1\nline2'), 'line1 line2');
  assert.equal(mdCell('plain'), 'plain');
});

test('generateDesignMd keeps table columns intact when names/values contain pipes', () => {
  const vars = [{
    id: 'C', name: 'Weird System',
    modes: [{ id: 'm1', name: 'Light | HC' }, { id: 'm2', name: 'Dark' }],
    variables: [
      { id: 'V1', name: 'spacing|inset', type: 'STRING', values: { 'Light | HC': 'a|b', Dark: 'x' } },
    ],
  }];
  const md = generateDesignMd({ ...EXTRACTION, variables: vars });
  const row = md.split('\n').find(l => l.startsWith('| spacing'));
  // a literal pipe in content must be escaped so it isn't read as a column break
  assert.ok(row.includes('spacing\\|inset'), row);
  assert.ok(row.includes('"a\\|b"'), row);
  // header carries the escaped mode name
  assert.match(md, /Light \\\| HC/);
  // every body row has the same column count as the header (5 cells → 6 bars)
  const headerBars = (md.split('\n').find(l => l.startsWith('| Variable')).match(/(?<!\\)\|/g) || []).length;
  const rowBars = (row.match(/(?<!\\)\|/g) || []).length;
  assert.equal(rowBars, headerBars);
});

test('buildVariableTokens suffixes duplicate collection names instead of overwriting', () => {
  const dup = [
    { name: 'Theme', modes: ['default'], variables: [{ name: 'a', type: 'COLOR', values: { default: '#111111' } }] },
    { name: 'Theme', modes: ['default'], variables: [{ name: 'b', type: 'COLOR', values: { default: '#222222' } }] },
  ];
  const tokens = buildVariableTokens(dup);
  assert.deepEqual(Object.keys(tokens), ['Theme', 'Theme (2)']);
  assert.ok(tokens['Theme'].variables.a);
  assert.ok(tokens['Theme (2)'].variables.b);
});

test('captures all four Figma variable resolved types (not just colors)', () => {
  const vars = [{
    id: 'C', name: 'Mixed', modes: [{ id: 'm', name: 'default' }],
    variables: [
      { id: '1', name: 'col', type: 'COLOR', values: { default: '#abcdef' } },
      { id: '2', name: 'num', type: 'FLOAT', values: { default: 8 } },
      { id: '3', name: 'str', type: 'STRING', values: { default: 'Inter' } },
      { id: '4', name: 'flag', type: 'BOOLEAN', values: { default: true } },
    ],
  }];
  const md = generateDesignMd({ ...EXTRACTION, variables: vars });
  assert.match(md, /\| col \| COLOR \| `#abcdef` \|/);
  assert.match(md, /\| num \| FLOAT \| 8 \|/);
  assert.match(md, /\| str \| STRING \| "Inter" \|/);
  assert.match(md, /\| flag \| BOOLEAN \| true \|/);
});

test('Variables roundtrip: parseDesignMd reads the JSON variables block back', () => {
  const md = generateDesignMd({ ...EXTRACTION, variables: FIXTURE_VARS });
  const dir = mkdtempSync(join(tmpdir(), 'extract-vars-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file);
  const pp = parsed.tokens.variables['Primer Primitives'];
  assert.deepEqual(pp.modes, ['Light', 'Dark']);
  assert.equal(pp.variables['fgColor-default'].values.Dark, '#e6edf3');
  // existing color/typography parsing still works alongside the new block
  assert.ok(Object.values(parsed.tokens.color).includes('#ffffff'));
});
