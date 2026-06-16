#!/usr/bin/env node

// figma-ds-cli entry point. The CLI core (daemon plumbing, eval helpers,
// config, the Commander program) lives in lib/cli-core.js; every command
// group registers itself as an import side effect, in the original order.
import './lib/cli-core.js';
import './commands/setup.js';
import './commands/variables.js';
import './commands/daemon.js';
import './commands/tokens.js';
import './commands/gradient.js';
import './commands/create.js';
import './commands/url-tools.js';
import './commands/config.js';
import './commands/canvas-ops.js';
import './commands/render.js';
import './commands/export-eval.js';
import './commands/analyze.js';
import './commands/a11y.js';
import './commands/node-ops.js';
import './commands/slots.js';
import './commands/figjam.js';
import './commands/variants.js';
import './commands/misc.js';
import './commands/extract.js';
import './commands/spec.js';
import './commands/instantiate.js';
import './commands/init.js';
import { program } from './lib/cli-core.js';

program.parse();
