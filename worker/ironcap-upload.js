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
 * Deploy (about five minutes, free tier) — see worker/wrangler.toml:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy -c worker/wrangler.toml
 *   3. wrangler secret put BOT_TOKEN  -c worker/wrangler.toml   # from @BotFather
 *      wrangler secret put CHAT_ID    -c worker/wrangler.toml   # numeric chat id
 *      wrangler secret put UPLOAD_KEY -c worker/wrangler.toml   # optional ?k=...
 *   4. Paste the resulting URL into the app's Settings.
 *
 * wrangler.toml can bind this to a subdomain of your own zone, in which case
 * Cloudflare creates the DNS record and certificate itself.
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

    // Self-check. Reports the NAMES bound to this Worker and whether each has
    // a usable value — never the values themselves. Listing the real names
    // catches the cases a "looks correct" glance cannot: a stray space, or a
    // Cyrillic О/Т/А inside an otherwise Latin name, which renders identically
    // but is a different key entirely.
    if (new URL(request.url).pathname === '/health') {
      const names = Object.keys(env).sort();
      const describe = (k) => {
        const v = env[k];
        return {
          type: typeof v,
          empty: !v,
          length: typeof v === 'string' ? v.length : null,
          asciiName: /^[A-Za-z0-9_]+$/.test(k),
        };
      };
      const detail = {};
      for (const k of names) detail[k] = describe(k);
      return new Response(JSON.stringify({
        ok: true,
        boundNames: names,
        expected: { BOT_TOKEN: names.includes('BOT_TOKEN'), CHAT_ID: names.includes('CHAT_ID') },
        detail,
        hint: names.includes('BOT_TOKEN')
          ? 'names look right'
          : 'BOT_TOKEN is not bound under that exact name — compare it against boundNames above',
      }, null, 1), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (request.method !== 'POST') {
      return new Response('IronCap collector. POST a workout here. Try /health.', { headers: CORS });
    }

    if (!env.BOT_TOKEN || !env.CHAT_ID) {
      return new Response(JSON.stringify({
        ok: false,
        description: 'collector is missing ' +
          (!env.BOT_TOKEN ? 'BOT_TOKEN' : '') +
          (!env.BOT_TOKEN && !env.CHAT_ID ? ' and ' : '') +
          (!env.CHAT_ID ? 'CHAT_ID' : '') +
          ' — add it under Settings > Variables and Secrets, then Deploy again',
      }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // Optional shared key, so a leaked URL alone is not enough to post.
    if (env.UPLOAD_KEY) {
      const given = new URL(request.url).searchParams.get('k');
      if (given !== env.UPLOAD_KEY) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
    }

    // Only the upload path. Scanners hammer / and random paths.
    const path = new URL(request.url).pathname;
    if (path !== '/upload' && path !== '/') {
      return new Response('not here', { status: 404, headers: CORS });
    }

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return new Response('bad json', { status: 400, headers: CORS });
    }

    // Shape check. A public URL gets found within minutes — new certificates
    // are published to Certificate Transparency logs and crawlers follow them.
    // Observed in the wild here: GraphQL introspection probes, anti-bot
    // challenge payloads and bare {}. Anything that is not recognisably an
    // IronCap upload is dropped before it can reach the chat.
    const looksLikeIronCap =
      body && typeof body === 'object' &&
      body.app === 'IronCap' &&
      typeof body.participant === 'string' &&
      /^p_[a-z0-9]{4,12}$/.test(body.participant) &&
      body.payload && typeof body.payload === 'object' &&
      (Array.isArray(body.payload.sets) || body.payload.test === true);
    if (!looksLikeIronCap) {
      return new Response(JSON.stringify({ ok: false, description: 'not an IronCap upload' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
