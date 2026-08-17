import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

const client = new FigmaClient();

describe('textStyle= on <Text>', () => {
  it('applies the named style', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Heading/H1">Hi</Text></Frame>');
    assert.ok(/__applyTextStyle\(el0, "Heading\/H1"/.test(code), code);
    assert.ok(!/__autoTextStyle\(el0/.test(code), 'an explicit style must not also auto-match');
    assertValidJs(code);
  });

  it('is applied after characters are set', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M">Hi</Text></Frame>');
    const iChars = code.indexOf('el0.characters');
    const iStyle = code.indexOf('__applyTextStyle(el0');
    assert.ok(iChars > 0 && iStyle > iChars, 'style must not be applied before the text exists');
  });

  // Measured against a live Figma: writing fontSize/fontName/lineHeight/
  // letterSpacing CLEARS textStyleId. So nothing typographic may follow the
  // style — an "override" would detach the style it overrides.
  it('never writes typography after applying the style', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M" size={20} lineHeight={30}>Hi</Text></Frame>');
    const after = code.slice(code.indexOf('__applyTextStyle(el0'));
    assert.ok(!/el0\.fontSize = /.test(after), after);
    assert.ok(!/el0\.fontName = /.test(after), after);
    assert.ok(!/el0\.lineHeight = /.test(after), after);
    assert.ok(!/el0\.letterSpacing = /.test(after), after);
  });

  it('hands the conflicting props to the runtime so they can be reported', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M" size={20}>Hi</Text></Frame>');
    assert.ok(/__applyTextStyle\(el0, "Body\/M", \{"size":20\}\)/.test(code), code);
  });

  it('still applies align, which is not part of a text style', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M" align="center">Hi</Text></Frame>');
    const after = code.slice(code.indexOf('__applyTextStyle(el0'));
    assert.ok(/el0\.textAlignHorizontal = 'CENTER'/.test(after), after);
  });
});

describe('automatic text style matching', () => {
  it('asks for a match when no style is named', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text size={36} weight="bold">Hi</Text></Frame>');
    assert.ok(/__autoTextStyle\(el0, \{"size":36,"weightStyle":"Bold"/.test(code), code);
    assertValidJs(code);
  });

  it('marks the family as explicit only when font= was given', async () => {
    const withFont = await client.parseJSX('<Frame name="A"><Text font="Fira Sans" size={16}>Hi</Text></Frame>');
    assert.ok(/"family":"Fira Sans","familyExplicit":true/.test(withFont), withFont);

    const withoutFont = await client.parseJSX('<Frame name="A"><Text size={16}>Hi</Text></Frame>');
    assert.ok(/"family":"Inter","familyExplicit":false/.test(withoutFont), withoutFont);
  });

  it('is skipped for rich text with per-range formatting', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text size={16}>plain <b>bold</b></Text></Frame>');
    assert.ok(!/await globalThis\.__autoTextStyle\(el0/.test(code), code);
  });

  it('is skipped with auto-style off', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(false);
    const code = await c2.parseJSX('<Frame name="A"><Text size={36}>Hi</Text></Frame>');
    assert.ok(!/__autoTextStyle/.test(code) || !/await globalThis\.__autoTextStyle\(el0/.test(code), code);
    assertValidJs(code);
  });

  it('still honors textStyle= with auto-style off', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(false);
    const code = await c2.parseJSX('<Frame name="A"><Text textStyle="Body/M">Hi</Text></Frame>');
    assert.ok(/__applyTextStyle\(el0, "Body\/M"/.test(code), code);
  });
});

describe('text style prelude', () => {
  it('is emitted when the render contains text', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text>Hi</Text></Frame>');
    assert.ok(/__loadTextStyles/.test(code), code);
    assert.ok(/getLocalTextStylesAsync/.test(code), 'must use the async API for Safe Mode');
    assert.ok(/setTextStyleIdAsync/.test(code), code);
  });

  it('is skipped when there is no text at all', async () => {
    const code = await client.parseJSX('<Frame name="A" flex="col"><Rect w={10} h={10} bg="#f00"/></Frame>');
    assert.ok(!/__loadTextStyles/.test(code), 'no text: do not pay for the style query');
  });

  it('carries the matching rules from src/lib/text-styles.js verbatim', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text>Hi</Text></Frame>');
    assert.ok(/function matchTextStyle/.test(code), code);
    assert.ok(/function buildStyleIndex/.test(code), code);
    assert.ok(/function normalizeWeight/.test(code), code);
  });

  it('reports applied styles and warnings back to the caller', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text>Hi</Text></Frame>');
    assert.ok(/textStyles: __textStyles/.test(code), code);
  });

  it('works in the render-batch path too', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Text textStyle="Body/M">Hi</Text></Frame>']);
    assert.ok(/__loadTextStyles/.test(code), code);
    assert.ok(/__applyTextStyle\(el0_0, "Body\/M"/.test(code), code);
    assert.ok(/textStyles \}/.test(code), code);
    assertValidJs(code);
  });
});
