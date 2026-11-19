// Commands: variants (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'path';
import { listComponents, getComponent, getAllComponents, getVariety, VISUAL_COMPONENTS } from '../shadcn.js';
import {
  program,
  checkConnection,
  fastEval,
  fastRender
} from '../lib/cli-core.js';
import { planVariants } from '../lib/variant-plan.js';

// ============ SIZES ============

program
  .command('sizes [nodeId]')
  .description('Generate Small/Medium/Large size variants from a component')
  .option('-b, --base <size>', 'Which size is the source: small, medium, large', 'medium')
  .option('-g, --gap <n>', 'Gap between variants', '40')
  .action(async (nodeId, options) => {
    await checkConnection();
    const spinner = ora('Analyzing component...').start();

    try {
      const nodeIdStr = nodeId || '';
      const baseSize = options.base.toLowerCase();
      const gap = parseInt(options.gap) || 40;

      // Size multipliers relative to medium
      const sizeConfig = {
        small:  { scale: 0.85, fontSize: 0.85, padding: 0.75, radius: 0.85 },
        medium: { scale: 1.0,  fontSize: 1.0,  padding: 1.0,  radius: 1.0 },
        large:  { scale: 1.2,  fontSize: 1.15, padding: 1.25, radius: 1.1 }
      };

      // Adjust multipliers based on which size is the source
      let multipliers = {};
      const baseConfig = sizeConfig[baseSize];
      for (const [size, cfg] of Object.entries(sizeConfig)) {
        multipliers[size] = {
          scale: cfg.scale / baseConfig.scale,
          fontSize: cfg.fontSize / baseConfig.fontSize,
          padding: cfg.padding / baseConfig.padding,
          radius: cfg.radius / baseConfig.radius
        };
      }

      const code = `(async () => {
        let node;
        if (${JSON.stringify(nodeIdStr)}) {
          node = await figma.getNodeByIdAsync(${JSON.stringify(nodeIdStr)});
        } else {
          node = figma.currentPage.selection[0];
        }

        if (!node) {
          return { error: 'No component selected. Select a component or frame.' };
        }

        // Get the component to clone
        let sourceComponent = null;
        if (node.type === 'COMPONENT') {
          sourceComponent = node;
        } else if (node.type === 'INSTANCE') {
          sourceComponent = await node.getMainComponentAsync();
        } else if (node.type === 'FRAME') {
          // Convert frame to component first
          sourceComponent = figma.createComponentFromNode(node.clone());
          sourceComponent.name = node.name;
        }

        if (!sourceComponent) {
          return { error: 'Could not get source component.' };
        }

        // Load common Inter font styles
        const styles = ['Regular', 'Medium', 'Semi Bold', 'Bold'];
        for (const style of styles) {
          try { await figma.loadFontAsync({ family: 'Inter', style }); } catch (e) {}
        }

        const multipliers = ${JSON.stringify(multipliers)};
        const sizes = ['small', 'medium', 'large'];
        const baseSize = ${JSON.stringify(baseSize)};
        const gap = ${gap};

        // Find position for new components
        let startX = 0;
        figma.currentPage.children.forEach(n => { startX = Math.max(startX, n.x + n.width); });
        startX += 200;
        const startY = sourceComponent.y;

        const baseName = sourceComponent.name.replace(/\\/(Small|Medium|Large)/gi, '').replace(/\\s*(Small|Medium|Large)\\s*/gi, '').trim() || 'Component';
        const createdComponents = [];

        function scaleNode(node, mult) {
          // Scale frame/rectangle dimensions
          if (node.resize && typeof node.width === 'number') {
            const newW = Math.round(node.width * mult.scale);
            const newH = Math.round(node.height * mult.scale);
            node.resize(newW, newH);
          }

          // Scale corner radius
          if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
            node.cornerRadius = Math.round(node.cornerRadius * mult.radius);
          }

          // Scale padding
          if (node.paddingLeft !== undefined) {
            node.paddingLeft = Math.round(node.paddingLeft * mult.padding);
            node.paddingRight = Math.round(node.paddingRight * mult.padding);
            node.paddingTop = Math.round(node.paddingTop * mult.padding);
            node.paddingBottom = Math.round(node.paddingBottom * mult.padding);
          }

          // Scale gap
          if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
            node.itemSpacing = Math.round(node.itemSpacing * mult.padding);
          }

          // Scale text
          if (node.type === 'TEXT') {
            const newSize = Math.round(node.fontSize * mult.fontSize);
            node.fontSize = newSize;
          }

          // Recurse into children
          if (node.children) {
            for (const child of node.children) {
              scaleNode(child, mult);
            }
          }
        }

        let x = startX;
        for (const size of sizes) {
          const mult = multipliers[size];

          // Clone the source component
          const clone = sourceComponent.clone();

          // Scale all elements
          scaleNode(clone, mult);

          // Convert to component with size name
          const sizeLabel = size.charAt(0).toUpperCase() + size.slice(1);

          let comp;
          if (clone.type === 'COMPONENT') {
            comp = clone;
            comp.name = baseName + '/' + sizeLabel;
          } else {
            comp = figma.createComponentFromNode(clone);
            comp.name = baseName + '/' + sizeLabel;
          }

          comp.x = x;
          comp.y = startY;
          x += comp.width + gap;

          createdComponents.push({ id: comp.id, name: comp.name, w: comp.width, h: comp.height });
        }

        figma.currentPage.selection = createdComponents.map(c => figma.getNodeById(c.id)).filter(Boolean);
        figma.viewport.scrollAndZoomIntoView(figma.currentPage.selection);

        return { count: createdComponents.length, components: createdComponents };
      })()`;

      const result = await fastEval(code);

      if (result.error) {
        spinner.fail(result.error);
        return;
      }

      spinner.succeed(`Created ${result.count} size variants`);

      result.components.forEach(c => {
        console.log(chalk.gray(`  ${c.name} (${c.w}×${c.h})`));
      });

    } catch (error) {
      spinner.fail('Failed: ' + error.message);
    }
  });

