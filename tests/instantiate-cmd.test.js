import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { instantiateCode } from '../src/commands/instantiate.js';

test('instantiateCode is syntactically valid JS for a key+id plan', () => {
  const code = instantiateCode([{ via: 'key', key: 'k' }, { via: 'id', id: '1:2' }]);
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /importComponentByKeyAsync/);
  assert.match(code, /getNodeByIdAsync/);
  assert.match(code, /createInstance/);
  // dynamic-page safe: no legacy sync getNodeById( in the generated code
  assert.doesNotMatch(code, /[^A-Za-z]getNodeById\(/);
});

describe('instantiateCode — bounded steps', () => {
  it('time-bounds every step', () => {
    // figma.importComponentByKeyAsync on a key that was never published NEVER
    // settles (measured: still pending after 2 minutes). Unbounded, the command
    // hangs forever and wedges the daemon behind it, when the right answer is
    // to fall through to the node-id step.
    const code = instantiateCode([{ via: 'key', key: 'abc' }, { via: 'id', id: '1:2' }]);
    assert.match(code, /Promise\.race/);
    assert.match(code, /bounded\(figma\.importComponentByKeyAsync\(step\.key\)/);
    assert.match(code, /bounded\(figma\.getNodeByIdAsync\(step\.id\)/);
  });

  it('embeds the timeout as a number', () => {
    assert.match(instantiateCode([], { timeoutMs: 1234 }), /const TIMEOUT = 1234;/);
  });

  it('keeps trying the remaining steps after a timeout', () => {
    // The catch must stay inside the loop, otherwise a slow library lookup
    // aborts the whole plan instead of falling through to the id.
    const code = instantiateCode([{ via: 'key', key: 'a' }]);
    const loop = code.slice(code.indexOf('for (const step of plan)'));
    assert.match(loop, /catch \(e\) \{ tried\.push/);
  });
});
