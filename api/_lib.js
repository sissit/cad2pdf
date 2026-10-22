// Shared helpers for the feedback API: private Blob storage and simple rate limits.
import { put, list, del, get } from '@vercel/blob';
import { createHash, timingSafeEqual } from 'node:crypto';

export const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Visitors are counted by a one-way hash of their address; the address itself is never stored.
export const visitor = (request) => {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update('cad2pdf:' + ip).digest('hex').slice(0, 16);
};

// Number of marker blobs under `prefix` written in the last `ms` milliseconds; older ones are removed.
export async function recent(prefix, ms) {
  const now = Date.now(), old = [];
  let n = 0, cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    for (const b of r.blobs) {
      const t = Number(b.pathname.split('/').pop().split('-')[0]);
      if (now - t < ms) n++; else old.push(b.url);
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  if (old.length) await del(old).catch(() => {});
  return n;
}
export const mark = (prefix) => put(`${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, '1', { access: 'private', addRandomSuffix: false });

export async function readJson(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r) return null;
  return JSON.parse(await new Response(r.stream).text());
}
export const writeJson = (pathname, obj) => put(pathname, JSON.stringify(obj), {
  access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
});
export { list, del };

export function passwordOk(given) {
  const want = process.env.ADMIN_PASSWORD || '';
  if (!want || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}
