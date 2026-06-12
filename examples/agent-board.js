#!/usr/bin/env node
/**
 * Agent Board — a Figma kanban that humans AND agents operate together.
 *
 * Humans drag cards between columns like any kanban. Dragging a card into
 * the "Agent Queue" column delegates it: a watcher detects the drop, spawns
 * a real `claude -p` agent that executes the task via figma-cli, and moves
 * the card through In Progress to Done.
 *
 * Usage:
 *   node examples/agent-board.js create            Build the board in Figma
 *   node examples/agent-board.js watch             Watch the Agent Queue (Ctrl-C to stop)
 *   node examples/agent-board.js watch --once      Single poll cycle (testing)
 *   node examples/agent-board.js delegate <id>     Move a card into the queue via CLI
 *
 * Env:
 *   AGENT_CMD   Override the agent command (default: claude -p ...). The
 *               command runs via `sh -c` with TASK_TITLE/TASK_DESC env vars.
 */

import { spawnSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'index.js');
const BOARD = 'Comment Tracker';
const POLL_MS = 4000;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Demo data — simulated Figma comments (REST API hookup is a later step)
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'core-tokens', col: 'todo', tag: 'bg tokens · 10:1625',
    title: 'Ship 6 core tokens, or all 19?',
    desc: 'Sil + Philipp: mark 6 as core, hide the rest. Devs should not scan 19 surfaces for a card.',
    assignee: 'Sil',
  },
  {
    id: 'disabled-states', col: 'todo', tag: 'fg tokens · 10:1645',
    title: 'Are disabled states covered?',
    desc: 'No fg/disabled token defined, so it will get hardcoded per component. Define one and show it on a sample button.',
    assignee: 'Philipp',
  },
  {
    id: 'naming', col: 'todo', tag: 'naming · 10:1610',
    title: 'Align Figma names to the codebase',
    desc: 'Code is bg-surface-default, Figma says background/surface. Pick one convention before handoff.',
    assignee: 'Andressa',
  },
  {
    id: 'contrast', col: 'todo', tag: 'contrast · 10:1687',
    title: 'Re-test contrast on bg/elevated',
    desc: 'Pairings were only checked against white. Build a small swatch sheet of the elevated surface text pairings and flag any that fail AA.',
    assignee: null,
  },
  {
    id: 'button-variants', col: 'inprogress', tag: 'components · 10:1701',
    title: 'Primary button: hover + disabled variants',
    desc: 'Create the primary button with default, hover and disabled variants using the shadcn variables.',
    assignee: 'Sil',
  },
  {
    id: 'purple-lock', col: 'done', tag: 'color · 10:1480',
    title: 'Base purple locked to #36278B',
    desc: 'Debated 9179EA vs 36278B. Chose the darker one for AA contrast on white.',
    assignee: 'Philipp',
  },
];

const COLUMNS = [
  { key: 'todo', label: 'To do', dot: '#f59e0b' },
  { key: 'agent', label: 'Agent Queue', dot: '#8b5cf6' },
  { key: 'inprogress', label: 'In Progress', dot: '#3b82f6' },
  { key: 'done', label: 'Done', dot: '#22c55e' },
];

// ---------------------------------------------------------------------------
// figma-cli helpers
// ---------------------------------------------------------------------------

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

const tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-board-'));
let evalCount = 0;

