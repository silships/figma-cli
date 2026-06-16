// Command: instantiate — drop an instance of an EXISTING component using the
// reuse handle captured in an extracted DESIGN.md, instead of rebuilding it.
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import { findComponentSpec } from '../lib/design-spec.js';
import { locateDesignMd } from '../lib/design-md-locate.js';
import { resolveInstancePlan } from '../lib/instance-plan.js';

// Build the async, dynamic-page-safe eval that tries each plan step in order.
// Exported for unit testing. A COMPONENT_SET resolves to its default variant
// (a set has no createInstance). First success wins; failures are collected.
export function instantiateCode(plan) {
  return `(async () => {
    const plan = ${JSON.stringify(plan)};
    const tried = [];
    for (const step of plan) {
      try {
        let comp;
        if (step.via === 'key') comp = await figma.importComponentByKeyAsync(step.key);
        else comp = await figma.getNodeByIdAsync(step.id);
        if (!comp) { tried.push(step.via + ': not found'); continue; }
        if (comp.type === 'COMPONENT_SET') comp = comp.defaultVariant || comp.children[0];
        if (!comp || comp.type !== 'COMPONENT') { tried.push(step.via + ': not a component'); continue; }
        const inst = comp.createInstance();
        const c = figma.viewport.center;
        inst.x = Math.round(c.x); inst.y = Math.round(c.y);
        figma.currentPage.appendChild(inst);
        figma.currentPage.selection = [inst];
        figma.viewport.scrollAndZoomIntoView([inst]);
        return JSON.stringify({ ok: true, via: step.via, id: inst.id, name: inst.name });
      } catch (e) { tried.push(step.via + ': ' + e.message); }
    }
    return JSON.stringify({ ok: false, tried });
  })()`;
}

program
  .command('instantiate <name>')
  .description('Drop an instance of an EXISTING component (reuse handle from DESIGN.md) instead of rebuilding it')
  .option('-f, --file <path>', 'DESIGN.md to read (default: auto-locate in cwd / subdirs)')
  .action(async (name, options) => {
    const file = locateDesignMd(options.file);
    if (!file) {
      console.error(chalk.red('✗ No DESIGN.md found.'), 'Run `figma-cli extract` first or pass --file.');
      process.exit(1);
    }
    const md = readFileSync(file, 'utf8');
    const spec = findComponentSpec(md, name);
    if (!spec) {
      console.error(chalk.red(`✗ No component matching "${name}" in ${file}.`));
      process.exit(1);
    }
    if (!spec.reuse) {
      console.error(chalk.red(`✗ No reuse handle for "${spec.name}".`), 'Re-run `figma-cli extract` to capture it.');
      process.exit(1);
    }
    const plan = resolveInstancePlan(spec.reuse);
    await checkConnection();
    let res = await fastEval(instantiateCode(plan));
    if (typeof res === 'string') { try { res = JSON.parse(res); } catch {} }
    if (!res || !res.ok) {
      console.error(chalk.red(`✗ Could not instantiate "${spec.name}".`),
        res?.tried ? chalk.gray('Tried — ' + res.tried.join('; ')) : '');
      process.exit(1);
    }
    console.log(chalk.green(`✓ Instanced "${spec.name}" via ${res.via} → ${res.id}`));
    process.exit(0);
  });
