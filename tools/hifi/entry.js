// cad2pdf high-fidelity renderer: opens a drawing in the mlightcad viewer
// (hidden) and renders any WCS box into a TILE x TILE canvas. setPass() shows
// either the linework or the text, so the page can thicken lines to the plot
// line weight without smearing text.
import { AcApDocManager, LIBREDWG_PARSER_WORKER_FILE, MTEXT_RENDERER_WORKER_FILE } from '@mlightcad/cad-simple-viewer';
import { AcDbArcAlignedText, AcDbBlockReference, AcDbDatabaseConverterManager, AcDbDimension, AcDbHatch, AcDbLeader, AcDbFileType, AcDbMLeader, AcDbMText, AcDbRenderingCache, AcDbTable, AcDbText } from '@mlightcad/data-model';
import { AcGeArea2d, AcGeBox2d, AcGePoint2d, AcGePolyline2d } from '@mlightcad/geometry-engine';
import polybool from '@velipso/polybool';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';

const TILE = 2048;
let mgr = null, host = null, hook = null;

function setup(opts) {
  if (mgr) return mgr;
  const base = opts.assetBase;
  const dwgParser = base + 'workers/' + LIBREDWG_PARSER_WORKER_FILE;
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG,
    new AcDbLibreDwgConverter({ convertByEntityType: false, useWorker: true, parserWorkerUrl: dwgParser }));
  host = document.createElement('div');
  // Off-screen but laid out, so WebGL keeps a real drawing surface.
  host.style.cssText = `position:fixed;left:-${TILE + 100}px;top:0;width:${TILE}px;height:${TILE}px;overflow:hidden;pointer-events:none;`;
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  mgr = AcApDocManager.createInstance({
    container: host, width: TILE, height: TILE, autoResize: false,
    baseUrl: opts.fontBase,
    webworkerFileUrls: { dwgParser, mtextRender: base + 'workers/' + MTEXT_RENDERER_WORKER_FILE }
  });
  // Copy the canvas right after each WebGL render (drawing buffer is not preserved).
  const r = mgr.curView.renderer;
  const orig = r.render.bind(r);
  r.render = (scene, camera) => {
    const res = orig(scene, camera);
    if (hook) { const h = hook; hook = null; try { h(r.domElement); } catch (e) { console.error(e); } }
    return res;
  };
  return mgr;
}

// ---- Hatches with several boundary loops ----
// AutoCAD fills alternately from the outer loop inwards (even-odd), and leaves a "text box"
// island (a loop drawn around text that cuts across the others) empty. The viewer pairs loops
// by nesting and hands them to a triangulator that drops shapes whose islands touch the outer
// edge (logo bands, crescents), so such fills vanished. Here the loops are combined with
// polygon boolean operations instead: even-odd over the ordinary loops, minus crossing boxes,
// then regrouped into outer loops with holes.
const ptIn = (pt, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
};
const boxOf = (pts) => pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const straddles = (p, q) => {
  let inside = 0, n = 0; const step = Math.max(1, Math.floor(p.length / 64));
  for (let k = 0; k < p.length; k += step) { n++; if (ptIn(p[k], q)) inside++; }
  return inside > 0 && inside < n;
};
function evenOddAreas(loops) {
  const polys = [];
  let total = 0;
  for (const loop of loops) {
    const pts = (loop.tessellate ? loop.tessellate({}) : loop.getPoints(64)).map(p => [p.x, p.y]);
    if (pts.length < 3) return null;
    total += pts.length; polys.push(pts);
  }
  if (polys.length < 2 || polys.length > 60 || total > 30000) return null;
  const boxes = polys.map(boxOf);
  // In each pair of loops that cut across each other, the smaller one is a text box.
  const box = new Set();
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++)
    if (overlaps(boxes[i], boxes[j]) && (straddles(polys[i], polys[j]) || straddles(polys[j], polys[i])))
      box.add(boxArea(boxes[i]) < boxArea(boxes[j]) ? i : j);
  const shape = (pts) => ({ regions: [pts], inverted: false });
  let acc = null;
  polys.forEach((p, i) => { if (!box.has(i)) acc = acc ? polybool.xor(acc, shape(p)) : shape(p); });
  if (!acc) return null;
  box.forEach((i) => { acc = polybool.difference(acc, shape(polys[i])); });
  const regs = acc.regions.filter(r => r.length >= 3);
  if (!regs.length) return [];
  const depth = regs.map((r, i) => regs.reduce((d, o, k) => d + (k !== i && ptIn(r[0], o) ? 1 : 0), 0));
  const toLoop = (r) => new AcGePolyline2d(r.map(p => new AcGePoint2d(p[0], p[1])), true);
  const areas = [];
  regs.forEach((r, i) => {
    if (depth[i] % 2) return;
    const area = new AcGeArea2d();
    area.add(toLoop(r));
    regs.forEach((h, k) => { if (depth[k] === depth[i] + 1 && ptIn(h[0], r)) area.add(toLoop(h)); });
    areas.push(area);
  });
  return areas;
}
const origBuildAreas = AcDbHatch.prototype.buildAreasFromLoops;
AcDbHatch.prototype.buildAreasFromLoops = function () {
  if (this._areasFromLoopsCache != null) return this._areasFromLoopsCache;
  let areas = null;
  try { areas = this._geo && this._geo.loops && this._geo.loops.length > 1 ? evenOddAreas(this._geo.loops) : null; } catch (err) { areas = null; }
  if (areas) { this._areasFromLoopsCache = areas; return areas; }
  return origBuildAreas.call(this);
};

