/**
 * Sizing keywords (`fill` / `hug`) resolved into what the generator actually
 * has to emit. Kept pure so the rules are unit-testable without a Figma.
 *
 * Two callers, two shapes:
 *   - resolveLeafSizing  — Rectangle / Ellipse / Image, which used to pass
 *     `w="fill"` straight into `resize()` (the string reached the Plugin API).
 *   - resolveRootFill    — the root frame of `render`, where FILL is only
 *     meaningful once the frame sits inside an auto-layout parent.
 */

const isKeyword = (v) => v === 'fill' || v === 'hug';

/**
 * Leaf nodes (Rectangle / Ellipse / Image) have no auto-layout of their own,
 * so sizing is only ever `resize()` plus, for a FILL axis, a
 * `layoutSizingHorizontal/Vertical` assignment AFTER appendChild.
 *
 * `hug` has no meaning on a leaf — it resolves to the default like an unset
 * axis, which is what these nodes did before the keywords existed.
 *
 * @param {{w?:*, h?:*, defaultW?:number, defaultH?:number, parentIsNone?:boolean}} o
 * @returns {{resizeW:number, resizeH:number, fillH:boolean, fillV:boolean}}
 */
export function resolveLeafSizing({ w, h, defaultW = 100, defaultH = 100, parentIsNone = false } = {}) {
  // A parent without auto-layout cannot be filled: fall back to the default
  // size, exactly as a Frame child does in a flex="none" parent.
  const fillH = w === 'fill' && !parentIsNone;
  const fillV = h === 'fill' && !parentIsNone;
  const numeric = (v, fallback) => (v === undefined || v === null || isKeyword(v) ? fallback : v);
  return {
    resizeW: numeric(w, defaultW),
    resizeH: numeric(h, defaultH),
    fillH,
    fillV,
  };
}

/**
 * Root frame of a `render`. `w="fill"` needs two things the root only has with
 * `--parent`: an actual parent, and one using auto-layout. Without a parent the
 * keyword is meaningless — warn instead of emitting an assignment that throws.
 *
 * With a parent the assignment has to run AFTER `appendChild`, because the
 * frame is parentless until the very end of the generated code (deliberately,
 * so an auto-layout parent measures real content instead of the seed size).
 *
 * @param {{fillWidth?:boolean, fillHeight?:boolean, hasParent?:boolean, name?:string}} o
 * @returns {{applyAfterAppend:boolean, warnings:string[]}}
 */
export function resolveRootFill({ fillWidth = false, fillHeight = false, hasParent = false, name = 'frame' } = {}) {
  if (!fillWidth && !fillHeight) return { applyAfterAppend: false, warnings: [] };
  if (hasParent) return { applyAfterAppend: true, warnings: [] };
  const warnings = [];
  const axes = [];
  if (fillWidth) axes.push('width');
  if (fillHeight) axes.push('height');
  warnings.push(
    `"${name}" fills ${axes.join(' and ')}, but a root frame has no auto-layout parent to fill` +
    ` — pass --parent <id> or a fixed size`
  );
  return { applyAfterAppend: false, warnings };
}
