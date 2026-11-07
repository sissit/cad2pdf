// Copies the LibreDWG reader (JavaScript, and optionally its .wasm) into the site with its memory capped.
//
//   node tools/dwg/build.cjs <node_modules dir or package dir> [out dir] [--with-wasm] [--heap-mb=N]
//
// Default: the npm package's reader goes to /dwg, and its .wasm is loaded from the CDN
// (see CAD2PDF_DWG_WASM in index.html).
// The backup reader built by .github/workflows/build-dwg-reader.yml goes to /dwg-next with its
// .wasm (it is not on any CDN):
//   node tools/dwg/build.cjs lw/bindings/javascript dwg-next --with-wasm
//
// Some DWG files send the reader into a runaway loop that grows its memory to 4 GB before it
// fails, which takes the whole browser tab down with it. With the cap the reader runs out of
// memory at 1.25 GB and stops with an error the page can catch and explain.
// The backup reader gets a higher cap (--heap-mb=2048): it does not run away, but large drawings
// legitimately need about 1.5 GB to read.
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const withWasm = args.includes("--with-wasm");
const pos = args.filter(a => !a.startsWith("--"));
const heapArg = args.find(a => a.startsWith("--heap-mb="));
const heapBytes = heapArg ? Math.min(4095, Math.max(256, parseInt(heapArg.split("=")[1], 10))) * 1024 * 1024 : 1342177280;
let src = pos[0] || path.join(__dirname, "node_modules");
if (!fs.existsSync(path.join(src, "package.json"))) src = path.join(src, "@mlightcad/libredwg-web");
const out = path.resolve(__dirname, "..", "..", pos[1] || "dwg");
const ver = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
fs.mkdirSync(path.join(out, "dist"), { recursive: true });
fs.mkdirSync(path.join(out, "wasm"), { recursive: true });
let api = fs.readFileSync(path.join(src, "dist/libredwg-web.js"), "utf8");
// Newer LibreDWG has no ACADVER, CEPSNID or DIMFAC header fields (ACADVER only exists in DXF
// output), and asking the reader for a field it does not have aborts it outright. Take ACADVER
// from the file's version and leave the other two out.
const hdrCall = "let value = libredwg.dwg_dynapi_header_data(data, var_name);";
if (api.includes(hdrCall)) {
  api = api.replace(hdrCall, 'if (name == "ACADVER") { const v = libredwg.dwg_get_version_type(data); header[name] = v && v.hdr || ""; return; }\n' +
    '      if (name == "CEPSNID" || name == "DIMFAC") return;\n      ' + hdrCall);
}
fs.writeFileSync(path.join(out, "dist/libredwg-web.js"), api);
let glue = fs.readFileSync(path.join(src, "wasm/libredwg-web.js"), "utf8");
const cap = /getHeapMax=\(\)=>\d+/;
if (!cap.test(glue)) throw new Error("libredwg-web " + ver + ": memory cap patch no longer applies");
glue = glue.replace(cap, "getHeapMax=()=>" + heapBytes);
fs.writeFileSync(path.join(out, "wasm/libredwg-web.js"), glue);
if (withWasm) fs.copyFileSync(path.join(src, "wasm/libredwg-web.wasm"), path.join(out, "wasm/libredwg-web.wasm"));
fs.writeFileSync(path.join(out, "VERSION"), ver + (process.env.DWG_READER_NOTE ? " " + process.env.DWG_READER_NOTE : "") + "\n");
console.log("dwg reader " + ver + " copied to " + path.relative(process.cwd(), out) + " with a " + (heapBytes / 1073741824).toFixed(2) + " GB memory cap" + (withWasm ? " (with .wasm)" : ""));