// ============ VARIANTS ============
// Turn a set of frames OR components into a real Figma Component Set
// (variant set) with a named variant property. Solves the common case:
// "I have N frames that should be variants of one component."
//
// Usage:
//   figma-cli variants from 1:2,1:3,1:4 \
//     --property Size --values Small,Medium,Large --name Button
//
// Accepts FRAMEs (auto-promoted to components), GROUPs, or existing
// COMPONENTs. INSTANCEs are rejected with a clear error.

const variantsCmd = program
  .command('variants')
  .description('Build variant sets from frames or components');

variantsCmd
  .command('from <ids>')
  .description('Combine frames/components into a Variant Set. <ids> is a comma list, "selection", or "auto" (all page-level nodes already named prop=value).')
  .option('-p, --property <name>', 'Variant property name (e.g., Size, State, Color)')
  .option('-v, --values <values>', 'Comma-separated variant values matching the IDs (e.g., Small,Medium,Large)')
  .option('-m, --multi', 'Multi-axis: keep each node\'s existing "prop=value, prop2=value2" name and derive ALL properties from it')
  .option('-n, --name <name>', 'Name for the resulting Component Set (defaults to first node\'s base name)')
  .action(async (ids, options) => {
    await checkConnection();

    const source = ids.trim().toLowerCase();
    const idArr = (source === 'selection' || source === 'auto')
      ? []
      : ids.split(',').map(s => s.trim()).filter(Boolean);
    const valueArr = options.values
      ? options.values.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const spinner = ora('Building Variant Set...').start();

    // Step 1 — resolve the node list (id/name/type only, tiny payload).
    // "auto" is what makes a 144-variant build practical: after
    // `render-batch --as-component` the names already carry the axes, so the
    // user never has to paste 144 ids into a shell command.
    const collectCode = `(async () => {
      const source = ${JSON.stringify(source)};
      const ids = ${JSON.stringify(idArr)};
      const brief = (n) => ({ id: n.id, name: n.name, type: n.type });
      if (source === 'selection') {
        return { nodes: figma.currentPage.selection.map(brief) };
      }
      if (source === 'auto') {
        const isAxisName = (s) => /^[^,=]+=[^,=]+(\\s*,\\s*[^,=]+=[^,]+)*$/.test(String(s || '').trim());
        const nodes = figma.currentPage.children
          .filter(n => (n.type === 'COMPONENT' || n.type === 'FRAME') && isAxisName(n.name))
          .map(brief);
        return { nodes };
      }
      const out = [];
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) return { error: 'Node not found: ' + id };
        out.push(brief(n));
      }
      return { nodes: out };
    })()`;

    let nodes;
    try {
      const collected = await fastEval(collectCode);
      if (collected && collected.error) { spinner.fail(collected.error); process.exit(1); }
      nodes = (collected && collected.nodes) || [];
    } catch (e) {
      spinner.fail('Failed to read nodes: ' + (e.message || String(e)));
      process.exit(1);
    }

    if (!nodes.length) {
      spinner.fail(source === 'auto'
        ? 'No page-level nodes named "prop=value" found. Render them with names like "size=small, state=rest" first.'
        : source === 'selection' ? 'Nothing selected in Figma.' : 'No nodes resolved.');
      process.exit(1);
    }

    // Step 2 — plan the names purely (unit-tested in tests/variant-plan.test.js).
    const plan = planVariants(nodes, {
      property: options.property,
      values: valueArr,
      multi: !!options.multi,
      setName: options.name,
    });
    if (plan.error) {
      spinner.fail(plan.error);
      process.exit(1);
    }

    // Step 3 — promote, rename, combine.
    const code = `(async () => {
      const assignments = ${JSON.stringify(plan.assignments)};
      const setName = ${JSON.stringify(plan.setName)};

      const components = [];
      const promoted = [];

      for (const a of assignments) {
        const node = await figma.getNodeByIdAsync(a.id);
        if (!node) return { error: 'Node not found: ' + a.id };
        let comp;
        if (node.type === 'COMPONENT') {
          if (node.parent && node.parent.type === 'COMPONENT_SET') {
            return { error: 'Node ' + a.id + ' is already a variant inside a Component Set. Pass the source frames or standalone components.' };
          }
          comp = node;
        } else if (node.type === 'FRAME' || node.type === 'GROUP') {
          comp = figma.createComponentFromNode(node);
          promoted.push(a.id);
        } else if (node.type === 'INSTANCE') {
          return { error: 'Node ' + a.id + ' is an INSTANCE. Pass the source frame or main component instead.' };
        } else {
          return { error: 'Unsupported type for ' + a.id + ': ' + node.type + '. Must be FRAME, GROUP, or COMPONENT.' };
        }
        components.push({ comp, name: a.name });
      }

      // Figma derives the variant properties from the component NAMES, so the
      // plan's names are applied verbatim: pure "Property=Value" (single axis)
      // or the node's own multi-axis name. A base-name prefix would make Figma
      // invent an extra unnamed property, which is why the set carries the name.
      for (const { comp, name } of components) comp.name = name;

      // combineAsVariants requires all components to belong to the same parent.
      // We hoist them to currentPage to guarantee this regardless of where the
      // source frames lived (e.g. nested inside a layout frame).
      const page = figma.currentPage;
      for (const { comp } of components) {
        if (comp.parent !== page) page.appendChild(comp);
      }

      let set;
      try {
        set = figma.combineAsVariants(components.map(c => c.comp), page);
      } catch (err) {
        return { error: 'combineAsVariants failed: ' + (err && err.message ? err.message : String(err)) };
      }
      set.name = setName;

      figma.currentPage.selection = [set];
      figma.viewport.scrollAndZoomIntoView([set]);

      return {
        id: set.id,
        name: set.name,
        promotedCount: promoted.length,
        count: components.length
      };
    })()`;

    try {
      const r = await fastEval(code);
      if (r && r.error) {
        spinner.fail(r.error);
        process.exit(1);
      }
      spinner.succeed(`Created Variant Set "${r.name}" (${r.count} variants)`);
      if (r.promotedCount > 0) {
        console.log(chalk.gray(`  Promoted ${r.promotedCount} frame(s) to components`));
      }
      for (const [prop, values] of Object.entries(plan.axes)) {
        console.log(chalk.gray(`  ${chalk.white(prop)}: ${values.join(', ')}`));
      }
      console.log(chalk.cyan(`  ${r.id}`));
    } catch (e) {
      spinner.fail('Failed: ' + (e.message || String(e)));
      process.exit(1);
    }
  });

