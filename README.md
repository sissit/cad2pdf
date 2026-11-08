# cad2pdf

Free CAD conversion in the browser at [5cad2pdf.com](https://5cad2pdf.com). Files are never uploaded.

**DWG / DXF to PDF** (`/`)

- Default sheet: 24 × 36 in (ARCH D), full color; also ARCH E/C, Tabloid, Letter, A1, A3
- One PDF page per drawing frame; orientation auto/landscape/portrait
- Color (as set in the drawing) or black & white
- Several files at once, as a ZIP or one merged PDF

**PDF to DWG / DXF** (`/pdf-to-dwg`)

- Reads the line work and text of vector PDFs (exported from AutoCAD, Revit and similar)
- Writes DWG (AutoCAD 2000) or DXF (R12): lines, polylines, dashes, colors, editable text
- Drawing scale and units (inches or millimeters) can be restored
- Several PDFs or pages at once, packed in a ZIP

English interface by default, Chinese at `/zh/`.

## Output

Each page is rendered off screen with the [mlightcad CAD viewer](https://github.com/mlightcad/cad-viewer)
in two passes. Linework is rendered at 200 dpi and thickened to the chosen line weight
(default 0.35 mm). Text is rendered separately at 450 dpi with a light 0.12 mm stroke and laid
transparently on top, so small text stays readable when the PDF is zoomed in. Tiles are
compressed with the browser's native zlib and embedded directly.
Layers set to not plot are left out, as in AutoCAD, unless "Include layers set to not plot" is ticked. If high-fidelity rendering fails, the PDF is
made with the vector renderer instead and the status line says so.

The preview on the page uses a fast SVG renderer; the high-fidelity renderer loads in the
background after a drawing is opened.

## Layout

- `zh.html` – the DWG to PDF app, Chinese (the source; static, no build step)
- `index.html` – the same app in English, generated from `zh.html` by `tools/i18n/build-en.cjs`
- `pdf-to-dwg.html`, `zh-pdf-to-dwg.html` – the PDF to DWG / DXF page, built from `tools/pdf2dxf/`
- `pdf2dxf/` – `core.js` (reads PDFs, writes DXF), `dwg.js` (writes DWG) and the blank DWG template
- `hifi/` – built high-fidelity renderer: `cadhifi.js` plus the DWG parser and MTEXT workers
- `dwg/`, `dwg-next/` – DWG readers (LibreDWG compiled to WebAssembly); `tools/dwg/` builds them
- `api/` – usage statistics and feedback (Vercel functions); `admin.html` shows them
- `tools/hifi/` – source and build script for `hifi/`

Rebuild `hifi/` after changing `tools/hifi/entry.js` or upgrading packages:

```bash
cd tools/hifi
npm install --legacy-peer-deps
npm run build
```

CAD fonts (SHX/TTF) load at run time from
[mlightcad/cad-data](https://github.com/mlightcad/cad-data) via jsDelivr.

## Two languages

Each page has an English address and a Chinese one: `/` and `/zh/`, `/pdf-to-dwg` and `/zh/pdf-to-dwg`,
linked with hreflang (English is the default). `zh.html` is the source of both main pages; after changing it run
`node tools/i18n/build-en.cjs` to rebuild the English `index.html`. The PDF to DWG pages are built by
`python3 tools/pdf2dxf/build-page.py` (writes `zh-pdf-to-dwg.html` and `pdf-to-dwg.html`).

## License

cad2pdf is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [LICENSE](LICENSE).

Copyright (C) 2026 Sissi Tang

The DWG reader in `dwg/` and `dwg-next/` is LibreDWG (GPL-3.0) compiled to WebAssembly; the
source of the backup reader is mlightcad/libredwg-web with LibreDWG merged in, built by
`.github/workflows/build-dwg-reader.yml` with the changes in `tools/dwg/`. The bundled fonts in
`fonts/` keep their own license (SIL Open Font License, see `fonts/OFL-*.txt`).

PDF to DWG / DXF (`/pdf-to-dwg`, source in `pdf2dxf/` and `tools/pdf2dxf/`) reads PDFs with
[pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0). The DWG writer (`pdf2dxf/dwg.js`) is our own;
it starts from `pdf2dxf/template-r2000.dwg`, a blank drawing saved by AutoCAD in 2000 format, taken from
the LibreDWG test data (`test/test-data/2000/Line.dwg`, GPL-3.0).

## Libraries and licenses

- [@mlightcad/cad-simple-viewer](https://www.npmjs.com/package/@mlightcad/cad-simple-viewer) and the RealDWG-Web data model – MIT
- DWG parsing: [LibreDWG](https://github.com/LibreDWG/libredwg) compiled to WebAssembly
  ([@mlightcad/libredwg-web](https://www.npmjs.com/package/@mlightcad/libredwg-web),
  [@mlightcad/libredwg-converter](https://www.npmjs.com/package/@mlightcad/libredwg-converter)) – GPL-3.0,
  runs in its own Web Worker (`hifi/workers/`)
- DXF preview: [dxf-parser](https://www.npmjs.com/package/dxf-parser) – MIT
- PDF: [jsPDF](https://github.com/parallax/jsPDF), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) – MIT

Deployed on Vercel with Web Analytics.
