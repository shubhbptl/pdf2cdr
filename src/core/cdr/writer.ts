/**
 * SceneDocument → CorelDRAW X5 (.cdr) bytes.
 *
 * Document layout written (matching what CorelDRAW X5 saves):
 *   ZIP { content/riffData.cdr }
 *   riffData.cdr = RIFF 'CDRF' {
 *     vrsn 1500
 *     LIST 'cmpr' {                       (zlib-compressed record stream)
 *       LIST 'doc ' { mcfg, LIST 'filt' { LIST 'filc' { fild }… }, LIST 'otlt' { outl… } }
 *       LIST 'page' { master page: guides / desktop / grid layers }
 *       LIST 'page' { flgs, bbox, LIST 'lgob' { loda(page size) }, LIST 'gobj' { layers… } } …
 *     }
 *   }
 * Each drawing object is LIST 'obj ' { flgs, bbox, obbx, usdn, LIST 'lgob' { loda, ftil, LIST 'trfl' { trfd } } }.
 */
import { zipSync } from "fflate";
import { ByteWriter, concat } from "./bytes";
import {
  ARG, UNITS_PER_PT, bbox, bitmapCoords, bmpRecord, colorBytes, curveCoords, fildGradient, fildNone, fildSolid, ftil, layerLoda, loda, mcfg,
  obbx, outl, randomGuid, transparencyArg, trfd, u32Bytes, type GradientSpec, type LodaArg, type OutlineSpec,
} from "./records";
import { list, rec, serialize, serializeCmpr, type Node } from "./riff";
import type { Color, ImageItem, Paint, PathItem, PathSeg, SceneDocument, SceneItem } from "../scene";

export interface CdrWriteOptions {
  /** Compress the record stream like CorelDRAW does (default true). */
  compress?: boolean;
  /** Wrap in the X4+ ZIP container (default true). */
  container?: boolean;
  /** Deterministic GUIDs for tests. */
  seed?: number;
}

export interface CdrWriteResult {
  bytes: Uint8Array;
  warnings: string[];
  objects: number;
}

const CDRF_VERSION = 1500;

// Node-type flags for curve points (see libcdr CommonParser::processPath).
const NODE_MOVE = 0x00;
const NODE_LINE = 0x40;
const NODE_CTRL = 0xc0;
const NODE_CURVE = 0x80;
const NODE_CLOSED = 0x08;

const LAYER_FLAGS = {
  masterGuides: 0x9801000a,
  masterDesktop: 0x98010008,
  masterGrid: 0x9801011a,
  pageGuides: 0x9800000a,
  user: 0x98000000,
  userHidden: 0x98000108,
};

const OBJECT_FLAGS = 0x08000200;
/** Set on objects that carry a transparency (CorelDRAW draws them opaque without it). */
const OBJECT_FLAG_TRANSPARENT = 0x00080000;
const MASTER_PAGE_FLAGS = 0x90010000;
const PAGE_FLAGS = 0x90000040;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flagsRec = (v: number) => rec("flgs", u32Bytes(v));

