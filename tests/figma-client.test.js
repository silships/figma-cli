import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

// ----------------------------------------------------------------
// 1. URL Pattern Matching
// ----------------------------------------------------------------
describe('URL pattern matching', () => {
  const isDesignPage = (url) =>
    url != null && /figma\.com\/(design|file)\//.test(url);

  it('should match design URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/design/abc123/My-File'), true);
  });

  it('should match file URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/file/abc123/My-File'), true);
  });

  it('should NOT match /files/feed', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/files/feed'), false);
  });

  it('should NOT match /files/team/recents', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/files/team/123/recents'), false);
  });

  it('should NOT match /desktop_new_tab', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/desktop_new_tab'), false);
  });

  it('should NOT match null', () => {
    assert.strictEqual(isDesignPage(null), false);
  });

  it('should NOT match undefined', () => {
    assert.strictEqual(isDesignPage(undefined), false);
  });

  it('should NOT match empty string', () => {
    assert.strictEqual(isDesignPage(''), false);
  });
});

// ----------------------------------------------------------------
// 2. File Type Detection
// ----------------------------------------------------------------
describe('file type detection', () => {
  const extractFileType = (url) => {
    const match = url.match(/figma\.com\/(design|file)\//);
    return match ? match[1] : 'unknown';
  };

  it('should detect design type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/design/abc/File'), 'design');
  });

  it('should detect file type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/file/abc/File'), 'file');
  });

  it('should return unknown for other URLs', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/files/feed'), 'unknown');
  });
});

// ----------------------------------------------------------------
// 3. FigmaClient Properties
// ----------------------------------------------------------------
describe('FigmaClient properties', () => {
  it('should initialize with null pageUrl', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.pageUrl, null);
  });

  it('should initialize with null fileType', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.fileType, null);
  });

  it('should initialize with null pageTitle', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.pageTitle, null);
  });
});

it('root frame honors per-side padding in render and render-batch', async () => {
  const c = new FigmaClient();
  const jsx = '<Frame name="P" flex="row" pt={4} pr={10} pb={6} pl={8}><Text>x</Text></Frame>';
  const single = await c.parseJSX(jsx);
  for (const want of ['paddingTop = 4', 'paddingRight = 10', 'paddingBottom = 6', 'paddingLeft = 8']) {
    assert.ok(single.includes(want), 'render: ' + want);
  }
  const batch = await c.parseJSXBatch([jsx]);
  const code = typeof batch === 'string' ? batch : JSON.stringify(batch);
  for (const want of ['paddingTop = 4', 'paddingRight = 10', 'paddingBottom = 6', 'paddingLeft = 8']) {
    assert.ok(code.includes(want), 'render-batch: ' + want);
  }
});

describe('self-closing tags with URLs and centered text', () => {
  const c = new FigmaClient();
  it('parses <Image src="https://..."> and <Rect image="https://..."> despite the slashes', () => {
    const kids = c.parseChildren('<Image name="Hero" src="https://example.com/a/b.png" w={10} h={10} /><Rect name="R" image="https://example.com/x.png" w={5} h={5} />');
    assert.deepStrictEqual(kids.map(k => [k._type, k.name]), [['image', 'Hero'], ['rect', 'R']]);
    assert.strictEqual(kids[0].src, 'https://example.com/a/b.png');
  });
  it('accepts a lone Rectangle as the root', async () => {
    const code = await c.parseJSX('<Rectangle name="Box" w={20} h={20} bg="#f00" />');
    assert.ok(code.includes('"Box"'));
  });
  it('centers text in a column with items="center" unless align is set', async () => {
    const centered = await c.parseJSX('<Frame flex="col" items="center" w={200}><Text w="fill">Hi</Text></Frame>');
    assert.ok(centered.includes("textAlignHorizontal = 'CENTER'"));
    const left = await c.parseJSX('<Frame flex="col" items="center" w={200}><Text w="fill" align="left">Hi</Text></Frame>');
    assert.ok(!left.includes("textAlignHorizontal = 'CENTER'"));
    const plain = await c.parseJSX('<Frame flex="col" w={200}><Text w="fill">Hi</Text></Frame>');
    assert.ok(!plain.includes("textAlignHorizontal = 'CENTER'"));
  });
});

describe('round 2 fixes', () => {
  const c = new FigmaClient();
  it('reads bare numbers like x=48 and decimals', () => {
    assert.deepStrictEqual(c.parseProps('x=48 y=2.5 w={10} name="a"'), { x: '48', y: '2.5', w: '10', name: 'a' });
  });
  it('names text layers, strikes through, and positions text absolutely', async () => {
    const code = await c.parseJSX('<Frame flex="row" w={200} h={50}><Text name="Old price" decoration="strikethrough" position="absolute" x={10} y={5}>$9</Text></Frame>');
    assert.ok(code.includes('.name = "Old price"'));
    assert.ok(code.includes("textDecoration = 'STRIKETHROUGH'"));
    assert.ok(code.includes("layoutPositioning = 'ABSOLUTE'"));
  });
  it('positions instances absolutely', async () => {
    const code = await c.parseJSX('<Frame flex="row" w={200} h={50}><Instance component="Badge" position="absolute" x={8} y={8} /></Frame>');
    assert.ok(code.includes("layoutPositioning = 'ABSOLUTE'"));
  });
});

describe('strokes and instance tint', () => {
  const c = new FigmaClient();
  it('keeps strokes out of the auto-layout like the Figma editor does', async () => {
    const code = await c.parseJSX('<Frame flex="col" w={280} stroke="#ddd"><Frame w="fill" h={10} /></Frame>');
    assert.ok(code.includes('frame.strokesIncludedInLayout = false'));
  });
  it('tints the vectors of an instance', async () => {
    const code = await c.parseJSX('<Frame flex="row"><Instance component="Icon" tint="#E11D48" /></Frame>');
    assert.ok(code.includes('__tint'));
  });
});

describe('root instances', () => {
  const c = new FigmaClient();
  it('wraps a lone <Instance> so it can be rendered and dissolves the wrapper afterwards', async () => {
    const code = await c.parseJSX('<Instance component="Card" />');
    assert.ok(code.includes('__figma_cli_unwrap__'));
    assert.ok(code.includes('insertChild'));
  });
});
