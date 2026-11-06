// Copies the LibreDWG reader's JavaScript into /dwg with its memory capped.
// usage: node tools/dwg/build.cjs <node_modules dir with @mlightcad/libredwg-web>
//
// Some DWG files send the reader into a runaway loop that grows its memory to 4 GB before it
// fails, which takes the whole browser tab down with it. With the cap the reader runs out of
// memory at 1.25 GB and stops with an error the page can catch and explain.
// The .wasm binary itself is still loaded from the CDN (see CAD2PDF_DWG_WASM in index.html).
const fs = require("fs"), path = require("path");
const nm = process.argv[2] || path.join(__dirname, "node_modules");
const src = path.join(nm, "@mlightcad/libredwg-web");
const ver = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
const out = path.join(__dirname, "..", "..", "dwg");
fs.mkdirSync(path.join(out, "dist"), { recursive: true });
fs.mkdirSync(path.join(out, "wasm"), { recursive: true });
fs.copyFileSync(path.join(src, "dist/libredwg-web.js"), path.join(out, "dist/libredwg-web.js"));
let glue = fs.readFileSync(path.join(src, "wasm/libredwg-web.js"), "utf8");
const from = "getHeapMax=()=>4294901760";
if (!glue.includes(from)) throw new Error("libredwg-web " + ver + ": memory cap patch no longer applies");
glue = glue.replace(from, "getHeapMax=()=>1342177280");   // 1.25 GB
fs.writeFileSync(path.join(out, "wasm/libredwg-web.js"), glue);
fs.writeFileSync(path.join(out, "VERSION"), ver + "\n");
console.log("dwg reader " + ver + " copied with a 1.25 GB memory cap");
