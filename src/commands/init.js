// Command: init — scaffold agent guidance into a designer's project so figma-cli
// "just works" with whichever AI coding tool they use (Claude Code or Cursor).
// Writes the SAME condensed usage ruleset to:
//   - .cursor/rules/figma-cli.mdc   (Cursor)
//   - AGENTS.md                     (Claude Code, Cursor, Codex all read it)
// The CLI binary needs nothing else — it controls Figma Desktop directly, so it
// already runs in any terminal. This just teaches the agent HOW to drive it.
import chalk from 'chalk';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { program } from '../lib/cli-core.js';

// The shared, designer-facing usage rules. Kept tight on purpose — an agent
// needs the operating rules, not the CLI's internals.
const RULES_BODY = `# Using figma-cli

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

function writeFile(path, content, force) {
  if (existsSync(path) && !force) {
    const existing = readFileSync(path, 'utf8');
    if (existing.includes('# Using figma-cli')) return { path, status: 'up-to-date' };
    return { path, status: 'exists' };  // don't clobber unrelated content
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { path, status: 'written' };
}

program
  .command('init-agent')
  .description('Scaffold agent rules so figma-cli works out of the box in Claude Code & Cursor')
  .option('--tool <tool>', 'claude | cursor | both', 'both')
  .option('--force', 'overwrite existing figma-cli rule files')
  .action((options) => {
    const tool = String(options.tool).toLowerCase();
    const cwd = process.cwd();
    const results = [];

    if (tool === 'cursor' || tool === 'both') {
      const mdc = `---\ndescription: How to drive figma-cli (controls Figma Desktop) from this project\nalwaysApply: true\n---\n\n${RULES_BODY}`;
      results.push(writeFile(join(cwd, '.cursor', 'rules', 'figma-cli.mdc'), mdc, options.force));
    }
    if (tool === 'claude' || tool === 'both') {
      // AGENTS.md is read by Claude Code, Cursor and Codex — one file, all tools.
      results.push(writeFile(join(cwd, 'AGENTS.md'), RULES_BODY, options.force));
    }

    for (const r of results) {
      const rel = r.path.replace(cwd + '/', '');
      if (r.status === 'written') console.log(chalk.green('✓ wrote'), rel);
      else if (r.status === 'up-to-date') console.log(chalk.gray('• up-to-date'), rel);
      else console.log(chalk.yellow('• exists (use --force to overwrite)'), rel);
    }
    console.log(chalk.gray('\nDesigners can now ask Claude Code or Cursor to build in Figma — the agent knows the rules.'));
    console.log(chalk.gray('Next: open Figma Desktop and run `figma-cli connect`.'));
  });