export function writeCdr(doc: SceneDocument, opts: CdrWriteOptions = {}): CdrWriteResult {
  const compress = opts.compress ?? true;
  const rng = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
  const warnings: string[] = [];

  const bitmapRecs: Node[] = [];

  // ---- style tables (deduplicated) ----
  const fills = new Map<string, number>();
  const fillRecs: Node[] = [];
  const outlines = new Map<string, number>();
  const outlineRecs: Node[] = [];
  let nextId = 0x1000;

  const fillId = (key: string, make: (id: number) => Uint8Array) => {
    let id = fills.get(key);
    if (id === undefined) {
      id = nextId++;
      fills.set(key, id);
      fillRecs.push(list("filc", [rec("fild", make(id))]));
    }
    return id;
  };
  const outlineId = (key: string, make: (id: number) => Uint8Array) => {
    let id = outlines.get(key);
    if (id === undefined) {
      id = nextId++;
      outlines.set(key, id);
      outlineRecs.push(rec("outl", make(id)));
    }
    return id;
  };
  const noFill = () => fillId("none", fildNone);
  const blackFill = () => fillId("solid:rgb:0,0,0", (id) => fildSolid(id, { space: "rgb", r: 0, g: 0, b: 0 }));
  const noOutline = () => outlineId("none", (id) => outl(id, null));
  noFill();
  noOutline();

  // ---- master page (guides, desktop, grid) ----
  const masterGuides = randomGuid(rng), masterDesktop = randomGuid(rng), masterGrid = randomGuid(rng);
  const green: Color = { space: "rgb", r: 0, g: 1, b: 0 };
  const black: Color = { space: "cmyk", c: 0, m: 0, y: 0, k: 1 };
  const gridColor: Color = { space: "rgb", r: 0xc2 / 255, g: 0xc2 / 255, b: 0xc1 / 255 };
  const layerList = (flags: number, kind: number, guid: Uint8Array, color: Color, name: string | null, objs: Node[] = []) =>
    list("layr", [flagsRec(flags), list("lgob", [rec("loda", layerLoda(kind, guid, color, name))]), ...objs]);

  const first = doc.pages[0] ?? { width: 595.28, height: 841.89, layers: [] };
  const masterPage = list("page", [
    flagsRec(MASTER_PAGE_FLAGS),
    rec("bbox", bbox(0, 0, 0, 0)),
    list("gobj", [
      layerList(LAYER_FLAGS.masterGuides, 0x0c, masterGuides, green, "Guides"),
      layerList(LAYER_FLAGS.masterDesktop, 0x11, masterDesktop, black, "Desktop"),
      layerList(LAYER_FLAGS.masterGrid, 0x0b, masterGrid, gridColor, "Grid"),
    ]),
  ]);

  // ---- pages ----
  let objectCount = 0;
  let usdn = 1;
  const pageNodes: Node[] = [];
  for (const page of doc.pages) {
    const k = UNITS_PER_PT;
    const W = page.width, H = page.height;
    const toX = (x: number) => (x - W / 2) * k;
    const toY = (y: number) => (y - H / 2) * k;

    const objNode = (item: PathItem, closeOpen: boolean): Node | null => {
      const { points, types } = encodeSegs(item.segs, toX, toY, closeOpen);
      if (points.length < 2) return null;
      const fid = item.fill ? fillId(paintKey(item.fill, item), (id) => encodeFill(id, item.fill!, item, k)) : noFill();
      const stroke = item.stroke;
      const oid = stroke
        ? outlineId(strokeKey(item), (id) => outl(id, strokeSpec(item, k)))
        : noOutline();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const pad = stroke ? (stroke.width * k) / 2 : 0;
      const args: LodaArg[] = [
        { type: ARG.objectGuid, data: randomGuid(rng) },
        { type: ARG.objectProps, data: new ByteWriter(12).u32(1).u32(1).u32(0).toBytes() },
      ];
      if (item.opacity < 0.999) args.push({ type: ARG.transparency, data: transparencyArg(item.opacity, blackFill()) });
      args.push(
        { type: ARG.outline, data: u32Bytes(oid) },
        { type: ARG.coords, data: curveCoords(points, types) },
        { type: ARG.fill, data: u32Bytes(fid) },
      );
      const lodaBytes = loda(3, args);
      objectCount++;
      return list("obj ", [
        flagsRec(item.opacity < 0.999 ? OBJECT_FLAGS | OBJECT_FLAG_TRANSPARENT : OBJECT_FLAGS),
        rec("bbox", bbox(x0, y0, x1, y1)),
        rec("obbx", obbx(x0, y0, x1, y1, pad)),
        rec("usdn", u32Bytes(usdn++)),
        list("lgob", [
          rec("loda", lodaBytes),
          rec("ftil", ftil()),
          ...(item.opacity < 0.999 ? [rec("ttil", ftil())] : []), // transparency tiling, as CorelDRAW writes
          list("trfl", [rec("trfd", trfd())]),
        ]),
      ]);
    };

    const imageNode = (img: ImageItem): Node | null => {
      const [a, b, c, d, e, f] = img.matrix;
      const lenX = Math.hypot(a, b), lenY = Math.hypot(c, d);
      if (lenX < 1e-6 || lenY < 1e-6) return null;
      const Wu = lenX * k, Hu = lenY * k;
      const imageId = nextId++;
      const dpi = Math.max(1, Math.round(img.width / (Wu / 254000)));
      bitmapRecs.push(rec("bmp ", bmpRecord(imageId, img.rgba, img.width, img.height, dpi)));
      // Local rectangle (0,0)-(Wu,Hu); trfd maps it onto the page (keeps rotation/skew).
      const t = trfd(a / lenX, c / lenY, toX(e), b / lenX, d / lenY, toY(f));
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [toX(a * u + c * v + e), toY(b * u + d * v + f)]);
      const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      // Argument set and order as CorelDRAW X5 writes bitmap objects.
      const args: LodaArg[] = [
        { type: ARG.name, data: new Uint8Array(2) },
        { type: ARG.flag64, data: u32Bytes(1) },
      ];
      if (img.opacity < 0.999) args.push({ type: ARG.transparency, data: transparencyArg(img.opacity, blackFill()) });
      args.push(
        { type: ARG.coords, data: bitmapCoords(imageId, Wu, Hu, img.width, img.height) },
        { type: ARG.fill, data: u32Bytes(noFill()) },
        { type: ARG.outline, data: u32Bytes(noOutline()) },
      );
      objectCount++;
      return list("obj ", [
        flagsRec(img.opacity < 0.999 ? OBJECT_FLAGS | OBJECT_FLAG_TRANSPARENT : OBJECT_FLAGS),
        rec("bbox", bbox(x0, y0, x1, y1)),
        rec("obbx", obbx(x0, y0, x1, y1, 0)),
        rec("usdn", u32Bytes(usdn++)),
        list("lgob", [
          rec("loda", loda(5, args)),
          rec("ftil", ftil()),
          ...(img.opacity < 0.999 ? [rec("ttil", ftil())] : []),
          list("trfl", [rec("trfd", t)]),
        ]),
      ]);
    };

    const flattenItems = (items: SceneItem[], out: Node[]) => {
      for (const it of items) {
        if (it.type === "path") {
          // PDF fills close every subpath implicitly; CorelDRAW only fills closed curves. When
          // closing would also add a visible edge to the stroke, write the fill and the
          // stroke as two objects (fill below).
          if (it.fill && it.stroke && hasOpenGap(it.segs)) {
            const a = objNode({ ...it, stroke: null }, true);
            const b = objNode({ ...it, fill: null }, false);
            if (a) out.push(a);
            if (b) out.push(b);
          } else {
            const n = objNode(it, !!it.fill);
            if (n) out.push(n);
          }
        } else if (it.type === "group") {
          flattenItems(it.items, out);
        } else if (it.type === "image") {
          const n = imageNode(it);
          if (n) out.push(n);
        }
      }
    };

    const layers: Node[] = [
      layerList(LAYER_FLAGS.masterGuides, 0x0c, masterGuides, green, null),
      layerList(LAYER_FLAGS.masterDesktop, 0x11, masterDesktop, black, null),
      layerList(LAYER_FLAGS.pageGuides, 0x0c, randomGuid(rng), green, "Guides"),
    ];
    // CorelDRAW lists objects bottom-to-top within a layer? It stores them top-most first.
    for (const layer of [...page.layers].reverse()) {
      const objs: Node[] = [];
      flattenItems(layer.items, objs);
      objs.reverse();
      layers.push(layerList(layer.visible ? LAYER_FLAGS.user : LAYER_FLAGS.userHidden, 0, randomGuid(rng), black, layer.name, objs));
    }
    layers.push(layerList(LAYER_FLAGS.masterGrid, 0x0b, masterGrid, gridColor, null));

    const pw = W * k, ph = H * k;
    pageNodes.push(
      list("page", [
        flagsRec(PAGE_FLAGS),
        rec("bbox", bbox(-pw / 2, -ph / 2, pw / 2, ph / 2)),
        list("lgob", [rec("loda", loda(0x0e, [{ type: ARG.pageSize, data: new ByteWriter(8).s32(pw).s32(ph).toBytes() }]))]),
        list("gobj", layers),
      ]),
    );
  }

  const docList = list("doc ", [
    rec("mcfg", mcfg(first.width * UNITS_PER_PT, first.height * UNITS_PER_PT)),
    list("filt", fillRecs),
    list("otlt", outlineRecs),
  ]);

  // CorelDRAW X5 writes two compressed blocks: the first holds the bitmaps (LIST 'bmpt'),
  // empty when there are none; the second holds the document and its pages.
  const bitmaps = bitmapRecs.length ? [list("bmpt", bitmapRecs)] : [];
  const body = [docList, masterPage, ...pageNodes];
  const vrsn = rec("vrsn", new ByteWriter(2).u16(CDRF_VERSION).toBytes());
  const riffBody = compress
    ? concat([serialize(vrsn), serializeCmpr(bitmaps), serializeCmpr(body)])
    : concat([serialize(vrsn), ...bitmaps.map((n) => serialize(n)), ...body.map((n) => serialize(n))]);
  const riff = new ByteWriter(riffBody.length + 12).fourcc("RIFF").u32(riffBody.length + 4).fourcc("CDRF").bytes(riffBody).toBytes();


  const bytes = opts.container === false
    ? riff
    : zipSync(
        {
          mimetype: [new TextEncoder().encode("application/x-vnd.corel.draw.document+zip"), { level: 0 }],
          "content/riffData.cdr": [riff, { level: 0 }],
        },
        { mtime: new Date(2026, 0, 1) },
      );
  return { bytes, warnings, objects: objectCount };
}

