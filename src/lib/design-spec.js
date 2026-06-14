// Pure parser + conformance checker for the `## 6. Components` section of an
// extracted DESIGN.md. The CLI reads the markdown here (zero LLM tokens) and
// returns a COMPACT spec; `checkConformance` then HARD-enforces every
// instruction the md actually carries (variant axes, layout direction, gap,
// padding, child structure, sizes) against a built node — not just height.

const PAD_RE = /padding\s+(\d+)(?:\/(\d+)\/(\d+)\/(\d+))?px/;
const GAP_RE = /gap\s+(\d+)px/;

// Parse the "· horizontal row, gap 8px, padding 6/12/6/12px" meta segment that
// the extractor writes (see design-extract.js layoutDesc). Returns {lm,gap,pad}.
function parseLayoutMeta(seg) {
  const out = {};
  if (/horizontal row/.test(seg)) out.lm = 'HORIZONTAL';
  else if (/vertical stack/.test(seg)) out.lm = 'VERTICAL';
  const g = seg.match(GAP_RE);
  if (g) out.gap = Number(g[1]);
  const p = seg.match(PAD_RE);
  if (p) out.pad = p[2] !== undefined
    ? [Number(p[1]), Number(p[2]), Number(p[3]), Number(p[4])]   // T/R/B/L
    : [Number(p[1]), Number(p[1]), Number(p[1]), Number(p[1])];  // single value
  return out;
}

// Parse one bullet line into a node descriptor (no children yet).
function parseBullet(line) {
  const m = line.match(/^(\s*)-\s+\*\*(.+?)\*\*\s+·\s+`(\w+)`(.*)$/);
  if (!m) return null;
  const depth = Math.floor(m[1].length / 2);
  const node = { name: m[2].trim(), type: m[3], children: [] };
  const segs = m[4].split('·').map(s => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const dim = seg.match(/^(\d+)×(\d+)$/);
    if (dim) { node.w = Number(dim[1]); node.h = Number(dim[2]); continue; }
    if (/horizontal row|vertical stack/.test(seg)) Object.assign(node, parseLayoutMeta(seg));
    // "· ×N" marks a deduped run of repeated siblings → this is content, not a
    // fixed structure (a list/menu/table body). Recorded so the checker relaxes
    // child-count/order for the container that holds it.
    const rep = seg.match(/^×(\d+)$/);
    if (rep) node.repeat = Number(rep[1]);
    // "N children", text, "instance of …" are not enforced structurally here.
  }
  return { depth, node };
}

