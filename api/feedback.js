// POST /api/feedback — stores one visitor message privately. No owner details are exposed.
import { json, visitor, recent, mark, writeJson } from './_lib.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_request' }); }
  if (body.website) return json(200, { ok: true });               // honeypot: bots fill hidden fields
  const message = clip(body.message, 3000);
  if (message.length < 2) return json(400, { error: 'empty' });
  const who = visitor(request);
  if (await recent(`rl/fb/${who}/`, 10 * 60 * 1000) >= 5) return json(429, { error: 'too_many' });
  if (await recent('rl/fball/', 60 * 60 * 1000) >= 200) return json(429, { error: 'too_many' });
  await mark(`rl/fb/${who}/`); await mark('rl/fball/');
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const settings = body.settings && typeof body.settings === 'object'
    ? Object.fromEntries(Object.entries(body.settings).slice(0, 20).map(([k, v]) => [clip(k, 40), clip(String(v), 300)]))
    : null;
  await writeJson(`feedback/${id}.json`, {
    id, at: new Date().toISOString(), message, contact: clip(body.contact, 200),
    lang: clip(body.lang, 10), settings, ua: clip(request.headers.get('user-agent') || '', 300), done: false,
  });
  return json(200, { ok: true });
}
