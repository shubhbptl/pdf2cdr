/**
 * ImportCanvas implementation that records drawing calls into a SceneDocument.
 */
import { apply, emptyBBox, extend, intersects, isEmpty, type BBox, type Matrix } from "./geom";
import { clipFill, type ClipRegion } from "./clip";
import { segsBBox, type ImportCanvas, type PdfImage } from "./interpreter";
import type { Color, ImageItem, Paint, PathItem, SceneDocument, SceneLayer, ScenePage } from "./scene";

export class SceneBuilder implements ImportCanvas {
  private page: ScenePage | null = null;
  private layer: SceneLayer | null = null;
  private pageIndex = 0;

  constructor(private doc: SceneDocument, private includeHidden = true) {}
  private sink: SceneLayer = { name: "", visible: false, printable: false, items: [] };

  beginPage(width: number, height: number, index: number) {
    this.pageIndex = index;
    this.page = { width, height, layers: [] };
    this.layer = null;
  }

  endPage(): ScenePage {
    const p = this.page!;
    // Drop empty layers, keep order of first appearance.
    p.layers = p.layers.filter((l) => l.items.length);
    if (!p.layers.length) p.layers.push({ name: "Layer 1", visible: true, printable: true, items: [] });
    this.doc.pages.push(p);
    this.page = null;
    return p;
  }

  setLayer(name: string, visible: boolean): void {
    const page = this.page!;
    if (!visible && !this.includeHidden) { this.layer = this.sink; this.sink.items.length = 0; return; }
    let layer = page.layers.find((l) => l.name === name);
    if (!layer) {
      layer = { name, visible, printable: visible, items: [] };
      page.layers.push(layer);
    }
    this.layer = layer;
  }

  warn(message: string): void {
    this.doc.warnings.push({ page: this.pageIndex + 1, message });
  }

  countClipSimplified(): void {
    this.doc.stats.clipsSimplified++;
  }

  drawPath(p: Parameters<ImportCanvas["drawPath"]>[0]): void {
    let segs = p.segs;
    let evenOdd = p.evenOdd;
    let bbox = segsBBox(segs);
    const clip = p.clip;
    if (clip) {
      if (isEmpty(clip.bbox) || !intersects(bbox, clip.bbox)) return; // fully clipped away
      if (!inside(bbox, clip.bbox)) {
        if (p.fill && !p.stroke) {
          segs = clipFill(segs, evenOdd, clip);
          if (!segs.length) return;
          evenOdd = true;
          bbox = segsBBox(segs);
        } else {
          this.countClipSimplified();
        }
      }
    }
    const item: PathItem = { type: "path", segs, fill: p.fill, evenOdd, stroke: p.stroke, opacity: p.opacity, bbox, origin: p.origin };
    if (p.fill && p.fill.kind !== "solid") this.doc.stats.gradients++;
    if (p.origin === "text") this.doc.stats.glyphs++;
    else this.doc.stats.paths++;
    this.layer!.items.push(item);
  }

  drawImage(p: { image: PdfImage; matrix: Matrix; opacity: number; clip: ClipRegion | null; tint?: Paint }): void {
    const rgba = toRGBA(p.image, p.tint, p.matrix);
    if (!rgba) {
      this.warn(`An image of an unsupported pixel format (kind ${p.image.kind}) was skipped.`);
      return;
    }
    const bbox = emptyBBox();
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const [x, y] = apply(p.matrix, u, v);
      extend(bbox, x, y);
    }
    if (p.clip && (isEmpty(p.clip.bbox) || !intersects(bbox, p.clip.bbox))) return;
    if (p.clip && !inside(bbox, p.clip.bbox)) this.countClipSimplified();
    const item: ImageItem = {
      type: "image",
      width: p.image.width,
      height: p.image.height,
      rgba,
      matrix: p.matrix,
      opacity: p.opacity,
      bbox,
    };
    this.doc.stats.images++;
    this.layer!.items.push(item);
  }
}

function inside(a: BBox, clip: BBox): boolean {
  const eps = 0.5;
  return a.x0 >= clip.x0 - eps && a.y0 >= clip.y0 - eps && a.x1 <= clip.x1 + eps && a.y1 <= clip.y1 + eps;
}

/** Normalises pdf.js image data to RGBA8. kind 0 is a 1bpp stencil mask painted with `tint`. */
function toRGBA(img: PdfImage, tint?: Paint, matrix?: Matrix): Uint8ClampedArray | null {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  switch (img.kind) {
    case 3: // RGBA_32BPP
      out.set(data.subarray(0, w * h * 4));
      return out;
    case 2: // RGB_24BPP
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
      }
      return out;
    case 1: { // GRAYSCALE_1BPP, rows padded to whole bytes, 1 = white
      const rowBytes = (w + 7) >> 3;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const o = (y * w + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
        }
      }
      return out;
    }
    case 0: { // stencil mask from paintImageMaskXObject: 0 bits paint, 1 bits are transparent
      const rowBytes = (w + 7) >> 3;
      const paint: Paint = tint ?? { kind: "solid", color: { space: "rgb", r: 0, g: 0, b: 0 } };
      const solid = paint.kind === "solid" ? colorToRGB255(paint.color) : null;
      const m = matrix ?? [1, 0, 0, 1, 0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const o = (y * w + x) * 4;
          if (bit) { out[o + 3] = 0; continue; }
          // Gradient-filled masks: sample the gradient at the pixel centre (row 0 is the top, v = 1).
          const [r, g, b] = solid ?? sampleGradient(paint as Exclude<Paint, { kind: "solid" }>, apply(m, (x + 0.5) / w, 1 - (y + 0.5) / h));
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
      }
      return out;
    }
    default:
      return null;
  }
}

export function colorToRGB255(c: Color): [number, number, number] {
  if (c.space === "rgb") return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
  const k = c.k;
  return [
    Math.round(255 * (1 - c.c) * (1 - k)),
    Math.round(255 * (1 - c.m) * (1 - k)),
    Math.round(255 * (1 - c.y) * (1 - k)),
  ];
}

function sampleGradient(p: Exclude<Paint, { kind: "solid" }>, [x, y]: [number, number]): [number, number, number] {
  let t: number;
  if (p.kind === "linear") {
    const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
    const len2 = dx * dx + dy * dy || 1;
    t = ((x - p.x0) * dx + (y - p.y0) * dy) / len2;
  } else {
    t = Math.hypot(x - p.cx, y - p.cy) / (p.r || 1);
  }
  t = Math.min(1, Math.max(0, t));
  const stops = p.stops;
  if (t <= stops[0].offset) return colorToRGB255(stops[0].color);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const a = stops[i - 1], b = stops[i];
      const f = (t - a.offset) / (b.offset - a.offset || 1);
      const ca = colorToRGB255(a.color), cb = colorToRGB255(b.color);
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as [number, number, number];
    }
  }
  return colorToRGB255(stops[stops.length - 1].color);
}
