// POST /api/admin — password-protected list / mark done / delete of feedback.
// Wrong passwords are limited per visitor (5 per 15 minutes) and overall (30 per hour).
import { json, visitor, recent, mark, list, del, readJson, writeJson, passwordOk } from './_lib.js';

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_request' }); }
  const who = visitor(request);
  const fails = await recent(`rl/login/${who}/`, 15 * 60 * 1000);
  const allFails = await recent('rl/loginall/', 60 * 60 * 1000);
  if (fails >= 5 || allFails >= 30) return json(429, { error: 'locked' });
  if (!passwordOk(body.password)) {
    await mark(`rl/login/${who}/`); await mark('rl/loginall/');
    return json(401, { error: 'wrong_password', left: Math.max(0, 4 - fails) });
  }
  const action = body.action || 'list';
  const safeId = typeof body.id === 'string' && /^[0-9]+-[a-z0-9]+$/.test(body.id) ? body.id : null;
  if (action === 'list') {
    const items = []; let cursor;
    do {
      const r = await list({ prefix: 'feedback/', cursor, limit: 1000 });
      for (const b of r.blobs) items.push(b.pathname);
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    items.sort().reverse();
    const out = await Promise.all(items.slice(0, 300).map(p => readJson(p).catch(() => null)));
    return json(200, { items: out.filter(Boolean), total: items.length });
  }
  if (!safeId) return json(400, { error: 'bad_id' });
  const path = `feedback/${safeId}.json`;
  if (action === 'done' || action === 'undone') {
    const item = await readJson(path);
    if (!item) return json(404, { error: 'not_found' });
    item.done = action === 'done';
    await writeJson(path, item);
    return json(200, { ok: true });
  }
  if (action === 'delete') { await del(path); return json(200, { ok: true }); }
  return json(400, { error: 'bad_action' });
}
