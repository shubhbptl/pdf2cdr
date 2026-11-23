/**
 * PDF → SceneDocument using pdf.js for parsing (xref, object streams, filters, fonts, images)
 * and our own PageInterpreter for turning drawing operators into editable objects.
 *
 * Pipeline:
 *   load document → for each selected page: get operator list → resolve resources → interpret.
 */
import type { Matrix } from "./geom";
import { multiply } from "./geom";
import { OPS, PageInterpreter, type GlyphFont, type PdfImage, type Resources } from "./interpreter";
import type { SceneDocument } from "./scene";
import { SceneBuilder } from "./scene-builder";

export interface ImportOptions {
  /** 1-based page numbers; empty/undefined = all pages. */
  pages?: number[];
  /** Include content of optional-content layers that are hidden by default. */
  includeHiddenLayers?: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Extra pdf.js getDocument() parameters (worker, standard font URL, password…). */
  pdfjsParams?: Record<string, unknown>;
}

type PdfJs = typeof import("pdfjs-dist");

const getObj = <T>(objs: any, id: string, timeoutMs = 10000): Promise<T | null> =>
  new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      objs.get(id, (v: T) => { if (!done) { done = true; clearTimeout(t); resolve(v); } });
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });

export async function importPdf(pdfjs: PdfJs, data: Uint8Array, opts: ImportOptions = {}): Promise<SceneDocument> {
  const doc: SceneDocument = {
    pages: [],
    warnings: [],
    stats: { paths: 0, glyphs: 0, images: 0, gradients: 0, clipsSimplified: 0 },
  };
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true, // makes pdf.js ship glyph outlines to us
    fontExtraProperties: true,
    isOffscreenCanvasSupported: false, // raw image pixels instead of ImageBitmaps
    isImageDecoderSupported: false,
    ...opts.pdfjsParams,
  } as any);
  const pdf = await loadingTask.promise;
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    doc.title = (meta?.info as any)?.Title || undefined;

    const ocConfig = await pdf.getOptionalContentConfig().catch(() => null);
    const pageNumbers = (opts.pages?.length ? opts.pages : Array.from({ length: pdf.numPages }, (_, i) => i + 1))
      .filter((n) => n >= 1 && n <= pdf.numPages);

    const builder = new SceneBuilder(doc, opts.includeHiddenLayers ?? true);
    for (let idx = 0; idx < pageNumbers.length; idx++) {
      const pageNo = pageNumbers[idx];
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      // pdf.js maps user space to a y-down canvas; flip back to y-up page space.
      const pageM = multiply(viewport.transform as Matrix, [1, 0, 0, -1, 0, viewport.height]);
      const opList = await page.getOperatorList({
        intent: "print",
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      } as any);
      const res = await resolveResources(page, opList, ocConfig, !!opts.includeHiddenLayers);

      builder.beginPage(viewport.width, viewport.height, idx);
      const interp = new PageInterpreter(builder, res, pageM, "Layer 1", viewport.width, viewport.height);
      interp.run(opList.fnArray, opList.argsArray);
      builder.endPage();
      page.cleanup();
      opts.onProgress?.(idx + 1, pageNumbers.length);
    }
  } finally {
    await loadingTask.destroy();
  }
  return doc;
}

async function resolveResources(page: any, opList: any, ocConfig: any, includeHidden: boolean): Promise<Resources> {
  const fonts = new Map<string, GlyphFont>();
  const glyphPaths = new Map<string, ArrayLike<number> | null>();
  const images = new Map<string, PdfImage>();
  const patterns = new Map<string, unknown[]>();
  const masks = new Map<string, Uint8Array>();
  const maskIds = new Set<string>();

  const fontIds = new Set<string>();
  const imageIds = new Set<string>();
  const patternIds = new Set<string>();
  const glyphsByFont = new Map<string, Set<string>>();
  let currentFont: string | null = null;

  const lists: { fnArray: number[]; argsArray: any[] }[] = [opList];
  for (let li = 0; li < lists.length; li++) {
  const { fnArray, argsArray } = lists[li];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.setFont) {
      currentFont = args[0];
      fontIds.add(args[0]);
    } else if (fn === OPS.setGState) {
      for (const [k, v] of args[0] ?? []) if (k === "Font") { currentFont = v[0]; fontIds.add(v[0]); }
    } else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      const glyphs = fn === OPS.nextLineSetSpacingShowText ? args[2] : args[0];
      if (currentFont) {
        let set = glyphsByFont.get(currentFont);
        if (!set) glyphsByFont.set(currentFont, (set = new Set()));
        for (const g of glyphs) if (g && typeof g === "object") {
          set.add(g.fontChar);
          if (g.accent) set.add(g.accent.fontChar);
        }
      }
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      imageIds.add(args[0]);
    } else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat) {
      if (typeof args[0]?.data === "string") maskIds.add(args[0].data);
    } else if (fn === OPS.paintImageMaskXObjectGroup) {
      for (const m of args[0] ?? []) if (typeof m?.data === "string") maskIds.add(m.data);
    } else if (fn === OPS.shadingFill) {
      patternIds.add(args[0]);
    } else if ((fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) && args[0] === "Shading" && typeof args[1] === "string") {
      patternIds.add(args[1]);
    } else if ((fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) && args[0] === "TilingPattern" && args[2]?.fnArray) {
      if (lists.length < 64) lists.push(args[2]);
    }
  }
  }

  for (const id of fontIds) {
    const f: any = await getObj(page.commonObjs, id);
    if (!f) continue;
    fonts.set(id, {
      name: f.name ?? id,
      fontMatrix: (f.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0]) as Matrix,
      vertical: !!f.vertical,
      missingFile: !!f.missingFile,
      isType3: !!f.isType3Font,
      glyphPath: (ch: string) => glyphPaths.get(`${f.loadedName}\u0000${ch}`) ?? null,
    });
    const chars = glyphsByFont.get(id);
    if (chars && !f.missingFile && !f.isType3Font) {
      await Promise.all(
        [...chars].map(async (ch) => {
          const p: any = await getObj(page.commonObjs, `${f.loadedName}_path_${ch}`, 3000);
          glyphPaths.set(`${f.loadedName}\u0000${ch}`, p?.path ?? null);
        }),
      );
    }
  }
  for (const id of imageIds) {
    const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
    const img: any = await getObj(objs, id);
    if (img?.data) images.set(id, { width: img.width, height: img.height, kind: img.kind, data: img.data });
  }
  for (const id of maskIds) {
    const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
    const m: any = await getObj(objs, id);
    if (m?.data) masks.set(id, m.data);
  }
  for (const id of patternIds) {
    const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
    const ir: any = await getObj(objs, id);
    if (ir) patterns.set(id, ir);
  }

  return {
    font: (id) => fonts.get(id) ?? null,
    image: (id) => images.get(id) ?? null,
    pattern: (id) => patterns.get(id) ?? null,
    mask: (id) => masks.get(id) ?? null,
    optionalContent: (id) => {
      const g = ocConfig?.getGroup?.(id);
      if (!g) return null;
      const visible = ocConfig.isVisible?.(g) ?? g.visible ?? true;
      if (!visible && !includeHidden) return { name: g.name ?? id, visible: false };
      return { name: g.name ?? id, visible };
    },
  };
}
