#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { homedir, platform } from 'os';
import { createServer } from 'http';
import { FigJamClient } from './figjam-client.js';
import { FigmaClient } from './figma-client.js';
import { isPatched, patchFigma, unpatchFigma, getFigmaCommand } from './figma-patch.js';

// Daemon configuration
const DAEMON_PORT = 3456;
const DAEMON_PID_FILE = join(homedir(), '.figma-cli-daemon.pid');

// Check if daemon is running
function isDaemonRunning() {
  try {
    const response = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${DAEMON_PORT}/health`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 1000
    });
    return response.trim() === '200';
  } catch {
    return false;
  }
}

// Send command to daemon (uses native fetch in Node 18+)
async function daemonExec(action, data = {}) {
  const response = await fetch(`http://localhost:${DAEMON_PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(60000)
  });

  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.result;
}

// Fast eval via daemon (falls back to figma-use if all else fails)
async function fastEval(code) {
  // Try daemon first
  if (isDaemonRunning()) {
    try {
      return await daemonExec('eval', { code });
    } catch (e) {
      // Continue to fallbacks
    }
  }

  // Try direct connection
  try {
    const client = await getFigmaClient();
    return await client.eval(code);
  } catch (e) {
    // Fall back to npx figma-use
    const tempFile = '/tmp/figma-eval-' + Date.now() + '.js';
    writeFileSync(tempFile, code);
    try {
      const output = execSync(`npx figma-use eval "$(cat ${tempFile})"`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000
      });
      unlinkSync(tempFile);
      try {
        return JSON.parse(output.trim());
      } catch {
        return output.trim();
      }
    } finally {
      try { unlinkSync(tempFile); } catch {}
    }
  }
}

// Fast render via daemon (falls back to figma-use)
async function fastRender(jsx) {
  // Try daemon first
  if (isDaemonRunning()) {
    try {
      return await daemonExec('render', { jsx });
    } catch (e) {
      // Continue to fallbacks
    }
  }

  // Try direct connection
  try {
    const client = await getFigmaClient();
    return await client.render(jsx);
  } catch (e) {
    // Fall back to npx figma-use
    const { FigmaClient } = await import('./figma-client.js');
    const tempClient = new FigmaClient();
    const code = tempClient.parseJSX(jsx);

    const tempFile = '/tmp/figma-render-' + Date.now() + '.js';
    writeFileSync(tempFile, code);
    try {
      const output = execSync(`npx figma-use eval "$(cat ${tempFile})"`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000
      });
      unlinkSync(tempFile);
      try {
        return JSON.parse(output.trim());
      } catch {
        return { id: 'unknown', name: jsx.match(/name="([^"]+)"/)?.[1] || 'Frame' };
      }
    } finally {
      try { unlinkSync(tempFile); } catch {}
    }
  }
}

// Start daemon in background
function startDaemon(forceRestart = false) {
  // If force restart, always kill existing daemon first
  if (forceRestart) {
    stopDaemon();
    // Wait for port to be released
    try { execSync('sleep 0.3', { stdio: 'pipe' }); } catch {}
  } else if (isDaemonRunning()) {
    return true; // Already running
  }

  const daemonScript = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
  const child = spawn('node', [daemonScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DAEMON_PORT: String(DAEMON_PORT) }
  });
  child.unref();

  // Save PID
  writeFileSync(DAEMON_PID_FILE, String(child.pid));
  return true;
}

// Stop daemon
function stopDaemon() {
  try {
    if (existsSync(DAEMON_PID_FILE)) {
      const pid = readFileSync(DAEMON_PID_FILE, 'utf8').trim();
      try {
        process.kill(parseInt(pid), 'SIGTERM');
      } catch {}
      unlinkSync(DAEMON_PID_FILE);
    }
    // Also try to kill by port
    if (IS_MAC || IS_LINUX) {
      execSync(`lsof -ti:${DAEMON_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' });
    }
  } catch {}
}

// Platform detection
const IS_WINDOWS = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

// Platform-specific Figma paths and commands
function getFigmaPath() {
  if (IS_MAC) {
    return '/Applications/Figma.app/Contents/MacOS/Figma';
  } else if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'Figma', 'Figma.exe');
  } else {
    // Linux
    return '/usr/bin/figma';
  }
}

function startFigma() {
  const figmaPath = getFigmaPath();
  if (IS_MAC) {
    execSync('open -a Figma --args --remote-debugging-port=9222', { stdio: 'pipe' });
  } else if (IS_WINDOWS) {
    spawn(figmaPath, ['--remote-debugging-port=9222'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(figmaPath, ['--remote-debugging-port=9222'], { detached: true, stdio: 'ignore' }).unref();
  }
}

function killFigma() {
  try {
    if (IS_MAC) {
      execSync('pkill -x Figma 2>/dev/null || true', { stdio: 'pipe' });
    } else if (IS_WINDOWS) {
      execSync('taskkill /IM Figma.exe /F 2>nul', { stdio: 'pipe' });
    } else {
      execSync('pkill -x figma 2>/dev/null || true', { stdio: 'pipe' });
    }
  } catch (e) {
    // Ignore errors if Figma wasn't running
  }
}

function getManualStartCommand() {
  if (IS_MAC) {
    return 'open -a Figma --args --remote-debugging-port=9222';
  } else if (IS_WINDOWS) {
    return '"%LOCALAPPDATA%\\Figma\\Figma.exe" --remote-debugging-port=9222';
  } else {
    return 'figma --remote-debugging-port=9222';
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const CONFIG_DIR = join(homedir(), '.figma-ds-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const program = new Command();

// Helper: Prompt user
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

// Helper: Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// Helper: Save config
function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Singleton FigmaClient instance
let _figmaClient = null;

// Helper: Get or create FigmaClient
async function getFigmaClient() {
  if (!_figmaClient) {
    _figmaClient = new FigmaClient();
    await _figmaClient.connect();
  }
  return _figmaClient;
}

// Helper: Run code in Figma (replaces figma-use eval)
async function figmaEval(code) {
  const client = await getFigmaClient();
  return await client.eval(code);
}

// Sync wrapper for figmaEval - uses daemon via curl (fast) or fallback to direct connection
function figmaEvalSync(code) {
  // Try daemon first (fast path)
  const daemonRunning = isDaemonRunning();
  if (daemonRunning) {
    try {
      const payload = JSON.stringify({ action: 'eval', code });
      const payloadFile = `/tmp/figma-payload-${Date.now()}.json`;
      writeFileSync(payloadFile, payload);
      const result = execSync(
        `curl -s -X POST http://127.0.0.1:3456/exec -H "Content-Type: application/json" -d @${payloadFile}`,
        { encoding: 'utf8', timeout: 15000 }
      );
      try { unlinkSync(payloadFile); } catch {}
      if (!result || result.trim() === '') {
        throw new Error('Empty response from daemon');
      }
      const data = JSON.parse(result);
      if (data.error) throw new Error(data.error);
      return data.result;
    } catch (e) {
      // Fall through to direct connection
    }
  }

  // Fallback: direct connection via temp script
  const tempFile = join('/tmp', `figma-eval-${Date.now()}.mjs`);
  const resultFile = join('/tmp', `figma-result-${Date.now()}.json`);

  const script = `
    import { FigmaClient } from '${join(process.cwd(), 'src/figma-client.js').replace(/\\/g, '/')}';
    import { writeFileSync } from 'fs';

    (async () => {
      try {
        const client = new FigmaClient();
        await client.connect();
        const result = await client.eval(${JSON.stringify(code)});
        writeFileSync('${resultFile}', JSON.stringify({ success: true, result }));
        client.close();
      } catch (e) {
        writeFileSync('${resultFile}', JSON.stringify({ success: false, error: e.message }));
      }
    })();
  `;

  writeFileSync(tempFile, script);
  try {
    execSync(`node ${tempFile}`, { stdio: 'pipe', timeout: 30000 });
    if (existsSync(resultFile)) {
      const data = JSON.parse(readFileSync(resultFile, 'utf8'));
      try { execSync(`rm -f ${tempFile} ${resultFile}`, { stdio: 'pipe' }); } catch {}
      if (data.success) return data.result;
      throw new Error(data.error);
    }
  } catch (e) {
    try { execSync(`rm -f ${tempFile} ${resultFile}`, { stdio: 'pipe' }); } catch {}
    throw e;
  }
  return null;
}

