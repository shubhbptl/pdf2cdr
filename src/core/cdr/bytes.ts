/** Little-endian byte writer used by the CDR record encoders. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.length, v & 0xff); this.length += 1; return this; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.length, v & 0xffff, true); this.length += 2; return this; }
  s16(v: number) { this.ensure(2); this.view.setInt16(this.length, v, true); this.length += 2; return this; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.length, v >>> 0, true); this.length += 4; return this; }
  s32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.length, Math.max(-0x80000000, Math.min(0x7fffffff, Math.round(v))), true);
    this.length += 4;
    return this;
  }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.length, v, true); this.length += 8; return this; }
  bytes(b: ArrayLike<number>) { this.ensure(b.length); this.buf.set(b as any, this.length); this.length += b.length; return this; }
  zeros(n: number) { this.ensure(n); this.buf.fill(0, this.length, this.length + n); this.length += n; return this; }
  fourcc(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; }
  utf16z(s: string) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); this.u16(0); return this; }

  /** Overwrites a u32 at an earlier position (used for back-patching offsets). */
  patchU32(pos: number, v: number) { this.view.setUint32(pos, v >>> 0, true); }
  patchS32(pos: number, v: number) { this.view.setInt32(pos, Math.round(v), true); }

  toBytes(): Uint8Array { return this.buf.slice(0, this.length); }
}

export function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