// ============ COMBOS ============

program
  .command('combos [nodeId]')
  .description('Generate all component variant combinations in a labeled grid')
  .option('-g, --gap <n>', 'Gap between instances', '40')
  .option('--no-labels', 'Skip row/column labels')
  .option('--no-boolean', 'Skip boolean properties')
  .option('--dry-run', 'Show combinations without creating instances')
  .action(async (nodeId, options) => {
    await checkConnection();
    const spinner = ora('Analyzing component properties...').start();

    try {
      const includeBoolean = options.boolean !== false;
      const nodeIdStr = nodeId || '';

      const analysisCode = `(async () => {
        let node;
        if (${JSON.stringify(nodeIdStr)}) {
          node = await figma.getNodeByIdAsync(${JSON.stringify(nodeIdStr)});
        } else {
          node = figma.currentPage.selection[0];
        }

        if (!node) {
          return { error: 'No component selected. Select a component set or provide a node ID.' };
        }

        let componentSet = null;
        if (node.type === 'COMPONENT_SET') {
          componentSet = node;
        } else if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
          componentSet = node.parent;
        } else if (node.type === 'INSTANCE') {
          const main = await node.getMainComponentAsync();
          if (main?.parent?.type === 'COMPONENT_SET') {
            componentSet = main.parent;
          }
        }

        if (!componentSet) {
          return { error: 'Selected node is not a component set or variant. Select a component with variants.' };
        }

        const propDefs = componentSet.componentPropertyDefinitions;
        if (!propDefs || Object.keys(propDefs).length === 0) {
          return { error: 'Component has no properties defined.' };
        }

        const properties = [];
        for (const [name, def] of Object.entries(propDefs)) {
          if (def.type === 'VARIANT') {
            properties.push({ name, type: 'VARIANT', options: def.variantOptions || [] });
          } else if (def.type === 'BOOLEAN' && ${includeBoolean}) {
            properties.push({ name, type: 'BOOLEAN', options: [true, false] });
          }
        }

        if (properties.length === 0) {
          return { error: 'No variant or boolean properties found.' };
        }

        const defaultVariant = componentSet.defaultVariant;
        if (!defaultVariant) {
          return { error: 'Could not find default variant.' };
        }

        // Find max size across all variants (for proper grid spacing)
        let maxW = 0, maxH = 0;
        for (const child of componentSet.children) {
          if (child.type === 'COMPONENT') {
            maxW = Math.max(maxW, child.width);
            maxH = Math.max(maxH, child.height);
          }
        }

        return {
          componentSetId: componentSet.id,
          componentSetName: componentSet.name,
          defaultVariantId: defaultVariant.id,
          properties,
          instanceSize: { w: maxW || defaultVariant.width, h: maxH || defaultVariant.height }
        };
      })()`;

      const analysis = await fastEval(analysisCode);

      if (analysis.error) {
        spinner.fail(analysis.error);
        return;
      }

      // Calculate cartesian product of all options
      function cartesian(arrays) {
        return arrays.reduce((a, b) => a.flatMap(x => b.map(y => [...x, y])), [[]]);
      }

      const optionArrays = analysis.properties.map(p => p.options);
      const combinations = cartesian(optionArrays);
      const totalCombos = combinations.length;

      spinner.text = `Found ${totalCombos} combinations for ${analysis.properties.length} properties`;

      if (options.dryRun) {
        spinner.succeed(`${totalCombos} combinations (dry run)`);
        console.log(chalk.cyan('\nProperties:'));
        analysis.properties.forEach(p => {
          console.log(`  ${p.name}: ${p.options.join(', ')}`);
        });
        console.log(chalk.cyan(`\nWould create ${totalCombos} instances`));
        return;
      }

      // Determine grid layout
      const gap = parseInt(options.gap) || 40;
      const labelHeight = options.labels !== false ? 30 : 0;
      const labelWidth = options.labels !== false ? 120 : 0;
      const colProp = analysis.properties[analysis.properties.length - 1];
      const rowProps = analysis.properties.slice(0, -1);
      const numCols = colProp.options.length;
      const numRows = rowProps.length > 0 ? rowProps.reduce((acc, p) => acc * p.options.length, 1) : 1;
      const instanceW = analysis.instanceSize.w;
      const instanceH = analysis.instanceSize.h;
      const showLabels = options.labels !== false;

      spinner.text = `Creating ${totalCombos} components in ${numRows}x${numCols} grid...`;

      const createCode = `(async () => {
        const componentSet = await figma.getNodeByIdAsync(${JSON.stringify(analysis.componentSetId)});
        const defaultVariant = await figma.getNodeByIdAsync(${JSON.stringify(analysis.defaultVariantId)});

        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
        await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

        let startX = 0;
        figma.currentPage.children.forEach(n => { startX = Math.max(startX, n.x + n.width); });
        startX += 200;
        const startY = 100;

        const gap = ${gap};
        const instanceW = ${instanceW};
        const instanceH = ${instanceH};
        const baseName = ${JSON.stringify(analysis.componentSetName)};
        const showLabels = ${showLabels};
        const labelOffset = showLabels ? 120 : 0;
        const headerOffset = showLabels ? 40 : 0;

        const properties = ${JSON.stringify(analysis.properties)};
        const combinations = ${JSON.stringify(combinations)};
        const colProp = properties[properties.length - 1];
        const rowProps = properties.slice(0, -1);

        const createdComponents = [];
        const createdLabels = [];
        const rowCombos = new Map();
        for (const combo of combinations) {
          const rowKey = combo.slice(0, -1).join('|');
          if (!rowCombos.has(rowKey)) rowCombos.set(rowKey, []);
          rowCombos.get(rowKey).push(combo);
        }

        // Create column headers (last property values)
        if (showLabels) {
          for (let colIndex = 0; colIndex < colProp.options.length; colIndex++) {
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Medium' };
            label.characters = String(colProp.options[colIndex]);
            label.fontSize = 14;
            label.fills = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }];
            label.x = startX + labelOffset + colIndex * (instanceW + gap) + instanceW / 2 - label.width / 2;
            label.y = startY;
            createdLabels.push(label);
          }
        }

        let rowIndex = 0;
        for (const [rowKey, combos] of rowCombos) {
          // Create row label (all properties except last)
          if (showLabels && rowProps.length > 0) {
            const rowValues = rowKey.split('|');
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Regular' };
            label.characters = rowValues.join(' / ');
            label.fontSize = 12;
            label.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
            label.x = startX;
            label.y = startY + headerOffset + rowIndex * (instanceH + gap) + instanceH / 2 - label.height / 2;
            createdLabels.push(label);
          }

          for (let colIndex = 0; colIndex < combos.length; colIndex++) {
            const combo = combos[colIndex];

            // Create instance and set properties
            const instance = defaultVariant.createInstance();
            const propsToSet = {};
            for (let i = 0; i < properties.length; i++) {
              propsToSet[properties[i].name] = combo[i];
            }
            try {
              instance.setProperties(propsToSet);
            } catch (e) {
              instance.remove();
              continue;
            }

            // Detach from component to get a frame
            const detached = instance.detachInstance();

            // Convert to component with proper name
            const compName = baseName + '/' + combo.join('/');
            const component = figma.createComponentFromNode(detached);
            component.name = compName;

            // Position on canvas (offset for labels)
            component.x = startX + labelOffset + colIndex * (instanceW + gap);
            component.y = startY + headerOffset + rowIndex * (instanceH + gap);

            createdComponents.push({ id: component.id, name: component.name });
          }
          rowIndex++;
        }

        const allNodes = [...createdComponents.map(c => figma.getNodeById(c.id)), ...createdLabels].filter(Boolean);
        figma.currentPage.selection = allNodes;
        if (allNodes.length > 0) {
          figma.viewport.scrollAndZoomIntoView(allNodes);
        }

        return { count: createdComponents.length, labels: createdLabels.length, gridSize: rowIndex + 'x' + colProp.options.length, components: createdComponents.slice(0, 3) };
      })()`;

      const result = await fastEval(createCode);

      if (result.error) {
        spinner.fail(result.error);
        return;
      }

      const labelInfo = result.labels > 0 ? ` with ${result.labels} labels` : '';
      spinner.succeed(`Created ${result.count} components in ${result.gridSize} grid${labelInfo}`);
      if (result.components && result.components.length > 0) {
        console.log(chalk.gray(`  ${result.components.map(c => c.name).join(', ')}${result.count > 3 ? ', ...' : ''}`));
      }

    } catch (error) {
      spinner.fail('Failed: ' + error.message);
    }
  });

