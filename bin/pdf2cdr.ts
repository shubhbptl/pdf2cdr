#!/usr/bin/env -S npx tsx
/**
 * pdf2cdr command line:  npx tsx bin/pdf2cdr.ts input.pdf [-o output.cdr] [--pages 1-3,5]
 *                        [--no-hidden-layers] [--no-compress] [--riff] [--svg]
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdf } from "../src/core/pdf-import";
import { writeCdr } from "../src/core/cdr/writer";
import { pageToSvg } from "../src/core/svg-preview";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = args.find((a, i) => !a.startsWith("-") && !["-o", "--pages", "--password"].includes(args[i - 1]));
if (!input || flag("-h") || flag("--help")) {
  console.log(`Usage: pdf2cdr input.pdf [-o output.cdr] [--pages 1-3,5] [--password pw]
       [--no-hidden-layers] [--no-compress] [--riff] [--svg]

  --no-hidden-layers  drop content of PDF layers that are hidden by default
  --no-compress       write the record stream uncompressed (larger, easier to inspect)
  --riff              write a bare RIFF file instead of the X4+ ZIP container
  --svg               also write an SVG preview of each page next to the output`);
  process.exit(input ? 0 : 1);
}

const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pages = (value("--pages") ?? "")
  .split(",")
  .flatMap((p) => {
    const [a, b] = p.split("-").map((n) => parseInt(n, 10));
    if (!a) return [];
    return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i);
  });

const t0 = Date.now();
const scene = await importPdf(pdfjs as any, new Uint8Array(readFileSync(input)), {
  pages,
  includeHiddenLayers: !flag("--no-hidden-layers"),
  pdfjsParams: {
    password: value("--password"),
    standardFontDataUrl: join(pdfjsDir, "standard_fonts/"),
    cMapUrl: join(pdfjsDir, "cmaps/"),
    cMapPacked: true,
    wasmUrl: join(pdfjsDir, "wasm/"),
    iccUrl: join(pdfjsDir, "iccs/"),
    verbosity: 0,
  },
});
const out = writeCdr(scene, { compress: !flag("--no-compress"), container: !flag("--riff") });
const output = value("-o") ?? input.replace(/\.pdf$/i, "") + ".cdr";
writeFileSync(output, out.bytes);
if (flag("--svg")) scene.pages.forEach((p, i) => writeFileSync(output.replace(/\.cdr$/i, "") + `-p${i + 1}.svg`, pageToSvg(p)));

const s = scene.stats;
console.log(`${basename(output)}: ${scene.pages.length} page(s), ${out.objects} objects ` +
  `(${s.glyphs} text runs, ${s.gradients} gradients, ${s.images} images), ${out.bytes.length} bytes, ${Date.now() - t0} ms`);
for (const m of new Set([...scene.warnings.map((w) => `page ${w.page}: ${w.message}`), ...out.warnings])) console.log("  note:", m);
