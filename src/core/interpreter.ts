/**
 * Page interpreter: plays a pdf.js operator list against an ImportCanvas.
 *
 * A table maps each operator to a handler method, a graphics state stack tracks colour,
 * transform, line style, clip and opacity, and a canvas interface receives drawing calls
 * that are already resolved to page coordinates.
 */
import { IDENTITY, type Matrix, apply, emptyBBox, extend, invert as invertMatrix, meanScale, multiply, type BBox, isEmpty } from "./geom";
import type { Color, Paint, PathSeg, Stroke } from "./scene";
import { intersectClip, polygonSegs, type ClipRegion } from "./clip";

// ---- pdf.js constants (pdfjs-dist v6 `OPS` / `DrawOPS`) ----
export const OPS = {
  dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5, setDash: 6,
  setRenderingIntent: 7, setFlatness: 8, setGState: 9, save: 10, restore: 11, transform: 12,
  moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25,
  closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30,
  beginText: 31, endText: 32, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35,
  setLeading: 36, setFont: 37, setTextRenderingMode: 38, setTextRise: 39, moveText: 40,
  setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43, showText: 44, showSpacedText: 45,
  nextLineShowText: 46, nextLineSetSpacingShowText: 47, setCharWidth: 48, setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52, setStrokeColorN: 53,
  setFillColor: 54, setFillColorN: 55, setStrokeGray: 56, setFillGray: 57, setStrokeRGBColor: 58,
  setFillRGBColor: 59, setStrokeCMYKColor: 60, setFillCMYKColor: 61, shadingFill: 62,
  beginInlineImage: 63, beginImageData: 64, endInlineImage: 65, paintXObject: 66, markPoint: 67,
  markPointProps: 68, beginMarkedContent: 69, beginMarkedContentProps: 70, endMarkedContent: 71,
  beginCompat: 72, endCompat: 73, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  beginGroup: 76, endGroup: 77, beginAnnotation: 80, endAnnotation: 81,
  paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84, paintImageXObject: 85,
  paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90, constructPath: 91,
  setStrokeTransparent: 92, setFillTransparent: 93, rawFillPath: 94,
} as const;

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

// ---- What the interpreter needs from its host ----

export interface GlyphFont {
  name: string;
  /** pdf.js font matrix (text space units per glyph unit). */
  fontMatrix: Matrix;
  vertical: boolean;
  missingFile: boolean;
  isType3: boolean;
  /** Glyph outline as pdf.js DrawOPS, in glyph space scaled by the font matrix; null if none. */
  glyphPath(fontChar: string): ArrayLike<number> | null;
}

export interface PdfImage {
  width: number;
  height: number;
  /** pdf.js ImageKind: 1 = 1bpp gray, 2 = RGB 24bpp, 3 = RGBA 32bpp. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Resources {
  font(id: string): GlyphFont | null;
  image(id: string): PdfImage | null;
  /** 1bpp stencil mask data (pdf.js object id). */
  mask(id: string): Uint8Array | null;
  /** Shading/pattern IR as produced by pdf.js (e.g. ["RadialAxial", "axial", ...]). */
  pattern(id: string): unknown[] | null;
  /** Optional-content group lookup (id -> name/visibility). */
  optionalContent(id: string): { name: string; visible: boolean } | null;
}

/** The receiving side: gets fully resolved paths, images and layer changes. */
export interface ImportCanvas {
  setLayer(name: string, visible: boolean): void;
  drawPath(p: {
    segs: PathSeg[];
    fill: Paint | null;
    evenOdd: boolean;
    stroke: Stroke | null;
    opacity: number;
    clip: ClipRegion | null;
    origin: "text" | "shape" | "shading";
  }): void;
  drawImage(p: { image: PdfImage; matrix: Matrix; opacity: number; clip: ClipRegion | null; tint?: Paint }): void;
  warn(message: string): void;
  countClipSimplified(): void;
}

// ---- Graphics state ----

