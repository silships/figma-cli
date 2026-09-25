// Live regression check for the commands users already rely on. Runs against a
// connected Figma file on its own scratch page and removes that page afterwards.
//   FIGMA_FILE="Untitled" node tests/live/regression.mjs
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/index.js');
const PAGE = 'figma-cli regression';
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
const evalJson = code => {
  const last = run(['eval', code]).trim().split('\n').filter(l => !l.startsWith('note:')).pop();
  try { return JSON.parse(last); } catch { return last; }  // strings print raw
};
const idOf = out => (out.match(/Rendered: (\d+:\d+)/) || [])[1];
const ids = out => [...out.matchAll(/Rendered: (\d+:\d+)/g)].map(m => m[1]);

const results = [];
async function check(name, fn) {
  try { const detail = await fn(); results.push([name, true, detail || '']); }
  catch (e) { results.push([name, false, e.message.split('\n')[0].slice(0, 200)]); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const tmp = mkdtempSync(join(tmpdir(), 'reg-'));
const startPage = evalJson('figma.currentPage.id');
evalJson(`const p = figma.createPage(); p.name = ${JSON.stringify(PAGE)}; await figma.setCurrentPageAsync(p); return p.id`);

try {
  await check('render: card with p, gap, hex, rounded, wrapping text', () => {
    const id = idOf(run(['render', '<Frame name="Card" w={320} flex="col" p={24} gap={12} bg="#ffffff" rounded={12}><Text size={18} weight="bold" w="fill">Title</Text><Text size={14} w="fill">A long description that has to wrap onto a second line inside the card.</Text></Frame>']));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); return { w: n.width, pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft], gap: n.itemSpacing, r: n.cornerRadius, t: n.children.map(c => [c.layoutSizingHorizontal, c.textAutoResize, c.height]) }`);
    assert(r.w === 320 && r.pad.every(v => v === 24) && r.gap === 12 && r.r === 12, JSON.stringify(r));
    assert(r.t.every(t => t[0] === 'FILL') && r.t[1][2] > 20, 'text did not wrap: ' + JSON.stringify(r.t));
  });
  await check('render: px/py padding unchanged by the per-side fix', () => {
    const id = idOf(run(['render', '<Frame name="Btn" flex="row" px={16} py={8} bg="#000"><Text color="#fff">Go</Text></Frame>']));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); return [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft]`);
    assert(r.join() === '8,16,8,16', r.join());
  });
  await check('render: nested frame per-side padding', () => {
    const id = idOf(run(['render', '<Frame name="Outer" flex="col"><Frame name="Inner" flex="row" pt={1} pr={2} pb={3} pl={4}><Text>x</Text></Frame></Frame>']));
    const r = evalJson(`const n = (await figma.getNodeByIdAsync("${id}")).children[0]; return [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft]`);
    assert(r.join() === '1,2,3,4', r.join());
  });
  await check('render: auto-split of a flex wrapper into separate nodes', () => {
    const out = run(['render', '<Frame flex="row" gap={8}><Frame name="Item 1" w={40} h={40} bg="#f00" /><Frame name="Item 2" w={40} h={40} bg="#0f0" /><Frame name="Item 3" w={40} h={40} bg="#00f" /></Frame>']);
    assert(ids(out).length === 3, out.slice(0, 300));
  });
  await check('render --as-component', () => {
    const out = run(['render', '<Frame name="Chip" flex="row" p={8}><Text>Chip</Text></Frame>', '--as-component']);
    const cid = (out.match(/Converted to component: (\d+:\d+)/) || [])[1];
    assert(cid, out);
    writeFileSync(join(tmp, 'chip-id'), cid);
    return cid;
  });
  await check('render-batch --as-component: 3 separate components', () => {
    const out = run(['render-batch', '["<Frame name=\\"K1\\" w={30} h={30} bg=\\"#111\\" />","<Frame name=\\"K2\\" w={30} h={30} bg=\\"#222\\" />","<Frame name=\\"K3\\" w={30} h={30} bg=\\"#333\\" />"]', '--as-component']);
    assert((out.match(/Converted to component/g) || []).length === 3, out.slice(0, 300));
  });
  await check('<Instance component="<id>"> (old id form)', () => {
    const cid = readFileSync(join(tmp, 'chip-id'), 'utf8');
    const id = idOf(run(['render', `<Frame name="Holder" flex="row"><Instance component="${cid}" /></Frame>`]));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); const c = n.children[0]; return { type: c && c.type, main: c ? (await c.getMainComponentAsync()).id : null }`);
    assert(r.type === 'INSTANCE' && r.main === cid, JSON.stringify(r));
  });
  await check('<Instance name="Chip"> (old name form)', () => {
    const id = idOf(run(['render', '<Frame name="Holder2" flex="row"><Instance name="Chip" /></Frame>']));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); return n.children.map(c => c.type)`);
    assert(r.join() === 'INSTANCE', JSON.stringify(r));
  });
  await check('<Instance> after the component was deleted and recreated (no stale cache)', () => {
    const mk = () => evalJson(`const c = figma.createComponent(); c.name = 'Recycled'; c.resize(20, 20); return c.id`);
    const first = mk();
    idOf(run(['render', '<Frame name="R1" flex="row"><Instance component="Recycled" /></Frame>']));
    evalJson(`(await figma.getNodeByIdAsync("${first}")).remove(); return true`);
    const second = mk();
    const id = idOf(run(['render', '<Frame name="R2" flex="row"><Instance component="Recycled" /></Frame>']));
    assert(id, 'render failed');
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); return (await n.children[0].getMainComponentAsync()).id`);
    assert(r === second, r + ' != ' + second);
  });
  await check('render: shadow, opacity, icon', () => {
    const id = idOf(run(['render', '<Frame name="Fx" flex="row" p={8} shadow="0px 4px 12px rgba(0,0,0,0.25)" opacity={0.8}><Icon name="lucide:home" size={20} color="#000" /></Frame>']));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); return { fx: n.effects.map(e => e.type), o: Math.round(n.opacity * 100), kids: n.children.map(c => c.type) }`);
    assert(r.fx.includes('DROP_SHADOW') && r.o === 80 && r.kids.length === 1, JSON.stringify(r));
  });
  await check('render: var: binding to a local variable', () => {
    evalJson(`const col = figma.variables.createVariableCollection('regression'); const v = figma.variables.createVariable('reg/primary', col, 'COLOR'); v.setValueForMode(col.defaultModeId, { r: 0.1, g: 0.4, b: 0.9 }); return v.id`);
    const id = idOf(run(['render', '<Frame name="Bound" w={40} h={40} bg="var:reg/primary" />']));
    const r = evalJson(`const n = await figma.getNodeByIdAsync("${id}"); const b = n.fills[0].boundVariables?.color?.id; return b ? (await figma.variables.getVariableByIdAsync(b)).name : null`);
    assert(r === 'reg/primary', String(r));
  });
  await check('eval: expression, statements, compact JSON when piped', () => {
    assert(run(['eval', '1 + 1']).trim() === '2', 'expression');
    assert(run(['eval', 'const a = 2; return a * 3']).trim() === '6', 'statements');
    const out = run(['eval', '({ a: 1, b: [1, 2] })']).trim();
    assert(out === '{"a":1,"b":[1,2]}', out);
  });
  await check('eval: output cap on huge results', () => {
    const out = run(['eval', 'Array.from({ length: 5000 }, (_, i) => "item-" + i)']);
    assert(out.length < 21000 && out.includes('output cut'), String(out.length));
  });
  await check('variants from <ids> --property (old command)', () => {
    const out = run(['render-batch', '["<Frame name=\\"S\\" w={20} h={20} bg=\\"#aaa\\" />","<Frame name=\\"M\\" w={30} h={30} bg=\\"#aaa\\" />"]']);
    const [a, b] = ids(out);
    const v = run(['variants', 'from', `${a},${b}`, '--property', 'Size', '--values', 'Small,Medium', '--name', 'Box']);
    const r = evalJson(`await figma.loadAllPagesAsync(); const s = figma.currentPage.findOne(n => n.type === 'COMPONENT_SET' && n.name === 'Box'); return s ? Object.keys(s.variantGroupProperties) : null`);
    assert(r && r.join() === 'Size', v.slice(0, 200));
  });
  await check('shadcn add button --count 2', () => {
    const out = run(['shadcn', 'add', 'button', '--count', '2']);
    const n = (out.match(/\d+:\d+/g) || []).length;
    assert(n >= 2, out.slice(0, 300));
  });
  await check('undo removes the last render', () => {
    const id = idOf(run(['render', '<Frame name="Temp" w={10} h={10} bg="#f0f" />']));
    run(['undo']);
    const r = evalJson(`return !!(await figma.getNodeByIdAsync("${id}"))`);
    assert(r === false, 'node still there');
  });
} finally {
  evalJson(`await figma.loadAllPagesAsync();
const back = await figma.getNodeByIdAsync(${JSON.stringify(startPage)});
if (back) await figma.setCurrentPageAsync(back);
for (const p of figma.root.children.filter(p => p.name === ${JSON.stringify(PAGE)})) p.remove();
for (const c of await figma.variables.getLocalVariableCollectionsAsync()) if (c.name === 'regression') c.remove();
return true`);
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + (ok ? '' : '→ ') + detail : ''));
}
console.log(`\n${results.length - failed}/${results.length} regression checks passed`);
process.exit(failed ? 1 : 0);
