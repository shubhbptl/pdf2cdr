# pdf2cdr

Turn PDF pages into CorelDRAW drawings (`.cdr`) you can edit: real curves, fills, outlines,
gradients, transparency, images and layers. It runs as a website (the PDF never leaves your
browser) or from the command line.

Output opens in CorelDRAW 2026. It is also checked against libcdr, the open-source CDR reader
used by LibreOffice and Inkscape. You don't need CorelDRAW to run pdf2cdr.

## Quick start

You need Node.js 22 or newer.

```bash
npm install
npm run dev                             # website at http://localhost:5173
npm run convert -- flyer.pdf -o flyer.cdr
```

To host the website yourself, run `npm run build` and upload the `dist/` folder to any static
host. There's no server code.

### Command-line options

```
npm run convert -- input.pdf [-o output.cdr] [options]

  --pages 1-3,5       convert only these pages (default: all)
  --password pw       password for an encrypted PDF
  --no-hidden-layers  drop PDF layers that are hidden by default
  --svg               also write an SVG preview of each page
  --no-compress       write the record stream uncompressed (bigger, easier to inspect)
  --riff              write a bare RIFF file instead of the ZIP container
```

## How it works

A PDF page is a small program: a list of drawing commands such as "set the colour, move here,
draw a line there, fill". pdf2cdr runs that program and records what it draws as CorelDRAW
objects, in four stages.

```
PDF ─▶ pdf.js ─▶ PageInterpreter ─▶ SceneBuilder ─▶ writeCdr ─▶ .cdr
       parse      run operators      collect objects  encode records
```

| Stage | Code |
| --- | --- |
| Parse the file | pdf.js (`pdfjs-dist`) |
| Run each page's operators | `src/core/interpreter.ts` |
| Turn drawing calls into objects | `src/core/scene-builder.ts` |
| Write the file | `src/core/cdr/` |

**1. Parse (pdf.js).** Mozilla's pdf.js reads the file: cross-reference tables, compression,
fonts, images and colour spaces. It hands back each page as an operator list with everything
already decoded. This is the only borrowed stage.

**2. Interpret (`PageInterpreter`).** A table maps every PDF operator to a small handler, and
a graphics-state stack tracks the current colour, transform, line style, clip and opacity
(`q` saves it, `Q` restores it). As the operators run, every shape is worked out in final page
coordinates:

- Text has no font that CorelDRAW could reuse, so each glyph's outline is taken from the font
  and drawn as a curve.
- Shadings become linear or radial gradients with their colour stops.
- Tiling patterns are expanded into real copies of the tile.
- Images and image masks are decoded to RGBA pixels.

**3. Collect objects (`SceneBuilder`).** The interpreter draws onto a "canvas" interface (draw
this path, draw this image, switch layer), and `SceneBuilder` implements it. This is where PDF
features with no direct CorelDRAW equivalent get resolved:

- Clips are applied geometrically with Clipper2, so a fill that crosses a clip edge is cut
  to the visible part.
- PDF layers (optional content) become CorelDRAW layers, and hidden ones stay hidden.

The result is a plain scene of pages, layers and objects, each with a fill, an outline and an
opacity. The website's preview is this scene drawn as SVG.

**4. Write (`writeCdr`).** The scene is encoded the way CorelDRAW stores a document:

- The `.cdr` file is a ZIP holding `content/riffData.cdr`, a RIFF tree (the same chunked
  layout WAV files use).
- Inside are two zlib-compressed blocks. The first holds the bitmaps. The second holds the
  document settings, the fill and outline tables, then each page with its layers and objects.
- Fills and outlines are stored once and referenced by ID, so a hundred shapes in the same
  blue share one fill record.
- Each object's geometry is a list of nodes (move, line, curve, closed). Coordinates are in
  CorelDRAW's unit, 1/254000 inch, with the origin at the page centre.

### Example: one shape, start to finish

The sample flyer has a light beam: a pale yellow triangle at 35% opacity.

| Stage | What the beam looks like |
| --- | --- |
| PDF content stream | `/GS1 gs 1 0.92 0.55 rg 118 441 m 417 500 l 417 400 l h f` |
| pdf.js operator list | set graphics state (opacity 0.35), set fill colour, path, fill |
| Interpreter | a triangle in page coordinates, fill `#FFEB8C`, opacity 0.35 |
| Scene | the same triangle, closed, on its layer |
| `.cdr` | an object with 4 nodes, a fill ID and a 65% uniform transparency |

## What comes across

