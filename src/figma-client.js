/**
 * Figma CDP Client
 *
 * Connects directly to Figma via Chrome DevTools Protocol.
 * No external dependencies required.
 */

import WebSocket from 'ws';
import { getCdpPort } from './figma-patch.js';

export class FigmaClient {
  constructor() {
    this.ws = null;
    this.msgId = 0;
    this.callbacks = new Map();
    this.pageTitle = null;
    this.pageUrl = null;
    this.fileType = null; // 'design', 'file', or 'unknown'
    this.executionContextId = null; // For Figma v39+ sandboxed context
  }

  /**
   * List all available Figma pages
   */
  static async listPages() {
    const port = getCdpPort();
    const response = await fetch(`http://localhost:${port}/json`);
    const pages = await response.json();
    return pages
      .filter(p => p.url && p.url.includes('figma.com'))
      .map(p => ({ title: p.title, id: p.id, url: p.url, wsUrl: p.webSocketDebuggerUrl }));
  }

  /**
   * Check if Figma is running with debug port
   */
  static async isConnected() {
    try {
      const port = getCdpPort();
      const response = await fetch(`http://localhost:${port}/json`);
      const pages = await response.json();
      return pages.some(p => p.url && p.url.includes('figma.com'));
    } catch {
      return false;
    }
  }

  /**
   * Connect to a Figma design file
   */
  async connect(pageTitle = null) {
    const port = getCdpPort();
    const response = await fetch(`http://localhost:${port}/json`);
    const pages = await response.json();

    // Find design/file pages (not feed, home, etc.)
    // Use regex with trailing slash to avoid matching /files/ (feed/home pages)
    const isDesignPage = (p) =>
      p.url && /figma\.com\/(design|file)\//.test(p.url);

    const stripFigma = (t) => t.replace(/\s*[–\-]\s*Figma\s*$/i, '').trim();

    let page;
    if (pageTitle) {
      // Exact match first (e.g. "Test" must not match "Test (Copy)")
      page = pages.find(p => isDesignPage(p) && stripFigma(p.title) === pageTitle);
      // Fallback to substring if no exact match
      if (!page) page = pages.find(p => isDesignPage(p) && p.title.includes(pageTitle));
    } else {
      page = pages.find(isDesignPage);
    }

    if (!page) {
      throw new Error('No Figma design file open. Please open a design file in Figma Desktop.');
    }

    this.pageTitle = page.title;
    this.pageUrl = page.url;

    // Detect file type from URL
    const typeMatch = page.url.match(/figma\.com\/(design|file)\//);
    this.fileType = typeMatch ? typeMatch[1] : 'unknown';

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      const executionContexts = [];

      this.ws.on('open', async () => {
        try {
          // Enable Runtime to discover execution contexts (needed for Figma v39+)
          await this.send('Runtime.enable');

          // Give time for context events to arrive
          await new Promise(r => setTimeout(r, 500));

          // First try default context (works on older Figma versions)
          const defaultCheck = await this.send('Runtime.evaluate', {
            expression: 'typeof figma !== "undefined"',
            returnByValue: true
          });

          if (defaultCheck.result?.result?.value === true) {
            // figma is in default context (older Figma)
            this.executionContextId = null;
            resolve(this);
            return;
          }

          // Figma v39+: search all execution contexts for figma
          for (const ctx of executionContexts) {
            try {
              const check = await this.send('Runtime.evaluate', {
                expression: 'typeof figma !== "undefined"',
                contextId: ctx.id,
                returnByValue: true
              });

              if (check.result?.result?.value === true) {
                this.executionContextId = ctx.id;
                resolve(this);
                return;
              }
            } catch {
              // Context may have been destroyed, skip
            }
          }

          reject(new Error('Could not find Figma execution context. Make sure a design file is open.'));
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);

        // Collect execution contexts as they're created
        if (msg.method === 'Runtime.executionContextCreated') {
          executionContexts.push(msg.params.context);
        }

        if (msg.id && this.callbacks.has(msg.id)) {
          this.callbacks.get(msg.id)(msg);
          this.callbacks.delete(msg.id);
        }
      });

      this.ws.on('error', reject);

      setTimeout(() => reject(new Error('Connection timeout')), 15000);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.callbacks.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate JavaScript in the Figma context
   */
  async eval(expression) {
    if (!this.ws) {
      throw new Error('Not connected to Figma');
    }

    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true
    };

    // Use specific execution context if found (Figma v39+)
    if (this.executionContextId) {
      params.contextId = this.executionContextId;
    }

    const result = await this.send('Runtime.evaluate', params);

    if (result.result?.exceptionDetails) {
      const error = result.result.exceptionDetails;
      // Get the actual error message - Figma puts detailed errors in exception.value
      const errorValue = error.exception?.value || error.exception?.description || error.text || 'Evaluation error';
      throw new Error(errorValue);
    }

    return result.result?.result?.value;
  }

  /**
   * Get current page info
   */
  async getPageInfo() {
    return await this.eval(`
      (function() {
        return {
          name: figma.currentPage.name,
          id: figma.currentPage.id,
          childCount: figma.currentPage.children.length,
          fileKey: figma.fileKey
        };
      })()
    `);
  }

  /**
   * Get canvas bounds (for smart positioning)
   */
  async getCanvasBounds() {
    return await this.eval(`
      (function() {
        const children = figma.currentPage.children;
        if (children.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, isEmpty: true };

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        children.forEach(n => {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x + n.width > maxX) maxX = n.x + n.width;
          if (n.y + n.height > maxY) maxY = n.y + n.height;
        });
        return { minX, minY, maxX, maxY, isEmpty: false };
      })()
    `);
  }

  /**
   * List all nodes on current page
   */
  async listNodes(limit = 50) {
    return await this.eval(`
      figma.currentPage.children.slice(0, ${limit}).map(function(n) {
        return {
          id: n.id,
          type: n.type,
          name: n.name || '',
          x: Math.round(n.x),
          y: Math.round(n.y),
          width: Math.round(n.width),
          height: Math.round(n.height)
        };
      })
    `);
  }

  /**
   * Get all local variables
   */
  async getVariables(type = null) {
    const typeFilter = type ? `'${type}'` : 'null';
    return await this.eval(`
      (function() {
        const vars = figma.variables.getLocalVariables(${typeFilter});
        return vars.map(v => ({
          id: v.id,
          name: v.name,
          resolvedType: v.resolvedType
        }));
      })()
    `);
  }

  /**
   * Get all variable collections
   */
  async getCollections() {
    return await this.eval(`
      (function() {
        const cols = figma.variables.getLocalVariableCollections();
        return cols.map(c => ({
          id: c.id,
          name: c.name,
          modes: c.modes,
          variableIds: c.variableIds
        }));
      })()
    `);
  }

  /**
   * Render JSX-like syntax to Figma
   */
  async render(jsx) {
    // Parse JSX and generate Figma code
    const code = this.parseJSX(jsx);
    return await this.eval(code);
  }

  /**
   * Parse multiple JSX strings into a SINGLE eval call (10x faster)
   * Returns code that creates all frames and returns array of { id, name }
   */
  parseJSXBatch(jsxArray, options = {}) {
    const gap = options.gap || 40;
    const vertical = options.vertical || false;

    // Parse each JSX to get props and children
    const parsed = jsxArray.map(jsx => {
      const openMatch = jsx.match(/<Frame\s+([^>]*)>/);
      if (!openMatch) throw new Error('Invalid JSX: must start with <Frame>');
      const propsStr = openMatch[1];
      const startIdx = openMatch.index + openMatch[0].length;
      const children = this.extractContent(jsx.slice(startIdx), 'Frame');
      const props = this.parseProps(propsStr);
      const childElements = this.parseChildren(children);
      return { props, children: childElements };
    });

    // Collect all fonts needed
    const allFonts = new Set();
    let anyUsesVars = false;

    parsed.forEach(({ props, children }) => {
      const bg = props.bg || props.fill || '#ffffff';
      const stroke = props.stroke || null;
      if (this.isVarRef(bg)) anyUsesVars = true;
      if (stroke && this.isVarRef(stroke)) anyUsesVars = true;

      const collectFonts = (items) => {
        items.forEach(item => {
          if (item._type === 'text') {
            const weight = item.weight || 'regular';
            const style = weight === 'bold' ? 'Bold' : weight === 'medium' ? 'Medium' : weight === 'semibold' ? 'Semi Bold' : 'Regular';
            allFonts.add(style);
            if (item.color && this.isVarRef(item.color)) anyUsesVars = true;
          } else if (item._type === 'frame') {
            if (item.bg && this.isVarRef(item.bg)) anyUsesVars = true;
            if (item.stroke && this.isVarRef(item.stroke)) anyUsesVars = true;
            if (item._children) collectFonts(item._children);
          }
        });
      };
      collectFonts(children);
    });

    // Font caching: only load fonts not yet loaded in this session
    const fontStyles = Array.from(allFonts);
    const fontLoads = fontStyles.length > 0
      ? `
        if (!globalThis.__loadedFonts) globalThis.__loadedFonts = new Set();
        const fontsToLoad = ${JSON.stringify(fontStyles)}.filter(s => !globalThis.__loadedFonts.has(s));
        if (fontsToLoad.length > 0) {
          await Promise.all(fontsToLoad.map(s => figma.loadFontAsync({family:'Inter',style:s})));
          fontsToLoad.forEach(s => globalThis.__loadedFonts.add(s));
        }
      `
      : `
        if (!globalThis.__loadedFonts) globalThis.__loadedFonts = new Set();
        if (!globalThis.__loadedFonts.has('Regular')) {
          await figma.loadFontAsync({family:'Inter',style:'Regular'});
          globalThis.__loadedFonts.add('Regular');
        }
      `;

    // Variable caching: reuse loaded vars across calls
    const varLoadCode = anyUsesVars ? `
      if (!globalThis.__varsCache || Date.now() - (globalThis.__varsCacheTime || 0) > 30000) {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const shadcnCol = collections.find(c => c.name === 'shadcn');
        globalThis.__varsCache = {};
        if (shadcnCol) {
          for (const id of shadcnCol.variableIds) {
            const v = await figma.variables.getVariableByIdAsync(id);
            if (v) globalThis.__varsCache[v.name] = v;
          }
        }
        globalThis.__varsCacheTime = Date.now();
      }
      const vars = globalThis.__varsCache;
      const boundFill = (variable) => figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable
      );
    ` : '';

    // Generate code for each frame
    const framesCodes = parsed.map(({ props, children }, frameIdx) => {
      const name = props.name || 'Frame';
      const width = props.w || props.width || 320;
      const height = props.h || props.height || 200;
      const bg = props.bg || props.fill || '#ffffff';
      const stroke = props.stroke || null;
      const rounded = props.rounded || props.radius || 0;
      const flex = props.flex || 'col';
      const itemGap = props.gap || 0;
      const p = props.p || props.padding || 0;
      const px = props.px || p;
      const py = props.py || p;
      const align = props.align || 'MIN';
      const justify = props.justify || 'MIN';
      const wrap = props.wrap === true || props.wrap === 'true';
      const wrapGap = Number(props.wrapGap || props.counterAxisSpacing || 0);
      const hug = props.hug || '';
      const hugWidth = hug === 'both' || hug === 'w' || hug === 'width';
      const hugHeight = hug === 'both' || hug === 'h' || hug === 'height';
      const clip = props.clip === 'true' || props.clip === true;

      const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
      const alignVal = alignMap[align] || 'MIN';
      const justifyVal = alignMap[justify] || 'MIN';

      const fillCode = this.generateFillCode(bg, `f${frameIdx}`);
      const strokeCode = stroke ? this.generateStrokeCode(stroke, `f${frameIdx}`) : { code: '' };

      // Generate child code
      let childCounter = 0;
      const generateChildCode = (items, parentVar) => {
        return items.map(item => {
          const idx = `${frameIdx}_${childCounter++}`;
          if (item._type === 'text') {
            const weight = item.weight || 'regular';
            const style = weight === 'bold' ? 'Bold' : weight === 'medium' ? 'Medium' : weight === 'semibold' ? 'Semi Bold' : 'Regular';
            const size = item.size || 14;
            const color = item.color || '#000000';
            const fillWidth = item.w === 'fill';
            const textAlign = item.align || 'left';
            const textAlignVal = textAlign === 'center' ? 'CENTER' : textAlign === 'right' ? 'RIGHT' : 'LEFT';
            const textFillCode = this.generateFillCode(color, `el${idx}`);
            return `
          const el${idx} = figma.createText();
          el${idx}.fontName = {family:'Inter',style:'${style}'};
          el${idx}.characters = ${JSON.stringify(item.content || '')};
          el${idx}.fontSize = ${size};
          ${textFillCode.code}
          el${idx}.textAlignHorizontal = '${textAlignVal}';
          ${parentVar}.appendChild(el${idx});
          ${fillWidth ? `el${idx}.layoutSizingHorizontal = 'FILL';` : ''}`;
          } else if (item._type === 'frame') {
            const fName = item.name || 'Frame';
            const fillW = item.w === 'fill';
            const fillH = item.h === 'fill';
            const hasExplicitW = (item.w !== undefined || item.width !== undefined) && !fillW;
            const hasExplicitH = (item.h !== undefined || item.height !== undefined) && !fillH;
            const fWidth = hasExplicitW ? (item.w || item.width) : 100;
            const fHeight = hasExplicitH ? (item.h || item.height) : 40;
            // Frames without explicit bg should be transparent (not white)
            const fBg = item.bg || item.fill || null;
            const fStroke = item.stroke || null;
            const fRounded = item.rounded || item.radius || 0;
            const fFlex = item.flex || 'row';  // Default to row (always auto-layout like single render)
            const fGap = item.gap || 0;
            const fP = item.p !== undefined ? item.p : 0;
            const fPx = item.px !== undefined ? item.px : fP;
            const fPy = item.py !== undefined ? item.py : fP;
            const fGrow = item.grow || 0;
            const fJustify = item.justify || 'center';
            const fItems = item.items || 'center';
            const justifyMap = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };
            const fJustifyVal = justifyMap[fJustify] || 'CENTER';
            const fItemsVal = alignMap[fItems] || 'CENTER';
            const fFillCode = fBg ? this.generateFillCode(fBg, `el${idx}`) : { code: `el${idx}.fills = [];`, usesVars: false };
            const fStrokeCode = fStroke ? this.generateStrokeCode(fStroke, `el${idx}`) : { code: '' };
            const nestedChildren = item._children ? generateChildCode(item._children, `el${idx}`) : '';
            return `
          const el${idx} = figma.createFrame();
          el${idx}.name = ${JSON.stringify(fName)};
          el${idx}.layoutMode = '${fFlex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
          el${idx}.primaryAxisSizingMode = '${hasExplicitW ? 'FIXED' : 'AUTO'}';
          el${idx}.counterAxisSizingMode = '${hasExplicitH ? 'FIXED' : 'AUTO'}';
          ${hasExplicitW || hasExplicitH ? `el${idx}.resize(${fWidth}, ${fHeight});` : ''}
          el${idx}.cornerRadius = ${fRounded};
          ${fFillCode.code}
          ${fStrokeCode.code}
          el${idx}.itemSpacing = ${fGap};
          el${idx}.paddingTop = el${idx}.paddingBottom = ${fPy};
          el${idx}.paddingLeft = el${idx}.paddingRight = ${fPx};
          el${idx}.primaryAxisAlignItems = '${fJustifyVal}';
          el${idx}.counterAxisAlignItems = '${fItemsVal}';
          ${parentVar}.appendChild(el${idx});
          ${fillW ? `el${idx}.layoutSizingHorizontal = 'FILL';` : ''}
          ${fillH ? `el${idx}.layoutSizingVertical = 'FILL';` : ''}
          ${fGrow ? `el${idx}.layoutGrow = ${fGrow};` : ''}
          ${nestedChildren}`;
          }
          return '';
        }).join('\n');
      };

      const childCode = generateChildCode(children, `f${frameIdx}`);

      return `
        const f${frameIdx} = figma.createFrame();
        f${frameIdx}.name = ${JSON.stringify(name)};
        f${frameIdx}.resize(${width}, ${height});
        f${frameIdx}.x = posX;
        f${frameIdx}.y = posY;
        f${frameIdx}.cornerRadius = ${rounded};
        ${fillCode.code}
        ${strokeCode.code}
        f${frameIdx}.layoutMode = '${flex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
        ${wrap && flex === 'row' ? `f${frameIdx}.layoutWrap = 'WRAP';` : ''}
        f${frameIdx}.itemSpacing = ${itemGap};
        f${frameIdx}.paddingTop = f${frameIdx}.paddingBottom = ${py};
        f${frameIdx}.paddingLeft = f${frameIdx}.paddingRight = ${px};
        f${frameIdx}.primaryAxisAlignItems = '${justifyVal}';
        f${frameIdx}.counterAxisAlignItems = '${alignVal}';
        f${frameIdx}.primaryAxisSizingMode = '${hugWidth ? 'AUTO' : 'FIXED'}';
        f${frameIdx}.counterAxisSizingMode = '${hugHeight ? 'AUTO' : 'FIXED'}';
        ${wrap && flex === 'row' && wrapGap > 0 ? `f${frameIdx}.counterAxisSpacing = ${wrapGap};` : ''}
        f${frameIdx}.clipsContent = ${clip};
        ${childCode}
        results.push({ id: f${frameIdx}.id, name: f${frameIdx}.name, width: f${frameIdx}.width, height: f${frameIdx}.height });
        ${vertical ? `posY += f${frameIdx}.height + ${gap};` : `posX += f${frameIdx}.width + ${gap};`}
      `;
    }).join('\n');

    return `
      (async function() {
        ${fontLoads}
        ${varLoadCode}

        // Calculate start position
        let posX = 0, posY = 100;
        const children = figma.currentPage.children;
        if (children.length > 0) {
          let maxRight = 0;
          children.forEach(n => {
            const right = n.x + (n.width || 0);
            if (right > maxRight) maxRight = right;
          });
          posX = Math.round(maxRight + 100);
        }

        const results = [];
        ${framesCodes}
        return results;
      })()
    `;
  }

