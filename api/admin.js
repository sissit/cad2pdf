// POST /api/admin — password-protected list / mark done / delete of feedback.
// Wrong passwords: 5 within 15 minutes lock that visitor for 15 minutes; 10 within 24 hours lock
// it for 24 hours (a correct password clears the count). More than 30 wrong passwords from everyone in an hour pause logins for an hour.
import { json, visitor, counts, mark, list, del, readJson, writeJson, passwordOk } from './_lib.js';
import { hasToken, query, LAUNCH, tomorrow, daysAgo } from './_analytics.js';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_request' }); }
  const who = visitor(request);
  const [f15, f24] = await counts(`rl/login/${who}/`, [15 * MIN, DAY]);
  const [all] = await counts('rl/loginall/', [HOUR]);
  if (f24 >= 10) return json(429, { error: 'locked', minutes: 24 * 60 });
  if (f15 >= 5) return json(429, { error: 'locked', minutes: 15 });
  if (all >= 30) return json(429, { error: 'locked', minutes: 60 });
  if (!passwordOk(body.password)) {
    await mark(`rl/login/${who}/`); await mark('rl/loginall/');
    const left = Math.min(5 - (f15 + 1), 10 - (f24 + 1));
    return json(401, { error: 'wrong_password', left: Math.max(0, left), lockMinutes: f24 + 1 >= 10 ? 24 * 60 : 15 });
  }
  // A correct password clears this visitor's wrong-password count.
  if (f24 > 0) { const r = await list({ prefix: `rl/login/${who}/`, limit: 1000 }); if (r.blobs.length) await del(r.blobs.map(b => b.url)).catch(() => {}); }
  const action = body.action || 'list';
  if (action === 'stats') {
    if (!hasToken()) return json(200, { configured: false });
    try {
      const days = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 30;
      const until = tomorrow(), since = daysAgo(days - 1);
      const agg = (by, limit) => query('aggregate', { since, until, by, limit });
      const [total, period, daily, country, referrer, device, os, browser, pages] = await Promise.all([
        query('count', { since: LAUNCH, until }),
        query('count', { since, until }),
        agg('day'),
        agg('country', 10), agg('referrerHostname', 10), agg('deviceType', 5),
        agg('osName', 8), agg('browserName', 8), agg('requestPath', 10),
      ]);
      return json(200, { configured: true, days, total, period, daily, country, referrer, device, os, browser, pages });
    } catch (e) { return json(200, { configured: true, error: String(e.message || e) }); }
  }
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
