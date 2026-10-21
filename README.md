# cad2pdf

Convert AutoCAD DWG and DXF drawings to PDF in the browser. Files are never uploaded.

- Default sheet: 24 × 36 in (ARCH D), full color; also ARCH E/C, Tabloid, Letter, A1, A3
- Orientation auto/landscape/portrait, color or black & white, line weight, light-color darkening
- Vector output, or high-res image output when the drawing has Chinese text
- Chinese / English interface

DWG reading uses [LibreDWG](https://github.com/LibreDWG/libredwg) compiled to WebAssembly ([@mlightcad/libredwg-web](https://www.npmjs.com/package/@mlightcad/libredwg-web)); DXF uses [dxf-parser](https://www.npmjs.com/package/dxf-parser); PDF via [jsPDF](https://github.com/parallax/jsPDF) and [svg2pdf.js](https://github.com/yWorks/svg2pdf.js).

Static site, no build step. Deployed on Vercel with Web Analytics.
