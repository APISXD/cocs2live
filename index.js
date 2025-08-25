// index.js
require("dotenv").config();
const fetch = require("node-fetch");
const { chromium } = require("playwright");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 120000);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Set BOT_TOKEN dan CHAT_ID di .env");
  process.exit(1);
}

const accounts = JSON.parse(fs.readFileSync("./accounts.json", "utf8"));

// Simpan status terakhir agar tidak spam
const lastState = new Map(); // username -> { live: boolean, roomId?: string }

async function sendTelegram(text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Cek status live dari halaman profil
async function checkLiveStatus(page, username) {
  const url = `https://www.tiktok.com/@${username}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Kadang TikTok butuh scroll/idle sebentar agar data JS siap
  await page.waitForTimeout(1500);

  // 1) Coba baca objek global SIGI_STATE yang berisi data user/LiveRoom
  let result = await page.evaluate(() => {
    const out = { live: false, roomId: null };
    try {
      const state = window.SIGI_STATE || window.__UNIVERSAL_DATA__ || null;
      if (state) {
        // Cari LiveRoom/roomId di state
        const stateStr = JSON.stringify(state);
        // deteksi roomId numerik
        const m = stateStr.match(/"roomId":"?(\d{8,})"?/);
        if (m) {
          out.live = true;
          out.roomId = m[1];
        } else {
          // fallback kecil: flag 'LIVE' di teks
          if (
            stateStr.includes('"status":1') &&
            stateStr.toLowerCase().includes("live")
          ) {
            out.live = true;
          }
        }
      }
    } catch (e) {}
    return out;
  });

  // 2) Fallback: cek badge "LIVE" di UI
  if (!result.live) {
    const hasLiveBadge = await page
      .locator("text=LIVE")
      .first()
      .isVisible()
      .catch(() => false);
    if (hasLiveBadge) {
      result.live = true;
    }
  }

  return {
    username,
    ...result,
    profileUrl: url,
    liveUrl: `https://www.tiktok.com/@${username}/live`,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log(`Monitoring ${accounts.length} akun...`);

  async function tick() {
    for (const username of accounts) {
      try {
        const status = await checkLiveStatus(page, username);
        const prev = lastState.get(username) || { live: false };
        if (status.live && !prev.live) {
          const msg =
            `🔴 <b>${username}</b> sedang LIVE!\n` +
            `Jam: ${new Date().toLocaleString("id-ID")}\n` +
            `Tonton: ${status.liveUrl}\n` +
            `Profil: ${status.profileUrl}`;
          await sendTelegram(msg);
        }
        lastState.set(username, {
          live: status.live,
          roomId: status.roomId || null,
        });
      } catch (e) {
        console.error(`[${username}] error:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await tick();

  // ⬇️ mode sekali jalan untuk GitHub Actions
  if (process.env.ONE_TICK === "true") {
    await browser.close();
    process.exit(0);
  }

  // mode lokal (jalan terus)
  const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 120000);
  setInterval(tick, INTERVAL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

sendTelegram(
  "🔴 <b>TEST</b>: seolah-olah akun X sedang LIVE.\nTonton: https://www.tiktok.com/@akunX/live"
);
