/**
 * Clipping support. CorelDRAW keeps PDF clips as PowerClip containers; libcdr (our only open
 * reference reader) does not decode those, so instead of writing unverifiable PowerClip records
 * we resolve clipping geometrically before writing:
 *   - objects entirely inside the clip keep their exact Bézier geometry,
 *   - objects entirely outside are dropped,
 *   - filled objects that straddle the edge are intersected with the clip polygon.
 */
import { Clipper, FillRule, Path64, Paths64, Point64 } from "clipper2-js";
import { emptyBBox, extend, isEmpty, type BBox } from "./geom";
import type { PathSeg } from "./scene";

const SCALE = 1000; // Clipper works on integers: 1/1000 pt resolution
const FLATTEN_TOLERANCE = 0.05; // pt

export interface ClipRegion {
  polys: Paths64;
  bbox: BBox;
  /** Exact curve outline when the region came from a single clip path. */
  exact: PathSeg[] | null;
  exactEvenOdd: boolean;
}

export function flatten(segs: PathSeg[], tol = FLATTEN_TOLERANCE): [number, number][][] {
  const rings: [number, number][][] = [];
  let ring: [number, number][] = [];
  let cx = 0, cy = 0;
  const close = () => { if (ring.length > 2) rings.push(ring); ring = []; };
  for (const s of segs) {
    if (s.op === "M") { close(); ring.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.op === "L") { ring.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.op === "C") {
      const len = Math.hypot(s.x1 - cx, s.y1 - cy) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2);
      const n = Math.min(200, Math.max(2, Math.ceil(Math.sqrt(len / tol) / 2)));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        ring.push([
          u * u * u * cx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
          u * u * u * cy + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
        ]);
      }
      cx = s.x; cy = s.y;
    } else if (s.op === "Z") close();
  }
  close();
  return rings;
}

function toPaths(rings: [number, number][][]): Paths64 {
  const out = new Paths64();
  for (const r of rings) {
    const p = new Path64();
    for (const [x, y] of r) p.push(new Point64(Math.round(x * SCALE), Math.round(y * SCALE)));
    out.push(p);
  }
  return out;
}

function normalize(segs: PathSeg[], evenOdd: boolean): Paths64 {
  return Clipper.Union(toPaths(flatten(segs)), undefined, evenOdd ? FillRule.EvenOdd : FillRule.NonZero);
}

export function pathsToSegs(paths: Paths64): PathSeg[] {
  const segs: PathSeg[] = [];
  for (const p of paths) {
    if (p.length < 3) continue;
    p.forEach((pt, i) => segs.push({ op: i ? "L" : "M", x: pt.x / SCALE, y: pt.y / SCALE }));
    segs.push({ op: "Z" });
  }
  return segs;
}

function bboxOf(paths: Paths64): BBox {
  const b = emptyBBox();
  for (const p of paths) for (const pt of p) extend(b, pt.x / SCALE, pt.y / SCALE);
  return b;
}

/** Returns the region of `prev` ∩ the new clip path. */
export function intersectClip(prev: ClipRegion | null, segs: PathSeg[], evenOdd: boolean): ClipRegion {
  const polys = normalize(segs, evenOdd);
  if (!prev) return { polys, bbox: bboxOf(polys), exact: segs, exactEvenOdd: evenOdd };
  const merged = Clipper.Intersect(prev.polys, polys, FillRule.NonZero);
  // If the new clip fully contains the old one (or vice versa) keep the exact curve of the smaller.
  const area = (p: Paths64) => Math.abs(Clipper.areaPaths(p));
  const am = area(merged);
  let exact: PathSeg[] | null = null, exactEvenOdd = false;
  if (Math.abs(am - area(polys)) < 1e-6 * Math.max(1, am)) { exact = segs; exactEvenOdd = evenOdd; }
  else if (Math.abs(am - area(prev.polys)) < 1e-6 * Math.max(1, am)) { exact = prev.exact; exactEvenOdd = prev.exactEvenOdd; }
  return { polys: merged, bbox: bboxOf(merged), exact, exactEvenOdd };
}

/** Intersects a filled shape with a clip region; returns polygon segments (even-odd safe). */
export function clipFill(segs: PathSeg[], evenOdd: boolean, region: ClipRegion): PathSeg[] {
  const subject = normalize(segs, evenOdd);
  return pathsToSegs(Clipper.Intersect(subject, region.polys, FillRule.NonZero));
}

export function polygonSegs(points: [number, number][]): PathSeg[] {
  return [...points.map(([x, y], i) => ({ op: i ? "L" : "M", x, y }) as PathSeg), { op: "Z" }];
}

export function regionArea(region: ClipRegion): number {
  return Math.abs(Clipper.areaPaths(region.polys)) / (SCALE * SCALE);
}

export function bboxIsEmpty(b: BBox) {
  return isEmpty(b);
}
