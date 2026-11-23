/**
 * Format-neutral drawing model that sits between the PDF interpreter and the CDR writer.
 *
 * All coordinates are PDF points (1/72 in) in page space with the origin at the page's
 * bottom-left corner and y pointing up — the same convention CorelDRAW uses internally
 * (apart from its origin being the page centre, which the writer handles).
 */
import type { BBox } from "./geom";

export type Color =
  | { space: "rgb"; r: number; g: number; b: number } // 0..1
  | { space: "cmyk"; c: number; m: number; y: number; k: number }; // 0..1

export interface GradientStop {
  offset: number; // 0..1
  color: Color;
}

export type Paint =
  | { kind: "solid"; color: Color }
  | {
      kind: "linear";
      stops: GradientStop[];
      /** Gradient axis in page space. */
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      kind: "radial";
      stops: GradientStop[];
      /** Centre and radius of the outer circle in page space. */
      cx: number;
      cy: number;
      r: number;
    };

/** One node of a sub-path, already in page space. */
export type PathSeg =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Z" };

export interface Stroke {
  width: number; // points, page space
  color: Color;
  cap: 0 | 1 | 2; // butt, round, square
  join: 0 | 1 | 2; // miter, round, bevel
  miterLimit: number;
  dash: number[]; // page-space lengths; empty = solid
}

export interface PathItem {
  type: "path";
  segs: PathSeg[];
  fill: Paint | null;
  evenOdd: boolean;
  stroke: Stroke | null;
  opacity: number; // 0..1, 1 = opaque
  bbox: BBox;
  /** Where the item came from, for the conversion report. */
  origin?: "text" | "shape" | "shading";
}

export interface ImageItem {
  type: "image";
  width: number; // pixels
  height: number;
  /** RGBA, 8 bits per channel, top row first. */
  rgba: Uint8ClampedArray;
  /** Maps the unit square (0,0)-(1,1) to page space, PDF image convention. */
  matrix: [number, number, number, number, number, number];
  opacity: number;
  bbox: BBox;
}

export interface GroupItem {
  type: "group";
  name?: string;
  items: SceneItem[];
  bbox: BBox;
}

export type SceneItem = PathItem | ImageItem | GroupItem;

export interface SceneLayer {
  name: string;
  visible: boolean;
  printable: boolean;
  items: SceneItem[];
}

export interface ScenePage {
  width: number; // points
  height: number;
  layers: SceneLayer[];
}

export interface ConversionWarning {
  page: number;
  message: string;
}

export interface SceneDocument {
  title?: string;
  pages: ScenePage[];
  warnings: ConversionWarning[];
  stats: {
    paths: number;
    glyphs: number;
    images: number;
    gradients: number;
    clipsSimplified: number;
  };
}