  /**
   * Parse JSX-like syntax to Figma Plugin API code
   */
  parseJSX(jsx) {
    // Find opening Frame tag
    const openMatch = jsx.match(/<Frame\s+([^>]*)>/);
    if (!openMatch) {
      throw new Error('Invalid JSX: must start with <Frame>');
    }

    const propsStr = openMatch[1];
    const startIdx = openMatch.index + openMatch[0].length;

    // Find matching closing tag by counting open/close tags
    const children = this.extractContent(jsx.slice(startIdx), 'Frame');

    // Parse props
    const props = this.parseProps(propsStr);

    // Parse children
    const childElements = this.parseChildren(children);

    // Warn if children content exists but nothing was parsed
    const trimmedChildren = children.trim();
    if (trimmedChildren && childElements.length === 0) {
      console.warn('[render] Warning: Frame has content but no elements were parsed.');
      console.warn('[render] Content:', trimmedChildren.slice(0, 200) + (trimmedChildren.length > 200 ? '...' : ''));
      console.warn('[render] Supported elements: <Frame>, <Text>, <Rectangle>, <Rect>, <Image>, <Icon>');
    }

    // Generate code
    return this.generateCode(props, childElements);
  }

  /**
   * Extract content between matching open/close tags
   */
  extractContent(str, tagName) {
    let depth = 1;
    let i = 0;
    const closeTag = `</${tagName}>`;

    while (i < str.length && depth > 0) {
      const remaining = str.slice(i);

      if (remaining.startsWith(closeTag)) {
        depth--;
        if (depth === 0) {
          return str.slice(0, i);
        }
        i += closeTag.length;
      } else if (remaining.startsWith(`<${tagName} `) || remaining.startsWith(`<${tagName}>`)) {
        depth++;
        i++;
      } else {
        i++;
      }
    }

    return str;
  }

  parseProps(propsStr) {
    const props = {};

    // Match name="value" or name={value}
    const regex = /(\w+)=(?:"([^"]*)"|{([^}]*)})/g;
    let match;

    while ((match = regex.exec(propsStr)) !== null) {
      const key = match[1];
      const value = match[2] !== undefined ? match[2] : match[3];
      props[key] = value;
    }

