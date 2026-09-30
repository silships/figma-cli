/**
 * Pure helpers for `figma-cli comments` — no network, no Figma, so they are
 * unit-testable on their own (tests/comments.test.js).
 */

/**
 * A bare file key, or the key out of any figma.com/{design,file,proto,board}/<key>/… URL.
 */
export function parseFileKey(value) {
  const m = String(value).match(/figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : value;
}

/**
 * Group the flat REST comment list into threads (root + replies), oldest first.
 */
export function toThreads(comments) {
  const roots = comments.filter((c) => !c.parent_id);
  const replies = comments.filter((c) => c.parent_id);
  return roots
    .map((root) => ({
      ...root,
      replies: replies
        .filter((r) => r.parent_id === root.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * What the plugin needs to resolve each pin. REST pins a comment to a node plus
 * an offset inside it (usually the outermost frame), so both travel together.
 */
export function pinsOf(threads) {
  return threads
    .filter((t) => t.client_meta?.node_id)
    .map((t) => ({ key: t.id, node_id: t.client_meta.node_id, offset: t.client_meta.node_offset || null }));
}

/**
 * "outer › … › layer" from a resolved pin's ancestor chain (innermost first),
 * trimmed to the three innermost names so deep boards stay readable.
 */
export function pinLabel(info) {
  if (!info) return 'node not found (deleted?)';
  return info.chain.map((c) => c.name).slice(0, 3).reverse().join(' › ');
}

/**
 * Plugin-side code that walks each pin's offset down to the deepest visible
 * layer under it and returns { [pin.key]: { id, name, chain } }.
 */
export function resolvePinsCode(pins) {
  return `(async () => {
    const pins = ${JSON.stringify(pins)};
    const inside = (n, x, y) => {
      const b = n.absoluteBoundingBox;
      return b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    };
    const deepest = (n, x, y) => {
      if (!('children' in n)) return n;
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = n.children[i];
        if (c.visible !== false && inside(c, x, y)) return deepest(c, x, y);
      }
      return n;
    };
    const out = {};
    for (const pin of pins) {
      const base = await figma.getNodeByIdAsync(pin.node_id);
      if (!base) { out[pin.key] = null; continue; }
      let n = base;
      if (pin.offset && base.absoluteBoundingBox) {
        n = deepest(base, base.absoluteBoundingBox.x + pin.offset.x, base.absoluteBoundingBox.y + pin.offset.y);
      }
      const chain = [];
      for (let p = n; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p = p.parent) chain.push({ id: p.id, name: p.name });
      out[pin.key] = { id: n.id, name: n.name, chain };
    }
    return out;
  })()`;
}
