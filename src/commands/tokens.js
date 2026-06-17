// Commands: tokens (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  figmaUse,
  getFigmaClient,
  handleEvalError,
  hexToRgb
} from '../lib/cli-core.js';

// ============ COLLECTIONS ============

const collections = program
  .command('collections')
  .alias('col')
  .description('Manage variable collections');

collections
  .command('list')
  .description('List all collections')
  .action(() => {
    checkConnection();
    figmaUse('collection list');
  });

collections
  .command('create <name>')
  .description('Create a collection')
  .action((name) => {
    checkConnection();
    figmaUse(`collection create "${name}"`);
  });

// ============ TOKENS (PRESETS) ============

const tokens = program
  .command('tokens')
  .description('Create design token presets');

tokens
  .command('tailwind')
  .description('Create Tailwind CSS color palette')
  .option('-c, --collection <name>', 'Collection name', 'Color - Primitive')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating Tailwind color palette...').start();

    const tailwindColors = {
      slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
      zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
      stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
      red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
      orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
      amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
      yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
      lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
      green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
      emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
      teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
      cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
      sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
      blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
      violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
      purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
      fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
      pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
      rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' }
    };

    const code = `(async () => {
const colors = ${JSON.stringify(tailwindColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return 'Created ' + count + ' color variables in ' + ${JSON.stringify(options.collection)};
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created Tailwind palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(error.message);
    }
  });

tokens
  .command('preset <name>')
  .description('Add color presets: shadcn, radix')
  .action(async (preset) => {
    checkConnection();

    const presetLower = preset.toLowerCase();

    if (presetLower === 'shadcn') {
      // shadcn/ui colors: primitives + semantic tokens (Light/Dark)
      const spinner = ora('Adding shadcn colors...').start();

      // Tailwind primitives (same as shadcn uses)
      const primitives = {
        slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
        gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
        zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
        neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
        stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
        red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
        orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
        amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
        yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
        lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
        green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
        emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
        teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
        cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
        sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
        blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
        indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
        violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
        purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
        fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
        pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
        rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' },
        white: { DEFAULT: '#ffffff' },
        black: { DEFAULT: '#000000' }
      };

      // Semantic tokens with Light/Dark mode values (references to primitives)
      // Based on shadcn/ui default zinc theme
      const semanticTokens = {
        'background':           { light: 'white',  dark: 'zinc/950' },
        'foreground':           { light: 'zinc/950',       dark: 'zinc/50' },
        'card':                 { light: 'white',  dark: 'zinc/950' },
        'card-foreground':      { light: 'zinc/950',       dark: 'zinc/50' },
        'popover':              { light: 'white',  dark: 'zinc/950' },
        'popover-foreground':   { light: 'zinc/950',       dark: 'zinc/50' },
        'primary':              { light: 'zinc/900',       dark: 'zinc/50' },
        'primary-foreground':   { light: 'zinc/50',        dark: 'zinc/900' },
        'secondary':            { light: 'zinc/100',       dark: 'zinc/800' },
        'secondary-foreground': { light: 'zinc/900',       dark: 'zinc/50' },
        'muted':                { light: 'zinc/100',       dark: 'zinc/800' },
        'muted-foreground':     { light: 'zinc/500',       dark: 'zinc/400' },
        'accent':               { light: 'zinc/100',       dark: 'zinc/800' },
        'accent-foreground':    { light: 'zinc/900',       dark: 'zinc/50' },
        'destructive':          { light: 'red/500',        dark: 'red/900' },
        'destructive-foreground': { light: 'zinc/50',      dark: 'zinc/50' },
        'border':               { light: 'zinc/200',       dark: 'zinc/800' },
        'input':                { light: 'zinc/200',       dark: 'zinc/800' },
        'ring':                 { light: 'zinc/950',       dark: 'zinc/300' },
        'chart-1':              { light: 'orange/500',     dark: 'blue/500' },
        'chart-2':              { light: 'teal/500',       dark: 'emerald/500' },
        'chart-3':              { light: 'blue/500',       dark: 'amber/500' },
        'chart-4':              { light: 'amber/500',      dark: 'rose/500' },
        'chart-5':              { light: 'rose/500',       dark: 'violet/500' },
        'sidebar-background':   { light: 'zinc/50',        dark: 'zinc/950' },
        'sidebar-foreground':   { light: 'zinc/900',       dark: 'zinc/50' },
        'sidebar-primary':      { light: 'zinc/900',       dark: 'zinc/50' },
        'sidebar-primary-foreground': { light: 'zinc/50', dark: 'zinc/900' },
        'sidebar-accent':       { light: 'zinc/100',       dark: 'zinc/800' },
        'sidebar-accent-foreground': { light: 'zinc/900', dark: 'zinc/50' },
        'sidebar-border':       { light: 'zinc/200',       dark: 'zinc/800' },
        'sidebar-ring':         { light: 'zinc/950',       dark: 'zinc/300' }
      };

      const code = `(async () => {
const primitives = ${JSON.stringify(primitives)};
const semanticTokens = ${JSON.stringify(semanticTokens)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 } : null;
}

// Step 1: Create primitives collection
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let primCol = cols.find(c => c.name === 'shadcn/primitives');
if (!primCol) primCol = figma.variables.createVariableCollection('shadcn/primitives');
const primModeId = primCol.modes[0].modeId;

// Create primitive variables
const existingVars = await figma.variables.getLocalVariablesAsync('COLOR');
const primVarMap = {};
let primCount = 0;

for (const [colorName, shades] of Object.entries(primitives)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const varName = shade === 'DEFAULT' ? colorName : colorName + '/' + shade;
    let v = existingVars.find(ev => ev.name === varName && ev.variableCollectionId === primCol.id);
    if (!v) {
      v = figma.variables.createVariable(varName, primCol, 'COLOR');
      v.setValueForMode(primModeId, hexToRgb(hex));
      primCount++;
    }
    primVarMap[varName] = v;
  }
}

