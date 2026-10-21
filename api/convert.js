// Server-side relay to ConvertAPI so the API token never reaches the browser.
// POST /api/convert?name=<file name>&w=<mm>&h=<mm>&color=truecolors|grayscale|monochrome&space=default|model|all
// Body: the raw DWG/DXF file bytes. Returns { files: [{ url, name, size }], cost }.

const MAX_BYTES = 4.4 * 1024 * 1024; // Vercel request body limit is 4.5 MB

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "METHOD" });
  const token = process.env.CONVERTAPI_TOKEN;
  if (!token) return send(res, 500, { error: "NO_TOKEN" });

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES) return send(res, 413, { error: "TOO_LARGE" });
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) return send(res, 400, { error: "EMPTY" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const name = (q.get("name") || "drawing.dwg").slice(0, 200);
  const ext = /\.dxf$/i.test(name) ? "dxf" : "dwg";
  const clampMm = (v) => Math.min(30000, Math.max(10, Math.round(Number(v) || 0)));
  const color = ["truecolors", "grayscale", "monochrome"].includes(q.get("color")) ? q.get("color") : "truecolors";
  const space = ["default", "model", "all"].includes(q.get("space")) ? q.get("space") : "default";

  const fd = new FormData();
  fd.append("File", new Blob([buf]), name);
  fd.append("StoreFile", "true");
  fd.append("AutoFit", "true");
  fd.append("ColorSpace", color);
  fd.append("SpaceToConvert", space);
  if (q.get("w") && q.get("h")) {
    fd.append("PageWidth", String(clampMm(q.get("w"))));
    fd.append("PageHeight", String(clampMm(q.get("h"))));
  }

  let r;
  try {
    r = await fetch(`https://v2.convertapi.com/convert/${ext}/to/pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: fd,
    });
  } catch (e) {
    return send(res, 502, { error: "UPSTREAM", message: String(e && e.message || e) });
  }
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON error */ }
  if (!r.ok || !data || !Array.isArray(data.Files)) {
    return send(res, r.status >= 400 ? r.status : 502, { error: "CONVERT", message: (data && (data.Message || data.message)) || `HTTP ${r.status}` });
  }
  return send(res, 200, {
    cost: data.ConversionCost,
    files: data.Files.map((f) => ({ url: f.Url, name: f.FileName, size: f.FileSize })),
  });
};
