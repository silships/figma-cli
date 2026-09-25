#!/usr/bin/env node
/**
 * Live auto-layout parity harness.
 *
 * `render` and `render-batch` still run through two different code generators
 * (generateCode vs generateBatchCode). This renders the SAME JSX through both
 * and compares the resulting node trees by NUMBERS — size, sizing modes,
 * alignment, wrap, grow — instead of by eyeballing a screenshot. Any difference
 * is a bug: identical JSX must produce identical layout, whichever command
 * created it.
 *
 * This is how the original divergence was found. When it first ran, 9 of 10
 * cases differed (nested frames defaulted to a row and to centered content,
 * min/max was silently dropped, and plain `render` delegated to the external
 * `figma-use` binary, which agreed with neither).
 *
 * Requires a connected Figma (node src/index.js connect). It works in a
 * scratch page called "CLI Lab" and clears that page between cases.
 *
 *   node tests/live/parity-harness.mjs            # run all cases
 *   node tests/live/parity-harness.mjs divider    # filter by case name
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'src/index.js');
const PAGE = 'CLI Lab';

const cli = (args, input) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });

const evalIn = (code) => {
  const out = cli(['eval', code]);
  const line = out.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

/**
 * Each case is JSX with a `%s` placeholder in every name= attribute so the two
 * runs can be told apart on the canvas.
 */
export const CASES = [
  {
    name: 'row-hug-with-divider',
    jsx: `<Frame name="%s-root" flex="row" gap={12} items="center" p={8} bg="#18181b">
  <Text size={13} color="#a1a1aa">Left</Text>
  <Frame name="%s-div" w={1} stretch={true} bg="#3f3f46" />
  <Text size={13} color="#a1a1aa">Right</Text>
</Frame>`,
  },
  {
    name: 'col-fill-text-wrap',
    jsx: `<Frame name="%s-root" flex="col" gap={8} p={16} w={280} bg="#18181b">
  <Text size={16} weight="semibold" color="#ffffff" w="fill">A deliberately long headline that has to wrap onto several lines</Text>
  <Text size={13} color="#a1a1aa" w="fill">And a description that also has to wrap instead of being clipped.</Text>
</Frame>`,
  },
  {
    name: 'nested-fill-chain',
    jsx: `<Frame name="%s-root" flex="col" w={320} h={200} bg="#09090b" p={12} gap={12}>
  <Frame name="%s-a" flex="row" w="fill" grow={1} bg="#18181b" p={8} gap={8}>
    <Frame name="%s-a1" w="fill" h="fill" bg="#27272a" />
    <Frame name="%s-a2" w={64} h="fill" bg="#3f3f46" />
  </Frame>
  <Frame name="%s-b" flex="row" w="fill" h={40} bg="#18181b" />
</Frame>`,
  },
  {
    name: 'space-between-navbar',
    jsx: `<Frame name="%s-root" flex="row" justify="between" items="center" w={480} h={56} px={16} bg="#18181b">
  <Text size={15} weight="bold" color="#ffffff">Logo</Text>
  <Frame name="%s-actions" flex="row" gap={8} items="center">
    <Text size={13} color="#a1a1aa">One</Text>
    <Text size={13} color="#a1a1aa">Two</Text>
  </Frame>
</Frame>`,
  },
  {
    name: 'wrap-grid',
    jsx: `<Frame name="%s-root" flex="row" wrap={true} gap={8} rowGap={8} w={220} p={12} bg="#18181b">
  <Frame name="%s-c1" w={96} h={40} bg="#27272a" rounded={6} />
  <Frame name="%s-c2" w={96} h={40} bg="#27272a" rounded={6} />
  <Frame name="%s-c3" w={96} h={40} bg="#27272a" rounded={6} />
  <Frame name="%s-c4" w={96} h={40} bg="#27272a" rounded={6} />
</Frame>`,
  },
  {
    name: 'grow-spacer-row',
    jsx: `<Frame name="%s-root" flex="row" items="center" w={400} h={44} px={12} gap={8} bg="#18181b">
  <Text size={13} color="#ffffff">Start</Text>
  <Frame name="%s-spacer" grow={1} />
  <Text size={13} color="#a1a1aa">End</Text>
</Frame>`,
  },
  {
    name: 'min-max-constraints',
    jsx: `<Frame name="%s-root" flex="col" gap={8} p={12} w={300} bg="#18181b">
  <Frame name="%s-box" w="fill" minH={60} maxW={200} h={30} bg="#27272a" />
</Frame>`,
  },
  {
    name: 'stretch-in-fixed-row',
    jsx: `<Frame name="%s-root" flex="row" gap={8} items="center" w={320} h={48} px={12} bg="#18181b">
  <Frame name="%s-btn" px={12} py={6} bg="#3b82f6" rounded={6} flex="row" justify="center" items="center">
    <Text size={13} color="#ffffff">Go</Text>
  </Frame>
  <Frame name="%s-sep" w={1} stretch={true} bg="#3f3f46" />
  <Frame name="%s-fillbox" grow={1} stretch={true} bg="#27272a" />
</Frame>`,
  },
  {
    name: 'deep-hug-cascade',
    jsx: `<Frame name="%s-root" flex="col" p={12} gap={8} bg="#18181b">
  <Frame name="%s-l1" flex="col" gap={6} bg="#27272a" p={8}>
    <Frame name="%s-l2" flex="row" gap={6} items="center" bg="#3f3f46" p={6}>
      <Text size={12} color="#ffffff">Deep</Text>
      <Frame name="%s-dot" w={8} h={8} rounded={4} bg="#22c55e" />
    </Frame>
  </Frame>
</Frame>`,
  },
  {
    name: 'align-defaults-col',
    jsx: `<Frame name="%s-root" flex="col" gap={8} p={12} w={200} bg="#18181b">
  <Text size={13} color="#ffffff">Item one</Text>
  <Text size={13} color="#a1a1aa">Two</Text>
  <Frame name="%s-pill" px={10} py={4} bg="#27272a" rounded={999} flex="row">
    <Text size={12} color="#ffffff">Pill</Text>
  </Frame>
</Frame>`,
  },
];

