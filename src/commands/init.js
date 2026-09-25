// Command: init-agent — scaffold agent guidance into a designer's project so
// figma-cli "just works" with whichever AI coding tool they use.
// Writes the SAME ruleset to:
//   - .cursor/rules/figma-cli.mdc   (Cursor)
//   - AGENTS.md                     (Claude Code, Cursor, Codex all read it)
// The rules and the update logic live in lib/agent-rules.js, because `connect`
// also refreshes outdated copies.
import chalk from 'chalk';
import { join } from 'path';
import { program } from '../lib/cli-core.js';
import { RULE_FILES, syncRulesFile } from '../lib/agent-rules.js';

program
  .command('init-agent')
  .description('Scaffold agent rules so figma-cli works out of the box in Claude Code & Cursor')
  .option('--tool <tool>', 'claude | cursor | both', 'both')
  .option('--force', 'overwrite existing figma-cli rule files')
  .action((options) => {
    const tool = String(options.tool).toLowerCase();
    const cwd = process.cwd();
    const results = [];

    for (const f of RULE_FILES) {
      if (tool !== 'both' && tool !== f.tool) continue;
      results.push(syncRulesFile(join(cwd, f.rel), f.fresh, { force: options.force }));
    }

    for (const r of results) {
      const rel = r.path.replace(cwd + '/', '');
      if (r.status === 'written') console.log(chalk.green('✓ wrote'), rel);
      else if (r.status === 'updated') console.log(chalk.green('✓ updated'), rel);
      else if (r.status === 'up-to-date') console.log(chalk.gray('• up-to-date'), rel);
      else console.log(chalk.yellow('• exists (use --force to overwrite)'), rel);
    }
    console.log(chalk.gray('\nDesigners can now ask Claude Code or Cursor to build in Figma — the agent knows the rules.'));
    console.log(chalk.gray('Next: open Figma Desktop and run `figma-cli connect`.'));
  });
