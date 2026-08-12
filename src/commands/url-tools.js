// Commands: url-tools (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  program,
  checkConnection,
  fastEval,
  figmaUse,
  loadConfig
} from '../lib/cli-core.js';

// ============ SCREENSHOT URL ============

program
  .command('screenshot-url <url>')
  .alias('screenshot')
  .description('Screenshot a website and import into Figma as reference')
  .option('-w, --width <n>', 'Viewport width', '1280')
  .option('-h, --height <n>', 'Viewport height', '800')
  .option('--full', 'Capture full page (not just viewport)')
  .option('-n, --name <name>', 'Node name', 'Screenshot')
  .option('--scale <n>', 'Scale factor (1 or 2 for retina)', '2')
  .action(async (url, options) => {
    checkConnection();

    const spinner = ora('Taking screenshot of ' + url + '...').start();

    try {
      const tempFile = join(tmpdir(), 'figma-cli-screenshot.png');

      // Build capture-website command arguments (array avoids shell injection)
      const args = ['--yes', 'capture-website-cli', url, `--output=${tempFile}`, `--width=${options.width}`, `--height=${options.height}`, `--scale-factor=${options.scale}`];
      if (options.full) args.push('--full-page');
      args.push('--overwrite');

      // Take screenshot
      execFileSync('npx', args, { stdio: 'ignore', timeout: 60000 });

      if (!existsSync(tempFile)) {
        throw new Error('Screenshot failed');
      }

      spinner.text = 'Importing into Figma...';

      // Read as base64
      const buffer = readFileSync(tempFile);
      const base64 = buffer.toString('base64');
      const dataUrl = 'data:image/png;base64,' + base64;

      // Import into Figma with smart positioning
      const code = `
(async () => {
  try {
    // Smart positioning
    let smartX = 0;
    figma.currentPage.children.forEach(n => {
      smartX = Math.max(smartX, n.x + (n.width || 0));
    });
    smartX += 100;

    // Create image from base64
    const image = await figma.createImageAsync("${dataUrl}");
    const { width, height } = await image.getSizeAsync();

    // Create rectangle with image fill
    const rect = figma.createRectangle();
    rect.name = "${options.name} - ${url}";
    rect.resize(width, height);
    rect.x = smartX;
    rect.y = 0;
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([rect]);

    return 'Screenshot imported: ' + width + 'x' + height;
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed('Screenshot imported into Figma');
      if (result) console.log(chalk.gray(result.trim()));

      // Cleanup
      try { unlinkSync(tempFile); } catch {}
    } catch (e) {
      spinner.fail('Failed: ' + e.message);
    }
  });

// ============ ANALYZE URL (Playwright) ============

program
  .command('analyze-url <url>')
  .description('Analyze a webpage with Playwright and extract exact CSS values')
  .option('-w, --width <n>', 'Viewport width', '1440')
  .option('-h, --height <n>', 'Viewport height', '900')
  .option('--screenshot', 'Also save a screenshot')
  .action(async (url, options) => {
    const spinner = ora('Analyzing ' + url + ' with Playwright...').start();

    try {
      // Create analysis script
      const script = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: ${options.width}, height: ${options.height} } });

  await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const rgbToHex = (rgb) => {
      if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return 'transparent';
      const match = rgb.match(/\\d+/g);
      if (!match || match.length < 3) return rgb;
      const [r, g, b] = match.map(Number);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    };

    const getStyles = (el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: rgbToHex(cs.color),
        bgColor: rgbToHex(cs.backgroundColor),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(),
        borderRadius: cs.borderRadius,
        border: cs.border,
        padding: cs.padding
      };
    };

    const results = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyBg: rgbToHex(window.getComputedStyle(document.body).backgroundColor),
      elements: []
    };

    document.querySelectorAll('h1, h2, h3, h4, button, [role="button"], input, label, [class*="btn"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.placeholder || '').slice(0, 80).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    return results;
  });

  console.log(JSON.stringify(data, null, 2));
  ${options.screenshot ? `await page.screenshot({ path: '${join(tmpdir(), 'analyze-screenshot.png').replace(/\\/g, '\\\\')}' });` : ''}
  await browser.close();
})();
`;

      // Write and run script
      const scriptPath = join(tmpdir(), 'figma-analyze-url.js');
      writeFileSync(scriptPath, script);

      const result = execSync(`node "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      });

      spinner.succeed('Page analyzed');
      console.log(result);

      if (options.screenshot) {
        console.log(chalk.gray('Screenshot saved: /tmp/analyze-screenshot.png'));
      }

      // Cleanup
      try { unlinkSync(scriptPath); } catch {}
    } catch (e) {
      spinner.fail('Analysis failed: ' + e.message);
    }
  });

// ============ RECREATE URL (Playwright + Figma) ============

program
  .command('recreate-url <url>')
  .alias('recreate')
  .description('Analyze a webpage and recreate it in Figma (desktop 1440px)')
  .option('-w, --width <n>', 'Viewport width', '1440')
  .option('-h, --height <n>', 'Viewport height', '900')
  .option('--name <name>', 'Frame name', 'Recreated Page')
  .action(async (url, options) => {
    checkConnection();

    const spinner = ora('Analyzing ' + url + ' with Playwright...').start();

    try {
      // Step 1: Analyze with Playwright
      const analyzeScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: ${options.width}, height: ${options.height} } });

  await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const rgbToHex = (rgb) => {
      if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return 'transparent';
      const match = rgb.match(/\\d+/g);
      if (!match || match.length < 3) return rgb;
      const [r, g, b] = match.map(Number);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    };

    const getStyles = (el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: rgbToHex(cs.color),
        bgColor: rgbToHex(cs.backgroundColor),
        fontSize: parseInt(cs.fontSize) || 16,
        fontWeight: parseInt(cs.fontWeight) || 400,
        fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(),
        borderRadius: parseInt(cs.borderRadius) || 0,
        borderWidth: parseInt(cs.borderWidth) || 0,
        borderColor: rgbToHex(cs.borderColor),
        paddingTop: parseInt(cs.paddingTop) || 0,
        paddingRight: parseInt(cs.paddingRight) || 0,
        paddingBottom: parseInt(cs.paddingBottom) || 0,
        paddingLeft: parseInt(cs.paddingLeft) || 0
      };
    };

    const results = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyBg: rgbToHex(window.getComputedStyle(document.body).backgroundColor),
      elements: []
    };

    // Get headings
    document.querySelectorAll('h1, h2, h3').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'heading',
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').slice(0, 200).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], a[class*="btn"], [class*="button"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 30 && rect.height > 20 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'button',
          text: (el.innerText || el.value || '').slice(0, 80).trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get inputs
    document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], textarea').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 20 && rect.top < 1200 && rect.top > -50) {
        results.elements.push({
          type: 'input',
          placeholder: el.placeholder || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    // Get paragraphs/labels
    document.querySelectorAll('p, label, span').forEach(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').trim();
      if (rect.width > 20 && rect.height > 10 && rect.top < 1200 && rect.top > -50 && text.length > 2 && text.length < 500) {
        results.elements.push({
          type: 'text',
          text: text.slice(0, 200),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ...getStyles(el)
        });
      }
    });

    return results;
  });

  console.log(JSON.stringify(data));
  await browser.close();
})();
`;

      const scriptPath = join(tmpdir(), 'figma-recreate-analyze.js');
      writeFileSync(scriptPath, analyzeScript);

      const analysisResult = execSync(`node "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      });

      const data = JSON.parse(analysisResult);
      spinner.text = 'Generating Figma code...';

      // Step 2: Generate Figma code
      const hexToRgbCodeStr = (hex) => {
        if (!hex || hex === 'transparent') return '{ r: 1, g: 1, b: 1 }';
        const h = hex.replace('#', '');
        const r = (parseInt(h.slice(0, 2), 16) / 255).toFixed(3);
        const g = (parseInt(h.slice(2, 4), 16) / 255).toFixed(3);
        const b = (parseInt(h.slice(4, 6), 16) / 255).toFixed(3);
        return `{ r: ${r}, g: ${g}, b: ${b} }`;
      };

      // Normalize font family name (Playwright returns lowercase)
      const normalizeFontFamily = (family) => {
        if (!family) return 'Inter';
        const f = family.toLowerCase();
        if (f.includes('inter')) return 'Inter';
        if (f.includes('roboto')) return 'Roboto';
        if (f.includes('arial')) return 'Arial';
        if (f.includes('helvetica')) return 'Helvetica';
        if (f.includes('georgia')) return 'Georgia';
        if (f.includes('times')) return 'Times New Roman';
        if (f.includes('verdana')) return 'Verdana';
        if (f.includes('open sans')) return 'Open Sans';
        if (f.includes('lato')) return 'Lato';
        if (f.includes('montserrat')) return 'Montserrat';
        if (f.includes('poppins')) return 'Poppins';
        if (f.includes('source sans')) return 'Source Sans Pro';
        // Capitalize first letter of each word
        return family.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      };

      // Get font style based on weight (handles different font naming conventions)
      const getFontStyle = (weight, family) => {
        const w = weight || 400;
        const f = (family || '').toLowerCase();

        // Inter uses "Semi Bold" with space
        if (f.includes('inter')) {
          if (w >= 700) return 'Bold';
          if (w >= 600) return 'Semi Bold';
          if (w >= 500) return 'Medium';
          return 'Regular';
        }

        // Most other fonts use "SemiBold" without space
        if (w >= 700) return 'Bold';
        if (w >= 600) return 'SemiBold';
        if (w >= 500) return 'Medium';
        return 'Regular';
      };

      // Collect unique font family + style combinations
      const fonts = new Set();
      data.elements.forEach(el => {
        const family = normalizeFontFamily(el.fontFamily);
        const style = getFontStyle(el.fontWeight, el.fontFamily);
        fonts.add(JSON.stringify({ family, style }));
      });
      // Always include a fallback
      fonts.add(JSON.stringify({ family: 'Inter', style: 'Regular' }));

      // Build Figma script
      let figmaCode = `(async function() {
  // Font fallback map: requested font → available font
  const fontMap = new Map();
  const fallbackFont = { family: 'Inter', style: 'Regular' };

  // Load font with fallback chain
  const loadFont = async (family, style) => {
    const key = family + '|' + style;

    // Try exact match
    try {
      await figma.loadFontAsync({ family, style });
      fontMap.set(key, { family, style });
      return;
    } catch {}

    // Try Regular style
    try {
      await figma.loadFontAsync({ family, style: 'Regular' });
      fontMap.set(key, { family, style: 'Regular' });
      return;
    } catch {}

    // Fall back to Inter
    await figma.loadFontAsync(fallbackFont);
    fontMap.set(key, fallbackFont);
  };

  // Get available font (with fallback)
  const getFont = (family, style) => {
    const key = family + '|' + style;
    return fontMap.get(key) || fallbackFont;
  };

${[...fonts].map(f => {
  const { family, style } = JSON.parse(f);
  return `  await loadFont("${family}", "${style}");`;
}).join('\n')}

  // Smart positioning
  let smartX = 0;
  figma.currentPage.children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
  smartX += 100;

  // Main desktop frame
  const main = figma.createFrame();
  main.name = "${options.name}";
  main.resize(${options.width}, ${options.height});
  main.fills = [{ type: "SOLID", color: ${hexToRgbCodeStr(data.bodyBg)} }];
  main.x = smartX;
  main.y = 0;
  main.clipsContent = true;

`;

      // Add elements
      data.elements.forEach((el, i) => {
        const fontFamily = normalizeFontFamily(el.fontFamily);
        const fontStyle = getFontStyle(el.fontWeight, el.fontFamily);

        if (el.type === 'heading' || el.type === 'text') {
          const text = (el.text || '').replace(/"/g, '\\"').replace(/\n/g, '\\n');
          if (!text) return;
          figmaCode += `
  // ${el.type}: ${text.slice(0, 30)}
  const t${i} = figma.createText();
  t${i}.fontName = getFont("${fontFamily}", "${fontStyle}");
  t${i}.characters = "${text}";
  t${i}.fontSize = ${el.fontSize || 16};
  t${i}.fills = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.color)} }];
  t${i}.x = ${el.x};
  t${i}.y = ${el.y};
  main.appendChild(t${i});
`;
        } else if (el.type === 'button') {
          const text = (el.text || '').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
          if (!text) return;
          figmaCode += `
  // Button: ${text.slice(0, 30)}
  const btn${i} = figma.createFrame();
  btn${i}.name = "${text.slice(0, 20)}";
  btn${i}.resize(${el.w}, ${el.h});
  btn${i}.x = ${el.x};
  btn${i}.y = ${el.y};
  btn${i}.cornerRadius = ${el.borderRadius || 0};
  btn${i}.fills = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.bgColor)} }];
  ${el.borderWidth > 0 ? `btn${i}.strokes = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.borderColor)} }]; btn${i}.strokeWeight = ${el.borderWidth};` : ''}
  btn${i}.layoutMode = "HORIZONTAL";
  btn${i}.primaryAxisAlignItems = "CENTER";
  btn${i}.counterAxisAlignItems = "CENTER";
  const btnTxt${i} = figma.createText();
  btnTxt${i}.fontName = getFont("${fontFamily}", "${fontStyle}");
  btnTxt${i}.characters = "${text}";
  btnTxt${i}.fontSize = ${el.fontSize || 14};
  btnTxt${i}.fills = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.color)} }];
  btn${i}.appendChild(btnTxt${i});
  main.appendChild(btn${i});
