import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

const client = new FigmaClient();

// Every failure inside the generated render code used to surface as
// "ReferenceError: frame is not defined": the catch block read a `const frame`
// declared inside the try. The real error never reached the caller and
// frame.remove() never ran, so a failed render left an orphan on the canvas.
describe('render error handling is not self-masking', () => {
  it('declares frame outside the try so the catch can see it', async () => {
    const code = await client.parseJSX('<Frame name="A" w={100} h={40} bg="#eee" />');
    assert.ok(/let frame;/.test(code), code);
    assert.ok(!/const frame = figma\.createFrame\(\)/.test(code), code);
    assert.ok(/frame = figma\.createFrame\(\)/.test(code), code);
    assertValidJs(code);
  });

  it('guards the cleanup so a failing remove() cannot replace the real error', async () => {
    const code = await client.parseJSX('<Frame name="A" w={100} h={40} bg="#eee" />');
    const tail = code.slice(code.indexOf('catch(e)'));
    assert.ok(/if \(frame\)/.test(tail), tail);
    assert.ok(/\[Node: /.test(tail), tail);
  });
});

// w/h="fill" needs an auto-layout PARENT. The root frame is parentless until
// the very end of the generated code, so a FILL assignment near the top could
// never work — and without --parent there is nothing to fill at all.
describe('fill sizing on the root frame', () => {
  it('warns instead of throwing when there is no --parent', async () => {
    const code = await client.parseJSX('<Frame name="A" w="fill" h={40} bg="#eee" />');
    assert.ok(!/frame\.layoutSizingHorizontal/.test(code), code);
    assert.ok(/__layoutWarnings\.push\("\\"A\\" fills width/.test(code), code);
    assertValidJs(code);
  });

  it('sets FILL after appendChild when --parent is given', async () => {
    const code = await client.parseJSX(
      '<Frame name="B" w="fill" h={20} bg="#0f0" />', { parent: '1:2' }
    );
    const iAppend = code.indexOf('__p.appendChild(frame)');
    const iFill = code.indexOf("frame.layoutSizingHorizontal = 'FILL'");
    assert.ok(iAppend > 0 && iFill > 0, code);
    assert.ok(iFill > iAppend, 'FILL must be assigned after appendChild');
    assertValidJs(code);
  });

  it('checks the parent actually uses auto-layout', async () => {
    const code = await client.parseJSX('<Frame name="B" h="fill" w={20} />', { parent: '1:2' });
    assert.ok(/__p\.layoutMode && __p\.layoutMode !== 'NONE'/.test(code), code);
    assert.ok(/frame\.layoutSizingVertical = 'FILL'/.test(code), code);
    assertValidJs(code);
  });
});

// Rectangle / Ellipse / Image passed item.w straight into resize(), so
// w="fill" arrived at the Plugin API as the string "fill".
describe('fill sizing on leaf nodes', () => {
  const cases = [
    ['Rectangle', '<Frame name="C" w={200} h={60} flex="col"><Rectangle w="fill" h={2} bg="#f00" /></Frame>'],
    ['Ellipse', '<Frame name="C" w={200} h={60} flex="col"><Ellipse w="fill" h={20} bg="#f00" /></Frame>'],
    ['Image', '<Frame name="C" w={200} h={60} flex="col"><Image w="fill" h={20} /></Frame>'],
  ];

  for (const [label, jsx] of cases) {
    it(`${label}: keeps "fill" out of resize() and sets FILL after appendChild`, async () => {
      const code = await client.parseJSX(jsx);
      assert.ok(!/resize\((["'])?fill/.test(code), code);
      const iAppend = code.indexOf('.appendChild(el0)');
      const iFill = code.indexOf("el0.layoutSizingHorizontal = 'FILL'");
      assert.ok(iAppend > 0 && iFill > iAppend, code);
      assert.ok(/__figHugWarn\(el0, 'H'\)/.test(code), code);
      assertValidJs(code);
    });
  }

  it('ignores fill in a flex="none" parent instead of emitting an assignment that throws', async () => {
    const code = await client.parseJSX('<Frame name="C" w={200} h={60} flex="none"><Rectangle w="fill" h={2} bg="#f00" /></Frame>');
    assert.ok(!/el0\.layoutSizingHorizontal/.test(code), code);
    assert.ok(/el0\.resize\(100, 2\)/.test(code), code);
    assertValidJs(code);
  });

  it('fills both axes when asked', async () => {
    const code = await client.parseJSX('<Frame name="C" w={200} h={60} flex="col"><Rectangle w="fill" h="fill" bg="#f00" /></Frame>');
    assert.ok(/el0\.layoutSizingHorizontal = 'FILL'/.test(code), code);
    assert.ok(/el0\.layoutSizingVertical = 'FILL'/.test(code), code);
    assertValidJs(code);
  });

  it('leaves fixed sizes untouched', async () => {
    const code = await client.parseJSX('<Frame name="F" w={200} h={60} flex="col"><Rectangle w={100} h={2} bg="#f00" /></Frame>');
    assert.ok(/el0\.resize\(100, 2\)/.test(code), code);
    assert.ok(!/el0\.layoutSizing/.test(code), code);
  });

  // render-batch shares the child generator, so the leaf fix has to hold there too.
  it('applies in the render-batch path as well', async () => {
    const code = await client.parseJSXBatch([
      '<Frame name="C" w={200} h={60} flex="col"><Rectangle w="fill" h={2} bg="#f00" /></Frame>',
    ]);
    assert.ok(!/resize\((["'])?fill/.test(code), code);
    assert.ok(/layoutSizingHorizontal = 'FILL'/.test(code), code);
    assertValidJs(code);
  });
});
