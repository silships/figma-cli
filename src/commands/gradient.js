// Commands: gradient (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { extractGradient, extractMesh, buildMeshFromColors, buildFigmaPaint, buildCssString } from '../gradient-extractor.js';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';

// ============ GRADIENT ============

const gradient = program
  .command('gradient')
  .description('Extract gradients from images and apply them to nodes');

gradient
  .command('extract <image>')
  .description('Extract a gradient or mesh-like gradient from an image (PNG/JPG)')
  .option('--mode <mode>', 'linear (1D, two/three-stop) or mesh (blur-stack approximation)', 'linear')
  .option('--apply-to <nodeId>', 'Apply the extracted gradient to this node. linear: sets fills. mesh: populates the frame with blur-blob children.')
  .option('--direction <dir>', '[linear] Force direction: auto|vertical|horizontal', 'auto')
  .option('--stops <n>', '[linear] Number of color stops (2, 3, or 5)', '3')
  .option('--blur <frac>', '[mesh] Blur radius as fraction of min(W, H). Default 0.38.')
  .option('--no-trim', "Don't auto-trim solid/transparent image borders")
  .option('--json', 'Output JSON instead of human-readable')
  .action(async (imagePath, options) => {
    const path = imagePath.startsWith('~')
      ? join(homedir(), imagePath.slice(1))
      : imagePath;
    if (!existsSync(path)) {
      console.error(chalk.red(`Image not found: ${path}`));
      process.exit(1);
    }

    const mode = (options.mode || 'linear').toLowerCase();
    if (mode !== 'linear' && mode !== 'mesh') {
      console.error(chalk.red(`Unknown mode "${mode}". Use linear or mesh.`));
      process.exit(1);
    }

    // ─── LINEAR mode ───
    if (mode === 'linear') {
      let result;
      try {
        result = extractGradient(path, {
          direction: options.direction,
          stops: Math.max(2, Math.min(5, parseInt(options.stops, 10) || 3)),
          trim: options.trim !== false,
        });
      } catch (e) {
        console.error(chalk.red(`Extraction failed: ${e.message}`));
        process.exit(1);
      }

      const css = buildCssString(result);
      const hexes = result.stops.map((s) =>
        '#' + s.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
      );

      if (options.json) {
        console.log(JSON.stringify({
          mode: 'linear',
          direction: result.direction,
          angle: result.angle,
          stops: result.stops.map((s, i) => ({ position: s.position, hex: hexes[i], rgb: s.rgb })),
          css,
          innerBox: result.box,
        }, null, 2));
      } else {
        console.log();
        console.log(chalk.cyan('  Gradient extracted (linear)'));
        console.log(chalk.gray('  ─────────────────────────────────────────'));
        console.log(chalk.white(`  Direction: ${result.direction} (${result.angle}deg)`));
        console.log(chalk.white(`  Stops:`));
        result.stops.forEach((s, i) => {
          const pct = Math.round(s.position * 100);
          console.log(chalk.gray(`    ${String(pct).padStart(3)}%  `) + chalk.white(hexes[i]) + chalk.gray(`  rgb(${s.rgb.join(', ')})`));
        });
        console.log(chalk.white(`  CSS:`));
        console.log(chalk.gray(`    ${css}`));
      }

      if (options.applyTo) {
        await checkConnection();
        const paint = buildFigmaPaint(result);
        const code = `
          (async () => {
            await figma.loadAllPagesAsync();
            const __wantId = ${JSON.stringify(options.applyTo)};
            let __gNode;
            if (/^selected$/i.test(__wantId)) {
              __gNode = figma.currentPage.selection[0];
              if (!__gNode) throw new Error('Nothing selected in Figma');
            } else {
              __gNode = await figma.getNodeByIdAsync(__wantId);
              if (!__gNode) throw new Error('Node not found: ' + __wantId);
            }
            if (!('fills' in __gNode)) throw new Error('Node does not support fills: ' + __gNode.type);
            __gNode.fills = [${JSON.stringify(paint)}];
            return JSON.stringify({ name: __gNode.name, type: __gNode.type });
          })()
        `;
        const spinner = options.json ? null : ora('Applying gradient...').start();
        try {
          const res = await fastEval(code);
          const info = JSON.parse(res);
          if (spinner) spinner.succeed(`Applied to ${info.name} (${info.type})`);
          else if (!options.json) console.log(chalk.green(`  ✓ Applied to ${info.name}`));
        } catch (e) {
          if (spinner) spinner.fail(`Apply failed: ${e.message}`);
          else console.error(chalk.red(`Apply failed: ${e.message}`));
          process.exit(1);
        }
      }
      return;
    }

    // ─── MESH mode ───
    let recipe;
    try {
      recipe = extractMesh(path, { trim: options.trim !== false });
      if (options.blur) recipe.blurFraction = Math.max(0.05, Math.min(0.8, parseFloat(options.blur)));
    } catch (e) {
      console.error(chalk.red(`Mesh extraction failed: ${e.message}`));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(recipe, null, 2));
    } else {
      console.log();
      console.log(chalk.cyan('  Mesh gradient extracted (blur-stack recipe)'));
      console.log(chalk.gray('  ─────────────────────────────────────────'));
      console.log(chalk.white(`  Base:  `) + chalk.gray(recipe.base));
      console.log(chalk.white(`  Blobs: `) + chalk.gray(`${recipe.blobs.length} ellipses, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`));
      recipe.blobs.forEach((b, i) => {
        const pos = `(${b.fx.toFixed(2)}, ${b.fy.toFixed(2)})`;
        console.log(chalk.gray(`    ${i + 1}.  ${pos.padEnd(18)} r=${b.r.toFixed(2)}  `) + chalk.white(b.color));
      });
    }

    if (options.applyTo) {
      await checkConnection();
      const code = `
        (async () => {
          await figma.loadAllPagesAsync();
          const __wantId = ${JSON.stringify(options.applyTo)};
          let __target;
          if (/^selected$/i.test(__wantId)) {
            __target = figma.currentPage.selection[0];
            if (!__target) throw new Error('Nothing selected in Figma');
          } else {
            __target = await figma.getNodeByIdAsync(__wantId);
            if (!__target) throw new Error('Node not found: ' + __wantId);
          }
          if (__target.type !== 'FRAME') throw new Error('Mesh mode requires a FRAME target; got ' + __target.type);
          const W = __target.width, H = __target.height;
          const D = Math.min(W, H);
          // Clear existing children
          for (const c of [...__target.children]) c.remove();
          __target.clipsContent = true;
          const __base = ${JSON.stringify(recipe.base)};
          const __hex = (h) => { h = h.replace('#', ''); return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 }; };
          __target.fills = [{ type:'SOLID', color: __hex(__base), opacity:1, visible:true, blendMode:'NORMAL' }];
          const __blobs = ${JSON.stringify(recipe.blobs)};
          const __blur = Math.round(D * ${recipe.blurFraction});
          for (const b of __blobs) {
            const e = figma.createEllipse();
            const R = Math.round(D * b.r);
            e.resize(R * 2, R * 2);
            e.x = b.fx * W - R;
            e.y = b.fy * H - R;
            e.fills = [{ type:'SOLID', color: __hex(b.color), opacity:1, visible:true, blendMode:'NORMAL' }];
            e.effects = [{ type:'LAYER_BLUR', radius: Math.round(__blur * (b.blurMul || 1)), visible: true }];
            __target.appendChild(e);
          }
          return JSON.stringify({ name: __target.name, blobs: __blobs.length, blur: __blur });
        })()
      `;
      const spinner = options.json ? null : ora('Building blur-stack...').start();
      try {
        const res = await fastEval(code);
        const info = JSON.parse(res);
        if (spinner) spinner.succeed(`Mesh built on ${info.name} (${info.blobs} blobs, blur ${info.blur}px)`);
        else if (!options.json) console.log(chalk.green(`  ✓ Mesh built on ${info.name}`));
      } catch (e) {
        if (spinner) spinner.fail(`Apply failed: ${e.message}`);
        else console.error(chalk.red(`Apply failed: ${e.message}`));
        process.exit(1);
      }
    }
  });

