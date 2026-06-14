// Pure parser for the `## 6. Components` section of an extracted DESIGN.md.
// The CLI reads the markdown here (zero LLM tokens) and returns a COMPACT spec
// — variant axes + a sample size — so recreating a component is checked against
// authoritative numbers instead of eyeballing a 600-line structure dump.

/**
 * Parse every component block out of a DESIGN.md string.
 * Each `### Name` block under the Components section carries:
 *   Page: <page> · <N> variants
 *   | Property | Values |  ... (the variant axes)
 *   Sample variant structure:
 *   - **<sample name>** · `TYPE` · WxH · ... · M children
 * @returns {Array<{name,page,variants,axes,sample}>}
 */
export function parseComponentSpecs(md) {
  if (!md || typeof md !== 'string') return [];
  const lines = md.split('\n');

  // Collect ### blocks (component headings). We only treat a ### block as a
  // component if it has a "· N variants" line — that filters out token/heading
  // noise elsewhere in the doc.
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      if (cur) blocks.push(cur);
      cur = { name: h3[1].trim(), body: [] };
      continue;
    }
    if (/^##\s+/.test(line)) {            // a new ## section ends the current block
      if (cur) { blocks.push(cur); cur = null; }
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);

  const specs = [];
  for (const b of blocks) {
    const body = b.body.join('\n');
    const vm = body.match(/·\s*(\d+)\s+variants?/i) || body.match(/^\s*Page:.*?(\d+)\s+variants?/im);
    if (!vm) continue;                    // not a component block
    const pageM = body.match(/^\s*Page:\s*(.+?)\s*·/im);

    // Variant axes from the markdown table: | Property | Values |
    const axes = {};
    const tableRows = body.match(/^\|.*\|.*\|\s*$/gm) || [];
    for (const row of tableRows) {
      const cells = row.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
      if (cells.length < 2) continue;
      const [prop, vals] = cells;
      if (/^property$/i.test(prop) || /^-+$/.test(prop)) continue;  // header / separator
      axes[prop] = vals.split(',').map(v => v.trim()).filter(Boolean);
    }

    // Sample size: first structure bullet after "Sample variant structure:".
    let sample = null;
    const sIdx = body.indexOf('Sample variant structure:');
    if (sIdx >= 0) {
      const after = body.slice(sIdx);
      const sm = after.match(/^-\s+\*\*(.+?)\*\*\s+·\s+`(\w+)`\s+·\s+(\d+)×(\d+)(?:\s+·\s+[^·]*?padding\s+([0-9/]+px))?/m);
      if (sm) {
        sample = { name: sm[1].trim(), type: sm[2], w: Number(sm[3]), h: Number(sm[4]), padding: sm[5] || null };
      }
    }

    specs.push({
      name: b.name,
      page: pageM ? pageM[1].trim() : null,
      variants: Number(vm[1]),
      axes,
      sample,
    });
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

/**
 * Enforce a spec against a measured built node. Pure: takes the spec and a
 * measurement {type, variantProps:[...], variants:[{name,w,h}]} and returns
 * { pass, rules:[{ok,msg}] }. The actual Figma measurement happens in the
 * command; keeping this pure makes it unit-testable.
 */
export function checkConformance(spec, measured, opts = {}) {
  const tol = opts.tolerance ?? 2;          // px tolerance for dimension checks
  const rules = [];
  const axisNames = Object.keys(spec.axes || {});
  const isMultiVariant = spec.variants > 1 && axisNames.length >= 1;

  // R1 — structure: a multi-variant component must be a COMPONENT_SET, not a
  // lone COMPONENT/FRAME. This catches "built 1 thing instead of the set".
  if (isMultiVariant) {
    const ok = measured.type === 'COMPONENT_SET';
    rules.push({
      ok,
      msg: ok
        ? `structure: COMPONENT_SET (spec has ${spec.variants} variants)`
        : `structure: expected a COMPONENT_SET (spec has ${spec.variants} variants across ${axisNames.join(', ')}), got ${measured.type}`,
    });
  }

  // R2 — axes: built variant property names must cover the spec's axis names.
  if (isMultiVariant && measured.type === 'COMPONENT_SET') {
    const built = (measured.variantProps || []).map(s => s.toLowerCase());
    const missing = axisNames.filter(a => !built.includes(a.toLowerCase()));
    const ok = missing.length === 0;
    rules.push({
      ok,
      msg: ok
        ? `axes: ${axisNames.join(', ')} (match spec)`
        : `axes: missing ${missing.join(', ')} — built has ${(measured.variantProps || []).join(', ') || 'none'}`,
    });
  }

  // R3 — dimensions: if a built variant matches the spec sample, its HEIGHT
  // must be within tolerance. Height is the structural spec (this is the bug
  // that made the ButtonGroup "zu hoch"). Width is content-hug — it varies with
  // font/locale — so it's reported but never fails the build.
  // Variant names are normalised order-independently so "Size=Medium,Variant=X"
  // matches the spec's "Variant=X, Size=Medium".
  if (spec.sample && measured.variants && measured.variants.length) {
    const norm = s => String(s).replace(/\s+/g, '').toLowerCase().split(',').sort().join(',');
    const match = measured.variants.find(v => norm(v.name) === norm(spec.sample.name));
    if (match) {
      const dh = Math.abs(match.h - spec.sample.h);
      const dw = Math.abs(match.w - spec.sample.w);
      const ok = dh <= tol;
      const widthNote = dw > Math.max(tol, spec.sample.w * 0.15) ? ` (width ${match.w} vs ~${spec.sample.w}, content-hug — informational)` : '';
      rules.push({
        ok,
        msg: ok
          ? `height[${spec.sample.name}]: ${match.h}px (matches spec)${widthNote}`
          : `height[${spec.sample.name}]: built ${match.h}px, spec ${spec.sample.h}px (off by ${dh}px)`,
      });
    }
  }

  return { pass: rules.every(r => r.ok), rules };
}
