// Builds ../../hifi/: the viewer bundle plus the worker files it loads.
// usage: cd tools/hifi && npm install --legacy-peer-deps && npm run build
const fs = require("fs"), path = require("path");
const nm = path.join(__dirname, "node_modules");
const out = path.join(__dirname, "..", "..", "hifi");
fs.mkdirSync(path.join(out, "workers"), { recursive: true });
require("esbuild").buildSync({
  entryPoints: [path.join(__dirname, "entry.js")],
  bundle: true, format: "iife", minify: true, legalComments: "eof",
  outfile: path.join(out, "cadhifi.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "three/examples/jsm/libs/stats.module": path.join(nm, "three/examples/jsm/libs/stats.module.js"),
    "three/examples/jsm/controls/OrbitControls": path.join(nm, "three/examples/jsm/controls/OrbitControls.js"),
  },
});
for (const [from, to] of [
  ["@mlightcad/libredwg-converter/dist/libredwg-parser-worker.js", "libredwg-parser-worker.js"],
  ["@mlightcad/libredwg-converter/dist/libredwg-web.wasm", "libredwg-web.wasm"],
  ["@mlightcad/cad-simple-viewer/dist/mtext-renderer-worker.js", "mtext-renderer-worker.js"],
]) fs.copyFileSync(path.join(nm, from), path.join(out, "workers", to));
// Stamp the bundle hash into index.html so browsers always fetch the matching renderer.
const hash = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(out, "cadhifi.js"))).digest("hex").slice(0, 10);
const indexPath = path.join(__dirname, "..", "..", "index.html");
// Version shown to users: build date and time in Houston.
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(new Date()).map((x) => [x.type, x.value]));
const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
const html = fs.readFileSync(indexPath, "utf8")
  .replace(/const HIFI_VER = "[^"]*";/, `const HIFI_VER = "${hash}";`)
  .replace(/const HIFI_DATE = "[^"]*";/, `const HIFI_DATE = "${stamp}";`);
fs.writeFileSync(indexPath, html);
console.log("built", hash, stamp, fs.readdirSync(out), fs.readdirSync(path.join(out, "workers")));