| In the PDF | In the `.cdr` |
| --- | --- |
| Paths, rectangles, curves | Curve objects with exact Bézier nodes |
| Fills and strokes | Solid fills, and outlines with width, caps, joins and dashes |
| Axial and radial shadings | Linear and radial gradient fills, including multi-stop |
| Constant opacity (`ca` / `CA`) | Uniform transparency |
| Images, image masks | 24-bit bitmaps, with an 8-bit alpha mask where needed |
| Text (embedded and standard fonts) | Curves from the glyph outlines |
| Optional content (layers) | Named CorelDRAW layers |
| Clipping | Applied to the geometry |
| Tiling patterns | Expanded tile by tile (up to 400 tiles per fill) |
| Multiple page sizes and orientations | One CorelDRAW page each, at the right size |

### Not yet

- **Text:** it becomes curves, not editable text. Text-heavy PDFs get large (a 23-page paper
  makes an 18 MB file).
- **Colour:** CMYK and spot colours arrive as RGB, because pdf.js converts them.
- **Gradients:** two-circle radial gradients are approximated.
- **Clipping:** strokes and images that cross a clip edge are kept whole.
- **Other:** blend modes, soft masks, Type 3 fonts and annotations aren't converted.
- **Testing:** only tested in CorelDRAW 2026 on macOS so far.

## The output format

pdf2cdr writes CorelDRAW X5 documents (format version 1500). Current versions of CorelDRAW
open these normally. The record layouts were taken from files CorelDRAW 2026 saved in X5
format, with libcdr's source as a map.

CorelDRAW is much stricter than libcdr. These rules were found by opening output in
CorelDRAW 2026 and comparing it with files CorelDRAW saved itself:

| Rule | What happens otherwise |
| --- | --- |
| Odd-length records in the compressed block get a zero pad byte | "Error reading file" |
| The `mcfg` settings record is complete, with page size and orientation filled in | "Error reading file" |
| Gradient fills use X5's layout: 42-byte header, 45 bytes per stop, 8 zero bytes | "Error reading file" |
| Gradients with more than two stops set the custom-blend flag | Only the first and last colours show |
| Bitmaps sit in the first compressed block and use the 118-byte X5 header | "Invalid object", and the rest of the layer is dropped |
| Filled paths are marked closed (PDF closes fills implicitly) | The shape isn't drawn |
| Transparency uses the 125-byte record (black-fill reference at offset 113), the object flag `0x00080000` and a `ttil` record | "Invalid fill ID", or the object is drawn opaque |

`npm test` checks these records byte for byte against ones CorelDRAW saved (in
`test/fixtures/corel2026-x5/`).

## Project layout

```
src/core/                 the converter (runs in the browser and in Node)
  pdf-import.ts           loads the PDF with pdf.js, resolves fonts, glyphs, images, layers
  interpreter.ts          operator handlers, graphics state, text, shadings, patterns
  scene-builder.ts        canvas → scene: clipping, layers, image conversion
  clip.ts                 clip regions (Clipper2)
  scene.ts, geom.ts       scene types, matrix helpers
  svg-preview.ts          scene → SVG, for the preview and tests
  cdr/
    writer.ts             scene → .cdr: pages, layers, objects, fill and outline tables
    records.ts            byte layouts of each CorelDRAW record
    riff.ts               RIFF and compressed-block encoding
    mcfg-template.ts      CorelDRAW's default document settings
src/app/                  browser glue: pdf.js setup, bundled fonts, the sample PDF
src/main.ts               website UI
bin/pdf2cdr.ts            command line
test/                     test suite, fixtures, libcdr round-trip scripts
```

## Testing

```bash
npm test
```

The suite does two things:

- **Record checks.** It compares the record encoders byte for byte with records CorelDRAW
  saved. These always run.
- **Round trip.** It converts the test PDFs, reads each result back with libcdr, renders it,
  and compares the pixels with poppler's rendering of the original PDF. This part runs when
  `cdr2xhtml` (libcdr-tools), `pdftoppm` (poppler) and `rsvg-convert` are installed.

`test/run-corpus.sh file1.pdf file2.pdf …` runs the same round trip over any PDFs you give it
and prints the worst pixel difference per file.

## Licence

MIT, see [LICENSE](LICENSE).

Dependencies: pdf.js (Apache-2.0), fflate (MIT), clipper2-js (Boost).

pdf2cdr is not affiliated with or endorsed by Corel. CorelDRAW is a trademark of Corel
Corporation.