// ------------------------------------------------------------------ geometry encoding

/** True when some subpath is left open (no Z) with its end away from its start. */
function hasOpenGap(segs: PathSeg[]): boolean {
  let sx = 0, sy = 0, cx = 0, cy = 0, drawing = false;
  const gap = () => drawing && Math.hypot(cx - sx, cy - sy) > 0.01;
  for (const s of segs) {
    if (s.op === "M") { if (gap()) return true; sx = cx = s.x; sy = cy = s.y; drawing = false; }
    else if (s.op === "L" || s.op === "C") { cx = s.x; cy = s.y; drawing = true; }
    else { drawing = false; cx = sx; cy = sy; }
  }
  return gap();
}

/**
 * Converts path segments to CDR nodes. With `closeOpen`, every subpath is closed (used for
 * filled paths, which PDF closes implicitly); otherwise only subpaths ending in Z are.
 */
function encodeSegs(segs: PathSeg[], toX: (x: number) => number, toY: (y: number) => number, closeOpen = false) {
  const points: [number, number][] = [];
  const types: number[] = [];
  let subStart = -1;
  let startX = 0, startY = 0;
  const closeSub = () => {
    if (subStart < 0) return;
    // Close: make sure the last node sits on the start point, then flag it as closing.
    const last = points.length - 1;
    if (last > subStart) {
      const [lx, ly] = points[last];
      if (Math.abs(lx - startX) > 0.5 || Math.abs(ly - startY) > 0.5) {
        points.push([startX, startY]);
        types.push(NODE_LINE);
      }
      types[points.length - 1] |= NODE_CLOSED;
      types[subStart] |= NODE_CLOSED;
    } else if (last === subStart) {
      points.pop(); types.pop(); // a move with nothing after it
    }
    subStart = -1;
  };
  for (const s of segs) {
    switch (s.op) {
      case "M":
        if (closeOpen) closeSub();
        if (subStart >= 0 && points.length - 1 === subStart) { points.pop(); types.pop(); } // lone move
        subStart = points.length;
        startX = toX(s.x); startY = toY(s.y);
        points.push([startX, startY]);
        types.push(NODE_MOVE);
        break;
      case "L":
        if (subStart < 0) { subStart = points.length; startX = toX(s.x); startY = toY(s.y); points.push([startX, startY]); types.push(NODE_MOVE); break; }
        points.push([toX(s.x), toY(s.y)]);
        types.push(NODE_LINE);
        break;
      case "C":
        if (subStart < 0) { subStart = points.length; startX = toX(s.x1); startY = toY(s.y1); points.push([startX, startY]); types.push(NODE_MOVE); }
        points.push([toX(s.x1), toY(s.y1)]); types.push(NODE_CTRL);
        points.push([toX(s.x2), toY(s.y2)]); types.push(NODE_CTRL);
        points.push([toX(s.x), toY(s.y)]); types.push(NODE_CURVE);
        break;
      case "Z":
        closeSub();
        break;
    }
  }
  if (closeOpen) closeSub();
  if (subStart >= 0 && points.length - 1 === subStart) { points.pop(); types.pop(); }
  return { points, types };
}

