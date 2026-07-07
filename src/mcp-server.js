#!/usr/bin/env node
/**
 * figma-cli MCP server — exposes figma-cli commands as MCP tools so Claude
 * can drive Figma from any project without a shell.
 *
 * Add to ~/.claude/settings.json mcpServers:
 *   "figma-cli": { "command": "node", "args": ["/home/alauxui/figma-cli-nixos/src/mcp-server.js"] }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dir, 'index.js');
const NODE = process.execPath;

async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [CLI, ...args], {
      timeout: opts.timeout ?? 30_000,
      env: { ...process.env },
    });
    return (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
  } catch (err) {
    return `ERROR: ${err.message}\n${err.stderr ?? ''}`.trim();
  }
}

const server = new McpServer({
  name: 'figma-cli',
  version: '2.1.0',
});

// ── render ──────────────────────────────────────────────────────────────────
server.tool(
  'figma_render',
  'Render a JSX frame on the Figma canvas. Use this to create any visual element.',
  {
    jsx: z.string().describe('JSX string, e.g. "<Frame bg=\\"#fff\\" p={24}><Text>Hello</Text></Frame>"'),
    name: z.string().optional().describe('Node name override'),
    verify: z.boolean().optional().describe('Screenshot after creation'),
    collection: z.string().optional().describe('Variable collection name to resolve var: tokens against'),
  },
  async ({ jsx, name, verify, collection }) => {
    const args = ['render', jsx];
    if (name) args.push('--name', name);
    if (verify) args.push('--verify');
    if (collection) args.push('--collection', collection);
    return { content: [{ type: 'text', text: await run(args) }] };
  }
);

// ── render-batch ─────────────────────────────────────────────────────────────
server.tool(
  'figma_render_batch',
  'Render multiple independent JSX frames side-by-side. Pass an array of JSX strings.',
  {
    items: z.array(z.string()).describe('Array of JSX strings, one per frame'),
    direction: z.enum(['row', 'col']).optional().describe('Layout direction (default: row)'),
    gap: z.number().optional().describe('Gap between frames in px'),
    collection: z.string().optional().describe('Variable collection to resolve var: tokens'),
  },
  async ({ items, direction, gap, collection }) => {
    const args = ['render-batch', JSON.stringify(items)];
    if (direction) args.push('--direction', direction);
    if (gap != null) args.push('--gap', String(gap));
    if (collection) args.push('--collection', collection);
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

// ── verify ────────────────────────────────────────────────────────────────────
server.tool(
  'figma_verify',
  'Screenshot a node for visual validation. Returns saved PNG path + dimensions.',
  {
    nodeId: z.string().optional().describe('Node ID to screenshot (omit = current selection)'),
    measure: z.boolean().optional().describe('Include real w/h measure tree'),
  },
  async ({ nodeId, measure }) => {
    const args = ['verify', ...(nodeId ? [nodeId] : [])];
    if (measure) args.push('--measure');
    return { content: [{ type: 'text', text: await run(args) }] };
  }
);

// ── var list ──────────────────────────────────────────────────────────────────
server.tool(
  'figma_var_list',
  'List all Figma variables/tokens in the current file.',
  {
    collection: z.string().optional().describe('Filter by collection name'),
  },
  async ({ collection }) => {
    const args = ['var', 'list', ...(collection ? [collection] : [])];
    return { content: [{ type: 'text', text: await run(args) }] };
  }
);

// ── tokens preset ─────────────────────────────────────────────────────────────
server.tool(
  'figma_tokens_preset',
  'Load a design token preset into Figma variables.',
  {
    preset: z.enum(['shadcn', 'tailwind', 'ds']).describe('Preset to load'),
  },
  async ({ preset }) => {
    return { content: [{ type: 'text', text: await run(['tokens', 'preset', preset], { timeout: 60_000 }) }] };
  }
);

// ── canvas info ───────────────────────────────────────────────────────────────
server.tool(
  'figma_canvas_info',
  'Show what is currently on the Figma canvas.',
  {},
  async () => {
    return { content: [{ type: 'text', text: await run(['canvas', 'info']) }] };
  }
);

// ── find ──────────────────────────────────────────────────────────────────────
server.tool(
  'figma_find',
  'Find nodes by name on the canvas.',
  {
    query: z.string().describe('Node name (or partial) to search for'),
  },
  async ({ query }) => {
    return { content: [{ type: 'text', text: await run(['find', query]) }] };
  }
);

// ── node to-component ────────────────────────────────────────────────────────
server.tool(
  'figma_to_component',
  'Convert a frame/node to a Figma component.',
  {
    nodeId: z.string().describe('Node ID to convert'),
  },
  async ({ nodeId }) => {
    return { content: [{ type: 'text', text: await run(['node', 'to-component', nodeId]) }] };
  }
);

// ── instantiate ───────────────────────────────────────────────────────────────
server.tool(
  'figma_instantiate',
  'Drop an instance of an existing component by name (reuse before rebuild).',
  {
    name: z.string().describe('Component name to instantiate'),
  },
  async ({ name }) => {
    return { content: [{ type: 'text', text: await run(['instantiate', name]) }] };
  }
);

// ── spec ──────────────────────────────────────────────────────────────────────
server.tool(
  'figma_spec',
  'Show the spec (variant axes, values, sample size) for a component from DESIGN.md.',
  {
    name: z.string().describe('Component name'),
    check: z.string().optional().describe('Node ID to enforce spec against (exits non-zero on mismatch)'),
  },
  async ({ name, check }) => {
    const args = ['spec', name, ...(check ? ['--check', check] : [])];
    return { content: [{ type: 'text', text: await run(args) }] };
  }
);

// ── extract ───────────────────────────────────────────────────────────────────
server.tool(
  'figma_extract',
  'Export the open Figma file as a DESIGN.md markdown document.',
  {
    output: z.string().optional().describe('Output file path (default: DESIGN.md)'),
    pages: z.string().optional().describe('Comma-separated page names to include'),
    sections: z.string().optional().describe('Only export specific sections, e.g. "tokens"'),
    selection: z.boolean().optional().describe('Only extract selected nodes'),
  },
  async ({ output, pages, sections, selection }) => {
    const args = ['extract', ...(output ? [output] : [])];
    if (pages) args.push('--pages', pages);
    if (sections) args.push('--sections', sections);
    if (selection) args.push('--selection');
    return { content: [{ type: 'text', text: await run(args, { timeout: 120_000 }) }] };
  }
);

// ── import ────────────────────────────────────────────────────────────────────
server.tool(
  'figma_import',
  'Import design tokens from a file (tailwind.config.js, globals.css, tokens.json, DESIGN.md) or Storybook URL into Figma.',
  {
    source: z.string().describe('File path or URL to import from'),
    collection: z.string().optional().describe('Variable collection name'),
    type: z.string().optional().describe('Override detection: tailwind | css | tokens | storybook | designmd'),
  },
  async ({ source, collection, type }) => {
    const args = ['import', source];
    if (collection) args.push('--collection', collection);
    if (type) args.push('--type', type);
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

// ── export ────────────────────────────────────────────────────────────────────
server.tool(
  'figma_export',
  'Export design tokens or assets from Figma (formats: png, svg, dtcg, css, tailwind).',
  {
    format: z.string().describe('Export format: png | svg | dtcg | css | tailwind'),
    output: z.string().optional().describe('Output file path'),
  },
  async ({ format, output }) => {
    const args = ['export', format, ...(output ? [output] : [])];
    return { content: [{ type: 'text', text: await run(args, { timeout: 30_000 }) }] };
  }
);

// ── blocks ────────────────────────────────────────────────────────────────────
server.tool(
  'figma_blocks',
  'Create or list pre-built UI layout blocks (dashboards, etc.).',
  {
    action: z.enum(['list', 'create']).describe('"list" to see available blocks, "create" to add one'),
    block: z.string().optional().describe('Block name to create, e.g. "dashboard-01"'),
  },
  async ({ action, block }) => {
    const args = ['blocks', action, ...(block ? [block] : [])];
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

// ── shadcn add ────────────────────────────────────────────────────────────────
server.tool(
  'figma_shadcn_add',
  'Add shadcn UI components to the Figma canvas.',
  {
    component: z.string().describe('Component name: button | card | badge | input | etc.'),
    count: z.number().optional().describe('Number of distinct variants to create'),
  },
  async ({ component, count }) => {
    const args = ['shadcn', 'add', component];
    if (count != null) args.push('--count', String(count));
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

// ── a11y ──────────────────────────────────────────────────────────────────────
server.tool(
  'figma_a11y',
  'Run accessibility checks on the Figma canvas.',
  {
    check: z.enum(['contrast', 'vision', 'touch', 'text', 'audit']).describe('Check type'),
  },
  async ({ check }) => {
    return { content: [{ type: 'text', text: await run(['a11y', check]) }] };
  }
);

// ── undo ──────────────────────────────────────────────────────────────────────
server.tool(
  'figma_undo',
  'Undo the last Figma operation.',
  {},
  async () => {
    return { content: [{ type: 'text', text: await run(['undo']) }] };
  }
);

// ── gradient ─────────────────────────────────────────────────────────────────
server.tool(
  'figma_gradient',
  'Create or extract mesh/aurora gradient backgrounds.',
  {
    colors: z.string().describe('Comma-separated hex colors, e.g. "#a855f7,#3b82f6,#06b6d4"'),
    size: z.string().optional().describe('Canvas size, e.g. "1920x1080"'),
    applyTo: z.string().optional().describe('Node ID to apply gradient to'),
    mode: z.string().optional().describe('Gradient mode: mesh | aurora'),
    style: z.string().optional().describe('Composition style: auto | scatter | diagonal | etc.'),
    grain: z.boolean().optional().describe('Add film grain noise'),
  },
  async ({ colors, size, applyTo, mode, style, grain }) => {
    const args = ['gradient', 'mesh', colors];
    if (size) args.push('--size', size);
    if (applyTo) args.push('--apply-to', applyTo);
    if (mode) args.push('--mode', mode);
    if (style) args.push('--style', style);
    if (grain) args.push('--grain');
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

// ── variants from ─────────────────────────────────────────────────────────────
server.tool(
  'figma_variants_from',
  'Combine existing frames or components into a Figma Component Set (variant set).',
  {
    nodeIds: z.string().describe('Comma-separated node IDs to combine'),
    property: z.string().describe('Variant property name, e.g. "Size"'),
    values: z.string().describe('Comma-separated values matching node order, e.g. "Small,Medium,Large"'),
    name: z.string().describe('Component Set name'),
  },
  async ({ nodeIds, property, values, name }) => {
    const args = ['variants', 'from', nodeIds, '--property', property, '--values', values, '--name', name];
    return { content: [{ type: 'text', text: await run(args, { timeout: 30_000 }) }] };
  }
);

// ── daemon ────────────────────────────────────────────────────────────────────
server.tool(
  'figma_daemon',
  'Check or restart the figma-cli daemon.',
  {
    action: z.enum(['status', 'restart']).describe('"status" or "restart"'),
  },
  async ({ action }) => {
    return { content: [{ type: 'text', text: await run(['daemon', action]) }] };
  }
);

// ── connect ───────────────────────────────────────────────────────────────────
server.tool(
  'figma_connect',
  'Connect to Figma (Yolo mode patches Figma once for full access; safe mode uses the plugin).',
  {
    safe: z.boolean().optional().describe('Use safe/plugin mode instead of Yolo'),
  },
  async ({ safe }) => {
    const args = ['connect', ...(safe ? ['--safe'] : [])];
    return { content: [{ type: 'text', text: await run(args, { timeout: 60_000 }) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
