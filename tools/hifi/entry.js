// cad2pdf high-fidelity renderer: opens a drawing in the mlightcad viewer
// (hidden), then renders any WCS box to a high-res canvas tile by tile.
import { AcApDocManager, LIBREDWG_PARSER_WORKER_FILE, MTEXT_RENDERER_WORKER_FILE } from '@mlightcad/cad-simple-viewer';
import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model';
import { AcGeBox2d } from '@mlightcad/geometry-engine';
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

const frame = () => new Promise((res) => requestAnimationFrame(() => res()));

async function renderOnce(view) {
  return new Promise((resolve) => {
    hook = resolve;
    view.isDirty = true;
    // Safety net: if no render happens within 3 s, resolve with the canvas as is.
    setTimeout(() => { if (hook === resolve) { hook = null; resolve(view.renderer.domElement); } }, 3000);
  });
}

window.CADHIFI = {
  // Opens the drawing; resolves when geometry and text are ready.
  async open(buf, name, opts) {
    const m = setup(opts);
    const ok = await m.openDocument(name, buf, { readOnly: true, drawNoPlotLayers: !!opts.drawNoPlotLayers });
    if (!ok) throw new Error('open failed');
    const view = m.curView;
    view.backgroundColor = 0xffffff;          // paper: ACI 7 draws black
    await view.waitUntilIdle(120000);
    await frame(); await frame();
    return true;
  },
  // Renders WCS box {x0,y0,x1,y1} into a canvas of pxW × pxH.
  async render(box, pxW, pxH, onProgress) {
    const view = mgr.curView;
    const out = document.createElement('canvas');
    out.width = pxW; out.height = pxH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pxW, pxH);
    const upp = (box.x1 - box.x0) / pxW;       // drawing units per output pixel
    const cols = Math.ceil(pxW / TILE), rows = Math.ceil(pxH / TILE);
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px0 = c * TILE, py0 = r * TILE;
        // Each tile covers exactly TILE × TILE output pixels (the last ones spill past the page edge).
        const x0 = box.x0 + px0 * upp, x1 = x0 + TILE * upp;
        const y1 = box.y1 - py0 * upp, y0 = y1 - TILE * upp;   // WCS y grows up, pixels grow down
        view.zoomTo(new AcGeBox2d({ x: x0, y: y0 }, { x: x1, y: y1 }), 1);
        await frame();
        await view.waitUntilIdle(30000);
        const cv = await renderOnce(view);
        ctx.drawImage(cv, 0, 0, cv.width, cv.height, px0, py0, TILE, TILE);
        if (onProgress) onProgress(++n, rows * cols);
      }
    }
    return out;
  },
  extents() {
    const db = mgr.curDocument.database;
    const a = db.extmin, b = db.extmax;
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  },
  get ready() { return !!mgr; }
};
