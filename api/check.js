// api/check.js
export const config = { runtime: "nodejs", maxDuration: 60 };

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.Chat_ID || process.env.CHAT_ID; // jaga-jaga salah kapital
const ACCOUNTS  = (process.env.ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await r.json(); if (!j.ok) console.error('[telegram error]', j); return j;
}
async function redisGet(k){ if(!REDIS_URL||!REDIS_TOKEN) return null;
  const r=await fetch(`${REDIS_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); if(!r.ok) return null;
  const {result}=await r.json(); return result;
}
async function redisSetEx(k,v,s){ if(!REDIS_URL||!REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`,{
    method:'POST', headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body: JSON.stringify({ ex: s })
  });
}

async function checkOne(page, username){
  const profileUrl = `https://www.tiktok.com/@${username}`;
  const liveUrl    = `https://www.tiktok.com/@${username}/live`;

  await page.goto(profileUrl, { waitUntil:'domcontentloaded', timeout: 45_000 });
  await sleep(1500);

  const res = await page.evaluate(() => {
    const out = { live:false, roomId:null, title:null };
    try {
      const state = globalThis.SIGI_STATE || null;
      if (state) {
        const s = JSON.stringify(state);
        const m = s.match(/"roomId":"?(\d{8,})"?/); if (m){ out.live=true; out.roomId=m[1]; }
        const t = s.match(/"title":"([^"]{1,120})"/); if (t) out.title = t[1];
      }
    } catch {}
    return out;
  });

  if (!res.live) {
    try { const badge = await page.$x("//*[contains(., 'LIVE')]"); if (badge && badge.length) res.live = true; } catch {}
  }
  return { username, ...res, profileUrl, liveUrl };
}

export default async function handler(req, res){
  try {
    // auth sederhana (opsional)
    if (process.env.CRON_SECRET && req.query.token !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok:false, error:'Unauthorized' });
    }

    // mode tes ringan tanpa Chromium
    if (req.query.ping === '1') {
      await sendTelegram('✅ Ping OK — token & env valid.');
      return res.status(200).json({ ok:true, mode:'ping' });
    }
    if (req.query.test === '1') {
      const who = (req.query.user || 'akunX').trim();
      await sendTelegram(`🔴 <b>TEST</b>: seolah-olah ${who} sedang LIVE.\nTonton: https://www.tiktok.com/@${who}/live`);
      return res.status(200).json({ ok:true, mode:'test', user: who });
    }

    if (!BOT_TOKEN || !CHAT_ID || ACCOUNTS.length === 0) {
      return res.status(400).json({ ok:false, error:'Missing env: BOT_TOKEN, CHAT_ID, ACCOUNTS' });
    }

    const DRY = req.query.status === '1' || req.query.dry === '1';
    const onlyUser = (req.query.user || '').trim();
    const list = onlyUser ? [onlyUser] : ACCOUNTS;

    const executablePath = await chromium.executablePath();
    if (!executablePath) throw new Error('Chromium executablePath null (pastikan runtime "nodejs").');

    const browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: chromium.headless
    });
    const page = await browser.newPage();

    const results = [];
    try {
      for (const username of list) {
        try {
          const st = await checkOne(page, username);
          results.push(st);

          if (!DRY) {
            const key  = `live:${username}`;
            const prev = await redisGet(key);
            if (st.live) {
              if (prev !== '1') {
                const title = st.title ? `\nJudul: ${st.title}` : '';
                await sendTelegram(`🔴 <b>${username}</b> sedang LIVE!${title}\nTonton: ${st.liveUrl}\nProfil: ${st.profileUrl}`);
                await redisSetEx(key, '1', 2*60*60);
              }
            } else {
              await redisSetEx(key, '0', 10*60);
            }
          }
        } catch (e) {
          console.error('[checkOne error]', username, e);
          results.push({ username, error: e.message || String(e) });
        }
        await sleep(1000);
      }
    } finally {
      await browser.close();
    }

    return res.status(200).json({ ok:true, dry:DRY, count:results.length, results });

  } catch (e) {
    console.error('[FATAL] check.js', e);
    return res.status(500).json({ ok:false, error: e.message || 'Internal error' });
  }
}
