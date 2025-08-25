// api/check.js
export const config = {
  runtime: "nodejs20.x", // Wajib: jangan Edge runtime
  maxDuration: 60,       // kasih waktu max 60 detik
  memory: 1024           // RAM lebih lega
};


import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const ACCOUNTS  = (process.env.ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional: pakai Upstash/Vercel KV untuk anti-spam (status terakhir)
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  return result;
}
async function redisSetEx(key, value, seconds) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ex: seconds })
  });
}

async function checkOne(page, username) {
  const profileUrl = `https://www.tiktok.com/@${username}`;
  const liveUrl = `https://www.tiktok.com/@${username}/live`;

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1500);

  // Coba baca SIGI_STATE untuk roomId atau flag LIVE
  const res = await page.evaluate(() => {
    const out = { live: false, roomId: null, title: null };
    try {
      const state = globalThis.SIGI_STATE || null;
      if (state) {
        const s = JSON.stringify(state);
        const m = s.match(/"roomId":"?(\d{8,})"?/);
        if (m) out.live = true, out.roomId = m[1];
        // coba ambil title jika ada
        const t = s.match(/"title":"([^"]{1,120})"/);
        if (t) out.title = t[1];
      }
    } catch {}
    return out;
  });

  // Fallback badge LIVE
  if (!res.live) {
    try {
      const badge = await page.$x("//*[contains(., 'LIVE')]");
      if (badge && badge.length) res.live = true;
    } catch {}
  }

  return { username, ...res, profileUrl, liveUrl };
}

export default async function handler(req, res) {
  // validasi secret token
  if (process.env.CRON_SECRET && req.query.token !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

if (req.query.ping === '1') {
  await sendTelegram('✅ Ping OK — token & env valid.');
  return res.status(200).json({ ok: true, ping: true });
}
  if (req.query.test === '1') {
    await sendTelegram(
      "🔴 <b>TEST</b>: seolah-olah akun X sedang LIVE.\nTonton: https://www.tiktok.com/@akunX/live"
    );
    return res.status(200).json({ ok: true, test: 'notif dummy terkirim' });
  }
  
  if (!BOT_TOKEN || !CHAT_ID || ACCOUNTS.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing env: BOT_TOKEN, CHAT_ID, ACCOUNTS' });
  }

  // Launch Chromium yang kompatibel dengan Vercel
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
    executablePath,
    headless: chromium.headless
  });

  const page = await browser.newPage();

  const results = [];
  try {
    for (const username of ACCOUNTS) {
      try {
        const st = await checkOne(page, username);
        results.push(st);

        // Anti-spam: kirim hanya saat transisi OFF->ON (pakai Upstash Redis kalau ada)
        const key = `live:${username}`;
        const prev = await redisGet(key); // "1" atau null
        if (st.live) {
          if (prev !== '1') {
            const title = st.title ? `\nJudul: ${st.title}` : '';
            await sendTelegram(`🔴 <b>${username}</b> sedang LIVE!${title}\nTonton: ${st.liveUrl}\nProfil: ${st.profileUrl}`);
            // set flag live selama 2 jam (sesuaikan)
            await redisSetEx(key, '1', 2 * 60 * 60);
          }
        } else {
          // reset flag biar bisa notif lagi ketika live berikutnya
          await redisSetEx(key, '0', 10 * 60);
        }
      } catch (e) {
        results.push({ username, error: e.message || String(e) });
      }
      // kecilkan beban & hindari block
      await page.waitForTimeout(1500);
    }
  } finally {
    await browser.close();
  }

  res.status(200).json({ ok: true, results });
}