const frame = () => new Promise((res) => requestAnimationFrame(() => res()));

// AutoCAD rule: ByLayer contents on layer "0" inside a block take the layer of the INSERT.
// The viewer applies this only when layer 0 is ACI 7, so drawings whose layer 0 is another
// color (often 8, grey) show fixtures and equipment grey. Apply the rule in the database:
// every block inserted on exactly one layer gets its layer-0 contents moved to that layer.
function inheritLayer0(db) {
  const bt = db.tables.blockTable;
  const layersOf = new Map();
  const visit = (record, inherited, depth) => {
    if (!record || depth > 8) return;
    for (const e of record.newIterator()) {
      if (e.blockName == null) continue;
      const eff = e.layer === '0' && inherited ? inherited : e.layer;
      let s = layersOf.get(e.blockName);
      if (!s) layersOf.set(e.blockName, s = new Set());
      if (s.has(eff)) continue;
      s.add(eff);
      visit(e.blockTableRecord || bt.getAt(e.blockName), eff, depth + 1);
    }
  };
  visit(bt.modelSpace, null, 0);
  let moved = 0;
  for (const [name, set] of layersOf) {
    if (set.size !== 1) continue;                 // inserted on several layers: leave as is
    const L = [...set][0];
    if (L === '0') continue;
    const rec = bt.getAt(name);
    if (!rec) continue;
    for (const e of rec.newIterator()) if (e.layer === '0') { e.layer = L; moved++; }
  }
  return moved;
}


async function renderOnce(view) {
  return new Promise((resolve) => {
    hook = resolve;
    view.isDirty = true;
    // Safety net: if no render happens within 3 s, resolve with the canvas as is.
    setTimeout(() => { if (hook === resolve) { hook = null; resolve(view.renderer.domElement); } }, 3000);
  });
}

// AutoCAD draws a LEADER in its dimension style's dimension-line color (DIMCLRD) when that is
// set; the viewer uses the entity color instead, so leaders came out black instead of green.
function leaderDimColors(db) {
  const styles = db.tables.dimStyleTable;
  const find = (key) => {
    if (!key) return undefined;
    let s = styles.getAt ? styles.getAt(key) : undefined;
    if (!s) for (const rec of styles.newIterator()) if (rec.objectId === key || rec.name === key) { s = rec; break; }
    return s;
  };
  // DIMCLRD may arrive as an ACI number or as LibreDWG's raw color (method 0xC3 = ACI in the low byte).
  const aci = (v) => typeof v === 'number' ? v
    : v && typeof v === 'object' && (v.method === 195 || v.method === 0xC3) ? (v.rgb & 0xff) : undefined;
  // Leaders whose style was not read fall back to the style most dimensions use, then the current one.
  const usage = new Map();
  for (const rec of db.tables.blockTable.newIterator()) for (const x of rec.newIterator())
    if (x instanceof AcDbDimension && x.dimensionStyleName) usage.set(x.dimensionStyleName, (usage.get(x.dimensionStyleName) || 0) + 1);
  const common = [...usage.entries()].sort((p, q) => q[1] - p[1]).map(p => p[0])[0];
  const current = find(common) || find(db.dimstyle);
  let n = 0;
  for (const rec of db.tables.blockTable.newIterator()) for (const x of rec.newIterator()) {
    if (!(x instanceof AcDbLeader)) continue;
    const s = find(x.dimensionStyle) || current;
    const ci = s && aci(s.dimclrd);
    if (!(ci >= 1 && ci <= 255)) continue;
    const c = x.color.clone(); c.colorIndex = ci; x.color = c; n++;
  }
  return n;
}