// Compatibility wrapper for old figmaUse calls
function figmaUse(args, options = {}) {
  // Parse eval command
  const evalMatch = args.match(/^eval\s+"(.+)"$/s) || args.match(/^eval\s+'(.+)'$/s);

  if (evalMatch) {
    // Only unescape quotes, NOT \n (which would break string literals like .join('\n'))
    const code = evalMatch[1].replace(/\\"/g, '"');
    try {
      const result = figmaEvalSync(code);
      if (!options.silent && result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
      return typeof result === 'object' ? JSON.stringify(result) : String(result || '');
    } catch (error) {
      if (options.silent) return null;
      throw error;
    }
  }

  if (args === 'status' || args.startsWith('status')) {
    try {
      const result = execSync('curl -s http://localhost:9222/json', { encoding: 'utf8', stdio: 'pipe' });
      const pages = JSON.parse(result);
      const figmaPage = pages.find(p => p.url && /figma\.com\/(design|file|make|board)\//.test(p.url));
      if (figmaPage) {
        const typeMatch = figmaPage.url.match(/figma\.com\/(design|file|make|board)\//);
        const fileType = typeMatch ? typeMatch[1] : 'unknown';
        const isMake = fileType === 'make' || fileType === 'board';
        const typeLabel = isMake ? ` (${fileType === 'make' ? 'Make' : 'Board'} file)` : '';
        let status = `Connected to Figma\n  File: ${figmaPage.title.replace(' – Figma', '')}${typeLabel}`;
        if (isMake) {
          status += "\n  ⚠ Make/Board files don't support eval/render — open a Design file for full CLI access";
        }
        if (!options.silent) console.log(status);
        return status;
      }
      return 'Not connected';
    } catch {
      return 'Not connected';
    }
  }

  if (args === 'variable list') {
    const result = figmaEvalSync(`
      figma.variables.getLocalVariables().map(v => v.name + ' (' + v.resolvedType + ')').join('\\n')
    `);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args === 'collection list') {
    const result = figmaEvalSync(`
      figma.variables.getLocalVariableCollections().map(c => c.name + ' (' + c.variableIds.length + ' vars)').join('\\n')
    `);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args.startsWith('collection create ')) {
    const name = args.replace('collection create ', '').replace(/"/g, '');
    const result = figmaEvalSync(`
      const col = figma.variables.createVariableCollection('${name}');
      col.id
    `);
    if (!options.silent) console.log(chalk.green('✓ Created collection: ' + name));
    return result;
  }

  if (args.startsWith('variable find ')) {
    const pattern = args.replace('variable find ', '').replace(/"/g, '');
    const result = figmaEvalSync(`
      const pattern = '${pattern}'.replace('*', '.*');
      const re = new RegExp(pattern, 'i');
      figma.variables.getLocalVariables().filter(v => re.test(v.name)).map(v => v.name).join('\\n')
    `);
    if (!options.silent) console.log(result);
    return result;
  }

  if (args.startsWith('select ')) {
    const nodeId = args.replace('select ', '').replace(/"/g, '');
    figmaEvalSync(`
      const node = figma.getNodeById('${nodeId}');
      if (node) figma.currentPage.selection = [node];
    `);
    return 'Selected';
  }

  // Fallback warning
  if (!options.silent) {
    console.log(chalk.yellow('Command not fully supported: ' + args));
  }
  return null;
}

// Helper: Check connection
async function checkConnection() {
  const connected = await FigmaClient.isConnected();
  if (!connected) {
    console.log(chalk.red('\n✗ Not connected to Figma\n'));
    console.log(chalk.white('  Make sure Figma is running with remote debugging:'));
    console.log(chalk.cyan('  figma-ds-cli connect\n'));
    process.exit(1);
  }
  return true;
}

// Helper: Check connection (sync version for backwards compat)
function checkConnectionSync() {
  // This is a sync check - just verify port is open
  try {
    execSync('curl -s http://localhost:9222/json > /dev/null', { stdio: 'pipe' });
    return true;
  } catch {
    console.log(chalk.red('\n✗ Not connected to Figma\n'));
    console.log(chalk.white('  Make sure Figma is running with remote debugging:'));
    console.log(chalk.cyan('  figma-ds-cli connect\n'));
    process.exit(1);
  }
}

// Helper: Check if Figma is patched
function isFigmaPatched() {
  const config = loadConfig();
  return config.patched === true;
}

// Helper: Hex to Figma RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  };
}

// Helper: Smart positioning code (returns JS to get next free X position)
function smartPosCode(gap = 100) {
  return `
const children = figma.currentPage.children;
let smartX = 0;
if (children.length > 0) {
  children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
  smartX += ${gap};
}
`;
}

program
  .name('figma-ds-cli')
  .description('CLI for managing Figma design systems')
  .version(pkg.version);

// Default action when no command is given
program.action(async () => {
  const config = loadConfig();

  // First time? Run init
  if (!config.patched) {
    showBanner();
    console.log(chalk.white('  Welcome! Let\'s get you set up.\n'));
    console.log(chalk.gray('  This takes about 30 seconds. No API key needed.\n'));

    // Step 1: Check Node version
    console.log(chalk.blue('Step 1/3: ') + 'Checking Node.js...');
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor < 18) {
      console.log(chalk.red(`  ✗ Node.js ${nodeVersion} is too old. Please upgrade to Node 18+`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Node.js ${nodeVersion}`));

    // Step 2: Patch Figma
    console.log(chalk.blue('\nStep 2/3: ') + 'Patching Figma Desktop...');
    if (config.patched) {
      console.log(chalk.green('  ✓ Figma already patched'));
    } else {
      console.log(chalk.gray('  (This allows CLI to connect to Figma)'));
      const spinner = ora('  Patching...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma already patched');
        } else if (patchStatus === false) {
          patchFigma();
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma patched');
        } else {
          // Can't determine - assume it's fine (old Figma version)
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma ready (no patch needed)');
        }
      } catch (error) {
        spinner.fail('Patch failed: ' + error.message);
        if ((error.message.includes('EPERM') || error.message.includes('permission') || error.message.includes('Full Disk Access')) && process.platform === 'darwin') {
          console.log(chalk.yellow('\n  ⚠️  Your Terminal needs "Full Disk Access" permission.\n'));
          console.log(chalk.gray('  1. Open System Settings → Privacy & Security → Full Disk Access'));
          console.log(chalk.gray('  2. Click + and add your Terminal app'));
          console.log(chalk.gray('  3. Quit Terminal completely (Cmd+Q)'));
          console.log(chalk.gray('  4. Reopen Terminal and try again\n'));
        } else if (error.message.includes('EPERM') || error.message.includes('permission')) {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
        }
      }
    }

    // Step 3: Start Figma
    console.log(chalk.blue('\nStep 3/3: ') + 'Starting Figma...');
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 1000));
      startFigma();
      console.log(chalk.green('  ✓ Figma started'));

      // Wait for connection
      const spinner = ora('  Waiting for connection...').start();
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        connected = await FigmaClient.isConnected();
        if (connected) break;
      }

      if (connected) {
        spinner.succeed('Connected to Figma');
      } else {
        spinner.warn('Connection pending - open a file in Figma');
      }
    } catch (error) {
      console.log(chalk.yellow('  ! Could not start Figma automatically'));
      console.log(chalk.gray('    Start manually: ' + getManualStartCommand()));
    }

    // Done!
    console.log(chalk.green('\n  ✓ Setup complete!\n'));
    showQuickStart();
    return;
  }

  // Already set up - check connection and show status
  showBanner();

  const connected = await FigmaClient.isConnected();
  if (connected) {
    console.log(chalk.green('  ✓ Connected to Figma\n'));
    try {
      const client = new FigmaClient();
      await client.connect();
      const info = await client.getPageInfo();
      console.log(chalk.gray(`  File: ${client.pageTitle.replace(' – Figma', '')}`));
      console.log(chalk.gray(`  Page: ${info.name}`));
      client.close();
    } catch {}
    console.log();
    showQuickStart();
  } else {
    console.log(chalk.yellow('  ⚠ Figma not connected\n'));
    console.log(chalk.white('  Starting Figma...'));
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 500));
      startFigma();
      console.log(chalk.green('  ✓ Figma started\n'));

      const spinner = ora('  Waiting for connection...').start();
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await FigmaClient.isConnected()) {
          spinner.succeed('Connected to Figma\n');
          showQuickStart();
          return;
        }
      }
      spinner.warn('Open a file in Figma to connect\n');
      showQuickStart();
    } catch {
      console.log(chalk.gray('  Start manually: ' + getManualStartCommand() + '\n'));
    }
  }
});

function showQuickStart() {
  console.log(chalk.white('  Quick start:\n'));
  console.log(chalk.gray('    Create design system       ') + chalk.cyan('figma-ds-cli tokens ds'));
  console.log(chalk.gray('    Create Tailwind colors     ') + chalk.cyan('figma-ds-cli tokens tailwind'));
  console.log(chalk.gray('    List all variables         ') + chalk.cyan('figma-ds-cli var list'));
  console.log(chalk.gray('    Render JSX to Figma        ') + chalk.cyan('figma-ds-cli render \'<Frame>...</Frame>\''));
  console.log(chalk.gray('    See all commands           ') + chalk.cyan('figma-ds-cli --help'));
  console.log();
  console.log(chalk.gray('  Learn more: ') + chalk.cyan('https://intodesignsystems.com\n'));
}

// ============ WELCOME BANNER ============

function showBanner() {
  console.log(chalk.cyan(`
  ███████╗██╗ ██████╗ ███╗   ███╗ █████╗       ██████╗ ███████╗       ██████╗██╗     ██╗
  ██╔════╝██║██╔════╝ ████╗ ████║██╔══██╗      ██╔══██╗██╔════╝      ██╔════╝██║     ██║
  █████╗  ██║██║  ███╗██╔████╔██║███████║█████╗██║  ██║███████╗█████╗██║     ██║     ██║
  ██╔══╝  ██║██║   ██║██║╚██╔╝██║██╔══██║╚════╝██║  ██║╚════██║╚════╝██║     ██║     ██║
  ██║     ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║      ██████╔╝███████║      ╚██████╗███████╗██║
  ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝       ╚═════╝╚══════╝╚═╝
`));
  console.log(chalk.white(`  Design System CLI for Figma ${chalk.gray('v' + pkg.version)}`));
  console.log(chalk.gray(`  by Sil Bormüller • intodesignsystems.com\n`));
}

// ============ INIT (Interactive Onboarding) ============

program
  .command('init')
  .description('Interactive setup wizard')
  .action(async () => {
    showBanner();

    console.log(chalk.white('  Welcome! Let\'s get you set up.\n'));
    console.log(chalk.gray('  This takes about 30 seconds. No API key needed.\n'));

    // Step 1: Check Node version
    console.log(chalk.blue('Step 1/4: ') + 'Checking Node.js...');
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (nodeMajor < 18) {
      console.log(chalk.red(`  ✗ Node.js ${nodeVersion} is too old. Please upgrade to Node 18+`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Node.js ${nodeVersion}`));

    // Step 2: Patch Figma
    console.log(chalk.blue('\nStep 2/3: ') + 'Patching Figma Desktop...');
    const config = loadConfig();
    if (config.patched) {
      console.log(chalk.green('  ✓ Figma already patched'));
    } else {
      console.log(chalk.gray('  (This allows CLI to connect to Figma)'));
      const spinner = ora('  Patching...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma already patched');
        } else if (patchStatus === false) {
          patchFigma();
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma patched');
        } else {
          config.patched = true;
          saveConfig(config);
          spinner.succeed('Figma ready (no patch needed)');
        }
      } catch (error) {
        spinner.fail('Patch failed: ' + error.message);
        if ((error.message.includes('EPERM') || error.message.includes('permission') || error.message.includes('Full Disk Access')) && process.platform === 'darwin') {
          console.log(chalk.yellow('\n  ⚠️  Your Terminal needs "Full Disk Access" permission.\n'));
          console.log(chalk.gray('  1. Open System Settings → Privacy & Security → Full Disk Access'));
          console.log(chalk.gray('  2. Click + and add your Terminal app'));
          console.log(chalk.gray('  3. Quit Terminal completely (Cmd+Q)'));
          console.log(chalk.gray('  4. Reopen Terminal and try again\n'));
        } else if (error.message.includes('EPERM') || error.message.includes('permission')) {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
        }
      }
    }

    // Step 3: Start Figma
    console.log(chalk.blue('\nStep 3/3: ') + 'Starting Figma...');
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 1000));
      startFigma();
      console.log(chalk.green('  ✓ Figma started'));

      // Wait for connection
      const spinner = ora('  Waiting for connection...').start();
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        connected = await FigmaClient.isConnected();
        if (connected) break;
      }

      if (connected) {
        spinner.succeed('Connected to Figma');
      } else {
        spinner.warn('Connection pending - open a file in Figma');
      }
    } catch (error) {
      console.log(chalk.yellow('  ! Could not start Figma automatically'));
      console.log(chalk.gray('    Start manually: ' + getManualStartCommand()));
    }

    // Done!
    console.log(chalk.green('\n  ✓ Setup complete!\n'));

    console.log(chalk.white('  Quick start:\n'));
    console.log(chalk.gray('    Create Tailwind colors    ') + chalk.cyan('figma-ds-cli tokens tailwind'));
    console.log(chalk.gray('    Create spacing scale      ') + chalk.cyan('figma-ds-cli tokens spacing'));
    console.log(chalk.gray('    List all variables        ') + chalk.cyan('figma-ds-cli var list'));
    console.log(chalk.gray('    Render JSX to Figma       ') + chalk.cyan('figma-ds-cli render \'<Frame>...</Frame>\''));
    console.log(chalk.gray('    See all commands          ') + chalk.cyan('figma-ds-cli --help'));
    console.log();
    console.log(chalk.gray('  Learn more: ') + chalk.cyan('https://intodesignsystems.com\n'));
  });

// ============ SETUP (alias for init) ============

program
  .command('setup')
  .description('Setup Figma for CLI access (alias for init)')
  .action(() => {
    // Redirect to init
    execSync('figma-ds-cli init', { stdio: 'inherit' });
  });

// ============ STATUS ============

program
  .command('status')
  .description('Check connection to Figma')
  .action(() => {
    // Check if first run
    const config = loadConfig();
    if (!config.patched && !checkDependencies(true)) {
      console.log(chalk.yellow('\n⚠ First time? Run the setup wizard:\n'));
      console.log(chalk.cyan('  figma-ds-cli init\n'));
      return;
    }
    figmaUse('status');
  });

// ============ UNPATCH ============

program
  .command('unpatch')
  .description('Restore Figma to original state (removes remote debugging patch)')
  .action(() => {
    const spinner = ora('Checking Figma patch status...').start();

    try {
      const patchStatus = isPatched();

      if (patchStatus === false) {
        spinner.succeed('Figma is already in original state (not patched)');
        return;
      }

      if (patchStatus === null) {
        spinner.warn('Cannot determine patch status. Figma version may be incompatible.');
        return;
      }

      spinner.text = 'Restoring Figma to original state...';
      unpatchFigma();

      // Update config
      const config = loadConfig();
      config.patched = false;
      saveConfig(config);

      spinner.succeed('Figma restored to original state');
      console.log(chalk.gray('  Remote debugging is now blocked by default.'));
      console.log(chalk.gray('  Run "node src/index.js connect" to re-enable it.'));
    } catch (err) {
      spinner.fail(`Failed to unpatch: ${err.message}`);
    }
  });

// ============ CONNECT ============

program
  .command('connect')
  .description('Connect to Figma Desktop')
  .action(async () => {
    // Fun welcome message
    console.log(chalk.hex('#FF6B35')('\n  ✨ Hey designer! ') + chalk.white("Don't be afraid of the terminal!"));
    console.log(chalk.hex('#4ECDC4')('  🎨 Happy vibe coding! ') + chalk.gray('— Sil · ') + chalk.hex('#FF6B35')('intodesignsystems.com\n'));

    const config = loadConfig();

    // Patch Figma if needed
    if (!config.patched) {
      const patchSpinner = ora('Setting up Figma connection...').start();
      try {
        const patchStatus = isPatched();
        if (patchStatus === true) {
          patchSpinner.succeed('Figma ready');
        } else if (patchStatus === false) {
          patchFigma();
          patchSpinner.succeed('Figma configured');
        } else {
          patchSpinner.succeed('Figma ready');
        }
        config.patched = true;
        saveConfig(config);
      } catch (err) {
        patchSpinner.fail('Setup failed');

        // macOS Full Disk Access needed
        if (process.platform === 'darwin') {
          console.log(chalk.hex('#FF6B35')('\n  ┌─────────────────────────────────────────────────────┐'));
          console.log(chalk.hex('#FF6B35')('  │') + chalk.white.bold('  One-time setup required                           ') + chalk.hex('#FF6B35')('│'));
          console.log(chalk.hex('#FF6B35')('  └─────────────────────────────────────────────────────┘\n'));

          console.log(chalk.white('  Your Terminal needs permission to configure Figma.\n'));

          console.log(chalk.cyan('  Step 1: ') + chalk.white('Open ') + chalk.yellow('System Settings'));
          console.log(chalk.cyan('  Step 2: ') + chalk.white('Go to ') + chalk.yellow('Privacy & Security → Full Disk Access'));
          console.log(chalk.cyan('  Step 3: ') + chalk.white('Click ') + chalk.yellow('+') + chalk.white(' and add ') + chalk.yellow('Terminal'));
          console.log(chalk.cyan('  Step 4: ') + chalk.white('Quit Terminal completely ') + chalk.gray('(Cmd+Q)'));
          console.log(chalk.cyan('  Step 5: ') + chalk.white('Reopen Terminal and try again\n'));
        } else {
          console.log(chalk.yellow('\n  Try running as administrator.\n'));
        }
        return;
      }
    }

    // Stop any existing daemon
    stopDaemon();

    console.log(chalk.blue('Starting Figma...'));
    try {
      killFigma();
      await new Promise(r => setTimeout(r, 500));
    } catch {}

    startFigma();
    console.log(chalk.green('✓ Figma started\n'));

    // Wait and check connection
    const spinner = ora('Waiting for connection...').start();
    let connected = false;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const result = figmaUse('status', { silent: true });
      if (result && result.includes('Connected')) {
        spinner.succeed('Connected to Figma');
        console.log(chalk.gray(result.trim()));
        connected = true;
        break;
      }
    }

    if (!connected) {
      spinner.warn('Open a file in Figma to connect');
      return;
    }

    // Start daemon for fast commands (force restart to get fresh connection)
    const daemonSpinner = ora('Starting speed daemon...').start();
    try {
      startDaemon(true);  // Always restart daemon on connect
      await new Promise(r => setTimeout(r, 1500));
      if (isDaemonRunning()) {
        daemonSpinner.succeed('Speed daemon running (commands are now 10x faster)');
      } else {
        daemonSpinner.warn('Daemon failed to start, commands will be slower');
      }
    } catch (e) {
      daemonSpinner.warn('Daemon failed: ' + e.message);
    }
  });

// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

variables
  .command('list')
  .description('List all variables')
  .action(() => {
    checkConnection();
    figmaUse('variable list');
  });

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN')
  .option('-v, --value <value>', 'Initial value')
  .action((name, options) => {
    checkConnection();
    let cmd = `variable create "${name}" --collection "${options.collection}" --type ${options.type}`;
    if (options.value) cmd += ` --value "${options.value}"`;
    figmaUse(cmd);
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .action((pattern) => {
    checkConnection();
    figmaUse(`variable find "${pattern}"`);
  });

// ============ DAEMON ============

const daemon = program
  .command('daemon')
  .description('Manage the speed daemon');

daemon
  .command('status')
  .description('Check if daemon is running')
  .action(() => {
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon is running on port ' + DAEMON_PORT));
    } else {
      console.log(chalk.yellow('○ Daemon is not running'));
      console.log(chalk.gray('  Run "figma-ds-cli connect" to start it automatically'));
    }
  });

daemon
  .command('start')
  .description('Start the daemon manually')
  .action(async () => {
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon already running'));
      return;
    }
    console.log(chalk.blue('Starting daemon...'));
    startDaemon();
    await new Promise(r => setTimeout(r, 1500));
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon started on port ' + DAEMON_PORT));
    } else {
      console.log(chalk.red('✗ Failed to start daemon'));
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    console.log(chalk.blue('Stopping daemon...'));
    stopDaemon();
    console.log(chalk.green('✓ Daemon stopped'));
  });

