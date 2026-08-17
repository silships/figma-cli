/**
 * Text style lookup and matching.
 *
 * These functions run in BOTH worlds: unit tests call them here in Node, and
 * `figma-client.js` embeds their source (via `.toString()`) into the code it
 * evaluates inside Figma. That is deliberate — the alternative was writing the
 * matching rules twice, once testable and once as a template string, and
 * letting the two drift.
 *
 * Consequences for anything added here:
 *   - no imports, no module-scope references, no closures
 *   - plain function DECLARATIONS, so they can call each other after being
 *     re-declared inside the generated code
 *   - ES2017 at most (the Figma renderer is modern, but keep it boring)
 *
 * A "style" is the shape Figma's TextStyle exposes, trimmed to what matching
 * needs: { id, name, fontName: { family, style }, fontSize }.
 */

/**
 * "Semi Bold", "SemiBold" and "semibold" are the same weight as far as a
 * designer is concerned — Figma just writes it differently per font family.
 */
export function normalizeWeight(styleName) {
  return String(styleName || '').toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Name → style, plus a "tail" alias for slash-grouped names: `Heading/H1` is
 * also reachable as `H1`. Same rule the variable cache uses for `var:`, so
 * `textStyle="H1"` and `var:primary` behave alike. The full name always wins.
 */
export function buildStyleIndex(styles) {
  var index = {};
  var list = styles || [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s || !s.name) continue;
    if (!index[s.name]) index[s.name] = s;
  }
  for (var j = 0; j < list.length; j++) {
    var st = list[j];
    if (!st || !st.name) continue;
    var slash = st.name.lastIndexOf('/');
    if (slash < 0) continue;
    var tail = st.name.slice(slash + 1);
    if (tail && !index[tail]) index[tail] = st;
  }
  return index;
}

/**
 * Pick the text style a `<Text>` without an explicit `textStyle` should get.
 *
 * Exact matches only: same font size, same weight/italic. Guessing across
 * sizes would silently restyle text the caller sized on purpose, which is
 * worse than leaving it unstyled.
 *
 * The family is only required when the caller actually wrote `font=` — the
 * default "Inter" is a fallback, not an intent, and demanding it would mean a
 * file whose styles use another family could never auto-match.
 *
 * @returns {{match:object}} one exact hit
 *        | {{ambiguous:string[]}} several hits, nothing applied
 *        | {{nearest:object|null}} no hit, closest by size for the warning
 */
export function matchTextStyle(o) {
  var opts = o || {};
  var list = opts.styles || [];
  var size = Number(opts.size);
  var wanted = normalizeWeight(opts.weightStyle);
  var family = String(opts.family || '').toLowerCase();
  var familyExplicit = !!opts.familyExplicit;

  var hits = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s || !s.fontName) continue;
    if (Number(s.fontSize) !== size) continue;
    if (normalizeWeight(s.fontName.style) !== wanted) continue;
    if (familyExplicit && String(s.fontName.family).toLowerCase() !== family) continue;
    hits.push(s);
  }

  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) {
    var names = [];
    for (var j = 0; j < hits.length; j++) names.push(hits[j].name);
    return { ambiguous: names };
  }

  // No hit: report the closest size at the same weight, else the closest size
  // overall. Purely for the warning text — nothing is applied.
  var nearest = null;
  var bestDelta = Infinity;
  for (var k = 0; k < list.length; k++) {
    var c = list[k];
    if (!c || !c.fontName) continue;
    var delta = Math.abs(Number(c.fontSize) - size);
    var sameWeight = normalizeWeight(c.fontName.style) === wanted;
    var score = delta + (sameWeight ? 0 : 1000);
    if (score < bestDelta) { bestDelta = score; nearest = c; }
  }
  return { nearest: nearest };
}
