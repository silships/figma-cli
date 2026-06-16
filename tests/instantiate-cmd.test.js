import { test } from 'node:test';
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
