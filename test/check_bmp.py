#!/usr/bin/env python3
"""Checks 'bmp ' records with the logic of libcdr master's CDRParser::readBmp / readRImage
(version >= 700): image id, 50 skipped bytes, RImage header + data, optional "RI" alpha mask."""
import io, struct, sys, zipfile, zlib

def records(buf, off, end, blocks=None, out=None):
    out = [] if out is None else out
    while off + 8 <= end:
        if buf[off] == 0: off += 1; continue
        fc = buf[off:off+4]; size = struct.unpack_from('<I', buf, off+4)[0]
        if blocks and size < len(blocks): size = blocks[size]
        if fc in (b'RIFF', b'LIST'):
            lt = buf[off+8:off+12]
            if lt == b'cmpr':
                h = off + 12; cs, us, bs, bus = struct.unpack_from('<4I', buf, h)
                data = zlib.decompressobj().decompress(buf[h+24:h+16+cs])
                bl = zlib.decompressobj().decompress(buf[h+16+cs+8:off+8+size])
                records(data, 0, len(data), list(struct.unpack(f'<{len(bl)//4}I', bl)), out)
            else:
                records(buf, off+12, off+8+size, blocks, out)
        else:
            out.append((fc, buf[off+8:off+8+size]))
        off += 8 + size + ((size & 1) if not blocks else 0)
    return out

raw = open(sys.argv[1], 'rb').read()
if raw[:2] == b'PK':
    raw = zipfile.ZipFile(io.BytesIO(raw)).read('content/riffData.cdr')
for fc, d in records(raw, 0, len(raw)):
    if fc != b'bmp ': continue
    p = 0
    image_id = struct.unpack_from('<I', d, p)[0]; p += 4 + 50
    model, _, w, h, _, bpp, _, size = struct.unpack_from('<8I', d, p); p += 32 + 32
    p += size
    mask = None
    if p + 14 + 64 < len(d) and d[p:p+2] == b'RI':
        q = p + 2 + 12 + 8
        mw, mh, _, mbpp, _, msize = struct.unpack_from('<6I', d, q); q += 24 + 32
        if mw == w and mh == h and mbpp == 8 and h and msize // h >= w and q + msize <= len(d):
            mask = d[q:q+msize]
    alpha = f"mask ok, {sum(1 for v in mask if v == 0)} transparent px" if mask else "no mask"
    print(f"bmp id=0x{image_id:x} model={model} {w}x{h} bpp={bpp} size={size} (stride {size // h if h else 0}) {alpha}")
