/** Renders a ScenePage as SVG — used for the in-browser preview and for regression tests. */
import type { Color, Paint, PathSeg, SceneItem, ScenePage } from "./scene";
import { colorToRGB255 } from "./scene-builder";
import { zlibSync } from "fflate";

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function colorCss(c: Color): string {
  const [r, g, b] = colorToRGB255(c);
  return `rgb(${r},${g},${b})`;
}

export function segsToD(segs: PathSeg[], H: number): string {
  let d = "";
  for (const s of segs) {
    switch (s.op) {
      case "M": d += `M${f(s.x)} ${f(H - s.y)}`; break;
      case "L": d += `L${f(s.x)} ${f(H - s.y)}`; break;
      case "C": d += `C${f(s.x1)} ${f(H - s.y1)} ${f(s.x2)} ${f(H - s.y2)} ${f(s.x)} ${f(H - s.y)}`; break;
      case "Z": d += "Z"; break;
    }
  }
  return d;
}

export function pageToSvg(page: ScenePage, opts: { showHidden?: boolean } = {}): string {
  const H = page.height;
  const defs: string[] = [];
  let gid = 0;
  const paint = (p: Paint): string => {
    if (p.kind === "solid") return colorCss(p.color);
    const id = `g${gid++}`;
    const stops = p.stops.map((s) => `<stop offset="${f(s.offset)}" stop-color="${colorCss(s.color)}"/>`).join("");
    if (p.kind === "linear") {
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(p.x0)}" y1="${f(H - p.y0)}" x2="${f(p.x1)}" y2="${f(H - p.y1)}">${stops}</linearGradient>`);
    } else {
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(p.cx)}" cy="${f(H - p.cy)}" r="${f(p.r)}">${stops}</radialGradient>`);
    }
    return `url(#${id})`;
  };
  const caps = ["butt", "round", "square"];
  const joins = ["miter", "round", "bevel"];
  const item = (it: SceneItem): string => {
    if (it.type === "group") return `<g>${it.items.map(item).join("")}</g>`;
    if (it.type === "image") {
      const [a, b, c, d, e, ff] = it.matrix;
      // Unit square, top row first → flip v, then page y-down.
      const m = [a, -b, -c, d, e + c, H - (ff + d)];
      const href = rgbaToDataUrl(it.rgba, it.width, it.height);
      return `<image href="${href}" width="1" height="1" preserveAspectRatio="none" opacity="${f(it.opacity)}" transform="matrix(${m.map(f).join(" ")})"/>`;
    }
    const attrs = [`d="${segsToD(it.segs, H)}"`];
    attrs.push(`fill="${it.fill ? paint(it.fill) : "none"}"`);
    if (it.fill && it.evenOdd) attrs.push(`fill-rule="evenodd"`);
    if (it.stroke) {
      attrs.push(`stroke="${colorCss(it.stroke.color)}" stroke-width="${f(Math.max(it.stroke.width, 0.1))}"`);
      attrs.push(`stroke-linecap="${caps[it.stroke.cap]}" stroke-linejoin="${joins[it.stroke.join]}"`);
      if (it.stroke.dash.length) attrs.push(`stroke-dasharray="${it.stroke.dash.map(f).join(" ")}"`);
    }
    if (it.opacity < 1) attrs.push(`opacity="${f(it.opacity)}"`);
    return `<path ${attrs.join(" ")}/>`;
  };
  const body = page.layers
    .filter((l) => l.visible || opts.showHidden)
    .map((l) => `<g data-layer="${escapeXml(l.name)}">${l.items.map(item).join("")}</g>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(page.width)} ${f(H)}" width="${f(page.width)}" height="${f(H)}"><defs>${defs.join("")}</defs><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** Minimal PNG encoder (RGBA8) so previews work in browsers and in SVG rasterisers. */
export function rgbaToDataUrl(rgba: Uint8ClampedArray, w: number, h: number): string {
  const png = encodePng(rgba, w, h);
  let bin = "";
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
