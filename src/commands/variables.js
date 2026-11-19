// Commands: variables (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'path';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  figmaEvalSync,
  figmaUse,
  handleEvalError,
  hexToRgb
} from '../lib/cli-core.js';

// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

variables
  .command('list')
  .description('List all variables')
  .action(async () => {
    await checkConnection();
    figmaUse('variable list');
  });

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN')
  .option('-v, --value <value>', 'Initial value')
  .action(async (name, options) => {
    await checkConnection();
    const type = options.type.toUpperCase();
    const code = `(async () => {
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === ${JSON.stringify(options.collection)} || c.name === ${JSON.stringify(options.collection)});
if (!col) return 'Collection not found: ' + ${JSON.stringify(options.collection)};
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : null;
}

const v = figma.variables.createVariable(${JSON.stringify(name)}, col, ${JSON.stringify(type)});
${options.value ? `
let figmaValue = ${JSON.stringify(options.value)};
if (${JSON.stringify(type)} === 'COLOR') figmaValue = hexToRgb(${JSON.stringify(options.value)});
else if (${JSON.stringify(type)} === 'FLOAT') figmaValue = parseFloat(${JSON.stringify(options.value)});
else if (${JSON.stringify(type)} === 'BOOLEAN') figmaValue = ${JSON.stringify(options.value)} === 'true';
v.setValueForMode(modeId, figmaValue);
` : ''}
return 'Created ${type.toLowerCase()} variable: ${name}';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .action(async (pattern) => {
    await checkConnection();
    figmaUse(`variable find "${pattern}"`);
  });

variables
  .command('visualize [collection]')
  .description('Create color swatches on canvas (shadcn-style layout)')
  .action(async (collection, options) => {
    await checkConnection();
    const spinner = ora('Creating color palette...').start();

    const code = `(async () => {
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const colorVars = await figma.variables.getLocalVariablesAsync('COLOR');

const targetCols = ${collection ? `collections.filter(c => c.name.toLowerCase().includes(${JSON.stringify(collection)}.toLowerCase()))` : 'collections'};
if (targetCols.length === 0) return 'No collections found';

// Skip semantic collections (they're aliases, colors already shown in primitives)
const filteredCols = targetCols.filter(c => !c.name.toLowerCase().includes('semantic'));
if (filteredCols.length === 0) return 'No color collections found (only semantic)';

let startX = 0;
figma.currentPage.children.forEach(n => {
  startX = Math.max(startX, n.x + (n.width || 0));
});
startX += 100;

let totalSwatches = 0;

// shadcn color order
const colorOrder = ['slate','gray','zinc','neutral','stone','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose','white','black'];

for (const col of filteredCols) {
  const colVars = colorVars.filter(v => v.variableCollectionId === col.id);
  if (colVars.length === 0) continue;

  // Group by prefix (handles both "blue/500" and semantic names)
  const groups = {};
  const semanticGroups = {
    'background': 'base', 'foreground': 'base', 'border': 'base', 'input': 'base', 'ring': 'base',
    'primary': 'primary', 'primary-foreground': 'primary',
    'secondary': 'secondary', 'secondary-foreground': 'secondary',
    'muted': 'muted', 'muted-foreground': 'muted',
    'accent': 'accent', 'accent-foreground': 'accent',
    'card': 'card', 'card-foreground': 'card',
    'popover': 'popover', 'popover-foreground': 'popover',
    'destructive': 'destructive', 'destructive-foreground': 'destructive',
    'chart-1': 'chart', 'chart-2': 'chart', 'chart-3': 'chart', 'chart-4': 'chart', 'chart-5': 'chart',
  };
  colVars.forEach(v => {
    const parts = v.name.split('/');
    let prefix;
    if (parts.length > 1) {
      prefix = parts[0];
    } else if (v.name.startsWith('sidebar-')) {
      prefix = 'sidebar';
    } else {
      prefix = semanticGroups[v.name] || 'other';
    }
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(v);
  });

  // Sort groups
  const semanticOrder = ['base','primary','secondary','muted','accent','card','popover','destructive','chart','sidebar'];
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    const aColorIdx = colorOrder.indexOf(a[0]);
    const bColorIdx = colorOrder.indexOf(b[0]);
    const aSemanticIdx = semanticOrder.indexOf(a[0]);
    const bSemanticIdx = semanticOrder.indexOf(b[0]);
    if (aColorIdx !== -1 && bColorIdx !== -1) return aColorIdx - bColorIdx;
    if (aColorIdx !== -1) return -1;
    if (bColorIdx !== -1) return 1;
    if (aSemanticIdx !== -1 && bSemanticIdx !== -1) return aSemanticIdx - bSemanticIdx;
    return a[0].localeCompare(b[0]);
  });

  // Create container
  const container = figma.createFrame();
  container.name = col.name;
  container.x = startX;
  container.y = 0;
  container.layoutMode = 'VERTICAL';
  container.primaryAxisSizingMode = 'AUTO';
  container.counterAxisSizingMode = 'AUTO';
  container.itemSpacing = 8;
  container.paddingTop = 32;
  container.paddingBottom = 32;
  container.paddingLeft = 32;
  container.paddingRight = 32;
  container.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  container.cornerRadius = 16;

  // Title
  const title = figma.createText();
  title.characters = col.name;
  title.fontSize = 20;
  title.fontName = { family: 'Inter', style: 'Medium' };
  title.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
  container.appendChild(title);

  // Spacer
  const spacer = figma.createFrame();
  spacer.resize(1, 16);
  spacer.fills = [];
  container.appendChild(spacer);

  const modeId = col.modes[0].modeId;
  const swatchesToBind = [];

  for (const [groupName, vars] of sortedGroups) {
    // Row container with label
    const rowContainer = figma.createFrame();
    rowContainer.name = groupName;
    rowContainer.layoutMode = 'HORIZONTAL';
    rowContainer.primaryAxisSizingMode = 'AUTO';
    rowContainer.counterAxisSizingMode = 'AUTO';
    rowContainer.itemSpacing = 16;
    rowContainer.counterAxisAlignItems = 'CENTER';
    rowContainer.fills = [];
    container.appendChild(rowContainer);

    // Label
    const label = figma.createText();
    label.characters = groupName;
    label.fontSize = 13;
    label.fontName = { family: 'Inter', style: 'Medium' };
    label.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
    label.resize(80, label.height);
    label.textAlignHorizontal = 'RIGHT';
    rowContainer.appendChild(label);

    // Swatches row
    const swatchRow = figma.createFrame();
    swatchRow.layoutMode = 'HORIZONTAL';
    swatchRow.primaryAxisSizingMode = 'AUTO';
    swatchRow.counterAxisSizingMode = 'AUTO';
    swatchRow.itemSpacing = 0;
    swatchRow.fills = [];
    swatchRow.cornerRadius = 6;
    swatchRow.clipsContent = true;
    rowContainer.appendChild(swatchRow);

    // Sort shades
    vars.sort((a, b) => {
      const aNum = parseInt(a.name.split('/').pop()) || 0;
      const bNum = parseInt(b.name.split('/').pop()) || 0;
      return aNum - bNum;
    });

    for (const v of vars) {
      const swatch = figma.createFrame();
      swatch.name = v.name;
      swatch.resize(48, 32);
      swatch.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
      swatchRow.appendChild(swatch);
      swatchesToBind.push({ swatch, variable: v, modeId });
      totalSwatches++;
    }
  }

  // Bind after appending
  for (const { swatch, variable, modeId } of swatchesToBind) {
    try {
      let value = variable.valuesByMode[modeId];
      if (value && value.type === 'VARIABLE_ALIAS') {
        const resolved = figma.variables.getVariableById(value.id);
        if (resolved) value = resolved.valuesByMode[Object.keys(resolved.valuesByMode)[0]];
      }
      if (value && value.r !== undefined) {
        swatch.fills = [figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: value.r, g: value.g, b: value.b } }, 'color', variable
        )];
      }
    } catch (e) {}
  }

  startX += container.width + 60;
}

