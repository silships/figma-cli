// Gradient extraction from raster images.
//
// Decodes a PNG/JPG, identifies the dominant background gradient (vertical
// or horizontal, 2/3/5 stops), and returns a descriptor that can be turned
// into a Figma GRADIENT_LINEAR paint or a CSS string.
//
// Robust to image borders (auto-trimmed) and content-heavy images. Per
// sample band we cluster pixels in a coarse RGB histogram (16-step bins)
// and take the centroid of the largest bin — that's the background color
// in that band, even if the band also contains text/photos/widgets.

import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { readFileSync } from 'fs';
import { extname } from 'path';

export function loadImage(path) {
  const buf = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const j = jpeg.decode(buf, { useTArray: true });
    return { width: j.width, height: j.height, data: j.data };
  }
  throw new Error(`Unsupported image format "${ext}". Use PNG or JPG.`);
}

function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// Trim outer rows/cols that are uniformly black or fully transparent.
function detectInnerBox(img) {
  const { width: w, height: h } = img;
  const isBorder = (r, g, b, a) => a === 0 || r + g + b < 30;
  const rowAllBorder = (y) => {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelAt(img, x, y);
      if (!isBorder(r, g, b, a)) return false;
    }
    return true;
  };
  const colAllBorder = (x, y0, y1) => {
    for (let y = y0; y <= y1; y++) {
      const [r, g, b, a] = pixelAt(img, x, y);
      if (!isBorder(r, g, b, a)) return false;
    }
    return true;
  };
  let top = 0;
  while (top < h && rowAllBorder(top)) top++;
  let bottom = h - 1;
  while (bottom > top && rowAllBorder(bottom)) bottom--;
  let left = 0;
  while (left < w && colAllBorder(left, top, bottom)) left++;
  let right = w - 1;
  while (right > left && colAllBorder(right, top, bottom)) right--;
  return { left, top, right, bottom };
}

// Dominant color in a rectangle, found by quantizing pixels into 16-step
// RGB bins and taking the centroid of the largest bin.
function dominantColor(img, x0, y0, x1, y1) {
  const bins = new Map();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [r, g, b, a] = pixelAt(img, x, y);
      if (a === 0) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bin = bins.get(key);
      if (!bin) {
        bin = { r: 0, g: 0, b: 0, n: 0 };
        bins.set(key, bin);
      }
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bin.n++;
    }
  }
  let best = null;
  for (const bin of bins.values()) {
    if (!best || bin.n > best.n) best = bin;
  }
  if (!best) return null;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

function rgbDist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Compare color variation along vertical vs horizontal to pick the axis.
function detectDirection(img, box) {
  const sampleAxis = (vertical, n) => {
    const colors = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let c;
      if (vertical) {
        const y = box.top + Math.round((box.bottom - box.top) * t);
        const pad = 2;
        c = dominantColor(img, box.left, Math.max(box.top, y - pad), box.right, Math.min(box.bottom, y + pad));
      } else {
        const x = box.left + Math.round((box.right - box.left) * t);
        const pad = 2;
        c = dominantColor(img, Math.max(box.left, x - pad), box.top, Math.min(box.right, x + pad), box.bottom);
      }
      if (c) colors.push(c);
    }
    if (colors.length < 2) return 0;
    return rgbDist(colors[0], colors[colors.length - 1]);
  };
  const vDelta = sampleAxis(true, 8);
  const hDelta = sampleAxis(false, 8);
  return vDelta >= hDelta
    ? { dir: 'vertical', angle: 180 }
    : { dir: 'horizontal', angle: 90 };
}

function extractStops(img, box, dir, n) {
  const stops = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let c;
    if (dir.dir === 'vertical') {
      const y = box.top + Math.round((box.bottom - box.top) * t);
      const band = Math.max(2, Math.round((box.bottom - box.top) / (n * 6)));
      c = dominantColor(img, box.left, Math.max(box.top, y - band), box.right, Math.min(box.bottom, y + band));
    } else {
      const x = box.left + Math.round((box.right - box.left) * t);
      const band = Math.max(2, Math.round((box.right - box.left) / (n * 6)));
      c = dominantColor(img, Math.max(box.left, x - band), box.top, Math.min(box.right, x + band), box.bottom);
    }
    if (!c) c = [128, 128, 128];
    stops.push({ position: t, rgb: c });
  }
  return stops;
}

