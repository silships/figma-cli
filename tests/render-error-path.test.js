import { describe, it } from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { FigmaClient } from '../src/figma-client.js';

// A permissive stand-in for the Plugin API: every property is a callable,
// awaitable, iterable no-op, so the generated render code runs end to end
// until the instance helper throws.
function stub() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'length') return 0;
      return stub();
    },
    apply: () => stub(),
    set: () => true,
  });
}

// The render code installs the real helpers, so the error comes from the
// real variant lookup against this Tag set (3 states, no "disabled").
const tagSet = {
  type: 'COMPONENT_SET',
  name: 'Tag',
  children: ['default', 'hover', 'active'].map(s => ({ type: 'COMPONENT', name: 'State=' + s, variantProperties: { State: s } })),
  variantGroupProperties: { State: { values: ['default', 'hover', 'active'] } },
};

async function runRender(jsx) {
  const removed = [];
  const frame = new Proxy({}, {
    get(t, key) {
      if (key === 'remove') return () => removed.push(true);
      if (key === 'then') return undefined;
      return key in t ? t[key] : stub();
    },
    set(t, key, value) { t[key] = value; return true; },
  });
  const figma = new Proxy({}, {
    get(_, key) {
      if (key === 'createFrame') return () => frame;
      if (key === 'root') return new Proxy({ findAllWithCriteria: () => [tagSet], children: [] }, { get: (t, k) => (k in t ? t[k] : stub()) });
      if (key === 'mixed') return Symbol('mixed');
      if (key === 'then') return undefined;
      return stub();
    },
  });
  const code = await new FigmaClient().parseJSX(jsx);
  const context = vm.createContext({ figma, console });
  let error;
  try { await vm.runInContext(code, context); } catch (e) { error = e; }
  return { error, removed };
}

describe('render error path', () => {
  it('reports the missing variant instead of "frame is not defined"', async () => {
    const { error } = await runRender('<Frame name="Board"><Instance component="Tag" variant="State=disabled" /></Frame>');
    assert.ok(error, 'render should fail');
    assert.doesNotMatch(error.message, /frame is not defined/);
    assert.match(error.message, /No variant of "Tag" matches \{"State":"disabled"\}\. Axes: State=default\|hover\|active/);
    assert.match(error.message, /\[Node: Instance: Tag\]/);
  });

  it('removes the partial frame before rethrowing', async () => {
    const { removed } = await runRender('<Frame name="Board"><Instance component="Tag" variant="State=disabled" /></Frame>');
    assert.strictEqual(removed.length, 1);
  });
});
