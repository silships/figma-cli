import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RULES_BODY, RULES_HASH, RULE_FILES, syncRulesFile, refreshRules } from '../src/lib/agent-rules.js';

const agents = RULE_FILES.find(f => f.rel === 'AGENTS.md');
const dir = () => mkdtempSync(join(tmpdir(), 'rules-'));

test('writes a marked block into a new AGENTS.md', () => {
  const d = dir(); const p = join(d, 'AGENTS.md');
  assert.equal(syncRulesFile(p, agents.fresh).status, 'written');
  const t = readFileSync(p, 'utf8');
  assert.ok(t.includes(RULES_HASH) && t.includes(RULES_BODY));
  assert.equal(syncRulesFile(p, agents.fresh).status, 'up-to-date');
});

test('replaces an outdated block and keeps the user text around it', () => {
  const d = dir(); const p = join(d, 'AGENTS.md');
  writeFileSync(p, 'my intro\n<!-- figma-cli rules 0000000000 -->\n# Using figma-cli\nold\n<!-- /figma-cli rules -->\nmy outro\n');
  assert.equal(syncRulesFile(p, agents.fresh).status, 'updated');
  const t = readFileSync(p, 'utf8');
  assert.ok(t.startsWith('my intro\n') && t.endsWith('my outro\n'));
  assert.ok(t.includes(RULES_HASH) && !t.includes('\nold\n'));
});

test('upgrades a pre-marker copy up to the end of its Handy commands block', () => {
  const d = dir(); const p = join(d, 'AGENTS.md');
  writeFileSync(p, '# Using figma-cli\nold rules\n## Handy commands\n```\nfigma-cli connect\n```\n\n## Our own notes\nkeep me\n');
  assert.equal(syncRulesFile(p, agents.fresh).status, 'updated');
  const t = readFileSync(p, 'utf8');
  assert.ok(t.includes(RULES_HASH) && t.includes('## Our own notes\nkeep me') && !t.includes('old rules'));
});

test('never touches an unrelated AGENTS.md', () => {
  const d = dir(); const p = join(d, 'AGENTS.md');
  writeFileSync(p, '# Team rules\n');
  assert.equal(syncRulesFile(p, agents.fresh).status, 'exists');
  assert.equal(readFileSync(p, 'utf8'), '# Team rules\n');
});

test('refreshRules updates existing copies and creates nothing', () => {
  const d = dir();
  assert.deepEqual(refreshRules(d), []);
  assert.equal(existsSync(join(d, 'AGENTS.md')), false);
  writeFileSync(join(d, 'AGENTS.md'), '<!-- figma-cli rules 0000000000 -->\nold\n<!-- /figma-cli rules -->\n');
  assert.equal(refreshRules(d).length, 1);
});

import { mkdirSync } from 'fs';
import { ensureRules, looksLikeProject } from '../src/lib/agent-rules.js';

test('connect writes AGENTS.md into a project folder that has none', () => {
  const d = dir(); mkdirSync(join(d, '.git'));
  const r = ensureRules(d, { home: '/nonexistent-home' });
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'written');
  assert.ok(readFileSync(join(d, 'AGENTS.md'), 'utf8').includes(RULES_HASH));
  assert.equal(ensureRules(d, { home: '/nonexistent-home' }).length, 0);
});

test('connect never writes outside a project or into the home folder', () => {
  const plain = dir();
  assert.equal(looksLikeProject(plain, '/nonexistent-home'), false);
  assert.equal(ensureRules(plain, { home: '/nonexistent-home' }).length, 0);
  assert.equal(existsSync(join(plain, 'AGENTS.md')), false);
  const home = dir(); mkdirSync(join(home, '.git'));
  assert.equal(ensureRules(home, { home }).length, 0);
  assert.equal(existsSync(join(home, 'AGENTS.md')), false);
});

test('an unrelated AGENTS.md in a project is left alone', () => {
  const d = dir(); writeFileSync(join(d, 'package.json'), '{}'); writeFileSync(join(d, 'AGENTS.md'), '# Team\n');
  assert.equal(ensureRules(d, { home: '/nonexistent-home' }).length, 0);
  assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), '# Team\n');
});
