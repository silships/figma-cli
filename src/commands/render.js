// Commands: render (extracted from index.js)
import chalk from 'chalk';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { FigmaClient } from '../figma-client.js';
import { getFigmaVersion, isFigmaRunning, platformName } from '../platform.js';
import { getCdpPort } from '../figma-patch.js';
import {
  program,
  CONFIG_DIR,
  checkConnection,
  daemonExec,
  detectWrapperSplit,
  fastEval,
  figmaEvalSync,
  getFigmaClient,
  isDaemonRunning,
  unescapeShell
} from '../lib/cli-core.js';

// ============ RENDER ============

// ---- shared render UX helpers ----

// Warn about unknown JSX props before rendering (typos and CSS-style names
// are otherwise silently ignored and the result just looks wrong).
function warnUnknownProps(jsxStrings) {
  try {
    const client = new FigmaClient();
    for (const j of jsxStrings) {
      for (const w of client.validateJsxProps(j)) {
        console.log(chalk.yellow(
          `\u26a0 Unknown prop "${w.prop}" on <${w.tag}>` +
          (w.suggestion ? ` — did you mean "${w.suggestion}"?` : ' (ignored)')
        ));
      }
    }
  } catch {}
}

function printUnresolvedVars(unresolved) {
  if (!unresolved || unresolved.length === 0) return;
  console.log(chalk.yellow(`\n\u26a0 ${unresolved.length} variable reference(s) could not be resolved:`));
  console.log(chalk.yellow('  ' + unresolved.join(', ')));
  console.log(chalk.gray('  These bindings rendered as grey placeholders. Check `figma-cli var list` (optionally with --collection).'));
}

/**
 * Report children that FILL an axis their parent HUGs.
 *
 * Figma's UI disables "fill container" in that situation; the Plugin API
 * accepts it and resolves it to nothing, so the element collapses and vanishes
 * with no error anywhere. Saying it out loud is the difference between a
 * two-second fix and re-deriving the same auto-layout bug from scratch.
 */
function printLayoutWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  console.log(chalk.yellow(`\n⚠ ${warnings.length} auto-layout problem(s):`));
  for (const w of warnings) console.log(chalk.yellow('  ' + w));
  console.log(chalk.gray('  Fix: give the parent a fixed size on that axis, or drop the fill from the child.'));
}

/**
 * Report which text styles the render bound, and which it could not.
 *
 * Without this the whole feature is invisible: a text that silently kept its
 * hardcoded 14px Inter looks exactly like one that picked up "Body/S".
 */
