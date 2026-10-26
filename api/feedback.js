// POST /api/feedback — stores one visitor message privately. No owner details are exposed.
import { json, visitor, recent, mark, writeJson } from './_lib.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Emails the new feedback to the owner when RESEND_API_KEY and NOTIFY_EMAIL are set in Vercel.
// The address lives only in the project settings; failures never block saving the feedback.
async function notify(item) {
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  const from = process.env.NOTIFY_FROM || 'cad2pdf <onboarding@resend.dev>';
  const rows = item.settings ? Object.entries(item.settings).filter(([, v]) => v !== '').map(([k, v]) => `<tr><td style="color:#5b6776;padding:2px 12px 2px 0">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') : '';
  const html = `<div style="font:15px/1.6 system-ui,'PingFang SC','Microsoft YaHei',sans-serif;color:#18202b">
    <p style="margin:0 0 8px;color:#5b6776">${esc(new Date(item.at).toLocaleString('zh-CN', { timeZone: 'America/Chicago', hour12: false }))}（休斯顿时间）</p>
    <div style="white-space:pre-wrap;border-left:3px solid #1d5bb8;padding:6px 12px;background:#f3f6fa">${esc(item.message)}</div>
    <p>联系方式：${item.contact ? esc(item.contact) : '（未填）'}</p>
    ${rows ? `<table style="font-size:13px;border-collapse:collapse">${rows}</table>` : ''}
    <p style="font-size:12px;color:#5b6776">${esc(item.ua)}</p>
    <p><a href="https://5cad2pdf.com/admin">打开意见管理页</a></p></div>`;
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.contact || '');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: to.split(',').map((x) => x.trim()).filter(Boolean),
      subject: `cad2pdf 新意见：${item.message.replace(/\s+/g, ' ').slice(0, 40)}`, html,
      ...(emailish ? { reply_to: item.contact } : {}) }),
  });
  if (!r.ok) console.error('notify failed', r.status, (await r.text()).slice(0, 300));
}

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
  const item = {
    id, at: new Date().toISOString(), message, contact: clip(body.contact, 200),
    lang: clip(body.lang, 10), settings, ua: clip(request.headers.get('user-agent') || '', 300), done: false,
  };
  await writeJson(`feedback/${id}.json`, item);
  try { await notify(item); } catch (e) { console.error('notify error', e && e.message); }
  return json(200, { ok: true });
}
