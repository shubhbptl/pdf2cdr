// Copies the pdf.js worker and its data files (standard fonts, CMaps, WASM decoders) into
// public/pdfjs so they are served next to the page.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const src = "node_modules/pdfjs-dist";
const dst = "public/pdfjs";
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(`${src}/legacy/build/pdf.worker.min.mjs`, `${dst}/pdf.worker.min.mjs`);
// CMaps (CJK encodings) go into one JSON file, fetched only when a PDF needs one.
const cmaps = {};
for (const f of readdirSync(`${src}/cmaps`)) if (f.endsWith(".bcmap")) cmaps[f] = readFileSync(`${src}/cmaps/${f}`).toString("base64");
writeFileSync(`${dst}/cmaps.json`, JSON.stringify(cmaps));
// Standard 14 font programs (.pfb/.ttf) likewise go into one JSON file.
const fonts = {};
for (const f of readdirSync(`${src}/standard_fonts`)) if (/\.(pfb|ttf)$/.test(f)) fonts[f] = readFileSync(`${src}/standard_fonts/${f}`).toString("base64");
writeFileSync(`${dst}/standard_fonts.json`, JSON.stringify(fonts));
for (const dir of ["wasm"]) cpSync(`${src}/${dir}`, `${dst}/${dir}`, { recursive: true });
// JavaScript-in-PDF support is not needed for drawing conversion.
for (const f of ["quickjs-eval.js", "quickjs-eval.wasm", "LICENSE_QUICKJS", "LICENSE_PDFJS_QUICKJS"]) rmSync(`${dst}/wasm/${f}`, { force: true });
console.log("pdf.js assets copied to", dst);
