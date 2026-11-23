/**
 * Encoders for the CorelDRAW X5 (version 1500) records the converter writes.
 *
 * Field layouts follow libcdr's reader (the Document Liberation Project's open documentation of
 * the format) and the byte layout of records saved by CorelDRAW X5 itself; fields whose meaning
 * is unknown are written with the values CorelDRAW writes for a default object.
 */
import { unzlibSync } from "fflate";
import { ByteWriter, hex } from "./bytes";
import { MCFG_TEMPLATE_B64 } from "./mcfg-template";
import type { Color } from "../scene";

/** CDR world units: 1/254000 inch. PDF points are 1/72 inch. */
export const UNITS_PER_PT = 254000 / 72;

export const V1300_TAG = 0x0514; // version marker CorelDRAW writes in X3+ sub-records

export function randomGuid(rng: () => number): Uint8Array {
  const g = new Uint8Array(16);
  for (let i = 0; i < 16; i++) g[i] = Math.floor(rng() * 256);
  g[6] = (g[6] & 0x0f) | 0x40;
  g[8] = (g[8] & 0x3f) | 0x80;
  return g;
}

/** 12-byte colour: model u16, palette u16, 4 reserved bytes, value u32. */
export function colorBytes(c: Color): Uint8Array {
  const w = new ByteWriter(12);
  if (c.space === "cmyk") {
    // Model 2: CMYK in percent, one byte per channel (c, m, y, k).
    const p = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);
    w.u16(2).u16(5).u32(0).u8(p(c.c)).u8(p(c.m)).u8(p(c.y)).u8(p(c.k));
  } else {
    // Model 5: RGB stored as 0x00RRGGBB.
    const b = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    w.u16(5).u16(5).u32(0).u32((b(c.r) << 16) | (b(c.g) << 8) | b(c.b));
  }
  return w.toBytes();
}

/** The 43-byte colour block CorelDRAW X3+ embeds in fills, outlines and layers. */
function colorBlock(c: Color): Uint8Array {
  return new ByteWriter(43)
    .bytes([0x01, 0x0c, 0x00, 0x00, 0x00])
    .bytes(colorBytes(c))
    .bytes([0x07, 0x10, 0x00, 0x00, 0x00])
    .zeros(16) // palette GUID (none)
    .zeros(5)
    .toBytes();
}

// ------------------------------------------------------------------ fills

export function fildNone(id: number): Uint8Array {
  return new ByteWriter(22).u32(id).u32(V1300_TAG).u32(10).u16(0).zeros(8).toBytes();
}

export function fildSolid(id: number, c: Color): Uint8Array {
  // Tail of CorelDRAW's solid-fill body after the colour block (observed constant bytes).
  const tail = hex("00".repeat(13) + "40a5ae023c" + "00".repeat(11)); // 29 bytes
  const inner = new ByteWriter(67).bytes(colorBlock(c).subarray(0, 38)).bytes(tail).toBytes();
  const w = new ByteWriter(97);
  w.u32(id).u32(V1300_TAG).u32(2 + 8 + inner.length + 8);
  w.u16(1).u32(V1300_TAG).u32(inner.length).bytes(inner).zeros(8);
  return w.toBytes();
}

export interface GradientSpec {
  type: 1 | 2; // 1 = linear, 2 = radial
  angleDeg: number;
  edgeOffset: number; // percent
  centerX: number; // percent offset from object centre
  centerY: number;
  stops: { offset: number; color: Color }[]; // offset 0..1
}

/**
 * Fountain fill (fild type 2) in the layout CorelDRAW X5 writes (checked against X5-saved
 * files; CorelDRAW 2026 rejects the whole document if this record is malformed):
 *   inner = u32 type (1 linear, 2 radial) · 14 constant bytes · u16 edge offset ·
 *           s32 angle (millionths of a degree) · s32 centre x · s32 centre y ·
 *           u16 0 · u16 blend (0 = two-colour, 3 = custom; CorelDRAW ignores middle stops
 *           unless 3) · u16 1 · u16 midpoint (50) · u16 stop count ·
 *           per stop: 43-byte colour block + u16 position (0–100) · 8 zero bytes
 *   record = u32 id · tag · u32 (2 + 8 + inner + 8) · u16 2 · tag · u32 inner · inner · 8 zeros
 */