// Step 2: Create semantic collection with Light/Dark modes
let semCol = cols.find(c => c.name === 'shadcn/semantic');
if (!semCol) semCol = figma.variables.createVariableCollection('shadcn/semantic');

// Ensure we have Light and Dark modes
let lightModeId = semCol.modes.find(m => m.name === 'Light')?.modeId;
let darkModeId = semCol.modes.find(m => m.name === 'Dark')?.modeId;

if (!lightModeId) {
  semCol.renameMode(semCol.modes[0].modeId, 'Light');
  lightModeId = semCol.modes[0].modeId;
}
if (!darkModeId) {
  darkModeId = semCol.addMode('Dark');
}

// Create semantic variables with aliases
let semCount = 0;
for (const [name, refs] of Object.entries(semanticTokens)) {
  let v = existingVars.find(ev => ev.name === name && ev.variableCollectionId === semCol.id);
  if (!v) {
    v = figma.variables.createVariable(name, semCol, 'COLOR');
    semCount++;
  }

  // Set Light mode (alias to primitive)
  const lightPrim = primVarMap[refs.light];
  if (lightPrim) {
    v.setValueForMode(lightModeId, { type: 'VARIABLE_ALIAS', id: lightPrim.id });
  }

  // Set Dark mode (alias to primitive)
  const darkPrim = primVarMap[refs.dark];
  if (darkPrim) {
    v.setValueForMode(darkModeId, { type: 'VARIABLE_ALIAS', id: darkPrim.id });
  }
}