// Text-like entities: drawn unthickened (AutoCAD does not apply plot lineweight to TrueType text).
// Tables and multileaders go with the text because their text cannot be separated from them.
const isText = (x) => x instanceof AcDbText || x instanceof AcDbMText || x instanceof AcDbArcAlignedText
  || x instanceof AcDbTable || x instanceof AcDbMLeader
  // Solid fills have no plot lineweight; thickening them closes the thin white gaps in logos.
  || (x instanceof AcDbHatch && x.isSolidFill);

let pass = 'all';
function applyPass(db, mode) {
  let n = 0;
  const set = (x) => {
    const want = mode === 'all' || (isText(x) === (mode === 'text'));
    if (x.visibility !== want) { x.visibility = want; n++; }
  };
  for (const rec of db.tables.blockTable.newIterator()) {
    for (const x of rec.newIterator()) {
      if (x instanceof AcDbDimension) {
        // Dimensions draw from their own block (lines + text), which is filtered like any block.
        if (!x.visibility) { x.visibility = true; n++; }
      } else if (x instanceof AcDbBlockReference && !(x instanceof AcDbTable)) {
        // Inserts stay visible in both passes; their contents and attributes are filtered.
        if (!x.visibility) { x.visibility = true; n++; }
        if (typeof x.attributeIterator === 'function') for (const a of x.attributeIterator()) set(a);
      } else set(x);
    }
  }
  return n;
}

async function settle(view) {
  await frame();
  await view.waitUntilIdle(120000);
  await new Promise((res) => setTimeout(res, 500));   // let any queued auto-fit run first
  await view.waitUntilIdle(120000);
  await frame();
}

// ---- Vector export ----
// Instead of copying pixels, record every draw call the viewer makes for a page and write the same
// geometry as PDF paths: lines as strokes, filled triangles (text glyphs, solid fills) merged into
// outlines, and pattern hatches as their pattern lines clipped to the hatch area. Colors are the
// viewer's own, so the result matches the image output but stays sharp at any zoom.
const glOf = (view) => { const r = view._renderer; return [r.renderer, r._renderer, r].find(x => x && typeof x.renderBufferDirect === 'function'); };

async function captureDraws(box) {
  const view = mgr.curView, R = glOf(view), root = view._scene && view._scene._scene;
  if (!R || !root) throw new Error('vector: renderer internals not found');
  const draws = [];
  const orig = R.renderBufferDirect;
  R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (scene === root) draws.push({ geometry, material, object, group });
    return orig.apply(this, arguments);
  };
  try {
    const side = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1.02;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const b = new AcGeBox2d({ x: cx - side / 2, y: cy - side / 2 }, { x: cx + side / 2, y: cy + side / 2 });
    view.zoomTo(b, 1);
    await frame();
    await view.waitUntilIdle(30000);
    view.zoomTo(b, 1);
    await frame();
    draws.length = 0;
    await renderOnce(view);
  } finally { R.renderBufferDirect = orig; }
  return draws;
}

const num = (v) => { const r = Math.round(v * 100) / 100; return (r === 0 ? 0 : r).toString(); };
const rgbOp = (hex, op) => `${num(((hex >> 16) & 255) / 255)} ${num(((hex >> 8) & 255) / 255)} ${num((hex & 255) / 255)} ${op}`;

