/**
 * RIFF tree for CorelDRAW documents.
 *
 * A CDR file (or content/riffData.cdr inside the X4+ ZIP container) is a RIFF tree:
 *   RIFF 'CDRF' { vrsn, LIST 'doc ' {...}, LIST 'page' {...}, ... }
 * CorelDRAW X5 wraps the document body in LIST 'cmpr': a zlib-compressed record stream in
 * which every record's size field is an index into a separately compressed table of sizes.
 * Both layouts are produced here; both were validated against libcdr.
 */
import { zlibSync } from "fflate";
import { ByteWriter, concat } from "./bytes";

export type Node = { kind: "rec"; id: string; data: Uint8Array } | { kind: "list"; type: string; children: Node[] };

export const rec = (id: string, data: Uint8Array): Node => ({ kind: "rec", id, data });
export const list = (type: string, children: Node[]): Node => ({ kind: "list", type, children });

/** Plain RIFF serialisation (sizes are byte counts, odd chunks padded to even). */
export function serialize(node: Node, top = false): Uint8Array {
  const w = new ByteWriter();
  if (node.kind === "rec") {
    w.fourcc(node.id).u32(node.data.length).bytes(node.data);
    if (node.data.length & 1) w.u8(0);
    return w.toBytes();
  }
  const body = concat(node.children.map((c) => serialize(c)));
  w.fourcc(top ? "RIFF" : "LIST").u32(body.length + 4).fourcc(node.type).bytes(body);
  if ((body.length + 4) & 1) w.u8(0);
  return w.toBytes();
}

/**
 * Compressed serialisation used inside LIST 'cmpr'. Every size field holds an index into
 * `sizes`. Records of odd length are followed by one zero pad byte that is not counted in
 * the size table; list sizes include their children's padding. This matches files saved by
 * CorelDRAW (X5 and 2026); CorelDRAW 2026 refuses to open a stream without the padding,
 * while libcdr reads either form.
 */
function serializeIndexed(node: Node, sizes: number[], w: ByteWriter) {
  if (node.kind === "rec") {
    w.fourcc(node.id).u32(sizes.length).bytes(node.data);
    sizes.push(node.data.length);
    if (node.data.length & 1) w.u8(0);
    return;
  }
  w.fourcc("LIST");
  const sizePos = w.length;
  w.u32(0);
  const index = sizes.length;
  sizes.push(0); // reserve; filled once the list body is known
  const start = w.length;
  w.fourcc(node.type);
  for (const c of node.children) serializeIndexed(c, sizes, w);
  sizes[index] = w.length - start;
  w.patchU32(sizePos, index);
}

export function compressedList(children: Node[]): Node {
  const sizes: number[] = [];
  const w = new ByteWriter(1 << 16);
  for (const c of children) serializeIndexed(c, sizes, w);
  const data = w.toBytes();
  const sizeTable = new ByteWriter(sizes.length * 4);
  for (const s of sizes) sizeTable.u32(s);
  const table = sizeTable.toBytes();
  const zData = zlibSync(data, { level: 6 });
  const zTable = zlibSync(table, { level: 6 });
  const cpng = new ByteWriter(8).fourcc("CPng").u16(1).u16(4).toBytes();
  const header = new ByteWriter(16)
    .u32(zData.length + 8)
    .u32(data.length)
    .u32(zTable.length + 8)
    .u32(table.length)
    .toBytes();
  // The cmpr payload is opaque bytes after the list type, so model it as one raw record body.
  return { kind: "rec", id: "\u0000raw", data: concat([header, cpng, zData, cpng, zTable]) };
}

/** Serialises a LIST 'cmpr' whose body is produced by compressedList(). */
export function serializeCmpr(children: Node[]): Uint8Array {
  const raw = (compressedList(children) as { data: Uint8Array }).data;
  const w = new ByteWriter(raw.length + 16);
  w.fourcc("LIST").u32(raw.length + 4).fourcc("cmpr").bytes(raw);
  if ((raw.length + 4) & 1) w.u8(0);
  return w.toBytes();
}
