/**
 * Figma Plugin API documentation lookup.
 *
 * Reads from docs/figma-api/ (cloned via `figma-cli api setup`).
 * Source: https://github.com/iamtekeste/figma (Figma Plugin API as markdown)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, '..', 'docs', 'figma-api');
const REPO = 'https://github.com/iamtekeste/figma.git';

function isInstalled() {
  return fs.existsSync(path.join(DOCS_DIR, 'interfaces'));
}

export async function setup() {
  if (isInstalled()) {
    console.log('✓ API docs already installed at docs/figma-api/');
    return;
  }
  console.log('→ cloning Figma API docs (~5 MB) into docs/figma-api/');
  fs.mkdirSync(path.dirname(DOCS_DIR), { recursive: true });
  try {
    execSync(`git clone --depth 1 ${REPO} "${DOCS_DIR}"`, { stdio: 'inherit' });
    console.log('✓ done. Try: figma-cli api Frame');
  } catch (e) {
    console.error('✗ clone failed:', e.message);
    process.exit(1);
  }
}

function listAll() {
  if (!isInstalled()) return null;
  const interfaces = fs.readdirSync(path.join(DOCS_DIR, 'interfaces'))
    .filter(f => f.endsWith('.md'))
    .map(f => ({ kind: 'interface', name: f.replace(/\.md$/, ''), file: path.join(DOCS_DIR, 'interfaces', f) }));
  const aliases = fs.readdirSync(path.join(DOCS_DIR, 'type-aliases'))
    .filter(f => f.endsWith('.md'))
    .map(f => ({ kind: 'type', name: f.replace(/\.md$/, ''), file: path.join(DOCS_DIR, 'type-aliases', f) }));
  return [...interfaces, ...aliases];
}

export function list(filter) {
  const all = listAll();
  if (!all) {
    console.error('✗ docs not installed. Run: figma-cli api setup');
    process.exit(1);
  }
  const items = filter
    ? all.filter(i => i.name.toLowerCase().includes(filter.toLowerCase()))
    : all;
  if (items.length === 0) {
    console.log(`No matches for "${filter}".`);
    return;
  }
  for (const i of items) {
    console.log(`${i.kind.padEnd(10)} ${i.name}`);
  }
  console.log(`\n${items.length} result(s)`);
}

function score(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 100 + (q.length / n.length) * 50;
  if (n.includes(q)) return 50 + (q.length / n.length) * 25;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? i : 0;
}

export function show(query) {
  const all = listAll();
  if (!all) {
    console.error('✗ docs not installed. Run: figma-cli api setup');
    process.exit(1);
  }
  if (!query) {
    console.error('Usage: figma-cli api <name>   (e.g. figma-cli api FrameNode)');
    process.exit(1);
  }
  const ranked = all
    .map(i => ({ ...i, s: score(i.name, query) }))
    .filter(i => i.s > 0)
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 0) {
    console.log(`No interface or type matching "${query}".`);
    console.log('Try: figma-cli api list ' + query);
    return;
  }
  const top = ranked[0];
  if (ranked.length > 1 && top.s < 100) {
    console.log(`Top matches for "${query}":`);
    for (const r of ranked.slice(0, 8)) {
      console.log(`  ${r.kind.padEnd(10)} ${r.name}`);
    }
    console.log(`\nUse: figma-cli api <exact-name>`);
    return;
  }
  console.log(fs.readFileSync(top.file, 'utf-8'));
}

/**
 * Try to extract a Figma API name from a runtime error message,
 * then call suggest() if the docs are installed.
 * Returns true if a useful suggestion was emitted, false otherwise.
 *
 * Recognized patterns:
 *   "TypeError: <obj>.<name> is not a function"     -> name
 *   "Property \"<name>\" failed validation"          -> name
 *   "Error: in <name>: ..."                          -> name
 *   "Cannot read properties of undefined (reading '<name>')" -> name
 */
