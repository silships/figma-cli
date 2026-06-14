// Command: spec — read the authoritative spec for a component out of an
// extracted DESIGN.md (axes, sizes) and optionally ENFORCE it against a built
// node. All markdown reading happens here in code, so checking conformance
// costs zero LLM tokens — the CLI returns a compact digest / verdict, not the
// 600-line structure dump.
import chalk from 'chalk';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import { findComponentSpec, checkConformance } from '../lib/design-spec.js';

const MARKER = 'Sample variant structure:';   // a DESIGN.md with a Components section

// Find a DESIGN.md (any name) in cwd or one level of subdirs. CLI-side file
// reads only — no model tokens spent scanning.
function locateDesignMd(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const cwd = process.cwd();
  const candidates = [];
  const scanDir = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile() && e.endsWith('.md')) candidates.push(p);
      else if (st.isDirectory() && depth > 0) scanDir(p, depth - 1);
    }
  };
  scanDir(cwd, 1);
  // Prefer files that actually contain a Components section.
  for (const f of candidates) {
    try { if (readFileSync(f, 'utf8').includes(MARKER)) return f; } catch {}
  }
  return null;
}

// Measure a built node for conformance: type, variant property names, and each
// variant's name + size. Compact by design.
function measureCode(nodeId) {
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!n) return { error: 'node not found' };
    const out = { type: n.type, name: n.name };
    if (n.type === 'COMPONENT_SET') {
      out.variantProps = Object.keys(n.variantGroupProperties || {});
      out.variants = n.children.map(c => ({ name: c.name, w: Math.round(c.width), h: Math.round(c.height) }));
    } else {
      out.variants = [{ name: n.name, w: Math.round(n.width || 0), h: Math.round(n.height || 0) }];
    }
    return out;
  })()`;
}

program
  .command('spec <component>')
  .description('Read a component\'s authoritative spec (axes, sizes) from an extracted DESIGN.md; --check enforces it against a built node')
  .option('-f, --file <path>', 'DESIGN.md to read (default: auto-locate in cwd / subdirs)')
  .option('--check <nodeId>', 'Measure this node and ENFORCE the spec (exit 1 on violation)')
  .option('--tolerance <px>', 'Dimension tolerance in px for --check', '2')
  .action(async (component, options) => {
    const file = locateDesignMd(options.file);
    if (!file) {
      console.error(chalk.red('✗ No DESIGN.md found.'), 'Pass --file <path> or run from a folder that has one (try `figma-cli extract` first).');
      process.exit(1);
    }
    const md = readFileSync(file, 'utf8');
    const spec = findComponentSpec(md, component);
    if (!spec) {
      console.error(chalk.red(`✗ No component matching "${component}" in ${file}.`));
      process.exit(1);
    }

    if (!options.check) {
      // Digest mode — compact authoritative spec, no structure dump.
      const axisLines = Object.entries(spec.axes).map(([k, v]) => `  ${k}: ${v.join(', ')}`);
      console.log(chalk.bold(spec.name) + chalk.gray(`  (${spec.variants} variants${spec.page ? ` · ${spec.page}` : ''})`));
      if (axisLines.length) {
        console.log(chalk.gray('axes:'));
        console.log(axisLines.join('\n'));
      }
      if (spec.sample) {
        console.log(chalk.gray(`sample: ${spec.sample.name} → ${spec.sample.w}×${spec.sample.h}${spec.sample.padding ? ` padding ${spec.sample.padding}` : ''}`));
      }
      console.log(chalk.gray(`\nbuild to this, then enforce: figma-cli spec "${spec.name}" --check <nodeId>`));
      // Also emit JSON on the last line for programmatic use.
      console.log(JSON.stringify({ spec }));
      return;
    }

    // Check mode — measure + enforce. Hard rule: exit 1 on any violation.
    await checkConnection();
    let measured = await fastEval(measureCode(options.check));
    if (typeof measured === 'string') { try { measured = JSON.parse(measured); } catch {} }
    if (!measured || measured.error) {
      console.error(chalk.red('✗ Could not measure node:'), measured?.error || 'unknown');
      process.exit(1);
    }
    const { pass, rules } = checkConformance(spec, measured, { tolerance: parseFloat(options.tolerance) });
    console.log(chalk.bold(`Conformance: ${spec.name} vs ${options.check}`));
    for (const r of rules) console.log(`  ${r.ok ? chalk.green('✓') : chalk.red('✗')} ${r.msg}`);
    if (!rules.length) console.log(chalk.gray('  (no enforceable rules for this component)'));
    if (!pass) {
      console.log(chalk.red('\n✗ Build does NOT conform to the DESIGN.md spec.'));
      process.exit(1);
    }
    console.log(chalk.green('\n✓ Conforms to spec.'));
  });
