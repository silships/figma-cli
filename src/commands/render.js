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
  DAEMON_PORT,
  checkConnection,
  daemonExec,
  detectWrapperSplit,
  fastEval,
  figmaEvalSync,
  getDaemonToken,
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

// Helper: Extract properties that figma-use doesn't handle correctly
// Returns array of fixes to apply after render
function extractPostProcessFixes(jsx) {
  const fixes = [];

  // Match ALL Frame elements with wrapGap (counterAxisSpacing) - including nested
  const wrapGapRegex = /<Frame[^>]*\bwrapGap=\{(\d+)\}[^>]*>/g;
  let wrapMatch;
  while ((wrapMatch = wrapGapRegex.exec(jsx)) !== null) {
    const tag = wrapMatch[0];
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/);
    fixes.push({
      type: 'wrapGap',
      name: nameMatch ? nameMatch[1] : null,
      value: parseInt(wrapMatch[1])
    });
  }

  // Match absolute positioned children with x/y
  const absRegex = /<Frame[^>]*\bposition=["']absolute["'][^>]*>/g;
  let match;
  while ((match = absRegex.exec(jsx)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/);
    const xMatch = tag.match(/\bx=\{(\d+)\}/);
    const yMatch = tag.match(/\by=\{(\d+)\}/);

    if (nameMatch && (xMatch || yMatch)) {
      fixes.push({
        type: 'absolutePosition',
        name: nameMatch[1],
        x: xMatch ? parseInt(xMatch[1]) : null,
        y: yMatch ? parseInt(yMatch[1]) : null
      });
    }
  }

  return fixes;
}

// Helper: Apply post-process fixes to rendered node
async function applyPostProcessFixes(nodeId, fixes) {
  const code = `(async function() {
    const root = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!root) return { error: 'Node not found' };

    const results = [];

    // Helper to find node by name recursively
    const findByName = (node, name) => {
      if (node.name === name) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findByName(child, name);
          if (found) return found;
        }
      }
      return null;
    };

    // Helper to find all nodes with layoutWrap
    const findAllWrap = (node, results = []) => {
      if (node.layoutWrap === 'WRAP') results.push(node);
      if (node.children) {
        for (const child of node.children) {
          findAllWrap(child, results);
        }
      }
      return results;
    };

    ${fixes.map((fix, i) => {
      if (fix.type === 'wrapGap') {
        if (fix.name) {
          // Named element - find by name
          return `
            // Fix wrapGap for "${fix.name}"
            const wrapNode${i} = findByName(root, ${JSON.stringify(fix.name)});
            if (wrapNode${i} && wrapNode${i}.layoutWrap === 'WRAP') {
              wrapNode${i}.counterAxisSpacing = ${fix.value};
              results.push({ type: 'wrapGap', name: ${JSON.stringify(fix.name)}, value: ${fix.value}, applied: true });
            }
          `;
        } else {
          // No name - apply to first wrap element (root or first found)
          return `
            // Fix wrapGap on first wrap element
            const wrapNodes${i} = findAllWrap(root);
            if (wrapNodes${i}.length > 0) {
              wrapNodes${i}[0].counterAxisSpacing = ${fix.value};
              results.push({ type: 'wrapGap', value: ${fix.value}, applied: true });
            }
          `;
        }
      } else if (fix.type === 'absolutePosition') {
        return `
          // Fix absolute position for "${fix.name}"
          const absNode${i} = findByName(root, ${JSON.stringify(fix.name)});
          if (absNode${i} && absNode${i}.layoutPositioning === 'ABSOLUTE') {
            ${fix.x !== null ? `absNode${i}.x = ${fix.x};` : ''}
            ${fix.y !== null ? `absNode${i}.y = ${fix.y};` : ''}
            results.push({ type: 'absolutePosition', name: ${JSON.stringify(fix.name)}, x: ${fix.x}, y: ${fix.y}, applied: true });
          }
        `;
      }
      return '';
    }).join('\n')}

    return { fixes: results };
  })()`;

  try {
    if (isDaemonRunning()) {
      await daemonExec('eval', { code });
    } else {
      figmaEvalSync(code);
    }
  } catch (e) {
    // Silent fail - fixes are best-effort
  }
}

// Fast JSX parser for simple frames (daemon-based, 4x faster)
function parseSimpleJsx(jsx) {
  // Only handles single Frame element, no nesting
  const frameMatch = jsx.match(/^<Frame\s+([^>]+)\s*\/?>(?:<\/Frame>)?$/);
  if (!frameMatch) return null;

  const propsStr = frameMatch[1];
  const props = {};

  // Parse props: name="X" or name={X} or name='X'
  const propRegex = /(\w+)=(?:\{([^}]+)\}|"([^"]+)"|'([^']+)')/g;
  let match;
  while ((match = propRegex.exec(propsStr)) !== null) {
    const key = match[1];
    const value = match[2] || match[3] || match[4];
    props[key] = value;
  }

  return props;
}