daemon
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    console.log(chalk.blue('Restarting daemon...'));
    stopDaemon();
    await new Promise(r => setTimeout(r, 500));
    startDaemon();
    await new Promise(r => setTimeout(r, 1500));
    if (isDaemonRunning()) {
      console.log(chalk.green('✓ Daemon restarted'));
    } else {
      console.log(chalk.red('✗ Failed to restart daemon'));
    }
  });

daemon
  .command('reconnect')
  .description('Reconnect to Figma (use if connection is stale)')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log(chalk.yellow('○ Daemon is not running'));
      console.log(chalk.gray('  Run "figma-ds-cli connect" first'));
      return;
    }
    console.log(chalk.blue('Reconnecting to Figma...'));
    try {
      const response = await fetch(`http://localhost:${DAEMON_PORT}/reconnect`);
      const result = await response.json();
      if (result.error) {
        console.log(chalk.red('✗ Reconnect failed: ' + result.error));
      } else {
        console.log(chalk.green('✓ Reconnected to Figma'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

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

    const code = `
const colors = ${JSON.stringify(tailwindColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
let col = figma.variables.getLocalVariableCollections().find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(colors).forEach(([colorName, shades]) => {
  Object.entries(shades).forEach(([shade, hex]) => {
    const existing = figma.variables.getLocalVariables().find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col.id, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  });
});
'Created ' + count + ' color variables in ${options.collection}'
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Created Tailwind palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(error.message);
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

    const code = `
const colors = ${JSON.stringify(shadcnColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
let col = figma.variables.getLocalVariableCollections().find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(colors).forEach(([colorName, shades]) => {
  Object.entries(shades).forEach(([shade, hex]) => {
    const existing = figma.variables.getLocalVariables().find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col.id, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  });
});
'Created ' + count + ' shadcn color variables in ${options.collection}'
`;

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

    const code = `
const spacings = ${JSON.stringify(spacings)};
let col = figma.variables.getLocalVariableCollections().find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(spacings).forEach(([name, value]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === 'spacing/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('spacing/' + name, col.id, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
});
'Created ' + count + ' spacing variables'
`;

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

    const code = `
const radii = ${JSON.stringify(radii)};
let col = figma.variables.getLocalVariableCollections().find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(radii).forEach(([name, value]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === 'radius/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('radius/' + name, col.id, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
});
'Created ' + count + ' radius variables'
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
  .action((file, options) => {
    checkConnection();

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

    const code = `
const data = ${JSON.stringify(tokensData)};
const collectionName = '${collectionName}';

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

let col = figma.variables.getLocalVariableCollections().find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const tokens = flattenTokens(data);
let count = 0;

tokens.forEach(({ name, value, type }) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === name);
  if (!existing) {
    try {
      const figmaType = type === 'COLOR' ? 'COLOR' : type === 'FLOAT' || type === 'NUMBER' ? 'FLOAT' : type === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';
      const v = figma.variables.createVariable(name, col.id, figmaType);
      let figmaValue = value;
      if (figmaType === 'COLOR') figmaValue = hexToRgb(value);
      if (figmaValue !== null) {
        v.setValueForMode(modeId, figmaValue);
        count++;
      }
    } catch (e) {}
  }
});

'Imported ' + count + ' tokens into ' + collectionName
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(result?.trim() || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
    }
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
    const primitivesCode = `
const colors = ${JSON.stringify(idsColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
let col = figma.variables.getLocalVariableCollections().find(c => c.name === 'Color - Primitives');
if (!col) col = figma.variables.createVariableCollection('Color - Primitives');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(colors).forEach(([colorName, shades]) => {
  Object.entries(shades).forEach(([shade, hex]) => {
    const existing = figma.variables.getLocalVariables().find(v => v.name === colorName + '/' + shade);
    if (!existing) {
      const v = figma.variables.createVariable(colorName + '/' + shade, col.id, 'COLOR');
      v.setValueForMode(modeId, hexToRgb(hex));
      count++;
    }
  });
});
count
`;
    try {
      const result = figmaUse(`eval "${primitivesCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Primitives (${result?.trim() || '33'} variables)`);
    } catch { spinner.fail('Color - Primitives failed'); }

    // Create Color - Semantic
    spinner = ora('Creating Color - Semantic...').start();
    const semanticCode = `
const colors = ${JSON.stringify(idsSemanticColors)};
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}
let col = figma.variables.getLocalVariableCollections().find(c => c.name === 'Color - Semantic');
if (!col) col = figma.variables.createVariableCollection('Color - Semantic');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(colors).forEach(([name, hex]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col.id, 'COLOR');
    v.setValueForMode(modeId, hexToRgb(hex));
    count++;
  }
});
count
`;
    try {
      const result = figmaUse(`eval "${semanticCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Color - Semantic (${result?.trim() || '13'} variables)`);
    } catch { spinner.fail('Color - Semantic failed'); }

    // Create Spacing
    spinner = ora('Creating Spacing...').start();
    const spacingCode = `
const spacings = ${JSON.stringify(idsSpacing)};
let col = figma.variables.getLocalVariableCollections().find(c => c.name === 'Spacing');
if (!col) col = figma.variables.createVariableCollection('Spacing');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(spacings).forEach(([name, value]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col.id, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
});
count
`;
    try {
      const result = figmaUse(`eval "${spacingCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Spacing (${result?.trim() || '7'} variables)`);
    } catch { spinner.fail('Spacing failed'); }

    // Create Typography
    spinner = ora('Creating Typography...').start();
    const typographyCode = `
const typography = ${JSON.stringify(idsTypography)};
let col = figma.variables.getLocalVariableCollections().find(c => c.name === 'Typography');
if (!col) col = figma.variables.createVariableCollection('Typography');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(typography).forEach(([name, value]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col.id, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
});
count
`;
    try {
      const result = figmaUse(`eval "${typographyCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      spinner.succeed(`Typography (${result?.trim() || '12'} variables)`);
    } catch { spinner.fail('Typography failed'); }

    // Create Border Radii
    spinner = ora('Creating Border Radii...').start();
    const radiiCode = `
const radii = ${JSON.stringify(idsRadii)};
let col = figma.variables.getLocalVariableCollections().find(c => c.name === 'Border Radii');
if (!col) col = figma.variables.createVariableCollection('Border Radii');
const modeId = col.modes[0].modeId;
let count = 0;
Object.entries(radii).forEach(([name, value]) => {
  const existing = figma.variables.getLocalVariables().find(v => v.name === name);
  if (!existing) {
    const v = figma.variables.createVariable(name, col.id, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
});
count
`;
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
const f = figma.currentPage.children.find(n => n.name === '${comp.name}' && n.type === 'FRAME');
if (f) {
  const vars = figma.variables.getLocalVariables();
  const findVar = (name) => vars.find(v => v.name === name);
  ${comp.varFill ? `
  const vFill = findVar('${comp.varFill}');
  if (vFill && f.fills && f.fills.length > 0) {
    const fills = JSON.parse(JSON.stringify(f.fills));
    fills[0] = figma.variables.setBoundVariableForPaint(fills[0], 'color', vFill);
    f.fills = fills;
  }` : ''}
  ${comp.varStroke ? `
  const vStroke = findVar('${comp.varStroke}');
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

    const code = `
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const value = '${value}';
let type = '${options.type || ''}';
if (!type) {
  if (value.startsWith('#')) type = 'COLOR';
  else if (!isNaN(parseFloat(value))) type = 'FLOAT';
  else if (value === 'true' || value === 'false') type = 'BOOLEAN';
  else type = 'STRING';
}

let col = figma.variables.getLocalVariableCollections().find(c => c.name === '${options.collection}');
if (!col) col = figma.variables.createVariableCollection('${options.collection}');
const modeId = col.modes[0].modeId;

const v = figma.variables.createVariable('${name}', col.id, type);
let figmaValue = value;
if (type === 'COLOR') figmaValue = hexToRgb(value);
else if (type === 'FLOAT') figmaValue = parseFloat(value);
else if (type === 'BOOLEAN') figmaValue = value === 'true';
v.setValueForMode(modeId, figmaValue);

'Created ' + type.toLowerCase() + ' token: ${name}'
`;

    try {
      const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      console.log(chalk.green(result?.trim() || `✓ Created token: ${name}`));
    } catch (error) {
      console.log(chalk.red(`✗ Failed to create token: ${name}`));
    }
  });

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
  .option('--fill <color>', 'Fill color')
  .option('--radius <n>', 'Corner radius')
  .option('--smart', 'Auto-position to avoid overlaps (default if no -x)')
  .option('-g, --gap <n>', 'Gap for smart positioning', '100')
  .action((name, options) => {
    checkConnection();
    // Smart positioning: if no X specified, auto-position
    const useSmartPos = options.smart || options.x === undefined;
    if (useSmartPos) {
      const { r, g, b } = options.fill ? hexToRgb(options.fill) : { r: 1, g: 1, b: 1 };
      let code = `
${smartPosCode(options.gap)}
const frame = figma.createFrame();
frame.name = '${name}';
frame.x = smartX;
frame.y = ${options.y};
frame.resize(${options.width}, ${options.height});
${options.fill ? `frame.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];` : ''}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
'${name} created at (' + smartX + ', ${options.y})'
`;
      figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
    } else {
      let cmd = `create frame --name "${name}" --x ${options.x} --y ${options.y} --width ${options.width} --height ${options.height}`;
      if (options.fill) cmd += ` --fill "${options.fill}"`;
      if (options.radius) cmd += ` --radius ${options.radius}`;
      figmaUse(cmd);
    }
  });

create
  .command('icon <name>')
  .description('Create an icon from Iconify (e.g., lucide:star, mdi:home) - auto-positions')
  .option('-s, --size <n>', 'Size', '24')
  .option('-c, --color <color>', 'Color', '#000000')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action((name, options) => {
    checkConnection();
    const useSmartPos = options.x === undefined;
    if (useSmartPos) {
      // First create icon at 0,0, then move it to smart position
      const code = `
${smartPosCode(options.spacing)}
const icon = figma.currentPage.selection[0];
if (icon) {
  icon.x = smartX;
  icon.y = ${options.y};
  'Icon moved to (' + smartX + ', ${options.y})';
} else {
  'No icon selected';
}
`;
      figmaUse(`create icon ${name} --size ${options.size} --color "${options.color}"`);
      // Move to smart position after creation
      setTimeout(() => {
        figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
      }, 500);
    } else {
      figmaUse(`create icon ${name} --size ${options.size} --color "${options.color}" -x ${options.x} -y ${options.y}`);
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
    checkConnection();
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
      const tempFile = '/tmp/figma-cli-screenshot.png';

      // Build capture-website command
      let cmd = `npx --yes capture-website-cli "${url}" --output="${tempFile}" --width=${options.width} --height=${options.height} --scale-factor=${options.scale}`;
      if (options.full) cmd += ' --full-page';
      cmd += ' --overwrite';

      // Take screenshot
      execSync(cmd, { stdio: 'ignore', timeout: 60000 });

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

  await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  ${options.screenshot ? "await page.screenshot({ path: '/tmp/analyze-screenshot.png' });" : ''}
  await browser.close();
})();
`;

      // Write and run script
      const scriptPath = '/tmp/figma-analyze-url.js';
      writeFileSync(scriptPath, script);

      const result = execSync(`cd /tmp && node figma-analyze-url.js`, {
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

  await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 60000 });
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

      const scriptPath = '/tmp/figma-recreate-analyze.js';
      writeFileSync(scriptPath, analyzeScript);

      const analysisResult = execSync('cd /tmp && node figma-recreate-analyze.js', {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      });

      const data = JSON.parse(analysisResult);
      spinner.text = 'Generating Figma code...';

      // Step 2: Generate Figma code
      const hexToRgb = (hex) => {
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
  main.fills = [{ type: "SOLID", color: ${hexToRgb(data.bodyBg)} }];
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
  t${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.color)} }];
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
  btn${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.bgColor)} }];
  ${el.borderWidth > 0 ? `btn${i}.strokes = [{ type: "SOLID", color: ${hexToRgb(el.borderColor)} }]; btn${i}.strokeWeight = ${el.borderWidth};` : ''}
  btn${i}.layoutMode = "HORIZONTAL";
  btn${i}.primaryAxisAlignItems = "CENTER";
  btn${i}.counterAxisAlignItems = "CENTER";
  const btnTxt${i} = figma.createText();
  btnTxt${i}.fontName = getFont("${fontFamily}", "${fontStyle}");
  btnTxt${i}.characters = "${text}";
  btnTxt${i}.fontSize = ${el.fontSize || 14};
  btnTxt${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.color)} }];
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
  input${i}.fills = [{ type: "SOLID", color: ${hexToRgb(el.bgColor)} }];
  ${el.borderWidth > 0 ? `input${i}.strokes = [{ type: "SOLID", color: ${hexToRgb(el.borderColor)} }]; input${i}.strokeWeight = ${el.borderWidth};` : ''}
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

      // Step 3: Execute via daemon (fast) or figma-use (fallback)
      spinner.text = 'Creating in Figma...';

      if (isDaemonRunning()) {
        await daemonExec('eval', { code: figmaCode });
      } else {
        const figmaScriptPath = '/tmp/figma-recreate-build.js';
        writeFileSync(figmaScriptPath, figmaCode);
        execSync(`npx figma-use eval "$(cat ${figmaScriptPath})"`, { stdio: 'pipe', timeout: 60000 });
      }

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
      const tempInput = '/tmp/figma-cli-removebg-input.png';

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

// ============ CONFIG ============

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g., removebgApiKey)')
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
  .option('--fill <color>', 'Fill color', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity 0-1')
  .action((name, options) => {
    checkConnection();
    const rectName = name || 'Rectangle';
    const { r, g, b } = hexToRgb(options.fill);
    const useSmartPos = options.x === undefined;
    let code = `
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const rect = figma.createRectangle();
rect.name = '${rectName}';
rect.x = smartX;
rect.y = ${options.y};
rect.resize(${options.width}, ${options.height});
rect.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];
${options.radius ? `rect.cornerRadius = ${options.radius};` : ''}
${options.opacity ? `rect.opacity = ${options.opacity};` : ''}
${options.stroke ? `rect.strokes = [{ type: 'SOLID', color: { r: ${hexToRgb(options.stroke).r}, g: ${hexToRgb(options.stroke).g}, b: ${hexToRgb(options.stroke).b} } }]; rect.strokeWeight = 1;` : ''}
figma.currentPage.selection = [rect];
'${rectName} created at (' + smartX + ', ${options.y})'
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('ellipse [name]')
  .alias('circle')
  .description('Create an ellipse/circle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width (diameter)', '100')
  .option('-h, --height <n>', 'Height (same as width for circle)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color')
  .action((name, options) => {
    checkConnection();
    const ellipseName = name || 'Ellipse';
    const height = options.height || options.width;
    const { r, g, b } = hexToRgb(options.fill);
    const useSmartPos = options.x === undefined;
    let code = `
${useSmartPos ? smartPosCode(100) : `const smartX = ${options.x};`}
const ellipse = figma.createEllipse();
ellipse.name = '${ellipseName}';
ellipse.x = smartX;
ellipse.y = ${options.y};
ellipse.resize(${options.width}, ${height});
ellipse.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];
${options.stroke ? `ellipse.strokes = [{ type: 'SOLID', color: { r: ${hexToRgb(options.stroke).r}, g: ${hexToRgb(options.stroke).g}, b: ${hexToRgb(options.stroke).b} } }]; ellipse.strokeWeight = 1;` : ''}
figma.currentPage.selection = [ellipse];
'${ellipseName} created at (' + smartX + ', ${options.y})'
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('text <content>')
  .description('Create a text layer (smart positions by default)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .option('-c, --color <color>', 'Text color', '#000000')
  .option('-w, --weight <weight>', 'Font weight: regular, medium, semibold, bold', 'regular')
  .option('--font <family>', 'Font family', 'Inter')
  .option('--width <n>', 'Text box width (auto-width if not set)')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action((content, options) => {
    checkConnection();
    const { r, g, b } = hexToRgb(options.color);
    const weightMap = { regular: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' };
    const fontStyle = weightMap[options.weight.toLowerCase()] || 'Regular';
    const useSmartPos = options.x === undefined;
    let code = `
(async function() {
  ${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
  await figma.loadFontAsync({ family: '${options.font}', style: '${fontStyle}' });
  const text = figma.createText();
  text.fontName = { family: '${options.font}', style: '${fontStyle}' };
  text.characters = '${content.replace(/'/g, "\\'")}';
  text.fontSize = ${options.size};
  text.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];
  text.x = smartX;
  text.y = ${options.y};
  ${options.width ? `text.resize(${options.width}, text.height); text.textAutoResize = 'HEIGHT';` : ''}
  figma.currentPage.selection = [text];
  return 'Text created at (' + smartX + ', ${options.y})';
})()
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

create
  .command('line')
  .description('Create a line (smart positions by default)')
  .option('--x1 <n>', 'Start X (auto if not set)')
  .option('--y1 <n>', 'Start Y', '0')
  .option('--x2 <n>', 'End X (auto + length if x1 not set)')
  .option('--y2 <n>', 'End Y', '0')
  .option('-l, --length <n>', 'Line length', '100')
  .option('-c, --color <color>', 'Line color', '#000000')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action((options) => {
    checkConnection();
    const { r, g, b } = hexToRgb(options.color);
    const useSmartPos = options.x1 === undefined;
    const lineLength = parseFloat(options.length);
    let code = `
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x1};`}
const line = figma.createLine();
line.x = smartX;
line.y = ${options.y1};
line.resize(${useSmartPos ? lineLength : `Math.abs(${options.x2 || options.x1 + '+' + lineLength} - ${options.x1}) || ${lineLength}`}, 0);
${options.x2 && options.x1 ? `line.rotation = Math.atan2(${options.y2} - ${options.y1}, ${options.x2} - ${options.x1}) * 180 / Math.PI;` : ''}
line.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];
line.strokeWeight = ${options.weight};
figma.currentPage.selection = [line];
'Line created at (' + smartX + ', ${options.y1}) with length ${lineLength}'
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
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
  comp.name = '${compName}';
  figma.currentPage.selection = [comp];
  'Component created: ' + comp.name;
} else {
  const group = figma.group(sel, figma.currentPage);
  const comp = figma.createComponentFromNode(group);
  comp.name = '${compName}';
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
  group.name = '${groupName}';
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
  .option('--fill <color>', 'Fill color')
  .option('--radius <n>', 'Corner radius')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action((name, options) => {
    checkConnection();
    const frameName = name || 'Auto Layout';
    const layoutMode = options.direction === 'col' ? 'VERTICAL' : 'HORIZONTAL';
    const useSmartPos = options.x === undefined;
    let code = `
${useSmartPos ? smartPosCode(options.spacing) : `const smartX = ${options.x};`}
const frame = figma.createFrame();
frame.name = '${frameName}';
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
${options.fill ? `frame.fills = [{ type: 'SOLID', color: { r: ${hexToRgb(options.fill).r}, g: ${hexToRgb(options.fill).g}, b: ${hexToRgb(options.fill).b} } }];` : 'frame.fills = [];'}
${options.radius ? `frame.cornerRadius = ${options.radius};` : ''}
figma.currentPage.selection = [frame];
'Auto-layout frame created at (' + smartX + ', ${options.y})'
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ CANVAS ============

const canvas = program
  .command('canvas')
  .description('Canvas awareness and smart positioning');

canvas
  .command('info')
  .description('Show canvas info (bounds, element count, free space)')
  .action(() => {
    checkConnection();
    let code = `
const children = figma.currentPage.children;
if (children.length === 0) {
  JSON.stringify({ empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 });
} else {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  children.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  JSON.stringify({
    elements: children.length,
    bounds: { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
    nextX: Math.round(maxX + 100),
    nextY: 0,
    frames: children.filter(n => n.type === 'FRAME').length,
    components: children.filter(n => n.type === 'COMPONENT').length
  }, null, 2);
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

canvas
  .command('next')
  .description('Get next free position on canvas (no overlap)')
  .option('-g, --gap <n>', 'Gap from existing elements', '100')
  .option('-d, --direction <dir>', 'Direction: right, below', 'right')
  .action((options) => {
    checkConnection();
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
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
const v = figma.variables.getLocalVariables().find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) 'Variable not found: ${varName}';
else if (nodes.length === 0) 'No node selected';
else {
  nodes.forEach(n => {
    if ('fills' in n && n.fills.length > 0) {
      const newFill = figma.variables.setBoundVariableForPaint(n.fills[0], 'color', v);
      n.fills = [newFill];
    }
  });
  'Bound ' + v.name + ' to fill on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('stroke <varName>')
  .description('Bind color variable to stroke')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
const v = figma.variables.getLocalVariables().find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) 'Variable not found: ${varName}';
else if (nodes.length === 0) 'No node selected';
else {
  nodes.forEach(n => {
    if ('strokes' in n) {
      const stroke = n.strokes[0] || { type: 'SOLID', color: {r:0,g:0,b:0} };
      const newStroke = figma.variables.setBoundVariableForPaint(stroke, 'color', v);
      n.strokes = [newStroke];
    }
  });
  'Bound ' + v.name + ' to stroke on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('radius <varName>')
  .description('Bind number variable to corner radius')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
const v = figma.variables.getLocalVariables().find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) 'Variable not found: ${varName}';
else if (nodes.length === 0) 'No node selected';
else {
  nodes.forEach(n => {
    if ('cornerRadius' in n) n.setBoundVariable('cornerRadius', v);
  });
  'Bound ' + v.name + ' to radius on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('gap <varName>')
  .description('Bind number variable to auto-layout gap')
  .option('-n, --node <id>', 'Node ID')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
const v = figma.variables.getLocalVariables().find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) 'Variable not found: ${varName}';
else if (nodes.length === 0) 'No node selected';
else {
  nodes.forEach(n => {
    if ('itemSpacing' in n) n.setBoundVariable('itemSpacing', v);
  });
  'Bound ' + v.name + ' to gap on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('padding <varName>')
  .description('Bind number variable to padding')
  .option('-n, --node <id>', 'Node ID')
  .option('-s, --side <side>', 'Side: top, right, bottom, left, all', 'all')
  .action((varName, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    const sides = options.side === 'all'
      ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
      : [`padding${options.side.charAt(0).toUpperCase() + options.side.slice(1)}`];
    let code = `
${nodeSelector}
const v = figma.variables.getLocalVariables().find(v => v.name === '${varName}' || v.name.endsWith('/${varName}'));
if (!v) 'Variable not found: ${varName}';
else if (nodes.length === 0) 'No node selected';
else {
  const sides = ${JSON.stringify(sides)};
  nodes.forEach(n => {
    sides.forEach(side => { if (side in n) n.setBoundVariable(side, v); });
  });
  'Bound ' + v.name + ' to padding on ' + nodes.length + ' elements';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

bind
  .command('list')
  .description('List available variables for binding')
  .option('-t, --type <type>', 'Filter: COLOR, FLOAT')
  .action((options) => {
    checkConnection();
    let code = `
const vars = figma.variables.getLocalVariables();
const filtered = vars${options.type ? `.filter(v => v.resolvedType === '${options.type.toUpperCase()}')` : ''};
filtered.map(v => v.resolvedType.padEnd(8) + ' ' + v.name).join('\\n') || 'No variables';
`;
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
  .action((options) => {
    checkConnection();
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
  .action((options) => {
    checkConnection();
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
  .action((width, height) => {
    checkConnection();
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
  .action((value, r, b, l) => {
    checkConnection();
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
  .action((value) => {
    checkConnection();
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
  .action((alignment) => {
    checkConnection();
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
  .action((nodeId) => {
    checkConnection();
    figmaUse(`select "${nodeId}"`);
  });

// ============ DELETE ============

program
  .command('delete [nodeId]')
  .alias('remove')
  .description('Delete node by ID or current selection')
  .action((nodeId) => {
    checkConnection();
    if (nodeId) {
      let code = `
const node = figma.getNodeById('${nodeId}');
if (node) { node.remove(); 'Deleted: ${nodeId}'; } else { 'Node not found: ${nodeId}'; }
`;
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
  .action((nodeId, options) => {
    checkConnection();
    if (nodeId) {
      let code = `
const node = figma.getNodeById('${nodeId}');
if (node) { const clone = node.clone(); clone.x += ${options.offset}; clone.y += ${options.offset}; figma.currentPage.selection = [clone]; 'Duplicated: ' + clone.id; } else { 'Node not found'; }
`;
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
  .description('Set fill color')
  .option('-n, --node <id>', 'Node ID (uses selection if not set)')
  .action((color, options) => {
    checkConnection();
    const { r, g, b } = hexToRgb(color);
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('fills' in n) n.fills = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; }); 'Fill set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('stroke <color>')
  .description('Set stroke color')
  .option('-n, --node <id>', 'Node ID')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .action((color, options) => {
    checkConnection();
    const { r, g, b } = hexToRgb(color);
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('strokes' in n) { n.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; n.strokeWeight = ${options.weight}; } }); 'Stroke set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('radius <value>')
  .description('Set corner radius')
  .option('-n, --node <id>', 'Node ID')
  .action((value, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
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
  .action((width, height, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { if ('resize' in n) n.resize(${width}, ${height}); }); 'Size set on ' + nodes.length + ' elements'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('pos <x> <y>')
  .alias('position')
  .description('Set position')
  .option('-n, --node <id>', 'Node ID')
  .action((x, y, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
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
  .action((value, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
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
  .action((name, options) => {
    checkConnection();
    const nodeSelector = options.node
      ? `const nodes = [figma.getNodeById('${options.node}')].filter(Boolean);`
      : `const nodes = figma.currentPage.selection;`;
    let code = `
${nodeSelector}
if (nodes.length === 0) 'No node found';
else { nodes.forEach(n => { n.name = '${name}'; }); 'Renamed ' + nodes.length + ' elements to ${name}'; }
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

set
  .command('autolayout <direction>')
  .alias('al')
  .description('Apply auto-layout to selection (row/col)')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Padding')
  .action((direction, options) => {
    checkConnection();
    const layoutMode = direction === 'col' || direction === 'vertical' ? 'VERTICAL' : 'HORIZONTAL';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else {
  sel.forEach(n => {
    if (n.type === 'FRAME' || n.type === 'COMPONENT') {
      n.layoutMode = '${layoutMode}';
      n.primaryAxisSizingMode = 'AUTO';
      n.counterAxisSizingMode = 'AUTO';
      n.itemSpacing = ${options.gap};
      ${options.padding ? `n.paddingTop = n.paddingRight = n.paddingBottom = n.paddingLeft = ${options.padding};` : ''}
    }
  });
  'Auto-layout applied to ' + sel.length + ' frames';
}
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ ARRANGE ============

program
  .command('arrange')
  .description('Arrange frames on canvas')
  .option('-g, --gap <n>', 'Gap between frames', '100')
  .option('-c, --cols <n>', 'Number of columns (0 = single row)', '0')
  .action((options) => {
    checkConnection();
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
  .action((nodeId) => {
    checkConnection();
    const nodeSelector = nodeId
      ? `const node = figma.getNodeById('${nodeId}');`
      : `const node = figma.currentPage.selection[0];`;
    let code = `
${nodeSelector}
if (!node) 'No node found';
else JSON.stringify({
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
}, null, 2)
`;
    figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: false });
  });

// ============ FIND ============

program
  .command('find <name>')
  .description('Find nodes by name (partial match)')
  .option('-t, --type <type>', 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)')
  .option('-l, --limit <n>', 'Limit results', '20')
  .action((name, options) => {
    checkConnection();
    let code = `(function() {
const results = [];
function search(node) {
  if (node.name && node.name.toLowerCase().includes('${name.toLowerCase()}')) {
    ${options.type ? `if (node.type === '${options.type.toUpperCase()}')` : ''}
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

// ============ RENDER ============

// Helper: Get next free X position for smart positioning (horizontal)
function getNextFreeX(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxX = 0;
      figma.currentPage.children.forEach(n => {
        maxX = Math.max(maxX, n.x + n.width);
      });
      return maxX;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

// Helper: Get next free Y position for smart positioning (vertical)
function getNextFreeY(gap = 100) {
  try {
    const result = figmaEvalSync(`(function() {
      let maxY = 0;
      figma.currentPage.children.forEach(n => {
        maxY = Math.max(maxY, n.y + n.height);
      });
      return maxY;
    })()`);
    return (result || 0) + gap;
  } catch {
    return 0;
  }
}

program
  .command('render <jsx>')
  .description('Render JSX to Figma (uses figma-use render)')
  .option('--parent <id>', 'Parent node ID')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .action(async (jsx, options) => {
    await checkConnection();
    try {
      // Calculate smart position if not specified
      let posX = options.x;
      let posY = options.y !== undefined ? options.y : 0;

      if (!options.parent && options.x === undefined && options.smartPosition !== false) {
        posX = getNextFreeX();
      }

      // Use figma-use render directly - it has full JSX support
      let cmd = 'npx figma-use render --stdin --json';
      if (options.parent) cmd += ` --parent "${options.parent}"`;
      if (posX !== undefined) cmd += ` --x ${posX}`;
      cmd += ` --y ${posY}`;

      const output = execSync(cmd, {
        input: jsx,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000
      });

      const result = JSON.parse(output.trim());
      console.log(chalk.green('✓ Rendered: ' + result.id));
      if (result.name) console.log(chalk.gray('  name: ' + result.name));
    } catch (e) {
      console.log(chalk.red('✗ Render failed: ' + (e.stderr || e.message)));
    }
  });

program
  .command('render-batch')
  .description('Render multiple JSX frames (uses figma-use render)')
  .argument('<jsxArray>', 'JSON array of JSX strings, e.g. \'["<Frame>...</Frame>","<Frame>...</Frame>"]\'')
  .option('-g, --gap <n>', 'Gap between frames', '40')
  .option('-d, --direction <dir>', 'Layout direction: row (horizontal) or col (vertical)', 'row')
  .action(async (jsxArrayStr, options) => {
    await checkConnection();
    try {
      const jsxArray = JSON.parse(jsxArrayStr);
      if (!Array.isArray(jsxArray)) {
        throw new Error('Argument must be a JSON array of JSX strings');
      }

      const gap = parseInt(options.gap) || 40;
      const vertical = options.direction === 'col' || options.direction === 'column' || options.direction === 'vertical';
      let currentX = vertical ? 0 : getNextFreeX(gap);
      let currentY = vertical ? getNextFreeY(gap) : 0;
      let results = [];

      for (const jsx of jsxArray) {
        try {
          const cmd = `npx figma-use render --stdin --json --x ${currentX} --y ${currentY}`;
          const output = execSync(cmd, {
            input: jsx,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000
          });

          const result = JSON.parse(output.trim());
          results.push(result);
          console.log(chalk.green('✓ Rendered: ' + result.id + (result.name ? ' (' + result.name + ')' : '')));

          // Get size of created frame for next position
          try {
            if (vertical) {
              const height = figmaEvalSync(`(function() { const n = figma.getNodeById('${result.id}'); return n ? n.height : 200; })()`);
              currentY += (height || 200) + gap;
            } else {
              const width = figmaEvalSync(`(function() { const n = figma.getNodeById('${result.id}'); return n ? n.width : 300; })()`);
              currentX += (width || 300) + gap;
            }
          } catch {
            if (vertical) currentY += 200 + gap;
            else currentX += 300 + gap;
          }
        } catch (err) {
          console.log(chalk.red('✗ Failed to render: ' + (err.stderr || err.message)));
        }
      }

      console.log(chalk.cyan(`\n${results.length} frames created`));
    } catch (e) {
      console.log(chalk.red('✗ Batch render failed: ' + e.message));
    }
  });

// ============ EXPORT ============

const exp = program
  .command('export')
  .description('Export from Figma');

exp
  .command('screenshot')
  .description('Take a screenshot')
  .option('-o, --output <file>', 'Output file', 'screenshot.png')
  .action((options) => {
    checkConnection();
    figmaUse(`export screenshot --output "${options.output}"`);
  });

exp
  .command('css')
  .description('Export variables as CSS custom properties')
  .action(() => {
    checkConnection();
    const code = `
const vars = figma.variables.getLocalVariables();
const css = vars.map(v => {
  const val = Object.values(v.valuesByMode)[0];
  if (v.resolvedType === 'COLOR') {
    const hex = '#' + [val.r, val.g, val.b].map(n => Math.round(n*255).toString(16).padStart(2,'0')).join('');
    return '  --' + v.name.replace(/\\//g, '-') + ': ' + hex + ';';
  }
  return '  --' + v.name.replace(/\\//g, '-') + ': ' + val + (v.resolvedType === 'FLOAT' ? 'px' : '') + ';';
}).join('\\n');
':root {\\n' + css + '\\n}'
`;
    const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
    console.log(result);
  });

exp
  .command('tailwind')
  .description('Export color variables as Tailwind config')
  .action(() => {
    checkConnection();
    const code = `
const vars = figma.variables.getLocalVariables().filter(v => v.resolvedType === 'COLOR');
const colors = {};
vars.forEach(v => {
  const val = Object.values(v.valuesByMode)[0];
  const hex = '#' + [val.r, val.g, val.b].map(n => Math.round(n*255).toString(16).padStart(2,'0')).join('');
  const parts = v.name.split('/');
  if (parts.length === 2) {
    if (!colors[parts[0]]) colors[parts[0]] = {};
    colors[parts[0]][parts[1]] = hex;
  } else {
    colors[v.name.replace(/\\//g, '-')] = hex;
  }
});
JSON.stringify({ theme: { extend: { colors } } }, null, 2)
`;
    const result = figmaUse(`eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { silent: true });
    console.log(result);
  });

// ============ EVAL ============

program
  .command('eval [code]')
  .description('Execute JavaScript in Figma plugin context')
  .option('-f, --file <path>', 'Run code from file instead of argument')
  .action((code, options) => {
    checkConnection();
    let jsCode = code;

    // If --file option provided, read code from file
    if (options.file) {
      if (!existsSync(options.file)) {
        console.log(chalk.red('✗ File not found: ' + options.file));
        return;
      }
      jsCode = readFileSync(options.file, 'utf8');
    }

    if (!jsCode) {
      console.log(chalk.red('✗ No code provided. Use: eval "code" or eval --file /path/to/script.js'));
      return;
    }

    figmaUse(`eval "${jsCode.replace(/"/g, '\\"')}"`);
  });

// Run command - alias for eval --file
program
  .command('run <file>')
  .description('Run JavaScript file in Figma (alias for eval --file)')
  .action((file) => {
    checkConnection();
    if (!existsSync(file)) {
      console.log(chalk.red('✗ File not found: ' + file));
      return;
    }
    const code = readFileSync(file, 'utf8');
    figmaUse(`eval "${code.replace(/"/g, '\\"')}"`);
  });

// ============ PASSTHROUGH ============

program
  .command('raw <command...>')
  .description('Run raw figma-use command')
  .action((command) => {
    checkConnection();
    figmaUse(command.join(' '));
  });

// ============ DESIGN ANALYSIS (figma-use) ============

program
  .command('lint')
  .description('Lint design for issues (figma-use)')
  .option('--fix', 'Auto-fix issues where possible')
  .option('--rule <rule>', 'Run specific rule (can be repeated)', (val, prev) => prev ? [...prev, val] : [val])
  .option('--preset <preset>', 'Preset: recommended, strict, accessibility, design-system')
  .option('--json', 'Output as JSON')
  .action((options) => {
    checkConnection();
    let cmd = 'npx figma-use lint';
    if (options.fix) cmd += ' --fix';
    if (options.rule) options.rule.forEach(r => cmd += ` --rule ${r}`);
    if (options.preset) cmd += ` --preset ${options.preset}`;
    if (options.json) cmd += ' --json';
    try {
      execSync(cmd, { stdio: 'inherit', timeout: 60000 });
    } catch (error) {
      // figma-use exits with error if issues found, that's ok
    }
  });

const analyze = program
  .command('analyze')
  .description('Analyze design (colors, typography, spacing, clusters)');

analyze
  .command('colors')
  .description('Analyze color usage')
  .option('--json', 'Output as JSON')
  .action((options) => {
    checkConnection();
    let cmd = 'npx figma-use analyze colors';
    if (options.json) cmd += ' --json';
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

analyze
  .command('typography')
  .alias('type')
  .description('Analyze typography usage')
  .option('--json', 'Output as JSON')
  .action((options) => {
    checkConnection();
    let cmd = 'npx figma-use analyze typography';
    if (options.json) cmd += ' --json';
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

analyze
  .command('spacing')
  .description('Analyze spacing (gap/padding) usage')
  .option('--json', 'Output as JSON')
  .action((options) => {
    checkConnection();
    let cmd = 'npx figma-use analyze spacing';
    if (options.json) cmd += ' --json';
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

analyze
  .command('clusters')
  .description('Find repeated patterns (potential components)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    checkConnection();
    let cmd = 'npx figma-use analyze clusters';
    if (options.json) cmd += ' --json';
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

// ============ NODE OPERATIONS (figma-use) ============

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .action((nodeId, options) => {
    checkConnection();
    let cmd = 'npx figma-use node tree';
    if (nodeId) cmd += ` "${nodeId}"`;
    cmd += ` --depth ${options.depth}`;
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .action((nodeId) => {
    checkConnection();
    let cmd = 'npx figma-use node bindings';
    if (nodeId) cmd += ` "${nodeId}"`;
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .action((nodeIds) => {
    checkConnection();
    const cmd = `npx figma-use node to-component "${nodeIds.join(' ')}"`;
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action((nodeIds) => {
    checkConnection();
    const cmd = `npx figma-use node delete "${nodeIds.join(' ')}"`;
    execSync(cmd, { stdio: 'inherit', timeout: 60000 });
  });

// ============ EXPORT (figma-use) ============

program
  .command('export-jsx [nodeId]')
  .description('Export node as JSX/React code')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .option('--pretty', 'Format output')
  .option('--match-icons', 'Match vectors to Iconify icons')
  .action((nodeId, options) => {
    checkConnection();
    let cmd = 'npx figma-use export jsx';
    if (nodeId) cmd += ` "${nodeId}"`;
    if (options.pretty) cmd += ' --pretty';
    if (options.matchIcons) cmd += ' --match-icons';
    if (options.output) {
      cmd += ` > "${options.output}"`;
      execSync(cmd, { shell: true, stdio: 'inherit', timeout: 60000 });
    } else {
      execSync(cmd, { stdio: 'inherit', timeout: 60000 });
    }
  });

program
  .command('export-storybook [nodeId]')
  .description('Export components as Storybook stories')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .action((nodeId, options) => {
    checkConnection();
    let cmd = 'npx figma-use export storybook';
    if (nodeId) cmd += ` "${nodeId}"`;
    if (options.output) {
      cmd += ` > "${options.output}"`;
      execSync(cmd, { shell: true, stdio: 'inherit', timeout: 60000 });
    } else {
      execSync(cmd, { stdio: 'inherit', timeout: 60000 });
    }
  });

// ============ FIGJAM ============

const figjam = program
  .command('figjam')
  .alias('fj')
  .description('FigJam commands (sticky notes, shapes, connectors)');

// Helper: Get FigJam client
async function getFigJamClient(pageTitle) {
  const client = new FigJamClient();
  try {
    const pages = await FigJamClient.listPages();
    if (pages.length === 0) {
      console.log(chalk.red('\n✗ No FigJam pages open\n'));
      console.log(chalk.gray('  Open a FigJam file in Figma Desktop first.\n'));
      process.exit(1);
    }

    const targetPage = pageTitle || pages[0].title;
    await client.connect(targetPage);
    return client;
  } catch (error) {
    console.log(chalk.red('\n✗ ' + error.message + '\n'));
    process.exit(1);
  }
}

figjam
  .command('list')
  .description('List open FigJam pages')
  .action(async () => {
    try {
      const pages = await FigJamClient.listPages();
      if (pages.length === 0) {
        console.log(chalk.yellow('\n  No FigJam pages open\n'));
        return;
      }
      console.log(chalk.cyan('\n  Open FigJam Pages:\n'));
      pages.forEach((p, i) => {
        console.log(chalk.white(`  ${i + 1}. ${p.title}`));
      });
      console.log();
    } catch (error) {
      console.log(chalk.red('\n✗ Could not connect to Figma\n'));
      console.log(chalk.gray('  Make sure Figma is running with: figma-ds-cli connect\n'));
    }
  });

figjam
  .command('info')
  .description('Show current FigJam page info')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const info = await client.getPageInfo();
      console.log(chalk.cyan('\n  FigJam Page Info:\n'));
      console.log(chalk.white(`  Name: ${info.name}`));
      console.log(chalk.white(`  ID: ${info.id}`));
      console.log(chalk.white(`  Elements: ${info.childCount}`));
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('nodes')
  .description('List nodes on current FigJam page')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-l, --limit <n>', 'Limit number of nodes', '20')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const nodes = await client.listNodes(parseInt(options.limit));
      if (nodes.length === 0) {
        console.log(chalk.yellow('\n  No elements on this page\n'));
        return;
      }
      console.log(chalk.cyan('\n  FigJam Elements:\n'));
      nodes.forEach(n => {
        const type = n.type.padEnd(16);
        const name = (n.name || '(unnamed)').substring(0, 30);
        console.log(chalk.gray(`  ${n.id.padEnd(8)}`), chalk.white(type), chalk.gray(name), chalk.gray(`(${n.x}, ${n.y})`));
      });
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('sticky <text>')
  .description('Create a sticky note')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-c, --color <hex>', 'Background color')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating sticky note...').start();
    try {
      const result = await client.createSticky(text, parseFloat(options.x), parseFloat(options.y), options.color);
      spinner.succeed(`Sticky created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create sticky: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('shape <text>')
  .description('Create a shape with text')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-w, --width <n>', 'Width', '200')
  .option('-h, --height <n>', 'Height', '100')
  .option('-t, --type <type>', 'Shape type (ROUNDED_RECTANGLE, RECTANGLE, ELLIPSE, DIAMOND)', 'ROUNDED_RECTANGLE')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating shape...').start();
    try {
      const result = await client.createShape(
        text,
        parseFloat(options.x),
        parseFloat(options.y),
        parseFloat(options.width),
        parseFloat(options.height),
        options.type
      );
      spinner.succeed(`Shape created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create shape: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('text <content>')
  .description('Create a text node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .action(async (content, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating text...').start();
    try {
      const result = await client.createText(content, parseFloat(options.x), parseFloat(options.y), parseFloat(options.size));
      spinner.succeed(`Text created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('connect <startId> <endId>')
  .description('Create a connector between two nodes')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (startId, endId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating connector...').start();
    try {
      const result = await client.createConnector(startId, endId);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Connector created: ${result.id}`);
      }
    } catch (error) {
      spinner.fail('Failed to create connector: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('delete <nodeId>')
  .description('Delete a node by ID')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Deleting node...').start();
    try {
      const result = await client.deleteNode(nodeId);
      if (result.deleted) {
        spinner.succeed(`Node ${nodeId} deleted`);
      } else {
        spinner.fail(result.error || 'Node not found');
      }
    } catch (error) {
      spinner.fail('Failed to delete node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('move <nodeId> <x> <y>')
  .description('Move a node to a new position')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, x, y, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Moving node...').start();
    try {
      const result = await client.moveNode(nodeId, parseFloat(x), parseFloat(y));
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} moved to (${result.x}, ${result.y})`);
      }
    } catch (error) {
      spinner.fail('Failed to move node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('update <nodeId> <text>')
  .description('Update text content of a node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Updating text...').start();
    try {
      const result = await client.updateText(nodeId, text);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} text updated`);
      }
    } catch (error) {
      spinner.fail('Failed to update text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('eval <code>')
  .description('Execute JavaScript in FigJam context')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (code, options) => {
    const client = await getFigJamClient(options.page);
    try {
      const result = await client.eval(code);
      if (result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (error) {
      console.log(chalk.red('Error: ' + error.message));
    } finally {
      client.close();
    }
  });

program.parse();
