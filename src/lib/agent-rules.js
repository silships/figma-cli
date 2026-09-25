// The figma-cli agent rules (AGENTS.md for Claude Code / Codex / Cursor, and
// .cursor/rules/figma-cli.mdc) plus the logic that keeps them current.
//
// The rules live between two markers. The start marker carries a hash of the
// rules, so an outdated copy is detected without a version number anyone has
// to remember to bump. Only the marked block is ever rewritten: whatever the
// user wrote around it stays. `init-agent` writes or refreshes it; `connect`
// refreshes copies that already exist in the working directory, so an update
// of figma-cli reaches projects without anyone re-running init-agent.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// The shared, designer-facing usage rules. Kept tight on purpose — an agent
// needs the operating rules, not the CLI's internals.
export const RULES_BODY = `# Using figma-cli

figma-cli controls **Figma Desktop** directly (no API key). It runs in any
terminal. Open Figma Desktop, then \`figma-cli connect\` once per session.

## Golden rules
1. **Create frames with \`render\` / \`render-batch\`** — they have smart positioning.
   NEVER use \`eval\` to create visual nodes (no positioning, bypasses guards).
2. **"N buttons/cards" = N separate top-level nodes**, not one wrapper frame
   containing N children. Use \`render-batch '[...]'\` or \`shadcn add <c> --count N\`.
3. **Never delete the user's existing nodes.**
4. After creating, **verify**: \`figma-cli verify "<id>" --measure\` (returns a
   screenshot + real w/h so you catch size bugs by numbers, not by eye).

Every command you need for everyday work is on this page. Only run
\`figma-cli <command> --help\` when a task needs a command not listed here.
**Each tool call costs a full agent turn, so do a whole task in ONE call where
you can**: one \`eval\` that reads everything, one \`render\` that builds the
whole structure.

## Reading: \`eval\` runs Figma Plugin API code
\`figma-cli eval '<code>'\` runs JavaScript in the open file and prints the
result as compact JSON. Top-level \`await\` works. A single expression returns
itself; statements need an explicit \`return\`. Long code: \`eval --file q.js\`.
- The file loads pages lazily: call \`await figma.loadAllPagesAsync()\` before
  searching beyond the current page, and use the async APIs
  (\`getNodeByIdAsync\`, \`getMainComponentAsync\`, \`getLocalVariablesAsync\`,
  \`getStyleByIdAsync\`); the sync ones throw.
- \`findAllWithCriteria({types: [...]})\` is much faster than \`findAll\`.
- Return only what answers the question (counts, names, ids). Output over
  20,000 characters is cut.
- A variable binding: \`node.fills[0].boundVariables.color.id\` → \`getVariableByIdAsync\`.
  Resolve an alias by following \`valuesByMode\` values of type \`VARIABLE_ALIAS\`.

Helpers available inside \`eval\` (they handle the Figma pitfalls for you):
- \`await $page(name)\` switch to a page, creating it when missing
- \`await $var(name)\` local variable by full name; \`await $bind(node, varName, 'fills'|'strokes'|field)\`
- \`await $style(name)\` any local style by name
- \`await $component(name)\` component or component set by name, whole file
- \`await $instance(name, 'axis=value, axis=value', {text, parent})\` instance of a
  variant; unspecified axes use the default variant
- \`await $fontSafe(node)\` load fonts and replace fonts that are not installed
- \`await $describe(node)\` compact one-line-per-node summary of a subtree
- Loops are fine: e.g. one instance per variant of a set in a single \`eval\`:
  \`for (const v of (await $component('Name')).children) await $instance(v.id, '', {parent: frame})\`

## Writing: \`render\`
- \`--page "Name"\` renders on that page and creates it when missing.
- \`var:\` takes any variable by full name: \`bg="var:bgColor/muted"\`, \`color="var:fgColor/default"\`.
- Styles by name: \`<Frame effectStyle="shadow/small">\`, \`<Text textStyle="Body/Medium">\`.
- Existing components, any page: \`<Instance component="Button" variant="variant=danger, size=large" text="Delete" />\`
  (\`text\` relabels the first text layer).
- A component text or style whose font is not installed is switched to Inter
  automatically and reported as a \`note:\` line. You do not need to fix fonts.
- \`render\` prints the new node id and **the structure it built**: sizes, layout,
  padding, gap, bound variables, styles, which component each instance uses.
  Check that output; do not re-read the result with \`eval\`. \`--verify\` adds a
  screenshot when the look matters.

## Components
- One component: \`render '<Frame ...>' --as-component\`.
- A component set with variants in ONE call: \`render-batch\` with every frame
  named by its variant, plus \`--variant-set <Name>\`:
  \`render-batch '["<Frame name=\\"size=small, state=hover\\" ...>...</Frame>", ...]' --variant-set Button\`
- Component properties (in \`eval\`): \`const k = comp.addComponentProperty('Label', 'TEXT', 'Default')\`,
  then \`textNode.componentPropertyReferences = { characters: k }\`. For \`'BOOLEAN'\`
  reference \`visible\`; for \`'INSTANCE_SWAP'\` reference \`mainComponent\`.

## Design tokens / variables
- Bind colors at creation with \`var:name\`, never raw hex when a system is loaded:
  \`<Frame bg="var:primary"><Text color="var:on-primary">Go</Text></Frame>\`
- Pin a named collection when the user names one: \`render-batch ... --collection figma\`.
- Import a system: \`figma-cli import tailwind.config.js | globals.css | tokens.json\`.
- Export the open file's system: \`figma-cli extract\` → DESIGN.md.

## JSX cheatsheet (render)
- Layout: \`flex="row|col" gap={16} p={24} px py pt pr pb pl justify="center|between" items="center"\`
- Size: \`w={320} h={200} w="fill" w="hug" w="60%"\` (percent resolves vs parent)
- Look: \`bg="#fff" stroke="#000" strokeWidth={2} rounded={12} shadow="..." opacity={0.8}\`
- Text: \`<Text size={14} weight="semibold" color="#000" lineHeight={20} truncate maxLines={2} w="fill">\`
- Icons (real SVG, never emojis): \`<Icon name="lucide:home" size={20} color="var:primary" />\`
- Dividers: a thin child (\`<Frame w={1} bg="var:border" />\`) auto-fills the cross axis.

## Text wrapping (most common bug)
For text to wrap, the parent AND every \`<Text>\` need \`w="fill"\`, and the parent
needs \`flex="col"\` or \`flex="row"\`.

## Recreating a component from an extracted DESIGN.md (hard rule)
Don't read the structure markdown by hand. Use:
- \`figma-cli spec <Component>\` → authoritative variant axes + sample size (compact).
  Build EXACTLY to those axes (e.g. Variant × Size = a Component Set, not one node).
- \`figma-cli spec <Component> --check <nodeId>\` → enforces it (exit 1 on mismatch:
  wrong structure, missing axes, wrong height). Treat non-zero as "not done".

## Handy commands
\`\`\`
figma-cli connect                      # connect to Figma Desktop (yolo)
figma-cli render '<Frame>...</Frame>'  # one frame
figma-cli render-batch '[ "<Frame>", ... ]' --direction row
figma-cli shadcn add button --count 3  # N distinct shadcn primitives
figma-cli node to-component "<id>"     # promote to a component
figma-cli verify "<id>" --measure      # screenshot + dimensions
figma-cli a11y audit                   # contrast / touch / text checks
\`\`\`
`;


