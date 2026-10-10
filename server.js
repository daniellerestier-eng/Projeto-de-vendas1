'use strict';
const http = require('node:http');
const path = require('node:path');
const { loadEnv, ApiError, err } = require('./util');

loadEnv(path.join(__dirname, '.env'));

const db_ = require('./db');
const { Game } = require('./game');
const { Auth } = require('./auth');
const { Payments } = require('./pay');

function config() {
  return {
    port: Number(process.env.PORT || 3000),
    publicUrl: process.env.PUBLIC_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${process.env.PORT || 3000}`),
    dbFile: process.env.DB_FILE
      || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'capicoin.db') : path.join(__dirname, 'data', 'capicoin.db')),
    mpAccessToken: process.env.MP_ACCESS_TOKEN || '',
    mpWebhookSecret: process.env.MP_WEBHOOK_SECRET || '',
    mpApiBase: process.env.MP_API_BASE || 'https://api.mercadopago.com',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    appScheme: process.env.APP_SCHEME || 'capicoin',
  };
}

function createServer(cfg = config()) {
  const db = db_.open(cfg.dbFile);
  const game = new Game(db);
  const auth = new Auth(db, game, cfg);
  const pay = new Payments(db, game, cfg);
  game.ensureBots(40);

  // ---------------------------------------------------------------- tiny router
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth, rate: opts.rate });
  };
  const GET = (p, o, h) => route('GET', p, o, h);
  const POST = (p, o, h) => route('POST', p, o, h);

  // simple per-IP rate limiter for auth/payment endpoints
  const buckets = new Map();
  function limited(ip, key, max, windowMs) {
    const k = ip + '|' + key, now = Date.now();
    let b = buckets.get(k);
    if (!b || now - b.t > windowMs) { b = { t: now, n: 0 }; buckets.set(k, b); }
    b.n++;
    if (buckets.size > 5000) for (const [kk, v] of buckets) if (now - v.t > windowMs) buckets.delete(kk);
    return b.n > max;
  }

  /** Loads the user, runs fn, and appends the fresh profile to the response. */
  const withUser = (fn) => async (ctx) => {
    const u = game.load(ctx.userId);
    if (!u) throw err(401, 'no_user', 'Conta não encontrada.');
    const now = Date.now();
    const out = await fn(u, ctx, now);
    const fresh = game.load(ctx.userId);
    return { ...out, profile: game.profile(fresh, now) };
  };

  // ---------------------------------------------------------------- public
  GET('/health', {}, async () => ({ ok: true, name: 'Capi Coin', version: 2, payments: pay.enabled(), google: auth.googleEnabled() }));

  POST('/auth/guest', { rate: [20, 60e3] }, async (ctx) => auth.guest(ctx.body.deviceId, ctx.body.name, Date.now()));
  POST('/auth/register', { rate: [10, 60e3] }, async (ctx) => auth.register(ctx.body.email, ctx.body.password, ctx.body.name, ctx.userId, Date.now()));
  POST('/auth/login', { rate: [15, 60e3] }, async (ctx) => auth.login(ctx.body.email, ctx.body.password, Date.now()));
  POST('/auth/logout', { auth: true }, async (ctx) => { auth.logout(ctx.token); return { ok: true }; });
  GET('/auth/google/start', { rate: [20, 60e3] }, async (ctx) => {
    let link = null;
    if (ctx.query.link) link = auth.resolve(ctx.query.link);
    try { return { redirect: auth.googleStart(link) }; }
    catch (e) { return { html: auth.bouncePage('', e.message), status: 200 }; }
  });
  GET('/auth/google/callback', {}, async (ctx) => {
    if (ctx.query.error) return { html: auth.bouncePage('', 'Login cancelado.') };
    try { const r = await auth.googleCallback(String(ctx.query.code || ''), String(ctx.query.state || ''), Date.now()); return { html: auth.bouncePage(r.token) }; }
    catch (e) { console.error('[google]', e.message); return { html: auth.bouncePage('', e.message || 'Falha no login com Google.') }; }
  });

  POST('/webhooks/mercadopago', {}, async (ctx) => {
    try { await pay.webhook(ctx.query, ctx.body, ctx.headers); } catch (e) { console.error('[webhook]', e.message); }
    return { ok: true };
  });

  // ---------------------------------------------------------------- game (auth required)
  GET('/api/profile', { auth: true }, async (ctx) => {
    const u = game.load(ctx.userId);
    if (!u) throw err(401, 'no_user', 'Conta não encontrada.');
    const now = Date.now();
    const bonus = game.touch(u, now);
    game.save(u, now);
    return { profile: game.profile(u, now), dailyBonus: bonus, wheel: game.wheelInfo(u.st), chests: game.chestList(u.st), gemShop: game.gemShop(u.st), payments: pay.enabled(), google: auth.googleEnabled() };
  });
  POST('/api/profile/name', { auth: true }, withUser(async (u, ctx, now) => {
    const n = String(ctx.body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
    if (n.length < 2) throw err(400, 'bad_name', 'Nome muito curto.');
    u.row.name = n;
    if (Number.isInteger(ctx.body.avatar) && ctx.body.avatar >= 0 && ctx.body.avatar < 6) u.row.avatar = ctx.body.avatar;
    game.save(u, now);
    return { ok: true };
  }));
  POST('/api/spin', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.spin(u, Number(ctx.body.bet) || 1, now) })));
  POST('/api/build', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.build(u, Number(ctx.body.slot), now) })));
  POST('/api/village/next', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.nextVillage(u, now) })));
  POST('/api/attack/start', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.attackStart(u, Number(ctx.body.targetId) || null, now) })));
  POST('/api/attack/hit', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.attackHit(u, Number(ctx.body.targetId), Number(ctx.body.slot), now) })));
  POST('/api/raid/start', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.raidStart(u, now) })));
  POST('/api/raid/dig', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.raidDig(u, Number(ctx.body.spot), now) })));
  POST('/api/wheel/spin', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.wheelSpin(u, now) })));
  POST('/api/chest/buy', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.chestBuy(u, Number(ctx.body.kind), now) })));
  POST('/api/gems/buy', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.gemBuy(u, String(ctx.body.id), now) })));
  POST('/api/pets/feed', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.petFeed(u, String(ctx.body.pet), now) })));
  POST('/api/pets/select', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.petSelect(u, String(ctx.body.pet), now) })));
  POST('/api/pets/unlock', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.petUnlock(u, String(ctx.body.pet), now) })));
  POST('/api/missions/claim', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.missionClaim(u, ctx.body.id === 'all' ? 'all' : Number(ctx.body.id), now) })));

  GET('/api/friends', { auth: true }, withUser(async (u, ctx, now) => ({ friends: game.friends(u, now) })));
  POST('/api/friends/add', { auth: true, rate: [30, 60e3] }, withUser(async (u, ctx, now) => ({ result: game.friendAdd(u, ctx.body.code, now) })));
  POST('/api/friends/respond', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.friendRespond(u, Number(ctx.body.id), !!ctx.body.accept, now) })));
  POST('/api/friends/remove', { auth: true }, withUser(async (u, ctx) => ({ result: game.friendRemove(u, Number(ctx.body.id)) })));
  POST('/api/friends/gift', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.giftSend(u, Number(ctx.body.id), now) })));
  POST('/api/friends/giftAll', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.giftAll(u, now) })));
  POST('/api/gifts/collect', { auth: true }, withUser(async (u, ctx, now) => ({ result: game.giftsCollect(u, now) })));

  GET('/api/events', { auth: true }, withUser(async (u) => ({ events: game.events(u) })));
  GET('/api/events/poll', { auth: true }, async (ctx) => {
    const u = game.load(ctx.userId);
    if (!u) throw err(401, 'no_user', 'Conta não encontrada.');
    return { events: game.eventsSince(u, Number(ctx.query.after) || 0) };
  });
  GET('/api/leaderboard', { auth: true }, withUser(async (u) => ({ leaderboard: game.leaderboard(u) })));

  // ---------------------------------------------------------------- payments
  GET('/api/shop', { auth: true }, withUser(async (u) => ({ items: pay.catalogFor(u), payments: pay.enabled() })));
  POST('/api/pay/pix', { auth: true, rate: [12, 60e3] }, withUser(async (u, ctx, now) => ({ order: await pay.createPix(u, String(ctx.body.itemId), now) })));
  GET('/api/pay/status/:id', { auth: true }, async (ctx) => {
    const o = db.prepare('SELECT user_id FROM orders WHERE id = ?').get(ctx.params.id);
    if (!o || o.user_id !== ctx.userId) throw err(404, 'no_order', 'Pedido não encontrado.');
    const r = await pay.check(ctx.params.id);
    const u = game.load(ctx.userId);
    return { order: r.order, justCredited: r.justCredited, profile: game.profile(u, Date.now()) };
  });

  // ---------------------------------------------------------------- http plumbing
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    const send = (status, obj, extraHeaders = {}) => {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
      res.end(body);
    };
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(404, { error: 'not_found', message: 'Rota não encontrada.' });
      const ip = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      if (r.rate && limited(ip, url.pathname, r.rate[0], r.rate[1])) return send(429, { error: 'rate_limited', message: 'Muitas tentativas. Espere um pouco.' });
      const m = url.pathname.match(r.re);
      const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 200_000) throw err(413, 'too_big', 'Requisição grande demais.'); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) { try { body = JSON.parse(raw); } catch (_) { body = Object.fromEntries(new URLSearchParams(raw)); } }
      }
      const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
      const userId = tok ? auth.resolve(tok) : null;
      if (r.auth && !userId) return send(401, { error: 'unauthorized', message: 'Faça login novamente.' });
      const ctx = { req, params, query: Object.fromEntries(url.searchParams), body: body || {}, headers: req.headers, token: tok, userId, ip };
      const out = await r.handler(ctx);
      if (out && out.redirect) { res.writeHead(302, { Location: out.redirect }); return res.end(); }
      if (out && out.html) return send(out.status || 200, out.html);
      send(200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.code, message: e.message });
      console.error('[erro]', req.method, url.pathname, e);
      send(500, { error: 'server_error', message: 'Erro no servidor.' });
    } finally {
      if (process.env.LOG_REQUESTS) console.log(req.method, url.pathname, res.statusCode, Date.now() - started + 'ms');
    }
  });

  const sweeper = setInterval(() => { pay.sweep().catch(() => {}); }, 45_000);
  sweeper.unref();
  server.on('close', () => { clearInterval(sweeper); try { db.close(); } catch (_) {} });
  return { server, db, game, auth, pay, cfg };
}

if (require.main === module) {
  const cfg = config();
  const { server, pay, auth } = createServer(cfg);
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`\n  🪙 Capi Coin servidor rodando em http://0.0.0.0:${cfg.port}`);
    console.log(`     URL pública: ${cfg.publicUrl}`);
    console.log(`     PIX Mercado Pago: ${pay.enabled() ? 'ATIVO' : 'desligado (defina MP_ACCESS_TOKEN no .env)'}`);
    console.log(`     Login Google: ${auth.googleEnabled() ? 'ATIVO' : 'desligado (defina GOOGLE_CLIENT_ID/SECRET no .env)'}\n`);
  });
}

module.exports = { createServer, config };
