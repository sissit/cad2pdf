// Reads this project's Vercel Web Analytics with a token kept in VERCEL_ANALYTICS_TOKEN.
const TEAM = 'team_nRh2eQCVomguoMGEjdj8fpVW', PROJECT = 'prj_lFSppFpBYMSGNCFvhXmxNBxkvdqb';
export const LAUNCH = '2026-10-01T00:00:00.000Z';
export const hasToken = () => !!process.env.VERCEL_ANALYTICS_TOKEN;
const day = 24 * 60 * 60 * 1000;
export const tomorrow = () => new Date(Math.floor(Date.now() / day) * day + day).toISOString();
export const daysAgo = (n) => new Date(Math.floor(Date.now() / day) * day - n * day).toISOString();

export async function query(kind, params) {
  const u = new URL(`https://api.vercel.com/v1/query/web-analytics/visits/${kind}`);
  u.searchParams.set('projectId', PROJECT); u.searchParams.set('teamId', TEAM);
  for (const [k, v] of Object.entries(params)) if (v != null) for (const x of [].concat(v)) u.searchParams.append(k, String(x));
  const r = await fetch(u, { headers: { authorization: `Bearer ${String(process.env.VERCEL_ANALYTICS_TOKEN).trim().replace(/^["']|["']$/g, "")}` } });
  if (!r.ok) { const t = (await r.text()).slice(0, 300); console.error('analytics', kind, r.status, t); throw new Error(`analytics ${r.status}: ${t}`); }
  return (await r.json()).data;
}