export const RULES_HASH = createHash('sha1').update(RULES_BODY).digest('hex').slice(0, 10);
const START = `<!-- figma-cli rules ${RULES_HASH} (managed by figma-cli; edits inside this block are replaced on update) -->`;
const START_RE = /<!-- figma-cli rules ([0-9a-f]+)[^>]*-->/;
const END = '<!-- /figma-cli rules -->';
const BLOCK = `${START}\n${RULES_BODY}${END}\n`;

// Copies written before the markers existed start at this heading and end
// with the fenced "Handy commands" block. Replace exactly that span.
function legacySpan(text) {
  const start = text.indexOf('# Using figma-cli');
  if (start < 0) return null;
  const handy = text.indexOf('## Handy commands', start);
  if (handy < 0) return null;
  const open = text.indexOf('```', handy);
  const close = open < 0 ? -1 : text.indexOf('```', open + 3);
  if (close < 0) return null;
  let end = close + 3;
  if (text[end] === '\n') end++;
  return { start, end };
}

const MDC_HEAD = '---\ndescription: How to drive figma-cli (controls Figma Desktop) from this project\nalwaysApply: true\n---\n\n';

export const RULE_FILES = [
  { tool: 'cursor', rel: join('.cursor', 'rules', 'figma-cli.mdc'), fresh: () => MDC_HEAD + BLOCK },
  { tool: 'claude', rel: 'AGENTS.md', fresh: () => BLOCK },
];

// Write or refresh one rules file.
//   create: false -> only refresh a file that already carries figma-cli rules
// Returns { path, status: written | updated | up-to-date | exists | absent }.
export function syncRulesFile(path, fresh, { create = true, force = false } = {}) {
  if (!existsSync(path)) {
    if (!create) return { path, status: 'absent' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fresh());
    return { path, status: 'written' };
  }
  const text = readFileSync(path, 'utf8');
  const m = text.match(START_RE);
  if (m) {
    const s = m.index;
    const e = text.indexOf(END, s);
    if (m[1] === RULES_HASH && e >= 0 && !force) return { path, status: 'up-to-date' };
    const end = e >= 0 ? e + END.length + (text[e + END.length] === '\n' ? 1 : 0) : text.length;
    writeFileSync(path, text.slice(0, s) + BLOCK + text.slice(end));
    return { path, status: 'updated' };
  }
  const legacy = legacySpan(text);
  if (legacy) {
    writeFileSync(path, text.slice(0, legacy.start) + BLOCK + text.slice(legacy.end));
    return { path, status: 'updated' };
  }
  if (force) { writeFileSync(path, fresh()); return { path, status: 'written' }; }
  return { path, status: 'exists' };  // unrelated file: never touch it
}

// Refresh the rules files in dir that already exist.
export function refreshRules(dir) {
  return RULE_FILES.map(f => syncRulesFile(join(dir, f.rel), f.fresh, { create: false }))
    .filter(r => r.status === 'updated');
}

// A folder someone works in with an AI tool, not the home directory or a
// random place: it has version control, a package, or agent instructions.
export function looksLikeProject(dir, home = homedir()) {
  if (!dir || dir === home || dir === '/') return false;
  return ['.git', 'package.json', 'CLAUDE.md', 'AGENTS.md', '.cursor'].some(f => existsSync(join(dir, f)));
}

// Used by `connect`: refresh outdated copies, and give a project that has no
// AGENTS.md one, so users get the agent rules without running init-agent.
// Never writes outside a project folder.
export function ensureRules(dir, { home = homedir() } = {}) {
  const changed = refreshRules(dir);
  const agents = RULE_FILES.find(f => f.rel === 'AGENTS.md');
  if (looksLikeProject(dir, home) && !existsSync(join(dir, agents.rel))) {
    changed.push(syncRulesFile(join(dir, agents.rel), agents.fresh));
  }
  return changed;
}
