// Commands: create (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import {
  program,
  checkConnection,
  daemonExec,
  figmaUse,
  generateFillCode,
  getVarName,
  isVarRef,
  smartPosCode,
  varLoadingCode
} from '../lib/cli-core.js';

// ============ CREATE ============

const create = program
  .command('create')
  .description('Create Figma elements');

create
  .command('frame <name>')
  .description('Create a frame')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--smart', 'Auto-position to avoid overlaps (default if no -x)')
  .option('-g, --gap <n>', 'Gap for smart positioning', '100')
  .action(async (name, options) => {
    await checkConnection();
    const useSmartPos = options.smart || options.x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${useSmartPos ? smartPosCode(options.gap) : `const smartX = ${options.x};`}
const frame = figma.createFrame();
frame.name = ${JSON.stringify(name)};
frame.x = smartX;
frame.y = ${options.y};
frame.resize(${options.width}, ${options.height});
${fillCode ? fillCode.code : ''}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
return '${name} created at (' + smartX + ', ${options.y})';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('icon <name>')
  .description('Create an icon from Iconify (e.g., lucide:star, mdi:home) - auto-positions')
  .option('-s, --size <n>', 'Size', '24')
  .option('-c, --color <color>', 'Color (hex or var:name)', '#000000')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (name, options) => {
    await checkConnection();
    const spinner = ora(`Fetching icon ${name}...`).start();

    try {
      // Parse icon name (prefix:name format)
      const [prefix, iconName] = name.includes(':') ? name.split(':') : ['lucide', name];

      // Fetch SVG from Iconify API (use black for var: refs, actual color otherwise)
      const size = parseInt(options.size) || 24;
      const usesVar = isVarRef(options.color);
      const fetchColor = usesVar ? '#000000' : (options.color || '#000000');
      const url = `https://api.iconify.design/${prefix}/${iconName}.svg?width=${size}&height=${size}&color=${encodeURIComponent(fetchColor)}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Icon not found: ${name}`);
      }
      const svgContent = await response.text();

      if (!svgContent.includes('<svg')) {
        throw new Error(`Invalid icon: ${name}`);
      }

      spinner.text = 'Creating in Figma...';

      // Create SVG in Figma via daemon
      const posX = options.x !== undefined ? parseInt(options.x) : null;
      const posY = parseInt(options.y) || 0;
      const spacing = parseInt(options.spacing) || 100;

      // If using var: syntax, we need to bind after creation
      const varName = usesVar ? getVarName(options.color) : null;

      const code = `
(async () => {
  ${usesVar ? varLoadingCode() : ''}

  // Smart positioning
  let x = ${posX};
  if (x === null) {
    x = 0;
    figma.currentPage.children.forEach(n => {
      x = Math.max(x, n.x + (n.width || 0));
    });
    x += ${spacing};
  }

  // Create SVG node
  const node = figma.createNodeFromSvg(${JSON.stringify(svgContent)});
  node.name = "${name}";
  node.x = x;
  node.y = ${posY};

  // Flatten to vector for cleaner result
  let finalNode = node;
  if (node.type === 'FRAME' && node.children.length > 0) {
    finalNode = figma.flatten([node]);
    finalNode.name = "${name}";
  }

  ${usesVar ? `
  // Bind variable to fills
  if ('fills' in finalNode && vars[${JSON.stringify(varName)}]) {
    finalNode.fills = [boundFill(vars[${JSON.stringify(varName)}])];
  }
  ` : ''}

  return { id: finalNode.id, x: finalNode.x, y: finalNode.y, width: finalNode.width, height: finalNode.height };
})()`;

      const result = await daemonExec('eval', { code });
      spinner.succeed(`Created icon: ${name}`);
      console.log(chalk.gray(`  Position: (${result.x}, ${result.y}), Size: ${result.width}x${result.height}px`));
    } catch (error) {
      spinner.fail('Error creating icon');
      console.error(chalk.red(error.message));
    }
  });

create
  .command('image <url>')
  .description('Create an image from URL (PNG, JPG, GIF, WebP)')
  .option('-w, --width <n>', 'Width (auto if not set)')
  .option('-h, --height <n>', 'Height (auto if not set)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-n, --name <name>', 'Node name', 'Image')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (url, options) => {
    await checkConnection();
    const spinner = ora('Loading image...').start();

    const code = `
(async () => {
  try {
    // Smart positioning
    let smartX = 0;
    if (${options.x === undefined}) {
      figma.currentPage.children.forEach(n => {
        smartX = Math.max(smartX, n.x + (n.width || 0));
      });
      smartX += ${options.spacing || 100};
    } else {
      smartX = ${options.x || 0};
    }

    // Create image from URL
    const image = await figma.createImageAsync("${url}");
    const { width, height } = await image.getSizeAsync();

    // Calculate dimensions
    let w = ${options.width || 'null'};
    let h = ${options.height || 'null'};
    if (w && !h) h = Math.round(height * (w / width));
    if (h && !w) w = Math.round(width * (h / height));
    if (!w && !h) { w = width; h = height; }

    // Create rectangle with image fill
    const rect = figma.createRectangle();
    rect.name = "${options.name}";
    rect.resize(w, h);
    rect.x = smartX;
    rect.y = ${options.y};
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([rect]);

    return 'Image created: ' + w + 'x' + h + ' at (' + smartX + ', ${options.y})';
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed('Image created from URL');
      if (result) console.log(chalk.gray(result.trim()));
    } catch (e) {
      spinner.fail('Failed to create image: ' + e.message);
    }
  });

// config.js continues to register subcommands on this group
export { create };
