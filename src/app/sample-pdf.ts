/**
 * Builds the sample flyer PDF in the browser (so the site ships no PDF file). It exercises
 * shadings, clipping, CMYK, transparency, Bézier curves, strokes and text (standard 14 font).
 */
export function buildSamplePdf(): Uint8Array {
  const W = 420, H = 595;
  const c: string[] = [];
  const f = (n: number) => +n.toFixed(2);
  // Sky: axial shading clipped to the upper area
  c.push(`q 0 220 ${W} ${H - 220} re W n /Sh1 sh Q`);
  // Sun: radial shading clipped to a circle
  const k = 0.5523 * 70;
  c.push(`q ${370} 300 m ${370} ${f(300 + k)} ${f(300 + k)} 370 300 370 c ${f(300 - k)} 370 230 ${f(300 + k)} 230 300 c 230 ${f(300 - k)} ${f(300 - k)} 230 300 230 c ${f(300 + k)} 230 370 ${f(300 - k)} 370 300 c h W n /Sh2 sh Q`);
  // Sea (CMYK) and waves
  c.push(`1 0.45 0 0.35 k 0 0 ${W} 250 re f`);
  c.push(`0.85 0.3 0 0.2 k`);
  for (let i = 0; i < 6; i++) {
    const y = 40 + i * 34;
    let p = `0 ${y} m `;
    for (let x = 0; x < 480; x += 60) p += `${x + 15} ${y + 10} ${x + 45} ${y - 10} ${x + 60} ${y} c `;
    c.push(p + `${W} ${y - 14} l 0 ${y - 14} l h f`);
  }
  // Lighthouse
  c.push(`0.96 0.96 0.94 rg 0.12 0.12 0.16 RG 2 w 1 j 80 230 m 130 230 l 120 420 l 90 420 l h B`);
  const xl = (y: number) => 80 + (10 * (y - 230)) / 190, xr = (y: number) => 130 - (10 * (y - 230)) / 190;
  c.push(`0.86 0.12 0.18 rg`);
  for (const [a, b] of [[270, 300], [340, 370]]) c.push(`${f(xl(a))} ${a} m ${f(xr(a))} ${a} l ${f(xr(b))} ${b} l ${f(xl(b))} ${b} l h f`);
  c.push(`0.12 0.12 0.16 rg 84 420 42 10 re f 1 0.85 0.3 rg 92 430 26 22 re B 0.12 0.12 0.16 rg 86 452 m 124 452 l 105 472 l h f`);
  // Light beams at 35 % opacity
  c.push(`q /GS1 gs 1 0.92 0.55 rg 118 441 m ${W} 500 l ${W} 400 l h f 92 441 m 0 470 l 0 420 l h f Q`);
  // Text
  c.push(`BT 1 1 1 rg /F2 34 Tf 30 540 Td (Harbour Lights) Tj ET`);
  c.push(`BT /F1 13 Tf 32 516 Td (Night walk \\267 Saturday 14 March \\267 7 pm) Tj ET`);
  c.push(`BT /F2 11 Tf 30 24 Td (Pier 3 \\267 free entry \\267 bring a torch) Tj ET`);
  const content = c.join("\n");

  const objs: string[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /Shading << /Sh1 7 0 R /Sh2 8 0 R >> /ExtGState << /GS1 9 0 R >> >> >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[6] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[7] = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 ${H} 0 220] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.05 0.12 0.32] /C1 [0.95 0.45 0.35] /N 1 >> >>`;
  objs[8] = `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [300 300 0 300 300 70] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0.95 0.6] /C1 [1 0.55 0.2] /N 1 >> >>`;
  objs[9] = `<< /Type /ExtGState /ca 0.35 >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 0xff);
}
