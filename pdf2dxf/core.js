// PDF -> DXF core: reads the vector content of PDF pages with pdf.js and writes it as DXF.
//
//   const pages = await PDF2DXF.extractPage(pdfjsLib, page)   (one per page)
//   const dxf = PDF2DXF.toDxf(pageData, { unit: "in" | "mm" | "pt", scale: 1 })
//
// What comes across: straight and curved line work (curves are flattened into short segments),
// filled areas (as closed outlines on their own layer), dashed lines (as linetypes), line colors,
// and text (as TEXT, from the PDF's text layer). Images and shadings are not converted.
// The DXF is AutoCAD R12 (AC1009): every CAD program opens it, and AutoCAD can save it as DWG.
(function (root) {
  "use strict";

  // ---------- geometry helpers ----------
  const mul = (m, n) => [ // m then n (pdf.js / PDF matrix order: [a b c d e f])
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

  function bezier(out, p0, p1, p2, p3, tol) {
    // Flatten a cubic Bezier into enough segments to stay within roughly `tol` of the curve.
    const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(d / tol))));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]]);
    }
  }

  // ---------- clipping (to an axis-aligned box: the page, or the bounding box of a clip path) ----------
  // An open line: the parts inside the box, as separate pieces (Liang-Barsky per segment).
  function clipLine(pts, b) {
    const out = []; let cur = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], dx = x1 - x0, dy = y1 - y0;
      let t0 = 0, t1 = 1, ok = true;
      for (const [p, q] of [[-dx, x0 - b[0]], [dx, b[2] - x0], [-dy, y0 - b[1]], [dy, b[3] - y0]]) {
        if (p === 0) { if (q < 0) { ok = false; break; } continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
      if (!ok) { cur = null; continue; }
      const a = [x0 + t0 * dx, y0 + t0 * dy], c = [x0 + t1 * dx, y0 + t1 * dy];
      if (cur && t0 === 0) cur.push(c);
      else { cur = [a, c]; out.push(cur); }
      if (t1 < 1) cur = null;
    }
    return out;
  }
  // A closed area: Sutherland-Hodgman against the four sides.
  function clipPoly(pts, b) {
    let poly = pts;
    const edges = [[p => p[0] >= b[0], (p, q) => { const t = (b[0] - p[0]) / (q[0] - p[0]); return [b[0], p[1] + t * (q[1] - p[1])]; }],
      [p => p[0] <= b[2], (p, q) => { const t = (b[2] - p[0]) / (q[0] - p[0]); return [b[2], p[1] + t * (q[1] - p[1])]; }],
      [p => p[1] >= b[1], (p, q) => { const t = (b[1] - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), b[1]]; }],
      [p => p[1] <= b[3], (p, q) => { const t = (b[3] - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), b[3]]; }]];
    for (const [inside, cut] of edges) {
      if (!poly.length) break;
      const res = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length], pi = inside(p), qi = inside(q);
        if (pi) res.push(p);
        if (pi !== qi) res.push(cut(p, q));
      }
      poly = res;
    }
    return poly;
  }
  const bboxOf = (pts) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; };
  const inBox = (bb, b) => bb[0] >= b[0] && bb[1] >= b[1] && bb[2] <= b[2] && bb[3] <= b[3];
  const meet = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

  // ---------- extraction ----------
  async function extractPage(pdfjsLib, page, opts) {
    opts = opts || {};
    const OPS = pdfjsLib.OPS;
    const vp = page.getViewport({ scale: 1 });
    // Viewport transform (handles page rotation; y down), then flip so y goes up as in CAD.
    const flip = [1, 0, 0, -1, 0, vp.height];
    const base = mul(vp.transform, flip);
    const ops = await page.getOperatorList();
    const fn = ops.fnArray, args = ops.argsArray;

    const paths = [];    // { pts, closed, stroke, fill, lw, dash }
    // Everything outside the page, or outside a clip region, is cut off as a PDF viewer would.
    const pageBox = [0, 0, vp.width, vp.height];
    let st = { ctm: base, stroke: [0, 0, 0], fill: [0, 0, 0], lw: 1, dash: null, clip: pageBox };
    let pendingClip = false;
    const stack = [];
    let sub = [], cur = null, subs = [];
    const tol = 0.15; // points
    let images = 0;   // pictures on the page (scans, photos): they carry no line work

    const startSub = (p) => { if (sub.length > 1) subs.push({ pts: sub, closed: false }); sub = [p]; cur = p; };
    const lineTo = (p) => { if (!sub.length) sub = [cur || p]; sub.push(p); cur = p; };
    const flush = (stroke, fill, closeAll) => {
      if (sub.length > 1) subs.push({ pts: sub, closed: false });
      // White on white paper is invisible: masks and background boxes. In CAD they would be
      // drawn (white shows as black), so they are left out.
      const white = (c) => c && c[0] >= 250 && c[1] >= 250 && c[2] >= 250;
      if (stroke && white(st.stroke)) stroke = false;
      if (fill && white(st.fill)) fill = false;
      if (pendingClip) {
        // A clip path: keep its bounding box (exact for the usual rectangular viewports and frames).
        const all = [];
        for (const s of subs) for (const p of s.pts) all.push(apply(st.ctm, p[0], p[1]));
        if (all.length) st.clip = meet(st.clip, bboxOf(all));
        pendingClip = false;
      }
      if (!stroke && !fill) { subs = []; sub = []; cur = null; return; }
      const box = st.clip, sc = scaleOf(st.ctm);
      if (box[2] <= box[0] || box[3] <= box[1]) { subs = []; sub = []; cur = null; return; }
      const style = {
        stroke: stroke ? st.stroke.slice() : null,
        fill: fill ? st.fill.slice() : null,
        lw: st.lw * sc,
        dash: stroke && st.dash && st.dash[0].length ? st.dash[0].map(v => v * sc) : null,
      };
      for (const s of subs) {
        let closed = s.closed || closeAll || !!fill;
        let pts = s.pts.map(p => apply(st.ctm, p[0], p[1]));
        // Drop a repeated closing point.
        if (pts.length > 2) { const a = pts[0], b = pts[pts.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) { pts.pop(); closed = true; } }
        if (pts.length < 2) continue;
        const bb = bboxOf(pts);
        if (bb[2] < box[0] || bb[0] > box[2] || bb[3] < box[1] || bb[1] > box[3]) continue;   // wholly outside
        if (inBox(bb, box)) { paths.push({ pts, closed, ...style }); continue; }
        if (fill) {
          pts = clipPoly(pts, box);
          if (pts.length > 2) paths.push({ pts, closed: true, ...style });
        } else {
          for (const piece of clipLine(closed ? pts.concat([pts[0]]) : pts, box)) paths.push({ pts: piece, closed: false, ...style });
        }
      }
      subs = []; sub = []; cur = null;
    };
    const rgb = (a) => a && a.length >= 3 ? [a[0] | 0, a[1] | 0, a[2] | 0] : (typeof a === "string" ? hex(a) : [0, 0, 0]);
    const hex = (s) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s || ""); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0]; };

    for (let i = 0; i < fn.length; i++) {
      const f = fn[i], a = args[i];
      switch (f) {
        case OPS.save: stack.push({ ...st, dash: st.dash }); break;
        case OPS.restore: if (stack.length) st = stack.pop(); break;
        case OPS.transform: st.ctm = mul(a, st.ctm); break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ...st });
          if (a && a[0]) st.ctm = mul(a[0], st.ctm);
          break;
        case OPS.paintFormXObjectEnd: if (stack.length) st = stack.pop(); break;
        case OPS.setLineWidth: st.lw = a[0]; break;
        case OPS.setDash: st.dash = a; break;
        case OPS.setGState:
          for (const [k, v] of a[0] || []) { if (k === "LW") st.lw = v; else if (k === "D") st.dash = v; }
          break;
        case OPS.setStrokeRGBColor: st.stroke = a.length === 1 ? rgb(a[0]) : rgb(a); break;
        case OPS.setFillRGBColor: st.fill = a.length === 1 ? rgb(a[0]) : rgb(a); break;
        case OPS.setStrokeGray: st.stroke = [a[0] * 255, a[0] * 255, a[0] * 255].map(v => v | 0); break;
        case OPS.setFillGray: st.fill = [a[0] * 255, a[0] * 255, a[0] * 255].map(v => v | 0); break;
        case OPS.constructPath: {
          const o = a[0], c = a[1];
          let k = 0;
          for (const op of o) {
            if (op === OPS.moveTo) { startSub([c[k], c[k + 1]]); k += 2; }
            else if (op === OPS.lineTo) { lineTo([c[k], c[k + 1]]); k += 2; }
            else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
              const p0 = cur || [0, 0];
              let p1, p2, p3;
              if (op === OPS.curveTo) { p1 = [c[k], c[k + 1]]; p2 = [c[k + 2], c[k + 3]]; p3 = [c[k + 4], c[k + 5]]; k += 6; }
              else if (op === OPS.curveTo2) { p1 = p0; p2 = [c[k], c[k + 1]]; p3 = [c[k + 2], c[k + 3]]; k += 4; }
              else { p1 = [c[k], c[k + 1]]; p2 = [c[k + 2], c[k + 3]]; p3 = p2; k += 4; }
              if (!sub.length) sub = [p0];
              const s = scaleOf(st.ctm), seg = [];
              bezier(seg, p0, p1, p2, p3, tol / s);
              for (const p of seg) sub.push(p);
              cur = p3;
            } else if (op === OPS.closePath) {
              if (sub.length > 1) { subs.push({ pts: sub, closed: true }); cur = sub[0]; sub = []; }
            } else if (op === OPS.rectangle) {
              const x = c[k], y = c[k + 1], w = c[k + 2], h = c[k + 3]; k += 4;
              if (sub.length > 1) subs.push({ pts: sub, closed: false });
              subs.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true });
              sub = []; cur = [x, y];
            }
          }
          break;
        }
        case OPS.stroke: flush(true, false, false); break;
        case OPS.closeStroke: flush(true, false, true); break;
        case OPS.fill: case OPS.eoFill: flush(false, true, true); break;
        case OPS.fillStroke: case OPS.eoFillStroke: flush(true, true, true); break;
        case OPS.closeFillStroke: case OPS.closeEOFillStroke: flush(true, true, true); break;
        case OPS.clip: case OPS.eoClip: pendingClip = true; break;
        case OPS.endPath: flush(false, false, false); break;
        case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject:
        case OPS.paintImageXObjectRepeat: case OPS.paintJpegXObject: images++; break;
        default: break;
      }
    }

    // Text from the PDF's text layer.
    const texts = [];
    if (opts.text !== false) {
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        const s = (it.str || "").replace(/\s+$/, "");
        if (!s.trim()) continue;
        const m = mul(it.transform, base);
        const h = Math.hypot(m[2], m[3]);
        if (!(h > 0)) continue;
        if (m[4] < pageBox[0] || m[4] > pageBox[2] || m[5] < pageBox[1] || m[5] > pageBox[3]) continue;
        // CAD text height is the capital-letter height, about 0.72 of the PDF font size (Arial).
        texts.push({ s, x: m[4], y: m[5], h: h * 0.72, size: h, rot: Math.atan2(m[1], m[0]) * 180 / Math.PI, w: (it.width || 0) * scaleOf(base) });
      }
    }
    return { width: vp.width, height: vp.height, paths, texts, images };
  }

  // ---------- AutoCAD color index ----------
  const ACI = (() => {
    const t = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]];
    const v = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15];
    for (let i = 10; i < 250; i++) {
      const h = ((i - 10) / 10 | 0) * 15, val = v[i % 10], s = i % 2 ? 0.5 : 1;
      const c = val * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = val - c;
      const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      t.push([(r + m) * 255, (g + m) * 255, (b + m) * 255].map(Math.round));
    }
    for (const g of [51, 91, 132, 173, 214, 255]) t.push([g, g, g]);
    return t;
  })();
  function aci(rgb) {
    if (!rgb) return 7;
    const [r, g, b] = rgb;
    // Black and white both become 7 (black on a white background, white on a dark one).
    if (r + g + b < 60 || r + g + b > 735) return 7;
    let best = 7, bd = Infinity;
    for (let i = 1; i < 256; i++) {
      if (i === 7) continue;
      const c = ACI[i], d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------- DXF writer (R12) ----------
  function num(v) { return Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6).toString() : "0"; }
  function dxfText(s) {
    // R12 text: escape non-ASCII as \U+XXXX, which AutoCAD reads in any DXF version.
    let o = "";
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 32) continue;
      o += c < 128 ? ch : c <= 0xFFFF ? "\\U+" + c.toString(16).toUpperCase().padStart(4, "0") : "?";
    }
    return o.replace(/%%/g, "%%%");
  }

  function toDxf(pages, opts) {
    opts = opts || {};
    const unitF = opts.unit === "mm" ? 25.4 / 72 : opts.unit === "pt" ? 1 : 1 / 72;
    const k = unitF * (opts.scale > 0 ? opts.scale : 1);
    const gap = 0.5 * 72; // half an inch between pages laid side by side
    const L = [];
    const w = (code, val) => { L.push(String(code)); L.push(String(val)); };

    // Linetypes for the dash patterns that occur.
    const ltypes = new Map();
    const ltypeOf = (dash) => {
      if (!dash || !dash.length) return null;
      let pat = dash.length % 2 ? dash.concat(dash) : dash.slice();
      pat = pat.map(v => Math.max(v * k, 0));
      if (pat.every(v => v === 0)) return null;
      const key = pat.map(v => num(v)).join(",");
      if (!ltypes.has(key)) ltypes.set(key, { name: "PDFDASH" + (ltypes.size + 1), pat });
      return ltypes.get(key).name;
    };

    // Entities first (to know the linetypes and extents), then assemble.
    const E = [];
    const e = (code, val) => { E.push(String(code)); E.push(String(val)); };
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const P = (x, y) => { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; return [x, y]; };
    let ox = 0;
    const counts = { lines: 0, polylines: 0, fills: 0, texts: 0 };
    for (const pg of pages) {
      const T = (x, y) => P((x + ox) * k, y * k);
      for (const p of pg.paths) {
        const layer = p.fill && !p.stroke ? "PDF_FILL" : "PDF_LINES";
        const color = aci(p.stroke || p.fill);
        const lt = p.stroke ? ltypeOf(p.dash) : null;
        const pts = p.pts.map(q => T(q[0], q[1]));
        if (pts.length === 2 && !p.closed) {
          e(0, "LINE"); e(8, layer); e(62, color); if (lt) e(6, lt);
          e(10, num(pts[0][0])); e(20, num(pts[0][1])); e(30, 0); e(11, num(pts[1][0])); e(21, num(pts[1][1])); e(31, 0);
          counts.lines++;
        } else {
          e(0, "POLYLINE"); e(8, layer); e(62, color); if (lt) e(6, lt); e(66, 1); e(10, 0); e(20, 0); e(30, 0); e(70, p.closed ? 1 : 0);
          for (const q of pts) { e(0, "VERTEX"); e(8, layer); e(10, num(q[0])); e(20, num(q[1])); e(30, 0); }
          e(0, "SEQEND"); e(8, layer);
          if (layer === "PDF_FILL") counts.fills++; else counts.polylines++;
        }
      }
      for (const t of pg.texts) {
        const [x, y] = T(t.x, t.y);
        e(0, "TEXT"); e(8, "PDF_TEXT"); e(62, 7);
        e(10, num(x)); e(20, num(y)); e(30, 0); e(40, num(t.h * k)); e(1, dxfText(t.s));
        if (Math.abs(t.rot) > 1e-6) e(50, num(t.rot));
        e(7, "PDFTEXT");
        counts.texts++;
      }
      ox += pg.width + gap;
    }
    if (!Number.isFinite(minx)) { minx = miny = 0; maxx = maxy = 1; }

    // HEADER
    w(0, "SECTION"); w(2, "HEADER");
    w(9, "$ACADVER"); w(1, "AC1009");
    w(9, "$INSUNITS"); w(70, opts.unit === "mm" ? 4 : opts.unit === "pt" ? 0 : 1);
    w(9, "$EXTMIN"); w(10, num(minx)); w(20, num(miny)); w(30, 0);
    w(9, "$EXTMAX"); w(10, num(maxx)); w(20, num(maxy)); w(30, 0);
    w(9, "$LTSCALE"); w(40, 1);
    w(9, "$PSLTSCALE"); w(70, 0);
    w(0, "ENDSEC");
    // TABLES
    w(0, "SECTION"); w(2, "TABLES");
    w(0, "TABLE"); w(2, "LTYPE"); w(70, ltypes.size + 1);
    w(0, "LTYPE"); w(2, "CONTINUOUS"); w(70, 0); w(3, "Solid line"); w(72, 65); w(73, 0); w(40, 0);
    for (const { name, pat } of ltypes.values()) {
      const total = pat.reduce((s, v) => s + v, 0);
      w(0, "LTYPE"); w(2, name); w(70, 0); w(3, "From PDF"); w(72, 65); w(73, pat.length); w(40, num(total));
      pat.forEach((v, i) => w(49, num(i % 2 ? -v : v)));
    }
    w(0, "ENDTAB");
    w(0, "TABLE"); w(2, "LAYER"); w(70, 4);
    for (const [name, col] of [["0", 7], ["PDF_LINES", 7], ["PDF_FILL", 8], ["PDF_TEXT", 7]]) {
      w(0, "LAYER"); w(2, name); w(70, 0); w(62, col); w(6, "CONTINUOUS");
    }
    w(0, "ENDTAB");
    w(0, "TABLE"); w(2, "STYLE"); w(70, 2);
    w(0, "STYLE"); w(2, "STANDARD"); w(70, 0); w(40, 0); w(41, 1); w(50, 0); w(71, 0); w(42, 2.5); w(3, "txt"); w(4, "");
    w(0, "STYLE"); w(2, "PDFTEXT"); w(70, 0); w(40, 0); w(41, 1); w(50, 0); w(71, 0); w(42, 2.5); w(3, "arial.ttf"); w(4, "");
    w(0, "ENDTAB");
    w(0, "ENDSEC");
    // ENTITIES
    w(0, "SECTION"); w(2, "ENTITIES");
    for (const s of E) L.push(s);
    w(0, "ENDSEC");
    w(0, "EOF");
    return { dxf: L.join("\r\n") + "\r\n", counts, extents: [minx, miny, maxx, maxy] };
  }

  const api = { extractPage, toDxf, aci };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PDF2DXF = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
