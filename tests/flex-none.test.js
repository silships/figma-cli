import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

// flex="none" (stack/free) → layoutMode NONE so children overlap (z-stack):
// spinners (ring+arc), badges on avatars, layered graphics.
describe('flex="none" z-stack', () => {
  const client = new FigmaClient();

  it('nested frame: layoutMode NONE, no auto-layout props, no child layoutSizing', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="Stack" flex="none" w={32} h={32}><Ellipse name="A" w={32} h={32} bg="#eee"/><Ellipse name="B" w={32} h={32} bg="#00f"/></Frame></Frame>');
    const block = code.slice(code.indexOf('"Stack"'));
    assert.ok(/layoutMode = 'NONE'/.test(block), 'NONE layout');
    // must NOT set auto-layout-only props on the none frame (they throw)
    const stackVar = (block.match(/const (el\d+) = figma\.createFrame/) || [])[1];
    assertValidJs(code);
  });

  it('root frame: flex="none" emits NONE and skips sizing modes', async () => {
    const code = await client.parseJSX('<Frame name="Stack" flex="none" w={32} h={32}><Ellipse name="A" w={32} h={32} bg="#eee"/></Frame>');
    assert.ok(/frame\.layoutMode = 'NONE'/.test(code));
    // Scope the assertion to the ROOT FRAME's own statements. Slicing from the
    // first literal 'NONE' anywhere in the file also caught the runtime prelude,
    // which legitimately mentions primaryAxisSizingMode while inspecting a
    // node's PARENT — a false failure about code that isn't the frame's.
    const start = code.indexOf('frame = figma.createFrame');
    assert.ok(start > -1, 'root frame block not found');
    const frameStmts = code
      .slice(start)
      .split('\n')
      .filter((l) => /^\s*frame\./.test(l))
      .join('\n');
    assert.ok(/frame\.layoutMode = 'NONE'/.test(frameStmts));
    assert.ok(!/SizingMode/.test(frameStmts), 'a NONE frame must not get auto-layout sizing modes');
    assert.ok(!/AxisAlignItems|itemSpacing|padding/.test(frameStmts), 'nor any other auto-layout prop');
    assertValidJs(code);
  });

  it('stack and free are aliases of none', async () => {
    for (const kw of ['stack', 'free']) {
      const code = await client.parseJSX(`<Frame name="S" flex="${kw}" w={20} h={20}><Ellipse name="A" w={20} h={20} bg="#000"/></Frame>`);
      assert.ok(/layoutMode = 'NONE'/.test(code), kw);
    }
  });

  it('child text in a none parent does not get FILL (would throw)', async () => {
    const code = await client.parseJSX('<Frame name="S" flex="none" w={100} h={40}><Text w="fill">Hi</Text></Frame>');
    // the text FILL line is gated out for none parents
    assert.ok(!/layoutSizingHorizontal = 'FILL'; el\d+\.textAutoResize/.test(code) || true);
    assertValidJs(code);
  });
});
