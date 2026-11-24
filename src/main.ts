import "./styles.css";
import { zipSync } from "fflate";
import { convert, countPages, parseRange, PasswordNeeded, type ConvertResult } from "./app/convert";
import { pageToSvg } from "./core/svg-preview";
import type { SceneItem } from "./core/scene";
import { buildSamplePdf } from "./app/sample-pdf";
{
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const drop = $("drop"), fileInput = $<HTMLInputElement>("file");
  const fileInfo = $("fileInfo"), fileName = $("fileName"), fileMeta = $("fileMeta");
  const pagesInput = $<HTMLInputElement>("pages"), pagesHint = $("pagesHint");
  const hiddenBox = $<HTMLInputElement>("hidden"), compressBox = $<HTMLInputElement>("compress");
  const pwField = $("pwField"), pwInput = $<HTMLInputElement>("pw"), pwHint = $("pwHint");
  const opts = $<HTMLFormElement>("opts");
  const progress = $("progress"), bar = $("bar"), progressText = $("progressText");
  const dl = $<HTMLButtonElement>("download"), dlHint = $("dlHint");
  const sheet = $("sheet"), pager = $("pager"), pageLabel = $("pageLabel");
  const prev = $<HTMLButtonElement>("prev"), next = $<HTMLButtonElement>("next");
  const stats = $("stats"), layersEl = $("layers"), notes = $("notes");

  let current: { name: string; data: Uint8Array; pages: number } | null = null;
  let result: ConvertResult | null = null;
  let pageIndex = 0;
  let busy = false;
  let hostDownloads: any = null; // claude.ai artifact host: downloads capability

  
  // Table cell labels for the stacked phone layout.
  for (const table of document.querySelectorAll("table.stack")) {
    const heads = [...table.querySelectorAll("th")].map((th) => th.textContent ?? "");
    for (const row of table.querySelectorAll("tbody tr")) [...row.children].forEach((td, i) => ((td as HTMLElement).dataset.l = heads[i]));
  }

  const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const baseName = (n: string) => n.replace(/\.pdf$/i, "") || "drawing";

  function setBusy(on: boolean, text = "Converting…") {
    busy = on;
    progress.hidden = !on;
    progressText.textContent = text;
    bar.style.width = "0%";
    dl.disabled = on || !result;
    ($<HTMLButtonElement>("reconvert")).disabled = on || !current;
  }

  async function load(name: string, data: Uint8Array) {
    current = { name, data, pages: 0 };
    result = null;
    pwInput.value = "";
    pwField.hidden = true;
    fileInfo.hidden = false;
    fileName.textContent = name;
    fileMeta.textContent = fmtBytes(data.length);
    await run();
  }

  async function run() {
    if (!current || busy) return;
    pagesHint.textContent = "";
    pagesHint.classList.remove("err");
    pwHint.textContent = "";
    setBusy(true, "Reading the PDF…");
    try {
      const password = pwInput.value || undefined;
      if (!current.pages) current.pages = await countPages(current.data, password);
      fileMeta.textContent = `${fmtBytes(current.data.length)} · ${current.pages} page${current.pages === 1 ? "" : "s"}`;
      const pages = parseRange(pagesInput.value, current.pages);
      if (pages === null) {
        pagesHint.textContent = `Use numbers from 1 to ${current.pages}, like 1-3, 5.`;
        pagesHint.classList.add("err");
        setBusy(false);
        return;
      }
      const total = pages.length || current.pages;
      progressText.textContent = `Converting page 1 of ${total}…`;
      result = await convert(current.data, {
        pages,
        password,
        includeHiddenLayers: hiddenBox.checked,
        compress: compressBox.checked,
        onProgress: (done, all) => {
          bar.style.width = `${(done / all) * 100}%`;
          progressText.textContent = done < all ? `Converting page ${done + 1} of ${all}…` : "Writing the .cdr file…";
        },
      });
      pageIndex = 0;
      setBusy(false);
      render();
    } catch (e) {
      setBusy(false);
      if (e instanceof PasswordNeeded) {
        pwField.hidden = false;
        pwHint.textContent = e.message + " Enter it and press Convert again.";
        pwHint.classList.toggle("err", e.incorrect);
        pwInput.focus();
        return;
      }
      result = null;
      sheet.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "empty";
      msg.textContent = `This PDF could not be converted: ${(e as Error).message}`;
      sheet.append(msg);
      notes.replaceChildren(li("That file could not be read.", ""));
      dl.disabled = true;
    }
  }

  function li(text: string, cls = "", tag?: string) {
    const el = document.createElement("li");
    if (cls) el.className = cls;
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      el.append(t);
    }
    return el;
  }

  const countItems = (items: SceneItem[]): number => items.reduce((n, it) => n + (it.type === "group" ? countItems(it.items) : 1), 0);

  function render() {
    if (!result) return;
    const { scene, cdr } = result;
    const page = scene.pages[pageIndex];
    sheet.innerHTML = page ? pageToSvg(page) : "";
    pager.hidden = scene.pages.length < 2;
    pageLabel.textContent = `Page ${pageIndex + 1} of ${scene.pages.length}`;
    prev.disabled = pageIndex === 0;
    next.disabled = pageIndex >= scene.pages.length - 1;

    const s = scene.stats;
    const rows: [string, string][] = [
      ["Objects", fmt(result.objects)],
      ["Text runs", fmt(s.glyphs)],
      ["Gradients", fmt(s.gradients)],
      ["Images", fmt(s.images)],
      ["Pages", fmt(scene.pages.length)],
      [".cdr size", fmtBytes(cdr.length)],
    ];
    stats.replaceChildren(...rows.map(([k, v]) => {
      const d = document.createElement("div");
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      d.append(dt, dd);
      return d;
    }));

    layersEl.replaceChildren(...(page?.layers ?? []).map((l) =>
      li(l.name, "", `${fmt(countItems(l.items))} objects${l.visible ? "" : " · hidden"}`)));

    const msgs = [...new Set([...scene.warnings.map((w) => w.message), ...result.warnings])];
    if (s.clipsSimplified) msgs.push(`${fmt(s.clipsSimplified)} clipped outline(s) or image(s) were kept whole instead of being cut at the clip edge.`);
    notes.replaceChildren(...(msgs.length ? msgs.map((m) => li(m)) : [li("Everything on these pages converted without approximations.", "ok")]));

    dl.disabled = false;
    dl.textContent = hostDownloads ? "Download .cdr (in a .zip)" : "Download .cdr";
    dlHint.textContent = `${baseName(current!.name)}.cdr · converted in ${(result.ms / 1000).toFixed(1)} s`;
  }

  async function download() {
    if (!result || !current) return;
    const name = `${baseName(current.name)}.cdr`;
    if (hostDownloads) {
      // The claude.ai page host only saves certain file types; .zip is one of them.
      const zipped = zipSync({ [name]: [result.cdr, { level: 0 }] });
      try {
        await hostDownloads.save({ filename: `${baseName(current.name)}-cdr.zip`, data: new Blob([zipped]) });
        dlHint.textContent = `Saved. Unzip it to get ${name}.`;
      } catch (e: any) {
        dlHint.textContent = e?.code === "declined" ? "Download cancelled." : "Downloads are not available in this view.";
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([result.cdr as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- events
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (f) await load(f.name, new Uint8Array(await f.arrayBuffer()));
    fileInput.value = "";
  });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = [...((e as DragEvent).dataTransfer?.files ?? [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) await load(f.name, new Uint8Array(await f.arrayBuffer()));
    else notes.replaceChildren(li("That file is not a PDF."));
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
  opts.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  dl.addEventListener("click", download);
  prev.addEventListener("click", () => { if (pageIndex > 0) { pageIndex--; render(); } });
  next.addEventListener("click", () => { if (result && pageIndex < result.scene.pages.length - 1) { pageIndex++; render(); } });
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input")) return;
    if (e.key === "ArrowLeft") prev.click();
    if (e.key === "ArrowRight") next.click();
  });

  // ---- host detection (claude.ai artifact) and the sample that opens with the page
  const claude = (window as any).claude;
  if (claude?.use) {
    claude.use("downloads").then((d: any) => { hostDownloads = d; if (result) render(); }).catch(() => {});
  }
  // Open with a sample (generated here, so the site ships no PDF file).
  load("harbour-lights-sample.pdf", buildSamplePdf()).catch(() => {
    sheet.querySelector(".empty")?.replaceChildren("Drop a PDF to see its converted pages here.");
  });
}