return 'Created ' + primCount + ' primitives + ' + semCount + ' semantic tokens (Light/Dark)';
})()`;

      try {
        const result = await fastEval(code);
        spinner.succeed(result || 'Added shadcn colors');
        console.log(chalk.gray('\n  Collections created:'));
        console.log(chalk.gray('    • shadcn/primitives - 244 color primitives'));
        console.log(chalk.gray('    • shadcn/semantic   - 32 semantic tokens (Light/Dark mode)\n'));
        console.log(chalk.gray('  Usage: Apply "Light" or "Dark" mode to any frame'));
      } catch (error) {
        spinner.fail('Failed to add shadcn');
        console.error(chalk.red(error.message));
      }

    } else if (presetLower === 'radix') {
      // Radix UI Colors - 12 color families with 12 steps each
      const spinner = ora('Adding Radix UI colors...').start();

      const radixColors = {
        gray: { 1: '#fcfcfc', 2: '#f9f9f9', 3: '#f0f0f0', 4: '#e8e8e8', 5: '#e0e0e0', 6: '#d9d9d9', 7: '#cecece', 8: '#bbbbbb', 9: '#8d8d8d', 10: '#838383', 11: '#646464', 12: '#202020' },
        slate: { 1: '#fcfcfd', 2: '#f9f9fb', 3: '#f0f0f3', 4: '#e8e8ec', 5: '#e0e1e6', 6: '#d9d9e0', 7: '#cdced6', 8: '#b9bbc6', 9: '#8b8d98', 10: '#80838d', 11: '#60646c', 12: '#1c2024' },
        red: { 1: '#fffcfc', 2: '#fff7f7', 3: '#feebec', 4: '#ffdbdc', 5: '#ffcdce', 6: '#fdbdbe', 7: '#f4a9aa', 8: '#eb8e90', 9: '#e5484d', 10: '#dc3e42', 11: '#ce2c31', 12: '#641723' },
        orange: { 1: '#fefcfb', 2: '#fff7ed', 3: '#ffefd6', 4: '#ffdfb5', 5: '#ffd19a', 6: '#ffc182', 7: '#f5ae73', 8: '#ec9455', 9: '#f76b15', 10: '#ef5f00', 11: '#cc4e00', 12: '#582d1d' },
        amber: { 1: '#fefdfb', 2: '#fefbe9', 3: '#fff7c2', 4: '#ffee9c', 5: '#fbe577', 6: '#f3d673', 7: '#e9c162', 8: '#e2a336', 9: '#ffc53d', 10: '#ffba18', 11: '#ab6400', 12: '#4f3422' },
        yellow: { 1: '#fdfdf9', 2: '#fefce9', 3: '#fffab8', 4: '#fff394', 5: '#ffe770', 6: '#f3d768', 7: '#e4c767', 8: '#d5ae39', 9: '#ffe629', 10: '#ffdc00', 11: '#9e6c00', 12: '#473b1f' },
        green: { 1: '#fbfefc', 2: '#f4fbf6', 3: '#e6f6eb', 4: '#d6f1df', 5: '#c4e8d1', 6: '#adddc0', 7: '#8eceaa', 8: '#5bb98b', 9: '#30a46c', 10: '#2b9a66', 11: '#218358', 12: '#193b2d' },
        teal: { 1: '#fafefd', 2: '#f3fbf9', 3: '#e0f8f3', 4: '#ccf3ea', 5: '#b8eae0', 6: '#a1ded2', 7: '#83cdc1', 8: '#53b9ab', 9: '#12a594', 10: '#0d9b8a', 11: '#008573', 12: '#0d3d38' },
        cyan: { 1: '#fafdfe', 2: '#f2fafb', 3: '#def7f9', 4: '#caf1f6', 5: '#b5e9f0', 6: '#9ddde7', 7: '#7dcedc', 8: '#3db9cf', 9: '#00a2c7', 10: '#0797b9', 11: '#107d98', 12: '#0d3c48' },
        blue: { 1: '#fbfdff', 2: '#f4faff', 3: '#e6f4fe', 4: '#d5efff', 5: '#c2e5ff', 6: '#acd8fc', 7: '#8ec8f6', 8: '#5eb1ef', 9: '#0090ff', 10: '#0588f0', 11: '#0d74ce', 12: '#113264' },
        indigo: { 1: '#fdfdfe', 2: '#f7f9ff', 3: '#edf2fe', 4: '#e1e9ff', 5: '#d2deff', 6: '#c1d0ff', 7: '#abbdf9', 8: '#8da4ef', 9: '#3e63dd', 10: '#3358d4', 11: '#3a5bc7', 12: '#1f2d5c' },
        violet: { 1: '#fdfcfe', 2: '#faf8ff', 3: '#f4f0fe', 4: '#ebe4ff', 5: '#e1d9ff', 6: '#d4cafe', 7: '#c2b5f5', 8: '#aa99ec', 9: '#6e56cf', 10: '#654dc4', 11: '#6550b9', 12: '#2f265f' },
        pink: { 1: '#fffcfe', 2: '#fef7fb', 3: '#fee9f5', 4: '#fbdcef', 5: '#f6cee7', 6: '#efbfdd', 7: '#e7acd0', 8: '#dd93c2', 9: '#d6409f', 10: '#cf3897', 11: '#c2298a', 12: '#651249' }
      };

      const code = `(async () => {
const colors = ${JSON.stringify(radixColors)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 } : null;
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'radix/colors');
if (!col) col = figma.variables.createVariableCollection('radix/colors');
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync('COLOR');
let count = 0;

for (const [colorName, steps] of Object.entries(colors)) {
  for (const [step, hex] of Object.entries(steps)) {
    const varName = colorName + '/' + step;
    let v = existingVars.find(ev => ev.name === varName && ev.variableCollectionId === col.id);
    if (!v) {
      v = figma.variables.createVariable(varName, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}

return 'Created ' + count + ' Radix color variables';
})()`;

      try {
        const result = await fastEval(code);
        spinner.succeed(result || 'Added Radix UI colors');
        console.log(chalk.gray('\n  Collection created:'));
        console.log(chalk.gray('    • radix/colors - 156 colors (13 families × 12 steps)\n'));
        console.log(chalk.gray('  Colors: gray, slate, red, orange, amber, yellow,'));
        console.log(chalk.gray('          green, teal, cyan, blue, indigo, violet, pink'));
      } catch (error) {
        spinner.fail('Failed to add Radix colors');
        console.error(chalk.red(error.message));
      }

    } else if (presetLower === 'material') {
      console.log(chalk.yellow('Material Design preset coming soon!'));
      console.log(chalk.gray('Available now: shadcn, radix'));

    } else {
      console.log(chalk.red(`Unknown preset: ${preset}`));
      console.log(chalk.gray('Available presets: shadcn, radix, material (coming soon)'));
    }
  });

tokens
  .command('shadcn')
  .description('Create shadcn/ui color primitives (from v3.shadcn.com/colors)')
  .option('-c, --collection <name>', 'Collection name', 'shadcn/primitives')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating shadcn color primitives...').start();

    // All colors from https://v3.shadcn.com/colors
    const shadcnColors = {
      slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
      zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
      stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
      red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
      orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
      amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
      yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
      lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
      green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
      emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
      teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
      cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
      sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
      blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
      violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
      purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
      fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
      pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
      rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' }
    };

    const code = `(async () => {
const colors = ${JSON.stringify(shadcnColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return 'Created ' + count + ' shadcn color variables in ' + ${JSON.stringify(options.collection)};
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created shadcn primitives (231 colors)');
    } catch (error) {
      spinner.fail('Failed to create shadcn colors');
      console.error(error.message);
    }
  });

tokens
  .command('spacing')
  .description('Create spacing scale (4px base)')
  .option('-c, --collection <name>', 'Collection name', 'Spacing')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating spacing scale...').start();

    const spacings = {
      '0': 0, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10,
      '3': 12, '3.5': 14, '4': 16, '5': 20, '6': 24, '7': 28,
      '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
      '14': 56, '16': 64, '20': 80, '24': 96, '28': 112,
      '32': 128, '36': 144, '40': 160, '44': 176, '48': 192
    };

    const code = `(async () => {
const spacings = ${JSON.stringify(spacings)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(spacings)) {
  const existing = existingVars.find(v => v.name === 'spacing/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('spacing/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' spacing variables';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created spacing scale');
    } catch (error) {
      spinner.fail('Failed to create spacing scale');
    }
  });

tokens
  .command('radii')
  .description('Create border radius scale')
  .option('-c, --collection <name>', 'Collection name', 'Radii')
  .action((options) => {
    checkConnection();
    const spinner = ora('Creating border radii...').start();

    const radii = {
      'none': 0, 'sm': 2, 'default': 4, 'md': 6, 'lg': 8,
      'xl': 12, '2xl': 16, '3xl': 24, 'full': 9999
    };

    const code = `(async () => {
const radii = ${JSON.stringify(radii)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(radii)) {
  const existing = existingVars.find(v => v.name === 'radius/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('radius/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' radius variables';
})()
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created border radii');
    } catch (error) {
      spinner.fail('Failed to create radii');
    }
  });

tokens
  .command('import <file>')
  .description('Import tokens from JSON file')
  .option('-c, --collection <name>', 'Collection name')
  .option('--force-slash', 'Allow "/" in --collection (bypasses the LLM-mistake guard)')
  .action((file, options) => {
    checkConnection();
    // Guard against LLM-style mistakes: a "/" in the collection name almost
    // always means the caller split one DESIGN.md across multiple `tokens
    // import` runs (e.g. -c "stripe/colors", -c "stripe/radius"). Figma
    // treats "/" as a normal character — it does NOT nest collections — so
    // the result is fake siblings, not a hierarchy.
    if (options.collection && options.collection.includes('/')) {
      console.error(chalk.yellow(`⚠ Collection name "${options.collection}" contains "/".`));
      console.error(chalk.yellow('  Figma does not nest collections. "/" creates flat sibling collections.'));
      console.error(chalk.gray('  If this is a DESIGN.md file, use `figma-cli import <path>` instead — it imports the whole system into one collection atomically.'));
      console.error(chalk.gray('  To proceed anyway, re-run with --force-slash.'));
      if (!options.forceSlash) process.exit(1);
    }

    // Read JSON file
    let tokensData;
    try {
      const content = readFileSync(file, 'utf8');
      tokensData = JSON.parse(content);
    } catch (error) {
      console.log(chalk.red(`✗ Could not read file: ${file}`));
      process.exit(1);
    }

    const spinner = ora('Importing tokens...').start();

    // Detect format and convert
    // Support: { "colors": { "primary": "#xxx" } } or { "primary": { "value": "#xxx", "type": "color" } }
    const collectionName = options.collection || 'Imported Tokens';

    const code = `(async () => {
const data = ${JSON.stringify(tokensData)};
const collectionName = ${JSON.stringify(collectionName)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

function detectType(value) {
  if (typeof value === 'string' && value.startsWith('#')) return 'COLOR';
  if (typeof value === 'number') return 'FLOAT';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'STRING';
}

function flattenTokens(obj, prefix = '') {
  const result = [];
  for (const [key, val] of Object.entries(obj)) {
    const name = prefix ? prefix + '/' + key : key;
    if (val && typeof val === 'object' && !val.value && !val.type) {
      result.push(...flattenTokens(val, name));
    } else {
      const value = val?.value ?? val;
      const type = val?.type?.toUpperCase() || detectType(value);
      result.push({ name, value, type });
    }
  }
  return result;
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
const tokens = flattenTokens(data);
let count = 0;

for (const { name, value, type } of tokens) {
  // Scoped to the target collection — overlapping names across collections OK
  const existing = existingVars.find(v => v.name === name && v.variableCollectionId === col.id);
  if (!existing) {
    try {
      const figmaType = type === 'COLOR' ? 'COLOR' : type === 'FLOAT' || type === 'NUMBER' ? 'FLOAT' : type === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';
      const v = figma.variables.createVariable(name, col, figmaType);
      let figmaValue = value;
      if (figmaType === 'COLOR') figmaValue = hexToRgb(value);
      if (figmaValue !== null) {
        v.setValueForMode(modeId, figmaValue);
        count++;
      }
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
    }
  });

tokens
  .command('overlap <collections...>')
  .description('Compare token names across N local variable collections. Shows common core (switchable subset) + per-collection unique names. Useful before `figma-cli use` to know which tokens swap cleanly.')
  .option('--json', 'Output as JSON')
  .action(async (collectionNames, options) => {
    await checkConnection();
    if (collectionNames.length < 2) {
      console.error(chalk.red('✗'), 'Pass at least two collection names. Example: figma-cli tokens overlap airbnb cursor stripe');
      process.exit(1);
    }
    const code = `(async () => {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      const allVars = await figma.variables.getLocalVariablesAsync();
      const targets = ${JSON.stringify(collectionNames)};
      const resolved = [];
      const missing = [];
      for (const q of targets) {
        const ql = q.toLowerCase();
        const c = cols.find(c => c.name.toLowerCase() === ql)
              || cols.find(c => c.name.toLowerCase().includes(ql));
        if (!c) { missing.push(q); continue; }
        const names = new Set(allVars.filter(v => v.variableCollectionId === c.id).map(v => v.name));
        resolved.push({ query: q, name: c.name, names: [...names] });
      }
      if (missing.length) {
        return { error: 'collections not found: ' + missing.join(', '),
                 available: cols.map(c => c.name) };
      }
      // Intersection: names present in EVERY resolved collection
      const sets = resolved.map(r => new Set(r.names));
      const intersection = [...sets[0]].filter(n => sets.every(s => s.has(n))).sort();
      // Per-collection: unique to this collection (in this set, not in any other)
      const unique = resolved.map((r, i) => ({
        collection: r.name,
        total: r.names.length,
        only_here: r.names.filter(n => resolved.every((r2, j) => i === j || !sets[j].has(n))).sort(),
        missing_here: [...intersection.length > 0 ? new Set() : new Set()].sort(),
      }));
      // For each collection, also compute "missing here that others have"
      const allNames = new Set();
      for (const r of resolved) for (const n of r.names) allNames.add(n);
      for (let i = 0; i < unique.length; i++) {
        const have = sets[i];
        unique[i].missing_here = [...allNames].filter(n => !have.has(n)).sort();
      }
      return { collections: resolved.map(r => r.name), commonCore: intersection, perCollection: unique };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (r.error) {
        console.error(chalk.red('✗'), r.error);
        console.error(chalk.gray('  Available: ' + (r.available || []).join(', ')));
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log();
      console.log(chalk.cyan(`Comparing ${r.collections.length} collections: ${r.collections.join(', ')}`));
      console.log();
      console.log(chalk.green(`✓ Common core — ${r.commonCore.length} tokens (switch cleanly across all):`));
      if (r.commonCore.length === 0) {
        console.log(chalk.gray('  (none — no shared token names)'));
      } else {
        console.log('  ' + r.commonCore.join(', '));
      }
      console.log();
      for (const c of r.perCollection) {
        console.log(chalk.cyan(`${c.collection}`) + chalk.gray(` (${c.total} tokens)`));
        if (c.only_here.length > 0) {
          console.log(chalk.yellow(`  only here (${c.only_here.length}):`));
          console.log('    ' + c.only_here.join(', '));
        }
        if (c.missing_here.length > 0) {
          console.log(chalk.gray(`  missing here (${c.missing_here.length}) — won't switch INTO this collection:`));
          console.log(chalk.gray('    ' + c.missing_here.join(', ')));
        }
        console.log();
      }
      console.log(chalk.gray('Tip: design with the common-core tokens for cleanest theme switching.'));
    } catch (e) {
      handleEvalError(e);
    }
  });

tokens
  .command('import-design-md <file>')
  .description('Import tokens from a DESIGN.md (Figma extraction format with `## 11. Machine-readable tokens` JSON block). Creates color, radius, and typography variables. Also prints a context summary for figmachat.')
  .option('-c, --collection <name>', 'Collection name (defaults to the design system name)')
  .option('--print-context', 'Just print the figmachat context summary, do not create variables')
  .action(async (file, options) => {
    let parsed;
    try {
      const { parseDesignMd } = await import('../design-md.js');
      parsed = parseDesignMd(file);
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }

    if (options.printContext) {
      const { summarizeForLLM } = await import('../design-md.js');
      console.log(summarizeForLLM(parsed));
      return;
    }

    checkConnection();
    const { toTokensImportJson, summarizeForLLM, variableImportCode } = await import('../design-md.js');

    // Authoritative path: the file carries real variable collections (from
    // `figma-cli extract`). Recreate them faithfully — names, modes, alias
    // chains — instead of the lossy single-mode palette derived from fills.
    const realVars = parsed.tokens.variables;
    if (realVars && Object.keys(realVars).length) {
      const collNames = Object.keys(realVars);
      const totalVars = collNames.reduce((a, n) => a + Object.keys(realVars[n].variables || {}).length, 0);
      if (options.collection) {
        console.log(chalk.yellow('⚠'), `--collection is ignored: this file carries ${collNames.length} named collection(s); using their real names.`);
      }
      const spinner = ora(`Recreating ${totalVars} variable(s) across ${collNames.length} collection(s)…`).start();
      try {
        const result = await daemonExec('eval', { code: variableImportCode(realVars) });
        const r = typeof result === 'string' ? (() => { try { return JSON.parse(result); } catch { return null; } })() : result;
        if (r) {
          spinner.succeed(`Created ${r.createdCount} variable(s), wired ${r.aliasCount} alias(es) across ${r.collections} collection(s)`);
          if (r.unresolved) console.log(chalk.yellow(`  ⚠ ${r.unresolved} alias value(s) unresolved (target outside this file / type mismatch)`));
        } else {
          spinner.succeed('Variables imported');
        }
      } catch (error) {
        spinner.fail('Failed to import variable collections');
        console.error(error.message);
        process.exit(1);
      }
      console.log();
      console.log(chalk.cyan('─── figmachat context (drop into /design) ───'));
      console.log(summarizeForLLM(parsed));
      console.log(chalk.cyan('──────────────────────────────────────────────'));
      return;
    }

    const tokensData = toTokensImportJson(parsed);
    const collectionName = options.collection || parsed.meta.source || 'Imported Design System';
    const colorCount = Object.keys(tokensData.color || {}).length;
    const radiusCount = Object.keys(tokensData.radius || {}).length;
    const typoCount = Object.keys(tokensData.typography || {}).length;

    const spinner = ora(`Importing ${colorCount} colors, ${radiusCount} radii, ${typoCount} type styles from ${file}...`).start();

    const code = `(async () => {
const data = ${JSON.stringify({ ...tokensData.color, _radii: tokensData.radius })};
const collectionName = ${JSON.stringify(collectionName)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;

// Colors. Skip-check scoped to the TARGET collection so multiple design
// systems can coexist with overlapping token names (Airbnb's primary AND
// Cursor's primary, switchable via "Apply variable mode" in Figma).
for (const [name, entry] of Object.entries(data)) {
  if (name === '_radii') continue;
  const value = entry?.value ?? entry;
  const rgb = typeof value === 'string' ? hexToRgb(value) : null;
  if (!rgb) continue;
  if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
  try {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(modeId, rgb);
    count++;
  } catch (e) {}
}
// Radii
if (data._radii) {
  for (const [name, entry] of Object.entries(data._radii)) {
    const num = typeof entry === 'object' ? entry.value : entry;
    if (typeof num !== 'number') continue;
    if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
    try {
      const v = figma.variables.createVariable(name, col, 'FLOAT');
      v.setValueForMode(modeId, num);
      count++;
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = await daemonExec('eval', { code });
      spinner.succeed(result || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
      process.exit(1);
    }

    console.log();
    console.log(chalk.cyan('─── figmachat context (drop into /design) ───'));
    console.log(summarizeForLLM(parsed));
    console.log(chalk.cyan('──────────────────────────────────────────────'));
  });

tokens
  .command('ds')
  .description('Create IDS Base Design System (complete starter kit)')
  .action(async () => {
    checkConnection();

    console.log(chalk.cyan('\n  IDS Base Design System'));
    console.log(chalk.gray('  by Into Design Systems\n'));

    // IDS Base values
    const idsColors = {
      gray: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
      primary: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      accent: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' }
    };

    const idsSemanticColors = {
      'background/default': '#ffffff',
      'background/muted': '#f4f4f5',
      'background/emphasis': '#18181b',
      'foreground/default': '#18181b',
      'foreground/muted': '#71717a',
      'foreground/emphasis': '#ffffff',
      'border/default': '#e4e4e7',
      'border/focus': '#3b82f6',
      'action/primary': '#3b82f6',
      'action/primary-hover': '#2563eb',
      'feedback/success': '#22c55e',
      'feedback/success-muted': '#dcfce7',
      'feedback/warning': '#f59e0b',
      'feedback/warning-muted': '#fef3c7',
      'feedback/error': '#ef4444',
      'feedback/error-muted': '#fee2e2'
    };

    const idsSpacing = {
      'xs': 4, 'sm': 8, 'md': 16, 'lg': 24, 'xl': 32, '2xl': 48, '3xl': 64
    };

    const idsTypography = {
      'size/xs': 12, 'size/sm': 14, 'size/base': 16, 'size/lg': 18,
      'size/xl': 20, 'size/2xl': 24, 'size/3xl': 30, 'size/4xl': 36,
      'weight/normal': 400, 'weight/medium': 500, 'weight/semibold': 600, 'weight/bold': 700
    };

    const idsRadii = {
      'none': 0, 'sm': 4, 'md': 8, 'lg': 12, 'xl': 16, 'full': 9999
    };

    // Create Color - Primitives
    let spinner = ora('Creating Color - Primitives...').start();
    const primitivesCode = `(async () => {
const colors = ${JSON.stringify(idsColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Color - Primitives');
if (!col) col = figma.variables.createVariableCollection('Color - Primitives');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [colorName, shades] of Object.entries(colors)) {
  for (const [shade, hex] of Object.entries(shades)) {
    const existing = existingVars.find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${primitivesCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Primitives (${result?.trim() || '33'} variables)`);
    } catch { spinner.fail('Color - Primitives failed'); }

    // Create Color - Semantic
    spinner = ora('Creating Color - Semantic...').start();
    const semanticCode = `(async () => {
const colors = ${JSON.stringify(idsSemanticColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Color - Semantic');
if (!col) col = figma.variables.createVariableCollection('Color - Semantic');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, hex] of Object.entries(colors)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(modeId, hexToRgb(hex));
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${semanticCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Semantic (${result?.trim() || '13'} variables)`);
    } catch { spinner.fail('Color - Semantic failed'); }

    // Create Spacing
    spinner = ora('Creating Spacing...').start();
    const spacingCode = `(async () => {
const spacings = ${JSON.stringify(idsSpacing)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Spacing');
if (!col) col = figma.variables.createVariableCollection('Spacing');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(spacings)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${spacingCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Spacing (${result?.trim() || '7'} variables)`);
    } catch { spinner.fail('Spacing failed'); }

    // Create Typography
    spinner = ora('Creating Typography...').start();
    const typographyCode = `(async () => {
const typography = ${JSON.stringify(idsTypography)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Typography');
if (!col) col = figma.variables.createVariableCollection('Typography');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(typography)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${typographyCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Typography (${result?.trim() || '12'} variables)`);
    } catch { spinner.fail('Typography failed'); }

    // Create Border Radii
    spinner = ora('Creating Border Radii...').start();
    const radiiCode = `(async () => {
const radii = ${JSON.stringify(idsRadii)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === 'Border Radii');
if (!col) col = figma.variables.createVariableCollection('Border Radii');
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(radii)) {
  const existing = existingVars.find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return count;
})()`;
    try {
      const result = figmaUse(`eval "${radiiCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Border Radii (${result?.trim() || '6'} variables)`);
    } catch { spinner.fail('Border Radii failed'); }

    // Small delay to let spinner render
    await new Promise(r => setTimeout(r, 100));

    // Summary
    console.log(chalk.green('\n  ✓ IDS Base Design System created!\n'));
    console.log(chalk.white('  Collections:'));
    console.log(chalk.gray('    • Color - Primitives (gray, primary, accent)'));
    console.log(chalk.gray('    • Color - Semantic (background, foreground, border, action, feedback)'));
    console.log(chalk.gray('    • Spacing (xs to 3xl, 4px base)'));
    console.log(chalk.gray('    • Typography (sizes + weights)'));
    console.log(chalk.gray('    • Border Radii (none to full)'));
    console.log();
    console.log(chalk.gray('  Total: ~74 variables across 5 collections\n'));
    console.log(chalk.gray('  Next: ') + chalk.cyan('figma-ds-cli tokens components') + chalk.gray(' to add UI components\n'));
  });

tokens
  .command('components')
  .description('Create IDS Base Components (Button, Input, Card, Badge)')
  .action(async () => {
    checkConnection();

    console.log(chalk.cyan('\n  IDS Base Components'));
    console.log(chalk.gray('  by Into Design Systems\n'));

    // Component colors (using IDS Base values)
    const colors = {
      primary500: '#3b82f6',
      primary600: '#2563eb',
      gray100: '#f4f4f5',
      gray200: '#e4e4e7',
      gray500: '#71717a',
      gray900: '#18181b',
      white: '#ffffff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444'
    };

    // First, clean up any existing IDS components
    let spinner = ora('Cleaning up existing components...').start();
    const cleanupCode = `
const names = ['Button / Primary', 'Button / Secondary', 'Button / Outline', 'Input', 'Card', 'Badge / Default', 'Badge / Success', 'Badge / Warning', 'Badge / Error'];
let removed = 0;
figma.currentPage.children.forEach(n => {
  if (names.includes(n.name)) { n.remove(); removed++; }
});
removed
`;
    try {
      const removed = figmaUse(`eval "${cleanupCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Cleaned up ${removed?.trim() || '0'} old elements`);
    } catch { spinner.succeed('Ready'); }

    // Step 1: Create frames using JSX render (handles fonts)
    spinner = ora('Creating frames...').start();
    const jsxComponents = [
      { jsx: `<Frame name="Button / Primary" bg="${colors.primary500}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="#ffffff">Button</Text></Frame>` },
      { jsx: `<Frame name="Button / Secondary" bg="${colors.gray100}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="${colors.gray900}">Button</Text></Frame>` },
      { jsx: `<Frame name="Button / Outline" bg="#ffffff" stroke="${colors.gray200}" px={16} py={10} rounded={8} flex="row"><Text size={14} weight="semibold" color="${colors.gray900}">Button</Text></Frame>` },
      { jsx: `<Frame name="Input" w={200} bg="#ffffff" stroke="${colors.gray200}" px={12} py={10} rounded={8} flex="row"><Text size={14} color="${colors.gray500}">Placeholder</Text></Frame>` },
      { jsx: `<Frame name="Card" bg="#ffffff" stroke="${colors.gray200}" p={24} rounded={12} flex="col" gap={8}><Text size={18} weight="semibold" color="${colors.gray900}">Card Title</Text><Text size={14} color="${colors.gray500}">Card description goes here.</Text></Frame>` },
      { jsx: `<Frame name="Badge / Default" bg="${colors.gray100}" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="${colors.gray900}">Badge</Text></Frame>` },
      { jsx: `<Frame name="Badge / Success" bg="#dcfce7" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#166534">Success</Text></Frame>` },
      { jsx: `<Frame name="Badge / Warning" bg="#fef3c7" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#92400e">Warning</Text></Frame>` },
      { jsx: `<Frame name="Badge / Error" bg="#fee2e2" px={10} py={4} rounded={9999} flex="row"><Text size={12} weight="medium" color="#991b1b">Error</Text></Frame>` }
    ];

    try {
      const client = await getFigmaClient();
      for (const { jsx } of jsxComponents) {
        await client.render(jsx);
      }
      spinner.succeed('9 frames created');
    } catch (e) { spinner.fail('Frame creation failed: ' + e.message); }

    // Step 2: Convert to components one by one with positioning
    spinner = ora('Converting to components...').start();

    const componentOrder = [
      { name: 'Button / Primary', row: 0, width: 80, varFill: 'action/primary' },
      { name: 'Button / Secondary', row: 0, width: 80, varFill: 'background/muted' },
      { name: 'Button / Outline', row: 0, width: 80, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Input', row: 0, width: 200, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Card', row: 0, width: 240, varFill: 'background/default', varStroke: 'border/default' },
      { name: 'Badge / Default', row: 1, width: 60, varFill: 'background/muted' },
      { name: 'Badge / Success', row: 1, width: 70, varFill: 'feedback/success-muted' },
      { name: 'Badge / Warning', row: 1, width: 70, varFill: 'feedback/warning-muted' },
      { name: 'Badge / Error', row: 1, width: 50, varFill: 'feedback/error-muted' }
    ];

    let row0X = 0, row1X = 0;
    const gap = 32;

    for (const comp of componentOrder) {
      const convertSingle = `
const f = figma.currentPage.children.find(n => n.name === ${JSON.stringify(comp.name)} && n.type === 'FRAME');
if (f) {
  const vars = figma.variables.getLocalVariables();
  const findVar = (name) => vars.find(v => v.name === name);
  ${comp.varFill ? `
  const vFill = findVar(${JSON.stringify(comp.varFill)});
  if (vFill && f.fills && f.fills.length > 0) {
    const fills = JSON.parse(JSON.stringify(f.fills));
    fills[0] = figma.variables.setBoundVariableForPaint(fills[0], 'color', vFill);
    f.fills = fills;
  }` : ''}
  ${comp.varStroke ? `
  const vStroke = findVar(${JSON.stringify(comp.varStroke)});
  if (vStroke && f.strokes && f.strokes.length > 0) {
    const strokes = JSON.parse(JSON.stringify(f.strokes));
    strokes[0] = figma.variables.setBoundVariableForPaint(strokes[0], 'color', vStroke);
    f.strokes = strokes;
  }` : ''}
  const c = figma.createComponentFromNode(f);
  c.x = ${comp.row === 0 ? row0X : row1X};
  c.y = ${comp.row === 0 ? 0 : 80};
}
`;
      try {
        figmaUse(`eval "${convertSingle.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
        if (comp.row === 0) row0X += comp.width + gap;
        else row1X += comp.width + 24;
      } catch {}
    }
    spinner.succeed('9 components with variables');

    await new Promise(r => setTimeout(r, 100));

    console.log(chalk.green('\n  ✓ IDS Base Components created!\n'));
    console.log(chalk.white('  Components:'));
    console.log(chalk.gray('    • Button (Primary, Secondary, Outline)'));
    console.log(chalk.gray('    • Input'));
    console.log(chalk.gray('    • Card'));
    console.log(chalk.gray('    • Badge (Default, Success, Warning, Error)'));
    console.log();
    console.log(chalk.gray('  Total: 9 components on canvas\n'));
  });

tokens
  .command('add <name> <value>')
  .description('Add a single token')
  .option('-c, --collection <name>', 'Collection name', 'Tokens')
  .option('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN (auto-detected if not set)')
  .action((name, value, options) => {
    checkConnection();

    const code = `(async () => {
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const value = ${JSON.stringify(value)};
let type = '${options.type || ''}';
if (!type) {
  if (value.startsWith('#')) type = 'COLOR';
  else if (!isNaN(parseFloat(value))) type = 'FLOAT';
  else if (value === 'true' || value === 'false') type = 'BOOLEAN';
  else type = 'STRING';
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;

const v = figma.variables.createVariable(${JSON.stringify(name)}, col, type);
let figmaValue = value;
if (type === 'COLOR') figmaValue = hexToRgb(value);
else if (type === 'FLOAT') figmaValue = parseFloat(value);
else if (type === 'BOOLEAN') figmaValue = value === 'true';
v.setValueForMode(modeId, figmaValue);

return 'Created ' + type.toLowerCase() + ' token: ${name}';
})()`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      console.log(chalk.green(result?.trim() || `✓ Created token: ${name}`));
    } catch (error) {
      console.log(chalk.red(`✗ Failed to create token: ${name}`));
    }
  });