/** Run code in Figma via `figma-cli eval --file`, parse the JSON result. */
function figmaEval(code) {
  const file = path.join(tmpDir, `eval-${evalCount++}.js`);
  // Explicit async IIFE: the daemon's auto-wrap heuristic misses code where
  // `return` only appears inside if-statements, breaking top-level await.
  writeFileSync(file, `(async () => {\n${code}\n})()`);
  const res = cli(['eval', '--file', file]);
  const out = (res.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`eval returned no JSON:\n${out}\n${res.stderr || ''}`);
  }
  return JSON.parse(out.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// create — render the board
// ---------------------------------------------------------------------------

function cardJSX(t) {
  const footer = t.assignee
    ? `<Frame name="footer" flex="row" gap={6} items="center" w="fill">
         <Frame w={18} h={18} bg="var:primary" rounded={9} flex="row" justify="center" items="center">
           <Text size={9} weight="semibold" color="var:primary-foreground">${t.assignee[0]}</Text>
         </Frame>
         <Text size={10} color="var:muted-foreground">${t.assignee}</Text>
       </Frame>`
    : `<Frame name="footer" flex="row" gap={6} items="center" w="fill">
         <Frame w={18} h={18} rounded={9} stroke="var:border" strokeWidth={1} />
         <Text size={10} color="var:muted-foreground">Unassigned</Text>
       </Frame>`;
  return `<Frame name="task:${t.id}" bg="var:card" stroke="var:border" strokeWidth={1} rounded={10} p={12} flex="col" gap={8} w="fill">
    <Frame name="meta" flex="row" gap={6} items="center" w="fill">
      <Frame bg="var:muted" px={6} py={2} rounded={4} flex="row" items="center">
        <Text size={10} color="var:muted-foreground">${t.tag}</Text>
      </Frame>
    </Frame>
    <Text size={13} weight="semibold" color="var:foreground" w="fill">${t.title}</Text>
    <Text size={11} color="var:muted-foreground" w="fill">${t.desc}</Text>
    ${footer}
  </Frame>`;
}

function columnJSX(col) {
  const cards = TASKS.filter(t => t.col === col.key).map(cardJSX).join('\n');
  const hint = col.key === 'agent'
    ? `<Frame name="hint" stroke="var:border" strokeWidth={1} rounded={10} p={12} flex="row" justify="center" items="center" w="fill">
         <Text size={10} color="var:muted-foreground" align="center" w="fill">Drop a card here to delegate it to the agent</Text>
       </Frame>`
    : '';
  return `<Frame name="col:${col.key}" flex="col" gap={10} w={250} p={12} bg="var:muted" rounded={12} items="start" align="start">
    <Frame name="header" flex="row" gap={6} items="center" w="fill">
      <Frame w={8} h={8} bg="${col.dot}" rounded={4} />
      <Text size={12} weight="semibold" color="var:foreground">${col.label}</Text>
    </Frame>
    ${hint}
    ${cards}
  </Frame>`;
}

function boardJSX() {
  return `<Frame name="${BOARD}" flex="col" gap={16} p={20} bg="var:background" rounded={16} stroke="var:border" strokeWidth={1}>
    <Frame name="board-header" flex="col" gap={2} w="fill">
      <Text size={16} weight="bold" color="var:foreground" w="fill">Comment Tracker</Text>
      <Text size={11} color="var:muted-foreground" w="fill">Synced from Figma comments · humans drag cards, the Agent Queue is worked by Claude</Text>
    </Frame>
    <Frame name="columns" flex="row" gap={16} items="start" align="start">
      ${COLUMNS.map(columnJSX).join('\n')}
    </Frame>
  </Frame>`;
}

function ensureShadcnVars() {
  const res = cli(['var', 'list']);
  if (!(res.stdout || '').includes('shadcn')) {
    console.log('No shadcn variables found, creating them (tokens preset shadcn)...');
    const t = cli(['tokens', 'preset', 'shadcn'], { stdio: 'inherit' });
    if (t.status !== 0) throw new Error('tokens preset shadcn failed');
  }
}

function create() {
  ensureShadcnVars();
  console.log('Rendering board...');
  const res = cli(['render', boardJSX(), '--keep-wrapper'], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('render failed');
  console.log('\nBoard created. Start the watcher with:\n  node examples/agent-board.js watch');
}

// ---------------------------------------------------------------------------
// Board operations (eval)
// ---------------------------------------------------------------------------

function pollQueue() {
  return figmaEval(`
    const board = figma.currentPage.findOne(n => n.name === ${JSON.stringify(BOARD)} && n.type === 'FRAME');
    if (!board) return { error: 'board-not-found' };
    const col = board.findOne(n => n.name === 'col:agent');
    if (!col) return { error: 'agent-col-not-found' };
    const cards = col.children
      .filter(c => c.name.startsWith('task:'))
      .map(card => {
        const texts = card.findAll(n => n.type === 'TEXT');
        return {
          id: card.id,
          taskId: card.name,
          tag: texts[0] ? texts[0].characters : '',
          title: texts[1] ? texts[1].characters : '',
          desc: texts[2] ? texts[2].characters : '',
        };
      });
    return { cards };
  `);
}

/** Move a card to a column and replace its status badge. badge = {text,bg,fg} or null. */
function moveCard(cardId, colKey, badge) {
  return figmaEval(`
    function rgb(hex) {
      return {
        r: parseInt(hex.slice(1, 3), 16) / 255,
        g: parseInt(hex.slice(3, 5), 16) / 255,
        b: parseInt(hex.slice(5, 7), 16) / 255,
      };
    }
    const card = await figma.getNodeByIdAsync(${JSON.stringify(cardId)});
    if (!card) return { error: 'card-not-found' };
    const board = figma.currentPage.findOne(n => n.name === ${JSON.stringify(BOARD)} && n.type === 'FRAME');
    const dest = board.findOne(n => n.name === ${JSON.stringify('col:' + colKey)});
    if (!dest) return { error: 'column-not-found' };
    dest.appendChild(card);
    card.layoutSizingHorizontal = 'FILL';
    const old = card.findOne(n => n.name === 'badge');
    if (old) old.remove();
    const badge = ${JSON.stringify(badge)};
    if (badge) {
      await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
      const b = figma.createFrame();
      b.name = 'badge';
      b.layoutMode = 'HORIZONTAL';
      b.primaryAxisSizingMode = 'AUTO';
      b.counterAxisSizingMode = 'AUTO';
      b.paddingLeft = 8; b.paddingRight = 8; b.paddingTop = 3; b.paddingBottom = 3;
      b.cornerRadius = 6;
      b.fills = [{ type: 'SOLID', color: rgb(badge.bg) }];
      const t = figma.createText();
      t.fontName = { family: 'Inter', style: 'Medium' };
      t.fontSize = 10;
      t.characters = badge.text;
      t.fills = [{ type: 'SOLID', color: rgb(badge.fg) }];
      b.appendChild(t);
      card.appendChild(b);
      b.layoutSizingHorizontal = 'HUG';
    }
    return { ok: true };
  `);
}

function delegate(taskId) {
  const id = taskId.startsWith('task:') ? taskId : `task:${taskId}`;
  const res = figmaEval(`
    const board = figma.currentPage.findOne(n => n.name === ${JSON.stringify(BOARD)} && n.type === 'FRAME');
    if (!board) return { error: 'board-not-found' };
    const card = board.findOne(n => n.name === ${JSON.stringify(id)});
    if (!card) return { error: 'card-not-found' };
    const dest = board.findOne(n => n.name === 'col:agent');
    dest.appendChild(card);
    card.layoutSizingHorizontal = 'FILL';
    return { ok: true };
  `);
  if (res.error) throw new Error(res.error);
  console.log(`Delegated ${id} to the Agent Queue.`);
}

// ---------------------------------------------------------------------------
// watch — the agent loop
// ---------------------------------------------------------------------------

function agentPrompt(task) {
  return [
    'You are a design agent operating on the currently open Figma file through the `figma-cli` command (already connected, run it directly).',
    '',
    'Task from a Figma comment:',
    `Title: ${task.title}`,
    `Details: ${task.desc}`,
    '',
    'Rules:',
    `- Create your result on the canvas NEAR the frame "${BOARD}", never inside it.`,
    `- Do NOT modify, move or restyle anything inside "${BOARD}" — that board is managed by a watcher.`,
    '- Use figma-cli render / render-batch / a11y / var subcommands as appropriate. Bind colors to shadcn variables (var:card, var:foreground, ...) where it makes sense.',
    '- When done, print a one-line summary of what you created.',
  ].join('\n');
}

function runAgent(task) {
  console.log(`\n→ Agent starting on "${task.title}"`);
  let res;
  if (process.env.AGENT_CMD) {
    res = spawnSync('sh', ['-c', process.env.AGENT_CMD], {
      stdio: 'inherit', timeout: AGENT_TIMEOUT_MS,
      env: { ...process.env, TASK_TITLE: task.title, TASK_DESC: task.desc },
    });
  } else {
    res = spawnSync('claude', [
      '-p', agentPrompt(task),
      '--allowedTools', 'Bash(figma-cli:*),Bash(node:*)',
    ], { stdio: 'inherit', timeout: AGENT_TIMEOUT_MS });
  }
  if (res.error) console.error(`Agent error: ${res.error.message}`);
  return !res.error && res.status === 0;
}

const BADGES = {
  working: { text: 'Agent working…', bg: '#fef3c7', fg: '#92400e' },
  done: { text: 'Done by Agent', bg: '#dcfce7', fg: '#166534' },
  failed: { text: 'Failed — back to To do', bg: '#fee2e2', fg: '#991b1b' },
};

function processQueue() {
  const q = pollQueue();
  if (q.error) {
    console.error(`Poll error: ${q.error}`);
    return 0;
  }
  for (const task of q.cards) {
    moveCard(task.id, 'inprogress', BADGES.working);
    const ok = runAgent(task);
    if (ok) {
      moveCard(task.id, 'done', BADGES.done);
      console.log(`✓ "${task.title}" done — card moved to Done.`);
    } else {
      moveCard(task.id, 'todo', BADGES.failed);
      console.log(`✗ "${task.title}" failed — card moved back to To do.`);
    }
  }
  return q.cards.length;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function watch(once) {
  console.log(`Watching the Agent Queue on "${BOARD}" (poll every ${POLL_MS / 1000}s). Drag a card in to delegate. Ctrl-C to stop.`);
  for (;;) {
    try {
      const n = processQueue();
      if (!n && once) console.log('Queue is empty.');
    } catch (e) {
      console.error(`Watcher error${once ? '' : ' (retrying)'}: ${e.message}`);
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'create') create();
  else if (cmd === 'watch') await watch(arg === '--once');
  else if (cmd === 'delegate' && arg) delegate(arg);
  else {
    console.log('Usage: node examples/agent-board.js <create | watch [--once] | delegate <task-id>>');
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
