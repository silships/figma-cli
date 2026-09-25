#!/usr/bin/env node
/**
 * Auto-layout patterns — a runnable gallery.
 *
 * Renders one labelled example of each auto-layout shape that used to go wrong,
 * onto a page called "Auto-Layout Patterns". Every pattern here is verified by
 * MEASUREMENT after rendering, not by looking at it: the script asserts the real
 * width/height and sizing modes Figma ended up with, and exits non-zero if any
 * of them drift. So it is both documentation and a live regression test.
 *
 *   node examples/autolayout-patterns.mjs           # render + verify
 *   node examples/autolayout-patterns.mjs --keep    # don't clear the page first
 *
 * Requires a connected Figma: node src/index.js connect
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src/index.js');
const PAGE = 'Auto-Layout Patterns';

const INK = '#fafafa';
const MUTED = '#a1a1aa';
const SURFACE = '#18181b';
const RAISED = '#27272a';
const LINE = '#3f3f46';
const ACCENT = '#3b82f6';

/**
 * Each pattern carries what it TEACHES and what must be true afterwards.
 * `expect` is keyed by node name → the properties that must hold.
 */
const PATTERNS = [
  {
    name: 'Card',
    teaches: 'Text wraps only when the parent AND every Text carry w="fill".',
    jsx: `<Frame name="Card" flex="col" gap={8} p={16} w={260} bg="${SURFACE}" rounded={12}>
  <Text w="fill" size={15} weight="semibold" color="${INK}">Wireless Noise-Canceling Headphones</Text>
  <Text w="fill" size={13} color="${MUTED}">Both the frame and the text need a width, or the label clips to one line.</Text>
</Frame>`,
    expect: {
      Card: { w: 260, hz: 'FIXED', vt: 'HUG' },
      'Wireless Noise-Canceling Headphones': { hz: 'FILL', minH: 34 },
    },
  },
  {
    name: 'Navbar',
    teaches: 'justify="between" pushes children to opposite edges.',
    jsx: `<Frame name="Navbar" flex="row" justify="between" items="center" w={360} h={52} px={16} bg="${SURFACE}" rounded={10}>
  <Text size={14} weight="bold" color="${INK}">Logo</Text>
  <Frame name="NavActions" flex="row" gap={12} items="center">
    <Text size={13} color="${MUTED}">Docs</Text>
    <Frame name="NavCta" flex="row" justify="center" items="center" px={12} py={6} bg="${ACCENT}" rounded={8}>
      <Text size={13} weight="medium" color="${INK}">Sign in</Text>
    </Frame>
  </Frame>
</Frame>`,
    expect: {
      Navbar: { w: 360, h: 52, pri: 'SPACE_BETWEEN', cnt: 'CENTER' },
    },
  },
  {
    name: 'Divider row',
    teaches: 'A 1px divider fills the row height. Siblings set that height — no fixed height needed.',
    jsx: `<Frame name="DividerRow" flex="row" gap={12} items="center" p={12} bg="${SURFACE}" rounded={10}>
  <Text size={13} color="${INK}">Overview</Text>
  <Frame name="Rule" w={1} stretch={true} bg="${LINE}" />
  <Text size={13} color="${MUTED}">Settings</Text>
</Frame>`,
    expect: {
      Rule: { w: 1, vt: 'FILL', maxH: 24 },
      DividerRow: { vt: 'HUG', maxH: 44 },
    },
  },
  {
    name: 'Toggles',
    teaches: 'Toggle knobs use justify start/end, never absolute positioning.',
    jsx: `<Frame name="Toggles" flex="row" gap={12} items="center" p={12} bg="${SURFACE}" rounded={10}>
  <Frame name="ToggleOn" w={52} h={28} bg="${ACCENT}" rounded={14} flex="row" items="center" p={2} justify="end">
    <Frame name="KnobOn" w={24} h={24} bg="#ffffff" rounded={12} />
  </Frame>
  <Frame name="ToggleOff" w={52} h={28} bg="${RAISED}" rounded={14} flex="row" items="center" p={2} justify="start">
    <Frame name="KnobOff" w={24} h={24} bg="#52525b" rounded={12} />
  </Frame>
</Frame>`,
    expect: {
      ToggleOn: { w: 52, h: 28, pri: 'MAX' },
      ToggleOff: { w: 52, h: 28, pri: 'MIN' },
      KnobOn: { w: 24, h: 24 },
    },
  },
  {
    name: 'Sidebar',
    teaches: 'A grow spacer pushes the last item to the bottom of a fixed-height column.',
    jsx: `<Frame name="Sidebar" flex="col" gap={8} p={12} w={180} h={220} bg="${SURFACE}" rounded={12}>
  <Text size={13} weight="semibold" color="${INK}">Workspace</Text>
  <Text size={13} color="${MUTED}">Projects</Text>
  <Text size={13} color="${MUTED}">Members</Text>
  <Frame name="Spacer" grow={1} />
  <Frame name="Account" flex="row" gap={8} items="center" w="fill" p={8} bg="${RAISED}" rounded={8}>
    <Frame name="Avatar" w={20} h={20} rounded={10} bg="${ACCENT}" />
    <Text size={12} color="${INK}">Sil</Text>
  </Frame>
</Frame>`,
    expect: {
      Sidebar: { w: 180, h: 220, hz: 'FIXED', vt: 'FIXED' },
      Spacer: { vt: 'FILL' },
      Account: { hz: 'FILL' },
    },
  },
  {
    name: 'Wrap grid',
    teaches: 'wrap={true} flows to the next row. rowGap spaces the rows.',
    jsx: `<Frame name="WrapGrid" flex="row" wrap={true} gap={8} rowGap={8} w={228} p={12} bg="${SURFACE}" rounded={12}>
  <Frame name="Chip1" w={96} h={36} bg="${RAISED}" rounded={8} />
  <Frame name="Chip2" w={96} h={36} bg="${RAISED}" rounded={8} />
  <Frame name="Chip3" w={96} h={36} bg="${RAISED}" rounded={8} />
  <Frame name="Chip4" w={96} h={36} bg="${RAISED}" rounded={8} />
</Frame>`,
    expect: {
      WrapGrid: { w: 228, wrap: 'WRAP', minH: 90 },
    },
  },
  {
    name: 'Constrained',
    teaches: 'maxW clamps a filling child; minH holds a floor.',
    jsx: `<Frame name="Constrained" flex="col" gap={8} p={12} w={260} bg="${SURFACE}" rounded={12}>
  <Frame name="Clamped" w="fill" maxW={160} h={24} bg="${ACCENT}" rounded={6} />
  <Frame name="Floored" flex="col" justify="center" w="fill" minH={48} p={8} bg="${RAISED}" rounded={6}>
    <Text size={12} color="${MUTED}">One short line, held at 48px</Text>
  </Frame>
</Frame>`,
    expect: {
      // maxW clamps the fill; minH lifts a frame that would hug to ~32.
      Clamped: { w: 160 },
      Floored: { h: 48, hz: 'FILL' },
    },
  },
  {
    name: 'Fill chain',
    teaches: 'FILL cascades: a fixed shell, a growing body, a fixed footer.',
    jsx: `<Frame name="FillChain" flex="col" gap={8} p={12} w={240} h={180} bg="#09090b" rounded={12}>
  <Frame name="Body" flex="row" gap={8} w="fill" grow={1} p={8} bg="${SURFACE}" rounded={8}>
    <Frame name="Main" w="fill" h="fill" bg="${RAISED}" rounded={6} />
    <Frame name="Rail" w={48} h="fill" bg="${LINE}" rounded={6} />
  </Frame>
  <Frame name="Footer" flex="row" items="center" justify="center" w="fill" h={36} bg="${SURFACE}" rounded={8}>
    <Text size={12} color="${MUTED}">Fixed footer</Text>
  </Frame>
</Frame>`,
    expect: {
      FillChain: { w: 240, h: 180 },
      Body: { hz: 'FILL', vt: 'FILL' },
      Main: { hz: 'FILL', vt: 'FILL' },
      Footer: { hz: 'FILL', h: 36 },
    },
  },
  {
    name: 'Z-stack',
    teaches: 'flex="none" stops auto-layout so children overlap at their own x/y.',
    jsx: `<Frame name="ZStack" flex="none" w={64} h={64}>
  <Frame name="Face" w={64} h={64} rounded={32} bg="${ACCENT}" />
  <Frame name="Badge" x={44} y={44} w={20} h={20} rounded={10} bg="#22c55e" stroke="${SURFACE}" strokeWidth={2} />
</Frame>`,
    expect: {
      ZStack: { w: 64, h: 64, mode: 'NONE' },
      Face: { w: 64, h: 64 },
      Badge: { w: 20, h: 20 },
    },
  },
];