export function fildGradient(id: number, g: GradientSpec): Uint8Array {
  const body = new ByteWriter(64 + 45 * g.stops.length);
  body.u32(g.type);
  body.bytes(hex("0151000000" + "0040a5ae023c000000")); // 14 bytes, constant in X5 files
  body.s16(Math.round(g.edgeOffset));
  body.s32(Math.round(g.angleDeg * 1e6));
  body.s32(Math.round(g.centerX));
  body.s32(Math.round(g.centerY));
  body.u16(0).u16(g.stops.length > 2 ? 3 : 0).u16(1).u16(50).u16(g.stops.length); // 3 = custom blend
  for (const s of g.stops) {
    body.bytes(colorBlock(s.color));
    body.u16(Math.round(Math.min(1, Math.max(0, s.offset)) * 100));
  }
  body.zeros(8);
  const inner = body.toBytes();
  const w = new ByteWriter(inner.length + 30);
  w.u32(id).u32(V1300_TAG).u32(2 + 8 + inner.length + 8);
  w.u16(2).u32(V1300_TAG).u32(inner.length).bytes(inner).zeros(8);
  return w.toBytes();
}

// ------------------------------------------------------------------ outlines

export interface OutlineSpec {
  width: number; // CDR units
  color: Color;
  cap: number;
  join: number;
  dash: number[]; // in multiples of line width
}

/** Outline style. `null` spec writes CorelDRAW's "no outline". */
export function outl(id: number, spec: OutlineSpec | null): Uint8Array {
  const color: Color = spec?.color ?? { space: "rgb", r: 0, g: 0, b: 0 };
  const w = new ByteWriter(272);
  w.u32(id);
  // Sub-record 5 (48 bytes) and 3 (4 bytes) as CorelDRAW writes them for a default outline.
  w.u32(5).u32(48).zeros(48);
  w.u32(3).u32(4).u32(0x004c4b40);
  // Sub-record 2: outline colour block.
  w.u32(2).u32(43).bytes(colorBlock(color));
  // Sub-record 1: the outline itself (130 bytes).
  const m = new ByteWriter(130);
  const lineType = !spec ? 0x01 : spec.dash.length ? 0x06 : 0x02;
  m.u16(lineType).u16(spec?.cap ?? 0).u16(spec?.join ?? 0);
  m.s32(spec?.width ?? 0);
  m.u16(100); // stretch %
  m.zeros(4);
  m.f64(1).f64(0).f64(0).f64(0).f64(1).f64(0); // calligraphic nib transform (identity)
  m.bytes(colorBytes(color));
  m.bytes(hex("0000000000000000" + "40a5ae023c000000")); // 16 bytes
  const dash = (spec?.dash ?? []).slice(0, 10);
  m.u16(dash.length);
  for (const d of dash) m.u16(Math.max(1, Math.round(d)));
  m.zeros(22 - dash.length * 2);
  m.u32(0).u32(0); // start / end arrowheads: none
  m.zeros(130 - m.length);
  w.u32(1).u32(130).bytes(m.toBytes());
  w.zeros(8);
  return w.toBytes();
}

// ------------------------------------------------------------------ loda (object geometry & attributes)

export interface LodaArg {
  type: number;
  data: Uint8Array;
}

/**
 * Generic 'loda' record: header, n+1 argument offsets (the last one is the end), argument
 * types in reverse order, then the argument payloads.
 */
export function loda(chunkType: number, args: LodaArg[]): Uint8Array {
  const n = args.length;
  const startArgs = 0x14;
  const startTypes = startArgs + 4 * (n + 1);
  let off = startTypes + 4 * n;
  const offsets: number[] = [];
  for (const a of args) { offsets.push(off); off += a.data.length; }
  const total = off;
  const w = new ByteWriter(total);
  w.u32(total).u32(n).u32(startArgs).u32(startTypes).u32(chunkType);
  for (const o of offsets) w.u32(o);
  w.u32(total);
  for (let i = n - 1; i >= 0; i--) w.u32(args[i].type);
  for (const a of args) w.bytes(a.data);
  return w.toBytes();
}

export const ARG = {
  coords: 0x1e,
  fill: 0x14,
  outline: 0x0a,
  style: 0xc8,
  name: 0x3e8,
  layerColor: 0x7d0,
  objectGuid: 0x9c41,
  layerGuid: 0x9c72,
  objectProps: 0x4ae2,
  pageSize: 0x4aba,
  transparency: 0x1f40,
  flag64: 0x64, // u32 1 on the objects CorelDRAW X5 writes (curves and bitmaps)
} as const;