`;
        } else if (el.type === 'input') {
          const placeholder = (el.placeholder || 'Enter text...').replace(/"/g, '\\"');
          figmaCode += `
  // Input
  const input${i} = figma.createFrame();
  input${i}.name = "Input";
  input${i}.resize(${el.w}, ${el.h});
  input${i}.x = ${el.x};
  input${i}.y = ${el.y};
  input${i}.cornerRadius = ${el.borderRadius || 4};
  input${i}.fills = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.bgColor)} }];
  ${el.borderWidth > 0 ? `input${i}.strokes = [{ type: "SOLID", color: ${hexToRgbCodeStr(el.borderColor)} }]; input${i}.strokeWeight = ${el.borderWidth};` : ''}
  input${i}.layoutMode = "HORIZONTAL";
  input${i}.counterAxisAlignItems = "CENTER";
  input${i}.paddingLeft = ${el.paddingLeft || 12};
  const ph${i} = figma.createText();
  ph${i}.fontName = getFont("${fontFamily}", "Regular");
  ph${i}.characters = "${placeholder}";
  ph${i}.fontSize = ${el.fontSize || 14};
  ph${i}.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }];
  input${i}.appendChild(ph${i});
  main.appendChild(input${i});
`;
        }
      });

      figmaCode += `
  figma.viewport.scrollAndZoomIntoView([main]);
  return "Recreated ${data.elements.length} elements from ${url}";
})()`;

      // Step 3: Execute via daemon (fast) or direct connection (fallback)
      spinner.text = 'Creating in Figma...';
      await fastEval(figmaCode);

      spinner.succeed('Page recreated in Figma');
      console.log(chalk.green('✓ ') + chalk.white(`Created ${data.elements.length} elements`));
      console.log(chalk.gray(`  Frame: "${options.name}" (${options.width}x${options.height})`));
      console.log(chalk.gray(`  Source: ${url}`));

      // Cleanup
      try { unlinkSync(scriptPath); } catch {}
    } catch (e) {
      spinner.fail('Recreation failed: ' + e.message);
      if (process.env.DEBUG) console.error(e);
    }
  });

// ============ REMOVE BACKGROUND ============

program
  .command('remove-bg [nodeId]')
  .alias('removebg')
  .description('Remove background from selected image (uses remove.bg API)')
  .option('--api-key <key>', 'Remove.bg API key')
  .action(async (nodeId, options) => {
    checkConnection();

    // Get API key from option, env var, or config
    const config = loadConfig();
    const apiKey = options.apiKey || process.env.REMOVEBG_API_KEY || config.removebgApiKey;

    if (!apiKey) {
      console.log(chalk.red('✗ Remove.bg API key required\n'));
      console.log(chalk.white.bold('How to get your API key (free, 50 images/month):\n'));
      console.log(chalk.gray('  1. Go to ') + chalk.cyan('https://www.remove.bg/api'));
      console.log(chalk.gray('  2. Click "Get API Key" and sign up'));
      console.log(chalk.gray('  3. Copy your API key from the dashboard\n'));
      console.log(chalk.white.bold('Then use one of these methods:\n'));
      console.log(chalk.cyan('  Option A: ') + chalk.gray('Save permanently'));
      console.log(chalk.white('    node src/index.js config set removebgApiKey YOUR_KEY\n'));
      console.log(chalk.cyan('  Option B: ') + chalk.gray('Use once'));
      console.log(chalk.white('    node src/index.js remove-bg --api-key YOUR_KEY\n'));
      console.log(chalk.cyan('  Option C: ') + chalk.gray('Environment variable'));
      console.log(chalk.white('    export REMOVEBG_API_KEY=YOUR_KEY'));
      return;
    }

    const spinner = ora('Exporting selected image...').start();

    try {
      const tempInput = join(tmpdir(), 'figma-cli-removebg-input.png');

      // Export selected node as PNG
      let exportCmd = 'export png --scale 2 --output "' + tempInput + '"';
      if (nodeId) exportCmd += ' --node "' + nodeId + '"';
      const exportResult = figmaUse(exportCmd, { silent: true });

      if (!existsSync(tempInput)) {
        throw new Error('Export failed. Select an image or frame first.');
      }

      spinner.text = 'Removing background via remove.bg...';

      // Read image and send to Remove.bg API
      const imageBuffer = readFileSync(tempInput);
      const base64Image = imageBuffer.toString('base64');

      const response = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_file_b64: base64Image,
          size: 'auto',
          format: 'png',
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const errorMsg = error.errors?.[0]?.title || 'API request failed';
        if (response.status === 402) {
          throw new Error('API credits exhausted. Get more at remove.bg/api');
        }
        if (response.status === 403) {
          throw new Error('Invalid API key. Check your key at remove.bg/api');
        }
        throw new Error(errorMsg);
      }

      // Get result as base64
      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const resultBase64 = resultBuffer.toString('base64');
      const dataUrl = 'data:image/png;base64,' + resultBase64;

      spinner.text = 'Updating image in Figma...';

      // Replace the selected node's fill with the new image
      const code = `
(async () => {
  try {
    const node = figma.currentPage.selection[0];
    if (!node) return 'Error: No node selected';

    // Create new image from base64
    const image = await figma.createImageAsync("${dataUrl}");

    // Replace fills with new image
    if ('fills' in node) {
      node.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
      return 'Background removed from ' + node.name;
    } else {
      return 'Error: Selected node cannot have image fills';
    }
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });

      if (result && result.includes('Error:')) {
        spinner.fail(result.trim());
      } else {
        spinner.succeed('Background removed!');
        if (result) console.log(chalk.gray(result.trim()));
      }

      // Cleanup
      try { unlinkSync(tempInput); } catch {}
    } catch (e) {
      spinner.fail('Failed: ' + e.message);
    }
  });

