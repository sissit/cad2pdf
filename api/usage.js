// Reports ConvertAPI conversions used / remaining. ConvertAPI's /user endpoint only accepts the
// account secret (not an API token), so this reads CONVERTAPI_SECRET, kept server-side.
// GET /api/usage -> { total, used, remaining }

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "METHOD" });
  const secret = process.env.CONVERTAPI_SECRET;
  if (!secret) return send(res, 200, { error: "NO_SECRET" });
  let r, data = null;
  try {
    r = await fetch("https://v2.convertapi.com/user", {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    });
    data = await r.json();
  } catch (e) {
    return send(res, 502, { error: "UPSTREAM" });
  }
  if (!r.ok || !data) return send(res, 502, { error: "UPSTREAM", status: r.status, message: data && (data.Message || data.message) });
  const total = Number(data.ConversionsTotal), used = Number(data.ConversionsConsumed);
  if (!isFinite(total) || !isFinite(used)) return send(res, 502, { error: "SHAPE" });
  return send(res, 200, { total, used, remaining: Math.max(0, total - used) });
};
