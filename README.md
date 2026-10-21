# cad2pdf

Convert AutoCAD DWG and DXF drawings to PDF in the browser. Files are never uploaded.

- Default sheet: 24 × 36 in (ARCH D), full color; also ARCH E/C, Tabloid, Letter, A1, A3
- One PDF page per drawing frame; orientation auto/landscape/portrait
- Color or black & white, light-color darkening
- Chinese / English interface

## Output modes

| Mode | What it uses | Good for |
|------|--------------|----------|
| High fidelity (default) | [mlightcad CAD viewer](https://github.com/mlightcad/cad-viewer) rendered off screen at up to 200 dpi | Printing; hatch patterns, CAD fonts, dimensions and Chinese text look close to AutoCAD |
| Vector | Own SVG renderer + [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | Zooming and searching; Chinese text does not survive |
| Simplified image | Own SVG renderer rasterized | The previous look |

The preview on the page always uses the fast SVG renderer; the high-fidelity renderer
loads in the background after a drawing is opened.

## Layout

- `index.html` – the whole app (static, no build step)
- `hifi/` – built high-fidelity renderer: `cadhifi.js` plus the DWG parser and MTEXT workers
- `tools/hifi/` – source and build script for `hifi/`

Rebuild `hifi/` after changing `tools/hifi/entry.js` or upgrading packages:

```bash
cd tools/hifi
npm install --legacy-peer-deps
npm run build
```

CAD fonts (SHX/TTF) load at run time from
[mlightcad/cad-data](https://github.com/mlightcad/cad-data) via jsDelivr.

## Libraries and licenses

- [@mlightcad/cad-simple-viewer](https://www.npmjs.com/package/@mlightcad/cad-simple-viewer) and the RealDWG-Web data model – MIT
- DWG parsing: [LibreDWG](https://github.com/LibreDWG/libredwg) compiled to WebAssembly
  ([@mlightcad/libredwg-web](https://www.npmjs.com/package/@mlightcad/libredwg-web),
  [@mlightcad/libredwg-converter](https://www.npmjs.com/package/@mlightcad/libredwg-converter)) – GPL-3.0,
  runs in its own Web Worker (`hifi/workers/`)
- DXF preview: [dxf-parser](https://www.npmjs.com/package/dxf-parser) – MIT
- PDF: [jsPDF](https://github.com/parallax/jsPDF), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) – MIT

Deployed on Vercel with Web Analytics.
