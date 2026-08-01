/**
 * IronCap collector — a Cloudflare Worker that receives workout uploads and
 * forwards them to Telegram as a file.
 *
 * Why this exists: the app used to call the Telegram Bot API directly, which
 * meant a bot token had to be typed into every tester's phone. Here the token
 * is a Worker secret instead. Testers only ever hold a URL, and a URL is not a
 * credential — the worst it permits is someone posting junk to your own chat,
 * which you fix by rotating the URL.
 *
 * Deploy (about five minutes, free tier):
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy worker/ironcap-upload.js --name ironcap-upload
 *   3. wrangler secret put BOT_TOKEN     # from @BotFather
 *      wrangler secret put CHAT_ID       # your numeric chat id
 *      wrangler secret put UPLOAD_KEY    # optional: adds ?k=... to the URL
 *   4. Paste https://ironcap-upload.<you>.workers.dev/upload into the app.
 *
 * The app posts text/plain on purpose, so this stays a "simple" CORS request
 * and no preflight is involved. OPTIONS is still handled for good measure.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') {
      return new Response('IronCap collector. POST a workout here.', { headers: CORS });
    }

    // Optional shared key, so a leaked URL alone is not enough to post.
    if (env.UPLOAD_KEY) {
      const given = new URL(request.url).searchParams.get('k');
      if (given !== env.UPLOAD_KEY) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
    }

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return new Response('bad json', { status: 400, headers: CORS });
    }

    const name = String(body.name || 'ironcap.json').replace(/[^\w.\-]/g, '_');
    const caption = String(body.caption || '').slice(0, 1000);
    const file = JSON.stringify(body.payload ?? body);

    // Telegram caps bot uploads at 50 MB; a workout is a few hundred KB.
    const form = new FormData();
    form.append('chat_id', env.CHAT_ID);
    form.append('document', new Blob([file], { type: 'application/json' }), name);
    if (caption) form.append('caption', caption);

    const tg = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
      { method: 'POST', body: form }
    );
    const result = await tg.json().catch(() => ({ ok: false }));

    if (!result.ok) {
      // Surface the reason so the app's retry queue can be debugged.
      return new Response(JSON.stringify(result), { status: 502, headers: CORS });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