/**
 * Uniform transparency argument (loda 0x1f40) as CorelDRAW X5 writes it; libcdr reads the
 * opacity as a u16 (per mille) at offset 14.
 */
/**
 * Uniform transparency (loda arg 0x1f40) in the 125-byte layout CorelDRAW X5 writes: the
 * transparency is a double percentage at offset 69 (65.0 = 65 % transparent). libcdr reads
 * a u16 opacity in thousandths at offset 14, a byte CorelDRAW leaves zero, so that is filled
 * in too and both readers agree. The u32 at offset 113 must name a fill in the table (a
 * solid black one, as CorelDRAW writes; otherwise it reports "invalid fill ID"). Offsets 37
 * and 89 hold 1 and 2 in every file CorelDRAW writes; other values load without error but
 * the object is then drawn opaque.
 */
export function transparencyArg(opacity: number, blackFillId: number): Uint8Array {
  const o = Math.min(1, Math.max(0, opacity));
  const t = new Uint8Array(125);
  const v = new DataView(t.buffer);
  v.setUint32(0, V1300_TAG, true);
  v.setUint32(4, 117, true);
  t[8] = 0x05; // uniform
  t[9] = 0x01;
  v.setUint16(14, Math.round(o * 1000), true);
  v.setUint32(37, 1, true);
  v.setUint32(41, 0xffffffff, true);
  v.setFloat64(69, Math.round((1 - o) * 1000) / 10, true);
  v.setUint32(89, 2, true);
  v.setUint32(113, blackFillId, true); // checked: must name a fill in the table

  return t;
}

export const u32Bytes = (v: number) => new ByteWriter(4).u32(v).toBytes();

/** Curve geometry (loda chunk type 3): point count, points (s32 x/y), node type bytes. */
export function curveCoords(points: [number, number][], types: number[]): Uint8Array {
  const w = new ByteWriter(4 + points.length * 9);
  w.u16(points.length).u16(0);
  for (const [x, y] of points) w.s32(x).s32(y);
  for (const t of types) w.u8(t);
  return w.toBytes();
}

export function layerLoda(kind: number, guid: Uint8Array, color: Color, name: string | null): Uint8Array {
  const args: LodaArg[] = [
    { type: ARG.layerGuid, data: guid },
    { type: ARG.layerColor, data: colorBlock(color) },
  ];
  if (name !== null) args.push({ type: ARG.name, data: new ByteWriter().utf16z(name).toBytes() });
  return loda(kind, args);
}

// ------------------------------------------------------------------ transforms, boxes, misc

/** trfd with a single affine transform (x' = a*x + b*y + tx, y' = c*x + d*y + ty). */
export function trfd(a = 1, b = 0, tx = 0, c = 0, d = 1, ty = 0): Uint8Array {
  const w = new ByteWriter(96);
  w.u32(0x60).u32(1).u32(0x10).u32(0x0000ffff).u32(0x18).u32(0x60);
  w.u32(V1300_TAG).u32(0);
  w.u16(0x08).bytes(hex("1200e48b3d03"));
  w.f64(a).f64(b).f64(tx).f64(c).f64(d).f64(ty);
  w.zeros(96 - w.length);
  return w.toBytes();
}

/** Identity fill transform written alongside each object. */
export function ftil(): Uint8Array {
  return new ByteWriter(48).f64(1).f64(0).f64(0).f64(0).f64(1).f64(0).toBytes();
}

export function bbox(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  // CorelDRAW order: left, top, right, bottom.
  return new ByteWriter(16).s32(x0).s32(y1).s32(x1).s32(y0).toBytes();
}

export function obbx(x0: number, y0: number, x1: number, y1: number, pad: number): Uint8Array {
  return new ByteWriter(32)
    .s32(x0).s32(y1).s32(x1).s32(y0)
    .s32(x0 - pad).s32(y1 + pad).s32(x1 + pad).s32(y0 - pad)
    .toBytes();
}

let mcfgTemplate: Uint8Array | null = null;

/**
 * 'mcfg' document settings. CorelDRAW 2026 refuses a file whose mcfg is mostly zeros, so this
 * starts from the record CorelDRAW itself writes and patches the page-dependent fields
 * (found by diffing portrait and landscape saves): page width at 12, height at 16, the
 * landscape flag at 22, and the page's lower-left corner (−w/2, −h/2) at 670 and 674.
 */