// Writes one page. o: { box (drawing units), ox, oy, s (pt per unit; PDF origin bottom-left),
// clip: [x, y, w, h] in pt, lineW, hatchW (pt), mono }. Returns PDF content-stream chunks.
function emitPage(draws, o) {
  const chunks = []; let buf = [];
  const put = (s) => { buf.push(s); if (buf.length > 20000) { chunks.push(buf.join('\n')); buf = []; } };
  let curStroke = -1, curFill = -1, curW = -1, curCap = 1;
  // Round caps for plain lines; butt caps for dashes so the gaps stay open.
  const setCap = (c) => { if (c !== curCap) { put(c + ' J'); curCap = c; } };
  const [cx0, cy0, cw, ch] = o.clip, cx1 = cx0 + cw, cy1 = cy0 + ch;
  const pad = 2;
  put('q 1 J 1 j');
  put(`${num(cx0)} ${num(cy0)} ${num(cw)} ${num(ch)} re W n`);
  const colorOf = (mt) => {
    const c = mt.uniforms && mt.uniforms.u_color ? mt.uniforms.u_color.value : mt.color;
    if (!c || !c.isColor) return null;
    const hex = c.getHex();
    return o.mono ? (hex === 0xffffff ? 0xffffff : 0) : hex;
  };
  const setStroke = (hex, w) => {
    if (hex !== curStroke) { put(rgbOp(hex, 'RG')); curStroke = hex; }
    if (w !== curW) { put(num(w) + ' w'); curW = w; }
  };
  const setFill = (hex) => { if (hex !== curFill) { put(rgbOp(hex, 'rg')); curFill = hex; } };
  const tmpM = new Float64Array(16);
  // Affine map local -> page pt for each instance: [a, b, c, d, e, f] with X = a x + c y + e, Y = b x + d y + f.
  const transforms = (obj) => {
    const W = obj.matrixWorld.elements, list = [];
    const toPage = (m) => [m[0] * o.s, m[1] * o.s, m[4] * o.s, m[5] * o.s, (m[12] - o.box.x0) * o.s + o.ox, (m[13] - o.box.y0) * o.s + o.oy];
    if (obj.instanceMatrix && obj.count != null) {
      const I = obj.instanceMatrix.array;
      for (let i = 0; i < obj.count; i++) {
        const k = i * 16;
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
          let sum = 0; for (let j = 0; j < 4; j++) sum += W[j * 4 + r] * I[k + c * 4 + j];
          tmpM[c * 4 + r] = sum;
        }
        list.push(toPage(tmpM));
      }
    } else list.push(toPage(W));
    return list;
  };
  const outside = (x0, y0, x1, y1) => (x0 < cx0 - pad && x1 < cx0 - pad) || (x0 > cx1 + pad && x1 > cx1 + pad) || (y0 < cy0 - pad && y1 < cy0 - pad) || (y0 > cy1 + pad && y1 > cy1 + pad);
  // Polyline writer that joins segments sharing endpoints.
  let lx = NaN, ly = NaN, nOps = 0;
  const seg = (x0, y0, x1, y1) => {
    if (outside(x0, y0, x1, y1)) return;
    if (!(Math.abs(x0 - lx) <= 0.01 && Math.abs(y0 - ly) <= 0.01)) put(`${num(x0)} ${num(y0)} m`);
    put(`${num(x1)} ${num(y1)} l`);
    lx = x1; ly = y1;
    if (++nOps > 4000) { put('S'); nOps = 0; lx = ly = NaN; }
  };
  const endStroke = () => { if (nOps) put('S'); nOps = 0; lx = ly = NaN; };
  const rangeOf = (g, group) => {
    const total = g.index ? g.index.count : g.attributes.position.count;
    let start = Math.max(0, g.drawRange.start), end = Math.min(total, start + (isFinite(g.drawRange.count) ? g.drawRange.count : total));
    if (group) { start = Math.max(start, group.start); end = Math.min(end, group.start + group.count); }
    return [start, end];
  };
  // Splits a line from local p to q (path distance d0..d1) into dashes of `pat` (period L).
  const dashes = (pat, L, d0, d1, emit) => {
    const len = d1 - d0;
    if (!(len > 0) || !(L > 0) || len / L > 20000) { emit(0, 1); return; }
    for (let base = Math.floor(d0 / L) * L, guard = 0; base < d1 && guard < 1e6; base += L, guard++) {
      let p = base;
      for (const el of pat) {
        const a = p, b = p + Math.abs(el);
        if (el > 0) { const s0 = Math.max(a, d0), s1 = Math.min(b, d1); if (s1 > s0) emit((s0 - d0) / len, (s1 - d0) / len); }
        else if (el === 0 && a >= d0 && a <= d1) { const u = (a - d0) / len; emit(u, u); }   // dot: zero-length, round cap
        p = b;
        if (p >= d1) break;
      }
    }
  };
  const scaleOf = (T) => Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));

  // Outline of a triangle set: directed edges that are not cancelled by a neighbour, chained into loops.
  const outline = (xs, ys, tris) => {
    const edges = new Map(); const N = xs.length + 1;
    for (let t = 0; t < tris.length; t += 3) {
      let a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const area = (xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a]);
      if (Math.abs(area) < 1e-9) continue;
      if (area < 0) { const z = b; b = c; c = z; }
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const rev = v * N + u;
        if (edges.has(rev)) { const n = edges.get(rev) - 1; if (n) edges.set(rev, n); else edges.delete(rev); }
        else edges.set(u * N + v, (edges.get(u * N + v) || 0) + 1);
      }
    }
    const next = new Map();
    for (const [k, n] of edges) { const u = Math.floor(k / N), v = k - u * N; for (let j = 0; j < n; j++) { let l = next.get(u); if (!l) next.set(u, l = []); l.push(v); } }
    const loops = [];
    for (const start of next.keys()) {
      while (next.get(start) && next.get(start).length) {
        const loop = [start]; let u = start, guard = 0;
        while (guard++ < 1e6) {
          const l = next.get(u); if (!l || !l.length) break;
          const v = l.pop(); if (v === start) break; loop.push(v); u = v;
        }
        if (loop.length >= 3) loops.push(loop);
      }
    }
    return loops;
  };
  // Vertices of a mesh draw in page pt (deduplicated by position) and its triangles.
  const meshTris = (g, range, T) => {
    const pos = g.attributes.position, idx = g.index;
    const xs = [], ys = [], key = new Map(), tris = [];
    const vid = (i) => {
      const x = pos.getX(i), y = pos.getY(i);
      const X = T[0] * x + T[2] * y + T[4], Y = T[1] * x + T[3] * y + T[5];
      const k = Math.round(X * 1000) + ',' + Math.round(Y * 1000);
      let id = key.get(k); if (id == null) { id = xs.length; xs.push(X); ys.push(Y); key.set(k, id); }
      return id;
    };
    const [s0, s1] = range;
    for (let i = s0; i + 2 < s1; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      tris.push(vid(a), vid(b), vid(c));
    }
    return { xs, ys, tris };
  };
  const pathOf = (xs, ys, loops) => loops.map(L => `${num(xs[L[0]])} ${num(ys[L[0]])} m ` + L.slice(1).map(i => `${num(xs[i])} ${num(ys[i])} l`).join(' ') + ' h').join('\n');
  const bboxOut = (xs, ys) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < xs.length; i++) { a = Math.min(a, xs[i]); c = Math.max(c, xs[i]); b = Math.min(b, ys[i]); d = Math.max(d, ys[i]); } return !xs.length || outside(a, b, c, d); };

  let stats = { lines: 0, fills: 0, hatches: 0, skipped: 0 };
  for (const d of draws) {
    const obj = d.object, g = d.geometry, mt = d.material;
    if (!obj.visible || obj.isSprite || obj.isPoints || !g || !g.attributes || !g.attributes.position && !g.attributes.instanceStart) { stats.skipped++; continue; }
    if (mt.map) { stats.skipped++; continue; }
    const col = colorOf(mt);
    if (col == null) { stats.skipped++; continue; }
    const Ts = transforms(obj);

    if (obj.isLineSegments2 || obj.type === 'LineSegments2' || g.attributes.instanceStart) {
      const A = g.attributes.instanceStart, B = g.attributes.instanceEnd;
      const n = Math.min(A.count, g.instanceCount != null && isFinite(g.instanceCount) ? g.instanceCount : A.count);
      for (const T of Ts) {
        const w = mt.worldUnits ? Math.max(o.lineW, mt.linewidth * scaleOf(T)) : o.lineW;
        setCap(1);
        setStroke(col, w);
        for (let i = 0; i < n; i++) {
          const x0 = A.getX(i), y0 = A.getY(i), x1 = B.getX(i), y1 = B.getY(i);
          seg(T[0] * x0 + T[2] * y0 + T[4], T[1] * x0 + T[3] * y0 + T[5], T[0] * x1 + T[2] * y1 + T[4], T[1] * x1 + T[3] * y1 + T[5]);
        }
        endStroke();
      }
      stats.lines++;
    } else if (obj.isLine) {
      const pos = g.attributes.position, idx = g.index, LD = g.attributes.lineDistance;
      const [s0, s1] = rangeOf(g, d.group);
      const vi = (i) => idx ? idx.getX(i) : i;
      const pairs = [];
      if (obj.isLineSegments) for (let i = s0; i + 1 < s1; i += 2) pairs.push(vi(i), vi(i + 1));
      else {
        for (let i = s0; i + 1 < s1; i++) pairs.push(vi(i), vi(i + 1));
        if (obj.isLineLoop && s1 - s0 > 2) pairs.push(vi(s1 - 1), vi(s0));
      }
      const U = mt.uniforms;
      const pat = U && U.pattern && LD ? Array.from(U.pattern.value).map(v => v * (U.u_viewportScale ? U.u_viewportScale.value : 1)) : null;
      const L = pat ? U.patternLength.value * (U.u_viewportScale ? U.u_viewportScale.value : 1) : 0;
      for (const T of Ts) {
        setStroke(col, o.lineW);
        const dashed = pat && L * scaleOf(T) >= 1.0;   // as the viewer: tiny patterns print solid
        setCap(dashed ? 0 : 1);
        for (let k = 0; k < pairs.length; k += 2) {
          const a = pairs[k], b = pairs[k + 1];
          const x0 = pos.getX(a), y0 = pos.getY(a), x1 = pos.getX(b), y1 = pos.getY(b);
          const X0 = T[0] * x0 + T[2] * y0 + T[4], Y0 = T[1] * x0 + T[3] * y0 + T[5];
          const X1 = T[0] * x1 + T[2] * y1 + T[4], Y1 = T[1] * x1 + T[3] * y1 + T[5];
          if (!dashed) { seg(X0, Y0, X1, Y1); continue; }
          if (outside(X0, Y0, X1, Y1)) continue;
          let d0 = LD.getX(a), d1 = LD.getX(b);
          if (!(d1 > d0)) { d0 = 0; d1 = Math.hypot(x1 - x0, y1 - y0); }
          const dotU = o.lineW / Math.max(1e-6, Math.hypot(X1 - X0, Y1 - Y0));
          dashes(pat, L, d0, d1, (u0, u1) => { if (u1 === u0) u1 = Math.min(1, u0 + dotU); seg(X0 + (X1 - X0) * u0, Y0 + (Y1 - Y0) * u0, X0 + (X1 - X0) * u1, Y0 + (Y1 - Y0) * u1); });
        }
        endStroke();
      }
      stats.lines++;
    } else if (obj.isMesh) {
      const range = rangeOf(g, d.group);
      const U = mt.uniforms;
      const patTex = U && U.u_patternData && U.u_patternData.value;
      for (const T of Ts) {
        const { xs, ys, tris } = meshTris(g, range, T);
        if (!tris.length || bboxOut(xs, ys)) continue;
        const loops = outline(xs, ys, tris);
        if (!loops.length) continue;
        const path = pathOf(xs, ys, loops);
        if (!patTex) { setFill(col); put(path + '\nf'); stats.fills++; continue; }
        // Pattern hatch: pattern lines in the mesh's local frame, clipped to its outline.
        const lines = hatchLines(g, range, U, mt, T, Math.max(o.hatchW * 1.6, 0.8));
        if (lines === null) { setFill(col); put(path + '\nf'); stats.fills++; continue; }
        put('q'); put(path + '\nW n');
        setStroke(col, o.hatchW); setCap(0);
        for (const [x0, y0, x1, y1] of lines) seg(T[0] * x0 + T[2] * y0 + T[4], T[1] * x0 + T[3] * y0 + T[5], T[0] * x1 + T[2] * y1 + T[4], T[1] * x1 + T[3] * y1 + T[5]);
        endStroke();
        put('Q'); curStroke = curFill = curW = curCap = -1;
        stats.hatches++;
      }
    } else stats.skipped++;
  }
  put('Q');
  chunks.push(buf.join('\n'));
  return { chunks, stats };
}