interface TextState {
  font: GlyphFont | null;
  fontSize: number;
  fontDirection: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  textMatrix: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

interface TilingFill {
  operatorList: { fnArray: number[]; argsArray: any[] };
  matrix: Matrix;
  bbox: [number, number, number, number];
  xstep: number;
  ystep: number;
  paintType: number;
  color: Color | null;
  /** Pattern space → page space, fixed when the pattern was selected. */
  space: Matrix;
}

interface GState {
  ctm: Matrix;
  tiling: TilingFill | null;
  /** Pattern space base: the page's (or enclosing form's) initial CTM. */
  baseCtm: Matrix;
  fill: Paint;
  strokeColor: Color;
  lineWidth: number;
  cap: 0 | 1 | 2;
  join: 0 | 1 | 2;
  miterLimit: number;
  dash: number[];
  fillAlpha: number;
  strokeAlpha: number;
  clip: ClipRegion | null;
  text: TextState;
}

const BLACK: Color = { space: "rgb", r: 0, g: 0, b: 0 };

function freshState(base: Matrix): GState {
  return {
    ctm: base,
    tiling: null,
    baseCtm: base,
    fill: { kind: "solid", color: BLACK },
    strokeColor: BLACK,
    lineWidth: 1,
    cap: 0,
    join: 0,
    miterLimit: 10,
    dash: [],
    fillAlpha: 1,
    strokeAlpha: 1,
    clip: null,
    text: {
      font: null, fontSize: 0, fontDirection: 1, charSpacing: 0, wordSpacing: 0, hScale: 1,
      leading: 0, rise: 0, renderMode: 0, textMatrix: [...IDENTITY], x: 0, y: 0, lineX: 0, lineY: 0,
    },
  };
}

function cloneState(s: GState): GState {
  return { ...s, dash: [...s.dash], text: { ...s.text } };
}

export function parseHexColor(hex: string): Color {
  const v = parseInt(hex.slice(1), 16);
  return { space: "rgb", r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

type Handler = (args: any[]) => void;

export class PageInterpreter {
  private state: GState;
  private stack: GState[] = [];
  private pendingClip: "nonzero" | "evenodd" | null = null;
  private handlers = new Map<number, Handler>();
  private ocDepth: { pushed: boolean }[] = [];
  /** Glyph outlines collected by text render modes 4–7, applied as a clip at ET. */
  private textClip: PathSeg[] | null = null;
  private layerStack: { name: string; visible: boolean }[] = [];
  private warned = new Set<string>();

  constructor(
    private canvas: ImportCanvas,
    private res: Resources,
    /** Maps PDF user space to page space (handles /Rotate and the crop box origin). */
    pageMatrix: Matrix,
    private defaultLayer: string,
    private pageWidth: number,
    private pageHeight: number,
    private depth = 0,
  ) {
    this.state = freshState(pageMatrix);
    this.initHandlers();
  }

  private warnOnce(msg: string) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.canvas.warn(msg);
  }

  /** Operator → handler table. */
  private initHandlers() {
    const h = this.handlers;
    const s = () => this.state;
    h.set(OPS.save, () => { this.stack.push(cloneState(this.state)); });
    h.set(OPS.restore, () => { const p = this.stack.pop(); if (p) this.state = p; });
    h.set(OPS.transform, (a) => { s().ctm = multiply(a as Matrix, s().ctm); });
    h.set(OPS.setLineWidth, ([w]) => { s().lineWidth = w; });
    h.set(OPS.setLineCap, ([c]) => { s().cap = c; });
    h.set(OPS.setLineJoin, ([j]) => { s().join = j; });
    h.set(OPS.setMiterLimit, ([m]) => { s().miterLimit = m; });
    h.set(OPS.setDash, ([arr]) => { s().dash = Array.from(arr ?? []); });
    h.set(OPS.setGState, ([entries]) => this.setGState(entries));
    h.set(OPS.setFillRGBColor, ([hex]) => { s().fill = { kind: "solid", color: this.forcedColor ?? parseHexColor(hex) }; s().tiling = null; });
    h.set(OPS.setStrokeRGBColor, ([hex]) => { s().strokeColor = this.forcedColor ?? parseHexColor(hex); });
    h.set(OPS.setFillTransparent, () => { s().fillAlpha = 0; });
    h.set(OPS.setStrokeTransparent, () => { s().strokeAlpha = 0; });
    h.set(OPS.setFillColorN, (a) => this.setPatternFill(a, true));
    h.set(OPS.setStrokeColorN, (a) => this.setPatternFill(a, false));
    h.set(OPS.clip, () => { this.pendingClip = "nonzero"; });
    h.set(OPS.eoClip, () => { this.pendingClip = "evenodd"; });
    h.set(OPS.constructPath, ([op, data]) => this.constructPath(op, data?.[0] ?? null));
    h.set(OPS.rawFillPath, ([data]) => this.constructPath(OPS.fill, data));
    h.set(OPS.shadingFill, ([id]) => this.shadingFill(id));
    // Text
    h.set(OPS.beginText, () => {
      this.textClip = null;
      const t = s().text;
      t.textMatrix = [...IDENTITY]; t.x = t.y = t.lineX = t.lineY = 0;
    });
    h.set(OPS.endText, () => {
      if (this.textClip) {
        // An empty clip (no glyphs) clips everything away, as in PDF.
        this.applyClip(this.textClip.length ? this.textClip : this.rectSegs(0, 0, 0, 0, IDENTITY), false);
        this.textClip = null;
      }
    });
    h.set(OPS.setFont, ([id, size]) => {
      const t = s().text;
      t.font = this.res.font(id);
      t.fontDirection = size < 0 ? -1 : 1;
      t.fontSize = Math.abs(size);
      if (t.font?.isType3) this.warnOnce(`Type 3 font "${t.font.name}" is not converted yet; its text is skipped.`);
      else if (t.font?.missingFile) this.warnOnce(`Font "${t.font.name}" is not embedded in the PDF and has no outline data; its text is skipped.`);
    });
    h.set(OPS.setCharSpacing, ([v]) => { s().text.charSpacing = v; });
    h.set(OPS.setWordSpacing, ([v]) => { s().text.wordSpacing = v; });
    h.set(OPS.setHScale, ([v]) => { s().text.hScale = v / 100; });
    h.set(OPS.setLeading, ([v]) => { s().text.leading = -v; });
    h.set(OPS.setTextRenderingMode, ([v]) => { s().text.renderMode = v; });
    h.set(OPS.setTextRise, ([v]) => { s().text.rise = v; });
    h.set(OPS.moveText, ([x, y]) => this.moveText(x, y));
    h.set(OPS.setLeadingMoveText, ([x, y]) => { s().text.leading = y; this.moveText(x, y); });
    h.set(OPS.setTextMatrix, ([m]) => {
      const t = s().text;
      t.textMatrix = Array.from(m) as Matrix; t.x = t.y = t.lineX = t.lineY = 0;
    });
    h.set(OPS.nextLine, () => this.moveText(0, s().text.leading));
    h.set(OPS.showText, ([glyphs]) => this.showText(glyphs));
    h.set(OPS.showSpacedText, ([glyphs]) => this.showText(glyphs));
    h.set(OPS.nextLineShowText, ([glyphs]) => { this.moveText(0, s().text.leading); this.showText(glyphs); });
    h.set(OPS.nextLineSetSpacingShowText, ([ws, cs, glyphs]) => {
      s().text.wordSpacing = ws; s().text.charSpacing = cs;
      this.moveText(0, s().text.leading); this.showText(glyphs);
    });
    // XObjects, groups, marked content
    h.set(OPS.paintFormXObjectBegin, ([matrix, bbox]) => {
      this.stack.push(cloneState(this.state));
      if (matrix) s().ctm = multiply(Array.from(matrix) as Matrix, s().ctm);
      s().baseCtm = s().ctm;
      if (bbox) this.intersectClipRect(bbox);
    });
    h.set(OPS.paintFormXObjectEnd, () => { const p = this.stack.pop(); if (p) this.state = p; });
    h.set(OPS.beginGroup, ([group]) => {
      this.stack.push(cloneState(this.state));
      if (group?.matrix) s().ctm = multiply(Array.from(group.matrix) as Matrix, s().ctm);
      if (group?.bbox) this.intersectClipRect(group.bbox);
      if (group?.smask) this.warnOnce("Soft masks are approximated: masked content is imported without its mask.");
    });
    h.set(OPS.endGroup, () => { const p = this.stack.pop(); if (p) this.state = p; });
    h.set(OPS.beginMarkedContent, () => this.ocDepth.push({ pushed: false }));
    h.set(OPS.beginMarkedContentProps, ([tag, props]) => this.beginMarkedContent(tag, props));
    h.set(OPS.endMarkedContent, () => {
      const e = this.ocDepth.pop();
      if (e?.pushed) {
        this.layerStack.pop();
        const top = this.layerStack[this.layerStack.length - 1];
        this.canvas.setLayer(top?.name ?? this.defaultLayer, top?.visible ?? true);
      }
    });
    // Images
    h.set(OPS.paintImageXObject, ([id]) => {
      const img = this.res.image(id);
      if (img) this.paintImage(img, s().ctm);
      else this.warnOnce("An image could not be decoded and was skipped.");
    });
    h.set(OPS.paintInlineImageXObject, ([img]) => this.paintImage(img, s().ctm));
    h.set(OPS.paintImageXObjectRepeat, ([id, sx, sy, positions]) => {
      const img = this.res.image(id);
      if (!img) return;
      for (let i = 0; i < positions.length; i += 2) {
        this.paintImage(img, multiply([sx, 0, 0, sy, positions[i], positions[i + 1]], s().ctm));
      }
    });
    h.set(OPS.paintImageMaskXObject, ([img]) => this.paintMask(img, s().ctm));
    h.set(OPS.paintImageMaskXObjectRepeat, ([img, sx, kx, ky, sy, positions]) => {
      for (let i = 0; i < positions.length; i += 2) {
        this.paintMask(img, multiply([sx, kx, ky, sy, positions[i], positions[i + 1]], s().ctm));
      }
    });
    h.set(OPS.paintImageMaskXObjectGroup, ([images]) => {
      for (const img of images ?? []) {
        const t = img.transform ?? [1, 0, 0, 1, 0, 0];
        this.paintMask(img, multiply(Array.from(t) as Matrix, s().ctm));
      }
    });
    h.set(OPS.paintSolidColorImageMask, () => {
      const segs = this.rectSegs(0, 0, 1, 1, s().ctm);
      this.emitPath(segs, s().fill, false, null, "shape");
    });
    // Operators with no visual effect for vector import
    for (const op of [OPS.dependency, OPS.setRenderingIntent, OPS.setFlatness, OPS.markPoint, OPS.markPointProps,
      OPS.beginCompat, OPS.endCompat, OPS.setCharWidth, OPS.setCharWidthAndBounds, OPS.beginAnnotation,
      OPS.endAnnotation, OPS.setFillColorSpace, OPS.setStrokeColorSpace]) h.set(op, () => {});
  }

  /** Uncoloured tiling patterns (PaintType 2) paint everything in the pattern's colour. */
  private forcedColor: Color | null = null;

  runNested(fnArray: ArrayLike<number>, argsArray: ArrayLike<any>) {
    this.execute(fnArray, argsArray);
  }

  run(fnArray: ArrayLike<number>, argsArray: ArrayLike<any>) {
    this.canvas.setLayer(this.defaultLayer, true);
    this.execute(fnArray, argsArray);
  }

  private execute(fnArray: ArrayLike<number>, argsArray: ArrayLike<any>) {
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const handler = this.handlers.get(fn);
      if (handler) {
        try {
          handler(argsArray[i] ?? []);
        } catch (e) {
          this.warnOnce(`Skipped an operator that failed to convert (${(e as Error).message}).`);
        }
      } else {
        this.warnOnce(`Unsupported PDF drawing operation #${fn} was skipped.`);
      }
    }
  }

  // ---------------------------------------------------------------- state helpers

  private setGState(entries: [string, any][]) {
    const st = this.state;
    for (const [key, value] of entries) {
      switch (key) {
        case "LW": st.lineWidth = value; break;
        case "LC": st.cap = value; break;
        case "LJ": st.join = value; break;
        case "ML": st.miterLimit = value; break;
        case "D": st.dash = Array.from(value?.[0] ?? []); break;
        case "ca": st.fillAlpha = value; break;
        case "CA": st.strokeAlpha = value; break;
        case "Font": {
          const [id, size] = value;
          st.text.font = this.res.font(id);
          st.text.fontSize = Math.abs(size);
          break;
        }
        case "BM":
          if (value && value !== "source-over" && value !== "Normal") this.warnOnce(`Blend mode "${value}" is imported as Normal.`);
          break;
        case "SMask":
          if (value) this.warnOnce("Soft masks are approximated: masked content is imported without its mask.");
          break;
      }
    }
  }

  private setPatternFill(args: any[], isFill: boolean) {
    const [kind, ...rest] = args;
    if (kind === "Shading" || kind === "RadialAxial") {
      const ir = kind === "Shading" ? (typeof rest[0] === "string" ? this.res.pattern(rest[0]) : rest[0]) : args;
      const paint = ir ? this.shadingToPaint(ir, rest[1] ?? null, true) : null;
      if (paint && isFill) { this.state.fill = paint; return; }
      if (paint && !isFill) { this.state.strokeColor = firstStopColor(paint); return; }
    }
    if (kind === "TilingPattern") {
      const [, color, operatorList, matrix, bbox, xstep, ystep, paintType] = args;
      if (isFill && operatorList) {
        const m = matrix ? (Array.from(matrix) as Matrix) : ([...IDENTITY] as Matrix);
        this.state.tiling = {
          operatorList, matrix: m, bbox: Array.from(bbox ?? [0, 0, 1, 1]) as any,
          xstep: Math.abs(xstep) || 1, ystep: Math.abs(ystep) || 1, paintType,
          color: typeof color === "string" ? parseHexColor(color) : null,
          space: multiply(m, this.state.baseCtm),
        };
        return;
      }
      this.warnOnce("Tiling patterns on outlines are imported as a flat colour.");
      this.state.strokeColor = { space: "rgb", r: 0.6, g: 0.6, b: 0.6 };
      return;
    }
    // Uncoloured patterns / unknown: keep current colour.
  }

  /** Converts a pdf.js shading IR into a page-space gradient paint. */
  private shadingToPaint(ir: any[], patternMatrix: Matrix | null, isPattern = false): Paint | null {
    if (!ir || ir[0] !== "RadialAxial") {
      // Mesh / function-based shadings: fall back to a solid representative colour.
      this.warnOnce("Mesh and function-based shadings are imported as a flat colour.");
      return { kind: "solid", color: { space: "rgb", r: 0.5, g: 0.5, b: 0.5 } };
    }
    const [, type, , colorStops, p0, p1, r0, r1] = ir;
    const stops = cleanStops(colorStops as [number, string][])
      .map(([offset, c]) => ({ offset: Math.min(1, Math.max(0, offset)), color: parseHexColor(c) }));
    if (!stops.length) return null;
    // Shading patterns live in pattern space (relative to the base CTM); `sh` uses the current CTM.
    const space = isPattern ? this.state.baseCtm : this.state.ctm;
    const m = patternMatrix ? multiply(Array.from(patternMatrix) as Matrix, space) : space;
    if (type === "axial") {
      const [x0, y0] = apply(m, p0[0], p0[1]);
      const [x1, y1] = apply(m, p1[0], p1[1]);
      return { kind: "linear", stops, x0, y0, x1, y1 };
    }
    const [cx, cy] = apply(m, p1[0], p1[1]);
    const r = (r1 ?? 0) * meanScale(m);
    if (r0) this.warnOnce("Two-circle radial gradients are imported as a simple radial gradient.");
    return { kind: "radial", stops, cx, cy, r };
  }

  private intersectClipRect(bbox: ArrayLike<number>) {
    const segs = this.rectSegs(bbox[0], bbox[1], bbox[2], bbox[3], this.state.ctm);
    this.applyClip(segs, false);
  }

  private applyClip(segs: PathSeg[], evenOdd: boolean) {
    this.state.clip = intersectClip(this.state.clip, segs, evenOdd);
  }

  private rectSegs(x0: number, y0: number, x1: number, y1: number, m: Matrix): PathSeg[] {
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => apply(m, x, y));
    return [
      { op: "M", x: pts[0][0], y: pts[0][1] },
      { op: "L", x: pts[1][0], y: pts[1][1] },
      { op: "L", x: pts[2][0], y: pts[2][1] },
      { op: "L", x: pts[3][0], y: pts[3][1] },
      { op: "Z" },
    ];
  }

