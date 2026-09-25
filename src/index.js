#!/usr/bin/env node

// figma-ds-cli entry point. The CLI core (daemon plumbing, eval helpers,
// config, the Commander program) lives in lib/cli-core.js; every command group
// registers itself as an import side effect.
//
// Only the module that owns the invoked command is loaded. Importing all 25
// command modules costs ~42ms, and startup dominates a typical command: `eval`
// takes ~140ms end to end, of which ~110ms was process start and module load
// and only ~30ms the actual Figma roundtrip. Skipping the modules a command
// doesn't need takes startup to ~67ms.
//
// Anything unrecognised — --help, an unknown command, no arguments — falls back
// to loading everything, so help output and "did you mean" suggestions stay
// complete. Correctness first, speed only on the path we can be sure about.
import { program } from './lib/cli-core.js';
import { ALL, COMMAND_MODULES } from './lib/command-map.js';
import { runUpdateCheck } from './lib/update-check.js';

const load = (names) =>
  Promise.all(names.map((n) => import(`./commands/${n}.js`)));

// Scan for the first token that names a command, rather than reading argv[2]
// only: global options come BEFORE the command (`figma-cli --port 9222 eval …`),
// and stopping at argv[2] would see `--port` and fall back to loading all 25
// modules. Taking the FIRST match left-to-right is safe because a command always
// precedes its own arguments, so a command name appearing later as an argument
// (`figma-cli find "render"`) can never win over the real command.
const invoked = process.argv.slice(2).find((arg) => COMMAND_MODULES[arg]);
await load(invoked ? COMMAND_MODULES[invoked] : ALL);

// Never awaited on the network: reads a cached answer, refreshes it in a
// detached process at most once a day. See lib/update-check.js.
runUpdateCheck();

program.parse();