export function suggestFromError(message) {
  if (!message || typeof message !== 'string') return false;
  const candidates = [];
  let m;
  // Match the last identifier before "is not a function" (e.g. "figma.createImage" -> "createImage")
  if ((m = message.match(/([a-zA-Z][a-zA-Z0-9_]+)\s+is not a function/))) candidates.push(m[1]);
  if ((m = message.match(/Property\s+"([a-zA-Z][a-zA-Z0-9_.#]+)"\s+failed validation/))) {
    // "node.addComponentProperty.options" -> "addComponentProperty"
    const last = m[1].split('.').pop();
    candidates.push(last);
  }
  if ((m = message.match(/Error:\s+in\s+([a-zA-Z][a-zA-Z0-9_]+)/))) candidates.push(m[1]);
  if ((m = message.match(/Cannot read propert(?:y|ies)\s+(?:of undefined\s+\(reading\s+)?'?([a-zA-Z][a-zA-Z0-9_]+)'?/))) candidates.push(m[1]);
  // Strip "set_"/"get_" prefixes Figma adds to setters
  const cleaned = candidates.map(c => c.replace(/^(set_|get_)/, ''));
  // Filter out generic JS terms
  const skip = new Set(['undefined', 'null', 'object', 'function', 'string', 'number', 'array', 'true', 'false', 'foo', 'bar', 'baz', 'something', 'value', 'data', 'item']);
  // Need at least 5 chars to be likely a real API name (avoids "foo", "id", etc.)
  const useful = [...new Set(cleaned)].filter(c => c.length >= 5 && !skip.has(c.toLowerCase()));
  if (useful.length === 0) return false;

  if (!isInstalled()) return false;

  // Search both: interface names (fast, fuzzy) AND interface contents (for method/property names)
  const all = listAll() || [];
  const hits = new Map(); // name -> { name, kind, file, score, matchedTerm }

  for (const term of useful) {
    // 1. Name-based fuzzy match
    for (const i of all) {
      const s = score(i.name, term);
      if (s > 0) {
        const ex = hits.get(i.name);
        if (!ex || s > ex.score) hits.set(i.name, { ...i, score: s, matchedTerm: term, source: 'name' });
      }
    }
    // 2. Content search: which files contain this term?
    // Higher score if term appears as a heading (### term) — that's where it's DEFINED.
    const headingRe = new RegExp(`^#{2,4}\\s+${term}\\b`, 'm');
    const wordRe = new RegExp(`\\b${term}\\b`);
    for (const i of all) {
      if (hits.has(i.name) && hits.get(i.name).source === 'name') continue;
      try {
        const content = fs.readFileSync(i.file, 'utf-8');
        let s = 0;
        if (headingRe.test(content)) {
          // Defined here — high score
          s = 80;
        } else if (wordRe.test(content)) {
          // Just mentioned — low score
          s = i.kind === 'interface' ? 25 : 15;
        }
        if (s > 0) {
          const ex = hits.get(i.name);
          if (!ex || s > ex.score) hits.set(i.name, { ...i, score: s, matchedTerm: term, source: s >= 80 ? 'definition' : 'mention' });
        }
      } catch { /* skip unreadable */ }
    }
  }

  const top = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  if (top.length === 0) return false;

  console.error('\n  💡 Looks like this might map to a Figma Plugin API. Try:');
  for (const r of top) {
    let tag = '';
    if (r.source === 'definition') tag = ` (defines "${r.matchedTerm}")`;
    else if (r.source === 'mention') tag = ` (mentions "${r.matchedTerm}")`;
    console.error(`    figma-cli api ${r.name}${tag}`);
  }
  return true;
}

/**
 * Suggest API interfaces/types when user types an unknown command.
 * Hint without crashing if docs not installed.
 */
export function suggest(query) {
  if (!query) return;
  const all = listAll();
  if (!all) {
    console.error('  → run `figma-cli --help` to see available commands');
    console.error('  → or `figma-cli api setup` to enable offline Figma API lookup');
    return;
  }
  const ranked = all
    .map(i => ({ ...i, s: score(i.name, query) }))
    .filter(i => i.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (ranked.length === 0) {
    console.error('  → run `figma-cli --help` to see available commands');
    return;
  }
  console.error('  Did you mean one of these Figma Plugin API references?');
  for (const r of ranked) {
    console.error(`    figma-cli api ${r.name}`);
  }
  console.error('  Or run `figma-cli --help` for actual CLI commands.');
}

export function gap() {
  const all = listAll();
  if (!all) {
    console.error('✗ docs not installed. Run: figma-cli api setup');
    process.exit(1);
  }
  // Read figma-cli's main entry and check which Figma API names appear used vs. defined
  const indexJs = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
  const clientJs = fs.readFileSync(path.join(__dirname, 'figma-client.js'), 'utf-8');
  const usage = indexJs + clientJs;

  const interesting = all.filter(i => {
    const n = i.name;
    if (n.length < 4) return false;
    if (n.startsWith('Default')) return false;
    if (n.startsWith('Base')) return false;
    if (n.endsWith('Mixin')) return false;
    return true;
  });

  const referenced = [];
  const missing = [];
  for (const i of interesting) {
    const re = new RegExp(`\\b${i.name}\\b`);
    if (re.test(usage)) {
      referenced.push(i);
    } else {
      missing.push(i);
    }
  }

  // Group missing by likely category
  const groups = {
    figjam: [],
    slides: [],
    annotations: [],
    devmode: [],
    plugin_runtime: [],
    nodes: [],
    styles_effects: [],
    other: [],
  };
  for (const i of missing) {
    const n = i.name.toLowerCase();
    if (/sticky|connector|shapewithtext|stamp|widget|figjam|table/i.test(i.name)) groups.figjam.push(i);
    else if (/slide/i.test(i.name)) groups.slides.push(i);
    else if (/annotation/i.test(i.name)) groups.annotations.push(i);
    else if (/dev.*resource|codegen|measurement|status/i.test(i.name)) groups.devmode.push(i);
    else if (/plugin|param|relaunch|message|argfreedata/i.test(i.name)) groups.plugin_runtime.push(i);
    else if (/node$|component|frame|section/i.test(i.name)) groups.nodes.push(i);
    else if (/effect|fill|stroke|gradient|paint|style/i.test(i.name)) groups.styles_effects.push(i);
    else groups.other.push(i);
  }

  console.log(`Figma Plugin API: ${all.length} total (${interesting.length} interesting)\n`);
  console.log(`✓ Referenced in figma-cli: ${referenced.length}`);
  console.log(`✗ NOT referenced (potential gap): ${missing.length}\n`);

  console.log('=== Missing capabilities (grouped) ===\n');
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    console.log(`${cat.toUpperCase()} (${items.length}):`);
    for (const i of items.slice(0, 12)) {
      console.log(`  - ${i.name}`);
    }
    if (items.length > 12) console.log(`  …and ${items.length - 12} more`);
    console.log();
  }

  console.log('Tip: figma-cli api <Name>   to read the full spec for any of these.');
}