// ─── shadcn/ui Component Package ───────────────────────────────────
const shadcn = program
  .command('shadcn')
  .description('Generate shadcn/ui components in Figma (requires: tokens preset shadcn)');

shadcn
  .command('list')
  .description('List all available shadcn/ui components')
  .action(() => {
    const { available, interactive } = listComponents();
    console.log(chalk.bold('\n  Available components:\n'));
    available.forEach(name => {
      const variants = getComponent(name);
      console.log(`  ${chalk.green('●')} ${chalk.white(name)} ${chalk.gray(`(${variants.length} variant${variants.length > 1 ? 's' : ''})`)}`);
    });
    console.log(chalk.bold('\n  Interactive only (not generated):\n'));
    console.log(`  ${chalk.gray(interactive.join(', '))}`);
    console.log();
  });

shadcn
  .command('add [names...]')
  .description('Add shadcn/ui component(s) to Figma canvas. Use --count to add multiple copies of the same component.')
  .option('--all', 'Add all components')
  .option('-c, --count <n>', 'Add this many copies of each named component (e.g. --count 3 for 3 cards)', '1')
  .option('--no-component', 'Leave the rendered nodes as frames instead of converting them to real Figma components')
  .action(async (names, options) => {
    await checkConnection();
    const count = Math.max(1, parseInt(options.count) || 1);

    let items;
    if (options.all) {
      items = getAllComponents();
    } else if (names && names.length > 0) {
      items = [];
      const userPassedCount = options.count !== undefined && options.count !== '1';
      for (const name of names) {
        const comp = getComponent(name);
        if (!comp) {
          console.log(chalk.red(`  ✗ Unknown component: ${name}`));
          console.log(chalk.gray(`  Available: ${VISUAL_COMPONENTS.join(', ')}`));
          return;
        }
        // Semantics:
        //   `shadcn add button`           → all 9 variants once (the variant gallery)
        //   `shadcn add button --count 4` → 4 copies of the DEFAULT variant (= comp[0])
        //                                   (the user asked for 4 buttons, not 4×9=36)
        if (userPassedCount) {
          // If this component has a variety pool, N copies means N DIFFERENT
          // designs (e.g. 4 cards = 4 distinct layouts), not N clones.
          const varietySet = getVariety(name, count);
          if (varietySet) {
            items.push(...varietySet);
          } else {
            // No variety pool: the user asked for N "Button"s, not N "Button /
            // Default"s — the " / Variant" suffix is a gallery-grouping
            // convention that makes no sense for plain copies. Strip it from the
            // label and the JSX root-frame name (first name="..." is the root).
            const base = comp[0];
            const cleanName = base.name.split(' / ')[0];
            const cleanItem = {
              ...base,
              name: cleanName,
              jsx: base.jsx.replace(/name="[^"]*"/, `name="${cleanName}"`),
            };
            for (let i = 0; i < count; i++) items.push(cleanItem);
          }
        } else {
          items.push(...comp);
        }
      }
    } else {
      console.log(chalk.yellow('  Specify component names or use --all'));
      console.log(chalk.gray(`  Example: node src/index.js shadcn add card --count 3`));
      console.log(chalk.gray(`  Available: ${VISUAL_COMPONENTS.join(', ')}`));
      return;
    }

    const label = count > 1 ? ` (${count}x)` : '';
    const spinner = ora(`Creating ${items.length} shadcn/ui component(s)${label}...`).start();
    let created = 0;
    let failed = 0;
    // Track the real node IDs of everything we render. Without this the command
    // printed only "Created N component(s)" and callers (a user, or an LLM
    // driving the CLI) had NO ids to reference for follow-ups like `set scale`
    // or `node to-component` — they'd guess ids that don't exist and every
    // follow-up failed with "No node found".
    const madeNodes = [];

    for (const item of items) {
      try {
        const result = await fastRender(item.jsx);
        if (result && result.id) {
          created++;
          madeNodes.push({ id: result.id, name: item.name });
          spinner.text = `Created ${created}/${items.length}: ${item.name}`;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        spinner.text = `Failed: ${item.name} (${err.message})`;
      }
    }

    // The command promises "component(s)" — so make them REAL Figma components,
    // not bare frames (matches the always-make-components rule). --no-component
    // opts out. createComponentFromNode returns a NEW node, so we capture the
    // component's id (the frame id becomes invalid) and report THAT.
    let finalNodes = madeNodes;
    if (options.component !== false && madeNodes.length > 0) {
      spinner.text = 'Converting to components...';
      try {
        const conv = await fastEval(`(async () => {
          const ids = ${JSON.stringify(madeNodes.map(m => m.id))};
          const out = [];
          for (const id of ids) {
            const n = await figma.getNodeByIdAsync(id);
            if (n && (n.type === 'FRAME' || n.type === 'GROUP')) {
              const c = figma.createComponentFromNode(n);
              out.push({ id: c.id, name: c.name });
            } else if (n) {
              out.push({ id: n.id, name: n.name });
            }
          }
          return out;
        })()`);
        if (Array.isArray(conv) && conv.length) finalNodes = conv;
      } catch (e) {
        spinner.warn('Rendered as frames, but component conversion failed: ' + e.message);
      }
    }

    if (failed === 0) {
      spinner.succeed(`Created ${created} shadcn/ui ${options.component !== false ? 'component' : 'frame'}(s)`);
    } else {
      spinner.warn(`Created ${created}, failed ${failed}`);
    }
    // Print the real ids so follow-up commands (scale, to-component, set …) can
    // target them instead of guessing.
    finalNodes.forEach(n => console.log(chalk.gray(`  ${n.id}  ${n.name}`)));
  });