function printTextStyles(textStyles) {
  if (!textStyles) return;
  const applied = textStyles.applied || [];
  const warnings = textStyles.warnings || [];
  if (applied.length > 0) {
    const counts = new Map();
    for (const n of applied) counts.set(n, (counts.get(n) || 0) + 1);
    const summary = [...counts.entries()]
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
    console.log(chalk.gray(`  text styles: ${summary}`));
  }
  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n⚠ ${warnings.length} text style issue(s):`));
    for (const w of warnings) console.log(chalk.yellow('  ' + w));
    console.log(chalk.gray('  `figma-cli styles` lists what this file has.'));
  }
}

// Remember what the last render created so `figma-cli undo` can remove
// exactly those nodes. CLI-side state file: covers every render path
// (eval-based, daemon render, render-batch) and survives daemon restarts.
const LAST_RENDER_FILE = join(CONFIG_DIR, 'last-render.json');

function recordCreated(nodes) {
  try {
    const list = nodes.filter(n => n && n.id).map(n => ({ id: n.id, name: n.name || '' }));
    if (list.length) writeFileSync(LAST_RENDER_FILE, JSON.stringify({ nodes: list, at: new Date().toISOString() }));
  } catch {}
}

// Screenshot a freshly rendered node (same export logic as `figma-cli verify`)
// so render --verify gives Claude the visual check in a single roundtrip.
async function verifyRendered(nodeId) {
  try {
    const result = await fastEval(`(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!node) return { error: 'Node not found' };
      if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
      const nodeWidth = node.width || 100;
      const nodeHeight = node.height || 100;
      let finalScale = 1;
      const maxNodeDim = Math.max(nodeWidth, nodeHeight);
      if (maxNodeDim * finalScale > 2000) finalScale = 2000 / maxNodeDim;
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: finalScale } });
      return { name: node.name, id: node.id, width: Math.round(nodeWidth * finalScale), height: Math.round(nodeHeight * finalScale), base64: figma.base64Encode(bytes) };
    })()`);
    if (result && result.base64) {
      const savePath = join(tmpdir(), `figma-verify-${String(nodeId).replace(/:/g, '-')}.png`);
      writeFileSync(savePath, Buffer.from(result.base64, 'base64'));
      console.log(JSON.stringify({ verify: { id: result.id, name: result.name, width: result.width, height: result.height, saved: savePath } }));
    } else if (result && result.error) {
      console.error(chalk.yellow('\u26a0 verify failed:'), result.error);
    }
  } catch (e) {
    console.error(chalk.yellow('\u26a0 verify failed:'), e.message);
  }
}


// Helper: Get next free X position for smart positioning (horizontal)
function getNextFreeX(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxX = 0;
      figma.currentPage.children.forEach(n => {
        maxX = Math.max(maxX, n.x + n.width);
      });
      return maxX;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

// Helper: Get next free Y position for smart positioning (vertical)
function getNextFreeY(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxY = 0;
      figma.currentPage.children.forEach(n => {
        maxY = Math.max(maxY, n.y + n.height);
      });
      return maxY;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

program
  .command('render <jsx>')
  .description('Render JSX to Figma (use --as-component to also convert result to a Figma component)')
  .option('--parent <id>', 'Parent node ID')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .option('--fast', 'Use fast daemon-based rendering (simple frames only)')
  .option('--as-component', 'After rendering, convert the resulting frame to a Figma component')
  .option('--keep-wrapper', 'Keep an outer flex Frame as a parent — disables the auto-split that turns "N items in a flex wrapper" into independent canvas items')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--verify', 'After rendering, return a screenshot of the result (saves PNG, prints JSON) — replaces a separate `figma-cli verify` roundtrip')
  .option('--no-auto-style', "Don't auto-apply a matching text style to <Text> that names none (textStyle= still works)")
  .action(async (rawJsx, options) => {
    const jsx = unescapeShell(rawJsx);
    warnUnknownProps([jsx]);
    await checkConnection();

    // Auto-split: if the caller passed a layout-only outer Frame with N child
    // Frames, treat it as render-batch. This is the canonical "N buttons / N
    // cards" intent — independent items, not a single bagged Frame. Opt out
    // with --keep-wrapper.
    if (!options.keepWrapper) {
      const split = detectWrapperSplit(jsx);
      if (split) {
        console.log(chalk.gray(`↳ outer flex wrapper detected — splitting to ${split.children.length} standalone items (--keep-wrapper to opt out)`));
        const args = [
          'render-batch',
          JSON.stringify(split.children),
          '--direction', split.direction,
        ];
        if (options.asComponent) args.push('--as-component');
        if (options.collection) args.push('--collection', options.collection);
        await program.parseAsync(args, { from: 'user' });
        return;
      }
    }

    try {
      // Helper: convert a rendered frame to a Figma component if --as-component was passed
      const maybeAsComponent = async (id) => {
        if (!options.asComponent) return;
        try {
          const r = await daemonExec('eval', { code:
            `(async () => {
              const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
              if (!n) throw new Error('Node not found after render: ${id}');
              const c = figma.createComponentFromNode(n);
              return { id: c.id, name: c.name };
            })()`
          });
          if (r && r.id) {
            console.log(chalk.green('✓ Converted to component: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
          }
        } catch (e) {
          console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
        }
      };

      // Calculate smart position if not specified
      let posX = options.x;
      let posY = options.y !== undefined ? options.y : 0;

      if (!options.parent && options.x === undefined && options.smartPosition !== false) {
        posX = getNextFreeX();
      }

      // ONE render path.
      //
      // `render` used to pick between three implementations — this parser, a
      // "fast path" for simple frames, and the external `figma-use` binary —
      // while `render-batch` always used this parser. The same JSX therefore
      // produced different auto-layout depending on which branch it fell into
      // (different flex default, different alignment defaults, no min/max), and
      // the external branch cost a process spawn per render.
      //
      // Everything now goes through parseJSX: one behaviour to reason about,
      // one place to fix, and no subprocess. See tests/live/parity-harness.mjs.
      const { FigmaClient } = await import('../figma-client.js');
      const client = new FigmaClient();
      if (options.collection) client.setCollection(options.collection);
      if (options.autoStyle === false) client.setAutoTextStyle(false);
      const code = await client.parseJSX(jsx, {
        x: posX,
        y: options.y !== undefined ? posY : undefined,
        parent: options.parent,
      });
      const result = await daemonExec('eval', { code });
      if (!result || !result.id) {
        throw new Error('Render returned no node id');
      }

      console.log(chalk.green('✓ Rendered: ' + result.id));
      if (result.name) console.log(chalk.gray('  name: ' + result.name));
      printUnresolvedVars(result.unresolved);
      printLayoutWarnings(result.layoutWarnings);
      printTextStyles(result.textStyles);
      recordCreated([result]);

      await maybeAsComponent(result.id);
      if (options.verify) await verifyRendered(result.id);
    } catch (e) {
      const msg = e.stderr || e.message || String(e);
      // Extract node context from error if available
      const nodeMatch = msg.match(/\[Node: ([^\]]+)\]/);
      if (nodeMatch) {
        console.log(chalk.red('✗ Render failed at ' + chalk.yellow(nodeMatch[1]) + ':'));
        console.log(chalk.red('  ' + msg.replace(/\[Node: [^\]]+\]\s*/, '')));
      } else {
        console.log(chalk.red('✗ Render failed: ' + msg));
      }
      // Hint for common errors
      if (msg.includes('FILL can only be set on children of auto-layout')) {
        console.log(chalk.yellow('  💡 Hint: w="fill" requires the parent Frame to have flex="row" or flex="col"'));
      }
      if (msg.includes('Cannot read properties of null')) {
        console.log(chalk.yellow('  💡 Hint: A variable binding (var:name) may not exist. Check with: var list'));
      }
    }
  });

program
  .command('render-batch')
  .description('Render multiple JSX frames in a single call (fast). Pass --as-component to promote each rendered frame to a Figma Component.')
  .argument('<jsxArray>', 'JSON array of JSX strings, e.g. \'["<Frame>...</Frame>","<Frame>...</Frame>"]\'')
  .option('-g, --gap <n>', 'Gap between frames', '40')
  .option('-d, --direction <dir>', 'Layout direction: row (horizontal) or col (vertical)', 'row')
  .option('--as-component', 'After rendering, convert each resulting frame to a Figma component')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--verify', 'After rendering, return a screenshot of each result (saves PNGs, prints JSON)')
  .option('--no-auto-style', "Don't auto-apply a matching text style to <Text> that names none (textStyle= still works)")
  .action(async (jsxArrayStr, options) => {
    await checkConnection();
    try {
      const jsxArray = JSON.parse(jsxArrayStr);
      if (!Array.isArray(jsxArray)) {
        throw new Error('Argument must be a JSON array of JSX strings');
      }
      warnUnknownProps(jsxArray);

      const gap = parseInt(options.gap) || 40;
      const vertical = options.direction === 'col' || options.direction === 'column' || options.direction === 'vertical';

      // Single daemon call for ALL frames (10x faster)
      let results = await daemonExec('render-batch', {
        jsxArray,
        gap,
        vertical,
        collection: options.collection || undefined,
        autoStyle: options.autoStyle === false ? false : undefined,
      });
      // Unwrap the wrapped form returned when there are warnings to report.
      let unresolvedVars = null;
      let layoutWarnings = null;
      let textStyles = null;
      if (results && !Array.isArray(results) && Array.isArray(results.frames)) {
        unresolvedVars = results.unresolved;
        layoutWarnings = results.layoutWarnings;
        textStyles = results.textStyles;
        results = results.frames;
      }

      if (Array.isArray(results)) {
        results.forEach(r => {
          console.log(chalk.green('✓ Rendered: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
        });
        console.log(chalk.cyan(`\n${results.length} frames created`));
        recordCreated(results);
        printUnresolvedVars(unresolvedVars);
        printLayoutWarnings(layoutWarnings);
        printTextStyles(textStyles);

        if (options.asComponent) {
          const ids = results.map(r => r.id).filter(Boolean);
          if (ids.length > 0) {
            try {
              const compInfo = await daemonExec('eval', { code:
                `(async () => {
                  const ids = ${JSON.stringify(ids)};
                  const out = [];
                  for (const id of ids) {
                    const n = await figma.getNodeByIdAsync(id);
                    if (!n) continue;
                    const c = figma.createComponentFromNode(n);
                    out.push({ id: c.id, name: c.name });
                  }
                  return out;
                })()`
              });
              if (Array.isArray(compInfo)) {
                compInfo.forEach(c => {
                  console.log(chalk.green('✓ Converted to component: ' + c.id + (c.name ? ' (' + c.name + ')' : '')));
                });
                console.log(chalk.cyan(`\n${compInfo.length} components created`));
              }
            } catch (e) {
              console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
            }
          }
        }

        if (options.verify) {
          for (const r of results) {
            if (r && r.id) await verifyRendered(r.id);
          }
        }
      } else {
        console.log(chalk.green('✓ Rendered'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Batch render failed: ' + (e.stderr || e.message)));
    }
  });

// ============ UNDO (last render) ============

program
  .command('undo')
  .description('Remove the node(s) created by the most recent render / render-batch')
  .action(async () => {
    await checkConnection();
    try {
      if (!existsSync(LAST_RENDER_FILE)) {
        console.log(chalk.gray('Nothing to undo.'));
        return;
      }
      const state = JSON.parse(readFileSync(LAST_RENDER_FILE, 'utf8'));
      const nodes = (state.nodes || []).filter(n => n && n.id);
      if (nodes.length === 0) {
        console.log(chalk.gray('Nothing to undo.'));
        return;
      }
      const result = await fastEval(`(async () => {
        let removed = 0;
        const names = [];
        for (const id of ${JSON.stringify(nodes.map(n => n.id))}) {
          const node = await figma.getNodeByIdAsync(id);
          if (node && !node.removed) { names.push(node.name); node.remove(); removed++; }
        }
        return { removed, names };
      })()`);
      try { unlinkSync(LAST_RENDER_FILE); } catch {}
      if (result && result.removed > 0) {
        console.log(chalk.green(`✓ Removed ${result.removed} node(s) from the last render:`));
        result.names.forEach(n => console.log(chalk.gray('  ' + n)));
      } else {
        console.log(chalk.gray('Nothing to undo (nodes already gone).'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Undo failed: ' + e.message));
    }
  });

// ============ DIAGNOSE ============

program
  .command('diagnose')
  .description('Check system compatibility and connection status')
  .action(async () => {
    console.log(chalk.cyan('\n🔍 Figma CLI Diagnostics\n'));

    // 1. Node version
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor >= 18) {
      console.log(chalk.green(`✓ Node.js ${nodeVersion}`));
    } else {
      console.log(chalk.red(`✗ Node.js ${nodeVersion} (need 18+)`));
    }

    // 2. Platform
    console.log(chalk.gray(`  Platform: ${platformName}`));

    // 3. Figma version
    try {
      const figmaVersion = getFigmaVersion();
      const major = parseInt(figmaVersion.split('.')[0]);
      if (major >= 126) {
        console.log(chalk.yellow(`⚠ Figma ${figmaVersion} (126+ blocks remote debugging by default)`));
      } else {
        console.log(chalk.green(`✓ Figma ${figmaVersion}`));
      }
    } catch {
      console.log(chalk.red('✗ Figma not found'));
    }

    // 4. Figma running?
    try {
      if (isFigmaRunning()) {
        console.log(chalk.green('✓ Figma is running'));
      } else {
        console.log(chalk.red('✗ Figma is not running'));
      }
    } catch {
      console.log(chalk.gray('  Could not check if Figma is running'));
    }

    // 5. Remote debugging port
    const cdpPort = getCdpPort();
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        console.log(chalk.green(`✓ Remote debugging enabled (port ${cdpPort})`));
      } else {
        console.log(chalk.red('✗ Remote debugging port not responding'));
      }
    } catch {
      console.log(chalk.red(`✗ Remote debugging not available (port ${cdpPort} closed)`));
      console.log(chalk.gray('  → Run: node src/index.js connect'));
    }

    // 6. Daemon status
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon running on port 3456'));
    } else {
      console.log(chalk.yellow('○ Daemon not running (optional, speeds up commands)'));
    }

    // 7. figma-use availability — only FigJam export still shells out to it.
    // render/node/analyze all run natively through the daemon now, so its
    // absence no longer limits the commands people actually hit here. It is
    // deliberately NOT a dependency: it drags in sharp, whose libvips CVEs
    // then show up in every user's `npm audit`. `npx --yes` fetches it the
    // first time a FigJam export actually needs it.
    try {
      execSync('which figma-use 2>/dev/null || where figma-use 2>nul', { encoding: 'utf8' });
      console.log(chalk.green('✓ figma-use installed (used by FigJam export)'));
    } catch {
      console.log(chalk.yellow('○ figma-use not in PATH (FigJam export fetches it via npx)'));
    }

    // 8. Connection test
    console.log(chalk.gray('\n  Testing connection...'));
    let client = null;
    try {
      client = await getFigmaClient();
      const result = await client.eval('({ file: figma.root.name, page: figma.currentPage.name })');
      console.log(chalk.green(`✓ Connected to "${result.file}" / "${result.page}"`));
    } catch (e) {
      console.log(chalk.red('✗ Connection failed: ' + e.message));
    } finally {
      // This opens its OWN CDP socket rather than going through the daemon.
      // Leaving it open kept the event loop alive, so `diagnose` printed its
      // whole report and then hung forever instead of exiting.
      try { client?.close(); } catch {}
    }

    console.log('');
  });