// Pattern lines of a hatch mesh in local coordinates, or null when they are too dense to draw
// (those print as a solid tone, as in the viewer).
function hatchLines(g, range, U, mt, T, dotPt) {
  const tex = U.u_patternData.value, data = tex.image && tex.image.data;
  if (!data) return null;
  const lc = U.u_patternLineCount.value, tpl = U.u_texelsPerLine.value, PA = U.u_patternAngle ? U.u_patternAngle.value : 0;
  const nd = (mt.defines && mt.defines.MAX_PATTERN_SEGMENT_COUNT) || 0;
  const pos = g.attributes.position, idx = g.index;
  let xa = Infinity, ya = Infinity, xb = -Infinity, yb = -Infinity;
  for (let i = range[0]; i < range[1]; i++) { const v = idx ? idx.getX(i) : i; const x = pos.getX(v), y = pos.getY(v); if (x < xa) xa = x; if (x > xb) xb = x; if (y < ya) ya = y; if (y > yb) yb = y; }
  if (!isFinite(xa)) return [];
  const scale = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));     // pt per local unit
  const rot = (x, y, a) => [Math.cos(a) * x - Math.sin(a) * y, Math.cos(a) * y + Math.sin(a) * x];
  const out = [];
  for (let li = 0; li < lc; li++) {
    const f = li * tpl * 4;
    const ang = data[f], bx = data[f + 1], by = data[f + 2], offx = data[f + 3], offy = data[f + 4], plen = data[f + 5];
    const dl = []; for (let k = 0; k < nd; k++) dl.push(data[f + 6 + k]);
    const theta = ang + PA, [rbx, rby] = rot(bx, by, PA);
    const dashed = plen > 0;
    const dist = dashed ? Math.abs(offy) : Math.hypot(offx, offy);
    if (!(dist > 0)) return null;
    if (dist * scale < 0.35) return null;                                     // denser than ~0.1 mm
    // Bounding box in the pattern frame.
    let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
    for (const [px, py] of [[xa, ya], [xb, ya], [xa, yb], [xb, yb]]) {
      const [sx, sy] = rot(px - rbx, py - rby, -theta);
      xmin = Math.min(xmin, sx); xmax = Math.max(xmax, sx); ymin = Math.min(ymin, sy); ymax = Math.max(ymax, sy);
    }
    const k0 = Math.ceil(ymin / dist), k1 = Math.floor(ymax / dist);
    if (k1 - k0 > 20000) return null;
    const back = (x, y) => { const [px, py] = rot(x, y, theta); return [px + rbx, py + rby]; };
    const pat = [];
    if (dashed) { let sum = 0; for (const v of dl) { pat.push(v); sum += Math.abs(v); if (sum >= plen - 1e-6) break; } }
    for (let k = k0; k <= k1; k++) {
      const y = k * dist;
      if (!dashed) { const [x0, y0] = back(xmin, y), [x1, y1] = back(xmax, y); out.push([x0, y0, x1, y1]); continue; }
      const shift = Math.abs(offy) > 1e-9 ? y * offx / offy : 0;
      // Dash positions run along the line from the line's own origin (shifted per row).
      const st = xmin - shift, en = xmax - shift;
      for (let base = Math.floor(st / plen) * plen, guard = 0; base < en && guard < 100000; base += plen, guard++) {
        let p = base;
        for (const el of pat) {
          const a = p, b = p + Math.abs(el);
          if (el > 0) { const s0 = Math.max(a, st), s1 = Math.min(b, en); if (s1 > s0) { const [x0, y0] = back(s0 + shift, y), [x1, y1] = back(s1 + shift, y); out.push([x0, y0, x1, y1]); } }
          else if (el === 0 && a >= st && a <= en) { const [x0, y0] = back(a + shift, y), [x1, y1] = back(a + shift + dotPt / scale, y); out.push([x0, y0, x1, y1]); }
          p = b;
          if (p >= en) break;
        }
        if (out.length > 400000) return null;
      }
    }
  }
  return out;
}