export function extractGradient(path, opts = {}) {
  const img = loadImage(path);
  const box = opts.trim === false
    ? { left: 0, top: 0, right: img.width - 1, bottom: img.height - 1 }
    : detectInnerBox(img);
  const dirRaw = opts.direction || 'auto';
  let dir;
  if (dirRaw === 'auto') dir = detectDirection(img, box);
  else if (dirRaw === 'vertical' || dirRaw === '180') dir = { dir: 'vertical', angle: 180 };
  else if (dirRaw === 'horizontal' || dirRaw === '90') dir = { dir: 'horizontal', angle: 90 };
  else throw new Error(`Unknown direction "${dirRaw}". Use auto|vertical|horizontal.`);
  const nStops = opts.stops || 3;
  const stops = extractStops(img, box, dir, nStops);
  return {
    direction: dir.dir,
    angle: dir.angle,
    box,
    imageSize: { width: img.width, height: img.height },
    stops,
  };
}

export function buildFigmaPaint(result) {
  const angle = result.angle;
  const rad = ((angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tx = 0.5 - 0.5 * cos + 0.5 * sin;
  const ty = 0.5 - 0.5 * sin - 0.5 * cos;
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[cos, -sin, tx], [sin, cos, ty]],
    gradientStops: result.stops.map((s) => ({
      position: s.position,
      color: { r: s.rgb[0] / 255, g: s.rgb[1] / 255, b: s.rgb[2] / 255, a: 1 },
    })),
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  };
}