gradient
  .command('mesh <colors>')
  .description('Generate a mesh-gradient wallpaper from a color palette (no image needed)')
  .option('--apply-to <frameId>', 'Populate an existing Frame instead of creating a new one')
  .option('--base <hex>', 'Base fill behind the blobs (default: palette average)')
  .option('--size <WxH>', 'Frame size for a new wallpaper', '1920x1080')
  .option('--blur <frac>', 'Blur radius as fraction of min(W, H). Default 0.42.')
  .option('--grain [intensity]', 'Add film-grain NOISE over the wallpaper (0-1 density, default 0.18)')
  .option('--texture', 'Add a paper TEXTURE grain over the wallpaper')
  .option('--style <style>', 'Composition: scatter|diagonal|bands|drift|spotlight|corners|auto', 'auto')
  .option('--seed <n>', 'Random seed for reproducible composition (default: random each run)')
  .option('--name <name>', 'Name for the created frame', 'Mesh Wallpaper')
  .option('--json', 'Output JSON instead of human-readable')
  .action(async (colorsArg, options) => {
    const colors = colorsArg.split(',').map((c) => c.trim()).filter(Boolean);
    let recipe;
    try {
      recipe = buildMeshFromColors(colors, {
        base: options.base,
        blur: options.blur != null ? Math.max(0.05, Math.min(0.8, parseFloat(options.blur))) : undefined,
        style: options.style,
        seed: options.seed != null ? parseInt(options.seed, 10) : undefined,
      });
    } catch (e) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }

    if (!options.json) {
      console.log();
      console.log(chalk.cyan('  Mesh wallpaper recipe'));
      console.log(chalk.gray('  ─────────────────────────────────────────'));
      console.log(chalk.white(`  Style: `) + chalk.gray(`${recipe.style}  (seed ${recipe.seed})`));
      console.log(chalk.white(`  Base:  `) + chalk.gray(recipe.base));
      console.log(chalk.white(`  Blobs: `) + chalk.gray(`${recipe.blobs.length}, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`));
      recipe.blobs.forEach((b, i) => {
        const pos = `(${b.fx.toFixed(2)}, ${b.fy.toFixed(2)})`;
        console.log(chalk.gray(`    ${i + 1}.  ${pos.padEnd(18)} r=${b.r.toFixed(2)}  `) + chalk.white(b.color));
      });
    } else {
      console.log(JSON.stringify(recipe, null, 2));
    }

    await checkConnection();
    let W = 1920, H = 1080;
    const m = (options.size || '').match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (m) { W = parseInt(m[1], 10); H = parseInt(m[2], 10); }

    const code = `
      (async () => {
        await figma.loadAllPagesAsync();
        const __hex = (h) => { h = h.replace('#', ''); return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 }; };
        let __target;
        ${options.applyTo ? `
        const __wantId = ${JSON.stringify(options.applyTo)};
        if (/^selected$/i.test(__wantId)) {
          __target = figma.currentPage.selection[0];
          if (!__target) throw new Error('Nothing selected in Figma');
        } else {
          __target = await figma.getNodeByIdAsync(__wantId);
          if (!__target) throw new Error('Node not found: ' + __wantId);
        }
        if (__target.type !== 'FRAME') throw new Error('Mesh requires a FRAME target; got ' + __target.type);
        for (const c of [...__target.children]) c.remove();
        ` : `
        __target = figma.createFrame();
        __target.name = ${JSON.stringify(options.name || 'Mesh Wallpaper')};
        __target.resize(${W}, ${H});
        let __x = 0;
        figma.currentPage.children.forEach(n => { __x = Math.max(__x, n.x + (n.width || 0)); });
        __target.x = __x + 100;
        __target.y = 0;
        `}
        const W = __target.width, H = __target.height, D = Math.min(W, H);
        __target.clipsContent = true;
        __target.fills = [{ type:'SOLID', color: __hex(${JSON.stringify(recipe.base)}), opacity:1, visible:true, blendMode:'NORMAL' }];
        const __blobs = ${JSON.stringify(recipe.blobs)};
        const __blur = Math.round(D * ${recipe.blurFraction});
        for (const b of __blobs) {
          const e = figma.createEllipse();
          const R = Math.round(D * b.r);
          e.resize(R * 2, R * 2);
          e.x = b.fx * W - R;
          e.y = b.fy * H - R;
          e.fills = [{ type:'SOLID', color: __hex(b.color), opacity:1, visible:true, blendMode:'NORMAL' }];
          e.effects = [{ type:'LAYER_BLUR', radius: Math.round(__blur * (b.blurMul || 1)), visible: true }];
          __target.appendChild(e);
        }
        ${(() => {
          const fx = [];
          if (options.grain) {
            const dens = (options.grain === true) ? 0.18 : Math.max(0, Math.min(1, parseFloat(options.grain)));
            fx.push(`{type:'NOISE',noiseType:'MONOTONE',density:${dens},noiseSize:1.2,color:{r:0,g:0,b:0,a:1},visible:true}`);
          }
          if (options.texture) {
            fx.push(`{type:'TEXTURE',noiseSize:12,radius:24,clipToShape:true,visible:true}`);
          }
          return fx.length ? `__target.effects = [${fx.join(',')}];` : '';
        })()}
        figma.viewport.scrollAndZoomIntoView([__target]);
        return JSON.stringify({ id: __target.id, name: __target.name, blobs: __blobs.length, blur: __blur, w: W, h: H });
      })()
    `;
    const spinner = options.json ? null : ora('Building wallpaper...').start();
    try {
      const res = await fastEval(code);
      const info = JSON.parse(res);
      if (spinner) spinner.succeed(`${options.applyTo ? 'Built on' : 'Created'} ${info.name} (${info.w}x${info.h}, ${info.blobs} blobs)`);
      else if (!options.json) console.log(chalk.green(`  ✓ ${info.name} (${info.id})`));
    } catch (e) {
      if (spinner) spinner.fail(`Build failed: ${e.message}`);
      else console.error(chalk.red(`Build failed: ${e.message}`));
      process.exit(1);
    }
  });

