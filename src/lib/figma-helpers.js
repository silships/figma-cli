// Helpers that run INSIDE Figma, shared by `render` (<Instance>, effectStyle,
// textStyle) and by `eval` (as $page, $var, $bind, $instance, $fontSafe,
// $style). One implementation, so the missing-font handling below behaves the
// same whichever command an agent reaches for.
//
// Why they exist: a component whose text uses a font that is not installed
// cannot be relabelled, and Figma even refuses to appendChild the instance into
// a frame ("unloaded font"). Without help an agent rediscovers that by trial
// and error on every task. Here it is handled once.
//
// Kept as a source string because it is evaluated in the Figma sandbox, not in
// Node. It installs itself on globalThis and is idempotent per version.

export const HELPERS_VERSION = 6;

export const HELPERS_SOURCE = `
if (!globalThis.__figHelpers || globalThis.__figHelpers.v !== ${HELPERS_VERSION}) {
  const H = { v: ${HELPERS_VERSION} };
  // Notes for the caller (deduplicated). eval and render reset and print them.
  H.note = (msg) => { (globalThis.__figNotes || (globalThis.__figNotes = new Set())).add(msg); };
  let pagesLoaded = false;
  const loadPages = async () => { if (!pagesLoaded) { await figma.loadAllPagesAsync(); pagesLoaded = true; } };
  let fontList = null;
  const available = async (f) => {
    if (!fontList) fontList = new Set((await figma.listAvailableFontsAsync()).map(x => x.fontName.family + '|' + x.fontName.style));
    return fontList.has(f.family + '|' + f.style);
  };
  const FALLBACK = 'Inter';
  const fallbackStyle = (style) => {
    const s = String(style || '').toLowerCase();
    if (s.includes('black') || s.includes('heavy')) return 'Black';
    if (s.includes('extra') && s.includes('bold')) return 'Extra Bold';
    if (s.includes('semi') || s.includes('demi')) return 'Semi Bold';
    if (s.includes('bold')) return 'Bold';
    if (s.includes('medium')) return 'Medium';
    if (s.includes('light')) return 'Light';
    return 'Regular';
  };

  // Make every text under node editable: load installed fonts, swap missing
  // ones to Inter (same weight). Returns the list of swapped fonts.
  H.fontSafe = async (node) => {
    const texts = node.type === 'TEXT' ? [node] : (node.findAllWithCriteria ? node.findAllWithCriteria({ types: ['TEXT'] }) : []);
    const swapped = new Set();
    for (const t of texts) {
      const fonts = t.fontName === figma.mixed ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
      let missing = false;
      for (const f of fonts) {
        if (await available(f)) await figma.loadFontAsync(f); else missing = true;
      }
      if (missing) {
        const style = fallbackStyle((fonts[0] || {}).style);
        const f = { family: FALLBACK, style };
        try { await figma.loadFontAsync(f); } catch (e) { f.style = 'Regular'; await figma.loadFontAsync(f); }
        for (const old of fonts) swapped.add(old.family + ' ' + old.style);
        t.fontName = f;
      }
    }
    return [...swapped];
  };

  // Page by name: switch to it, create it when missing.
  H.page = async (name) => {
    await loadPages();
    let p = figma.root.children.find(p => p.name === name);
    if (!p) { p = figma.createPage(); p.name = name; }
    await figma.setCurrentPageAsync(p);
    return p;
  };

  let varIndex = null;
  H.variable = async (name) => {
    if (!varIndex || !varIndex.has(name)) {
      varIndex = new Map();
      for (const v of await figma.variables.getLocalVariablesAsync()) if (!varIndex.has(v.name)) varIndex.set(v.name, v);
    }
    const v = varIndex.get(name);
    if (!v) throw new Error('Variable not found: ' + name);
    return v;
  };

  // Bind a variable to fills (default), strokes, or any bindable field.
  H.bind = async (node, name, field = 'fills') => {
    const v = await H.variable(name);
    if (field === 'fills' || field === 'strokes') {
      const base = (Array.isArray(node[field]) && node[field][0] && node[field][0].type === 'SOLID') ? node[field][0] : { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } };
      node[field] = [figma.variables.setBoundVariableForPaint(base, 'color', v)];
    } else {
      node.setBoundVariable(field, v);
    }
    return node;
  };

  H.style = async (name) => {
    const all = [
      ...(await figma.getLocalTextStylesAsync()), ...(await figma.getLocalEffectStylesAsync()),
      ...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalGridStylesAsync()),
    ];
    const s = all.find(s => s.name === name);
    if (!s) throw new Error('Style not found: ' + name);
    return s;
  };

  const compCache = new Map();
  // The helpers live on globalThis for the whole Figma session, so anything
  // cached here can point at a node or variable the user has since deleted.
  // Every render / eval starts with a reset (see RESET_NOTES).
  H.resetCaches = () => { compCache.clear(); varIndex = null; pagesLoaded = false; fontList = null; };
  // A component or component set by name (whole document) or by node id.
  H.component = async (ref) => {
    if (/^I?\\d+:\\d+/.test(ref)) {
      const n = await figma.getNodeByIdAsync(ref);
      if (n && (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')) return n;
    }
    if (compCache.has(ref)) return compCache.get(ref);
    await loadPages();
    const all = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] });
    const hit = all.find(n => n.type === 'COMPONENT_SET' && n.name === ref)
      || all.find(n => n.type === 'COMPONENT' && n.name === ref && (!n.parent || n.parent.type !== 'COMPONENT_SET'))
      || all.find(n => n.type === 'COMPONENT_SET' && n.name.toLowerCase() === String(ref).toLowerCase());
    if (!hit) throw new Error('Component not found: ' + ref);
    compCache.set(ref, hit);
    return hit;
  };

  // Variant of a set. "variant=danger, size=large" or {variant:'danger'}; the
  // given pairs must match, unspecified axes fall back to the default variant.
  H.variant = (set, spec) => {
    if (set.type !== 'COMPONENT_SET') return set;
    const want = {};
    if (typeof spec === 'string') {
      for (const part of spec.split(',')) { const i = part.indexOf('='); if (i > 0) want[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    } else if (spec) Object.assign(want, spec);
    const keys = Object.keys(want);
    if (!keys.length) return set.defaultVariant || set.children[0];
    const matches = set.children.filter(c => keys.every(k => String((c.variantProperties || {})[k]).toLowerCase() === String(want[k]).toLowerCase()));
    if (!matches.length) {
      const axes = Object.entries(set.variantGroupProperties || {}).map(([k, v]) => k + '=' + v.values.join('|')).join('; ');
      throw new Error('No variant of "' + set.name + '" matches ' + JSON.stringify(want) + '. Axes: ' + axes);
    }
    const def = set.defaultVariant ? set.defaultVariant.variantProperties || {} : {};
    // prefer the match closest to the default variant on the unspecified axes
    matches.sort((a, b) => {
      const score = c => Object.entries(def).filter(([k, v]) => !(k in want) && (c.variantProperties || {})[k] === v).length;
      return score(b) - score(a);
    });
    return matches[0];
  };

  // Instance of a component (set name, component name or id), font-safe.
  // opts: { variant, text, texts: {layerName: chars}, parent }
  H.instance = async (ref, variantSpec, opts = {}) => {
    const c = await H.component(ref);
    const comp = H.variant(c, variantSpec);
    const inst = comp.createInstance();
    const swapped = await H.fontSafe(inst);
    const texts = inst.findAllWithCriteria({ types: ['TEXT'] }).filter(t => t.visible);
    if (opts.text !== undefined && texts[0]) texts[0].characters = String(opts.text);
    if (opts.texts) for (const [layer, chars] of Object.entries(opts.texts)) {
      const t = inst.findOne(n => n.type === 'TEXT' && n.name === layer);
      if (t) t.characters = String(chars);
    }
    if (opts.parent) opts.parent.appendChild(inst);
    for (const f of swapped) H.note('font "' + f + '" is not installed, used Inter instead');
    return inst;
  };

  // One line per node, compact enough to replace a verification eval:
  //   Card FRAME 360x212 col gap=12 pad=24 fill=var:bgColor/muted effect=shadow/small
  //     Title TEXT 20 Inter Bold w=FILL fill=var:fgColor/default "Release notes"
  //     Button INSTANCE Button[variant=danger, size=large] "Delete"
  // Capped by depth and line count so a big tree never floods the output.
  H.describe = async (root, maxDepth = 3, maxLines = 40) => {
    const lines = [];
    const varName = async (paint) => {
      const id = paint && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id;
      if (!id) return null;
      const v = await figma.variables.getVariableByIdAsync(id);
      return v ? 'var:' + v.name : null;
    };
    const paintDesc = async (paints) => {
      if (!Array.isArray(paints) || !paints.length) return null;
      const p = paints[0];
      const v = await varName(p);
      if (v) return v;
      if (p.type === 'SOLID') return '#' + [p.color.r, p.color.g, p.color.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('') + (p.opacity !== undefined && p.opacity < 1 ? '@' + Math.round(p.opacity * 100) + '%' : '');
      return p.type.toLowerCase();
    };
    const styleName = async (id) => (typeof id === 'string' && id) ? ((await figma.getStyleByIdAsync(id)) || {}).name : null;
    const visit = async (n, depth) => {
      if (lines.length >= maxLines) return;
      try { await line(n, depth); } catch (e) { lines.push('  '.repeat(depth) + n.name + ' ' + n.type); }
      // do not descend into instances (their inside is the component's business)
      if ('children' in n && n.type !== 'INSTANCE' && depth < maxDepth) {
        for (const c of n.children) { if (lines.length >= maxLines) break; await visit(c, depth + 1); }
      }
    };
    const line = async (n, depth) => {
      const bits = [n.name, n.type];
      if ('width' in n) bits.push(Math.round(n.width) + 'x' + Math.round(n.height));
      if (n.layoutMode && n.layoutMode !== 'NONE') {
        bits.push(n.layoutMode === 'HORIZONTAL' ? 'row' : 'col');
        if (n.itemSpacing) bits.push('gap=' + n.itemSpacing);
        const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
        if (pad.some(Boolean)) bits.push('pad=' + (pad.every(v => v === pad[0]) ? pad[0] : pad.join('/')));
        if (n.layoutWrap === 'WRAP') bits.push('wrap');
      }
      // sizing mode, where it is not the plain fixed size
      const inAuto = (n.layoutMode && n.layoutMode !== 'NONE') || (n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE');
      if (inAuto && n.type !== 'TEXT' || n.type === 'TEXT' && n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE') {
        try {
          if (n.layoutSizingHorizontal && n.layoutSizingHorizontal !== 'FIXED') bits.push('w=' + n.layoutSizingHorizontal);
          if (n.layoutSizingVertical && n.layoutSizingVertical !== 'FIXED') bits.push('h=' + n.layoutSizingVertical);
        } catch (e) {}
      }
      if (n.type === 'TEXT' && n.textAutoResize === 'HEIGHT') bits.push('wraps');
      if (n.cornerRadius && n.cornerRadius !== figma.mixed) bits.push('r=' + n.cornerRadius);
      if (n.opacity !== undefined && n.opacity < 1) bits.push('opacity=' + Math.round(n.opacity * 100) / 100);
      if (n.type === 'TEXT') {
        const f = n.fontName !== figma.mixed ? n.fontName : null;
        bits.push((n.fontSize !== figma.mixed ? n.fontSize : 'mixed') + (f ? ' ' + f.family + ' ' + f.style : ''));
        const ts = await styleName(n.textStyleId); if (ts) bits.push('style=' + ts);
      }
      if ('fills' in n && n.type !== 'INSTANCE') { const f = await paintDesc(n.fills); if (f) bits.push('fill=' + f); }
      if ('strokes' in n && n.strokes && n.strokes.length) { const s = await paintDesc(n.strokes); if (s) bits.push('stroke=' + s); }
      if ('effectStyleId' in n) { const es = await styleName(n.effectStyleId); if (es) bits.push('effect=' + es); }
      if (n.type === 'INSTANCE') {
        const mc = await n.getMainComponentAsync();
        if (mc) bits.push('of ' + (mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name + '[' + mc.name + ']' : mc.name));
      }
      if (n.type === 'COMPONENT_SET') bits.push(n.children.length + ' variants');
      // Figma throws when a VARIANT is asked for its property definitions;
      // only sets and standalone components have them.
      const ownsProps = n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && !(n.parent && n.parent.type === 'COMPONENT_SET'));
      if (ownsProps) {
        try {
          const defs = Object.entries(n.componentPropertyDefinitions).filter(([, d]) => d.type !== 'VARIANT').map(([k, d]) => k.split('#')[0] + ':' + d.type);
          if (defs.length) bits.push('props={' + defs.join(', ') + '}');
        } catch (e) {}
      }
      if (n.componentPropertyReferences && Object.keys(n.componentPropertyReferences).length) {
        bits.push('bound=' + Object.entries(n.componentPropertyReferences).map(([k, v]) => k + '→' + String(v).split('#')[0]).join(','));
      }
      if (n.reactions && n.reactions.length) bits.push(n.reactions.length + ' interaction(s)');
      if (n.type === 'TEXT') bits.push(JSON.stringify(n.characters.length > 40 ? n.characters.slice(0, 40) + '…' : n.characters));
      else if (n.type === 'INSTANCE') {
        const t = n.findOne(x => x.type === 'TEXT' && x.visible);
        if (t) bits.push(JSON.stringify(t.characters.length > 40 ? t.characters.slice(0, 40) + '…' : t.characters));
      }
      lines.push('  '.repeat(depth) + bits.join(' '));
    };
    await visit(root, 0);
    if (lines.length >= maxLines) lines.push('  … (more nodes; ' + maxLines + '-line summary)');
    return lines.join('\\n');
  };

  globalThis.__figHelpers = H;
  globalThis.$page = H.page; globalThis.$var = H.variable; globalThis.$bind = H.bind;
  globalThis.$style = H.style; globalThis.$component = H.component;
  globalThis.$instance = H.instance; globalThis.$fontSafe = H.fontSafe; globalThis.$describe = H.describe;
}
`;

// True when user eval code calls one of the helpers.
export const RESET_NOTES = 'globalThis.__figNotes = new Set(); if (globalThis.__figHelpers && globalThis.__figHelpers.resetCaches) globalThis.__figHelpers.resetCaches();';
export const READ_NOTES = 'return globalThis.__figNotes ? [...globalThis.__figNotes] : [];';

export function usesHelpers(code) {
  return /\$(page|var|bind|style|component|instance|fontSafe|describe)\s*\(/.test(code || '');
}
