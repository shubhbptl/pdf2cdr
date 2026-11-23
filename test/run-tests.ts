/**
 * Test suite. Unit checks always run; the libcdr round-trip runs when cdr2xhtml is installed
 * (apt install libcdr-tools) together with poppler (pdftoppm) and rsvg-convert.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { importPdf } from "../src/core/pdf-import";
import { writeCdr } from "../src/core/cdr/writer";
import { fildSolid, fildNone, fildGradient, outl, mcfg, transparencyArg, bitmapCoords, bmpRecord } from "../src/core/cdr/records";
import { hex } from "../src/core/cdr/bytes";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// 1. Record encoders reproduce CorelDRAW X5's own byte layout (ids and GUIDs excluded).
const ref = {
  fild: "004e3401140500005500000001001405000043000000010c00000005000500000000000000000007100000005b967382fda0344ea5c2a29720146cc30000000000000000000000000040a5ae023c00000000000000000000000000000000000000",
  fildNone: "405b3401140500000a00000000000000000000000000",
  outl: "e839eb0a05000000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000004000000404b4c00020000002b000000010c00000005000500000000000000000007100000005b967382fda0344ea5c2a29720146cc300000000000100000082000000020000000000d0070000640000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000050005000000000000000000000000000000000040a5ae023c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
};
const same = (a: Uint8Array, b: Uint8Array, skip: [number, number][]) =>
  a.length === b.length && a.every((v, i) => skip.some(([s, e]) => i >= s && i < e) || v === b[i]);
const black = { space: "rgb" as const, r: 0, g: 0, b: 0 };
check("fild (solid) matches CorelDRAW layout", same(fildSolid(0x01344e00, black), hex(ref.fild), [[44, 60]]));
check("fild (none) matches CorelDRAW layout", same(fildNone(0x01345b40), hex(ref.fildNone), []));
check("outl matches CorelDRAW layout", same(outl(0x0aeb39e8, { width: 2000, color: black, cap: 0, join: 0, dash: [] }), hex(ref.outl), [[102, 118]]));

// 1b. Records CorelDRAW 2026 is strict about, against records it saved itself (version 15).
const corel = (name: string) => new Uint8Array(readFileSync(`test/fixtures/corel2026-x5/${name}`));
const diffAt = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return [`length ${a.length} vs ${b.length}`];
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
  return d;
};
{
  // Uniform transparency 65 %; offsets 14–15 carry libcdr's opacity, 113 the black fill id (1 there).
  const d = diffAt(transparencyArg(0.35, 1), corel("transparency-65.bin"));
  check("transparency arg matches CorelDRAW (except libcdr's u16 at 14)", JSON.stringify(d) === "[14,15]", JSON.stringify(d));
}
{
  // Landscape Letter; CorelDRAW also stores a last-used colour at 1277–1278.
  const d = diffAt(mcfg(11 * 254000, 8.5 * 254000), corel("mcfg-letter-landscape.bin"));
  check("mcfg matches CorelDRAW (landscape Letter)", JSON.stringify(d) === "[1277,1278]", JSON.stringify(d));
}
{
  const d = diffAt(bitmapCoords(2, 1306509, 1306509, 51, 51), corel("bitmap-coords-51px.bin"));
  check("bitmap coords match CorelDRAW", d.length === 0, JSON.stringify(d));
  const px = new Uint8ClampedArray(51 * 51 * 4).fill(255);
  const d2 = diffAt(bmpRecord(2, px, 51, 51, 10).subarray(0, 118), corel("bmp-header-51px.bin"));
  check("bmp header matches CorelDRAW", d2.length === 0, JSON.stringify(d2));
}
{
  const g = fildGradient(7, { type: 1, angleDeg: 0, edgeOffset: 0, centerX: 0, centerY: 0, stops: [0, 0.5, 1].map((offset) => ({ offset, color: black })) });
  const v = new DataView(g.buffer);
  check("gradient fild: X5 layout and custom blend for 3 stops",
    g.length === 30 + 42 + 45 * 3 + 8 && v.getUint16(56, true) === 3 && v.getUint16(62, true) === 3 && v.getUint16(64 + 45 + 43, true) === 50);
}

// 2. End-to-end conversion of the fixtures.
const params = {
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  wasmUrl: "node_modules/pdfjs-dist/wasm/",
  iccUrl: "node_modules/pdfjs-dist/iccs/",
  verbosity: 0,
};
const dir = mkdtempSync(join(tmpdir(), "pdf2cdr-"));
const fixtures = ["test/fixtures/shapes.pdf", "test/fixtures/letter_landscape.pdf", "test/fixtures/harbour-lights.pdf"];
const haveLibcdr = spawnSync("cdr2xhtml", ["--help"]).error === undefined;
for (const f of fixtures) {
  const scene = await importPdf(pdfjs as any, new Uint8Array(readFileSync(f)), { pdfjsParams: params });
  const out = writeCdr(scene, { seed: 7 });
  const zip = unzipSync(out.bytes);
  const riff = zip["content/riffData.cdr"];
  check(`${f}: ZIP container with RIFF 'CDRF'`, !!riff && new TextDecoder().decode(riff.subarray(8, 12)) === "CDRF");
  check(`${f}: first entry is the mimetype CorelDRAW writes`, Object.keys(zip)[0] === "mimetype");
  const path = join(dir, f.replace(/\W+/g, "_") + ".cdr");
  writeFileSync(path, out.bytes);
  if (haveLibcdr) {
    const res = spawnSync("python3", ["test/verify.py", f, path, join(dir, "v_" + f.replace(/\W+/g, "_"))], { encoding: "utf8" });
    const worst = parseFloat(/worst: ([\d.]+)%/.exec(res.stdout)?.[1] ?? "100");
    const pagesOk = /pages in CDR: (\d+), pages in PDF: (\d+)/.exec(res.stdout);
    check(`${f}: libcdr reads ${pagesOk?.[1]} page(s), worst page differs ${worst}%`, worst < 3 && pagesOk?.[1] === pagesOk?.[2]);
  }
}
if (!haveLibcdr) console.log("skip libcdr round-trip (install libcdr-tools, poppler-utils, librsvg2-bin)");
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
void execFileSync; void readdirSync;
