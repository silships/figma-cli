import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFileKey, toThreads, pinsOf, pinLabel, resolvePinsCode } from '../src/lib/comments.js';

describe('parseFileKey', () => {
  it('returns a bare key unchanged', () => {
    assert.strictEqual(parseFileKey('AbC123'), 'AbC123');
  });

  it('extracts the key from design, file, proto and board URLs', () => {
    for (const kind of ['design', 'file', 'proto', 'board']) {
      assert.strictEqual(parseFileKey(`https://www.figma.com/${kind}/AbC123/Name?node-id=1-2`), 'AbC123');
    }
  });
});

describe('toThreads', () => {
  const comments = [
    { id: '3', parent_id: '1', created_at: '2026-01-01T10:05:00Z', message: 'second reply' },
    { id: '1', parent_id: '', created_at: '2026-01-01T10:00:00Z', message: 'root A' },
    { id: '2', parent_id: '1', created_at: '2026-01-01T10:01:00Z', message: 'first reply' },
    { id: '4', parent_id: '', created_at: '2025-12-31T09:00:00Z', message: 'root B' }
  ];

  it('groups replies under their root, both oldest first', () => {
    const threads = toThreads(comments);
    assert.deepStrictEqual(threads.map((t) => t.id), ['4', '1']);
    assert.deepStrictEqual(threads[1].replies.map((r) => r.id), ['2', '3']);
    assert.deepStrictEqual(threads[0].replies, []);
  });
});

describe('pinsOf', () => {
  it('keeps only pinned threads and carries the offset', () => {
    const pins = pinsOf([
      { id: 'a', client_meta: { node_id: '1:2', node_offset: { x: 5, y: 6 } } },
      { id: 'b', client_meta: { x: 10, y: 10 } },
      { id: 'c' }
    ]);
    assert.deepStrictEqual(pins, [{ key: 'a', node_id: '1:2', offset: { x: 5, y: 6 } }]);
  });
});

describe('pinLabel', () => {
  it('shows the three innermost ancestors, outer to inner', () => {
    const info = { chain: [{ name: 'Layer' }, { name: 'Card' }, { name: 'Screen' }, { name: 'Board' }] };
    assert.strictEqual(pinLabel(info), 'Screen › Card › Layer');
  });

  it('says so when the pinned node is gone', () => {
    assert.match(pinLabel(null), /not found/);
  });
});

describe('resolvePinsCode', () => {
  it('generates valid JavaScript with the pins inlined as data', () => {
    const code = resolvePinsCode([{ key: 'a', node_id: '1:2', offset: { x: 1, y: 2 } }]);
    assert.doesNotThrow(() => new Function(`return ${code}`));
    assert.ok(code.includes('"node_id":"1:2"'));
  });
});
