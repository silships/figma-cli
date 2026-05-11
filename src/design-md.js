/**
 * DESIGN.md importer.
 *
 * Parses the "Machine-readable tokens" JSON block at the end of a DESIGN.md
 * (the format produced by Figma extraction tools like figma-extract.md, the
 * `tokens-studio` exporter, and similar). Returns a normalized token map
 * ready for figma-cli's `tokens import` pipeline.
 *
 * Expected document layout:
 *   ## 11. Machine-readable tokens
 *   ```json design-tokens
 *   { "color": {...}, "typography": {...}, "spacing": {...},
 *     "radius": {...}, "shadow": {...}, "fonts": [...] }
 *   ```
 *
 * Section 7 ("Components") and the various tables (Color, Typography, Radius)
 * earlier in the file are summarized into a compact context string so the
 * `/design` command in figmachat can drop a token + component list into its
 * system prompt without bloating it with 7000 lines of structure.
 */

import fs from 'fs';

const JSON_BLOCK_RE = /```json\s+design-tokens\s*\n([\s\S]*?)\n```/;

export function parseDesignMd(filepath) {
  const text = fs.readFileSync(filepath, 'utf-8');
  const match = text.match(JSON_BLOCK_RE);
  if (!match) {
    throw new Error(
      `No \`\`\`json design-tokens block found in ${filepath}.\n` +
      `Expected the "## 11. Machine-readable tokens" section.`
    );
  }
  let tokens;
  try {
    tokens = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`Token JSON block is not valid JSON: ${e.message}`);
  }

  // Pull the document summary fields too — useful for the figmachat context.
  const identityMatch = text.match(/^\*\*In one line:\*\*\s+(.+)$/m);
  const sourceMatch = text.match(/^source:\s+(.+)$/m);
  const componentSections = [...text.matchAll(/^### Page:\s+(.+)$/gm)]
    .map(m => m[1].trim())
    // Drop the meta-pages that aren't real component areas
    .filter(p => !/^(About|Read me|Color|Effects|Spacing block|Screens|Utilities)$/i.test(p));

  return {
    tokens,
    meta: {
      source: tokens.meta?.source || sourceMatch?.[1] || 'unknown',
      generated: tokens.meta?.generated,
      identity: identityMatch?.[1],
      components: componentSections,
    },
  };
}

/** Produce a one-shot summary string for figmachat to drop into the system prompt. */
export function summarizeForLLM({ tokens, meta }) {
  const colors = Object.entries(tokens.color || {});
  const types = Object.keys(tokens.typography || {});
  const radii = Object.keys(tokens.radius || {});
  const shadows = Object.keys(tokens.shadow || {});

  const lines = [
    `Design system loaded: ${meta.source}`,
  ];
  if (meta.identity) lines.push(`Style: ${meta.identity}`);

  // Color tokens — list the first 40 by usage (the file already orders them
  // by usage count). Naming this section explicitly so the model knows these
  // are the canonical token names to use in `var:` references.
  if (colors.length) {
    const sample = colors.slice(0, 40)
      .map(([k, v]) => `var:${k}=${v}`)
      .join(', ');
    lines.push(`Color tokens (${colors.length} total, top by usage): ${sample}`);
    if (colors.length > 40) lines.push(`  …and ${colors.length - 40} more — call \`figma-cli var list\` for the full set.`);
  }
  if (types.length) lines.push(`Typography tokens (${types.length}): ${types.join(', ')}`);
  if (radii.length) lines.push(`Radius tokens (${radii.length}): ${radii.join(', ')}`);
  if (shadows.length) lines.push(`Shadow tokens (${shadows.length}): use sparingly — they're long compositions`);
  if (meta.components?.length) {
    lines.push(`Existing component pages: ${meta.components.slice(0, 50).join(', ')}`);
  }
  lines.push('');
  lines.push(`HARD RULES while this design system is loaded:`);
  lines.push(`- ALWAYS use \`bg="var:<name>"\` / \`color="var:<name>"\` for colors, never raw hex.`);
  lines.push(`- For text styles, match by purpose to the typography token names above.`);
  lines.push(`- For radii, match by name (e.g. radius-md = 2px).`);
  lines.push(`- If the user asks for a component already listed under "Existing component pages", PREFER using the existing component over creating a new one. Hint: 'figma-cli find "<name>"' to locate it.`);
  return lines.join('\n');
}

/** Build the JSON payload that figma-cli's `tokens import` already consumes. */
export function toTokensImportJson({ tokens }) {
  // figma-cli `tokens import` accepts a flat or nested map. We flatten color
  // / radius into the W3C-token-spec-ish shape it already understands.
  const out = {
    color: {},
    radius: {},
    typography: {},
  };
  for (const [name, value] of Object.entries(tokens.color || {})) {
    out.color[name] = { value, type: 'color' };
  }
  for (const [name, value] of Object.entries(tokens.radius || {})) {
    const num = parseFloat(value);
    if (Number.isFinite(num)) out.radius[name] = { value: num, type: 'number' };
  }
  for (const [name, ts] of Object.entries(tokens.typography || {})) {
    out.typography[name] = {
      value: {
        fontFamily: ts.fontFamily,
        fontSize: ts.fontSize,
        fontWeight: ts.fontWeight,
        lineHeight: ts.lineHeight,
        letterSpacing: ts.letterSpacing,
      },
      type: 'typography',
    };
  }
  return out;
}