  // ---------------------------------------------------------------- paths

  private constructPath(paintOp: number, data: ArrayLike<number> | null) {
    const segs = data ? this.toSegs(data, this.state.ctm) : [];
    if (this.pendingClip) {
      if (segs.length) this.applyClip(segs, this.pendingClip === "evenodd");
      this.pendingClip = null;
    }
    if (!segs.length) return;
    const st = this.state;
    let fill = false, stroke = false, evenOdd = false, close = false;
    switch (paintOp) {
      case OPS.stroke: stroke = true; break;
      case OPS.closeStroke: stroke = true; close = true; break;
      case OPS.fill: fill = true; break;
      case OPS.eoFill: fill = true; evenOdd = true; break;
      case OPS.fillStroke: fill = stroke = true; break;
      case OPS.eoFillStroke: fill = stroke = true; evenOdd = true; break;
      case OPS.closeFillStroke: fill = stroke = true; close = true; break;
      case OPS.closeEOFillStroke: fill = stroke = true; evenOdd = true; close = true; break;
      case OPS.endPath: return;
      default: return;
    }
    if (close && segs[segs.length - 1].op !== "Z") segs.push({ op: "Z" });
    if (fill && st.fillAlpha === 0) fill = false;
    if (stroke && st.strokeAlpha === 0) stroke = false;
    if (!fill && !stroke) return;
    if (fill && st.tiling) {
      this.fillWithTiling(segs, evenOdd, st.tiling);
      if (stroke) this.emitPath(segs, null, false, this.currentStroke(st.ctm), "shape");
      return;
    }
    this.emitPath(segs, fill ? st.fill : null, evenOdd, stroke ? this.currentStroke(st.ctm) : null, "shape");
  }

