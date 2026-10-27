import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectWrapperSplit } from '../src/lib/cli-core.js';

describe('render auto-split of flex wrappers', () => {
  it('still splits N standalone items in a layout-only wrapper', () => {
    const split = detectWrapperSplit('<Frame name="Buttons" flex="row" gap={16}><Frame name="Button 1" p={8}><Text>A</Text></Frame><Frame name="Button 2" p={8}><Text>B</Text></Frame></Frame>');
    assert.ok(split);
    assert.strictEqual(split.children.length, 2);
  });

  it('keeps the wrapper when its children fill it', () => {
    const jsx = '<Frame name="Gallery" w={1312} flex="col" gap={48}>'
      + '<Frame name="GalleryRow" w="fill" flex="row" gap={24}><Instance component="Figure" /></Frame>'
      + '<Frame name="GalleryRow" w="fill" flex="row" gap={24}><Instance component="Figure" /></Frame></Frame>';
    assert.strictEqual(detectWrapperSplit(jsx), null);
  });

  it('keeps the wrapper when a child grows or fills height', () => {
    assert.strictEqual(detectWrapperSplit('<Frame name="Row" flex="row"><Frame name="Item 1" grow={1} /><Frame name="Item 2" grow={1} /></Frame>'), null);
    assert.strictEqual(detectWrapperSplit('<Frame name="Col" flex="row" h={200}><Frame name="Item 1" h="fill" /><Frame name="Item 2" h="fill" /></Frame>'), null);
  });

  it('never splits a variant-named frame', () => {
    const jsx = '<Frame name="Type=desktop-screens, Size=desktop" flex="col" gap={48}><Frame name="Row 1" flex="row" /><Frame name="Row 2" flex="row" /></Frame>';
    assert.strictEqual(detectWrapperSplit(jsx), null);
  });
});
