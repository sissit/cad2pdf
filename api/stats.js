// GET /api/stats — public visitor counts for the home page, cached for 10 minutes.
import { hasToken, query, LAUNCH, tomorrow, daysAgo } from './_analytics.js';

export async function GET() {
  if (!hasToken()) return new Response(JSON.stringify({ error: 'not_configured' }), { status: 503, headers: { 'content-type': 'application/json' } });
  try {
    const [all, week] = await Promise.all([
      query('count', { since: LAUNCH, until: tomorrow() }),
      query('count', { since: daysAgo(6), until: tomorrow() }),
    ]);
    return new Response(JSON.stringify({ visitors: all.visitors, pageviews: all.pageviews, week: week.visitors }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=600, stale-while-revalidate=3600' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
}
