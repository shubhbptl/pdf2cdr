/** 2D affine matrix in PDF order: [a, b, c, d, e, f] maps (x, y) -> (a*x + c*y + e, b*x + d*y + f). */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Returns m1 × m2, i.e. apply m1 first, then m2 (PDF "cm" semantics: new CTM = m × CTM). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [...IDENTITY];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Average linear scale factor of a matrix (used to scale stroke widths into page space). */
export function meanScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const emptyBBox = (): BBox => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

export function extend(b: BBox, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
}

export function isEmpty(b: BBox): boolean {
  return !(b.x1 >= b.x0 && b.y1 >= b.y0);
}

export function intersects(a: BBox, b: BBox): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}
