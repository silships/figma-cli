// Ported from PR #44 (Daniel Martin), adapted to the helper-based textStyle=
// path on main: resolution lives in src/lib/figma-helpers.js, reports go
// through the shared notes channel, and auto-matching is opt-in.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';
import { HELPERS_SOURCE } from '../src/lib/figma-helpers.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

const client = new FigmaClient();

describe('textStyle= on <Text>', () => {
  it('resolves the name through the text style helper (tail + library aware)', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Heading/H1">Hi</Text></Frame>');
    assert.ok(/__figHelpers\.textStyle\("Heading\/H1"\)/.test(code), code);
    assert.ok(!/autoTextStyle\(el0/.test(code), 'an explicit style must not also auto-match');
    assertValidJs(code);
  });

  it('is applied after characters are set', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M">Hi</Text></Frame>');
    const iChars = code.indexOf('el0.characters');
    const iStyle = code.indexOf('__figHelpers.textStyle(');
    assert.ok(iChars > 0 && iStyle > iChars, 'style must not be applied before the text exists');
  });

  // Measured against a live Figma (PR #44): writing fontSize/fontName/
  // lineHeight/letterSpacing CLEARS textStyleId. Nothing typographic may follow
  // a successfully applied style.
  it('never writes typography after a successfully applied style', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M" size={20} lineHeight={30}>Hi</Text></Frame>');
    const start = code.indexOf('el0.setTextStyleIdAsync');
    const ok = code.slice(start, code.indexOf('catch (e)', start));
    assert.ok(!/el0\.(fontSize|fontName|lineHeight|letterSpacing) = /.test(ok), ok);
  });

  it('hands the conflicting props to the runtime so they can be reported', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text textStyle="Body/M" size={20}>Hi</Text></Frame>');
    assert.ok(/textStyleClashes\(__ts, \{"size":20\}\)/.test(code), code);
  });
});

describe('automatic text style matching (opt-in)', () => {
  it('is off by default', async () => {
    const code = await client.parseJSX('<Frame name="A"><Text size={36} weight="bold">Hi</Text></Frame>');
    assert.ok(!/autoTextStyle\(el0/.test(code), code);
  });

  it('asks for a match when enabled and no style is named', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(true);
    const code = await c2.parseJSX('<Frame name="A"><Text size={36} weight="bold">Hi</Text></Frame>');
    assert.ok(/autoTextStyle\(el0, \{"size":36,"weightStyle":"Bold"/.test(code), code);
    assertValidJs(code);
  });

  it('marks the family as explicit only when font= was given', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(true);
    const withFont = await c2.parseJSX('<Frame name="A"><Text font="Fira Sans" size={16}>Hi</Text></Frame>');
    assert.ok(/"family":"Fira Sans","familyExplicit":true/.test(withFont), withFont);
    const withoutFont = await c2.parseJSX('<Frame name="A"><Text size={16}>Hi</Text></Frame>');
    assert.ok(/"family":"Inter","familyExplicit":false/.test(withoutFont), withoutFont);
  });

  it('is skipped for rich text with per-range formatting', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(true);
    const code = await c2.parseJSX('<Frame name="A"><Text size={16}>plain <b>bold</b></Text></Frame>');
    assert.ok(!/autoTextStyle\(el0/.test(code), code);
  });

  it('works in the render-batch path too', async () => {
    const c2 = new FigmaClient();
    c2.setAutoTextStyle(true);
    const code = await c2.parseJSXBatch(['<Frame name="A"><Text size={16}>Hi</Text></Frame>']);
    assert.ok(/autoTextStyle\(el0_0/.test(code), code);
    assertValidJs(code);
  });
});

describe('text style helpers', () => {
  it('carry the matching rules from src/lib/text-styles.js verbatim', () => {
    assert.ok(/function matchTextStyle/.test(HELPERS_SOURCE));
    assert.ok(/function buildStyleIndex/.test(HELPERS_SOURCE));
    assert.ok(/function normalizeWeight/.test(HELPERS_SOURCE));
    assertValidJs(HELPERS_SOURCE);
  });

  it('use the async style APIs (Safe Mode / dynamic-page documents)', () => {
    assert.ok(/getLocalTextStylesAsync/.test(HELPERS_SOURCE));
    assert.ok(/getStyleByIdAsync/.test(HELPERS_SOURCE));
    assert.ok(/setTextStyleIdAsync/.test(HELPERS_SOURCE));
  });
});
