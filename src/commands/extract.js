// Command: extract — scan the open Figma file and write a DESIGN.md
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import {
  listPagesCode, walkerCode, variableCollectionsCode, variableChunkCode,
  generateDesignMd, generatePageStructureMd, estimateStructureTokens, ALL_SECTIONS,
} from '../design-extract.js';

const DEPTH_FLOOR = 3;
// Variable values are fetched in bounded chunks so huge libraries (thousands
// of variables) never land in one oversized eval. On payload/timeout the
// chunk halves down to this floor before the rest of a collection is skipped.
const VAR_CHUNK = 200;
const VAR_CHUNK_FLOOR = 25;
// Structure trees above this estimated token count get auto-split into
// DESIGN-structure/ so the main DESIGN.md stays loadable in one AI context.
const AUTO_SPLIT_TOKENS = 50_000;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';

/**
 * fastEval returns a string when the eval code uses JSON.stringify() (both
 * daemon and direct-connection paths pass the string value through), and an
 * object/primitive when the code returns a raw value (daemon deserialises the
 * HTTP body with response.json() which parses the outer envelope, leaving the
 * inner result as-is). Since all walkers in design-extract.js return
 * JSON.stringify(...), results will almost always be strings — but guard
 * against the object case so the command is robust to daemon changes.
 */
function parseEvalResult(res) {
  if (typeof res === 'string') return JSON.parse(res);
  return res;
}

