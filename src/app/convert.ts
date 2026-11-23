/** Browser glue: PDF bytes → SceneDocument → .cdr bytes, with pdf.js served from ./pdfjs. */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdf } from "../core/pdf-import";
import { writeCdr } from "../core/cdr/writer";
import type { SceneDocument } from "../core/scene";

const base = new URL("./pdfjs/", document.baseURI).href;
pdfjs.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";

/**
 * Serves pdf.js's binary data: CMaps and standard-font programs from two bundled JSON files
 * (one request each, only when a PDF needs them), WASM decoders from files next to the page.
 */
const bundles = new Map<string, Promise<Record<string, string>>>();
const bundle = (name: string) => {
  if (!bundles.has(name)) bundles.set(name, fetch(base + name).then((r) => r.json()));
  return bundles.get(name)!;
};
class BundledDataFactory {
  constructor(private urls: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }) {}
  async fetch({ kind, filename }: { kind: "cMapUrl" | "standardFontDataUrl" | "wasmUrl"; filename: string }) {
    if (kind === "cMapUrl" || kind === "standardFontDataUrl") {
      const b64 = (await bundle(kind === "cMapUrl" ? "cmaps.json" : "standard_fonts.json"))[filename];
      if (!b64) throw new Error(`Unknown data file ${filename}`);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
    const res = await fetch(`${this.urls[kind]}${filename}`);
    if (!res.ok) throw new Error(`Unable to load ${filename}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export interface ConvertOptions {
  pages?: number[];
  includeHiddenLayers: boolean;
  compress: boolean;
  password?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface ConvertResult {
  scene: SceneDocument;
  cdr: Uint8Array;
  warnings: string[];
  objects: number;
  ms: number;
}

export class PasswordNeeded extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "That password is not correct." : "This PDF is password-protected.");
  }
}

export async function countPages(data: Uint8Array, password?: string): Promise<number> {
  const task = pdfjs.getDocument({ data: data.slice(), password, wasmUrl: base + "wasm/", useWorkerFetch: false, BinaryDataFactory: BundledDataFactory } as any);
  try {
    const pdf = await task.promise;
    return pdf.numPages;
  } catch (e: any) {
    if (e?.name === "PasswordException") throw new PasswordNeeded(e.code === 2);
    throw e;
  } finally {
    task.destroy();
  }
}

export async function convert(data: Uint8Array, opts: ConvertOptions): Promise<ConvertResult> {
  const t0 = performance.now();
  let scene: SceneDocument;
  try {
    scene = await importPdf(pdfjs as any, data.slice(), {
      pages: opts.pages,
      includeHiddenLayers: opts.includeHiddenLayers,
      onProgress: opts.onProgress,
      pdfjsParams: {
        password: opts.password,
        standardFontDataUrl: base + "standard_fonts/",
        cMapUrl: base + "cmaps/",
        cMapPacked: true,
        wasmUrl: base + "wasm/",
        useSystemFonts: false,
        useWorkerFetch: false,
        BinaryDataFactory: BundledDataFactory,
      },
    });
  } catch (e: any) {
    if (e?.name === "PasswordException") throw new PasswordNeeded(e.code === 2);
    if (e?.name === "InvalidPDFException") throw new Error("This file is damaged or is not a PDF.");
    throw e;
  }
  // Let the UI repaint before the (synchronous) writer runs.
  await new Promise((r) => setTimeout(r, 0));
  const out = writeCdr(scene, { compress: opts.compress });
  return { scene, cdr: out.bytes, warnings: out.warnings, objects: out.objects, ms: performance.now() - t0 };
}

/** Parses "1-3, 5, 8-" style page ranges (1-based); empty → all pages. */
export function parseRange(text: string, total: number): number[] | null {
  const t = text.trim();
  if (!t || /^all$/i.test(t)) return [];
  const pages = new Set<number>();
  for (const part of t.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?(?:(-)(\d+)?)?$/);
    if (!m) return null;
    const a = m[1] ? +m[1] : 1;
    const b = m[2] ? (m[3] ? +m[3] : total) : a;
    if (a < 1 || b < a || a > total) return null;
    for (let p = a; p <= Math.min(b, total); p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}