const cli = (args) =>
  execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });

const evalIn = (code) => {
  const line = cli(['eval', code]).trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

function main() {
  const keep = process.argv.includes('--keep');

  // Remember where the user was. This script builds on its own page, and
  // without --keep it must leave the file exactly as it found it.
  const previousPage = evalIn(`(async () => {
    let p = figma.root.children.find(c => c.name === ${JSON.stringify(PAGE)});
    const prev = figma.currentPage.id;
    if (!p) { p = figma.createPage(); p.name = ${JSON.stringify(PAGE)}; }
    await figma.setCurrentPageAsync(p);
    ${keep ? '' : 'for (const c of [...p.children]) c.remove();'}
    return prev;
  })()`);

  // Caption above each example, so the page reads as documentation.
  const frames = PATTERNS.flatMap((p) => [
    `<Frame name="${p.name} — label" flex="col" gap={4} w={280}>
       <Text w="fill" size={12} weight="bold" color="${INK}">${p.name}</Text>
       <Text w="fill" size={11} color="${MUTED}">${p.teaches}</Text>
     </Frame>`,
    p.jsx,
  ]);

  const out = cli(['render-batch', JSON.stringify(frames), '--direction', 'col', '--gap', '28']);
  const warned = out.includes('auto-layout problem');
  console.log(out.trim().split('\n').filter((l) => l.includes('frames created') || l.includes('⚠')).join('\n'));

  // Verify by numbers. Indexed by name, but ONLY over container nodes: a Text
  // node is named after its own content in Figma, so a <Text>Footer</Text>
  // inside a frame called "Footer" would overwrite the frame's measurements and
  // report a bug that isn't there (it did, while this file was being written).
  const measured = evalIn(`(async () => {
    const page = figma.root.children.find(p => p.name === ${JSON.stringify(PAGE)});
    const seen = {};
    const collisions = [];
    const measure = (n) => ({
      w: Math.round(n.width), h: Math.round(n.height),
      hz: n.layoutSizingHorizontal || null, vt: n.layoutSizingVertical || null,
      mode: n.layoutMode || null, pri: n.primaryAxisAlignItems || null,
      cnt: n.counterAxisAlignItems || null, wrap: n.layoutWrap || null,
    });
    const walk = (n, fn) => { fn(n); if (n.children) n.children.forEach((c) => walk(c, fn)); };

    // Containers first, and a duplicate among THEM is a real ambiguity.
    page.children.forEach((c) => walk(c, (n) => {
      if (n.type === 'TEXT') return;
      if (seen[n.name]) collisions.push(n.name);
      seen[n.name] = measure(n);
    }));
    // Then text, which can be asserted on too — but never overwrites a frame.
    page.children.forEach((c) => walk(c, (n) => {
      if (n.type === 'TEXT' && !seen[n.name]) seen[n.name] = measure(n);
    }));
    return JSON.stringify({ seen, collisions });
  })()`);

  if (measured.collisions.length) {
    console.log(`✗ duplicate frame names, measurements are ambiguous: ${[...new Set(measured.collisions)].join(', ')}`);
    process.exit(1);
  }

  let failures = 0;
  for (const p of PATTERNS) {
    const problems = [];
    for (const [nodeName, want] of Object.entries(p.expect)) {
      const got = measured.seen[nodeName];
      if (!got) {
        problems.push(`${nodeName}: not found on the page`);
        continue;
      }
      for (const [key, value] of Object.entries(want)) {
        if (key === 'minH') {
          if (got.h < value) problems.push(`${nodeName}.h ${got.h} < ${value}`);
        } else if (key === 'maxH') {
          if (got.h > value) problems.push(`${nodeName}.h ${got.h} > ${value}`);
        } else if (got[key] !== value) {
          problems.push(`${nodeName}.${key} = ${JSON.stringify(got[key])}, expected ${JSON.stringify(value)}`);
        }
      }
    }
    if (problems.length) {
      failures++;
      console.log(`✗ ${p.name}`);
      for (const problem of problems) console.log(`    ${problem}`);
    } else {
      console.log(`✓ ${p.name}`);
    }
  }

  console.log(`\n${PATTERNS.length - failures}/${PATTERNS.length} patterns match their expected layout`);
  if (warned) console.log('note: render reported an auto-layout warning above — none of these patterns should trigger one');
  if (!keep) teardown(previousPage);
  else console.log(`kept on page "${PAGE}" — run without --keep to clean up`);
  process.exit(failures || warned ? 1 : 0);
}

/** Remove the scratch page and put the user back where they were. */
function teardown(previousPageId) {
  try {
    evalIn(`(async () => {
      await figma.loadAllPagesAsync();
      const p = figma.root.children.find(c => c.name === ${JSON.stringify(PAGE)});
      const prev = ${JSON.stringify(String(previousPageId || ''))};
      const back = prev ? await figma.getNodeByIdAsync(prev) : null;
      if (back && back.type === 'PAGE') await figma.setCurrentPageAsync(back);
      else if (p) { const other = figma.root.children.find(x => x !== p); if (other) await figma.setCurrentPageAsync(other); }
      if (p) p.remove();
      return 'torn down';
    })()`);
  } catch (e) {
    // Best effort — never mask the real result, but do say so: a silent
    // teardown failure is how scratch pages accumulate in someone's file.
    console.error(`⚠ teardown failed: ${e && e.message ? e.message.split('\n')[0] : e}`);
  }
}

try {
  main();
} catch (e) {
  // A crash must not leave the scratch page behind either.
  teardown(null);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}