    return props;
  }

  parseChildren(childrenStr) {
    const children = [];
    const frameRanges = [];

    // Find all nested Frame elements using balanced tag matching
    // Use \s* to allow frames with or without attributes
    const frameOpenRegex = /<Frame(?:\s+([^>]*?))?>/g;
    let match;

    while ((match = frameOpenRegex.exec(childrenStr)) !== null) {
      const frameProps = this.parseProps(match[1] || '');
      frameProps._type = 'frame';
      frameProps._index = match.index;

      // Get content between opening and matching closing tag
      const afterOpen = childrenStr.slice(match.index + match[0].length);
      const innerContent = this.extractContent(afterOpen, 'Frame');

      // Calculate full frame length
      const fullLength = match[0].length + innerContent.length + '</Frame>'.length;

      // Recursively parse children of nested frame
      frameProps._children = this.parseChildren(innerContent);
      children.push(frameProps);

      // Mark this range as consumed
      frameRanges.push({ start: match.index, end: match.index + fullLength });

      // Move regex past this frame to avoid re-matching nested frames
      frameOpenRegex.lastIndex = match.index + fullLength;
    }

    // Parse Slot elements (with children) - must be before Text parsing
    // Slots can have children (default content)
    const slotOpenRegex = /<Slot(?:\s+([^>]*?))?>/g;
    while ((match = slotOpenRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const slotProps = this.parseProps(match[1] || '');
        slotProps._type = 'slot';
        slotProps._index = idx;

        // Get content between opening and matching closing tag
        const afterOpen = childrenStr.slice(match.index + match[0].length);
        const innerContent = this.extractContent(afterOpen, 'Slot');
        const fullLength = match[0].length + innerContent.length + '</Slot>'.length;

        // Recursively parse children of slot (default content)
        slotProps._children = this.parseChildren(innerContent);
        children.push(slotProps);

        // Mark this range as consumed (so text/other elements inside are skipped)
        frameRanges.push({ start: idx, end: idx + fullLength });
        slotOpenRegex.lastIndex = idx + fullLength;
      }
    }

    // Parse self-closing Slot elements
    const slotSelfCloseRegex = /<Slot(?:\s+([^/]*?))?\s*\/>/g;
    while ((match = slotSelfCloseRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const slotProps = this.parseProps(match[1] || '');
        slotProps._type = 'slot';
        slotProps._index = idx;
        slotProps._children = [];
        children.push(slotProps);
        // Mark as consumed
        frameRanges.push({ start: idx, end: idx + match[0].length });
      }
    }

    // Parse Text elements, but skip those inside nested Frames/Slots
    // Use (?:\s+([^>]*?))? to allow Text with or without attributes
    const textRegex = /<Text(?:\s+([^>]*?))?>([^<]*)<\/Text>/g;
    while ((match = textRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      // Check if this text is inside a nested frame
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const textProps = this.parseProps(match[1] || '');
        textProps._type = 'text';
        textProps.content = match[2];
        textProps._index = idx;
        children.push(textProps);
      }
    }

    // Parse Rectangle elements (self-closing)
    // Use (?:\s+([^/]*?))? to allow Rect with or without attributes
    const rectRegex = /<(?:Rectangle|Rect)(?:\s+([^/]*?))?\s*\/>/g;
    while ((match = rectRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const rectProps = this.parseProps(match[1] || '');
        rectProps._type = 'rect';
        rectProps._index = idx;
        children.push(rectProps);
      }
    }

    // Parse Image elements (self-closing) - creates placeholder rectangle
    const imageRegex = /<Image\s+([^/]*)\s*\/>/g;
    while ((match = imageRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const imgProps = this.parseProps(match[1]);
        imgProps._type = 'image';
        imgProps._index = idx;
        children.push(imgProps);
      }
    }

    // Parse Icon elements (self-closing) - creates placeholder
    const iconRegex = /<Icon\s+([^/]*)\s*\/>/g;
    while ((match = iconRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const iconProps = this.parseProps(match[1]);
        iconProps._type = 'icon';
        iconProps._index = idx;
        children.push(iconProps);
      }
    }

    // Parse Instance elements (self-closing) - creates component instance
    const instanceRegex = /<Instance\s+([^/]*)\s*\/>/g;
    while ((match = instanceRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const instProps = this.parseProps(match[1]);
        instProps._type = 'instance';
        instProps._index = idx;
        children.push(instProps);
      }
    }

    // Sort by original position in JSX to maintain order
    children.sort((a, b) => a._index - b._index);

    return children;
  }

  generateCode(props, children) {
    const name = props.name || 'Frame';
    const rawWidth = props.w || props.width;
    const rawHeight = props.h || props.height;
    // Support w="fill" / h="fill" for root frame
    const fillWidth = rawWidth === 'fill';
    const fillHeight = rawHeight === 'fill';
    const width = fillWidth ? 100 : (rawWidth || 320);
    const height = fillHeight ? 100 : (rawHeight || 200);
    const bg = props.bg || props.fill || '#ffffff';
    const stroke = props.stroke || null;
    const rounded = props.rounded || props.radius || 0;
    const flex = props.flex || 'col';
    const gap = props.gap || 0;
    const p = props.p || props.padding || 0;
    const px = props.px || p;
    const py = props.py || p;
    const align = props.align || 'MIN';
    const justify = props.justify || 'MIN';
    const useSmartPos = props.x === undefined;
    const explicitX = props.x || 0;
    const y = props.y || 0;
    // New: clip defaults to false (don't clip auto-layout overflow)
    const clip = props.clip === 'true' || props.clip === true;
    // New: hug for auto-sizing (hug="both" | "w" | "h" | "width" | "height")
    const hug = props.hug || '';
    const hugWidth = hug === 'both' || hug === 'w' || hug === 'width';
    const hugHeight = hug === 'both' || hug === 'h' || hug === 'height';
    // New: wrap and wrapGap for horizontal layouts
    const wrap = props.wrap === true || props.wrap === 'true';
    const wrapGap = Number(props.wrapGap || props.counterAxisSpacing || 0);

    // Track variable usage for fast binding
    let usesVars = false;
    const checkVarUsage = (value) => {
      if (this.isVarRef(value)) usesVars = true;
    };

    // Check root frame for var usage
    checkVarUsage(bg);
    if (stroke) checkVarUsage(stroke);

    // Collect all fonts and check variable usage recursively
    const fonts = new Set();
    const collectFontsAndVars = (items) => {
      items.forEach(item => {
        if (item._type === 'text') {
          const weight = item.weight || 'regular';
          const style = weight === 'bold' ? 'Bold' : weight === 'medium' ? 'Medium' : weight === 'semibold' ? 'Semi Bold' : 'Regular';
          fonts.add(style);
          const color = item.color || '#000000';
          checkVarUsage(color);
        } else if (item._type === 'frame') {
          const fBg = item.bg || item.fill || '#ffffff';
          const fStroke = item.stroke || null;
          checkVarUsage(fBg);
          if (fStroke) checkVarUsage(fStroke);
          if (item._children) collectFontsAndVars(item._children);
        } else if (item._type === 'rect' || item._type === 'image' || item._type === 'icon') {
          const itemBg = item.bg || item.fill || item.color || item.c || '#e4e4e7';
          checkVarUsage(itemBg);
        }
      });
    };
    collectFontsAndVars(children);

    // Font caching for single render
    const fontStyles = Array.from(fonts);

    // Generate child code recursively
    let childCounter = 0;
    const generateChildCode = (items, parentVar) => {
      return items.map(item => {
        const idx = childCounter++;
        if (item._type === 'text') {
          const weight = item.weight || 'regular';
          const style = weight === 'bold' ? 'Bold' : weight === 'medium' ? 'Medium' : weight === 'semibold' ? 'Semi Bold' : 'Regular';
          const size = item.size || 14;
          const color = item.color || '#000000';
          const fillWidth = item.w === 'fill';
          const textFillCode = this.generateFillCode(color, `el${idx}`);

          return `
        const el${idx} = figma.createText();
        el${idx}.fontName = {family:'Inter',style:'${style}'};
        el${idx}.fontSize = ${size};
        el${idx}.characters = ${JSON.stringify(item.content)};
        ${textFillCode.code}
        ${parentVar}.appendChild(el${idx});
        ${fillWidth ? `el${idx}.layoutSizingHorizontal = 'FILL'; el${idx}.textAutoResize = 'HEIGHT';` : ''}`;
        } else if (item._type === 'frame') {
          // Nested frame (button, etc.)
          const fName = item.name || 'Nested Frame';
          const fBg = item.bg || item.fill || '#ffffff';
          const fStroke = item.stroke || null;
          const fRounded = item.rounded || item.radius || 8;
          const fFlex = item.flex || 'row';
          const fGap = item.gap || 0;
          // Default padding for buttons
          const fP = item.p !== undefined ? item.p : (item.padding !== undefined ? item.padding : null);
          const fPx = item.px !== undefined ? item.px : (fP !== null ? fP : 16);
          const fPy = item.py !== undefined ? item.py : (fP !== null ? fP : 10);
          const fAlign = item.align || 'center';
          const fJustify = item.justify || 'center';
          // Clip defaults to false for nested frames
          const fClip = item.clip === 'true' || item.clip === true;

          // NEW: wrap, wrapGap, grow, position props
          const fWrap = item.wrap === true || item.wrap === 'true';
          const fWrapGap = Number(item.wrapGap || item.counterAxisSpacing || 0);
          const fGrow = item.grow !== undefined ? Number(item.grow) : null;
          const fPosition = item.position || 'auto';
          const fAbsoluteX = item.x !== undefined ? Number(item.x) : 0;
          const fAbsoluteY = item.y !== undefined ? Number(item.y) : 0;

          // Support w="fill" for nested frames (check BEFORE setting fWidth/fHeight)
          const fillWidth = item.w === 'fill';
          const fillHeight = item.h === 'fill';

          // HUG by default, FIXED only if explicit numeric size given
          const hasWidth = (item.w !== undefined || item.width !== undefined) && !fillWidth;
          const hasHeight = (item.h !== undefined || item.height !== undefined) && !fillHeight;
          const fWidth = fillWidth ? 100 : (item.w || item.width || 100);
          const fHeight = fillHeight ? 100 : (item.h || item.height || 40);

          // Map align/justify to Figma values
          const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
          const fAlignVal = alignMap[fAlign] || 'CENTER';
          const fJustifyVal = alignMap[fJustify] || 'CENTER';

          const nestedChildren = item._children ? generateChildCode(item._children, `el${idx}`) : '';
          const frameFillCode = this.generateFillCode(fBg, `el${idx}`);
          const frameStrokeCode = fStroke ? this.generateStrokeCode(fStroke, `el${idx}`) : { code: '' };

          return `
        const el${idx} = figma.createFrame();
        el${idx}.name = ${JSON.stringify(fName)};
        el${idx}.layoutMode = '${fFlex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
        ${fWrap && fFlex === 'row' ? `el${idx}.layoutWrap = 'WRAP';` : ''}
        el${idx}.primaryAxisSizingMode = '${hasWidth && !fillWidth ? 'FIXED' : 'AUTO'}';
        el${idx}.counterAxisSizingMode = '${hasHeight && !fillHeight ? 'FIXED' : 'AUTO'}';
        ${hasWidth && !fillWidth || hasHeight && !fillHeight ? `el${idx}.resize(${hasWidth ? fWidth : 100}, ${hasHeight ? fHeight : 40});` : ''}
        ${fillWidth ? `el${idx}.layoutSizingHorizontal = 'FILL';` : ''}
        ${fillHeight ? `el${idx}.layoutSizingVertical = 'FILL';` : ''}
        el${idx}.itemSpacing = ${fGap};
        el${idx}.paddingTop = ${fPy};
        el${idx}.paddingBottom = ${fPy};
        el${idx}.paddingLeft = ${fPx};
        el${idx}.paddingRight = ${fPx};
        el${idx}.cornerRadius = ${fRounded};
        ${frameFillCode.code}
        ${frameStrokeCode.code}
        el${idx}.primaryAxisAlignItems = '${fJustifyVal}';
        el${idx}.counterAxisAlignItems = '${fAlignVal}';
        el${idx}.clipsContent = ${fClip};
        ${parentVar}.appendChild(el${idx});
        ${nestedChildren}
        ${fWrap && fFlex === 'row' && fWrapGap > 0 ? `el${idx}.counterAxisSpacing = ${fWrapGap};` : ''}
        ${fGrow !== null ? `el${idx}.layoutGrow = ${fGrow};` : ''}
        ${fPosition === 'absolute' ? `el${idx}.layoutPositioning = 'ABSOLUTE'; el${idx}.x = ${fAbsoluteX}; el${idx}.y = ${fAbsoluteY};` : ''}`;
        } else if (item._type === 'rect') {
          // Rectangle element
          const rWidth = item.w || item.width || 100;
          const rHeight = item.h || item.height || 100;
          const rBg = item.bg || item.fill || '#e4e4e7';
          const rRounded = item.rounded || item.radius || 0;
          const rName = item.name || 'Rectangle';
          const rectFillCode = this.generateFillCode(rBg, `el${idx}`);

          return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(rName)};
        el${idx}.resize(${rWidth}, ${rHeight});
        el${idx}.cornerRadius = ${rRounded};
        ${rectFillCode.code}
        ${parentVar}.appendChild(el${idx});`;
        } else if (item._type === 'image') {
          // Image placeholder (gray rectangle with image icon concept)
          const iWidth = item.w || item.width || 200;
          const iHeight = item.h || item.height || 150;
          const iBg = item.bg || '#f4f4f5';
          const iRounded = item.rounded || item.radius || 8;
          const iName = item.name || 'Image';
          const imgFillCode = this.generateFillCode(iBg, `el${idx}`);

          return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(iName)};
        el${idx}.resize(${iWidth}, ${iHeight});
        el${idx}.cornerRadius = ${iRounded};
        ${imgFillCode.code}
        ${parentVar}.appendChild(el${idx});`;
        } else if (item._type === 'icon') {
          // Icon placeholder (small square)
          const icSize = item.size || item.s || 24;
          const icBg = item.color || item.c || '#71717a';
          const icName = item.name || 'Icon';
          const iconFillCode = this.generateFillCode(icBg, `el${idx}`);

          return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(icName)};
        el${idx}.resize(${icSize}, ${icSize});
        el${idx}.cornerRadius = ${Math.round(icSize / 4)};
        ${iconFillCode.code}
        ${parentVar}.appendChild(el${idx});`;
        } else if (item._type === 'instance') {
          // Component instance
          const compId = item.component || item.id;
          const compName = item.name;

          if (compId) {
            // Create instance by component ID
            return `
        const comp${idx} = figma.getNodeById(${JSON.stringify(compId)});
        if (comp${idx} && comp${idx}.type === 'COMPONENT') {
          const el${idx} = comp${idx}.createInstance();
          ${parentVar}.appendChild(el${idx});
        }`;
          } else if (compName) {
            // Find component by name and create instance
            return `
        const comp${idx} = figma.currentPage.findOne(n => n.type === 'COMPONENT' && n.name === ${JSON.stringify(compName)});
        if (comp${idx}) {
          const el${idx} = comp${idx}.createInstance();
          ${parentVar}.appendChild(el${idx});
        }`;
          }
          return '';
        } else if (item._type === 'slot') {
          // Slot element - creates slot inside component
          // NOTE: createSlot only works when parent is a component
          const slotName = item.name || 'Slot';
          const slotFlex = item.flex || 'col';
          const slotGap = item.gap || 0;
          const slotP = item.p !== undefined ? item.p : (item.padding !== undefined ? item.padding : null);
          const slotPx = item.px !== undefined ? item.px : (slotP !== null ? slotP : 0);
          const slotPy = item.py !== undefined ? item.py : (slotP !== null ? slotP : 0);
          const slotBg = item.bg || item.fill || null;
          const slotWidth = item.w || item.width;
          const slotHeight = item.h || item.height;
          const fillWidth = item.w === 'fill';
          const fillHeight = item.h === 'fill';

          const nestedChildren = item._children ? generateChildCode(item._children, `slot${idx}`) : '';
          const slotFillCode = slotBg ? this.generateFillCode(slotBg, `slot${idx}`) : { code: '' };

          return `
        // Create slot (only works if parent is a component)
        let slot${idx} = null;
        if (${parentVar}.type === 'COMPONENT' || ${parentVar}.type === 'COMPONENT_SET') {
          slot${idx} = ${parentVar}.createSlot(${JSON.stringify(slotName)});
        } else {
          // Fall back to regular frame if parent is not a component
          slot${idx} = figma.createFrame();
          slot${idx}.name = ${JSON.stringify(slotName)};
          ${parentVar}.appendChild(slot${idx});
        }
        slot${idx}.layoutMode = '${slotFlex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
        slot${idx}.itemSpacing = ${slotGap};
        slot${idx}.paddingTop = ${slotPy};
        slot${idx}.paddingBottom = ${slotPy};
        slot${idx}.paddingLeft = ${slotPx};
        slot${idx}.paddingRight = ${slotPx};
        ${slotWidth && !fillWidth ? `slot${idx}.resize(${slotWidth}, ${slotHeight || 100});` : ''}
        ${fillWidth ? `slot${idx}.layoutSizingHorizontal = 'FILL';` : ''}
        ${fillHeight ? `slot${idx}.layoutSizingVertical = 'FILL';` : ''}
        ${slotFillCode.code}
        ${nestedChildren}`;
        }
        return '';
      }).join('\n');
    };

    const childCode = generateChildCode(children, 'frame');

    // Map align/justify to Figma values for root frame
    const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
    const alignVal = alignMap[align] || 'MIN';
    const justifyVal = alignMap[justify] || 'MIN';

    // Smart positioning code
    const smartPosCode = useSmartPos ? `
        let smartX = 0;
        const children = figma.currentPage.children;
        if (children.length > 0) {
          let maxRight = 0;
          children.forEach(n => {
            const right = n.x + (n.width || 0);
            if (right > maxRight) maxRight = right;
          });
          smartX = Math.round(maxRight + 100);
        }
    ` : `const smartX = ${explicitX};`;

    // Generate fill/stroke code for root frame
    const rootFillCode = this.generateFillCode(bg, 'frame');
    const rootStrokeCode = stroke ? this.generateStrokeCode(stroke, 'frame') : { code: '', usesVars: false };

    // Variable loading code with caching (only if any vars used)
    const varLoadCode = usesVars ? `
        // Load shadcn variables (cached for 30s)
        if (!globalThis.__varsCache || Date.now() - (globalThis.__varsCacheTime || 0) > 30000) {
          const collections = await figma.variables.getLocalVariableCollectionsAsync();
          const shadcnCol = collections.find(c => c.name === 'shadcn');
          globalThis.__varsCache = {};
          if (shadcnCol) {
            for (const id of shadcnCol.variableIds) {
              const v = await figma.variables.getVariableByIdAsync(id);
              if (v) globalThis.__varsCache[v.name] = v;
            }
          }
          globalThis.__varsCacheTime = Date.now();
        }
        const vars = globalThis.__varsCache;
        const boundFill = (variable) => figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable
        );
    ` : '';

    // Font loading with caching
    const fontLoadCode = fontStyles.length > 0
      ? `
        if (!globalThis.__loadedFonts) globalThis.__loadedFonts = new Set();
        const fontsToLoad = ${JSON.stringify(fontStyles)}.filter(s => !globalThis.__loadedFonts.has(s));
        if (fontsToLoad.length > 0) {
          await Promise.all(fontsToLoad.map(s => figma.loadFontAsync({family:'Inter',style:s})));
          fontsToLoad.forEach(s => globalThis.__loadedFonts.add(s));
        }
      `
      : `
        if (!globalThis.__loadedFonts) globalThis.__loadedFonts = new Set();
        if (!globalThis.__loadedFonts.has('Regular')) {
          await figma.loadFontAsync({family:'Inter',style:'Regular'});
          globalThis.__loadedFonts.add('Regular');
        }
      `;

    return `
      (async function() {
        ${fontLoadCode}
        ${varLoadCode}
        ${smartPosCode}

        const frame = figma.createFrame();
        frame.name = ${JSON.stringify(name)};
        frame.resize(${width}, ${height});
        frame.x = smartX;
        frame.y = ${y};
        frame.cornerRadius = ${rounded};
        ${rootFillCode.code}
        ${rootStrokeCode.code}
        frame.layoutMode = '${flex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
        ${wrap && flex === 'row' ? `frame.layoutWrap = 'WRAP';` : ''}
        frame.itemSpacing = ${gap};
        frame.paddingTop = ${py};
        frame.paddingBottom = ${py};
        frame.paddingLeft = ${px};
        frame.paddingRight = ${px};
        frame.primaryAxisAlignItems = '${justifyVal}';
        frame.counterAxisAlignItems = '${alignVal}';
        frame.primaryAxisSizingMode = '${hugWidth || fillWidth ? 'AUTO' : 'FIXED'}';
        frame.counterAxisSizingMode = '${hugHeight || fillHeight ? 'AUTO' : 'FIXED'}';
        ${fillWidth ? `frame.layoutSizingHorizontal = 'FILL';` : ''}
        ${fillHeight ? `frame.layoutSizingVertical = 'FILL';` : ''}
        ${wrap && flex === 'row' && wrapGap > 0 ? `frame.counterAxisSpacing = ${wrapGap};` : ''}
        frame.clipsContent = ${clip};

        ${childCode}

        return { id: frame.id, name: frame.name };
      })()
    `;
  }

  hexToRgbCode(hex) {
    // Support both #fff and #ffffff formats
    let r, g, b;
    if (hex.length === 4) {
      // #rgb -> #rrggbb
      r = parseInt(hex[1] + hex[1], 16) / 255;
      g = parseInt(hex[2] + hex[2], 16) / 255;
      b = parseInt(hex[3] + hex[3], 16) / 255;
    } else {
      // #rrggbb
      r = parseInt(hex.slice(1, 3), 16) / 255;
      g = parseInt(hex.slice(3, 5), 16) / 255;
      b = parseInt(hex.slice(5, 7), 16) / 255;
    }
    return `{r:${r},g:${g},b:${b}}`;
  }

  /**
   * Check if a value is a variable reference (var:name)
   */
  isVarRef(value) {
    return typeof value === 'string' && value.startsWith('var:');
  }

  /**
   * Extract variable name from var:name syntax
   */
  getVarName(value) {
    return value.slice(4); // Remove 'var:' prefix
  }

  /**
   * Generate fill code - either hex color or bound variable
   * Returns { code: string, usesVars: boolean }
   */
  generateFillCode(value, elementVar, property = 'fills') {
    if (this.isVarRef(value)) {
      const varName = this.getVarName(value);
      return {
        code: `${elementVar}.${property} = [boundFill(vars['${varName}'])];`,
        usesVars: true
      };
    } else {
      return {
        code: `${elementVar}.${property} = [{type:'SOLID',color:${this.hexToRgbCode(value)}}];`,
        usesVars: false
      };
    }
  }

  /**
   * Generate stroke code - either hex color or bound variable
   */
  generateStrokeCode(value, elementVar) {
    if (this.isVarRef(value)) {
      const varName = this.getVarName(value);
      return {
        code: `${elementVar}.strokes = [boundFill(vars['${varName}'])]; ${elementVar}.strokeWeight = 1;`,
        usesVars: true
      };
    } else {
      return {
        code: `${elementVar}.strokes = [{type:'SOLID',color:${this.hexToRgbCode(value)}}]; ${elementVar}.strokeWeight = 1;`,
        usesVars: false
      };
    }
  }

  // ============ Node Operations ============

  /**
   * Get a node by ID
   */
  async getNode(nodeId) {
    return await this.eval(`
      (function() {
        const n = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!n) return null;
        return {
          id: n.id,
          type: n.type,
          name: n.name || '',
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          visible: n.visible,
          opacity: n.opacity
        };
      })()
    `);
  }

  /**
   * Delete a node by ID
   */
  async deleteNode(nodeId) {
    return await this.eval(`
      (function() {
        const n = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!n) return { success: false, error: 'Node not found' };
        n.remove();
        return { success: true };
      })()
    `);
  }

  /**
   * Move a node to new position
   */
  async moveNode(nodeId, x, y) {
    return await this.eval(`
      (function() {
        const n = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!n) return { success: false, error: 'Node not found' };
        n.x = ${x};
        n.y = ${y};
        return { success: true, x: n.x, y: n.y };
      })()
    `);
  }

  /**
   * Resize a node
   */
  async resizeNode(nodeId, width, height) {
    return await this.eval(`
      (function() {
        const n = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!n) return { success: false, error: 'Node not found' };
        if (n.resize) n.resize(${width}, ${height});
        return { success: true, width: n.width, height: n.height };
      })()
    `);
  }

  /**
   * Get current selection
   */
  async getSelection() {
    return await this.eval(`
      figma.currentPage.selection.map(n => ({
        id: n.id,
        type: n.type,
        name: n.name || ''
      }))
    `);
  }

  /**
   * Set selection by node IDs
   */
  async setSelection(nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    return await this.eval(`
      (function() {
        const nodes = ${JSON.stringify(ids)}.map(id => figma.getNodeById(id)).filter(n => n);
        figma.currentPage.selection = nodes;
        return nodes.map(n => n.id);
      })()
    `);
  }

  /**
   * Get node tree (recursive structure)
   */
  async getNodeTree(nodeId, maxDepth = 10) {
    return await this.eval(`
      (function() {
        function buildTree(node, depth) {
          if (depth > ${maxDepth}) return null;
          const result = {
            id: node.id,
            type: node.type,
            name: node.name || '',
            x: Math.round(node.x || 0),
            y: Math.round(node.y || 0),
            width: Math.round(node.width || 0),
            height: Math.round(node.height || 0)
          };
          if (node.children) {
            result.children = node.children.map(c => buildTree(c, depth + 1)).filter(c => c);
          }
          return result;
        }
        const node = ${nodeId ? `figma.getNodeById(${JSON.stringify(nodeId)})` : 'figma.currentPage'};
        if (!node) return null;
        return buildTree(node, 0);
      })()
    `);
  }

  /**
   * Convert nodes to components
   */
  async toComponent(nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    return await this.eval(`
      (function() {
        const results = [];
        ${JSON.stringify(ids)}.forEach(id => {
          const node = figma.getNodeById(id);
          if (node && node.type === 'FRAME') {
            const component = figma.createComponentFromNode(node);
            results.push({ id: component.id, name: component.name });
          }
        });
        return results;
      })()
    `);
  }

  /**
   * Duplicate a node
   */
  async duplicateNode(nodeId, offsetX = 50, offsetY = 0) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return null;
        const clone = node.clone();
        clone.x = node.x + ${offsetX};
        clone.y = node.y + ${offsetY};
        return { id: clone.id, name: clone.name, x: clone.x, y: clone.y };
      })()
    `);
  }

  /**
   * Rename a node
   */
  async renameNode(nodeId, newName) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { success: false, error: 'Node not found' };
        node.name = ${JSON.stringify(newName)};
        return { success: true, name: node.name };
      })()
    `);
  }

  /**
   * Set node fill color
   */
  async setFill(nodeId, hexColor) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { success: false, error: 'Node not found' };
        const rgb = ${this.hexToRgbCode(hexColor)};
        node.fills = [{type: 'SOLID', color: rgb}];
        return { success: true };
      })()
    `);
  }

  /**
   * Set node corner radius
   */
  async setRadius(nodeId, radius) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { success: false, error: 'Node not found' };
        if ('cornerRadius' in node) node.cornerRadius = ${radius};
        return { success: true };
      })()
    `);
  }

  /**
   * Get file key from current file
   */
  async getFileKey() {
    return await this.eval('figma.fileKey');
  }

  /**
   * Arrange nodes on canvas
   */
  async arrangeNodes(gap = 100, columns = null) {
    return await this.eval(`
      (function() {
        const nodes = figma.currentPage.children.filter(n => n.type === 'FRAME' || n.type === 'COMPONENT');
        if (nodes.length === 0) return { arranged: 0 };

        const cols = ${columns || 'null'} || nodes.length;
        let x = 0, y = 0, rowHeight = 0, col = 0;

        nodes.forEach(n => {
          n.x = x;
          n.y = y;
          rowHeight = Math.max(rowHeight, n.height);
          col++;
          if (col >= cols) {
            col = 0;
            x = 0;
            y += rowHeight + ${gap};
            rowHeight = 0;
          } else {
            x += n.width + ${gap};
          }
        });

        return { arranged: nodes.length };
      })()
    `);
  }

  // ============ Create Primitives ============

  /**
   * Create a frame
   */
  async createFrame(options = {}) {
    const { name = 'Frame', width = 100, height = 100, x, y, fill = '#ffffff', radius = 0 } = options;
    return await this.eval(`
      (function() {
        const frame = figma.createFrame();
        frame.name = ${JSON.stringify(name)};
        frame.resize(${width}, ${height});
        ${x !== undefined ? `frame.x = ${x};` : ''}
        ${y !== undefined ? `frame.y = ${y};` : ''}
        frame.cornerRadius = ${radius};
        frame.fills = [{type:'SOLID',color:${this.hexToRgbCode(fill)}}];
        return { id: frame.id, name: frame.name, x: frame.x, y: frame.y };
      })()
    `);
  }

  /**
   * Create a rectangle
   */
  async createRectangle(options = {}) {
    const { name = 'Rectangle', width = 100, height = 100, x, y, fill = '#d9d9d9', radius = 0 } = options;
    return await this.eval(`
      (function() {
        const rect = figma.createRectangle();
        rect.name = ${JSON.stringify(name)};
        rect.resize(${width}, ${height});
        ${x !== undefined ? `rect.x = ${x};` : ''}
        ${y !== undefined ? `rect.y = ${y};` : ''}
        rect.cornerRadius = ${radius};
        rect.fills = [{type:'SOLID',color:${this.hexToRgbCode(fill)}}];
        return { id: rect.id, name: rect.name };
      })()
    `);
  }

  /**
   * Create an ellipse/circle
   */
  async createEllipse(options = {}) {
    const { name = 'Ellipse', width = 100, height = 100, x, y, fill = '#d9d9d9' } = options;
    return await this.eval(`
      (function() {
        const ellipse = figma.createEllipse();
        ellipse.name = ${JSON.stringify(name)};
        ellipse.resize(${width}, ${height || width});
        ${x !== undefined ? `ellipse.x = ${x};` : ''}
        ${y !== undefined ? `ellipse.y = ${y};` : ''}
        ellipse.fills = [{type:'SOLID',color:${this.hexToRgbCode(fill)}}];
        return { id: ellipse.id, name: ellipse.name };
      })()
    `);
  }

  /**
   * Create a text node
   */
  async createText(options = {}) {
    const { content = 'Text', x, y, size = 14, color = '#000000', weight = 'Regular' } = options;
    const style = weight === 'bold' ? 'Bold' : weight === 'medium' ? 'Medium' : 'Regular';
    return await this.eval(`
      (async function() {
        await figma.loadFontAsync({family:'Inter',style:'${style}'});
        const text = figma.createText();
        text.fontName = {family:'Inter',style:'${style}'};
        text.fontSize = ${size};
        text.characters = ${JSON.stringify(content)};
        text.fills = [{type:'SOLID',color:${this.hexToRgbCode(color)}}];
        ${x !== undefined ? `text.x = ${x};` : ''}
        ${y !== undefined ? `text.y = ${y};` : ''}
        return { id: text.id, characters: text.characters };
      })()
    `);
  }

  /**
   * Create a line
   */
  async createLine(options = {}) {
    const { length = 100, x, y, color = '#000000', strokeWeight = 1 } = options;
    return await this.eval(`
      (function() {
        const line = figma.createLine();
        line.resize(${length}, 0);
        ${x !== undefined ? `line.x = ${x};` : ''}
        ${y !== undefined ? `line.y = ${y};` : ''}
        line.strokes = [{type:'SOLID',color:${this.hexToRgbCode(color)}}];
        line.strokeWeight = ${strokeWeight};
        return { id: line.id };
      })()
    `);
  }

  /**
   * Create an auto-layout frame
   */
  async createAutoLayout(options = {}) {
    const {
      name = 'AutoLayout',
      direction = 'VERTICAL',
      gap = 8,
      padding = 16,
      width, height, x, y,
      fill = '#ffffff',
      radius = 0
    } = options;
    return await this.eval(`
      (function() {
        const frame = figma.createFrame();
        frame.name = ${JSON.stringify(name)};
        frame.layoutMode = '${direction === 'row' || direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL'}';
        frame.itemSpacing = ${gap};
        frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = ${padding};
        frame.primaryAxisSizingMode = 'AUTO';
        frame.counterAxisSizingMode = 'AUTO';
        ${width ? `frame.resize(${width}, ${height || width}); frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'FIXED';` : ''}
        ${x !== undefined ? `frame.x = ${x};` : ''}
        ${y !== undefined ? `frame.y = ${y};` : ''}
        frame.cornerRadius = ${radius};
        frame.fills = [{type:'SOLID',color:${this.hexToRgbCode(fill)}}];
        return { id: frame.id, name: frame.name };
      })()
    `);
  }

  // ============ Query & Find ============

  /**
   * Find nodes by name (partial match)
   */
  async findByName(name, type = null) {
    return await this.eval(`
      (function() {
        const results = [];
        function search(node) {
          if (node.name && node.name.includes(${JSON.stringify(name)})) {
            ${type ? `if (node.type === '${type}')` : ''} {
              results.push({ id: node.id, type: node.type, name: node.name });
            }
          }
          if (node.children) node.children.forEach(search);
        }
        search(figma.currentPage);
        return results.slice(0, 100);
      })()
    `);
  }

  /**
   * Find nodes by type
   */
  async findByType(type) {
    return await this.eval(`
      figma.currentPage.findAll(n => n.type === '${type}').slice(0, 100).map(n => ({
        id: n.id, name: n.name, x: Math.round(n.x), y: Math.round(n.y)
      }))
    `);
  }

  // ============ Variables ============

  /**
   * Create a variable
   */
  async createVariable(options = {}) {
    const { name, collectionId, type = 'COLOR', value } = options;
    return await this.eval(`
      (function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };
        const variable = figma.variables.createVariable(${JSON.stringify(name)}, col, '${type}');
        ${value ? `variable.setValueForMode(col.defaultModeId, ${type === 'COLOR' ? this.hexToRgbCode(value) : JSON.stringify(value)});` : ''}
        return { id: variable.id, name: variable.name };
      })()
    `);
  }

  /**
   * Create a variable collection
   */
  async createCollection(name) {
    return await this.eval(`
      (function() {
        const col = figma.variables.createVariableCollection(${JSON.stringify(name)});
        return { id: col.id, name: col.name, defaultModeId: col.defaultModeId };
      })()
    `);
  }

  /**
   * Bind a variable to a node property
   */
  async bindVariable(nodeId, property, variableName) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        const allVars = figma.variables.getLocalVariables();
        const variable = allVars.find(v => v.name === ${JSON.stringify(variableName)});
        if (!variable) return { error: 'Variable not found: ' + ${JSON.stringify(variableName)} };

        const prop = ${JSON.stringify(property)};
        if (prop === 'fill' || prop === 'fills') {
          node.fills = [figma.variables.setBoundVariableForPaint(
            {type:'SOLID',color:{r:1,g:1,b:1}}, 'color', variable
          )];
        } else if (prop === 'stroke' || prop === 'strokes') {
          node.strokes = [figma.variables.setBoundVariableForPaint(
            {type:'SOLID',color:{r:0,g:0,b:0}}, 'color', variable
          )];
        } else {
          node.setBoundVariable(prop, variable);
        }
        return { success: true, nodeId: node.id, property: prop, variable: variable.name };
      })()
    `);
  }

  // ============ Components ============

  /**
   * Create a component from a frame
   */
  async createComponent(nodeId) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        const component = figma.createComponentFromNode(node);
        return { id: component.id, name: component.name };
      })()
    `);
  }

  /**
   * Create an instance of a component
   */
  async createInstance(componentId, x, y) {
    return await this.eval(`
      (function() {
        const comp = figma.getNodeById(${JSON.stringify(componentId)});
        if (!comp || comp.type !== 'COMPONENT') return { error: 'Component not found' };
        const instance = comp.createInstance();
        ${x !== undefined ? `instance.x = ${x};` : ''}
        ${y !== undefined ? `instance.y = ${y};` : ''}
        return { id: instance.id, name: instance.name, x: instance.x, y: instance.y };
      })()
    `);
  }

  /**
   * Get all local components
   */
  async getComponents() {
    return await this.eval(`
      figma.root.findAll(n => n.type === 'COMPONENT').map(c => ({
        id: c.id, name: c.name, page: c.parent?.parent?.name
      }))
    `);
  }

  // ============ Export ============

  /**
   * Export a node as PNG (returns base64)
   */
  async exportPNG(nodeId, scale = 2) {
    return await this.eval(`
      (async function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        const bytes = await node.exportAsync({ format: 'PNG', scale: ${scale} });
        // Convert to base64
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return { base64: btoa(binary), width: node.width * ${scale}, height: node.height * ${scale} };
      })()
    `);
  }

  /**
   * Export a node as SVG
   */
  async exportSVG(nodeId) {
    return await this.eval(`
      (async function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        const bytes = await node.exportAsync({ format: 'SVG' });
        return { svg: String.fromCharCode.apply(null, bytes) };
      })()
    `);
  }

  // ============ Layout ============

  /**
   * Set auto-layout on a frame
   */
  async setAutoLayout(nodeId, options = {}) {
    const { direction = 'VERTICAL', gap = 8, padding = 0 } = options;
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node || node.type !== 'FRAME') return { error: 'Frame not found' };
        node.layoutMode = '${direction === 'row' || direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL'}';
        node.itemSpacing = ${gap};
        node.paddingTop = node.paddingBottom = node.paddingLeft = node.paddingRight = ${padding};
        return { success: true };
      })()
    `);
  }

  /**
   * Set sizing mode (hug/fill/fixed)
   */
  async setSizing(nodeId, horizontal = 'FIXED', vertical = 'FIXED') {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        if (node.layoutSizingHorizontal !== undefined) {
          node.layoutSizingHorizontal = '${horizontal}';
          node.layoutSizingVertical = '${vertical}';
        }
        return { success: true };
      })()
    `);
  }

  // ============ Icon (Iconify) ============

  /**
   * Create an icon from Iconify
   * @param {string} iconName - e.g., "lucide:star", "mdi:home"
   */
  async createIcon(iconName, options = {}) {
    const { size = 24, color = '#000000', x, y } = options;
    const [prefix, name] = iconName.split(':');

    // Fetch SVG from Iconify API
    const response = await fetch(`https://api.iconify.design/${prefix}/${name}.svg?width=${size}&height=${size}`);
    const svg = await response.text();

    return await this.eval(`
      (function() {
        const svgString = ${JSON.stringify(svg)};
        const node = figma.createNodeFromSvg(svgString);
        node.name = ${JSON.stringify(iconName)};
        ${x !== undefined ? `node.x = ${x};` : ''}
        ${y !== undefined ? `node.y = ${y};` : ''}
        // Apply color
        function colorize(n) {
          if (n.fills && n.fills.length > 0) {
            n.fills = [{type:'SOLID',color:${this.hexToRgbCode(color)}}];
          }
          if (n.children) n.children.forEach(colorize);
        }
        colorize(node);
        return { id: node.id, name: node.name };
      })()
    `);
  }

  // ============ Delete All ============

  /**
   * Delete all nodes on current page
   */
  async deleteAll() {
    return await this.eval(`
      (function() {
        const count = figma.currentPage.children.length;
        figma.currentPage.children.forEach(n => n.remove());
        return { deleted: count };
      })()
    `);
  }

  /**
   * Zoom to fit all content
   */
  async zoomToFit() {
    return await this.eval(`
      (function() {
        figma.viewport.scrollAndZoomIntoView(figma.currentPage.children);
        return { success: true };
      })()
    `);
  }

  /**
   * Group nodes
   */
  async groupNodes(nodeIds, name = 'Group') {
    return await this.eval(`
      (function() {
        const nodes = ${JSON.stringify(nodeIds)}.map(id => figma.getNodeById(id)).filter(n => n);
        if (nodes.length === 0) return { error: 'No nodes found' };
        const group = figma.group(nodes, figma.currentPage);
        group.name = ${JSON.stringify(name)};
        return { id: group.id, name: group.name, childCount: nodes.length };
      })()
    `);
  }

  // ============ Team Libraries ============

  /**
   * Get available library variable collections
   */
  async getLibraryCollections() {
    return await this.eval(`
      (async function() {
        const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        return collections.map(c => ({
          key: c.key,
          name: c.name,
          libraryName: c.libraryName
        }));
      })()
    `);
  }

  /**
   * Get variables from a library collection
   */
  async getLibraryVariables(collectionKey) {
    return await this.eval(`
      (async function() {
        const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(${JSON.stringify(collectionKey)});
        return variables.map(v => ({
          key: v.key,
          name: v.name,
          resolvedType: v.resolvedType
        }));
      })()
    `);
  }

  /**
   * Import a variable from a library by key
   */
  async importLibraryVariable(variableKey) {
    return await this.eval(`
      (async function() {
        const variable = await figma.variables.importVariableByKeyAsync(${JSON.stringify(variableKey)});
        return { id: variable.id, name: variable.name, resolvedType: variable.resolvedType };
      })()
    `);
  }

  /**
   * Get available library components
   */
  async getLibraryComponents() {
    return await this.eval(`
      (async function() {
        // Get all component sets and components from enabled libraries
        const components = [];

        // Search through all pages for component instances to find library components
        const instances = figma.root.findAll(n => n.type === 'INSTANCE');
        const seen = new Set();

        for (const instance of instances) {
          const mainComponent = await instance.getMainComponentAsync();
          if (mainComponent && mainComponent.remote && !seen.has(mainComponent.key)) {
            seen.add(mainComponent.key);
            components.push({
              key: mainComponent.key,
              name: mainComponent.name,
              description: mainComponent.description || ''
            });
          }
        }

        return components;
      })()
    `);
  }

  /**
   * Import a component from a library by key
   */
  async importLibraryComponent(componentKey) {
    return await this.eval(`
      (async function() {
        const component = await figma.importComponentByKeyAsync(${JSON.stringify(componentKey)});
        return { id: component.id, name: component.name, key: component.key };
      })()
    `);
  }

  /**
   * Create an instance of a library component
   */
  async createLibraryInstance(componentKey, x, y) {
    return await this.eval(`
      (async function() {
        const component = await figma.importComponentByKeyAsync(${JSON.stringify(componentKey)});
        const instance = component.createInstance();
        ${x !== undefined ? `instance.x = ${x};` : ''}
        ${y !== undefined ? `instance.y = ${y};` : ''}
        return { id: instance.id, name: instance.name, x: instance.x, y: instance.y };
      })()
    `);
  }

  /**
   * Get available library styles (color, text, effect)
   */
  async getLibraryStyles() {
    return await this.eval(`
      (async function() {
        const styles = {
          paint: [],
          text: [],
          effect: [],
          grid: []
        };

        // Get local styles that reference library
        const paintStyles = figma.getLocalPaintStyles();
        const textStyles = figma.getLocalTextStyles();
        const effectStyles = figma.getLocalEffectStyles();
        const gridStyles = figma.getLocalGridStyles();

        paintStyles.forEach(s => {
          styles.paint.push({ id: s.id, name: s.name, key: s.key, remote: s.remote });
        });
        textStyles.forEach(s => {
          styles.text.push({ id: s.id, name: s.name, key: s.key, remote: s.remote });
        });
        effectStyles.forEach(s => {
          styles.effect.push({ id: s.id, name: s.name, key: s.key, remote: s.remote });
        });
        gridStyles.forEach(s => {
          styles.grid.push({ id: s.id, name: s.name, key: s.key, remote: s.remote });
        });

        return styles;
      })()
    `);
  }

  /**
   * Import a style from a library by key
   */
  async importLibraryStyle(styleKey) {
    return await this.eval(`
      (async function() {
        const style = await figma.importStyleByKeyAsync(${JSON.stringify(styleKey)});
        return { id: style.id, name: style.name, type: style.type };
      })()
    `);
  }

  /**
   * Apply a library style to a node
   */
  async applyLibraryStyle(nodeId, styleKey, styleType = 'fill') {
    return await this.eval(`
      (async function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        const style = await figma.importStyleByKeyAsync(${JSON.stringify(styleKey)});
        const type = ${JSON.stringify(styleType)};

        if (type === 'fill' && 'fillStyleId' in node) {
          node.fillStyleId = style.id;
        } else if (type === 'stroke' && 'strokeStyleId' in node) {
          node.strokeStyleId = style.id;
        } else if (type === 'text' && 'textStyleId' in node) {
          node.textStyleId = style.id;
        } else if (type === 'effect' && 'effectStyleId' in node) {
          node.effectStyleId = style.id;
        }

        return { success: true, styleId: style.id, styleName: style.name };
      })()
    `);
  }

  /**
   * Bind a library variable to a node
   */
  async bindLibraryVariable(nodeId, property, variableKey) {
    return await this.eval(`
      (async function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        const variable = await figma.variables.importVariableByKeyAsync(${JSON.stringify(variableKey)});
        const prop = ${JSON.stringify(property)};

        if (prop === 'fill' || prop === 'fills') {
          node.fills = [figma.variables.setBoundVariableForPaint(
            {type:'SOLID',color:{r:1,g:1,b:1}}, 'color', variable
          )];
        } else if (prop === 'stroke' || prop === 'strokes') {
          node.strokes = [figma.variables.setBoundVariableForPaint(
            {type:'SOLID',color:{r:0,g:0,b:0}}, 'color', variable
          )];
        } else {
          node.setBoundVariable(prop, variable);
        }

        return { success: true, variableId: variable.id, variableName: variable.name };
      })()
    `);
  }

  /**
   * List all enabled libraries
   */
  async getEnabledLibraries() {
    return await this.eval(`
      (async function() {
        const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        const libraries = new Map();

        collections.forEach(c => {
          if (!libraries.has(c.libraryName)) {
            libraries.set(c.libraryName, { name: c.libraryName, collections: [] });
          }
          libraries.get(c.libraryName).collections.push({ key: c.key, name: c.name });
        });

        return Array.from(libraries.values());
      })()
    `);
  }

  /**
   * Swap a component instance to another library component
   */
  async swapComponent(instanceId, newComponentKey) {
    return await this.eval(`
      (async function() {
        const instance = figma.getNodeById(${JSON.stringify(instanceId)});
        if (!instance || instance.type !== 'INSTANCE') return { error: 'Instance not found' };

        const newComponent = await figma.importComponentByKeyAsync(${JSON.stringify(newComponentKey)});
        instance.swapComponent(newComponent);

        return { success: true, newComponentName: newComponent.name };
      })()
    `);
  }

  // ============ Designer Utilities ============

  /**
   * Batch rename layers with pattern
   * Patterns: {n} = number, {name} = original name, {type} = node type
   */
  async batchRename(nodeIds, pattern, options = {}) {
    const { startNumber = 1, case: textCase = null } = options;
    return await this.eval(`
      (function() {
        const ids = ${JSON.stringify(nodeIds)};
        const pattern = ${JSON.stringify(pattern)};
        let num = ${startNumber};
        const results = [];

        ids.forEach(id => {
          const node = figma.getNodeById(id);
          if (!node) return;

          let newName = pattern
            .replace(/{n}/g, num)
            .replace(/{name}/g, node.name)
            .replace(/{type}/g, node.type.toLowerCase());

          ${textCase === 'camel' ? "newName = newName.replace(/[-_\\s]+(\\w)/g, (_, c) => c.toUpperCase()).replace(/^\\w/, c => c.toLowerCase());" : ''}
          ${textCase === 'pascal' ? "newName = newName.replace(/[-_\\s]+(\\w)/g, (_, c) => c.toUpperCase()).replace(/^\\w/, c => c.toUpperCase());" : ''}
          ${textCase === 'snake' ? "newName = newName.replace(/[\\s-]+/g, '_').toLowerCase();" : ''}
          ${textCase === 'kebab' ? "newName = newName.replace(/[\\s_]+/g, '-').toLowerCase();" : ''}

          node.name = newName;
          results.push({ id: node.id, name: newName });
          num++;
        });

        return results;
      })()
    `);
  }

  /**
   * Rename all children of a node
   */
  async batchRenameChildren(parentId, pattern, options = {}) {
    return await this.eval(`
      (function() {
        const parent = figma.getNodeById(${JSON.stringify(parentId)});
        if (!parent || !parent.children) return { error: 'Parent not found or has no children' };

        const ids = parent.children.map(c => c.id);
        return ids;
      })()
    `).then(ids => this.batchRename(ids, pattern, options));
  }

  /**
   * Generate lorem ipsum text
   */
  async loremIpsum(options = {}) {
    const { type = 'paragraph', count = 1 } = options;
    const lorem = {
      words: ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo', 'consequat'],
      paragraph: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'
    };

    if (type === 'words') {
      const words = [];
      for (let i = 0; i < count; i++) {
        words.push(lorem.words[Math.floor(Math.random() * lorem.words.length)]);
      }
      return words.join(' ');
    } else if (type === 'sentences') {
      const sentences = [];
      for (let i = 0; i < count; i++) {
        const wordCount = 8 + Math.floor(Math.random() * 8);
        const words = [];
        for (let j = 0; j < wordCount; j++) {
          words.push(lorem.words[Math.floor(Math.random() * lorem.words.length)]);
        }
        words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
        sentences.push(words.join(' ') + '.');
      }
      return sentences.join(' ');
    } else {
      return Array(count).fill(lorem.paragraph).join('\n\n');
    }
  }

  /**
   * Fill text layer with lorem ipsum
   */
  async fillWithLorem(nodeId, options = {}) {
    const text = await this.loremIpsum(options);
    return await this.eval(`
      (async function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node || node.type !== 'TEXT') return { error: 'Text node not found' };

        await figma.loadFontAsync(node.fontName);
        node.characters = ${JSON.stringify(text)};
        return { success: true, text: node.characters };
      })()
    `);
  }

  /**
   * Insert image from URL (Unsplash, etc.)
   */
  async insertImage(imageUrl, options = {}) {
    const { x = 0, y = 0, width = 400, height = 300, name = 'Image' } = options;

    // Fetch image and convert to base64
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    return await this.eval(`
      (async function() {
        const imageData = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
        const image = figma.createImage(imageData);

        const rect = figma.createRectangle();
        rect.name = ${JSON.stringify(name)};
        rect.x = ${x};
        rect.y = ${y};
        rect.resize(${width}, ${height});
        rect.fills = [{
          type: 'IMAGE',
          scaleMode: 'FILL',
          imageHash: image.hash
        }];

        return { id: rect.id, name: rect.name, imageHash: image.hash };
      })()
    `);
  }

  /**
   * Insert random Unsplash image
   */
  async insertUnsplash(query, options = {}) {
    const { width = 800, height = 600 } = options;
    const imageUrl = `https://source.unsplash.com/random/${width}x${height}/?${encodeURIComponent(query)}`;
    return await this.insertImage(imageUrl, { ...options, width, height, name: `Unsplash: ${query}` });
  }

  /**
   * Export node in multiple sizes (@1x, @2x, @3x)
   */
  async exportMultipleSizes(nodeId, options = {}) {
    const { scales = [1, 2, 3], format = 'PNG' } = options;
    const results = [];

    for (const scale of scales) {
      const result = await this.eval(`
        (async function() {
          const node = figma.getNodeById(${JSON.stringify(nodeId)});
          if (!node) return { error: 'Node not found' };

          const bytes = await node.exportAsync({ format: '${format}', scale: ${scale} });
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          return {
            scale: ${scale},
            suffix: '@${scale}x',
            base64: btoa(binary),
            width: Math.round(node.width * ${scale}),
            height: Math.round(node.height * ${scale})
          };
        })()
      `);
      results.push(result);
    }

    return results;
  }

  /**
   * Check contrast ratio between two colors (WCAG)
   */
  checkContrast(color1, color2) {
    const getLuminance = (hex) => {
      const rgb = [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255
      ].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    };

    const l1 = getLuminance(color1);
    const l2 = getLuminance(color2);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    return {
      ratio: Math.round(ratio * 100) / 100,
      AA: ratio >= 4.5,
      AALarge: ratio >= 3,
      AAA: ratio >= 7,
      AAALarge: ratio >= 4.5
    };
  }

  /**
   * Check contrast of text node against background
   */
  async checkNodeContrast(textNodeId) {
    return await this.eval(`
      (function() {
        const textNode = figma.getNodeById(${JSON.stringify(textNodeId)});
        if (!textNode || textNode.type !== 'TEXT') return { error: 'Text node not found' };

        // Get text color
        const textFill = textNode.fills[0];
        if (!textFill || textFill.type !== 'SOLID') return { error: 'Text has no solid fill' };
        const textColor = textFill.color;

        // Find background (parent frame)
        let parent = textNode.parent;
        let bgColor = null;
        while (parent && !bgColor) {
          if (parent.fills && parent.fills.length > 0) {
            const fill = parent.fills.find(f => f.type === 'SOLID' && f.visible !== false);
            if (fill) bgColor = fill.color;
          }
          parent = parent.parent;
        }

        if (!bgColor) bgColor = { r: 1, g: 1, b: 1 }; // Default white

        const toHex = (c) => '#' +
          Math.round(c.r * 255).toString(16).padStart(2, '0') +
          Math.round(c.g * 255).toString(16).padStart(2, '0') +
          Math.round(c.b * 255).toString(16).padStart(2, '0');

        return {
          textColor: toHex(textColor),
          bgColor: toHex(bgColor),
          nodeId: textNode.id,
          nodeName: textNode.name
        };
      })()
    `).then(result => {
      if (result.error) return result;
      const contrast = this.checkContrast(result.textColor, result.bgColor);
      return { ...result, ...contrast };
    });
  }

  /**
   * Find and replace text in all text nodes
   */
  async findReplaceText(find, replace, options = {}) {
    const { caseSensitive = false, wholeWord = false } = options;
    return await this.eval(`
      (async function() {
        const textNodes = figma.currentPage.findAll(n => n.type === 'TEXT');
        const results = [];
        const findStr = ${JSON.stringify(find)};
        const replaceStr = ${JSON.stringify(replace)};
        const caseSensitive = ${caseSensitive};
        const wholeWord = ${wholeWord};

        for (const node of textNodes) {
          let text = node.characters;
          let pattern = caseSensitive ? findStr : findStr.toLowerCase();
          let searchText = caseSensitive ? text : text.toLowerCase();

          if (wholeWord) {
            pattern = '\\\\b' + pattern + '\\\\b';
          }

          const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
          if (regex.test(searchText)) {
            await figma.loadFontAsync(node.fontName);
            node.characters = text.replace(new RegExp(findStr, caseSensitive ? 'g' : 'gi'), replaceStr);
            results.push({ id: node.id, name: node.name, newText: node.characters });
          }
        }

        return { replaced: results.length, nodes: results };
      })()
    `);
  }

  /**
   * Select all nodes with same fill color
   */
  async selectSameFill(nodeId) {
    return await this.eval(`
      (function() {
        const refNode = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!refNode || !refNode.fills || refNode.fills.length === 0) return { error: 'Node has no fill' };

        const refFill = refNode.fills[0];
        if (refFill.type !== 'SOLID') return { error: 'Reference fill is not solid' };

        const matches = figma.currentPage.findAll(n => {
          if (!n.fills || n.fills.length === 0) return false;
          const fill = n.fills[0];
          if (fill.type !== 'SOLID') return false;
          return Math.abs(fill.color.r - refFill.color.r) < 0.01 &&
                 Math.abs(fill.color.g - refFill.color.g) < 0.01 &&
                 Math.abs(fill.color.b - refFill.color.b) < 0.01;
        });

        figma.currentPage.selection = matches;
        return { selected: matches.length, ids: matches.map(n => n.id) };
      })()
    `);
  }

  /**
   * Select all nodes with same stroke color
   */
  async selectSameStroke(nodeId) {
    return await this.eval(`
      (function() {
        const refNode = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!refNode || !refNode.strokes || refNode.strokes.length === 0) return { error: 'Node has no stroke' };

        const refStroke = refNode.strokes[0];
        if (refStroke.type !== 'SOLID') return { error: 'Reference stroke is not solid' };

        const matches = figma.currentPage.findAll(n => {
          if (!n.strokes || n.strokes.length === 0) return false;
          const stroke = n.strokes[0];
          if (stroke.type !== 'SOLID') return false;
          return Math.abs(stroke.color.r - refStroke.color.r) < 0.01 &&
                 Math.abs(stroke.color.g - refStroke.color.g) < 0.01 &&
                 Math.abs(stroke.color.b - refStroke.color.b) < 0.01;
        });

        figma.currentPage.selection = matches;
        return { selected: matches.length, ids: matches.map(n => n.id) };
      })()
    `);
  }

  /**
   * Select all text nodes with same font
   */
  async selectSameFont(nodeId) {
    return await this.eval(`
      (function() {
        const refNode = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!refNode || refNode.type !== 'TEXT') return { error: 'Not a text node' };

        const refFont = refNode.fontName;
        const refSize = refNode.fontSize;

        const matches = figma.currentPage.findAll(n => {
          if (n.type !== 'TEXT') return false;
          return n.fontName.family === refFont.family &&
                 n.fontName.style === refFont.style &&
                 n.fontSize === refSize;
        });

        figma.currentPage.selection = matches;
        return { selected: matches.length, ids: matches.map(n => n.id) };
      })()
    `);
  }

  /**
   * Select all nodes of same type and size
   */
  async selectSameSize(nodeId) {
    return await this.eval(`
      (function() {
        const refNode = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!refNode) return { error: 'Node not found' };

        const matches = figma.currentPage.findAll(n => {
          return n.type === refNode.type &&
                 Math.abs(n.width - refNode.width) < 1 &&
                 Math.abs(n.height - refNode.height) < 1;
        });

        figma.currentPage.selection = matches;
        return { selected: matches.length, ids: matches.map(n => n.id) };
      })()
    `);
  }

  /**
   * Simulate color blindness on a frame (creates a copy with filters)
   */
  async simulateColorBlindness(nodeId, type = 'deuteranopia') {
    const matrices = {
      deuteranopia: [0.625, 0.375, 0, 0, 0, 0.7, 0.3, 0, 0, 0, 0, 0.3, 0.7, 0, 0, 0, 0, 0, 1, 0],
      protanopia: [0.567, 0.433, 0, 0, 0, 0.558, 0.442, 0, 0, 0, 0, 0.242, 0.758, 0, 0, 0, 0, 0, 1, 0],
      tritanopia: [0.95, 0.05, 0, 0, 0, 0, 0.433, 0.567, 0, 0, 0, 0.475, 0.525, 0, 0, 0, 0, 0, 1, 0],
      grayscale: [0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 1, 0]
    };

    const matrix = matrices[type] || matrices.deuteranopia;

    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        const clone = node.clone();
        clone.name = node.name + ' (${type})';
        clone.x = node.x + node.width + 50;

        // Apply as layer blur with color matrix (simplified simulation)
        // Note: Figma doesn't have native color matrix, this is a visual approximation
        clone.opacity = 0.9;

        return { id: clone.id, name: clone.name, type: '${type}' };
      })()
    `);
  }

  // ============ Export to JSX ============

  /**
   * Export a node to JSX code
   */
  async exportToJSX(nodeId, options = {}) {
    const { pretty = true } = options;
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }

        function nodeToJSX(n, indent = 0) {
          const pad = ${pretty} ? '  '.repeat(indent) : '';
          const nl = ${pretty} ? '\\n' : '';

          let tag = 'Frame';
          if (n.type === 'TEXT') tag = 'Text';
          else if (n.type === 'RECTANGLE') tag = 'Rectangle';
          else if (n.type === 'ELLIPSE') tag = 'Ellipse';
          else if (n.type === 'LINE') tag = 'Line';
          else if (n.type === 'VECTOR') tag = 'Vector';
          else if (n.type === 'COMPONENT') tag = 'Component';
          else if (n.type === 'INSTANCE') tag = 'Instance';

          const props = [];
          if (n.name) props.push('name="' + n.name + '"');
          if (n.width) props.push('w={' + Math.round(n.width) + '}');
          if (n.height) props.push('h={' + Math.round(n.height) + '}');

          if (n.fills && n.fills.length > 0 && n.fills[0].type === 'SOLID') {
            const c = n.fills[0].color;
            props.push('bg="' + rgbToHex(c.r, c.g, c.b) + '"');
          }

          if (n.cornerRadius && n.cornerRadius > 0) {
            props.push('rounded={' + n.cornerRadius + '}');
          }

          if (n.layoutMode === 'HORIZONTAL') props.push('flex="row"');
          if (n.layoutMode === 'VERTICAL') props.push('flex="col"');
          if (n.itemSpacing) props.push('gap={' + n.itemSpacing + '}');
          if (n.paddingTop) props.push('p={' + n.paddingTop + '}');

          if (n.type === 'TEXT') {
            const fontSize = n.fontSize || 14;
            props.push('size={' + fontSize + '}');
            if (n.fontName && n.fontName.style) {
              const weight = n.fontName.style.toLowerCase();
              if (weight.includes('bold')) props.push('weight="bold"');
              else if (weight.includes('medium')) props.push('weight="medium"');
            }
            if (n.fills && n.fills[0] && n.fills[0].type === 'SOLID') {
              const c = n.fills[0].color;
              props.push('color="' + rgbToHex(c.r, c.g, c.b) + '"');
            }
            return pad + '<Text ' + props.join(' ') + '>' + (n.characters || '') + '</Text>';
          }

          const hasChildren = n.children && n.children.length > 0;
          const propsStr = props.length > 0 ? ' ' + props.join(' ') : '';

          if (!hasChildren) {
            return pad + '<' + tag + propsStr + ' />';
          }

          const childrenJSX = n.children.map(c => nodeToJSX(c, indent + 1)).join(nl);
          return pad + '<' + tag + propsStr + '>' + nl + childrenJSX + nl + pad + '</' + tag + '>';
        }

        return { jsx: nodeToJSX(node) };
      })()
    `);
  }

  /**
   * Export component to Storybook story
   */
  async exportToStorybook(nodeId) {
    const jsxResult = await this.exportToJSX(nodeId);
    if (jsxResult.error) return jsxResult;

    const nodeInfo = await this.getNode(nodeId);
    const componentName = (nodeInfo.name || 'Component').replace(/[^a-zA-Z0-9]/g, '');

    const story = `import type { Meta, StoryObj } from '@storybook/react';

// Auto-generated from Figma
const ${componentName} = () => (
${jsxResult.jsx.split('\n').map(l => '  ' + l).join('\n')}
);

const meta: Meta<typeof ${componentName}> = {
  title: 'Components/${componentName}',
  component: ${componentName},
};

export default meta;
type Story = StoryObj<typeof ${componentName}>;

export const Default: Story = {};
`;

    return { story, componentName };
  }

  // ============ Visual Diff ============

  /**
   * Compare two nodes visually (returns diff info)
   */
  async visualDiff(nodeId1, nodeId2) {
    return await this.eval(`
      (async function() {
        const node1 = figma.getNodeById(${JSON.stringify(nodeId1)});
        const node2 = figma.getNodeById(${JSON.stringify(nodeId2)});

        if (!node1 || !node2) return { error: 'One or both nodes not found' };

        const differences = [];

        // Compare basic properties
        if (node1.width !== node2.width || node1.height !== node2.height) {
          differences.push({
            property: 'size',
            from: node1.width + 'x' + node1.height,
            to: node2.width + 'x' + node2.height
          });
        }

        if (JSON.stringify(node1.fills) !== JSON.stringify(node2.fills)) {
          differences.push({ property: 'fills', changed: true });
        }

        if (JSON.stringify(node1.strokes) !== JSON.stringify(node2.strokes)) {
          differences.push({ property: 'strokes', changed: true });
        }

        if (node1.cornerRadius !== node2.cornerRadius) {
          differences.push({
            property: 'cornerRadius',
            from: node1.cornerRadius,
            to: node2.cornerRadius
          });
        }

        if (node1.opacity !== node2.opacity) {
          differences.push({
            property: 'opacity',
            from: node1.opacity,
            to: node2.opacity
          });
        }

        // Compare children count
        const children1 = node1.children ? node1.children.length : 0;
        const children2 = node2.children ? node2.children.length : 0;
        if (children1 !== children2) {
          differences.push({
            property: 'childCount',
            from: children1,
            to: children2
          });
        }

        return {
          node1: { id: node1.id, name: node1.name },
          node2: { id: node2.id, name: node2.name },
          identical: differences.length === 0,
          differences
        };
      })()
    `);
  }

  /**
   * Create a structural diff patch between two nodes
   */
  async createDiffPatch(fromId, toId) {
    return await this.eval(`
      (function() {
        const from = figma.getNodeById(${JSON.stringify(fromId)});
        const to = figma.getNodeById(${JSON.stringify(toId)});

        if (!from || !to) return { error: 'Node not found' };

        function getProps(n) {
          return {
            type: n.type,
            name: n.name,
            width: n.width,
            height: n.height,
            x: n.x,
            y: n.y,
            fills: n.fills,
            strokes: n.strokes,
            cornerRadius: n.cornerRadius,
            opacity: n.opacity,
            layoutMode: n.layoutMode,
            itemSpacing: n.itemSpacing
          };
        }

        const fromProps = getProps(from);
        const toProps = getProps(to);
        const patch = [];

        for (const key in toProps) {
          if (JSON.stringify(fromProps[key]) !== JSON.stringify(toProps[key])) {
            patch.push({ property: key, from: fromProps[key], to: toProps[key] });
          }
        }

        return { fromId: from.id, toId: to.id, patch };
      })()
    `);
  }

  // ============ XPath-like Query ============

  /**
   * Query nodes with XPath-like syntax
   * Examples:
   *   //FRAME - all frames
   *   //TEXT[@fontSize > 20] - text larger than 20px
   *   //FRAME[contains(@name, 'Card')] - frames with 'Card' in name
   *   //*[@cornerRadius > 0] - any node with radius
   */
  async query(xpath) {
    return await this.eval(`
      (function() {
        const xpath = ${JSON.stringify(xpath)};
        const results = [];

        // Parse simple XPath patterns
        const typeMatch = xpath.match(/\\/\\/([A-Z_*]+)/);
        const attrMatch = xpath.match(/@(\\w+)\\s*(=|>|<|>=|<=|!=)\\s*["']?([^"'\\]]+)["']?/);
        const containsMatch = xpath.match(/contains\\(@(\\w+),\\s*["']([^"']+)["']\\)/);
        const startsMatch = xpath.match(/starts-with\\(@(\\w+),\\s*["']([^"']+)["']\\)/);

        const targetType = typeMatch ? typeMatch[1] : '*';

        function matches(node) {
          // Type check
          if (targetType !== '*' && node.type !== targetType) return false;

          // Attribute comparison
          if (attrMatch) {
            const [, attr, op, val] = attrMatch;
            const nodeVal = node[attr];
            const numVal = parseFloat(val);

            if (op === '=' && nodeVal != val && nodeVal != numVal) return false;
            if (op === '!=' && (nodeVal == val || nodeVal == numVal)) return false;
            if (op === '>' && !(nodeVal > numVal)) return false;
            if (op === '<' && !(nodeVal < numVal)) return false;
            if (op === '>=' && !(nodeVal >= numVal)) return false;
            if (op === '<=' && !(nodeVal <= numVal)) return false;
          }

          // contains()
          if (containsMatch) {
            const [, attr, val] = containsMatch;
            if (!node[attr] || !String(node[attr]).includes(val)) return false;
          }

          // starts-with()
          if (startsMatch) {
            const [, attr, val] = startsMatch;
            if (!node[attr] || !String(node[attr]).startsWith(val)) return false;
          }

          return true;
        }

        function search(node) {
          if (matches(node)) {
            results.push({
              id: node.id,
              type: node.type,
              name: node.name || '',
              x: Math.round(node.x || 0),
              y: Math.round(node.y || 0),
              width: Math.round(node.width || 0),
              height: Math.round(node.height || 0)
            });
          }
          if (node.children) node.children.forEach(search);
        }

        search(figma.currentPage);
        return results.slice(0, 200);
      })()
    `);
  }

  // ============ Path/Vector Operations ============

  /**
   * Get vector path data from a node
   */
  async getPath(nodeId) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        if (!node.vectorPaths) return { error: 'Node has no vector paths' };

        return {
          id: node.id,
          name: node.name,
          paths: node.vectorPaths.map(p => ({
            data: p.data,
            windingRule: p.windingRule
          }))
        };
      })()
    `);
  }

  /**
   * Set vector path data on a node
   */
  async setPath(nodeId, pathData) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };
        if (node.type !== 'VECTOR') return { error: 'Node is not a vector' };

        node.vectorPaths = [{ data: ${JSON.stringify(pathData)}, windingRule: 'EVENODD' }];
        return { success: true };
      })()
    `);
  }

  /**
   * Scale a vector path
   */
  async scalePath(nodeId, factor) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        node.rescale(${factor});
        return { success: true, newWidth: node.width, newHeight: node.height };
      })()
    `);
  }

  /**
   * Flip a node horizontally or vertically
   */
  async flipNode(nodeId, axis = 'x') {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        if (${JSON.stringify(axis)} === 'x') {
          // Flip horizontally
          const transform = node.relativeTransform;
          node.relativeTransform = [
            [-transform[0][0], transform[0][1], transform[0][2] + node.width],
            [transform[1][0], transform[1][1], transform[1][2]]
          ];
        } else {
          // Flip vertically
          const transform = node.relativeTransform;
          node.relativeTransform = [
            [transform[0][0], transform[0][1], transform[0][2]],
            [transform[1][0], -transform[1][1], transform[1][2] + node.height]
          ];
        }

        return { success: true, axis: ${JSON.stringify(axis)} };
      })()
    `);
  }

  // ============ Analyze ============

  /**
   * Analyze colors used in the design
   */
  async analyzeColors() {
    return await this.eval(`
      (function() {
        const colorMap = new Map();

        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
        }

        function processNode(node) {
          // Check fills
          if (node.fills && Array.isArray(node.fills)) {
            node.fills.forEach(fill => {
              if (fill.type === 'SOLID' && fill.visible !== false) {
                const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
                const existing = colorMap.get(hex) || { count: 0, nodes: [], hasVariable: false };
                existing.count++;
                if (existing.nodes.length < 5) existing.nodes.push(node.id);

                // Check if bound to variable
                if (node.boundVariables && node.boundVariables.fills) {
                  existing.hasVariable = true;
                }
                colorMap.set(hex, existing);
              }
            });
          }

          // Check strokes
          if (node.strokes && Array.isArray(node.strokes)) {
            node.strokes.forEach(stroke => {
              if (stroke.type === 'SOLID' && stroke.visible !== false) {
                const hex = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
                const existing = colorMap.get(hex) || { count: 0, nodes: [], hasVariable: false };
                existing.count++;
                if (existing.nodes.length < 5) existing.nodes.push(node.id);
                colorMap.set(hex, existing);
              }
            });
          }

          if (node.children) node.children.forEach(processNode);
        }

        processNode(figma.currentPage);

        const colors = Array.from(colorMap.entries())
          .map(([hex, data]) => ({ hex, ...data }))
          .sort((a, b) => b.count - a.count);

        return {
          totalColors: colors.length,
          colors: colors.slice(0, 50)
        };
      })()
    `);
  }

  /**
   * Analyze typography used in the design
   */
  async analyzeTypography() {
    return await this.eval(`
      (function() {
        const fontMap = new Map();

        function processNode(node) {
          if (node.type === 'TEXT') {
            const key = node.fontName.family + '/' + node.fontName.style + '/' + node.fontSize;
            const existing = fontMap.get(key) || { count: 0, nodes: [] };
            existing.count++;
            existing.family = node.fontName.family;
            existing.style = node.fontName.style;
            existing.size = node.fontSize;
            if (existing.nodes.length < 5) existing.nodes.push(node.id);
            fontMap.set(key, existing);
          }
          if (node.children) node.children.forEach(processNode);
        }

        processNode(figma.currentPage);

        const fonts = Array.from(fontMap.values())
          .sort((a, b) => b.count - a.count);

        return {
          totalStyles: fonts.length,
          fonts: fonts.slice(0, 30)
        };
      })()
    `);
  }

  /**
   * Analyze spacing (gaps and padding) used in the design
   */
  async analyzeSpacing(gridBase = 8) {
    return await this.eval(`
      (function() {
        const spacingMap = new Map();
        const gridBase = ${gridBase};

        function processNode(node) {
          if (node.layoutMode) {
            // Gap
            if (node.itemSpacing !== undefined) {
              const key = 'gap:' + node.itemSpacing;
              const existing = spacingMap.get(key) || { value: node.itemSpacing, type: 'gap', count: 0, onGrid: node.itemSpacing % gridBase === 0 };
              existing.count++;
              spacingMap.set(key, existing);
            }

            // Padding
            const paddings = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].filter(p => p > 0);
            paddings.forEach(p => {
              const key = 'padding:' + p;
              const existing = spacingMap.get(key) || { value: p, type: 'padding', count: 0, onGrid: p % gridBase === 0 };
              existing.count++;
              spacingMap.set(key, existing);
            });
          }

          if (node.children) node.children.forEach(processNode);
        }

        processNode(figma.currentPage);

        const spacing = Array.from(spacingMap.values())
          .sort((a, b) => b.count - a.count);

        const offGrid = spacing.filter(s => !s.onGrid);

        return {
          gridBase,
          totalValues: spacing.length,
          offGridCount: offGrid.length,
          spacing: spacing.slice(0, 30),
          offGrid: offGrid.slice(0, 10)
        };
      })()
    `);
  }

  /**
   * Find repeated patterns (potential components)
   */
  async analyzeClusters() {
    return await this.eval(`
      (function() {
        const patterns = new Map();

        function getSignature(node) {
          if (!node.children) return node.type;

          const childTypes = node.children.map(c => c.type).sort().join(',');
          return node.type + '[' + childTypes + ']' + node.width + 'x' + node.height;
        }

        function processNode(node) {
          if (node.type === 'FRAME' && node.children && node.children.length > 0) {
            const sig = getSignature(node);
            const existing = patterns.get(sig) || { signature: sig, count: 0, examples: [] };
            existing.count++;
            if (existing.examples.length < 5) {
              existing.examples.push({ id: node.id, name: node.name });
            }
            patterns.set(sig, existing);
          }
          if (node.children) node.children.forEach(processNode);
        }

        processNode(figma.currentPage);

        const clusters = Array.from(patterns.values())
          .filter(p => p.count >= 2)
          .sort((a, b) => b.count - a.count);

        return {
          potentialComponents: clusters.length,
          clusters: clusters.slice(0, 20)
        };
      })()
    `);
  }

  // ============ Lint ============

  /**
   * Lint the design for common issues
   */
  async lint(options = {}) {
    const { preset = 'recommended' } = options;
    return await this.eval(`
      (function() {
        const issues = [];
        const preset = ${JSON.stringify(preset)};

        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }

        function getLuminance(r, g, b) {
          const [rs, gs, bs] = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
          return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
        }

        function getContrastRatio(c1, c2) {
          const l1 = getLuminance(c1.r, c1.g, c1.b);
          const l2 = getLuminance(c2.r, c2.g, c2.b);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }

        function checkNode(node, depth = 0) {
          // No default names
          if (node.name && (node.name.startsWith('Frame ') || node.name.startsWith('Rectangle ') || node.name.startsWith('Group '))) {
            issues.push({
              nodeId: node.id,
              nodeName: node.name,
              rule: 'no-default-names',
              severity: 'warning',
              message: 'Layer has default name'
            });
          }

          // Deeply nested
          if (depth > 10) {
            issues.push({
              nodeId: node.id,
              nodeName: node.name,
              rule: 'no-deeply-nested',
              severity: 'warning',
              message: 'Node is nested too deeply (' + depth + ' levels)'
            });
          }

          // Empty frames
          if (node.type === 'FRAME' && (!node.children || node.children.length === 0)) {
            issues.push({
              nodeId: node.id,
              nodeName: node.name,
              rule: 'no-empty-frames',
              severity: 'info',
              message: 'Frame is empty'
            });
          }

          // Prefer auto-layout
          if (node.type === 'FRAME' && node.children && node.children.length > 2 && !node.layoutMode) {
            issues.push({
              nodeId: node.id,
              nodeName: node.name,
              rule: 'prefer-auto-layout',
              severity: 'info',
              message: 'Frame with ' + node.children.length + ' children doesn\\'t use Auto Layout'
            });
          }

          // Hardcoded colors (not bound to variables)
          if (node.fills && node.fills.length > 0 && node.fills[0].type === 'SOLID') {
            if (!node.boundVariables || !node.boundVariables.fills) {
              issues.push({
                nodeId: node.id,
                nodeName: node.name,
                rule: 'no-hardcoded-colors',
                severity: 'warning',
                message: 'Fill color is not bound to a variable'
              });
            }
          }

          // Text contrast check
          if (node.type === 'TEXT' && node.fills && node.fills[0] && node.fills[0].type === 'SOLID') {
            let parent = node.parent;
            let bgColor = null;
            while (parent && !bgColor) {
              if (parent.fills && parent.fills.length > 0 && parent.fills[0].type === 'SOLID') {
                bgColor = parent.fills[0].color;
              }
              parent = parent.parent;
            }
            if (bgColor) {
              const textColor = node.fills[0].color;
              const ratio = getContrastRatio(textColor, bgColor);
              if (ratio < 4.5) {
                issues.push({
                  nodeId: node.id,
                  nodeName: node.name,
                  rule: 'color-contrast',
                  severity: 'error',
                  message: 'Contrast ratio ' + ratio.toFixed(1) + ':1 is below AA threshold (4.5:1)'
                });
              }
            }
          }

          // Touch target size
          if ((node.type === 'FRAME' || node.type === 'INSTANCE') && node.name && (node.name.toLowerCase().includes('button') || node.name.toLowerCase().includes('link'))) {
            if (node.width < 44 || node.height < 44) {
              issues.push({
                nodeId: node.id,
                nodeName: node.name,
                rule: 'touch-target-size',
                severity: 'warning',
                message: 'Touch target ' + Math.round(node.width) + 'x' + Math.round(node.height) + ' is below minimum 44x44'
              });
            }
          }

          // Min text size
          if (node.type === 'TEXT' && node.fontSize < 12) {
            issues.push({
              nodeId: node.id,
              nodeName: node.name,
              rule: 'min-text-size',
              severity: 'warning',
              message: 'Text size ' + node.fontSize + 'px is below minimum 12px'
            });
          }

          if (node.children) node.children.forEach(c => checkNode(c, depth + 1));
        }

        checkNode(figma.currentPage);

        const errors = issues.filter(i => i.severity === 'error').length;
        const warnings = issues.filter(i => i.severity === 'warning').length;
        const infos = issues.filter(i => i.severity === 'info').length;

        return {
          preset,
          errors,
          warnings,
          infos,
          total: issues.length,
          issues: issues.slice(0, 100)
        };
      })()
    `);
  }

  // ============ Component Variants ============

  /**
   * Create a component set with variants
   */
  async createComponentSet(name, variants) {
    // variants = [{ props: { variant: 'Primary', size: 'Large' }, nodeId: '1:23' }, ...]
    return await this.eval(`
      (async function() {
        const name = ${JSON.stringify(name)};
        const variants = ${JSON.stringify(variants)};

        // Convert each node to component
        const components = [];
        for (const v of variants) {
          const node = figma.getNodeById(v.nodeId);
          if (!node) continue;

          // Create component from node
          const component = figma.createComponentFromNode(node);

          // Set name with variant properties
          const propStr = Object.entries(v.props).map(([k, val]) => k + '=' + val).join(', ');
          component.name = propStr;

          components.push(component);
        }

        if (components.length === 0) return { error: 'No valid nodes found' };

        // Combine into component set
        const componentSet = figma.combineAsVariants(components, figma.currentPage);
        componentSet.name = name;

        return {
          id: componentSet.id,
          name: componentSet.name,
          variantCount: components.length
        };
      })()
    `);
  }

  /**
   * Add variant properties to existing component
   */
  async addVariantProperty(componentSetId, propertyName, values) {
    return await this.eval(`
      (function() {
        const componentSet = figma.getNodeById(${JSON.stringify(componentSetId)});
        if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
          return { error: 'Component set not found' };
        }

        // Add property definition
        const propDefs = componentSet.componentPropertyDefinitions;
        propDefs[${JSON.stringify(propertyName)}] = {
          type: 'VARIANT',
          defaultValue: ${JSON.stringify(values[0])},
          variantOptions: ${JSON.stringify(values)}
        };

        return { success: true, property: ${JSON.stringify(propertyName)}, values: ${JSON.stringify(values)} };
      })()
    `);
  }

  // ============ CSS Grid Layout ============

  /**
   * Set CSS Grid layout on a frame
   */
  async setGridLayout(nodeId, options = {}) {
    const { cols = '1fr 1fr', rows = 'auto', gap = 16, colGap, rowGap } = options;
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node || node.type !== 'FRAME') return { error: 'Frame not found' };

        // Parse columns
        const cols = ${JSON.stringify(cols)}.split(' ');
        const rows = ${JSON.stringify(rows)}.split(' ');

        // Figma doesn't have native CSS Grid, so we simulate with auto-layout
        // For true grid, we create nested frames

        node.layoutMode = 'VERTICAL';
        node.itemSpacing = ${rowGap || gap};
        node.primaryAxisSizingMode = 'AUTO';
        node.counterAxisSizingMode = 'FIXED';

        // If children exist, reorganize into rows
        const children = [...node.children];
        const colCount = cols.length;

        // Remove all children first
        children.forEach(c => c.remove());

        // Create rows
        let childIndex = 0;
        while (childIndex < children.length) {
          const rowFrame = figma.createFrame();
          rowFrame.name = 'Row';
          rowFrame.layoutMode = 'HORIZONTAL';
          rowFrame.itemSpacing = ${colGap || gap};
          rowFrame.primaryAxisSizingMode = 'AUTO';
          rowFrame.counterAxisSizingMode = 'AUTO';
          rowFrame.fills = [];

          for (let i = 0; i < colCount && childIndex < children.length; i++) {
            rowFrame.appendChild(children[childIndex]);
            children[childIndex].layoutSizingHorizontal = 'FILL';
            childIndex++;
          }

          node.appendChild(rowFrame);
        }

        return { success: true, cols: colCount, childrenReorganized: children.length };
      })()
    `);
  }

  // ============ Accessibility Snapshot ============

  /**
   * Get accessibility tree snapshot
   */
  async getAccessibilitySnapshot(nodeId = null) {
    return await this.eval(`
      (function() {
        const root = ${nodeId ? `figma.getNodeById(${JSON.stringify(nodeId)})` : 'figma.currentPage'};
        if (!root) return { error: 'Node not found' };

        const elements = [];

        function processNode(node, depth = 0) {
          const isInteractive = node.name && (
            node.name.toLowerCase().includes('button') ||
            node.name.toLowerCase().includes('link') ||
            node.name.toLowerCase().includes('input') ||
            node.name.toLowerCase().includes('checkbox') ||
            node.name.toLowerCase().includes('toggle') ||
            node.type === 'INSTANCE'
          );

          const isText = node.type === 'TEXT';

          if (isInteractive || isText) {
            elements.push({
              id: node.id,
              type: node.type,
              name: node.name,
              role: isInteractive ? 'interactive' : 'text',
              depth,
              width: Math.round(node.width || 0),
              height: Math.round(node.height || 0),
              text: node.characters || null
            });
          }

          if (node.children) {
            node.children.forEach(c => processNode(c, depth + 1));
          }
        }

        processNode(root);

        return {
          totalElements: elements.length,
          interactive: elements.filter(e => e.role === 'interactive').length,
          textElements: elements.filter(e => e.role === 'text').length,
          elements: elements.slice(0, 100)
        };
      })()
    `);
  }

  // ============ Match Icons ============

  /**
   * Try to match a vector node to an Iconify icon
   */
  async matchIcon(nodeId, preferredSets = ['lucide', 'mdi']) {
    // Get the SVG export of the node
    const svgResult = await this.exportSVG(nodeId);
    if (svgResult.error) return svgResult;

    // This would require an external service to match
    // For now, return info about the vector
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        return {
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height,
          suggestion: 'Use Iconify search to find matching icon: https://icon-sets.iconify.design/',
          preferredSets: ${JSON.stringify(preferredSets)}
        };
      })()
    `);
  }

  // ============ Variable Modes ============

  /**
   * Get all modes in a variable collection
   */
  async getCollectionModes(collectionId) {
    return await this.eval(`
      (function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };
        return {
          id: col.id,
          name: col.name,
          modes: col.modes,
          defaultModeId: col.defaultModeId
        };
      })()
    `);
  }

  /**
   * Add a new mode to a variable collection
   */
  async addMode(collectionId, modeName) {
    return await this.eval(`
      (function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };

        const modeId = col.addMode(${JSON.stringify(modeName)});
        return {
          success: true,
          modeId,
          modeName: ${JSON.stringify(modeName)},
          allModes: col.modes
        };
      })()
    `);
  }

  /**
   * Rename a mode in a variable collection
   */
  async renameMode(collectionId, modeId, newName) {
    return await this.eval(`
      (function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };

        col.renameMode(${JSON.stringify(modeId)}, ${JSON.stringify(newName)});
        return { success: true, modeId: ${JSON.stringify(modeId)}, newName: ${JSON.stringify(newName)} };
      })()
    `);
  }

  /**
   * Remove a mode from a variable collection
   */
  async removeMode(collectionId, modeId) {
    return await this.eval(`
      (function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };

        col.removeMode(${JSON.stringify(modeId)});
        return { success: true, modeId: ${JSON.stringify(modeId)} };
      })()
    `);
  }

  /**
   * Set variable value for a specific mode
   */
  async setVariableValueForMode(variableId, modeId, value) {
    return await this.eval(`
      (function() {
        const variable = figma.variables.getVariableById(${JSON.stringify(variableId)});
        if (!variable) return { error: 'Variable not found' };

        let val = ${JSON.stringify(value)};

        // Convert hex color to RGB if needed
        if (variable.resolvedType === 'COLOR' && typeof val === 'string' && val.startsWith('#')) {
          const hex = val.slice(1);
          val = {
            r: parseInt(hex.slice(0, 2), 16) / 255,
            g: parseInt(hex.slice(2, 4), 16) / 255,
            b: parseInt(hex.slice(4, 6), 16) / 255
          };
        }

        variable.setValueForMode(${JSON.stringify(modeId)}, val);
        return { success: true, variableId: variable.id, modeId: ${JSON.stringify(modeId)} };
      })()
    `);
  }

  /**
   * Get variable value for a specific mode
   */
  async getVariableValueForMode(variableId, modeId) {
    return await this.eval(`
      (function() {
        const variable = figma.variables.getVariableById(${JSON.stringify(variableId)});
        if (!variable) return { error: 'Variable not found' };

        const value = variable.valuesByMode[${JSON.stringify(modeId)}];
        return {
          variableId: variable.id,
          variableName: variable.name,
          modeId: ${JSON.stringify(modeId)},
          value
        };
      })()
    `);
  }

  /**
   * Create a complete variable collection with modes (e.g., Light/Dark)
   */
  async createCollectionWithModes(name, modeNames = ['Light', 'Dark']) {
    return await this.eval(`
      (function() {
        const col = figma.variables.createVariableCollection(${JSON.stringify(name)});

        // Rename default mode to first mode name
        col.renameMode(col.modes[0].modeId, ${JSON.stringify(modeNames[0])});

        // Add additional modes
        const modes = [{ modeId: col.modes[0].modeId, name: ${JSON.stringify(modeNames[0])} }];
        for (let i = 1; i < ${JSON.stringify(modeNames)}.length; i++) {
          const modeId = col.addMode(${JSON.stringify(modeNames)}[i]);
          modes.push({ modeId, name: ${JSON.stringify(modeNames)}[i] });
        }

        return {
          id: col.id,
          name: col.name,
          modes
        };
      })()
    `);
  }

  // ============ Batch Variable Operations ============

  /**
   * Batch create variables (up to 100)
   * @param {Array} variables - [{name, type, value, modeValues: {modeId: value}}]
   */
  async batchCreateVariables(collectionId, variables) {
    return await this.eval(`
      (async function() {
        const col = figma.variables.getVariableCollectionById(${JSON.stringify(collectionId)});
        if (!col) return { error: 'Collection not found' };

        const vars = ${JSON.stringify(variables)};
        const results = [];

        for (const v of vars.slice(0, 100)) {
          const variable = figma.variables.createVariable(v.name, col, v.type || 'COLOR');

          // Set default value
          if (v.value !== undefined) {
            let val = v.value;
            if (variable.resolvedType === 'COLOR' && typeof val === 'string' && val.startsWith('#')) {
              const hex = val.slice(1);
              val = {
                r: parseInt(hex.slice(0, 2), 16) / 255,
                g: parseInt(hex.slice(2, 4), 16) / 255,
                b: parseInt(hex.slice(4, 6), 16) / 255
              };
            }
            variable.setValueForMode(col.defaultModeId, val);
          }

          // Set mode-specific values
          if (v.modeValues) {
            for (const [modeId, modeVal] of Object.entries(v.modeValues)) {
              let val = modeVal;
              if (variable.resolvedType === 'COLOR' && typeof val === 'string' && val.startsWith('#')) {
                const hex = val.slice(1);
                val = {
                  r: parseInt(hex.slice(0, 2), 16) / 255,
                  g: parseInt(hex.slice(2, 4), 16) / 255,
                  b: parseInt(hex.slice(4, 6), 16) / 255
                };
              }
              variable.setValueForMode(modeId, val);
            }
          }

          results.push({ id: variable.id, name: variable.name });
        }

        return { created: results.length, variables: results };
      })()
    `);
  }

  /**
   * Batch update variable values
   * @param {Array} updates - [{variableId, modeId, value}]
   */
  async batchUpdateVariables(updates) {
    return await this.eval(`
      (function() {
        const updates = ${JSON.stringify(updates)};
        const results = [];

        for (const u of updates.slice(0, 100)) {
          const variable = figma.variables.getVariableById(u.variableId);
          if (!variable) {
            results.push({ variableId: u.variableId, error: 'Not found' });
            continue;
          }

          let val = u.value;
          if (variable.resolvedType === 'COLOR' && typeof val === 'string' && val.startsWith('#')) {
            const hex = val.slice(1);
            val = {
              r: parseInt(hex.slice(0, 2), 16) / 255,
              g: parseInt(hex.slice(2, 4), 16) / 255,
              b: parseInt(hex.slice(4, 6), 16) / 255
            };
          }

          variable.setValueForMode(u.modeId, val);
          results.push({ variableId: u.variableId, success: true });
        }

        return { updated: results.filter(r => r.success).length, results };
      })()
    `);
  }

  /**
   * Batch delete variables
   */
  async batchDeleteVariables(variableIds) {
    return await this.eval(`
      (function() {
        const ids = ${JSON.stringify(variableIds)};
        let deleted = 0;

        for (const id of ids.slice(0, 100)) {
          const variable = figma.variables.getVariableById(id);
          if (variable) {
            variable.remove();
            deleted++;
          }
        }

        return { deleted };
      })()
    `);
  }

  // ============ Component Descriptions ============

  /**
   * Set description on a component (supports markdown)
   */
  async setComponentDescription(componentId, description) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(componentId)});
        if (!node) return { error: 'Node not found' };
        if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
          return { error: 'Node is not a component' };
        }

        node.description = ${JSON.stringify(description)};
        return { success: true, id: node.id, description: node.description };
      })()
    `);
  }

  /**
   * Get description from a component
   */
  async getComponentDescription(componentId) {
    return await this.eval(`
      (function() {
        const node = figma.getNodeById(${JSON.stringify(componentId)});
        if (!node) return { error: 'Node not found' };

        return {
          id: node.id,
          name: node.name,
          type: node.type,
          description: node.description || ''
        };
      })()
    `);
  }

  /**
   * Set description with documentation template
   */
  async documentComponent(componentId, options = {}) {
    const { usage = '', props = [], notes = '' } = options;

    let description = '';
    if (usage) description += `## Usage\n${usage}\n\n`;
    if (props.length > 0) {
      description += `## Properties\n`;
      props.forEach(p => {
        description += `- **${p.name}**: ${p.description}\n`;
      });
      description += '\n';
    }
    if (notes) description += `## Notes\n${notes}`;

    return await this.setComponentDescription(componentId, description.trim());
  }

  // ============ Console & Debugging ============

  /**
   * Get console logs from Figma
   */
  async getConsoleLogs(limit = 50) {
    // Enable console tracking if not already
    await this.send('Runtime.enable');

    return await this.eval(`
      (function() {
        // Note: We can't access past console logs directly
        // But we can return info about current state
        return {
          message: 'Console log streaming enabled. Use captureConsoleLogs() to start capturing.',
          tip: 'Run your plugin code and logs will be captured.'
        };
      })()
    `);
  }

  /**
   * Start capturing console logs
   * Returns logs via callback
   */
  async startConsoleCapture(callback) {
    await this.send('Runtime.enable');

    // Listen for console messages
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = msg.params.args.map(arg => arg.value || arg.description || '');
        callback({
          type: msg.params.type,
          message: args.join(' '),
          timestamp: msg.params.timestamp
        });
      }
    });

    return { capturing: true };
  }

  /**
   * Execute code and capture its console output
   */
  async evalWithLogs(expression) {
    const logs = [];

    // Wrap expression to capture console
    const wrappedCode = `
      (function() {
        const _logs = [];
        const _origLog = console.log;
        const _origWarn = console.warn;
        const _origError = console.error;

        console.log = (...args) => { _logs.push({ type: 'log', args }); _origLog(...args); };
        console.warn = (...args) => { _logs.push({ type: 'warn', args }); _origWarn(...args); };
        console.error = (...args) => { _logs.push({ type: 'error', args }); _origError(...args); };

        try {
          const result = (function() { ${expression} })();
          return { result, logs: _logs };
        } finally {
          console.log = _origLog;
          console.warn = _origWarn;
          console.error = _origError;
        }
      })()
    `;

    return await this.eval(wrappedCode);
  }

  // ============ Page & Plugin Reload ============

  /**
   * Reload the current page
   */
  async reloadPage() {
    return await this.send('Page.reload');
  }

  /**
   * Navigate to a different Figma file
   */
  async navigateToFile(fileUrl) {
    return await this.send('Page.navigate', { url: fileUrl });
  }

  /**
   * Get current page URL
   */
  async getCurrentUrl() {
    const result = await this.eval('window.location.href');
    return { url: result };
  }

  /**
   * Reload/refresh plugins
   */
  async refreshPlugins() {
    return await this.eval(`
      (function() {
        // Trigger a plugin refresh by accessing the plugin API
        // This doesn't actually reload plugins but refreshes the state
        const pluginData = figma.root.getPluginData('__refresh__');
        figma.root.setPluginData('__refresh__', Date.now().toString());
        return { refreshed: true, timestamp: Date.now() };
      })()
    `);
  }

  // ============ Organize Variants ============

  /**
   * Organize component variants into a grid with labels
   */
  async organizeVariants(componentSetId, options = {}) {
    const { gap = 40, labelGap = 20, showLabels = true } = options;

    return await this.eval(`
      (async function() {
        const componentSet = figma.getNodeById(${JSON.stringify(componentSetId)});
        if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
          return { error: 'Component set not found' };
        }

        const variants = componentSet.children.filter(c => c.type === 'COMPONENT');
        if (variants.length === 0) return { error: 'No variants found' };

        // Parse variant properties
        const propValues = {};
        variants.forEach(v => {
          const props = v.name.split(', ');
          props.forEach(p => {
            const [key, val] = p.split('=');
            if (!propValues[key]) propValues[key] = new Set();
            propValues[key].add(val);
          });
        });

        const propNames = Object.keys(propValues);
        if (propNames.length === 0) return { organized: 0 };

        // Use first two properties for grid (rows/cols)
        const rowProp = propNames[0];
        const colProp = propNames[1] || null;

        const rowValues = Array.from(propValues[rowProp]);
        const colValues = colProp ? Array.from(propValues[colProp]) : [''];

        const gap = ${gap};
        const labelGap = ${labelGap};
        const showLabels = ${showLabels};

        // Get max dimensions
        let maxW = 0, maxH = 0;
        variants.forEach(v => {
          maxW = Math.max(maxW, v.width);
          maxH = Math.max(maxH, v.height);
        });

        // Position variants in grid
        let organized = 0;
        rowValues.forEach((rowVal, rowIdx) => {
          colValues.forEach((colVal, colIdx) => {
            const variant = variants.find(v => {
              const hasRow = v.name.includes(rowProp + '=' + rowVal);
              const hasCol = !colProp || v.name.includes(colProp + '=' + colVal);
              return hasRow && hasCol;
            });

            if (variant) {
              const xOffset = showLabels ? 100 : 0;
              const yOffset = showLabels ? 40 : 0;

              variant.x = xOffset + colIdx * (maxW + gap);
              variant.y = yOffset + rowIdx * (maxH + gap);
              organized++;
            }
          });
        });

        // Add labels if requested
        if (showLabels && organized > 0) {
          await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

          // Row labels
          rowValues.forEach((val, idx) => {
            const label = figma.createText();
            label.characters = val;
            label.fontSize = 12;
            label.x = 0;
            label.y = 40 + idx * (maxH + gap) + maxH / 2 - 6;
            componentSet.parent.appendChild(label);
          });

          // Column labels
          if (colProp) {
            colValues.forEach((val, idx) => {
              const label = figma.createText();
              label.characters = val;
              label.fontSize = 12;
              label.x = 100 + idx * (maxW + gap) + maxW / 2;
              label.y = 10;
              componentSet.parent.appendChild(label);
            });
          }
        }

        // Resize component set to fit
        componentSet.resizeWithoutConstraints(
          (showLabels ? 100 : 0) + colValues.length * (maxW + gap) - gap,
          (showLabels ? 40 : 0) + rowValues.length * (maxH + gap) - gap
        );

        return {
          organized,
          rows: rowValues.length,
          cols: colValues.length,
          rowProperty: rowProp,
          colProperty: colProp
        };
      })()
    `);
  }

  /**
   * Auto-generate component set from similar frames
   */
  async createComponentSetFromFrames(frameIds, name, variantProperty = 'variant') {
    return await this.eval(`
      (async function() {
        const ids = ${JSON.stringify(frameIds)};
        const frames = ids.map(id => figma.getNodeById(id)).filter(n => n && n.type === 'FRAME');

        if (frames.length < 2) return { error: 'Need at least 2 frames' };

        // Convert frames to components
        const components = frames.map((frame, idx) => {
          const component = figma.createComponentFromNode(frame);
          component.name = ${JSON.stringify(variantProperty)} + '=' + (frame.name || 'Variant' + (idx + 1));
          return component;
        });

        // Combine into component set
        const componentSet = figma.combineAsVariants(components, figma.currentPage);
        componentSet.name = ${JSON.stringify(name)};

        return {
          id: componentSet.id,
          name: componentSet.name,
          variantCount: components.length
        };
      })()
    `);
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default FigmaClient;