// ------------------------------------------------------------------ styles

function colorKey(c: Color) {
  return c.space === "rgb"
    ? `rgb:${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`
    : `cmyk:${Math.round(c.c * 100)},${Math.round(c.m * 100)},${Math.round(c.y * 100)},${Math.round(c.k * 100)}`;
}

function paintKey(p: Paint, item: PathItem): string {
  if (p.kind === "solid") return `solid:${colorKey(p.color)}`;
  // Gradients depend on the object's bounding box, so they are per-object.
  return `grad:${JSON.stringify(gradientSpec(p, item))}`;
}

function encodeFill(id: number, p: Paint, item: PathItem, _k: number): Uint8Array {
  if (p.kind === "solid") return fildSolid(id, p.color);
  return fildGradient(id, gradientSpec(p, item));
}

/**
 * Maps a page-space gradient onto CorelDRAW's object-relative fountain fill. A linear fountain
 * spans the object's bounding box along its angle, so stop offsets are re-based onto that span.
 */
function gradientSpec(p: Exclude<Paint, { kind: "solid" }>, item: PathItem): GradientSpec {
  const b = item.bbox;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const w = Math.max(1e-6, b.x1 - b.x0), h = Math.max(1e-6, b.y1 - b.y0);
  const rebase = (stops: { offset: number; color: Color }[], start: number, len: number, span0: number, spanLen: number) => {
    const out = stops.map((s) => ({ offset: (start + s.offset * len - span0) / spanLen, color: s.color }));
    // Pad colours beyond the gradient's end points, as PDF "extend" does.
    if (out.length && out[0].offset > 0.005) out.unshift({ offset: 0, color: out[0].color });
    if (out.length && out[out.length - 1].offset < 0.995) out.push({ offset: 1, color: out[out.length - 1].color });
    return out.filter((s) => s.offset >= -1e-6 && s.offset <= 1 + 1e-6).map((s) => ({ ...s, offset: Math.min(1, Math.max(0, s.offset)) }));
  };
  if (p.kind === "linear") {
    const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // Projected extent of the bbox along the axis.
    const proj = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => x * ux + y * uy);
    const span0 = Math.min(...proj), spanLen = Math.max(...proj) - span0 || 1;
    const start = p.x0 * ux + p.y0 * uy;
    return {
      type: 1,
      angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      edgeOffset: 0,
      centerX: 0,
      centerY: 0,
      stops: rebase(p.stops, start, len, span0, spanLen),
    };
  }
  // Radial: CorelDRAW's fountain is centred on the bbox centre + offset (percent of the box) and
  // reaches the box corner farthest from that centre, shrunk by the edge pad: r = d·(1 − 2·edge).
  const ncx = (p.cx - b.x0) / w, ncy = (p.cy - b.y0) / h;
  const dx = Math.max(ncx, 1 - ncx) * w, dy = Math.max(ncy, 1 - ncy) * h;
  const reach = Math.hypot(dx, dy) || 1;
  let edge = 0;
  let stops = p.stops;
  if (p.r > 0 && p.r <= reach) edge = ((1 - p.r / reach) / 2) * 100;
  else stops = rebase(p.stops, 0, p.r || reach, 0, reach);
  return {
    type: 2,
    angleDeg: 0,
    edgeOffset: Math.min(49, edge),
    centerX: (ncx - 0.5) * 100,
    centerY: (ncy - 0.5) * 100,
    // CorelDRAW lists radial stops from the outer edge inwards.
    stops: [...stops].reverse().map((s) => ({ offset: 1 - s.offset, color: s.color })),
  };
}

function strokeSpec(item: PathItem, k: number): OutlineSpec {
  const s = item.stroke!;
  const width = Math.max(s.width, 0) * k;
  const unit = Math.max(s.width, 0.01);
  return {
    width,
    color: s.color,
    cap: s.cap,
    join: s.join,
    dash: s.dash.length ? s.dash.map((d) => d / unit) : [],
  };
}

function strokeKey(item: PathItem): string {
  const s = item.stroke!;
  return `${colorKey(s.color)}|${s.width.toFixed(3)}|${s.cap}|${s.join}|${s.dash.map((d) => d.toFixed(2)).join(",")}`;
}

export function colorBytesForTest(c: Color) {
  return colorBytes(c);
}
