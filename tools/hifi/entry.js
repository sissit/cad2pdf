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

window.CADHIFI = {
  TILE,
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
  get ready() { return !!mgr; }
};
