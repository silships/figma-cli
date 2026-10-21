import chalk from 'chalk';
import { program, checkConnection, daemonExec } from '../lib/cli-core.js';
import { getKey, saveKey, deleteKey, maskKey, promptKeySecure } from '../credentials.js';
import { parseFileKey, toThreads, pinsOf, pinLabel, resolvePinsCode } from '../lib/comments.js';

// ============ COMMENTS ============
// The one command that talks to Figma's cloud API. The Plugin API has no access
// to comment threads in any connection mode, so `comments list` reads them from
// the REST API (GET /v1/files/:key/comments) with a personal access token. The
// plugin is still used for what REST cannot say: the open file's key and the
// layer each comment is pinned to. Nothing else in figma-cli needs the token,
// and without one nothing here is ever sent.

const TOKEN_NAME = 'FIGMA_ACCESS_TOKEN';
const API = 'https://api.figma.com/v1';

function tokenSource() {
  if (process.env.FIGMA_ACCESS_TOKEN) return { token: process.env.FIGMA_ACCESS_TOKEN, from: 'FIGMA_ACCESS_TOKEN env var' };
  const stored = getKey(TOKEN_NAME);
  return stored ? { token: stored, from: 'credential store' } : null;
}

function requireToken() {
  const source = tokenSource();
  if (source) return source.token;

  console.error(chalk.red('✗ Reading comments needs a Figma personal access token.'));
  console.error(chalk.gray('  The Plugin API cannot see comment threads, so this is the one command'));
  console.error(chalk.gray('  that uses the REST API. Create a token in Figma → Settings → Security →'));
  console.error(chalk.gray('  Personal access tokens, scopes "File content: Read" and "Comments: Read",'));
  console.error(chalk.gray('  then run:'));
  console.error(chalk.cyan('    figma-cli comments token set'));
  console.error(chalk.gray('  (or set FIGMA_ACCESS_TOKEN in your shell).'));
  process.exit(1);
}

async function openFileKey() {
  await checkConnection();
  const key = await daemonExec('eval', { code: 'figma.fileKey' });
  if (!key) throw new Error("Could not read the open file's key. Pass --file <key or figma.com URL>.");
  return key;
}

async function fetchComments(fileKey, token) {
  const res = await fetch(`${API}/files/${fileKey}/comments?as_md=true`, {
    headers: { 'X-Figma-Token': token }
  });
  if (res.status === 403) throw new Error('403 from Figma: the token lacks the "Comments: Read" scope, or has no access to this file.');
  if (res.status === 404) throw new Error(`404 from Figma: file ${fileKey} not found for this token.`);
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.comments || [];
}

const commentsCmd = program
  .command('comments')
  .description('Read comment threads on a file (REST API; needs a personal access token)');

commentsCmd
  .command('list')
  .description('List comment threads (unresolved only unless --all)')
  .option('-f, --file <key|url>', 'File key or figma.com URL (default: the file open in Figma)')
  .option('-n, --node <id>', 'Only comments pinned inside this node (any depth)')
  .option('-a, --all', 'Include resolved threads')
  .option('--json', 'Print raw JSON (threads with the resolved layer)')
  .action(async (options) => {
    const token = requireToken();
    try {
      const fileKey = options.file ? parseFileKey(options.file) : await openFileKey();
      const all = toThreads(await fetchComments(fileKey, token));
      const open = options.all ? all : all.filter((t) => !t.resolved_at);

      let info = {};
      try {
        info = (await daemonExec('eval', { code: resolvePinsCode(pinsOf(open)) }, 120000)) || {};
      } catch {
        // Not connected: still list the threads, with node ids instead of layer names.
      }

      const inScope = options.node
        ? open.filter((t) => info[t.id]?.chain.some((c) => c.id === options.node))
        : open;

      if (options.json) {
        console.log(JSON.stringify(inScope.map((t) => ({ ...t, node: info[t.id] || null })), null, 2));
        return;
      }

      if (inScope.length === 0) {
        console.log(chalk.gray(`No ${options.all ? '' : 'unresolved '}comments${options.node ? ` inside ${options.node}` : ''}.`));
        return;
      }

      for (const t of inScope) {
        const pin = info[t.id];
        const where = t.client_meta?.node_id ? `${pinLabel(pin)} (${pin ? pin.id : t.client_meta.node_id})` : 'canvas';
        const state = t.resolved_at ? chalk.green(' [resolved]') : '';
        console.log(chalk.bold(`#${t.order_id || t.id}`) + chalk.gray(` ${where}`) + state);
        console.log(`  ${chalk.cyan(t.user?.handle || '?')} ${chalk.gray(t.created_at.slice(0, 16).replace('T', ' '))}`);
        console.log(`  ${t.message.split('\n').join('\n  ')}`);
        for (const r of t.replies) {
          console.log(`    ↳ ${chalk.cyan(r.user?.handle || '?')}: ${r.message.split('\n').join('\n      ')}`);
        }
        console.log('');
      }
      console.log(chalk.gray(`${inScope.length} thread(s)`));
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }
  });

const tokenCmd = commentsCmd
  .command('token')
  .description('Store, check or remove the personal access token (OS credential store)');

tokenCmd
  .command('set')
  .description('Prompt for the token (hidden input) and store it securely')
  .action(async () => {
    const token = (await promptKeySecure('  Figma personal access token: ')).trim();
    if (!token) {
      console.error(chalk.red('✗ Empty token, nothing stored.'));
      process.exit(1);
    }
    saveKey(TOKEN_NAME, token);
    console.log(chalk.green(`✓ Stored ${maskKey(token)}`));
  });

tokenCmd
  .command('status')
  .description('Say whether a token is available (masked)')
  .action(() => {
    const source = tokenSource();
    console.log(source
      ? chalk.green(`✓ ${maskKey(source.token)} (${source.from})`)
      : chalk.yellow('No token set. Run: figma-cli comments token set'));
  });

tokenCmd
  .command('clear')
  .description('Remove the stored token')
  .action(() => {
    deleteKey(TOKEN_NAME);
    console.log(chalk.green('✓ Token removed from the credential store.'));
  });