function generateFigmaCode(props, x, y) {
  const name = props.name || 'Frame';
  const w = parseInt(props.w || props.width || 100);
  const h = parseInt(props.h || props.height || 100);
  const bg = props.bg || props.fill;
  const rounded = parseInt(props.rounded || props.cornerRadius || 0);
  const opacity = props.opacity ? parseFloat(props.opacity) : null;

  let code = `(function() {
    const f = figma.createFrame();
    f.name = ${JSON.stringify(name)};
    f.resize(${w}, ${h});
    f.x = ${x};
    f.y = ${y};`;

  if (rounded > 0) code += `\n    f.cornerRadius = ${rounded};`;
  if (opacity !== null) code += `\n    f.opacity = ${opacity};`;

  if (bg) {
    // Parse hex color
    const hex = bg.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    code += `\n    f.fills = [{type:'SOLID', color:{r:${r.toFixed(3)},g:${g.toFixed(3)},b:${b.toFixed(3)}}}];`;
  }

  code += `\n    return { id: f.id, name: f.name };
  })()`;

  return code;
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

      // Check if JSX uses features that require our own renderer:
      // - var:name syntax for variable binding
      // - <Slot> elements for component slots
      // - <Icon> elements
      // - gradient/effects/blur (needs full parser, fast-path doesn't handle them)
      if (jsx.includes('var:') || jsx.includes('<Slot') || jsx.includes('<Icon') ||
          /-gradient\s*\(/i.test(jsx) || jsx.includes('shadow=') || jsx.includes('innerShadow=') ||
          jsx.includes('blur=') || jsx.includes('bgBlur=') || jsx.includes('image=') ||
          jsx.includes('noise=') || jsx.includes('texture=') || jsx.includes('progressiveBlur=') ||
          jsx.includes('glass=') ||
          jsx.includes('font=') || jsx.includes('italic=') || jsx.includes('justify="between"') ||
          /weight="(thin|hairline|extralight|ultralight|light|extrabold|ultrabold|black|heavy)"/.test(jsx)) {
        const { FigmaClient } = await import('../figma-client.js');
        const client = new FigmaClient();
        if (options.collection) client.setCollection(options.collection);
        const code = await client.parseJSX(jsx);
        const result = await daemonExec('eval', { code });
        if (result && result.id) {
          console.log(chalk.green('✓ Rendered: ' + result.id));
          if (result.name) console.log(chalk.gray('  name: ' + result.name));
          printUnresolvedVars(result.unresolved);
          recordCreated([result]);
          await maybeAsComponent(result.id);
          if (options.verify) await verifyRendered(result.id);
          return;
        }
      }

      // Try fast path for simple frames
      if (options.fast || (!jsx.includes('><') && !jsx.includes('</Frame><'))) {
        const simpleProps = parseSimpleJsx(jsx.trim());
        if (simpleProps && isDaemonRunning()) {
          const code = generateFigmaCode(simpleProps, posX || 0, posY);
          const result = await daemonExec('eval', { code });
          if (result && result.id) {
            console.log(chalk.green('✓ Rendered: ' + result.id));
            if (result.name) console.log(chalk.gray('  name: ' + result.name));
            recordCreated([result]);
            await maybeAsComponent(result.id);
            if (options.verify) await verifyRendered(result.id);
            return;
          }
        }
      }

      // Extract props that figma-use doesn't handle correctly
      const postProcessFixes = extractPostProcessFixes(jsx);

      // Check if we're in Safe Mode (plugin only, no CDP)
      let useDaemonRender = false;
      try {
        const healthToken = getDaemonToken();
        const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
        const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
        const health = JSON.parse(healthRes);
        useDaemonRender = health.plugin && !health.cdp; // Safe Mode
      } catch {}

      let result;
      if (useDaemonRender) {
        // Safe Mode: use daemon render (works via plugin)
        result = await daemonExec('render', { jsx });
        // Position the frame after creation
        if (result && result.id && (posX !== undefined || posY !== undefined)) {
          await fastEval(`(async () => {
            const n = await figma.getNodeByIdAsync("${result.id}");
            if (n) { ${posX !== undefined ? `n.x = ${posX};` : ''} n.y = ${posY}; }
          })()`);
        }
      } else {
        // Yolo Mode: use figma-use (full JSX support, faster)
        let cmd = 'figma-use render --stdin --json';
        if (options.parent) cmd += ` --parent "${options.parent}"`;
        if (posX !== undefined) cmd += ` --x ${posX}`;
        cmd += ` --y ${posY}`;

        const output = execSync(cmd, {
          input: jsx,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000
        });
        result = JSON.parse(output.trim());
      }

      console.log(chalk.green('✓ Rendered: ' + result.id));
      if (result.name) console.log(chalk.gray('  name: ' + result.name));
      recordCreated([result]);

      // Post-process to fix properties figma-use doesn't set correctly
      if (postProcessFixes.length > 0) {
        await applyPostProcessFixes(result.id, postProcessFixes);
      }

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
      });
      // Unwrap the wrapped form returned when there are unresolved vars.
      let unresolvedVars = null;
      if (results && !Array.isArray(results) && Array.isArray(results.frames)) {
        unresolvedVars = results.unresolved;
        results = results.frames;
      }

      if (Array.isArray(results)) {
        results.forEach(r => {
          console.log(chalk.green('✓ Rendered: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
        });
        console.log(chalk.cyan(`\n${results.length} frames created`));
        recordCreated(results);
        if (unresolvedVars && unresolvedVars.length > 0) {
          console.log(chalk.yellow(`\n⚠ ${unresolvedVars.length} variable reference(s) could not be resolved:`));
          console.log(chalk.yellow('  ' + unresolvedVars.join(', ')));
          console.log(chalk.gray('  These bindings rendered as grey placeholders. Check `figma-cli var list` (optionally with --collection).'));
        }

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

    // 7. figma-use availability
    try {
      execSync('which figma-use 2>/dev/null || where figma-use 2>nul', { encoding: 'utf8' });
      console.log(chalk.green('✓ figma-use installed'));
    } catch {
      console.log(chalk.yellow('○ figma-use not in PATH (some features limited)'));
    }

    // 8. Connection test
    console.log(chalk.gray('\n  Testing connection...'));
    try {
      const client = await getFigmaClient();
      const result = await client.eval('({ file: figma.root.name, page: figma.currentPage.name })');
      console.log(chalk.green(`✓ Connected to "${result.file}" / "${result.page}"`));
    } catch (e) {
      console.log(chalk.red('✗ Connection failed: ' + e.message));
    }

    console.log('');
  });