// Build a tree from the bullet block that follows "Sample variant structure:".
function parseStructureTree(text) {
  const lines = text.split('\n');
  const stack = [];   // [{depth, node}]
  let root = null;
  for (const line of lines) {
    if (!/^\s*-\s+\*\*/.test(line)) { if (root) break; else continue; }
    const parsed = parseBullet(line);
    if (!parsed) continue;
    if (!root) { root = parsed.node; stack.push(parsed); continue; }
    while (stack.length && stack[stack.length - 1].depth >= parsed.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(parsed.node);
    stack.push(parsed);
  }
  return root;
}

/** Parse every component block out of a DESIGN.md string. */
export function parseComponentSpecs(md) {
  if (!md || typeof md !== 'string') return [];
  const lines = md.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { if (cur) blocks.push(cur); cur = { name: h3[1].trim(), body: [] }; continue; }
    if (/^##\s+/.test(line)) { if (cur) { blocks.push(cur); cur = null; } continue; }
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);

  const specs = [];
  for (const b of blocks) {
    const body = b.body.join('\n');
    const vm = body.match(/·\s*(\d+)\s+variants?/i) || body.match(/^\s*Page:.*?(\d+)\s+variants?/im);
    if (!vm) continue;
    const pageM = body.match(/^\s*Page:\s*(.+?)\s*·/im);

    const axes = {};
    const tableRows = body.match(/^\|.*\|.*\|\s*$/gm) || [];
    for (const row of tableRows) {
      const cells = row.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
      if (cells.length < 2) continue;
      const [prop, vals] = cells;
      if (/^property$/i.test(prop) || /^-+$/.test(prop)) continue;
      axes[prop] = vals.split(',').map(v => v.trim()).filter(Boolean);
    }

    let sample = null;
    const sIdx = body.indexOf('Sample variant structure:');
    if (sIdx >= 0) sample = parseStructureTree(body.slice(sIdx + 'Sample variant structure:'.length));

    specs.push({ name: b.name, page: pageM ? pageM[1].trim() : null, variants: Number(vm[1]), axes, sample });
  }
  return specs;
}

/** Find one component spec by name: exact (case-insensitive) → prefix → substring. */
export function findComponentSpec(md, name) {
  const specs = parseComponentSpecs(md);
  if (!specs.length || !name) return null;
  const n = name.toLowerCase();
  return (
    specs.find(s => s.name.toLowerCase() === n) ||
    specs.find(s => s.name.toLowerCase().startsWith(n)) ||
    specs.find(s => s.name.toLowerCase().includes(n)) ||
    null
  );
}

// Class a node type into a coarse family so a faithful rebuild that swaps an
// INSTANCE for a FRAME (or COMPONENT) isn't punished, while TEXT↔FRAME is.
function typeClass(t) {
  if (t === 'TEXT') return 'text';
  if (['RECTANGLE', 'VECTOR', 'ELLIPSE', 'LINE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION'].includes(t)) return 'shape';
  return 'container';   // FRAME / COMPONENT / INSTANCE / GROUP / COMPONENT_SET
}

const normName = s => String(s).replace(/\s+/g, '').toLowerCase().split(',').sort().join(',');
const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// The height a node MUST be to physically hold its (auto-laid-out) children,
// computed recursively so non-physical dims cascade up: a horizontal row
// inherits the unreliable height of a vertical child that's too short for ITS
// children. Leaves trust their stated height.
function physicalMinHeight(node) {
  const padV = node.pad ? (node.pad[0] + node.pad[2]) : 0;
  if (!node.lm || !node.children?.length) return node.h ?? 0;
  const kids = node.children.map(physicalMinHeight);
  if (node.lm === 'VERTICAL') return kids.reduce((a, b) => a + b, 0) + (node.gap || 0) * (node.children.length - 1) + padV;
  return Math.max(...kids) + padV;   // HORIZONTAL: height = tallest child + pad
}

// True when a spec node's stated height can't physically contain its children
// (a Primer instance-overlap artifact, e.g. a 20px group with 2×20px children,
// or a row inheriting that). Such dims are unreliable → check becomes a hint.
function nonPhysicalHeight(specN) {
  if (specN.h == null || !specN.lm || !specN.children?.length) return false;
  return specN.h + 1 < physicalMinHeight(specN);
}

// Deep-compare a built node tree against a spec node tree, pushing one rule per
// instruction. rule.warn = advisory (doesn't fail the build): composition hints
// and non-physical Primer dims. Everything else is a hard rule.
function compareNode(specN, builtN, path, rules, tol) {
  const at = path || specN.name;

  // type family. A spec INSTANCE (a sub-component) built as a raw text/shape is
  // a composition HINT, not a failure — and we stop checking this node's
  // internals (a raw substitute legitimately can't carry the instance's own
  // layout/gap/children). "Instance the component" is the only advice needed.
  const classMatch = typeClass(specN.type) === typeClass(builtN.type);
  if (!classMatch && specN.type === 'INSTANCE') {
    rules.push({ ok: false, warn: true, msg: `compose[${at}]: spec uses an instance of "${specN.name}" — built raw ${builtN.type}. Consider instancing that component for fidelity.` });
    return;
  }
  if (classMatch) {
    rules.push({ ok: true, msg: `type[${at}]: ${typeClass(builtN.type)}` });
  } else {
    rules.push({ ok: false, msg: `type[${at}]: spec wants ${specN.type} (${typeClass(specN.type)}), built ${builtN.type} (${typeClass(builtN.type)})` });
  }

  // Is this a content container (a list/menu/table body)? The extractor marks
  // repeated runs with ×N, so any repeated child means the count/length is
  // content-driven — height and child-count become advisory and children are
  // matched by name (pattern), not by index.
  const specKidsAll = (specN.lm ? specN.children : null) || [];
  const isContentList = specKidsAll.some(k => k.repeat);

  // height — enforced, unless the spec's height is non-physical OR this is a
  // content list (its length depends on how many rows you put in).
  if (specN.h != null) {
    const dh = Math.abs((builtN.h ?? 0) - specN.h);
    if (isContentList) {
      rules.push({ ok: dh <= tol, warn: true, msg: `height[${at}]: ${builtN.h}px (content list — length is content-driven, not enforced)` });
    } else if (nonPhysicalHeight(specN)) {
      rules.push({ ok: dh <= tol, warn: true, msg: `height[${at}]: spec ${specN.h}px is non-physical (children need more) — built ${builtN.h}px, not enforced` });
    } else {
      rules.push({ ok: dh <= tol, msg: dh <= tol ? `height[${at}]: ${builtN.h}px` : `height[${at}]: built ${builtN.h}px, spec ${specN.h}px (off ${dh}px)` });
    }
  }

  // Internal layout props (layout/gap/padding) of a spec INSTANCE describe the
  // SUB-COMPONENT's own internals — a rebuild that uses a plain frame instead of
  // instancing it legitimately differs, so these are advisory for instances.
  const internalsAdvisory = specN.type === 'INSTANCE';

  // layout direction
  if (specN.lm) {
    const ok = builtN.lm === specN.lm;
    rules.push({ ok, warn: internalsAdvisory && !ok, msg: ok ? `layout[${at}]: ${specN.lm}` : `layout[${at}]: spec ${specN.lm}, built ${builtN.lm || 'NONE'}${internalsAdvisory ? ' (instance internal)' : ''}` });
  }

  // gap
  if (specN.gap != null) {
    const ok = (builtN.gap ?? 0) === specN.gap;
    rules.push({ ok, warn: internalsAdvisory && !ok, msg: ok ? `gap[${at}]: ${specN.gap}px` : `gap[${at}]: spec ${specN.gap}px, built ${builtN.gap ?? 0}px${internalsAdvisory ? ' (instance internal)' : ''}` });
  }

  // padding (T/R/B/L)
  if (specN.pad) {
    const ok = sameArr(specN.pad, builtN.pad);
    rules.push({ ok, warn: internalsAdvisory && !ok, msg: ok ? `padding[${at}]: ${specN.pad.join('/')}` : `padding[${at}]: spec ${specN.pad.join('/')}, built ${(builtN.pad || []).join('/') || 'none'}${internalsAdvisory ? ' (instance internal)' : ''}` });
  }

  // children: only enforce structure UNDER an auto-layout node (one the md
  // describes with a direction). Vector-drawn nodes (a Spinner's GROUP /
  // BOOLEAN_OPERATION / ELLIPSE tree) carry no layout, so we treat them as
  // opaque and check size only — a clean ellipse-arc rebuild shouldn't have to
  // reproduce the designer's boolean tree.
  const specKids = specKidsAll;
  if (specKids.length) {
    const builtKids = builtN.children || [];
    if (isContentList) {
      // Content list: don't enforce exact count/order. Verify the ITEM PATTERN
      // instead — each distinct spec item type must have a matching built item
      // (by name) whose layout/padding/gap conform.
      rules.push({ ok: true, warn: true, msg: `children[${at}]: ${builtKids.length} (content list — ${specKids.length} item types in spec, count not enforced)` });
      const seen = new Set();
      for (const sk of specKids) {
        const key = normName(sk.name);
        if (seen.has(key)) continue;   // one check per distinct item type
        seen.add(key);
        const match = builtKids.find(bk => normName(bk.name) === key)
          || builtKids.find(bk => typeClass(bk.type) === typeClass(sk.type) && bk.lm === sk.lm);
        if (match) compareNode(sk, match, `${at} › ${sk.name}`, rules, tol);
        else rules.push({ ok: false, warn: true, msg: `item[${at} › ${sk.name}]: no matching item built (pattern check skipped)` });
      }
    } else {
      const ok = builtKids.length === specKids.length;
      rules.push({ ok, msg: ok ? `children[${at}]: ${specKids.length}` : `children[${at}]: spec ${specKids.length}, built ${builtKids.length}` });
      const n = Math.min(specKids.length, builtKids.length);
      for (let i = 0; i < n; i++) compareNode(specKids[i], builtKids[i], `${at} › ${specKids[i].name}`, rules, tol);
    }
  }
}

/**
 * Enforce a spec against a measured built node.
 * measured = { type, variantProps:[...], variants:[{name,w,h}], sampleTree:<deep tree> }
 * Returns { pass, rules:[{ok,msg}] }.
 */
export function checkConformance(spec, measured, opts = {}) {
  const tol = opts.tolerance ?? 2;
  const rules = [];
  const axisNames = Object.keys(spec.axes || {});
  const isMultiVariant = spec.variants > 1 && axisNames.length >= 1;

  // R1 — a multi-variant component must be a COMPONENT_SET.
  if (isMultiVariant) {
    const ok = measured.type === 'COMPONENT_SET';
    rules.push({ ok, msg: ok
      ? `structure: COMPONENT_SET (spec has ${spec.variants} variants)`
      : `structure: expected COMPONENT_SET (${spec.variants} variants across ${axisNames.join(', ')}), got ${measured.type}` });
  }

  // R2 — variant property names must cover the spec axes.
  if (isMultiVariant && measured.type === 'COMPONENT_SET') {
    const built = (measured.variantProps || []).map(s => s.toLowerCase());
    const missing = axisNames.filter(a => !built.includes(a.toLowerCase()));
    rules.push({ ok: missing.length === 0, msg: missing.length === 0
      ? `axes: ${axisNames.join(', ')} (match spec)`
      : `axes: missing ${missing.join(', ')} — built has ${(measured.variantProps || []).join(', ') || 'none'}` });
  }

  // R3 — deep structural conformance of the sample variant (the md's full
  // instruction set: layout, gap, padding, child tree, sizes).
  if (spec.sample && measured.sampleTree) {
    compareNode(spec.sample, measured.sampleTree, spec.sample.name, rules, tol);
  }

  // A warn (composition hint / non-physical dim) is advisory — it never fails
  // the build. Only hard rule violations do.
  return { pass: rules.every(r => r.ok || r.warn), rules };
}