const MEASURE = (rootName) => `(async () => {
  const walk = (n) => ({
    n: n.name.replace(/^(EXT|INT)-/, ''),
    t: n.type,
    w: Math.round(n.width * 100) / 100,
    h: Math.round(n.height * 100) / 100,
    hz: n.layoutSizingHorizontal || null,
    vt: n.layoutSizingVertical || null,
    mode: n.layoutMode || null,
    pri: n.primaryAxisAlignItems || null,
    cnt: n.counterAxisAlignItems || null,
    wrap: n.layoutWrap || null,
    grow: n.layoutGrow === undefined ? null : n.layoutGrow,
    align: n.layoutAlign || null,
    kids: n.children ? n.children.map(walk) : undefined,
  });
  const page = figma.root.children.find(p => p.name === ${JSON.stringify(PAGE)});
  const root = page && page.children.find(c => c.name === ${JSON.stringify(rootName)});
  return JSON.stringify(root ? walk(root) : null);
})()`;

const diff = (a, b, trail = 'root', out = []) => {
  if (!a || !b) {
    out.push(`${trail}: missing (${a ? 'render only' : 'batch only'})`);
    return out;
  }
  for (const k of ['t', 'w', 'h', 'hz', 'vt', 'mode', 'pri', 'cnt', 'wrap', 'grow', 'align']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      out.push(`${trail}.${k}: render=${JSON.stringify(a[k])} batch=${JSON.stringify(b[k])}`);
    }
  }
  const ak = a.kids || [];
  const bk = b.kids || [];
  if (ak.length !== bk.length) {
    out.push(`${trail}.children: render=${ak.length} batch=${bk.length}`);
  }
  for (let i = 0; i < Math.min(ak.length, bk.length); i++) {
    diff(ak[i], bk[i], `${trail}>${ak[i].n || i}`, out);
  }
  return out;
};

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

async function main() {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;

  // Remember where the user was: the harness switches pages to build on its
  // own scratch page, and leaving them somewhere else (or leaving the scratch
  // page behind at all) is debris in someone's real file.
  const previousPage = evalIn(`(async () => {
    let p = figma.root.children.find(c => c.name === ${JSON.stringify(PAGE)});
    const prev = figma.currentPage.id;
    if (!p) { p = figma.createPage(); p.name = ${JSON.stringify(PAGE)}; }
    await figma.setCurrentPageAsync(p);
    for (const c of [...p.children]) c.remove();
    return prev;
  })()`);

  let failed = 0;
  const timing = { single: 0, batch: 0 };

  for (const c of cases) {
    const ext = c.jsx.replace(/%s/g, 'EXT');
    const int = c.jsx.replace(/%s/g, 'INT');

    let t = Date.now();
    cli(['render', ext, '--no-smart-position', '-x', '0', '-y', '0']);
    timing.single += Date.now() - t;

    t = Date.now();
    cli(['render-batch', JSON.stringify([int])]);
    timing.batch += Date.now() - t;

    const a = evalIn(MEASURE('EXT-root'));
    const b = evalIn(MEASURE('INT-root'));
    const d = diff(a, b);

    if (d.length) {
      failed++;
      console.log(`\n✗ ${c.name}`);
      for (const line of d) console.log(`    ${line}`);
    } else {
      console.log(`✓ ${c.name}`);
    }

    evalIn(`(async () => {
      const p = figma.root.children.find(c => c.name === ${JSON.stringify(PAGE)});
      for (const c of [...p.children]) c.remove();
      return 'ok';
    })()`);
  }

  console.log(
    `\n${cases.length - failed}/${cases.length} cases match` +
      `   render ${timing.single}ms · render-batch ${timing.batch}ms` +
      `   (${(timing.single / Math.max(timing.batch, 1)).toFixed(1)}x)`
  );
  teardown(previousPage);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A case that throws must not leave the scratch page behind either.
  main().catch((e) => {
    teardown(null);
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}
