// PDF -> DWG: writes an AutoCAD 2000 (AC1015) DWG from the page data that core.js extracts.
//
//   const dwg = PDF2DWG.build(templateBytes, pages, { unit: "in" | "mm", scale: 1, text: true })
//   -> { bytes: Uint8Array, counts }
//
// How it works: a blank drawing saved by AutoCAD itself is the template. Every object in it
// (dictionaries, layouts, styles, the model space block, ...) is carried over byte for byte, so the
// drawing's skeleton is exactly what AutoCAD writes. Only what has to change is written anew:
// the model space block record (its entity list), the layer and linetype tables (our layers and
// dash patterns are added), the header (next free handle, extents, units), the active viewport
// (so the drawing opens zoomed to fit), plus our own layers, linetypes, text style and entities.
// Then the object map, the second header and the file header are rebuilt for the new layout.
(function (root) {
  "use strict";

  // ---------- CRC (CRC-16, as DWG uses it) ----------
  const CRCT = (() => {
    const t = new Uint16Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xA001 : c >>> 1; t[n] = c; }
    return t;
  })();
  function crc16(seed, u8, start, end) {
    let dx = seed;
    for (let i = start; i < end; i++) dx = ((dx >>> 8) & 0xFF) ^ CRCT[(u8[i] ^ dx) & 0xFF];
    return dx & 0xFFFF;
  }

  // ---------- bit reader ----------
  class BitReader {
    constructor(u8, bytePos, bit) { this.u = u8; this.p = (bytePos || 0) * 8 + (bit || 0); }
    get pos() { return this.p; }
    set pos(v) { this.p = v; }
    B() { const v = (this.u[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
    bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.B(); return v >>> 0; }
    BB() { return this.bits(2); }
    RC() { return this.bits(8); }
    RS() { const a = this.RC(), b = this.RC(); return a | (b << 8); }
    RL() { const a = this.RS(), b = this.RS(); return (a | (b << 16)) >>> 0; }
    RD() { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = this.RC(); return new DataView(b.buffer).getFloat64(0, true); }
    BS() { const c = this.BB(); return c === 0 ? this.RS() : c === 1 ? this.RC() : c === 2 ? 0 : 256; }
    BL() { const c = this.BB(); return c === 0 ? this.RL() : c === 1 ? this.RC() : 0; }
    BD() { const c = this.BB(); return c === 0 ? this.RD() : c === 1 ? 1 : 0; }
    MS() { let r = 0, j = 0; for (let i = 0; i < 2; i++) { const w = this.RS(); if (!(w & 0x8000)) return r + w * 2 ** j; r += (w & 0x7FFF) * 2 ** j; j += 15; } return r; }
    H() { const b = this.RC(), code = b >> 4, n = b & 15; let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this.RC(); return { code, value: v }; }
    TV() { const n = this.BS(); let s = ""; for (let i = 0; i < n; i++) { const c = this.RC(); if (c) s += String.fromCharCode(c); } return s; }
  }

  // ---------- bit writer ----------
  class BitWriter {
    constructor() { this.u = new Uint8Array(1024); this.p = 0; }
    get pos() { return this.p; }
    grow(n) { if (((this.p + n) >> 3) + 2 > this.u.length) { const v = new Uint8Array(Math.max(this.u.length * 2, ((this.p + n) >> 3) + 1024)); v.set(this.u); this.u = v; } }
    B(v) { this.grow(1); if (v) this.u[this.p >> 3] |= 0x80 >> (this.p & 7); this.p++; }
    bits(v, n) { this.grow(n); for (let i = n - 1; i >= 0; i--) this.B((v >>> i) & 1); }
    BB(v) { this.bits(v, 2); }
    RC(v) { this.bits(v & 0xFF, 8); }
    RS(v) { this.RC(v & 0xFF); this.RC((v >>> 8) & 0xFF); }
    RL(v) { this.RS(v & 0xFFFF); this.RS((v >>> 16) & 0xFFFF); }
    RD(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); for (const x of b) this.RC(x); }
    BS(v) { v &= 0xFFFF; if (v === 0) this.BB(2); else if (v === 256) this.BB(3); else if (v < 256) { this.BB(1); this.RC(v); } else { this.BB(0); this.RS(v); } }
    BL(v) { v >>>= 0; if (v === 0) this.BB(2); else if (v < 256) { this.BB(1); this.RC(v); } else { this.BB(0); this.RL(v); } }
    BD(v) { if (v === 0 && !Object.is(v, -0)) this.BB(2); else if (v === 1) this.BB(1); else { this.BB(0); this.RD(v); } }
    H(code, value) {
      const b = []; let v = value;
      while (v > 0) { b.unshift(v % 256); v = Math.floor(v / 256); }
      this.RC((code << 4) | b.length); for (const x of b) this.RC(x);
    }
    TV(s) {   // R2000: bit-short length (with the terminating zero), then the bytes
      if (!s) { this.BS(0); return; }
      const bytes = latin1(s);
      this.BS(bytes.length + 1); for (const x of bytes) this.RC(x); this.RC(0);
    }
    putRL(at, v) {   // overwrite 32 bits at a bit position (a size written before it was known)
      const save = this.p; this.p = at;
      const b = [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
      for (const x of b) for (let i = 7; i >= 0; i--) { const m = 0x80 >> (this.p & 7); if ((x >> i) & 1) this.u[this.p >> 3] |= m; else this.u[this.p >> 3] &= ~m; this.p++; }
      this.p = save;
    }
    copyBits(u8, from, to) { this.grow(to - from); for (let i = from; i < to; i++) this.B((u8[i >> 3] >> (7 - (i & 7))) & 1); }
    bytes() { return this.u.slice(0, (this.p + 7) >> 3); }
  }
  // Text for an ANSI_1252 drawing: characters outside it are written as \U+XXXX, which AutoCAD reads.
  function latin1(s) {
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 32) continue;
      if (c < 127) out.push(c);
      else for (const x of ("\\U+" + (c > 0xFFFF ? "003F" : c.toString(16).toUpperCase().padStart(4, "0")))) out.push(x.charCodeAt(0));
    }
    return out;
  }
  // Modular char (object map): 7 bits a byte, low first; the last byte carries the sign in 0x40.
  function MC(out, v) {
    const neg = v < 0; let a = Math.abs(v);
    for (;;) {
      const g = a & 0x7F; a = Math.floor(a / 128);
      if (a === 0 && !(g & 0x40)) { out.push(g | (neg ? 0x40 : 0)); return; }
      if (a === 0) { out.push(g | 0x80); out.push(neg ? 0x40 : 0); return; }
      out.push(g | 0x80);
    }
  }
  function UMC(out, v) {
    for (;;) { const g = v & 0x7F; v = Math.floor(v / 128); if (v === 0) { out.push(g); return; } out.push(g | 0x80); }
  }
  function readMC(u8, i) {   // -> [value, next index]
    let r = 0, sh = 0;
    for (;;) {
      const b = u8[i++];
      if (!(b & 0x80)) { const neg = b & 0x40; r += (b & 0x3F) * 2 ** sh; return [neg ? -r : r, i]; }
      r += (b & 0x7F) * 2 ** sh; sh += 7;
    }
  }
  function readUMC(u8, i) {
    let r = 0, sh = 0;
    for (;;) { const b = u8[i++]; r += (b & 0x7F) * 2 ** sh; sh += 7; if (!(b & 0x80)) return [r, i]; }
  }

  // ---------- template ----------
  const le = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  function parseTemplate(u8) {
    const dv = le(u8);
    if (String.fromCharCode(...u8.slice(0, 6)) !== "AC1015") throw new Error("template is not an AutoCAD 2000 DWG");
    const nsec = dv.getUint32(0x15, true), sec = [];
    for (let i = 0; i < nsec; i++) { const p = 0x19 + i * 9; sec.push({ nr: u8[p], addr: dv.getUint32(p + 1, true), size: dv.getUint32(p + 5, true) }); }
    const hdrEnd = 0x19 + nsec * 9 + 2;
    const T = { u8, sec, fileHead: u8.slice(0, 0x15), sentinelFileEnd: u8.slice(hdrEnd, hdrEnd + 16) };
    T.aux = u8.slice(sec[5].addr, sec[5].addr + sec[5].size);
    T.thumbAddr = dv.getUint32(0x0D, true);
    T.sentThumbBegin = u8.slice(T.thumbAddr, T.thumbAddr + 16);
    T.thumb = u8.slice(T.thumbAddr, sec[0].addr);         // with both sentinels
    T.sentThumbEnd = u8.slice(sec[0].addr - 16, sec[0].addr);
    // header variables
    const h = sec[0];
    T.sentHdrBegin = u8.slice(h.addr, h.addr + 16);
    T.sentHdrEnd = u8.slice(h.addr + h.size - 16, h.addr + h.size);
    T.hdrBits = dv.getUint32(h.addr + 16, true) * 8;
    T.hdrData = u8.slice(h.addr + 20, h.addr + 20 + T.hdrBits / 8);
    T.classes = u8.slice(sec[1].addr, sec[1].addr + sec[1].size);
    T.template = u8.slice(sec[4].addr, sec[4].addr + sec[4].size);
    // object map -> objects
    const m = sec[2], objs = [];
    let i = m.addr;
    for (;;) {
      const size = (u8[i] << 8) | u8[i + 1];
      if (size <= 2) break;
      const end = i + size; let j = i + 2, hd = 0, off = 0;
      while (j < end) { let d; [d, j] = readUMC(u8, j); hd += d; [d, j] = readMC(u8, j); off += d; objs.push({ handle: hd, addr: off }); }
      i = end + 2;
    }
    for (const o of objs) {
      const r = new BitReader(u8, o.addr);
      o.size = r.MS();
      o.dataStart = r.pos;                   // bit position of the object data (after MS)
      o.type = r.BS();
      o.bitsize = r.RL();
      o.raw = u8.slice(o.addr, (o.dataStart >> 3) + o.size + 2);   // MS + data + CRC
    }
    T.objects = objs;
    T.byHandle = new Map(objs.map(o => [o.handle, o]));
    // second header
    const sh = m.addr + m.size;
    T.sent2Begin = u8.slice(sh, sh + 16);
    const r2 = new BitReader(u8, sh + 16);
    const s2size = r2.RL(); r2.BL();
    for (let k = 0; k < 13; k++) r2.RC();
    r2.BS(); r2.RS();
    const ns = r2.BS(); for (let k = 0; k < ns; k++) { r2.RC(); r2.BL(); r2.BL(); }
    const nh = r2.BS(); T.secondHandles = [];
    for (let k = 0; k < nh; k++) { const n = r2.RC(), nr = r2.RC(); let v = 0; for (let q = 0; q < n; q++) v = v * 256 + r2.RC(); T.secondHandles[nr] = v; }
    const end2 = sh + 16 + s2size + 16;
    T.junk2 = u8.slice(end2 - 16 - 8, end2 - 16);
    T.sent2End = u8.slice(end2 - 16, end2);
    return T;
  }


  // ---------- field codec: one spec function reads or writes, so every spec can be checked by
  // decoding AutoCAD's own objects and encoding them again to the identical bytes ----------
  class IO {
    constructor(rw) { this.r = rw instanceof BitReader ? rw : null; this.w = this.r ? null : rw; }
    get pos() { return (this.r || this.w).pos; }
    f(o, k, t, def) {
      if (this.r) { o[k] = this.read(t, o, k, def); return o[k]; }
      this.write(t, o[k], o, k, def); return o[k];
    }
    read(t, o, k, def) {
      const r = this.r;
      switch (t) {
        case "2RD": return [r.RD(), r.RD()];
        case "3BD": return [r.BD(), r.BD(), r.BD()];
        case "3RD": return [r.RD(), r.RD(), r.RD()];
        case "TIMEBLL": return [r.BL(), r.BL()];
        case "BT": return r.B() ? 0 : r.BD();
        case "4B": return r.bits(4);
        case "BE": return r.B() ? [0, 0, 1] : [r.BD(), r.BD(), r.BD()];
        case "DD": {
          const c = r.BB();
          if (c === 0) return def;
          const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, def, true);
          if (c === 3) return r.RD();
          if (c === 1) { for (let i = 0; i < 4; i++) b[i] = r.RC(); }
          else { b[4] = r.RC(); b[5] = r.RC(); for (let i = 0; i < 4; i++) b[i] = r.RC(); }
          o[k + "$dd"] = c;
          return new DataView(b.buffer).getFloat64(0, true);
        }
        default: return r[t]();
      }
    }
    write(t, v, o, k, def) {
      const w = this.w;
      switch (t) {
        case "2RD": w.RD(v[0]); w.RD(v[1]); return;
        case "3BD": w.BD(v[0]); w.BD(v[1]); w.BD(v[2]); return;
        case "3RD": w.RD(v[0]); w.RD(v[1]); w.RD(v[2]); return;
        case "TIMEBLL": w.BL(v[0]); w.BL(v[1]); return;
        case "BT": if (v === 0) w.B(1); else { w.B(0); w.BD(v); } return;
        case "4B": w.bits(v, 4); return;
        case "BE": if (v[0] === 0 && v[1] === 0 && v[2] === 1) w.B(1); else { w.B(0); w.BD(v[0]); w.BD(v[1]); w.BD(v[2]); } return;
        case "DD": {
          if (v === def) { w.BB(0); return; }
          const c = o[k + "$dd"];
          const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true);
          const d = new Uint8Array(8); new DataView(d.buffer).setFloat64(0, def, true);
          if (c === 1 && b.slice(4).every((x, i) => x === d[4 + i])) { w.BB(1); for (let i = 0; i < 4; i++) w.RC(b[i]); return; }
          if (c === 2 && b[6] === d[6] && b[7] === d[7]) { w.BB(2); w.RC(b[4]); w.RC(b[5]); for (let i = 0; i < 4; i++) w.RC(b[i]); return; }
          w.BB(3); w.RD(v); return;
        }
        case "H": w.H(v.code, v.value); return;
        default: w[t](v);
      }
    }
  }
  const H = (code, value) => ({ code, value });

  // The parts every object shares (R2000): type, size of the data in bits, handle, extended data,
  // then the entity or object header; the handle references follow the data.
  function codec(io, o, spec) {
    const start = io.pos;
    io.f(o, "type", "BS");
    let bsPos = 0;
    if (io.r) o.bitsize = io.r.RL(); else { bsPos = io.w.pos; io.w.RL(0); }
    io.f(o, "handle", "H");
    // extended entity data (kept as raw bytes)
    if (io.r) {
      o.eed = [];
      for (;;) { const n = io.r.BS(); if (!n) break; const app = io.r.H(); const b = []; for (let i = 0; i < n; i++) b.push(io.r.RC()); o.eed.push({ app, b }); }
    } else {
      for (const e of o.eed || []) { io.w.BS(e.b.length); io.w.H(e.app.code, e.app.value); for (const x of e.b) io.w.RC(x); }
      io.w.BS(0);
    }
    if (spec.entity) {
      io.f(o, "preview_exists", "B");
      if (o.preview_exists) throw new Error("entity preview not supported");
      io.f(o, "entmode", "BB"); io.f(o, "num_reactors", "BL"); io.f(o, "nolinks", "B");
      io.f(o, "color", "BS"); io.f(o, "ltype_scale", "BD"); io.f(o, "ltype_flags", "BB"); io.f(o, "plotstyle_flags", "BB");
      io.f(o, "invisible", "BS"); io.f(o, "linewt", "RC");
    } else io.f(o, "num_reactors", "BL");
    if (spec.table) { io.f(o, "name", "TV"); io.f(o, "xref_ref", "B"); io.f(o, "xref_index", "BS"); io.f(o, "xref_dep", "B"); }
    if (spec.rawData) {   // data kept as is (only the handles change)
      if (io.r) { o.dataBits = [io.r.u, io.r.pos, start + o.bitsize]; io.r.pos = start + o.bitsize; }
      else io.w.copyBits(...o.dataBits);
    } else spec.data(io, o);
    // handle references
    if (io.r) io.r.pos = start + o.bitsize;
    else io.w.putRL(bsPos, io.w.pos - start);
    if (spec.entity) {
      if (o.entmode === 0) io.f(o, "owner", "H");
      hlist(io, o, "reactors", o.num_reactors);
      io.f(o, "xdic", "H");
      if (!o.nolinks) { io.f(o, "prev", "H"); io.f(o, "next", "H"); }
      io.f(o, "layer", "H");
      if (o.ltype_flags === 3) io.f(o, "ltype", "H");
      if (o.plotstyle_flags === 3) io.f(o, "plotstyle", "H");
    } else {
      io.f(o, "owner", "H");
      hlist(io, o, "reactors", o.num_reactors);
      io.f(o, "xdic", "H");
    }
    if (spec.table) io.f(o, "xref", "H");
    if (spec.handles) spec.handles(io, o);
    if (io.w) while (io.w.pos & 7) io.w.B(1);     // AutoCAD pads with ones
  }
  function hlist(io, o, k, n) {
    if (io.r) { o[k] = []; for (let i = 0; i < n; i++) o[k].push(io.r.H()); }
    else for (const h of o[k] || []) io.w.H(h.code, h.value);
  }
  // Object bytes: MS size, data, CRC over both.
  function encodeObject(o, spec) {
    const w = new BitWriter();
    codec(new IO(w), o, spec);
    const data = w.bytes(), n = data.length;
    const ms = n < 0x8000 ? [n & 0xFF, n >> 8] : [n & 0xFF, ((n >> 8) & 0x7F) | 0x80, (n >> 15) & 0xFF, (n >> 23) & 0xFF];
    const u = new Uint8Array(ms.length + n + 2);
    u.set(ms, 0); u.set(data, ms.length);
    le(u).setUint16(ms.length + n, crc16(0xC0C1, u, 0, ms.length + n), true);
    return u;
  }
  function decodeObject(u8, addr, spec) {
    const r = new BitReader(u8, addr); r.MS();
    const o = {}; codec(new IO(r), o, spec); return o;
  }

  // ---------- the object types this writer needs ----------
  const SPEC = {
    CONTROL: { data(io, o) { io.f(o, "num_entries", "BS"); },
      handles(io, o) {
        hlist(io, o, "entries", o.num_entries);
        if (o.type === 56) { io.f(o, "byblock", "H"); io.f(o, "bylayer", "H"); }            // LTYPE_CONTROL
        if (o.type === 48) { io.f(o, "mspace", "H"); io.f(o, "pspace", "H"); }              // BLOCK_CONTROL
      } },
    LAYER: { table: true,
      data(io, o) { io.f(o, "flags", "BS"); io.f(o, "color", "BS"); },
      handles(io, o) { io.f(o, "plotstyle", "H"); io.f(o, "ltype", "H"); } },
    LTYPE: { table: true,
      data(io, o) {
        io.f(o, "description", "TV"); io.f(o, "pattern_len", "BD"); io.f(o, "alignment", "RC"); io.f(o, "numdashes", "RC");
        if (io.r) o.dashes = [];
        for (let i = 0; i < o.numdashes; i++) {
          const d = io.r ? (o.dashes[i] = {}) : o.dashes[i];
          io.f(d, "length", "BD"); io.f(d, "shapecode", "BS"); io.f(d, "x", "RD"); io.f(d, "y", "RD");
          io.f(d, "scale", "BD"); io.f(d, "rotation", "BD"); io.f(d, "shape_flag", "BS");
        }
        if (io.r) { o.strings = []; for (let i = 0; i < 256; i++) o.strings.push(io.r.RC()); }
        else for (let i = 0; i < 256; i++) io.w.RC(o.strings ? o.strings[i] : 0);
      },
      handles(io, o) { for (const d of o.dashes) io.f(d, "style", "H"); } },
    BLOCK_HEADER: { table: true, rawData: true,
      handles(io, o) {
        io.f(o, "block_entity", "H"); io.f(o, "first", "H"); io.f(o, "last", "H");
        io.f(o, "endblk", "H"); io.f(o, "layout", "H");
      } },
    LINE: { entity: true,
      data(io, o) {
        io.f(o, "z_is_zero", "B");
        io.f(o, "x0", "RD"); io.f(o, "x1", "DD", o.x0); io.f(o, "y0", "RD"); io.f(o, "y1", "DD", o.y0);
        if (!o.z_is_zero) { io.f(o, "z0", "RD"); io.f(o, "z1", "DD", o.z0); }
        io.f(o, "thickness", "BT"); io.f(o, "extrusion", "BE");
      } },
    LWPOLYLINE: { entity: true,
      data(io, o) {
        io.f(o, "flag", "BS");
        if (o.flag & 4) io.f(o, "const_width", "BD");
        if (o.flag & 8) io.f(o, "elevation", "BD");
        if (o.flag & 2) io.f(o, "thickness", "BD");
        if (o.flag & 1) io.f(o, "normal", "3BD");
        if (io.r) o.n = io.r.BL(); else io.w.BL(o.pts.length);
        if (o.flag & 16) io.f(o, "num_bulges", "BL");
        if (o.flag & 32) io.f(o, "num_widths", "BL");
        if (io.r) {
          o.pts = []; o.$dd = [];
          for (let i = 0; i < o.n; i++) {
            if (i === 0) o.pts.push([io.r.RD(), io.r.RD()]);
            else { const q = {}; const p = o.pts[i - 1]; io.f(q, "x", "DD", p[0]); io.f(q, "y", "DD", p[1]); o.pts.push([q.x, q.y]); o.$dd.push(q); }
          }
        } else {
          o.pts.forEach((pt, i) => {
            if (i === 0) { io.w.RD(pt[0]); io.w.RD(pt[1]); }
            else { const q = Object.assign({}, (o.$dd || [])[i - 1], { x: pt[0], y: pt[1] }); const p = o.pts[i - 1]; io.f(q, "x", "DD", p[0]); io.f(q, "y", "DD", p[1]); }
          });
        }
        if (o.flag & 16) { if (io.r) { o.bulges = []; for (let i = 0; i < o.num_bulges; i++) o.bulges.push(io.r.BD()); } else for (const b of o.bulges) io.w.BD(b); }
        if (o.flag & 32) { if (io.r) { o.widths = []; for (let i = 0; i < o.num_widths; i++) o.widths.push([io.r.BD(), io.r.BD()]); } else for (const b of o.widths) { io.w.BD(b[0]); io.w.BD(b[1]); } }
      } },
    TEXT: { entity: true,
      data(io, o) {
        io.f(o, "df", "RC");
        if (!(o.df & 1)) io.f(o, "elevation", "RD");
        io.f(o, "ins", "2RD");
        if (!(o.df & 2)) { const q = o.$al || (o.$al = {}); if (io.w) { q.x = o.align[0]; q.y = o.align[1]; } io.f(q, "x", "DD", o.ins[0]); io.f(q, "y", "DD", o.ins[1]); if (io.r) o.align = [q.x, q.y]; }
        io.f(o, "extrusion", "BE"); io.f(o, "thickness", "BT");
        if (!(o.df & 4)) io.f(o, "oblique", "RD");
        if (!(o.df & 8)) io.f(o, "rotation", "RD");
        io.f(o, "height", "RD");
        if (!(o.df & 16)) io.f(o, "width_factor", "RD");
        io.f(o, "text", "TV");
        if (!(o.df & 32)) io.f(o, "generation", "BS");
        if (!(o.df & 64)) io.f(o, "halign", "BS");
        if (!(o.df & 128)) io.f(o, "valign", "BS");
      },
      handles(io, o) { io.f(o, "style", "H"); } },
  };

  SPEC.VPORT = { table: true,
    data(io, o) {
      for (const [k, t] of [["VIEWSIZE", "BD"], ["view_width", "BD"], ["VIEWCTR", "2RD"], ["view_target", "3BD"], ["VIEWDIR", "3BD"],
        ["view_twist", "BD"], ["lens_length", "BD"], ["front_clip", "BD"], ["back_clip", "BD"], ["VIEWMODE", "4B"], ["render_mode", "RC"],
        ["lower_left", "2RD"], ["upper_right", "2RD"], ["UCSFOLLOW", "B"], ["circle_zoom", "BS"], ["FASTZOOM", "B"], ["UCSICON", "BB"],
        ["GRIDMODE", "B"], ["GRIDUNIT", "2RD"], ["SNAPMODE", "B"], ["SNAPSTYLE", "B"], ["SNAPISOPAIR", "BS"], ["SNAPANG", "BD"],
        ["SNAPBASE", "2RD"], ["SNAPUNIT", "2RD"], ["ucs_at_origin", "B"], ["UCSVP", "B"], ["ucsorg", "3BD"], ["ucsxdir", "3BD"],
        ["ucsydir", "3BD"], ["ucs_elevation", "BD"], ["UCSORTHOVIEW", "BS"]]) io.f(o, k, t);
    },
    handles(io, o) { io.f(o, "named_ucs", "H"); io.f(o, "base_ucs", "H"); } };

  // ---------- header variables (field list of the AutoCAD 2000 template) ----------
  const HDR = "unit1_ratio:BD,unit2_ratio:BD,unit3_ratio:BD,unit4_ratio:BD,unit1_name:TV,unit2_name:TV,unit3_name:TV,unit4_name:TV,unknown_8:BL,unknown_9:BL,VX_TABLE_RECORD:H,DIMASO:B,DIMSHO:B,PLINEGEN:B,ORTHOMODE:B,REGENMODE:B,FILLMODE:B,QTEXTMODE:B,PSLTSCALE:B,LIMCHECK:B,USRTIMER:B,SKPOLY:B,ANGDIR:B,SPLFRAME:B,MIRRTEXT:B,WORLDVIEW:B,TILEMODE:B,PLIMCHECK:B,VISRETAIN:B,DISPSILH:B,PELLIPSE:B,PROXYGRAPHICS:BS,TREEDEPTH:BS,LUNITS:BS,LUPREC:BS,AUNITS:BS,AUPREC:BS,ATTMODE:BS,PDMODE:BS,USERI1:BS,USERI2:BS,USERI3:BS,USERI4:BS,USERI5:BS,SPLINESEGS:BS,SURFU:BS,SURFV:BS,SURFTYPE:BS,SURFTAB1:BS,SURFTAB2:BS,SPLINETYPE:BS,SHADEDGE:BS,SHADEDIF:BS,UNITMODE:BS,MAXACTVP:BS,ISOLINES:BS,CMLJUST:BS,TEXTQLTY:BS,LTSCALE:BD,TEXTSIZE:BD,TRACEWID:BD,SKETCHINC:BD,FILLETRAD:BD,THICKNESS:BD,ANGBASE:BD,PDSIZE:BD,PLINEWID:BD,USERR1:BD,USERR2:BD,USERR3:BD,USERR4:BD,USERR5:BD,CHAMFERA:BD,CHAMFERB:BD,CHAMFERC:BD,CHAMFERD:BD,FACETRES:BD,CMLSCALE:BD,CELTSCALE:BD,MENU:TV,TDUCREATE:TIMEBLL,TDUUPDATE:TIMEBLL,TDINDWG:TIMEBLL,TDUSRTIMER:TIMEBLL,CECOLOR:BS,HANDSEED:H,CLAYER:H,TEXTSTYLE:H,CELTYPE:H,DIMSTYLE:H,CMLSTYLE:H,PSVPSCALE:BD,PINSBASE:3BD,PEXTMIN:3BD,PEXTMAX:3BD,PLIMMIN:2RD,PLIMMAX:2RD,PELEVATION:BD,PUCSORG:3BD,PUCSXDIR:3BD,PUCSYDIR:3BD,PUCSNAME:H,PUCSORTHOREF:H,PUCSORTHOVIEW:BS,PUCSBASE:H,PUCSORGTOP:3BD,PUCSORGBOTTOM:3BD,PUCSORGLEFT:3BD,PUCSORGRIGHT:3BD,PUCSORGFRONT:3BD,PUCSORGBACK:3BD,INSBASE:3BD,EXTMIN:3BD,EXTMAX:3BD,LIMMIN:2RD,LIMMAX:2RD,ELEVATION:BD,UCSORG:3BD,UCSXDIR:3BD,UCSYDIR:3BD,UCSNAME:H,UCSORTHOREF:H,UCSORTHOVIEW:BS,UCSBASE:H,UCSORGTOP:3BD,UCSORGBOTTOM:3BD,UCSORGLEFT:3BD,UCSORGRIGHT:3BD,UCSORGFRONT:3BD,UCSORGBACK:3BD,DIMPOST:TV,DIMAPOST:TV,DIMSCALE:BD,DIMASZ:BD,DIMEXO:BD,DIMDLI:BD,DIMEXE:BD,DIMRND:BD,DIMDLE:BD,DIMTP:BD,DIMTM:BD,DIMTOL:B,DIMLIM:B,DIMTIH:B,DIMTOH:B,DIMSE1:B,DIMSE2:B,DIMTAD:BS,DIMZIN:BS,DIMAZIN:BS,DIMTXT:BD,DIMCEN:BD,DIMTSZ:BD,DIMALTF:BD,DIMLFAC:BD,DIMTVP:BD,DIMTFAC:BD,DIMGAP:BD,DIMALTRND:BD,DIMALT:B,DIMALTD:BS,DIMTOFL:B,DIMSAH:B,DIMTIX:B,DIMSOXD:B,DIMCLRD:BS,DIMCLRE:BS,DIMCLRT:BS,DIMADEC:BS,DIMDEC:BS,DIMTDEC:BS,DIMALTU:BS,DIMALTTD:BS,DIMAUNIT:BS,DIMFRAC:BS,DIMLUNIT:BS,DIMDSEP:BS,DIMTMOVE:BS,DIMJUST:BS,DIMSD1:B,DIMSD2:B,DIMTOLJ:BS,DIMTZIN:BS,DIMALTZ:BS,DIMALTTZ:BS,DIMUPT:B,DIMATFIT:BS,DIMTXSTY:H,DIMLDRBLK:H,DIMBLK:H,DIMBLK1:H,DIMBLK2:H,DIMLWD:BS,DIMLWE:BS,BLOCK_CONTROL_OBJECT:H,LAYER_CONTROL_OBJECT:H,STYLE_CONTROL_OBJECT:H,LTYPE_CONTROL_OBJECT:H,VIEW_CONTROL_OBJECT:H,UCS_CONTROL_OBJECT:H,VPORT_CONTROL_OBJECT:H,APPID_CONTROL_OBJECT:H,DIMSTYLE_CONTROL_OBJECT:H,VX_CONTROL_OBJECT:H,DICTIONARY_ACAD_GROUP:H,DICTIONARY_ACAD_MLINESTYLE:H,DICTIONARY_NAMED_OBJECT:H,TSTACKALIGN:BS,TSTACKSIZE:BS,HYPERLINKBASE:TV,STYLESHEET:TV,DICTIONARY_LAYOUT:H,DICTIONARY_PLOTSETTINGS:H,DICTIONARY_PLOTSTYLENAME:H,FLAGS:BL,INSUNITS:BS,CEPSNTYPE:BS,FINGERPRINTGUID:TV,VERSIONGUID:TV,BLOCK_RECORD_PSPACE:H,BLOCK_RECORD_MSPACE:H,LTYPE_BYLAYER:H,LTYPE_BYBLOCK:H,LTYPE_CONTINUOUS:H,unknown_54:BS,unknown_55:BS,unknown_56:BS,unknown_57:BS".split(",").map(x => x.split(":"));
  function readHeader(T) {
    const r = new BitReader(T.hdrData, 0), v = {};
    for (const [k, t] of HDR) v[k] = new IO(r).read(t, v, k);
    if (r.pos > T.hdrBits) throw new Error("header overrun");
    return v;
  }
  function writeHeader(v) {
    const w = new BitWriter(), io = new IO(w);
    for (const [k, t] of HDR) io.write(t, v[k], v, k);
    return { bits: w.bytes(), len: w.pos };
  }


  // ---------- building a drawing ----------
  // pages: from PDF2DXF.extractPage; opts: { unit: "in"|"mm", scale, text }
  function build(templateU8, pages, opts) {
    opts = opts || {};
    const aci = (root.PDF2DXF && root.PDF2DXF.aci) || (() => 7);
    const T = parseTemplate(templateU8);
    const hv = readHeader(T);
    const u8 = T.u8;
    const dec = (h, spec) => decodeObject(u8, T.byHandle.get(h).addr, spec);
    const msH = hv.BLOCK_RECORD_MSPACE.value;
    const ms = dec(msH, SPEC.BLOCK_HEADER);
    const layerCtlH = hv.LAYER_CONTROL_OBJECT.value, ltypeCtlH = hv.LTYPE_CONTROL_OBJECT.value;
    const layerCtl = dec(layerCtlH, SPEC.CONTROL), ltypeCtl = dec(ltypeCtlH, SPEC.CONTROL);
    const layer0 = dec(layerCtl.entries[0].value, SPEC.LAYER);
    const contH = hv.LTYPE_CONTINUOUS.value;
    const cont = dec(contH, SPEC.LTYPE);
    const styleH = hv.TEXTSTYLE.value;
    const vpH = (() => { for (const o of T.objects) if (o.type === 65) return o.handle; return 0; })();
    const vp = dec(vpH, SPEC.VPORT);
    // the template's own model space entities are dropped
    const drop = new Set();
    if (ms.first.value) { drop.add(ms.first.value); drop.add(ms.last.value); }

    let next = hv.HANDSEED.value;
    const out = new Map();            // handle -> bytes (replaced or new objects)
    const fresh = [];                 // new objects, in handle order

    // layers
    const LAYERS = [["PDF_LINES", 7], ["PDF_FILL", 8], ["PDF_TEXT", 7]];
    const layerH = {};
    for (const [name, color] of LAYERS) {
      const h = next++;
      const o = Object.assign({}, layer0, { handle: H(0, h), eed: [], num_reactors: 0, reactors: [], name, color,
        owner: H(4, layerCtlH), xdic: H(3, 0), xref: H(5, 0), ltype: H(5, contH), plotstyle: layer0.plotstyle });
      layerH[name] = h;
      fresh.push([h, encodeObject(o, SPEC.LAYER)]);
      layerCtl.entries.push(H(2, h));
    }
    layerCtl.num_entries = layerCtl.entries.length;
    out.set(layerCtlH, encodeObject(layerCtl, SPEC.CONTROL));

    // geometry, in drawing units
    const unitF = opts.unit === "mm" ? 25.4 / 72 : 1 / 72;
    const k = unitF * (opts.scale > 0 ? opts.scale : 1);
    const gap = 0.5 * 72;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const ext = (x, y) => { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; };

    // linetypes for the dash patterns that occur
    const ltypes = new Map();
    const ltypeOf = (dash) => {
      if (!dash || !dash.length) return 0;
      let pat = dash.length % 2 ? dash.concat(dash) : dash.slice();
      pat = pat.map(v => Math.max(v * k, 0));
      if (pat.every(v => v === 0)) return 0;
      const key = pat.map(v => v.toFixed(6)).join(",");
      if (!ltypes.has(key)) {
        const h = next++, name = "PDFDASH" + (ltypes.size + 1);
        const total = pat.reduce((s, v) => s + v, 0);
        const o = Object.assign({}, cont, { handle: H(0, h), eed: [], num_reactors: 0, reactors: [], name,
          description: "From PDF", pattern_len: total, alignment: 0x41, numdashes: pat.length,
          dashes: pat.map((v, i) => ({ length: i % 2 ? -v : v, shapecode: 0, x: 0, y: 0, scale: 1, rotation: 0, shape_flag: 0, style: H(5, 0) })),
          strings: null, owner: H(4, ltypeCtlH), xdic: H(3, 0), xref: H(5, 0) });
        fresh.push([h, encodeObject(o, SPEC.LTYPE)]);
        ltypeCtl.entries.push(H(2, h));
        ltypes.set(key, h);
      }
      return ltypes.get(key);
    };

    // entities: written after all table records so their handles run in drawing order
    const ents = [];
    let ox = 0;
    const counts = { lines: 0, polylines: 0, fills: 0, texts: 0 };
    for (const pg of pages) {
      const X = (x) => (x + ox) * k, Y = (y) => y * k;
      for (const p of pg.paths) {
        const layer = p.fill && !p.stroke ? "PDF_FILL" : "PDF_LINES";
        const lt = p.stroke ? ltypeOf(p.dash) : 0;
        const pts = p.pts.map(q => [X(q[0]), Y(q[1])]);
        for (const q of pts) ext(q[0], q[1]);
        const base = { layer: layerH[layer], color: aci(p.stroke || p.fill), lt };
        if (pts.length === 2 && !p.closed) { ents.push(Object.assign(base, { kind: "LINE", pts })); counts.lines++; }
        else { ents.push(Object.assign(base, { kind: "LWPOLYLINE", pts, closed: p.closed })); if (layer === "PDF_FILL") counts.fills++; else counts.polylines++; }
      }
      if (opts.text !== false) for (const t of pg.texts) {
        const x = X(t.x), y = Y(t.y), h = t.h * k;
        ext(x, y); ext(x + (t.w || 0) * k, y + h);
        ents.push({ kind: "TEXT", layer: layerH.PDF_TEXT, color: 7, lt: 0, x, y, h, rot: (t.rot || 0) * Math.PI / 180, s: t.s });
        counts.texts++;
      }
      ox += pg.width + gap;
    }
    ltypeCtl.num_entries = ltypeCtl.entries.length;
    out.set(ltypeCtlH, encodeObject(ltypeCtl, SPEC.CONTROL));

    const first = next;
    ents.forEach((e, i) => {
      const h = next++;
      const common = { handle: H(0, h), eed: [], preview_exists: 0, entmode: 2, num_reactors: 0, reactors: [], nolinks: 0,
        color: e.color, ltype_scale: 1, ltype_flags: e.lt ? 3 : 0, plotstyle_flags: 0, invisible: 0, linewt: 0x1D,
        xdic: H(3, 0), prev: H(4, i ? h - 1 : 0), next: H(4, i < ents.length - 1 ? h + 1 : 0), layer: H(5, e.layer) };
      if (e.lt) common.ltype = H(5, e.lt);
      let o, spec;
      if (e.kind === "LINE") {
        spec = SPEC.LINE;
        o = Object.assign(common, { type: 19, z_is_zero: 1, x0: e.pts[0][0], y0: e.pts[0][1], x1: e.pts[1][0], y1: e.pts[1][1], thickness: 0, extrusion: [0, 0, 1] });
      } else if (e.kind === "LWPOLYLINE") {
        spec = SPEC.LWPOLYLINE;
        o = Object.assign(common, { type: 77, flag: e.closed ? 512 : 0, pts: e.pts });
      } else {
        spec = SPEC.TEXT;
        let df = 1 | 2 | 4 | 16 | 32 | 64 | 128;
        if (!e.rot) df |= 8;
        o = Object.assign(common, { type: 1, df, ins: [e.x, e.y], extrusion: [0, 0, 1], thickness: 0, rotation: e.rot, height: e.h, text: e.s, style: H(5, styleH) });
      }
      fresh.push([h, encodeObject(o, spec)]);
    });
    const last = next - 1;
    ms.first = H(4, ents.length ? first : 0); ms.last = H(4, ents.length ? last : 0);
    out.set(msH, encodeObject(ms, SPEC.BLOCK_HEADER));

    // extents, units, and the view the drawing opens with
    if (!Number.isFinite(minx)) { minx = miny = 0; maxx = maxy = 1; }
    const w = maxx - minx, hgt = maxy - miny;
    const aspect = vp.view_width / vp.VIEWSIZE || 1.5;
    vp.VIEWSIZE = Math.max(hgt, w / aspect, 1e-6) * 1.04;
    vp.view_width = vp.VIEWSIZE * aspect;
    vp.VIEWCTR = [(minx + maxx) / 2, (miny + maxy) / 2];
    out.set(vpH, encodeObject(vp, SPEC.VPORT));

    hv.HANDSEED = H(0, next);
    hv.EXTMIN = [minx, miny, 0]; hv.EXTMAX = [maxx, maxy, 0];
    hv.LIMMIN = [minx, miny]; hv.LIMMAX = [maxx, maxy];
    hv.INSUNITS = opts.unit === "mm" ? 4 : 1;
    const now = new Date(), jd = now.getTime() / 86400000 + 2440587.5, day = Math.floor(jd);
    const stamp = [day, Math.round((jd - day) * 86400000)];
    hv.TDUCREATE = stamp; hv.TDUUPDATE = stamp; hv.TDINDWG = [0, 0]; hv.TDUSRTIMER = [0, 0];
    const hdr = writeHeader(hv);
    const tmpl = T.template.slice(); le(tmpl).setUint16(tmpl.length - 2, opts.unit === "mm" ? 1 : 0, true);   // MEASUREMENT

    // objects: the template's (some replaced), then the new ones
    const objects = [];
    for (const o of T.objects.slice().sort((a, b) => a.addr - b.addr)) {
      if (drop.has(o.handle)) continue;
      objects.push({ handle: o.handle, bytes: out.get(o.handle) || o.raw });
    }
    for (const [h, bytes] of fresh) objects.push({ handle: h, bytes });
    const bytes = writeFile(T, objects, hdr.bits, hdr.len, next, { template: tmpl });
    return { bytes, counts, extents: [minx, miny, maxx, maxy] };
  }

  // ---------- writing the file ----------
  // objects: [{ handle, bytes: Uint8Array (MS + data + CRC) }]
  function writeFile(T, objects, hdrBits, hdrBitLen, handseed, opts) {
    const out = []; let len = 0;
    const push = (u) => { out.push(u); len += u.length; };
    const sec = [];
    // file header placeholder (0x00 .. after the locators and sentinel)
    const nsec = 6, fhLen = 0x19 + nsec * 9 + 2 + 16;
    push(new Uint8Array(fhLen));
    // aux header (copy with the new handseed)
    const aux = T.aux.slice();
    patchAuxHandseed(aux, handseed);
    sec[5] = { addr: len, size: aux.length }; push(aux);
    // thumbnail: an empty one (no picture)
    const thumbAddr = len;
    const th = new Uint8Array(16 + 5 + 16);
    th.set(T.sentThumbBegin, 0); le(th).setUint32(16, 5, true); th[20] = 0; th.set(T.sentThumbEnd, 21);
    push(opts && opts.keepThumb ? T.thumb : th);
    // header variables
    {
      const nbytes = (hdrBitLen + 7) >> 3;
      const b = new Uint8Array(16 + 4 + nbytes + 2 + 16);
      b.set(T.sentHdrBegin, 0); le(b).setUint32(16, nbytes, true); b.set(hdrBits.slice(0, nbytes), 20);
      le(b).setUint16(20 + nbytes, crc16(0xC0C1, b, 16, 20 + nbytes), true);
      b.set(T.sentHdrEnd, 22 + nbytes);
      sec[0] = { addr: len, size: b.length }; push(b);
    }
    // classes (unchanged)
    sec[1] = { addr: len, size: T.classes.length }; push(T.classes);
    push(Uint8Array.of(0xCA, 0x0D, 0, 0));      // RL 0x0DCA before the objects, as AutoCAD writes it
    // objects
    const omap = [];
    for (const o of objects) { omap.push({ handle: o.handle, addr: len }); push(o.bytes); }
    // object map
    {
      omap.sort((a, b) => a.handle - b.handle);
      const bytes = []; let page = [], lh = 0, la = 0;
      const flush = () => {
        const size = page.length + 2;
        const p = [size >> 8, size & 0xFF, ...page];
        const c = crc16(0xC0C1, Uint8Array.from(p), 0, p.length);
        bytes.push(...p, c >> 8, c & 0xFF);
        page = []; lh = 0; la = 0;
      };
      for (const e of omap) {
        UMC(page, e.handle - lh); MC(page, e.addr - la); lh = e.handle; la = e.addr;
        if (page.length > 2030 - 2) flush();
      }
      if (page.length) flush();
      bytes.push(0, 2); const c = crc16(0xC0C1, Uint8Array.from([0, 2]), 0, 2); bytes.push(c >> 8, c & 0xFF);
      sec[2] = { addr: len, size: bytes.length }; push(Uint8Array.from(bytes));
    }
    sec[3] = { addr: 0, size: 0 };
    // second header
    const s2Addr = len;
    sec[4] = { addr: 0, size: 0 };   // placeholder, fixed below
    const s2 = secondHeader(T, sec, s2Addr, handseed);
    push(s2);
    sec[4] = { addr: len, size: T.template.length }; push(opts && opts.template ? opts.template : T.template);
    // file header
    const all = new Uint8Array(len); let p = 0; for (const u of out) { all.set(u, p); p += u.length; }
    all.set(T.fileHead, 0);
    const dv = le(all);
    dv.setUint32(0x0D, thumbAddr, true);
    dv.setUint32(0x15, nsec, true);
    for (let i = 0; i < nsec; i++) { const q = 0x19 + i * 9; all[q] = i; dv.setUint32(q + 1, sec[i].addr, true); dv.setUint32(q + 5, sec[i].size, true); }
    const cpos = 0x19 + nsec * 9;
    dv.setUint16(cpos, crc16(0xC0C1, all, 0, cpos), true);
    all.set(T.sentinelFileEnd, cpos + 2);
    // the second header repeats the section table: write it now that the addresses are known
    all.set(secondHeader(T, sec, s2Addr, handseed), s2Addr);
    return all;
  }

  function patchAuxHandseed(aux, handseed) {
    // ff 77 01, RS, RS, RL, RL, RS, RS, RL, RS, RS, RS, RS, 6 RS, 5 RL, 2 x (RL,RL), RL HANDSEED
    const off = 3 + 2 + 2 + 4 + 4 + 2 + 2 + 4 + 2 + 2 + 2 + 2 + 12 + 20 + 16;
    le(aux).setUint32(off, handseed, true);
  }

  function secondHeader(T, sec, addr, handseed) {
    // sentinel, RL size (of everything between the sentinels), bit-coded fields, RS crc, 8 bytes, sentinel
    const w = new BitWriter();
    w.RL(0);                                    // size, patched below
    w.BL(addr);
    for (const c of "AC1015") w.RC(c.charCodeAt(0));
    for (let i = 0; i < 5; i++) w.RC(0);
    w.RC(T.u8[0x0B]); w.RC(T.u8[0x0C]);         // is_maint, zero_one_or_three
    w.BS(T.u8[0x12] << 8 | T.u8[0x11]);         // dwg version and maintenance version
    w.RS(T.u8[0x13] | (T.u8[0x14] << 8));       // codepage
    w.BS(6);
    for (let i = 0; i < 6; i++) { const z = i === 3 || i === 4 || !sec[i]; w.RC(i); w.BL(z ? 0 : sec[i].addr); w.BL(z ? 0 : sec[i].size); }   // AutoCAD leaves 3 and 4 empty here
    w.BS(14);
    for (let i = 0; i < 14; i++) {
      const v = i === 0 ? handseed : T.secondHandles[i];
      const b = []; let x = v; while (x > 0) { b.unshift(x % 256); x = Math.floor(x / 256); }
      w.RC(b.length); w.RC(i); for (const y of b) w.RC(y);
    }
    const body = w.bytes();
    const n = 16 + body.length + 2 + 8 + 16;
    const u = new Uint8Array(n);
    u.set(T.sent2Begin, 0);
    u.set(body, 16);
    le(u).setUint32(16, n - 32, true);
    le(u).setUint16(16 + body.length, crc16(0xC0C1, u, 16, 16 + body.length), true);
    u.set(T.junk2, 16 + body.length + 2);
    u.set(T.sent2End, n - 16);
    return u;
  }

  const api = { BitReader, BitWriter, IO, H, crc16, parseTemplate, writeFile, MC, UMC, readMC, readUMC, SPEC, encodeObject, decodeObject, readHeader, writeHeader, build };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PDF2DWG = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