window.CADHIFI = {
  TILE,
  // Vector content for one page; see emitPage for the options.
  async vectorPage(o) {
    const draws = await captureDraws(o.box);
    return emitPage(draws, o);
  },
  // Opens the drawing; resolves when geometry and text are ready.
  async open(buf, name, opts) {
    const m = setup(opts);
    const ok = await m.openDocument(name, buf, { readOnly: true, drawNoPlotLayers: !!opts.drawNoPlotLayers });
    if (!ok) throw new Error('open failed');
    pass = 'all';
    const view = m.curView;
    view.backgroundColor = 0xffffff;          // paper: ACI 7 draws black
    await view.waitUntilIdle(120000);
    const db = m.curDocument.database;
    const fixed = inheritLayer0(db) + leaderDimColors(db);
    if (fixed > 0) { AcDbRenderingCache.instance.clear(); m.regen(); await settle(view); }
    await frame(); await frame();
    return true;
  },
  // 'all' | 'lines' (everything except text) | 'text' (text only).
  async setPass(mode) {
    if (mode === pass) return;
    const changed = applyPass(mgr.curDocument.database, mode);
    pass = mode;
    // Block graphics are cached per block definition; drop them so hidden contents really disappear.
    if (changed) { AcDbRenderingCache.instance.clear(); mgr.regen(); await settle(mgr.curView); }
  },
  // Renders WCS box {x0,y0,x1,y1} (square) into a fresh TILE x TILE canvas.
  async renderTile(box) {
    const view = mgr.curView;
    const b = new AcGeBox2d({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 });
    view.zoomTo(b, 1);
    await frame();
    await view.waitUntilIdle(30000);
    view.zoomTo(b, 1);                          // re-assert: a late auto-fit must not move this tile
    await frame();
    const src = await renderOnce(view);
    const cv = document.createElement('canvas');
    cv.width = TILE; cv.height = TILE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, TILE, TILE);
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, TILE, TILE);
    return cv;
  },
  // WCS boxes that contain text (model-space text, and inserts whose block holds text).
  textBoxes() {
    const db = mgr.curDocument.database, bt = db.tables.blockTable;
    const hasText = new Map();
    const blockHasText = (name, depth) => {
      if (hasText.has(name)) return hasText.get(name);
      hasText.set(name, false);
      const rec = bt.getAt(name); let r = false;
      if (rec && depth < 8) for (const x of rec.newIterator()) {
        if (isText(x) || x instanceof AcDbDimension || (x.blockName != null && blockHasText(x.blockName, depth + 1))) { r = true; break; }
        if (typeof x.attributeIterator === 'function') for (const _ of x.attributeIterator()) { r = true; break; }
        if (r) break;
      }
      hasText.set(name, r);
      return r;
    };
    const boxes = [];
    for (const x of bt.modelSpace.newIterator()) {
      let t = isText(x) || x instanceof AcDbDimension;
      if (!t && x.blockName != null) {
        t = blockHasText(x.blockName, 0);
        if (!t && typeof x.attributeIterator === 'function') for (const _ of x.attributeIterator()) { t = true; break; }
      }
      if (!t || !x.visibility && pass === 'all') continue;
      let ex; try { ex = x.geometricExtents; } catch (err) { continue; }
      if (ex && isFinite(ex.min.x) && isFinite(ex.max.x)) boxes.push({ x0: ex.min.x, y0: ex.min.y, x1: ex.max.x, y1: ex.max.y });
    }
    return boxes;
  },
  extents() {
    const db = mgr.curDocument.database;
    const a = db.extmin, b = db.extmax;
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  },
  get _mgr() { return mgr; },
  get ready() { return !!mgr; }
};