program
  .command('extract [output]')
  .description('Scan the open Figma file (all pages) and write a DESIGN.md — tokens, structure, component variant matrices. Roundtrips with `figma-cli import`.')
  .option('--sections <list>', `comma list of sections (${ALL_SECTIONS.join(',')})`)
  .option('--pages <list>', 'only pages whose name matches one of these (comma list, case-insensitive substring)')
  .option('--selection', 'only the currently selected nodes (overrides --pages)')
  .option('--split', 'additionally write full per-page trees to DESIGN-structure/')
  .option('--no-split', 'never auto-split, even for huge files (one big DESIGN.md)')
  .action(async (output, options) => {
    await checkConnection();
    const outPath = resolve(output || 'DESIGN.md');

    let sections;
    if (options.sections) {
      sections = options.sections.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = sections.filter(s => !ALL_SECTIONS.includes(s));
      if (bad.length) {
        console.error(chalk.red(`Unknown section(s): ${bad.join(', ')}`));
        console.error(chalk.gray(`Valid: ${ALL_SECTIONS.join(', ')}`));
        process.exit(1);
      }
    }

    const spinner = ora('Reading file info...').start();
    try {
      let pages;
      if (options.selection) {
        // Wrap the selection in a synthetic single "page".
        const sel = parseEvalResult(await fastEval(`(async () => {
          const sel = figma.currentPage.selection;
          return JSON.stringify({ ids: sel.map(n => n.id), pageId: figma.currentPage.id, pageName: figma.currentPage.name });
        })()`));
        if (!sel.ids.length) {
          spinner.fail('Nothing selected in Figma.');
          process.exit(1);
        }
        pages = [{ id: sel.pageId, name: sel.pageName, selectionIds: sel.ids }];
      } else {
        pages = parseEvalResult(await fastEval(listPagesCode()));
        if (options.pages) {
          const filters = options.pages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          pages = pages.filter(p => filters.some(f => p.name.toLowerCase().includes(f)));
          if (!pages.length) {
            spinner.fail(`No pages match "${options.pages}".`);
            process.exit(1);
          }
        }
      }

      const fileName = parseEvalResult(await fastEval(
        `(async () => JSON.stringify(figma.root.name))()`
      ));

      // Authoritative token layer: the file's real variable collections.
      // Two-phase + chunked so it scales to large systems: list collections
      // (tiny), then fetch each collection's values in bounded, retryable
      // chunks. Best-effort — older Figma builds / files without variables
      // yield []. droppedVars counts any chunk skipped after exhausting retries
      // so the summary can tell "no variables" apart from "some unreadable".
      let variables = [];
      let droppedVars = 0;
      const wantsVariables = !sections || sections.includes('variables');
      if (wantsVariables) {
        spinner.text = 'Reading variable collections…';
        let cols = [];
        try {
          cols = parseEvalResult(await fastEval(variableCollectionsCode())) || [];
        } catch (e) {
          cols = [];
        }
        for (let ci = 0; ci < cols.length; ci++) {
          const col = cols[ci];
          const ids = col.variableIds || [];
          const collected = [];
          let chunk = VAR_CHUNK;
          for (let i = 0; i < ids.length;) {
            spinner.text = `Variables: ${col.name} (${i}/${ids.length})…`;
            const slice = ids.slice(i, i + chunk);
            try {
              const got = parseEvalResult(await fastEval(variableChunkCode(slice, col.modes))) || [];
              collected.push(...got);
              i += chunk;
            } catch (e) {
              if (/payload|too large|timeout/i.test(e.message) && chunk > VAR_CHUNK_FLOOR) {
                chunk = Math.floor(chunk / 2);
                continue;
              }
              droppedVars += slice.length;
              i += chunk; // skip this slice, keep going with the rest
            }
          }
          variables.push({ id: col.id, name: col.name, modes: col.modes, variables: collected });
        }
      }

      const results = [];
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        spinner.text = `Page ${i + 1}/${pages.length}: ${page.name}…`;
        let depth = 8;
        let result = null;
        while (depth >= DEPTH_FLOOR) {
          try {
            const code = page.selectionIds
              ? walkerCode(page.id, { maxDepth: depth }).replace(
                  'page.children.map',
                  `page.children.filter(c => ${JSON.stringify(page.selectionIds)}.includes(c.id)).map`)
              : walkerCode(page.id, { maxDepth: depth });
            result = parseEvalResult(await fastEval(code));
            if (depth < 8) result.reducedDepth = depth;
            break;
          } catch (e) {
            // Payload-size / timeout errors → retry shallower. Anything else → skip page.
            if (/payload|too large|timeout/i.test(e.message) && depth > DEPTH_FLOOR) { depth -= 2; continue; }
            result = { id: page.id, name: page.name, nodeCount: 0, frames: [], error: e.message };
            break;
          }
        }
        if (!result) result = { id: page.id, name: page.name, nodeCount: 0, frames: [], error: `exceeded payload limit even at depth ${DEPTH_FLOOR}` };
        results.push(result);
      }

      spinner.text = 'Generating DESIGN.md…';
      const extraction = {
        fileName,
        date: new Date().toISOString().slice(0, 10),
        pages: results,
        variables,
      };

      // Auto-split: when the structure trees alone would blow any AI context
      // window, move them to DESIGN-structure/ and keep the main file lean.
      // options.split is true (--split), false (--no-split) or undefined (auto).
      const wantsStructure = !sections || sections.includes('structure');
      let autoSplit = false;
      let structTokens = 0;
      if (options.split === undefined && wantsStructure) {
        structTokens = estimateStructureTokens(results);
        autoSplit = structTokens > AUTO_SPLIT_TOKENS;
      }
      const doSplit = options.split === true || autoSplit;

      let mainSections = sections;
      if (autoSplit) {
        // Slim main file: drop the structure section, note where it went.
        mainSections = (sections || ALL_SECTIONS).filter(s => s !== 'structure');
      }
      let md = generateDesignMd(extraction, { sections: mainSections });
      if (autoSplit) {
        md = md.replace('-->\n', `-->\n\n> **Structure trees auto-split** (~${Math.round(structTokens / 1000)}k tokens — too large for one AI context): per-page trees are in \`DESIGN-structure/\`. Use \`--no-split\` to force a single file.\n`);
      }
      writeFileSync(outPath, md);

      const written = [outPath];
      if (doSplit) {
        const splitDir = join(dirname(outPath), 'DESIGN-structure');
        mkdirSync(splitDir, { recursive: true });
        for (const page of results) {
          const f = join(splitDir, `${slug(page.name)}.md`);
          writeFileSync(f, generatePageStructureMd(page));
          written.push(f);
        }
      }

      const failed = results.filter(r => r.error);
      const totalNodes = results.reduce((a, p) => a + (p.nodeCount || 0), 0);
      spinner.succeed(`Extracted ${results.length} page(s), ${totalNodes} nodes → ${outPath}`);
      if (variables.length) {
        const varCount = variables.reduce((a, c) => a + (c.variables?.length || 0), 0);
        console.log(chalk.gray(`  Captured ${varCount} variable(s) across ${variables.length} collection(s) — real token names + modes (see § Variables)`));
        if (droppedVars) console.log(chalk.yellow(`  ⚠ ${droppedVars} variable(s) skipped (chunk too large even at floor) — they're missing from § Variables`));
      }
      if (autoSplit) console.log(chalk.gray(`  Structure (~${Math.round(structTokens / 1000)}k tokens) auto-split into DESIGN-structure/ — main file stays AI-context-sized (--no-split to override)`));
      else if (doSplit) console.log(chalk.gray(`  + ${results.length} structure file(s) in DESIGN-structure/`));
      if (failed.length) {
        console.log(chalk.yellow(`  ⚠ ${failed.length} page(s) skipped:`));
        for (const f of failed) console.log(chalk.yellow(`    - ${f.name}: ${f.error}`));
      }
      console.log(chalk.gray(`  Re-import anytime: figma-cli import ${output || 'DESIGN.md'}`));
      // When the daemon is down, fastEval falls back to direct CDP websockets
      // that keep the event loop alive — exit explicitly once the work is done.
      process.exit(0);
    } catch (e) {
      spinner.fail(`Extraction failed: ${e.message}`);
      process.exit(1);
    }
  });