export function mcfg(width: number, height: number): Uint8Array {
  if (!mcfgTemplate) {
    const bin = atob(MCFG_TEMPLATE_B64);
    const z = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) z[i] = bin.charCodeAt(i);
    mcfgTemplate = unzlibSync(z);
  }
  const out = mcfgTemplate.slice();
  const v = new DataView(out.buffer);
  v.setInt32(12, width, true);
  v.setInt32(16, height, true);
  v.setUint16(22, width > height ? 1 : 0, true);
  v.setInt32(670, -Math.round(width / 2), true);
  v.setInt32(674, -Math.round(height / 2), true);
  return out;
}

// ------------------------------------------------------------------ bitmaps

/** The 78-byte "RI" section header CorelDRAW X5 writes before pixel data. */
function riHeader(w: ByteWriter, model: number, width: number, height: number, bpp: number, stride: number, size: number, res: number) {
  w.bytes([0x52, 0x49]).u32(78 + size).u32(0).u32(78);
  w.u32(model).u32(1).u32(width).u32(height).u32(1).u32(bpp).u32(stride).u32(size);
  w.u32(0).u32(res).u32(res).u32(0).u32(64).u32(0).u32(0).u32(0);
}

/**
 * 'bmp ' record in the layout CorelDRAW X5 writes (checked against bitmaps CorelDRAW 2026
 * saved as version 15): a 40-byte header, an "RI" section with 24-bit pixels (rows
 * bottom-up, B,G,R, padded to 4 bytes) and, for images with transparency, a second "RI"
 * section holding an 8-bit alpha mask. Resolution is stored as dpi × 39370.
 */
export function bmpRecord(id: number, rgba: Uint8ClampedArray, width: number, height: number, dpi = 72): Uint8Array {
  const stride = (width * 3 + 3) & ~3;
  const size = stride * height;
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
  const mstride = (width + 3) & ~3;
  const msize = mstride * height;
  const total = 40 + 78 + size + (hasAlpha ? 78 + msize : 0);
  const res = Math.round(dpi * 39370);
  const w = new ByteWriter(total);
  w.u32(id).u32(1).u32(0x4955).u32(total - 8).u32(0).u32(32);
  w.u32(hasAlpha ? 40 + 78 + size - 8 : 0).u32(0).u32(2).u32(255);
  riHeader(w, 1, width, height, 24, stride, size, res);
  const row = new Uint8Array(stride);
  for (let y = height - 1; y >= 0; y--) {
    row.fill(0);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      row[x * 3] = rgba[s + 2];
      row[x * 3 + 1] = rgba[s + 1];
      row[x * 3 + 2] = rgba[s];
    }
    w.bytes(row);
  }
  if (hasAlpha) {
    riHeader(w, 99, width, height, 8, mstride, msize, 0);
    const mrow = new Uint8Array(mstride);
    for (let y = height - 1; y >= 0; y--) {
      mrow.fill(0);
      for (let x = 0; x < width; x++) mrow[x] = rgba[(y * width + x) * 4 + 3];
      w.bytes(mrow);
    }
  }
  return w.toBytes();
}

/**
 * Bitmap object geometry (loda chunk type 5), as CorelDRAW X5 writes it: the local rectangle
 * (0,0)-(w,h) twice as (left, top, right, bottom), the image format and size, the image id,
 * and the rectangle as a closed 5-node path. The object's trfd places it on the page.
 */
export function bitmapCoords(imageId: number, w: number, h: number, pxWidth: number, pxHeight: number): Uint8Array {
  const out = new ByteWriter(125);
  out.s32(0).s32(h).s32(w).s32(0);
  out.s32(0).s32(h).s32(w).s32(0);
  out.u16(2).u16(24).u32(pxWidth).u32(pxHeight).u32(1).u32(imageId);
  out.u32(0).u32(0).u32(0xffffffff).u32(0).u32(0);
  const pts: [number, number][] = [[0, h], [w, h], [w, 0], [0, 0], [0, h]];
  out.u16(pts.length).u16(0);
  for (const [x, y] of pts) out.s32(x).s32(y);
  out.bytes([0x0c, 0x44, 0x44, 0x44, 0x48]).zeros(4);
  return out.toBytes();
}
