// Commands: canvas-ops (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import {
  program,
  buildNodeSelector,
  checkConnection,
  daemonExec,
  figmaUse,
  handleEvalError,
  hexToRgb
} from '../lib/cli-core.js';

// ============ CANVAS ============

const canvas = program
  .command('canvas')
  .description('Canvas awareness and smart positioning');

canvas
  .command('info')
  .description('Show canvas info (bounds, element count, free space)')
  .action(async () => {
    await checkConnection();
    let code = `(function() {
const children = figma.currentPage.children;
if (children.length === 0) {
  return JSON.stringify({ empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 });
} else {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  children.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  return JSON.stringify({
    elements: children.length,
    bounds: { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
    nextX: Math.round(maxX + 100),
    nextY: 0,
    frames: children.filter(n => n.type === 'FRAME').length,
    components: children.filter(n => n.type === 'COMPONENT').length
  }, null, 2);
}
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

canvas
  .command('next')
  .description('Get next free position on canvas (no overlap)')
  .option('-g, --gap <n>', 'Gap from existing elements', '100')
  .option('-d, --direction <dir>', 'Direction: right, below', 'right')
  .action(async (options) => {
    await checkConnection();
    let code = `
const children = figma.currentPage.children;
const gap = ${options.gap};
if (children.length === 0) {
  JSON.stringify({ x: 0, y: 0 });
} else {
  ${options.direction === 'below' ? `
  let maxY = -Infinity;
  children.forEach(n => { maxY = Math.max(maxY, n.y + n.height); });
  JSON.stringify({ x: 0, y: Math.round(maxY + gap) });
  ` : `
  let maxX = -Infinity;
  children.forEach(n => { maxX = Math.max(maxX, n.x + n.width); });
  JSON.stringify({ x: Math.round(maxX + gap), y: 0 });
  `}
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ BIND (Variables) ============

const bind = program
  .command('bind')
  .description('Bind variables to node properties');

bind
  .command('fill <varName>')
  .description('Bind color variable to fill')
  .option('-n, --node <id>', 'Node ID (uses selection if not set)')
  .action(async (varName, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === ${JSON.stringify(varName)} || v.name.endsWith(${JSON.stringify('/' + varName)}));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('fills' in n && n.fills.length > 0) {
    const newFill = figma.variables.setBoundVariableForPaint(n.fills[0], 'color', v);
    n.fills = [newFill];
  }
});
return 'Bound ' + v.name + ' to fill on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('stroke <varName>')
  .description('Bind color variable to stroke')
  .option('-n, --node <id>', 'Node ID')
  .action(async (varName, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === ${JSON.stringify(varName)} || v.name.endsWith(${JSON.stringify('/' + varName)}));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('strokes' in n) {
    const stroke = n.strokes[0] || { type: 'SOLID', color: {r:0,g:0,b:0} };
    const newStroke = figma.variables.setBoundVariableForPaint(stroke, 'color', v);
    n.strokes = [newStroke];
  }
});
return 'Bound ' + v.name + ' to stroke on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('radius <varName>')
  .description('Bind number variable to corner radius')
  .option('-n, --node <id>', 'Node ID')
  .action(async (varName, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === ${JSON.stringify(varName)} || v.name.endsWith(${JSON.stringify('/' + varName)}));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('cornerRadius' in n) n.setBoundVariable('cornerRadius', v);
});
return 'Bound ' + v.name + ' to radius on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('gap <varName>')
  .description('Bind number variable to auto-layout gap')
  .option('-n, --node <id>', 'Node ID')
  .action(async (varName, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === ${JSON.stringify(varName)} || v.name.endsWith(${JSON.stringify('/' + varName)}));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
nodes.forEach(n => {
  if ('itemSpacing' in n) n.setBoundVariable('itemSpacing', v);
});
return 'Bound ' + v.name + ' to gap on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('padding <varName>')
  .description('Bind number variable to padding')
  .option('-n, --node <id>', 'Node ID')
  .option('-s, --side <side>', 'Side: top, right, bottom, left, all', 'all')
  .action(async (varName, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    const sides = options.side === 'all'
      ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
      : [`padding${options.side.charAt(0).toUpperCase() + options.side.slice(1)}`];
    let code = `(async () => {
${nodeSelector}
const vars = await figma.variables.getLocalVariablesAsync();
const v = vars.find(v => v.name === ${JSON.stringify(varName)} || v.name.endsWith(${JSON.stringify('/' + varName)}));
if (!v) return 'Variable not found: ${varName}';
if (nodes.length === 0) return 'No node selected';
const sides = ${JSON.stringify(sides)};
nodes.forEach(n => {
  sides.forEach(side => { if (side in n) n.setBoundVariable(side, v); });
});
return 'Bound ' + v.name + ' to padding on ' + nodes.length + ' elements';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('list')
  .description('List available variables for binding')
  .option('-t, --type <type>', 'Filter: COLOR, FLOAT')
  .action(async (options) => {
    await checkConnection();
    let code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
const filtered = vars${options.type ? `.filter(v => v.resolvedType === ${JSON.stringify(options.type.toUpperCase())})` : ''};
return filtered.map(v => v.resolvedType.padEnd(8) + ' ' + v.name).join('\\n') || 'No variables';
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ SIZING ============

const sizing = program
  .command('sizing')
  .description('Control sizing in auto-layout');

sizing
  .command('hug')
  .description('Set to hug contents')
  .option('-a, --axis <axis>', 'Axis: both, h, v', 'both')
  .action(async (options) => {
    await checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    ${options.axis === 'h' || options.axis === 'both' ? `if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'HUG';` : ''}
    ${options.axis === 'v' || options.axis === 'both' ? `if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'HUG';` : ''}
    if (n.layoutMode) { n.primaryAxisSizingMode = 'AUTO'; n.counterAxisSizingMode = 'AUTO'; }
  });
  'Set hug on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

sizing
  .command('fill')
  .description('Set to fill container')
  .option('-a, --axis <axis>', 'Axis: both, h, v', 'both')
  .action(async (options) => {
    await checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    ${options.axis === 'h' || options.axis === 'both' ? `if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'FILL';` : ''}
    ${options.axis === 'v' || options.axis === 'both' ? `if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'FILL';` : ''}
  });
  'Set fill on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

sizing
  .command('fixed <width> [height]')
  .description('Set to fixed size')
  .action(async (width, height) => {
    await checkConnection();
    const h = height || width;
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('layoutSizingHorizontal' in n) n.layoutSizingHorizontal = 'FIXED';
    if ('layoutSizingVertical' in n) n.layoutSizingVertical = 'FIXED';
    if ('resize' in n) n.resize(${width}, ${h});
  });
  'Set fixed ${width}x${h} on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ LAYOUT SHORTCUTS ============

program
  .command('padding <value> [r] [b] [l]')
  .alias('pad')
  .description('Set padding (CSS-style: 1-4 values)')
  .action(async (value, r, b, l) => {
    await checkConnection();
    let top = value, right = r || value, bottom = b || value, left = l || r || value;
    if (!r) { right = value; bottom = value; left = value; }
    else if (!b) { bottom = value; left = r; }
    else if (!l) { left = r; }
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('paddingTop' in n) {
      n.paddingTop = ${top}; n.paddingRight = ${right};
      n.paddingBottom = ${bottom}; n.paddingLeft = ${left};
    }
  });
  'Set padding on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

program
  .command('gap <value>')
  .description('Set auto-layout gap')
  .action(async (value) => {
    await checkConnection();
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => { if ('itemSpacing' in n) n.itemSpacing = ${value}; });
  'Set gap ${value} on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

program
  .command('align <alignment>')
  .description('Align items: start, center, end, stretch')
  .action(async (alignment) => {
    await checkConnection();
    const map = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
    const val = map[alignment.toLowerCase()] || 'CENTER';
    let code = `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) 'No selection';
else {
  nodes.forEach(n => {
    if ('primaryAxisAlignItems' in n) n.primaryAxisAlignItems = '${val}';
    if ('counterAxisAlignItems' in n) n.counterAxisAlignItems = '${val}';
  });
  'Aligned ' + nodes.length + ' elements to ${alignment}';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ SELECT ============

program
  .command('select <nodeId>')
  .description('Select a node by ID')
  .action(async (nodeId) => {
    await checkConnection();
    figmaUse(`select "${nodeId}"`);
  });

// ============ DELETE ============

program
  .command('delete [nodeId]')
  .alias('remove')
  .description('Delete node by ID or current selection')
  .action(async (nodeId) => {
    await checkConnection();
    if (nodeId) {
      let code = `(async () => {
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (node) { node.remove(); return 'Deleted: ${nodeId}'; } else { return 'Node not found: ${nodeId}'; }
})()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    } else {
      let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else { const count = sel.length; sel.forEach(n => n.remove()); 'Deleted ' + count + ' elements'; }
`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

// ============ DUPLICATE ============

program
  .command('duplicate [nodeId]')
  .alias('dup')
  .description('Duplicate node by ID or current selection')
  .option('--offset <n>', 'Offset from original', '20')
  .action(async (nodeId, options) => {
    await checkConnection();
    if (nodeId) {
      let code = `(async () => {
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (node) { const clone = node.clone(); clone.x += ${options.offset}; clone.y += ${options.offset}; figma.currentPage.selection = [clone]; return 'Duplicated: ' + clone.id; } else { return 'Node not found'; }
})()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    } else {
      let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else { const clones = sel.map(n => { const c = n.clone(); c.x += ${options.offset}; c.y += ${options.offset}; return c; }); figma.currentPage.selection = clones; 'Duplicated ' + clones.length + ' elements'; }
`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

// ============ SET ============

const set = program
  .command('set')
  .description('Set properties on selection or node');

set
  .command('fill <color>')
  .description('Set fill color (hex or var:name) on selection, --node, or all nodes matching --query')
  .option('-n, --node <id>', 'Node ID (uses selection if not set)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern> (case-insensitive)')
  .action(async (color, options) => {
    await checkConnection();
    // For fill, after the standard selector runs we walk into matched
    // containers (Groups, Frames) and expand to their fillable descendants
    // when they don't have fills themselves.
    const nodeSelector = buildNodeSelector(options) + `
       const __expanded = [];
       for (const __m of nodes) {
         if ('fills' in __m) { __expanded.push(__m); continue; }
         if (typeof __m.findAll === 'function') {
           __expanded.push(...__m.findAll(c => 'fills' in c));
         }
       }
       const __fillNodes = __expanded;`;
    // Code below will reference __fillNodes instead of nodes for the actual mutation.

    let code;
    if (color.startsWith('var:')) {
      // Variable binding — search ALL local collections so user-imported
      // design systems (Carbon, Material, custom) resolve, not only shadcn.
      const varName = color.slice(4);
      code = `(async () => {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const allVars = await figma.variables.getLocalVariablesAsync();
        // Prefer an exact name match in a shadcn collection, then any other.
        let variable = null;
        for (const v of allVars) {
          if (v.name !== ${JSON.stringify(varName)}) continue;
          const col = collections.find(c => c.id === v.variableCollectionId);
          if (col && col.name.startsWith('shadcn')) { variable = v; break; }
        }
        if (!variable) variable = allVars.find(v => v.name === ${JSON.stringify(varName)});
        if (!variable) return 'Variable ${varName} not found in any local collection';
        ${nodeSelector}
        if (__fillNodes.length === 0) return 'No node found';
        const boundFill = (v) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v);
        __fillNodes.forEach(n => { if ('fills' in n) n.fills = [boundFill(variable)]; });
        return 'Bound ' + variable.name + ' to fill on ' + __fillNodes.length + ' elements';
      })()`;
      const result = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (result || 'Done')));
    } else {
      // Hex color
      const { r, g, b } = hexToRgb(color);
      code = `(async () => {
        ${nodeSelector}
        if (__fillNodes.length === 0) return 'No node found';
        __fillNodes.forEach(n => { if ('fills' in n) n.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; });
        return 'Fill set on ' + __fillNodes.length + ' elements';
      })()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

set
  .command('stroke <color>')
  .description('Set stroke color (hex or var:name)')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .action(async (color, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);

    let code;
    if (color.startsWith('var:')) {
      // Variable binding — search ALL local collections so user-imported
      // design systems (Carbon, Material, custom) resolve, not only shadcn.
      const varName = color.slice(4);
      code = `(async () => {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const allVars = await figma.variables.getLocalVariablesAsync();
        let variable = null;
        for (const v of allVars) {
          if (v.name !== ${JSON.stringify(varName)}) continue;
          const col = collections.find(c => c.id === v.variableCollectionId);
          if (col && col.name.startsWith('shadcn')) { variable = v; break; }
        }
        if (!variable) variable = allVars.find(v => v.name === ${JSON.stringify(varName)});
        if (!variable) return 'Variable ${varName} not found in any local collection';
        ${nodeSelector}
        if (nodes.length === 0) return 'No node found';
        const boundFill = (v) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', v);
        nodes.forEach(n => { if ('strokes' in n) { n.strokes = [boundFill(variable)]; n.strokeWeight = ${options.weight}; } });
        return 'Bound ' + variable.name + ' to stroke on ' + nodes.length + ' elements';
      })()`;
      const result = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (result || 'Done')));
    } else {
      // Hex color
      const { r, g, b } = hexToRgb(color);
      code = `(async () => {
        ${nodeSelector}
        if (nodes.length === 0) return 'No node found';
        nodes.forEach(n => { if ('strokes' in n) { n.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; n.strokeWeight = ${options.weight}; } });
        return 'Stroke set on ' + nodes.length + ' elements';
      })()`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    }
  });

set
  .command('radius <value>')
  .description('Set corner radius')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action(async (value, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('cornerRadius' in n) n.cornerRadius = ${value}; }); 'Radius set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('size <width> <height>')
  .description('Set size')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action(async (width, height, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('resize' in n) n.resize(${width}, ${height}); }); 'Size set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('scale <factor>')
  .description('Scale node(s) by a factor (e.g. 1.2 = 120%, 0.5 = half). Uses node.rescale() — also scales fontSize, stroke, radius. For multi-node selections, the SPACING between nodes is scaled too so they don\'t overlap (pass --keep-spacing to disable).')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('--keep-spacing', 'Only scale each node\'s size — do NOT reposition siblings to preserve relative spacing')
  .action(async (factor, options) => {
    await checkConnection();
    // Accept "1.2", "1.2x", "120%"
    let raw = String(factor).trim().toLowerCase();
    let f;
    if (raw.endsWith('%')) f = parseFloat(raw.slice(0, -1)) / 100;
    else if (raw.endsWith('x')) f = parseFloat(raw.slice(0, -1));
    else f = parseFloat(raw);
    if (!Number.isFinite(f) || f <= 0) {
      console.error(chalk.red('✗'), `Invalid scale factor: ${factor}. Use e.g. 1.2, 1.2x, or 120%.`);
      process.exit(1);
    }
    const scaleSpacing = !options.keepSpacing;
    const nodeSelector = buildNodeSelector(options);
    const code = `(async () => {
      ${nodeSelector}
      if (nodes.length === 0) return 'No node found';
      // Capture original positions BEFORE rescaling so we can scale the
      // sibling-spacing too. Without this, rescale() doubles the size but
      // leaves x/y untouched and the items overlap each other.
      const scaleSpacing = ${scaleSpacing};
      const origin = scaleSpacing && nodes.length > 1
        ? { x: Math.min(...nodes.map(n => n.x || 0)), y: Math.min(...nodes.map(n => n.y || 0)) }
        : null;
      const orig = nodes.map(n => ({ x: n.x || 0, y: n.y || 0 }));
      let count = 0;
      for (const n of nodes) {
        if (typeof n.rescale === 'function') { n.rescale(${f}); count++; }
        else if ('resize' in n && 'width' in n && 'height' in n) { n.resize(n.width * ${f}, n.height * ${f}); count++; }
      }
      if (origin) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (typeof n.x !== 'number') continue;
          n.x = origin.x + (orig[i].x - origin.x) * ${f};
          n.y = origin.y + (orig[i].y - origin.y) * ${f};
        }
      }
      return 'Scaled ' + count + ' element(s) by ${f}' + (origin ? ' (spacing scaled too)' : '');
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

set
  .command('pos <x> <y>')
  .alias('position')
  .description('Set position')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action(async (x, y, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { n.x = ${x}; n.y = ${y}; }); 'Position set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('opacity <value>')
  .description('Set opacity (0-1)')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action(async (value, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('opacity' in n) n.opacity = ${value}; }); 'Opacity set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('name <name>')
  .description('Rename node')
  .option('-n, --node <id>', 'Node ID')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .action(async (name, options) => {
    await checkConnection();
    const nodeSelector = buildNodeSelector(options);
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { n.name = ${JSON.stringify(name)}; }); 'Renamed ' + nodes.length + ' elements to ' + ${JSON.stringify(name)}; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('text <text>')
  .description('Change the text content of a text node (or all text children of a node)')
  .option('-n, --node <id>', 'Node ID (text node directly, or container whose text descendants to update)')
  .option('-q, --query <pattern>', 'Update text on all text nodes whose name OR text contains <pattern>')
  .action(async (text, options) => {
    await checkConnection();
    if (!options.node && !options.query) {
      console.error(chalk.red('✗'), 'Provide either --node <id> or --query <pattern>');
      process.exit(1);
    }
    const selectorCode = options.query
      ? `const pattern = ${JSON.stringify(options.query.toLowerCase())};
         const matchesByName = (n) => n && n.name && n.name.toLowerCase().includes(pattern);
         const matchesAncestor = (n) => {
           let p = n.parent;
           while (p && p.type !== 'PAGE') { if (matchesByName(p)) return true; p = p.parent; }
           return false;
         };
         const all = figma.currentPage.findAll(n => n.type === 'TEXT');
         let targets = all.filter(t =>
           matchesByName(t) ||
           (t.characters && t.characters.toLowerCase().includes(pattern)) ||
           matchesAncestor(t));`
      : `const root = await figma.getNodeByIdAsync(${JSON.stringify(options.node)});
         if (!root) throw new Error('Node not found: ${options.node}');
         const targets = root.type === 'TEXT' ? [root] :
           (typeof root.findAll === 'function' ? root.findAll(n => n.type === 'TEXT') : []);`;
    const code = `(async () => {
      ${selectorCode}
      if (targets.length === 0) throw new Error('No text nodes matched');
      const results = [];
      for (const t of targets) {
        await figma.loadFontAsync(t.fontName);
        t.characters = ${JSON.stringify(text)};
        results.push({ id: t.id, name: t.name });
      }
      return results;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Updated text on ${r.length} node(s):`);
      r.forEach(n => console.log(chalk.gray(`  ${n.name || '(unnamed)'} (${n.id})`)));
    } catch (e) {
      handleEvalError(e);
    }
  });

set
  .command('autolayout <direction>')
  .alias('al')
  .description('Apply auto-layout (row/col) with optional sizing, align, and wrap')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Uniform padding')
  .option('--px <n>', 'Horizontal padding (overrides --padding for left/right)')
  .option('--py <n>', 'Vertical padding (overrides --padding for top/bottom)')
  .option('-n, --node <id>', 'Apply to this node ID (or comma-separated list of IDs)')
  .option('-q, --query <pattern>', 'Apply to all FRAME/COMPONENT nodes whose name contains <pattern>')
  .option('--sizing <mode>', 'Container sizing: hug (default), fill, fixed', 'hug')
  .option('--align <a>', 'Children alignment: start | center | end | space-between', 'start')
  .option('--wrap', 'Enable layout wrap (for row direction)')
  .option('--fill-children', 'Set every child to FILL on the counter axis (good for cards with wrapping text)')
  .action(async (direction, options) => {
    await checkConnection();
    const isCol = direction === 'col' || direction === 'vertical' || direction === 'column';
    const layoutMode = isCol ? 'VERTICAL' : 'HORIZONTAL';
    const sizingMode = ({
      hug: 'AUTO', fill: 'FIXED', fixed: 'FIXED'
    })[options.sizing] || 'AUTO';
    const alignMap = {
      start: 'MIN', center: 'CENTER', end: 'MAX', 'space-between': 'SPACE_BETWEEN'
    };
    const primaryAxisAlign = alignMap[options.align] || 'MIN';
    const counterAxisAlign = options.align === 'center' ? 'CENTER' : 'MIN';
    const px = options.px ?? options.padding;
    const py = options.py ?? options.padding;
    // The standard helper produces `const nodes = [...]`; for autolayout we
    // also want to scope --query to FRAME/COMPONENT only (it's pointless
    // to apply auto-layout to text or vector nodes).
    const baseSelector = buildNodeSelector(options, { filterExpr: "(n.type === 'FRAME' || n.type === 'COMPONENT')" });
    const code = `
(async () => {
${baseSelector}
const sel = nodes.filter(n => n.type === 'FRAME' || n.type === 'COMPONENT');
if (sel.length === 0) { return 'No frame/component to apply autolayout to'; }
let count = 0;
for (const n of sel) {
  n.layoutMode = '${layoutMode}';
  n.primaryAxisSizingMode = ${JSON.stringify(sizingMode)};
  n.counterAxisSizingMode = ${JSON.stringify(sizingMode)};
  n.primaryAxisAlignItems = ${JSON.stringify(primaryAxisAlign)};
  n.counterAxisAlignItems = ${JSON.stringify(counterAxisAlign)};
  n.itemSpacing = ${parseInt(options.gap) || 0};
  ${px !== undefined ? `n.paddingLeft = n.paddingRight = ${parseInt(px) || 0};` : ''}
  ${py !== undefined ? `n.paddingTop = n.paddingBottom = ${parseInt(py) || 0};` : ''}
  ${options.wrap && !isCol ? `if ('layoutWrap' in n) n.layoutWrap = 'WRAP';` : ''}
  ${options.fillChildren ? `
  for (const c of n.children) {
    if ('layoutSizingHorizontal' in c) c.layoutSizingHorizontal = ${isCol ? "'FILL'" : "'HUG'"};
    if ('layoutSizingVertical' in c) c.layoutSizingVertical = ${isCol ? "'HUG'" : "'FILL'"};
  }` : ''}
  count++;
}
return 'Auto-layout applied to ' + count + ' frame(s)';
})()
`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ PIN (edge-anchored absolute positioning) ============
//
// Implements the directededges "Absolute Positioning" spec:
// https://directededges.github.io/specs/guides/absolute-positioning/
//
// Figma stores absolutely-positioned elements as raw x/y from the parent's
// top-left, plus a `constraints` object that records the anchor edge.
// Designers think in terms of edges ("16 from right"), but figma's API
// forces you to compute raw x = parent.width - node.width - 16 yourself.
// `pin` does the math AND sets the matching constraint so the element
// stays anchored when the parent resizes.

program
  .command('pin <edge>')
  .description('Pin node(s) to a parent edge with an edge-relative offset. Edges: left | right | top | bottom | top-left | top-right | bottom-left | bottom-right | center-x | center-y | stretch-x | stretch-y | scale-x | scale-y')
  .option('-n, --node <id>', 'Node ID (or comma-separated list)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-o, --offset <n>', 'Offset from the edge in px (default: 0). For top-right etc. it applies to the FIRST edge; use --offset-x / --offset-y to split.')
  .option('--offset-x <n>', 'Horizontal offset (overrides --offset on the horizontal axis)')
  .option('--offset-y <n>', 'Vertical offset (overrides --offset on the vertical axis)')
  .option('--start <v>', 'For stretch-x/stretch-y/scale-x/scale-y: start offset (px) or percentage string for scale')
  .option('--end <v>', 'For stretch-x/stretch-y/scale-x/scale-y: end offset (px) or percentage string for scale')
  .action(async (edge, options) => {
    await checkConnection();
    const validEdges = new Set([
      'left', 'right', 'top', 'bottom',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
      'center-x', 'center-y',
      'stretch-x', 'stretch-y',
      'scale-x', 'scale-y',
    ]);
    if (!validEdges.has(edge)) {
      console.error(chalk.red('✗'), `Unknown edge "${edge}". Valid: ${[...validEdges].join(', ')}`);
      process.exit(1);
    }
    const off = parseFloat(options.offset ?? 0);
    const offX = options.offsetX !== undefined ? parseFloat(options.offsetX) : off;
    const offY = options.offsetY !== undefined ? parseFloat(options.offsetY) : off;
    const start = options.start;
    const end = options.end;

    // Build the per-node mutation. Runs inside the eval, so it can read each
    // node's parent dimensions and compute the raw x/y per the Spec formulas.
    // Constraints are set so Figma keeps the anchor when the parent resizes.
    const pinExpr = `
      function pinOne(n) {
        if (!n || typeof n.x !== 'number' || !('constraints' in n)) return false;
        const p = n.parent;
        if (!p || typeof p.width !== 'number') return false;
        const pw = p.width, ph = p.height;
        const c = { ...n.constraints };
        const edge = ${JSON.stringify(edge)};
        const offX = ${offX}, offY = ${offY};
        if (edge === 'left')        { n.x = offX;                          c.horizontal = 'MIN'; }
        else if (edge === 'right')  { n.x = pw - n.width - offX;            c.horizontal = 'MAX'; }
        else if (edge === 'top')    { n.y = offY;                          c.vertical = 'MIN'; }
        else if (edge === 'bottom') { n.y = ph - n.height - offY;           c.vertical = 'MAX'; }
        else if (edge === 'top-left')     { n.x = offX; n.y = offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MIN'; }
        else if (edge === 'top-right')    { n.x = pw - n.width - offX; n.y = offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MIN'; }
        else if (edge === 'bottom-left')  { n.x = offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MAX'; }
        else if (edge === 'bottom-right') { n.x = pw - n.width - offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MAX'; }
        else if (edge === 'center-x') { n.x = (pw - n.width) / 2 + offX; c.horizontal = 'CENTER'; }
        else if (edge === 'center-y') { n.y = (ph - n.height) / 2 + offY; c.vertical = 'CENTER'; }
        else if (edge === 'stretch-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.x = sNum;
          n.resize(Math.max(1, pw - sNum - eNum), n.height);
          c.horizontal = 'STRETCH';
        }
        else if (edge === 'stretch-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.y = sNum;
          n.resize(n.width, Math.max(1, ph - sNum - eNum));
          c.vertical = 'STRETCH';
        }
        else if (edge === 'scale-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / pw;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / pw;
          n.x = pw * sPct;
          n.resize(Math.max(1, pw - n.x - pw * ePct), n.height);
          c.horizontal = 'SCALE';
        }
        else if (edge === 'scale-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / ph;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / ph;
          n.y = ph * sPct;
          n.resize(n.width, Math.max(1, ph - n.y - ph * ePct));
          c.vertical = 'SCALE';
        }
        n.constraints = c;
        return true;
      }
    `;

    const selector = buildNodeSelector(options);
    const code = `(async () => {
      ${selector}
      if (nodes.length === 0) return 'No node found';
      ${pinExpr}
      let count = 0;
      for (const n of nodes) if (pinOne(n)) count++;
      return 'Pinned ' + count + ' element(s) to ' + ${JSON.stringify(edge)};
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ UNWRAP (rescue a falsely-wrapped group of items) ============
//
// LLM callers sometimes create N similar items inside a single wrapper
// component when the user actually wanted N independent top-level items.
// `unwrap` rescues that: it takes a node, lifts every direct child up to
// the wrapper's parent (preserving canvas position), and deletes the
// wrapper. Works for FRAME, COMPONENT, GROUP, SECTION.

program
  .command('unwrap <nodeId>')
  .description('Lift the children of a wrapper node up to its parent, then delete the wrapper. Use when an LLM accidentally bundled N items into one component.')
  .option('--keep-wrapper', 'Move children out but keep the (now-empty) wrapper around')
  .action(async (nodeId, options) => {
    await checkConnection();
    const keepWrapper = !!options.keepWrapper;
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('children' in n) || !Array.isArray(n.children)) {
        return 'Node ' + n.id + ' has no children to unwrap';
      }
      const parent = n.parent;
      if (!parent) throw new Error('Wrapper has no parent (is it the page root?)');
      const isOnPage = parent.type === 'PAGE';
      const offsetX = isOnPage ? n.x : 0;
      const offsetY = isOnPage ? n.y : 0;
      const moved = [];
      // Snapshot children first — appendChild mutates the live array.
      const kids = n.children.slice();
      for (const c of kids) {
        const cx = c.x, cy = c.y;
        parent.appendChild(c);
        if (isOnPage && 'x' in c) {
          c.x = offsetX + cx;
          c.y = offsetY + cy;
        }
        moved.push(c.id);
      }
      const wrapperId = n.id;
      const wrapperName = n.name;
      if (!${keepWrapper}) n.remove();
      return { unwrapped: wrapperId, name: wrapperName, children: moved, deletedWrapper: !${keepWrapper} };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (typeof r === 'string') {
        console.log(chalk.yellow(r));
        return;
      }
      console.log(chalk.green(`✓ Unwrapped "${r.name}" (${r.unwrapped}) — ${r.children.length} child(ren) lifted to parent`));
      console.log(chalk.gray('  children: ' + r.children.join(', ')));
      if (r.deletedWrapper) console.log(chalk.gray('  wrapper deleted'));
      else console.log(chalk.gray('  wrapper kept (--keep-wrapper)'));
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ USE (switch theme / rebind variables to a target collection) ============
//
// Solves the parallel-design-systems case: when the user has multiple
// collections with overlapping token names (e.g. airbnb and cursor both
// define primary / body / ink), `use <collection>` walks all variable
// bindings on the selection (or a node, or the whole page) and rebinds them
// to the target collection's variables — name-matched.
//
// Example: design a card bound to var:primary from the airbnb collection,
// run `figma-cli use cursor` while the card is selected → the same card
// now renders with Cursor's primary color. No re-design needed.

program
  .command('use <collection>')
  .alias('theme')
  .description('Switch variable bindings to a target collection. Re-binds every bound variable on the selection (or --node, or --all) to the same-named variable in <collection>.')
  .option('-n, --node <id>', 'Node ID (or comma-separated list of IDs)')
  .option('-a, --all', 'Apply to every node on the current page (not just selection)')
  .option('--dry-run', 'Print what would be rebound, don\'t modify anything')
  .action(async (collectionName, options) => {
    await checkConnection();
    const dryRun = !!options.dryRun;
    const target = collectionName;
    const baseSelector = options.all
      ? `const roots = figma.currentPage.children.slice();`
      : options.node
        ? (() => {
            const ids = String(options.node).split(/[\s,]+/).filter(Boolean);
            if (ids.length === 1) return `const __n = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const roots = __n ? [__n] : [];`;
            return `const __ids = ${JSON.stringify(ids)};
                    const __res = await Promise.all(__ids.map(id => figma.getNodeByIdAsync(id)));
                    const roots = __res.filter(Boolean);`;
          })()
        : `const roots = figma.currentPage.selection.slice();`;

    const code = `(async () => {
      ${baseSelector}
      if (roots.length === 0) return 'No node found (selection / --node / --all all empty)';

      // Resolve target collection (case-insensitive substring match)
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const targetQ = ${JSON.stringify(target.toLowerCase())};
      const targetCol = collections.find(c => c.name.toLowerCase() === targetQ)
                     || collections.find(c => c.name.toLowerCase().includes(targetQ));
      if (!targetCol) {
        return 'Collection not found: ${target}. Available: ' + collections.map(c => c.name).join(', ');
      }

      // Build name → variable map for the target collection
      const allVars = await figma.variables.getLocalVariablesAsync();
      const targetMap = {};
      for (const v of allVars) {
        if (v.variableCollectionId === targetCol.id) targetMap[v.name] = v;
      }
      if (Object.keys(targetMap).length === 0) {
        return 'Target collection "' + targetCol.name + '" has no variables';
      }

      // Walk every node recursively and find bindings to rebind
      const walked = [];
      const seen = new Set();
      function walk(n) {
        if (!n || seen.has(n.id)) return;
        seen.add(n.id);
        walked.push(n);
        if ('children' in n && n.children) for (const c of n.children) walk(c);
      }
      for (const r of roots) walk(r);

      let reboundCount = 0;
      const reboundNames = new Set();
      const missing = new Set();
      const dryRun = ${dryRun};

      // For each paint-bearing node, swap variable bindings on fills/strokes
      for (const n of walked) {
        for (const prop of ['fills', 'strokes']) {
          if (!(prop in n)) continue;
          const paints = n[prop];
          if (!Array.isArray(paints) || paints.length === 0) continue;
          let changed = false;
          const newPaints = paints.map(paint => {
            if (!paint.boundVariables || !paint.boundVariables.color) return paint;
            const oldRef = paint.boundVariables.color;
            const oldVar = oldRef && oldRef.id ? allVars.find(v => v.id === oldRef.id) : null;
            if (!oldVar) return paint;
            // Already in target collection → leave alone
            if (oldVar.variableCollectionId === targetCol.id) return paint;
            const newVar = targetMap[oldVar.name];
            if (!newVar) { missing.add(oldVar.name); return paint; }
            reboundCount++;
            reboundNames.add(oldVar.name);
            changed = true;
            if (dryRun) return paint;
            return figma.variables.setBoundVariableForPaint(paint, 'color', newVar);
          });
          if (changed && !dryRun) n[prop] = newPaints;
        }
        // Also handle scalar bindings (cornerRadius, opacity, strokeWeight, …)
        // via the generic boundVariables map.
        if ('boundVariables' in n && n.boundVariables) {
          for (const [field, ref] of Object.entries(n.boundVariables)) {
            if (!ref || !ref.id) continue;
            // Some fields are arrays (fills/strokes already handled above)
            if (Array.isArray(ref)) continue;
            const oldVar = allVars.find(v => v.id === ref.id);
            if (!oldVar) continue;
            if (oldVar.variableCollectionId === targetCol.id) continue;
            const newVar = targetMap[oldVar.name];
            if (!newVar) { missing.add(oldVar.name); continue; }
            reboundCount++;
            reboundNames.add(oldVar.name);
            if (!dryRun) {
              try { n.setBoundVariable(field, newVar); } catch (e) { /* unsupported field */ }
            }
          }
        }
      }

      return {
        targetCollection: targetCol.name,
        nodesWalked: walked.length,
        rebindings: reboundCount,
        uniqueTokens: [...reboundNames].sort(),
        missingInTarget: [...missing].sort(),
        dryRun,
      };
    })()`;

    try {
      const r = await daemonExec('eval', { code });
      if (typeof r === 'string') {
        console.error(chalk.yellow(r));
        return;
      }
      const verb = r.dryRun ? 'Would rebind' : 'Rebound';
      console.log(chalk.green(`✓ ${verb} ${r.rebindings} binding(s) on ${r.nodesWalked} node(s) → ${r.targetCollection}`));
      if (r.uniqueTokens.length > 0) {
        console.log(chalk.gray(`  tokens: ${r.uniqueTokens.join(', ')}`));
      }
      if (r.missingInTarget.length > 0) {
        console.log(chalk.yellow(`  ⚠ not found in ${r.targetCollection}: ${r.missingInTarget.join(', ')}`));
        console.log(chalk.gray(`    (those bindings were left pointing at the original collection)`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ INSPECT (reverse: Figma → Spec) ============

program
  .command('inspect <nodeId>')
  .description('Inspect a node and emit its position as Spec-canonical properties (start/end/centerOffset/etc.). JSON output via --json.')
  .option('--json', 'Output as JSON (machine-readable)')
  .option('--spec', 'Output only the absolute-positioning spec block (compact)')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      const p = n.parent;
      const out = {
        id: n.id,
        name: n.name,
        type: n.type,
        width: 'width' in n ? n.width : null,
        height: 'height' in n ? n.height : null,
      };
      // Absolute-positioning spec output. Mirrors the directededges spec:
      // active keys carry computed values, inactive ones are null (so a
      // consumer can diff variants reliably).
      if (n.layoutPositioning === 'ABSOLUTE' && p && 'width' in p) {
        const c = n.constraints || { horizontal: 'MIN', vertical: 'MIN' };
        const pw = p.width, ph = p.height;
        const pos = {
          position: 'ABSOLUTE',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: n.width, height: n.height,
          layoutSizingHorizontal: null, layoutSizingVertical: null,
        };
        const pct = (v) => {
          const p2 = Math.round(v * 10000) / 100;
          return (p2 % 1 === 0 ? p2.toFixed(0) : (p2 % 0.1 === 0 ? p2.toFixed(1) : p2.toFixed(2))) + '%';
        };
        switch (c.horizontal) {
          case 'MIN':     pos.start = n.x; break;
          case 'MAX':     pos.end = pw - n.x - n.width; break;
          case 'CENTER':  pos.centerHorizontalOffset = n.x + n.width / 2 - pw / 2; break;
          case 'STRETCH': pos.start = n.x; pos.end = pw - n.x - n.width; pos.width = null; break;
          case 'SCALE':   pos.start = pct(n.x / pw); pos.end = pct((pw - n.x - n.width) / pw); pos.width = null; break;
        }
        switch (c.vertical) {
          case 'MIN':     pos.top = n.y; break;
          case 'MAX':     pos.bottom = ph - n.y - n.height; break;
          case 'CENTER':  pos.centerVerticalOffset = n.y + n.height / 2 - ph / 2; break;
          case 'STRETCH': pos.top = n.y; pos.bottom = ph - n.y - n.height; pos.height = null; break;
          case 'SCALE':   pos.top = pct(n.y / ph); pos.bottom = pct((ph - n.y - n.height) / ph); pos.height = null; break;
        }
        out.absolutePositioning = pos;
      } else if (n.layoutPositioning === 'AUTO' || p?.layoutMode !== 'NONE') {
        out.absolutePositioning = {
          position: 'AUTO',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: null, height: null,
          layoutSizingHorizontal: n.layoutSizingHorizontal ?? null,
          layoutSizingVertical: n.layoutSizingVertical ?? null,
        };
      }
      // Raw geometry alongside, useful for debugging the spec output
      if ('x' in n) {
        out.raw = { x: n.x, y: n.y, constraints: n.constraints };
      }
      return out;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (options.spec) {
        console.log(JSON.stringify(r.absolutePositioning, null, 2));
      } else {
        console.log(chalk.cyan(`${r.name || '(unnamed)'} (${r.id}) — ${r.type}`));
        console.log(chalk.gray(`  size: ${r.width}×${r.height}`));
        if (r.absolutePositioning) {
          console.log(chalk.cyan('  Absolute Positioning spec:'));
          for (const [k, v] of Object.entries(r.absolutePositioning)) {
            if (v !== null) console.log(`    ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
          }
        }
        if (r.raw) {
          console.log(chalk.gray(`  raw: x=${r.raw.x}, y=${r.raw.y}, constraints=${JSON.stringify(r.raw.constraints)}`));
        }
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ ARRANGE ============

program
  .command('unstack')
  .description('Find top-level nodes overlapping at the same position and spread them out. Keeps the first one in place, moves the rest. Non-destructive: leaves laid-out designs alone.')
  .option('-g, --gap <n>', 'Gap between unstacked items', '100')
  .option('--dry-run', 'Report what would move, do not modify anything')
  .action(async (options) => {
    await checkConnection();
    const gap = parseInt(options.gap) || 100;
    const dryRun = !!options.dryRun;
    const code = `(async () => {
      // Bucket every top-level node by its current (x,y) rounded to the nearest
      // integer. Anything with >1 entry in a bucket is overlapping at that origin.
      const top = figma.currentPage.children.filter(n =>
        typeof n.x === 'number' && typeof n.y === 'number');
      const buckets = new Map();
      for (const n of top) {
        const key = Math.round(n.x) + ',' + Math.round(n.y);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(n);
      }
      const moves = [];
      let xCursor = -Infinity;
      // Find the rightmost edge to start unstacking past existing layout
      for (const n of top) {
        xCursor = Math.max(xCursor, n.x + (n.width || 0));
      }
      if (!isFinite(xCursor)) xCursor = 0;
      xCursor += ${gap};
      for (const [key, group] of buckets) {
        if (group.length < 2) continue;
        // Keep the first one; move the rest to the right of everything else
        for (let i = 1; i < group.length; i++) {
          const n = group[i];
          moves.push({ id: n.id, name: n.name, from: { x: n.x, y: n.y }, to: { x: xCursor, y: 0 } });
          if (!${dryRun}) { n.x = xCursor; n.y = 0; }
          xCursor += (n.width || 100) + ${gap};
        }
      }
      return { moved: moves.length, moves: moves.slice(0, 12), totalOverlaps: moves.length, dryRun: ${dryRun} };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (!r || r.moved === 0) {
        console.log(chalk.green('✓ No overlapping top-level nodes found'));
        return;
      }
      const verb = r.dryRun ? 'Would move' : 'Moved';
      console.log(chalk.green(`✓ ${verb} ${r.moved} overlapping node(s)`));
      for (const m of r.moves) {
        console.log(chalk.gray(`  ${m.name} (${m.id}): (${m.from.x},${m.from.y}) → (${m.to.x},${m.to.y})`));
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

program
  .command('arrange')
  .description('Arrange ALL top-level frames on canvas — destructive, sorts alphabetically. For just-fix-overlaps use `unstack` instead.')
  .option('-g, --gap <n>', 'Gap between frames', '100')
  .option('-c, --cols <n>', 'Number of columns (0 = single row)', '0')
  .action(async (options) => {
    await checkConnection();
    let code = `
const frames = figma.currentPage.children.filter(n => n.type === 'FRAME' || n.type === 'COMPONENT');
if (frames.length === 0) 'No frames to arrange';
else {
  frames.sort((a, b) => a.name.localeCompare(b.name));
  let x = 0, y = 0, rowHeight = 0, col = 0;
  const gap = ${options.gap};
  const cols = ${options.cols};
  frames.forEach((f, i) => {
    f.x = x;
    f.y = y;
    rowHeight = Math.max(rowHeight, f.height);
    if (cols > 0 && ++col >= cols) {
      col = 0;
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    } else {
      x += f.width + gap;
    }
  });
  'Arranged ' + frames.length + ' frames';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ GET ============

program
  .command('get [nodeId]')
  .description('Get properties of node or selection')
  .action(async (nodeId) => {
    await checkConnection();
    const nodeSelector = nodeId
      ? `const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});`
      : `const node = figma.currentPage.selection[0];`;
    let code = `(async () => {
${nodeSelector}
if (!node) return 'No node found';
return JSON.stringify({
  id: node.id,
  name: node.name,
  type: node.type,
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  visible: node.visible,
  locked: node.locked,
  opacity: node.opacity,
  rotation: node.rotation,
  cornerRadius: node.cornerRadius,
  layoutMode: node.layoutMode,
  fills: node.fills?.length,
  strokes: node.strokes?.length,
  children: node.children?.length
}, null, 2);
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ FIND ============

program
  .command('find <name>')
  .description('Find nodes by name (partial match)')
  .option('-t, --type <type>', 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)')
  .option('-l, --limit <n>', 'Limit results', '20')
  .action(async (name, options) => {
    await checkConnection();
    let code = `(function() {
const results = [];
function search(node) {
  if (node.name && node.name.toLowerCase().includes(${JSON.stringify(name.toLowerCase())})) {
    ${options.type ? `if (node.type === ${JSON.stringify(options.type.toUpperCase())})` : ''}
    results.push({ id: node.id, name: node.name, type: node.type });
  }
  if (node.children && results.length < ${options.limit}) {
    node.children.forEach(search);
  }
}
search(figma.currentPage);
return results.length === 0 ? 'No nodes found matching "${name}"' : results.slice(0, ${options.limit}).map(r => r.id + ' [' + r.type + '] ' + r.name).join('\\n');
})()`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

