// POST /api/use — records one conversion (settings and outcome only; never file names or content).
// Each record is an empty private blob whose path carries the fields, so stats need only a listing.
import { put, list } from '@vercel/blob';
import { visitor } from './_lib.js';

const tok = (v, n = 12) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9.x_-]/g, '').slice(0, n);
const num = (v, max) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x * 10) / 10, max) : 0; };

export async function POST(request) {
  let b;
  try { b = JSON.parse(await request.text()); } catch (e) { return new Response(null, { status: 400 }); }
  const day = new Date().toISOString().slice(0, 10), who = visitor(request);
  const mine = await list({ prefix: `use/${day}/${who}-`, limit: 300 });
  if (mine.blobs.length >= 200) return new Response(null, { status: 429 });
  const f = {
    ok: b.ok ? 1 : 0, out: tok(b.out, 8), ext: tok(b.ext, 6), col: tok(b.col, 6), sh: tok(b.sh, 12),
    p: num(b.pages, 999), s: num(b.sec, 9999), mb: num(b.mb, 999), err: tok(b.err, 16),
  };
  const meta = Object.entries(f).map(([k, v]) => `${k}=${v}`).join('~');
  await put(`use/${day}/${who}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}~${meta}`, '', { access: 'private', addRandomSuffix: false });
  return new Response(null, { status: 204 });
}
