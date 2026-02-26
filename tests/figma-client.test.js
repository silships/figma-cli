import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

// ----------------------------------------------------------------
// 1. URL Pattern Matching
// ----------------------------------------------------------------
describe('URL pattern matching', () => {
  const isDesignPage = (url) =>
    url != null && /figma\.com\/(design|file|make|board)\//.test(url);

  it('should match design URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/design/abc123/My-File'), true);
  });

  it('should match file URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/file/abc123/My-File'), true);
  });

  it('should match make URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/make/abc123/My-File'), true);
  });

  it('should match board URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/board/abc123/My-File'), true);
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
    const match = url.match(/figma\.com\/(design|file|make|board)\//);
    return match ? match[1] : 'unknown';
  };

  it('should detect design type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/design/abc/File'), 'design');
  });

  it('should detect file type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/file/abc/File'), 'file');
  });

  it('should detect make type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/make/abc/File'), 'make');
  });

  it('should detect board type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/board/abc/File'), 'board');
  });
});

// ----------------------------------------------------------------
// 3. Page Selection Priority
// ----------------------------------------------------------------
describe('page selection priority', () => {
  const makePage = { title: 'FigJam', url: 'https://www.figma.com/make/xyz/Board' };
  const designPage = { title: 'My Design', url: 'https://www.figma.com/design/abc/File' };

  const selectPage = (pages) => {
    const isDesignPage = (p) =>
      p.url && /figma\.com\/(design|file|make|board)\//.test(p.url);
    const isDesignOrFile = (p) =>
      p.url && /figma\.com\/(design|file)\//.test(p.url);
    return pages.find(isDesignOrFile) || pages.find(isDesignPage);
  };

  it('should prefer design page over make page', () => {
    const result = selectPage([makePage, designPage]);
    assert.strictEqual(result, designPage);
  });

  it('should fall back to make page when no design page exists', () => {
    const result = selectPage([makePage]);
    assert.strictEqual(result, makePage);
  });

  it('should pick design page when it is the only page', () => {
    const result = selectPage([designPage]);
    assert.strictEqual(result, designPage);
  });

  it('should return undefined when no pages match', () => {
    const feedPage = { title: 'Feed', url: 'https://www.figma.com/files/feed' };
    const result = selectPage([feedPage]);
    assert.strictEqual(result, undefined);
  });
});

// ----------------------------------------------------------------
// 4. isMakeFile Getter
// ----------------------------------------------------------------
describe('isMakeFile getter', () => {
  it('should return true for make files', () => {
    const client = new FigmaClient();
    client.fileType = 'make';
    assert.strictEqual(client.isMakeFile, true);
  });

  it('should return true for board files', () => {
    const client = new FigmaClient();
    client.fileType = 'board';
    assert.strictEqual(client.isMakeFile, true);
  });

  it('should return false for design files', () => {
    const client = new FigmaClient();
    client.fileType = 'design';
    assert.strictEqual(client.isMakeFile, false);
  });

  it('should return false for file type files', () => {
    const client = new FigmaClient();
    client.fileType = 'file';
    assert.strictEqual(client.isMakeFile, false);
  });
});

// ----------------------------------------------------------------
// 5. Eval guard for Make files
//    FigmaClient.eval() should reject with a message containing
//    "Make" (or "Board") and "Plugin API" when isMakeFile is true.
// ----------------------------------------------------------------
describe('FigmaClient eval guard for Make files', () => {
  it('should throw when fileType is make', async () => {
    const client = new FigmaClient();
    client.fileType = 'make';
    // Set ws so we get past the "Not connected" guard
    client.ws = {};

    await assert.rejects(
      () => client.eval('1+1'),
      (err) => {
        assert.ok(err.message.includes('Make'), 'error should mention "Make"');
        assert.ok(err.message.includes('Plugin API'), 'error should mention "Plugin API"');
        return true;
      }
    );
  });

  it('should throw when fileType is board', async () => {
    const client = new FigmaClient();
    client.fileType = 'board';
    client.ws = {};

    await assert.rejects(
      () => client.eval('1+1'),
      (err) => {
        assert.ok(err.message.includes('Board'), 'error should mention "Board"');
        assert.ok(err.message.includes('Plugin API'), 'error should mention "Plugin API"');
        return true;
      }
    );
  });

  it('should not throw the Make guard for design files', async () => {
    const client = new FigmaClient();
    client.fileType = 'design';
    // ws is null so it will throw "Not connected" instead of the Make guard
    await assert.rejects(
      () => client.eval('1+1'),
      (err) => {
        assert.ok(
          err.message.includes('Not connected'),
          'should throw "Not connected", not the Make guard'
        );
        return true;
      }
    );
  });
});
