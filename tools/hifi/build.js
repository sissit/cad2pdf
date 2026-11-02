// Builds ../../hifi/: the viewer bundle plus the worker files it loads.
// usage: cd tools/hifi && npm install --legacy-peer-deps && npm run build
const fs = require("fs"), path = require("path");
const nm = path.join(__dirname, "node_modules");
const out = path.join(__dirname, "..", "..", "hifi");
// Extra fonts shipped with the site (all SIL OFL, metric-compatible with the faces they stand in
// for), added to the font catalog the page and the text worker read. Names are the font file
// names drawings ask for, without extension.
const EXTRA_FONTS = [
  ["arimo-bold.woff", ["arimo-bold", "arialbd", "arialbi", "arialnb", "ariblk", "swissb", "swisseb", "swissbi", "swisscb", "swissbo", "swissek", "swissebi", "calibrib", "segoeuib", "trebucbd", "tahomabd", "verdanab", "helveticab", "helvetica-bold"]],
  ["tinos.woff", ["tinos", "times", "times new roman", "timesnewroman", "tnr", "dutch", "dutch801", "serif", "georgia", "cambria", "garamond", "book antiqua", "bookos", "pala", "palatino", "century", "schlbk"]],
  ["tinos-bold.woff", ["tinos-bold", "timesbd", "dutchb", "dutcheb", "georgiab", "cambriab", "palab", "bookosb", "centuryb", "schlbkb"]],
  ["tinos-italic.woff", ["tinos-italic", "timesi", "dutchi", "georgiai", "cambriai", "palai", "bookosi", "schlbki"]],
  ["tinos-bolditalic.woff", ["tinos-bolditalic", "timesbi", "dutchbi", "georgiaz", "cambriaz", "palabi", "bookosbi", "schlbkbi"]],
  ["cousine.woff", ["cousine", "cour", "courier", "courier new", "couriernew", "consola", "consolas", "lucon", "monos"]],
  ["cousine-bold.woff", ["cousine-bold", "courbd", "consolab"]],
];
const catalogRe = /(\w+)\.forEach\(\((\w+)\) => \{\n\s*\2\.url = (\w+) \+ \2\.file;\n\s*\}\)/;
function addCatalogFonts(src, what) {
  if (!catalogRe.test(src)) throw new Error(what + ": font catalog patch no longer applies");
  const list = JSON.stringify(EXTRA_FONTS.map(([file, name]) => ({ file, name, type: "mesh" })));
  return src.replace(catalogRe, (all, arr) => `${all}, ${arr}.push(...(typeof location !== "undefined" && location.origin && location.origin !== "null" ? ${list}.map((f) => Object.assign(f, { url: location.origin + "/fonts/" + f.file })) : []))`);
}
// MTEXT parser: text such as "NOTE:\\P" was taken for a Windows path ("E:\\P...") and printed
// with its codes showing. Only treat "X:\\" as a drive when the letter does not end a word.
function fixDrivePath(src, what) {
  const from = "(?<![0-9A-Fa-f+])[A-Za-z]:", to = "(?<![0-9A-Za-z+])[A-Za-z]:";
  if (!src.includes(from)) throw new Error(what + ": drive-path patch no longer applies");
  return src.split(from).join(to);
}

fs.mkdirSync(path.join(out, "workers"), { recursive: true });
(async () => {
await require("esbuild").build({
  entryPoints: [path.join(__dirname, "entry.js")],
  bundle: true, format: "iife", minify: true, legalComments: "eof",
  outfile: path.join(out, "cadhifi.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "font-catalog",
    setup(build) {
      build.onLoad({ filter: /mtext-parser[\\/]dist[\\/]parser\.js$/ }, (args) => ({ contents: fixDrivePath(fs.readFileSync(args.path, "utf8"), "mtext-parser"), loader: "js" }));
      build.onLoad({ filter: /mtext-renderer[\\/]dist[\\/]index\.js$/ }, (args) => ({ contents: addCatalogFonts(fs.readFileSync(args.path, "utf8"), "mtext-renderer"), loader: "js" }));
    },
  }],
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
// MTEXT tabs: the text worker drops them, so "1.<tab>NOTE" printed as "1.NOTE" and numbered lists
// lost their hanging indent. Move to the next tab stop: the left margin when still left of it
// (a hanging indent), otherwise the next multiple of four text heights.
{
  const wp = path.join(out, "workers", "mtext-renderer-worker.js");
  let w = fs.readFileSync(wp, "utf8");
  const call = /\} else if \(o\.type === (\w+)\.SPACE\)\n(\s*)this\.processBlank\((\w+), (\w+)\);/;
  const m = w.match(call);
  if (!m || !/processBlank\(t, e\) \{/.test(w)) throw new Error("mtext worker: tab patch no longer applies");
  w = w.replace(call, (all, K, sp, a, b) => `${all}\n${sp.slice(2)}else if (o.type === ${K}.TABULATOR)\n${sp}this.processTab(${a}, ${b});`);
  w = w.replace("  processBlank(t, e) {", "  processTab(t, e) {\n    const step = 4 * this.defaultFontSize, x = this._hOffset;\n    const stop = x < -1e-9 ? 0 : (Math.floor(x / step + 1e-9) + 1) * step;\n    this.processBlank(t, e);\n    if (this._hOffset < stop) this._hOffset = stop;\n  }\n  processBlank(t, e) {");
  w = addCatalogFonts(w, "mtext worker");
  w = fixDrivePath(w, "mtext worker");
  fs.writeFileSync(wp, w);
}
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
})().catch((e) => { console.error(e); process.exit(1); });
