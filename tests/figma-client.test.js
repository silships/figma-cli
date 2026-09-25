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