  /**
   * Expands a tiling pattern: replays the tile's own drawing operations once per tile cell that
   * touches the filled area, each clipped to the area (an "expanded" pattern).
   */
  private fillWithTiling(segs: PathSeg[], evenOdd: boolean, t: TilingFill) {
    const MAX_TILES = 400;
    const region = intersectClip(this.state.clip, segs, evenOdd);
    if (!region.polys.length) return;
    const inv = invertMatrix(t.space);
    const b = region.bbox;
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
      const [u, v] = apply(inv, x, y);
      px0 = Math.min(px0, u); py0 = Math.min(py0, v); px1 = Math.max(px1, u); py1 = Math.max(py1, v);
    }
    const [bx0, by0, bx1, by1] = t.bbox;
    const i0 = Math.floor((px0 - bx1) / t.xstep), i1 = Math.ceil((px1 - bx0) / t.xstep);
    const j0 = Math.floor((py0 - by1) / t.ystep), j1 = Math.ceil((py1 - by0) / t.ystep);
    const count = (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!isFinite(count) || count > MAX_TILES || this.depth > 2) {
      this.warnOnce("A tiling pattern with too many tiles was imported as a flat colour.");
      const flat: Paint = { kind: "solid", color: t.color ?? { space: "rgb", r: 0.6, g: 0.6, b: 0.6 } };
      this.canvas.drawPath({ segs, fill: flat, evenOdd, stroke: null, opacity: this.state.fillAlpha, clip: this.state.clip, origin: "shape" });
      return;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = multiply([1, 0, 0, 1, i * t.xstep, j * t.ystep], t.space);
        const cellRect = this.rectSegs(bx0, by0, bx1, by1, cell);
        const cellClip = intersectClip(region, cellRect, false);
        if (!cellClip.polys.length) continue;
        const child = new PageInterpreter(this.canvas, this.res, cell, this.defaultLayer, this.pageWidth, this.pageHeight, this.depth + 1);
        child.state.clip = cellClip;
        child.state.fillAlpha = this.state.fillAlpha;
        if (t.paintType === 2 && t.color) {
          child.forcedColor = t.color;
          child.state.fill = { kind: "solid", color: t.color };
          child.state.strokeColor = t.color;
        }
        child.runNested(t.operatorList.fnArray, t.operatorList.argsArray);
      }
    }
  }

  private toSegs(d: ArrayLike<number>, m: Matrix): PathSeg[] {
    const out: PathSeg[] = [];
    let cx = 0, cy = 0, sx = 0, sy = 0; // current and subpath start (user space)
    for (let i = 0; i < d.length;) {
      switch (d[i++]) {
        case DRAW.moveTo: {
          cx = sx = d[i++]; cy = sy = d[i++];
          const [x, y] = apply(m, cx, cy);
          out.push({ op: "M", x, y });
          break;
        }
        case DRAW.lineTo: {
          cx = d[i++]; cy = d[i++];
          const [x, y] = apply(m, cx, cy);
          out.push({ op: "L", x, y });
          break;
        }
        case DRAW.curveTo: {
          const [x1, y1] = apply(m, d[i++], d[i++]);
          const [x2, y2] = apply(m, d[i++], d[i++]);
          cx = d[i++]; cy = d[i++];
          const [x, y] = apply(m, cx, cy);
          out.push({ op: "C", x1, y1, x2, y2, x, y });
          break;
        }
        case DRAW.quadraticCurveTo: {
          const qx = d[i++], qy = d[i++], ex = d[i++], ey = d[i++];
          const c1 = apply(m, cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy));
          const c2 = apply(m, ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey));
          const [x, y] = apply(m, ex, ey);
          cx = ex; cy = ey;
          out.push({ op: "C", x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1], x, y });
          break;
        }
        case DRAW.closePath:
          out.push({ op: "Z" });
          cx = sx; cy = sy;
          break;
        default:
          return out; // corrupt data — keep what we have
      }
    }
    return out;
  }

  private currentStroke(m: Matrix): Stroke {
    const st = this.state;
    const k = meanScale(m);
    return {
      width: st.lineWidth * k,
      color: st.strokeColor,
      cap: st.cap,
      join: st.join,
      miterLimit: st.miterLimit,
      dash: st.dash.map((v) => v * k),
    };
  }

  private emitPath(segs: PathSeg[], fill: Paint | null, evenOdd: boolean, stroke: Stroke | null, origin: "text" | "shape" | "shading") {
    const st = this.state;
    const opacity = fill ? st.fillAlpha : st.strokeAlpha;
    this.canvas.drawPath({ segs, fill, evenOdd, stroke, opacity, clip: st.clip, origin });
  }

  private shadingFill(id: string) {
    const ir = this.res.pattern(id) as any[] | null;
    if (!ir) return;
    const paint = this.shadingToPaint(ir, null);
    if (!paint) return;
    const st = this.state;
    // `sh` paints the shading over the current clip. Work out the area the shading itself covers
    // (non-extended gradients stop at their end points), then intersect with the clip.
    const stops: [number, string][] = ir[0] === "RadialAxial" ? ir[3] : [];
    const { extStart, extEnd } = extension(stops);
    const page = polygonSegs([[0, 0], [this.pageWidth, 0], [this.pageWidth, this.pageHeight], [0, this.pageHeight]]);
    let area: PathSeg[] | null = null; // null = unbounded
    if (paint.kind === "linear" && !(extStart && extEnd)) {
      const dx = paint.x1 - paint.x0, dy = paint.y1 - paint.y0;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      const L = 4 * (this.pageWidth + this.pageHeight);
      const a0 = extStart ? -L : 0, a1 = extEnd ? len + L : len;
      const p = (t: number, s: number): [number, number] => [paint.x0 + ux * t + nx * s, paint.y0 + uy * t + ny * s];
      area = polygonSegs([p(a0, -L), p(a1, -L), p(a1, L), p(a0, L)]);
    } else if (paint.kind === "radial" && !extEnd) {
      const k = 0.5522847498 * paint.r, { cx, cy, r } = paint;
      area = [
        { op: "M", x: cx + r, y: cy },
        { op: "C", x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
        { op: "C", x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
        { op: "C", x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
        { op: "C", x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
        { op: "Z" },
      ];
    }
    let clip = st.clip;
    let segs: PathSeg[];
    if (!area) {
      // Covers everything: use the clip's exact outline when we have one (keeps curves editable).
      segs = clip?.exact ?? page;
      if (clip?.exact) clip = null;
      else if (!clip) clip = intersectClip(null, page, false);
    } else {
      segs = area;
      clip = intersectClip(clip, page, false);
    }
    this.canvas.drawPath({ segs, fill: paint, evenOdd: false, stroke: null, opacity: st.fillAlpha, clip, origin: "shading" });
  }

  // ---------------------------------------------------------------- text

  private moveText(x: number, y: number) {
    const t = this.state.text;
    t.x = t.lineX += x;
    t.y = t.lineY += y;
  }

  /** Lays out glyphs exactly like pdf.js' canvas renderer and emits their outlines as one path. */
  private showText(glyphs: any[]) {
    const st = this.state;
    const t = st.text;
    const font = t.font;
    if (!font) return;
    const fontSize = t.fontSize;
    const hScale = t.hScale * t.fontDirection;
    const fm = font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    const widthAdvanceScale = fontSize * fm[0];
    const vertical = font.vertical;
    const spacingDir = vertical ? 1 : -1;
    const mode = t.renderMode & 3;
    const addToClip = (t.renderMode & 4) !== 0;
    const visible = (mode !== 3 || addToClip) && !font.isType3 && !font.missingFile;
    if (addToClip) this.textClip ??= [];

    // Text space → page space for this run.
    const base = multiply(t.textMatrix, st.ctm);
    const runM = multiply([hScale, 0, 0, 1, t.x, t.y + t.rise], base);

    const segs: PathSeg[] = [];
    let x = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === "number") {
        x += (spacingDir * glyph * fontSize) / 1000;
        continue;
      }
      const spacing = (glyph.isSpace ? t.wordSpacing : 0) + t.charSpacing;
      let width = glyph.width;
      let gx = x, gy = 0;
      if (vertical && glyph.vmetric) {
        gx = -glyph.vmetric[1] * widthAdvanceScale;
        // pdf.js lays vertical glyphs out downwards; its y flip makes the offset negative here.
        gy = -(x + glyph.vmetric[2] * widthAdvanceScale);
        width = -glyph.vmetric[0];
      }
      if (visible && glyph.isInFont !== false) {
        this.appendGlyph(segs, font, glyph.fontChar, gx, gy, fontSize, runM);
        if (glyph.accent) {
          const ax = gx + fontSize * glyph.accent.offset.x;
          const ay = gy + fontSize * glyph.accent.offset.y;
          this.appendGlyph(segs, font, glyph.accent.fontChar, ax, ay, fontSize, runM);
        }
      }
      x += vertical ? width * widthAdvanceScale - spacing * t.fontDirection : width * widthAdvanceScale + spacing * t.fontDirection;
    }
    if (vertical) t.y -= x;
    else t.x += x * hScale;

    if (!segs.length) return;
    if (addToClip) for (const sg of segs) this.textClip!.push(sg);
    const fill = mode === 0 || mode === 2 ? st.fill : null;
    const stroke = mode === 1 || mode === 2 ? this.currentStroke(multiply(t.textMatrix, st.ctm)) : null;
    if (stroke) stroke.width *= 1; // already scaled by text matrix × CTM
    if (!fill && !stroke) return;
    this.canvas.drawPath({ segs, fill, evenOdd: false, stroke, opacity: fill ? st.fillAlpha : st.strokeAlpha, clip: st.clip, origin: "text" });
  }

  private appendGlyph(out: PathSeg[], font: GlyphFont, ch: string, gx: number, gy: number, fontSize: number, runM: Matrix) {
    const d = font.glyphPath(ch);
    if (!d || !d.length) return;
    // Glyph space (already × font matrix) → text-run space: scale by font size, offset by advance.
    const m = multiply([fontSize, 0, 0, fontSize, gx, gy], runM);
    for (const s of this.toSegs(d, m)) out.push(s);
  }

  // ---------------------------------------------------------------- images

  private paintImage(img: PdfImage, m: Matrix) {
    this.canvas.drawImage({ image: img, matrix: m, opacity: this.state.fillAlpha, clip: this.state.clip });
  }

  private paintMask(img: { data: Uint8Array | string; width: number; height: number }, m: Matrix) {
    const data = typeof img.data === "string" ? this.res.mask(img.data) : img.data;
    if (!data) {
      this.warnOnce("An image mask could not be decoded and was skipped.");
      return;
    }
    const tint = this.state.fill;
    // pdf.js image masks are 1bpp, rows padded to bytes; 1 bits are transparent unless inverted.
    this.canvas.drawImage({
      image: { width: img.width, height: img.height, kind: 0, data },
      matrix: m,
      opacity: this.state.fillAlpha,
      clip: this.state.clip,
      tint,
    });
  }

  private beginMarkedContent(tag: string, props: any) {
    if (tag === "OC" && props && (props.type === "OCG" || props.type === "OCMD") && props.id) {
      const oc = this.res.optionalContent(props.id);
      if (oc) {
        this.layerStack.push(oc);
        this.canvas.setLayer(oc.name, oc.visible);
        this.ocDepth.push({ pushed: true });
        return;
      }
    }
    this.ocDepth.push({ pushed: false });
  }
}

function firstStopColor(p: Paint): Color {
  return p.kind === "solid" ? p.color : p.stops[0]?.color ?? BLACK;
}

export function segsBBox(segs: PathSeg[]): BBox {
  const b = emptyBBox();
  for (const s of segs) {
    if (s.op === "Z") continue;
    if (s.op === "C") { extend(b, s.x1, s.y1); extend(b, s.x2, s.y2); }
    extend(b, s.x, s.y);
  }
  if (isEmpty(b)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return b;
}

/**
 * pdf.js marks a non-extended end of a shading by adding a stop at exactly 0 / 1 holding the
 * shading's /Background colour (or "transparent") and nudging the real end stop by 1e-6.
 */
function extension(stops: [number, string][]) {
  const n = stops.length;
  const extStart = !(n > 2 && stops[0][0] === 0 && stops[1][0] > 0 && stops[1][0] < 1e-4);
  const extEnd = !(n > 2 && stops[n - 1][0] === 1 && stops[n - 2][0] < 1 && stops[n - 2][0] > 1 - 1e-4);
  return { extStart, extEnd };
}

function cleanStops(stops: [number, string][]): [number, string][] {
  const { extStart, extEnd } = extension(stops);
  let out = stops.slice(extStart ? 0 : 1, extEnd ? stops.length : stops.length - 1);
  out = out.filter(([, c]) => c !== "transparent");
  if (!extStart && out.length) out[0] = [0, out[0][1]];
  if (!extEnd && out.length) out[out.length - 1] = [1, out[out.length - 1][1]];
  return out;
}