export function buildCssString(result) {
  const stops = result.stops.map((s) => {
    const hex = '#' + s.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${hex} ${Math.round(s.position * 100)}%`;
  });
  return `linear-gradient(${result.angle}deg, ${stops.join(', ')})`;
}

// ─── MESH mode ──────────────────────────────────────────────────────────
//
// Figma has no real mesh-gradient primitive (the Plugin API rejects
// GRADIENT_MESH explicitly). The visual character of mesh gradients
// (smooth 2D color interpolation, no hard iso-lines) is best approximated
// by stacking heavily Layer-Blur'd colored ellipses inside a clipping
// frame — a well-known designer trick.
//
// extractMesh() samples key positions of the source image and returns
// a "recipe" describing the blobs to create. The applier turns that
// recipe into a Figma Frame containing the blur-stacked ellipses.

function dominantColorAt(img, fx, fy, halfBand = 30) {
  const cx = Math.round(fx * img.width);
  const cy = Math.round(fy * img.height);
  const x0 = Math.max(0, cx - halfBand);
  const x1 = Math.min(img.width - 1, cx + halfBand);
  const y0 = Math.max(0, cy - halfBand);
  const y1 = Math.min(img.height - 1, cy + halfBand);
  return dominantColor(img, x0, y0, x1, y1) || [128, 128, 128];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Scan a region and return the brightest cell (by mean R+G+B), to locate
// the "light hotspot" (e.g. white dome at the top of a mesh gradient).
function brightestSpot(img, box, opts = {}) {
  const cells = opts.cells || 16;
  const xMin = opts.xMin ?? 0.0;
  const xMax = opts.xMax ?? 1.0;
  const yMin = opts.yMin ?? 0.0;
  const yMax = opts.yMax ?? 1.0;
  const W = box.right - box.left;
  const H = box.bottom - box.top;
  let best = { v: -1, fx: 0.5, fy: 0.5, color: [255, 255, 255] };
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const fx = xMin + (xMax - xMin) * (i / (cells - 1));
      const fy = yMin + (yMax - yMin) * (j / (cells - 1));
      const x = box.left + Math.round(W * fx);
      const y = box.top + Math.round(H * fy);
      const pad = Math.max(4, Math.round(Math.min(W, H) / 60));
      const c = dominantColor(
        img,
        Math.max(box.left, x - pad), Math.max(box.top, y - pad),
        Math.min(box.right, x + pad), Math.min(box.bottom, y + pad),
      );
      if (!c) continue;
      const v = (c[0] + c[1] + c[2]) / 3;
      if (v > best.v) best = { v, fx, fy, color: c };
    }
  }
  return best;
}

// Scan a region and return the most "warm-saturated" cell — proxy for the
// red/pink hotspot. We score pixels by (R - 0.5 * (G + B)): high red
// dominance with not-too-light pixels wins.
function reddestSpot(img, box, opts = {}) {
  const cells = opts.cells || 16;
  const xMin = opts.xMin ?? 0.2;
  const xMax = opts.xMax ?? 0.8;
  const yMin = opts.yMin ?? 0.5;
  const yMax = opts.yMax ?? 0.95;
  const W = box.right - box.left;
  const H = box.bottom - box.top;
  let best = { score: -1e9, fx: 0.5, fy: 0.85, color: [200, 80, 80] };
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const fx = xMin + (xMax - xMin) * (i / (cells - 1));
      const fy = yMin + (yMax - yMin) * (j / (cells - 1));
      const x = box.left + Math.round(W * fx);
      const y = box.top + Math.round(H * fy);
      const pad = Math.max(4, Math.round(Math.min(W, H) / 60));
      const c = dominantColor(
        img,
        Math.max(box.left, x - pad), Math.max(box.top, y - pad),
        Math.min(box.right, x + pad), Math.min(box.bottom, y + pad),
      );
      if (!c) continue;
      const score = c[0] - 0.5 * (c[1] + c[2]);
      if (score > best.score) best = { score, fx, fy, color: c };
    }
  }
  return best;
}

// Channel-wise average of a list of [r,g,b] tuples — used to derive the
// base solid (warm mid-tone) under the blob stack.
function averageColor(colors) {
  const sum = [0, 0, 0];
  for (const c of colors) {
    sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
  }
  return [
    Math.round(sum[0] / colors.length),
    Math.round(sum[1] / colors.length),
    Math.round(sum[2] / colors.length),
  ];
}

export function extractMesh(path, opts = {}) {
  const img = loadImage(path);
  const box = opts.trim === false
    ? { left: 0, top: 0, right: img.width - 1, bottom: img.height - 1 }
    : detectInnerBox(img);
  const halfBand = Math.max(8, Math.round(Math.min(box.right - box.left, box.bottom - box.top) / 60));
  const sampleUV = (fx, fy) => {
    const x = box.left + Math.round((box.right - box.left) * fx);
    const y = box.top + Math.round((box.bottom - box.top) * fy);
    const c = dominantColor(
      img,
      Math.max(box.left, x - halfBand), Math.max(box.top, y - halfBand),
      Math.min(box.right, x + halfBand), Math.min(box.bottom, y + halfBand),
    );
    return c || [128, 128, 128];
  };

  // 4 corners + 2 mid-sides + 1 mid-center give the "structural" mesh anchors.
  const TL = sampleUV(0.05, 0.05);
  const TR = sampleUV(0.95, 0.05);
  const BL = sampleUV(0.05, 0.95);
  const BR = sampleUV(0.95, 0.95);
  const ML = sampleUV(0.05, 0.50);
  const MR = sampleUV(0.95, 0.50);
  const MC = sampleUV(0.50, 0.50);

  // Hotspots — light dome (typically top-center) and warm focal (often bottom).
  const light = brightestSpot(img, box, { yMax: 0.4 });
  const warm = reddestSpot(img, box);

  // Stack order: side accents go bottom, corner blobs over them, then the
  // warm focal, finally the light dome on top. This is what visually
  // reproduced blossom best in testing.
  const blobs = [
    { fx: -0.05, fy: 0.45, r: 0.50, color: rgbToHex(ML) },
    { fx:  1.05, fy: 0.55, r: 0.48, color: rgbToHex(MR) },
    { fx: -0.02, fy: -0.02, r: 0.40, color: rgbToHex(TL) },
    { fx:  1.02, fy: -0.02, r: 0.40, color: rgbToHex(TR) },
    { fx: -0.02, fy:  1.02, r: 0.42, color: rgbToHex(BL) },
    { fx:  1.02, fy:  1.02, r: 0.42, color: rgbToHex(BR) },
    { fx: warm.fx, fy: warm.fy, r: 0.42, color: rgbToHex(warm.color) },
    { fx: light.fx, fy: light.fy, r: 0.50, color: rgbToHex(light.color) },
  ];

  return {
    mode: 'mesh',
    base: rgbToHex(MC),
    blobs,
    blurFraction: 0.38,   // fraction of min(W, H) — applied at apply time
    imageSize: { width: img.width, height: img.height },
    box,
  };
}

// ─── MESH from a palette (no source image) ──────────────────────────────
//
// Generates a mesh-gradient wallpaper recipe from a list of colors. Blobs
// are distributed around the frame so each color anchors a region; they're
// pushed slightly off-frame so the clip shows only the soft bleed (no hard
// ellipse edges). Same blur-stack the image extractor produces, so the
// applier is shared.

function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function normalizeHex(h) {
  return rgbToHex(hexToRgb(h));
}

const relLum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const darken = (rgb, amt) => rgb.map((c) => clamp255(c * (1 - amt)));
const lighten = (rgb, amt) => rgb.map((c) => clamp255(c + (255 - c) * amt));
const mixRgb = (a, b, t) => a.map((c, i) => clamp255(c + (b[i] - c) * t));
// Push a color away from gray to keep accents vivid after blurring.
const saturate = (rgb, amt) => {
  const g = relLum(rgb);
  return rgb.map((c) => clamp255(c + (c - g) * amt));
};

// Seeded RNG (mulberry32) so a wallpaper is reproducible with --seed but
// varies run-to-run when no seed is given.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MESH_STYLES = ['scatter', 'diagonal', 'bands', 'drift', 'spotlight', 'corners'];

// Generate anchor positions for N colors in a given composition style.
// Positions can sit slightly off-frame; the clip then shows only the soft
// bleed. Each style jitters via rng() so repeated calls look distinct and
// no blob is hard-locked to dead center.
// Positions are pushed past the frame edges and radii are kept large (~0.6
// of the min side) so every blob blankets a big region. This is what made
// the hand-crafted Coral Reef / Deep Sea / Forest Mist wallpapers read as
// smooth full-bleed gradients rather than isolated blobs over a base color.
function meshPositions(n, style, rng) {
  const jit = (base, amt) => base + (rng() - 0.5) * amt;
  const r = (base, amt = 0.1) => Math.max(0.5, jit(base, amt));
  const pts = [];

  if (style === 'diagonal') {
    const flip = rng() > 0.5;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      // Run the band from one off-frame corner to the opposite one.
      const fx = (flip ? 1 - t : t) * 1.2 - 0.1;
      const fy = t * 1.2 - 0.1;
      pts.push({ fx: jit(fx, 0.2), fy: jit(fy, 0.18), r: r(0.66, 0.12) });
    }
  } else if (style === 'bands') {
    const horizontal = rng() > 0.5;
    for (let i = 0; i < n; i++) {
      // Spread the band centers slightly past the edges so the end colors
      // bleed fully off-frame instead of stopping inside it.
      const t = (i + 0.5) / n * 1.2 - 0.1;
      if (horizontal) pts.push({ fx: jit(0.5, 0.5), fy: jit(t, 0.1), r: r(0.66, 0.08) });
      else pts.push({ fx: jit(t, 0.1), fy: jit(0.5, 0.5), r: r(0.66, 0.08) });
    }
  } else if (style === 'drift') {
    const cx = rng() > 0.5 ? -0.1 : 1.1;
    const cy = rng() > 0.5 ? -0.1 : 1.1;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const fx = cx + (1 - 2 * (cx < 0.5 ? 0 : 1)) * t * 1.05;
      const fy = cy + (1 - 2 * (cy < 0.5 ? 0 : 1)) * t * 1.05;
      pts.push({ fx: jit(fx, 0.18), fy: jit(fy, 0.18), r: r(0.7 - t * 0.12, 0.1) });
    }
  } else if (style === 'spotlight') {
    // One big off-center anchor + satellites pushed out past the edges so the
    // frame stays fully covered (no base showing between satellites).
    pts.push({ fx: jit(0.4, 0.24), fy: jit(0.42, 0.24), r: r(0.7, 0.08) });
    const start = rng() * Math.PI * 2;
    for (let i = 1; i < n; i++) {
      const ang = start + (i / Math.max(1, n - 1)) * Math.PI * 2;
      pts.push({ fx: jit(0.5 + Math.cos(ang) * 0.85, 0.12), fy: jit(0.5 + Math.sin(ang) * 0.85, 0.12), r: r(0.6, 0.1) });
    }
  } else if (style === 'corners') {
    const corners = [[-0.1, -0.1], [1.1, -0.1], [-0.1, 1.1], [1.1, 1.1]];
    for (let i = 0; i < n; i++) {
      if (i < 4) pts.push({ fx: jit(corners[i][0], 0.1), fy: jit(corners[i][1], 0.1), r: r(0.68, 0.08) });
      // Extra colors become edge-centered accents, not a dead-center blob.
      else {
        const edge = (i - 4) % 4;
        const ep = [[0.5, -0.1], [1.1, 0.5], [0.5, 1.1], [-0.1, 0.5]][edge];
        pts.push({ fx: jit(ep[0], 0.12), fy: jit(ep[1], 0.12), r: r(0.6, 0.1) });
      }
    }
  } else {
    // scatter: jittered grid, but with big radii so neighbors overlap and
    // the whole frame fills. Outer cells pushed past the edges.
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const gx = (i % cols + 0.5) / cols;
      const gy = (Math.floor(i / cols) + 0.5) / rows;
      // Expand grid 1.2x around center so edge cells sit off-frame.
      const ex = (gx - 0.5) * 1.2 + 0.5;
      const ey = (gy - 0.5) * 1.2 + 0.5;
      pts.push({ fx: jit(ex, 0.3), fy: jit(ey, 0.3), r: r(0.62, 0.12) });
    }
  }
  return pts;
}

export function buildMeshFromColors(colors, opts = {}) {
  const hexes = colors.map(normalizeHex);
  if (hexes.length < 2) throw new Error('Need at least 2 colors for a mesh gradient.');

  const seed = opts.seed != null ? (opts.seed >>> 0) : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const rng = makeRng(seed);
  let style = opts.style;
  if (!style || style === 'auto') style = MESH_STYLES[Math.floor(rng() * MESH_STYLES.length)];
  if (!MESH_STYLES.includes(style)) throw new Error(`Unknown style "${style}". One of: ${MESH_STYLES.join(', ')}, auto.`);

  // Shuffle which color lands where so palette order doesn't dictate look.
  const order = hexes.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const positions = meshPositions(hexes.length, style, rng);
  const round = (v) => Math.round(v * 1000) / 1000;
  const blobs = positions.map((pos, i) => ({
    fx: round(pos.fx),
    fy: round(pos.fy),
    r: round(pos.r),
    color: hexes[order[i % order.length]],
  }));

  // ── Depth + focal glow ──
  // Analogous palettes (all similar lightness) otherwise blend into a flat
  // 2-tone wash. Deriving a darker depth corner and a brighter focal glow
  // from the palette itself adds tonal range and a light source — the thing
  // that made the hand-crafted wallpapers feel alive — without introducing
  // foreign hues.
  const rgbs = hexes.map(hexToRgb);
  const byLum = [...rgbs].sort((a, b) => relLum(a) - relLum(b));
  const darkest = byLum[0];
  const lightest = byLum[byLum.length - 1];
  const accents = opts.accents === false;

  if (!accents) {
    // Depth: a darkened version of the darkest color, big, in a back corner
    // (bottom z-order so the palette blobs sit on top of it).
    const dc = rng() > 0.5 ? -0.12 : 1.12;
    const dy = 1.12; // anchor depth low — reads as grounded shadow
    blobs.unshift({
      fx: round(dc), fy: round(dy), r: 0.7,
      color: rgbToHex(darken(darkest, 0.35)),
    });

    // Glow: a brightened, slightly saturated version of the lightest color,
    // smaller and sharper (less blur) so it reads as a focal light source.
    // Placed in the upper half, off-center.
    const gx = 0.3 + rng() * 0.4;
    const gy = 0.06 + rng() * 0.22;
    blobs.push({
      fx: round(gx), fy: round(gy), r: 0.34,
      color: rgbToHex(saturate(lighten(lightest, 0.4), 0.2)),
      blurMul: 0.62,
    });
  }

  // Base pulled toward the darkest color for depth (unless overridden).
  const base = opts.base
    ? normalizeHex(opts.base)
    : rgbToHex(mixRgb(averageColor(rgbs), darkest, 0.22));

  return {
    mode: 'mesh',
    style,
    seed,
    base,
    blobs,
    blurFraction: opts.blur != null ? opts.blur : 0.42,
  };
}