figma.viewport.scrollAndZoomIntoView(figma.currentPage.children.slice(-filteredCols.length));
return 'Created ' + totalSwatches + ' color swatches';
})()`;

    try {
      const result = await fastEval(code);
      spinner.succeed(result || 'Created color palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(chalk.red(error.message));
    }
  });

variables
  .command('create-batch <json>')
  .description('Create multiple variables at once (faster than individual calls)')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .action(async (json, options) => {
    await checkConnection();
    let vars;
    try {
      vars = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"name": "color/red", "type": "COLOR", "value": "#ff0000"}, ...]'));
      return;
    }
    if (!Array.isArray(vars)) {
      console.log(chalk.red('Expected JSON array'));
      return;
    }

    const code = `(async () => {
const vars = ${JSON.stringify(vars)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === ${JSON.stringify(options.collection)} || c.name === ${JSON.stringify(options.collection)});
if (!col) return 'Collection not found: ' + ${JSON.stringify(options.collection)};
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16) / 255, g: parseInt(result[2], 16) / 255, b: parseInt(result[3], 16) / 255 } : null;
}

let created = 0;
for (const v of vars) {
  const type = (v.type || 'COLOR').toUpperCase();
  const variable = figma.variables.createVariable(v.name, col, type);
  if (v.value !== undefined) {
    let figmaValue = v.value;
    if (type === 'COLOR') figmaValue = hexToRgb(v.value);
    else if (type === 'FLOAT') figmaValue = parseFloat(v.value);
    else if (type === 'BOOLEAN') figmaValue = v.value === true || v.value === 'true';
    variable.setValueForMode(modeId, figmaValue);
  }
  created++;
}
return 'Created ' + created + ' variables';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Created ${vars.length} variables`));
  });

variables
  .command('delete-all')
  .description('Delete all local variables and collections')
  .option('-c, --collection <name>', 'Only delete variables in this collection')
  .action(async (options) => {
    await checkConnection();
    const spinner = ora('Deleting variables...').start();

    const filterCode = options.collection
      ? `cols = cols.filter(c => c.name.includes(${JSON.stringify(options.collection)}));`
      : '';

    const code = `(async () => {
let cols = await figma.variables.getLocalVariableCollectionsAsync();
${filterCode}
let deleted = 0;
for (const col of cols) {
  const vars = await figma.variables.getLocalVariablesAsync();
  const colVars = vars.filter(v => v.variableCollectionId === col.id);
  for (const v of colVars) {
    v.remove();
    deleted++;
  }
  col.remove();
}
return 'Deleted ' + deleted + ' variables and ' + cols.length + ' collections';
})()`;

    try {
      const result = figmaEvalSync(code);
      spinner.succeed(result);
    } catch (error) {
      spinner.fail('Failed to delete variables');
      console.error(chalk.red(error.message));
    }
  });

// ============ BATCH OPERATIONS ============

program
  .command('delete-batch <nodeIds>')
  .description('Delete multiple nodes at once (comma-separated IDs or JSON array)')
  .action(async (nodeIds) => {
    await checkConnection();
    let ids;
    try {
      ids = JSON.parse(nodeIds);
    } catch {
      ids = nodeIds.split(',').map(s => s.trim());
    }

    const code = `(async () => {
const ids = ${JSON.stringify(ids)};
let deleted = 0;
for (const id of ids) {
  const node = await figma.getNodeByIdAsync(id);
  if (node) {
    node.remove();
    deleted++;
  }
}
return 'Deleted ' + deleted + ' nodes';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Deleted nodes`));
  });

program
  .command('bind-batch <json>')
  .description('Bind variables to multiple nodes at once')
  .action(async (json) => {
    await checkConnection();
    let bindings;
    try {
      bindings = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"nodeId": "1:234", "property": "fill", "variable": "primary/500"}, ...]'));
      return;
    }

    const code = `(async () => {
const bindings = ${JSON.stringify(bindings)};
const vars = await figma.variables.getLocalVariablesAsync();
let bound = 0;

for (const b of bindings) {
  const node = await figma.getNodeByIdAsync(b.nodeId);
  if (!node) continue;

  const variable = vars.find(v => v.name === b.variable || v.name.endsWith('/' + b.variable));
  if (!variable) continue;

  const prop = b.property.toLowerCase();

  if (prop === 'fill' && 'fills' in node && node.fills.length > 0) {
    const newFill = figma.variables.setBoundVariableForPaint(node.fills[0], 'color', variable);
    node.fills = [newFill];
    bound++;
  } else if (prop === 'stroke' && 'strokes' in node && node.strokes.length > 0) {
    const newStroke = figma.variables.setBoundVariableForPaint(node.strokes[0], 'color', variable);
    node.strokes = [newStroke];
    bound++;
  } else if (prop === 'radius' && 'cornerRadius' in node) {
    node.setBoundVariable('cornerRadius', variable);
    bound++;
  } else if (prop === 'gap' && 'itemSpacing' in node) {
    node.setBoundVariable('itemSpacing', variable);
    bound++;
  } else if (prop === 'padding' && 'paddingTop' in node) {
    node.setBoundVariable('paddingTop', variable);
    node.setBoundVariable('paddingBottom', variable);
    node.setBoundVariable('paddingLeft', variable);
    node.setBoundVariable('paddingRight', variable);
    bound++;
  }
}
return 'Bound ' + bound + ' properties';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Bound variables`));
  });

program
  .command('set-batch <json>')
  .description('Set properties on multiple nodes at once. Each entry: {id|nodeId, fill?, stroke?, strokeWidth?, radius?, opacity?, name?, visible?, x?, y?, width?, height?}. fill/stroke accept hex ("#ff0000") OR variable references ("var:primary", "var:colors/brand-blue", "var:miro:primary") — variable references stay BOUND so theme switches work later.')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this collection (same as render --collection).')
  .action(async (json, options) => {
    await checkConnection();
    let operations;
    try {
      operations = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"id": "1:234", "fill": "#ff0000" OR "var:primary", ...}, ...]'));
      return;
    }
    // Normalize id/nodeId (LLMs reach for `id`). Also tolerate `newName`/`label` for `name`.
    operations = operations.map(op => ({
      ...op,
      nodeId: op.nodeId ?? op.id,
      name: op.name ?? op.newName ?? op.label,
    }));
    const colFilter = options.collection || null;

    const code = `(async () => {
const operations = ${JSON.stringify(operations)};
const colFilter = ${JSON.stringify(colFilter)};

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16) / 255, g: parseInt(result[2], 16) / 255, b: parseInt(result[3], 16) / 255 } : null;
}

// Load the variable map once, with the same scoping rules as render.
const [allCols, allVars] = await Promise.all([
  figma.variables.getLocalVariableCollectionsAsync(),
  figma.variables.getLocalVariablesAsync(),
]);
let scoped = null;
if (colFilter) {
  const fl = colFilter.toLowerCase();
  const cols = allCols.filter(c => c.name.toLowerCase() === fl || c.name.toLowerCase().includes(fl));
  scoped = new Set(cols.map(c => c.id));
}
const shadcnIds = new Set(allCols.filter(c => c.name.startsWith('shadcn')).map(c => c.id));
const varCache = {};
const register = (v) => {
  if (!varCache[v.name]) varCache[v.name] = v;
  const slash = v.name.lastIndexOf('/');
  if (slash >= 0) {
    const tail = v.name.slice(slash + 1);
    if (tail && !varCache[tail]) varCache[tail] = v;
  }
};
const qualified = {};
for (const v of allVars) {
  const col = allCols.find(c => c.id === v.variableCollectionId);
  if (!col) continue;
  qualified[col.name.toLowerCase() + ':' + v.name] = v;
  const slash = v.name.lastIndexOf('/');
  if (slash >= 0) qualified[col.name.toLowerCase() + ':' + v.name.slice(slash + 1)] = v;
}
if (scoped) {
  for (const v of allVars) if (scoped.has(v.variableCollectionId)) register(v);
} else {
  for (const v of allVars) if (shadcnIds.has(v.variableCollectionId)) register(v);
  for (const v of allVars) if (!shadcnIds.has(v.variableCollectionId)) register(v);
}
const lookupVar = (ref) => {
  // Accept "primary", "colors/primary", "miro:primary" — return Variable or null
  if (ref.includes(':')) {
    const [cn, vn] = ref.split(':', 2);
    return qualified[cn.toLowerCase() + ':' + vn] || varCache[vn] || null;
  }
  return varCache[ref] || null;
};
const setPaintColor = (input) => {
  // Returns a Paint with a SOLID color, either hex (frozen) or variable-bound.
  if (typeof input === 'string' && input.startsWith('var:')) {
    const ref = input.slice(4);
    const v = lookupVar(ref);
    if (!v) return { _err: 'variable not found: ' + ref };
    return figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v
    );
  }
  const rgb = hexToRgb(input);
  return rgb ? { type: 'SOLID', color: rgb } : { _err: 'invalid color: ' + input };
};

let updated = 0;
const notFound = [];
const errors = [];

for (const op of operations) {
  const node = await figma.getNodeByIdAsync(op.nodeId);
  if (!node) { notFound.push(op.nodeId); continue; }
  let touched = false;

  if (op.fill !== undefined && 'fills' in node) {
    const paint = setPaintColor(op.fill);
    if (paint._err) errors.push(op.nodeId + ': ' + paint._err);
    else { node.fills = [paint]; touched = true; }
  }
  if (op.stroke !== undefined && 'strokes' in node) {
    const paint = setPaintColor(op.stroke);
    if (paint._err) errors.push(op.nodeId + ': ' + paint._err);
    else { node.strokes = [paint]; touched = true; }
  }
  if (op.strokeWidth !== undefined && 'strokeWeight' in node) { node.strokeWeight = op.strokeWidth; touched = true; }
  if (op.radius !== undefined && 'cornerRadius' in node) { node.cornerRadius = op.radius; touched = true; }
  if (op.opacity !== undefined && 'opacity' in node) { node.opacity = op.opacity; touched = true; }
  if (op.name && 'name' in node) { node.name = op.name; touched = true; }
  if (op.visible !== undefined && 'visible' in node) { node.visible = op.visible; touched = true; }
  if (op.x !== undefined) { node.x = op.x; touched = true; }
  if (op.y !== undefined) { node.y = op.y; touched = true; }
  if (op.width !== undefined && op.height !== undefined && 'resize' in node) {
    node.resize(op.width, op.height); touched = true;
  }
  if (touched) updated++;
}
return { updated, notFound, errors };
})()`;

    try {
      const r = await daemonExec('eval', { code });
      const data = typeof r === 'string' ? (() => { try { return JSON.parse(r); } catch { return null; } })() : r;
      if (data && typeof data === 'object' && 'updated' in data) {
        console.log(chalk.green(`✓ Updated ${data.updated} node(s)`));
        if (data.notFound && data.notFound.length) {
          console.log(chalk.yellow(`  ⚠ ${data.notFound.length} ID(s) not found: ${data.notFound.join(', ')}`));
        }
        if (data.errors && data.errors.length) {
          for (const e of data.errors) console.log(chalk.yellow('  ⚠ ' + e));
        }
      } else {
        console.log(chalk.green(r || `✓ Updated nodes`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

program
  .command('rename-batch <json>')
  .description('Rename multiple nodes at once. Accepts [{id|nodeId,name}, …] or {"<id>": "<name>", …}.')
  .action(async (json) => {
    await checkConnection();
    let renames;
    try {
      renames = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"id": "1:234", "name": "New Name"}, ...] or {"1:234": "New Name", ...}'));
      return;
    }

    // Support both array and object format. Array form: accept BOTH "id" and
    // "nodeId" as the ID key — LLMs reach for "id" more naturally and were
    // silently getting 0 renames before.
    let pairs;
    if (Array.isArray(renames)) {
      pairs = renames.map(r => ({ id: r.id ?? r.nodeId, name: r.name ?? r.newName }));
    } else {
      pairs = Object.entries(renames).map(([id, name]) => ({ id, name }));
    }
    const missing = pairs.filter(p => !p.id || !p.name);
    if (missing.length) {
      console.log(chalk.red(`✗ ${missing.length} entr${missing.length === 1 ? 'y is' : 'ies are'} missing id or name. Expected each entry to have both.`));
      return;
    }

    const code = `(async () => {
const pairs = ${JSON.stringify(pairs)};
let renamed = 0;
const notFound = [];
for (const p of pairs) {
  const node = await figma.getNodeByIdAsync(p.id);
  if (node) {
    node.name = p.name;
    renamed++;
  } else {
    notFound.push(p.id);
  }
}
return { renamed, notFound };
})()`;

    const result = figmaEvalSync(code);
    let parsed;
    try { parsed = typeof result === 'string' ? JSON.parse(result.trim()) : result; } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      console.log(chalk.green(`✓ Renamed ${parsed.renamed} node(s)`));
      if (parsed.notFound && parsed.notFound.length) {
        console.log(chalk.yellow(`  ⚠ ${parsed.notFound.length} ID(s) not found: ${parsed.notFound.join(', ')}`));
      }
    } else {
      console.log(chalk.green(result || `✓ Renamed nodes`));
    }
  });

