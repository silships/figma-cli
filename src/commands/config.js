// Commands: config (extracted from index.js)
import chalk from 'chalk';
import {
  program,
  checkConnection,
  daemonExec,
  figmaUse,
  generateFillCode,
  generateStrokeCode,
  isVarRef,
  loadConfig,
  saveConfig,
  smartPosCode,
  varLoadingCode
} from '../lib/cli-core.js';
import { create } from './create.js';

// ============ CONFIG ============

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g., leonardoApiKey)')
  .action((key, value) => {
    const config = loadConfig();
    config[key] = value;
    saveConfig(config);
    console.log(chalk.green('✓ Config saved: ') + chalk.gray(key + ' = ' + value.substring(0, 10) + '...'));
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    const config = loadConfig();
    if (config[key]) {
      console.log(config[key]);
    } else {
      console.log(chalk.gray('Not set'));
    }
  });

create
  .command('rect [name]')
  .alias('rectangle')
  .description('Create a rectangle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity 0-1')
  .action(async (name, options) => {
    checkConnection();
    const rectName = name || 'Rectangle';
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'rect');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'rect') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const rect = figma.createRectangle();
rect.name = ${JSON.stringify(rectName)};
rect.x = smartX;
rect.y = ${options.y};
rect.resize(${options.width}, ${options.height});
${fillCode.code}
${options.radius ? `rect.cornerRadius = ${options.radius};` : ''}
${options.opacity ? `rect.opacity = ${options.opacity};` : ''}
${strokeCode ? strokeCode.code : ''}
figma.currentPage.selection = [rect];
return '${rectName} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('ellipse [name]')
  .alias('circle')
  .description('Create an ellipse/circle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width (diameter)', '100')
  .option('-h, --height <n>', 'Height (same as width for circle)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .action(async (name, options) => {
    checkConnection();
    const ellipseName = name || 'Ellipse';
    const height = options.height || options.width;
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'ellipse');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'ellipse') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const ellipse = figma.createEllipse();
ellipse.name = ${JSON.stringify(ellipseName)};
ellipse.x = smartX;
ellipse.y = ${options.y};
ellipse.resize(${options.width}, ${height});
${fillCode.code}
${strokeCode ? strokeCode.code : ''}
figma.currentPage.selection = [ellipse];
return '${ellipseName} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('text <content>')
  .description('Create a text layer (smart positions by default)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .option('-c, --color <color>', 'Text color (hex or var:name)', '#000000')
  .option('-w, --weight <weight>', 'Font weight: regular, medium, semibold, bold', 'regular')
  .option('--font <family>', 'Font family', 'Inter')
  .option('--width <n>', 'Text box width (auto-width if not set)')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (content, options) => {
    checkConnection();
    const weightMap = { regular: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' };
    const fontStyle = weightMap[options.weight.toLowerCase()] || 'Regular';
    const useSmartPos = options.x === undefined;
    const usesVars = isVarRef(options.color);

    const fillCode = generateFillCode(options.color, 'text');

    let code = `
(async function() {
  ${usesVars ? varLoadingCode() : ''}
  ${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
  await figma.loadFontAsync({ family: ${JSON.stringify(options.font)}, style: ${JSON.stringify(fontStyle)} });
  const text = figma.createText();
  text.fontName = { family: ${JSON.stringify(options.font)}, style: ${JSON.stringify(fontStyle)} };
  text.characters = ${JSON.stringify(content)};
  text.fontSize = ${options.size};
  ${fillCode.code}
  text.x = smartX;
  text.y = ${options.y};
  ${options.width ? `text.resize(${options.width}, text.height); text.textAutoResize = 'HEIGHT';` : ''}
  figma.currentPage.selection = [text];
  return 'Text created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('line')
  .description('Create a line (smart positions by default)')
  .option('--x1 <n>', 'Start X (auto if not set)')
  .option('--y1 <n>', 'Start Y', '0')
  .option('--x2 <n>', 'End X (auto + length if x1 not set)')
  .option('--y2 <n>', 'End Y', '0')
  .option('-l, --length <n>', 'Line length', '100')
  .option('-c, --color <color>', 'Line color (hex or var:name)', '#000000')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (options) => {
    checkConnection();
    const useSmartPos = options.x1 === undefined;
    const lineLength = parseFloat(options.length);
    const usesVars = isVarRef(options.color);

    const strokeCode = generateStrokeCode(options.color, 'line', options.weight);

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x1};`}
const line = figma.createLine();
line.x = smartX;
line.y = ${options.y1};
line.resize(${useSmartPos ? lineLength : `Math.abs(${options.x2 || options.x1 + '+' + lineLength} - ${options.x1}) || ${lineLength}`}, 0);
${options.x2 && options.x1 ? `line.rotation = Math.atan2(${options.y2} - ${options.y1}, ${options.x2} - ${options.x1}) * 180 / Math.PI;` : ''}
${strokeCode.code}
figma.currentPage.selection = [line];
return 'Line created at (' + smartX + ', ${options.y1}) with length ${lineLength}';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('component [name]')
  .description('Convert selection to component')
  .action((name) => {
    checkConnection();
    const compName = name || 'Component';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else if (sel.length === 1) {
  const comp = figma.createComponentFromNode(sel[0]);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created: ' + comp.name;
} else {
  const group = figma.group(sel, figma.currentPage);
  const comp = figma.createComponentFromNode(group);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created from ' + sel.length + ' elements: ' + comp.name;
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('group [name]')
  .description('Group current selection')
  .action((name) => {
    checkConnection();
    const groupName = name || 'Group';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length < 2) 'Select 2+ elements to group';
else {
  const group = figma.group(sel, figma.currentPage);
  group.name = ${JSON.stringify(groupName)};
  figma.currentPage.selection = [group];
  'Grouped ' + sel.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('autolayout [name]')
  .alias('al')
  .description('Create an auto-layout frame (smart positions by default)')
  .option('-d, --direction <dir>', 'Direction: row, col', 'row')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Padding', '16')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (name, options) => {
    checkConnection();
    const frameName = name || 'Auto Layout';
    const layoutMode = options.direction === 'col' ? 'VERTICAL' : 'HORIZONTAL';
    const useSmartPos = options.x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
const frame = figma.createFrame();
frame.name = ${JSON.stringify(frameName)};
frame.x = smartX;
frame.y = ${options.y};
frame.layoutMode = '${layoutMode}';
frame.primaryAxisSizingMode = 'AUTO';
frame.counterAxisSizingMode = 'AUTO';
frame.itemSpacing = ${options.gap};
frame.paddingTop = ${options.padding};
frame.paddingRight = ${options.padding};
frame.paddingBottom = ${options.padding};
frame.paddingLeft = ${options.padding};
${fillCode ? fillCode.code : 'frame.fills = [];'}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
return 'Auto-layout frame created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

