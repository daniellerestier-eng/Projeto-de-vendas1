'use strict';
const crypto = require('node:crypto');
const { err, token } = require('./util');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const sessKey = (t) => 'h:' + sha(t);   // stored form of a session token
const SESSION_TTL = 60 * 86400e3;
const MAX_FAILS = 8, FAIL_WINDOW = 15 * 60e3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanName = (n, fallback) => {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
  return s.length >= 2 ? s : fallback;
};

class Auth {
  constructor(db, game, cfg) {
    this.db = db; this.game = game; this.cfg = cfg;
    this.oauthStates = new Map();
    this.oauthCodes = new Map();   // one-time codes handed to the app after Google login
    this.linkCodes = new Map();    // one-time codes to link Google to the current account
    this.fails = new Map();        // failed logins per e-mail
    this.lastSweep = 0;
    this.q = {
      session: db.prepare('SELECT s.token, s.user_id, s.last_used FROM sessions s WHERE s.token = ?'),
      touch: db.prepare('UPDATE sessions SET last_used = ? WHERE token = ?'),
      newSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used) VALUES (?,?,?,?)'),
      delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      byGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
      byDevice: db.prepare('SELECT * FROM users WHERE device_id = ? AND is_guest = 1 ORDER BY id DESC LIMIT 1'),
    };
  }

  /** Sessions are stored as SHA-256 hashes: a leaked database does not leak usable logins. */
  session(userId, now = Date.now()) {
    const t = token();
    this.q.newSession.run(sessKey(t), userId, now, now);
    return t;
  }

  /** Returns user id for a bearer token or null. Sessions unused for 60 days expire. */
  resolve(tok, now = Date.now()) {
    if (!tok || typeof tok !== 'string' || tok.length > 200) return null;
    const h = sessKey(tok);
    let s = this.q.session.get(h);
    if (!s && !tok.startsWith('h:')) { // sessions created before hashing: migrate on first use
      s = this.q.session.get(tok);
      if (s && String(s.token).startsWith('h:')) s = null;
      if (s) this.db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(h, tok);
    }
    if (!s) return null;
    if (now - (s.last_used || now) > SESSION_TTL) { this.q.delSession.run(h); return null; }
    if (now - (s.last_used || 0) > 60e3) this.q.touch.run(now, h);
    if (now - this.lastSweep > 6 * 3600e3) { this.lastSweep = now; this.db.prepare('DELETE FROM sessions WHERE last_used < ?').run(now - SESSION_TTL); }
    return s.user_id;
  }

  logout(tok) { if (tok && !String(tok).startsWith('h:')) { this.q.delSession.run(sessKey(tok)); this.q.delSession.run(tok); } }

  guest(deviceId, name, now) {
    const dev = String(deviceId || '').slice(0, 80);
    if (dev.length < 8) throw err(400, 'bad_device', 'Dispositivo inválido.');
    let row = this.q.byDevice.get(dev);
    let created = false;
    if (!row) {
      const id = this.game.createUser({ name: cleanName(name, 'Capi' + Math.floor(1000 + Math.random() * 9000)), deviceId: dev, guest: true, now });
      row = { id }; created = true;
    }
    return { token: this.session(row.id, now), userId: row.id, created };
  }

  register(email, password, name, currentUserId, now) {
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw err(400, 'bad_email', 'E-mail inválido.');
    if (String(password || '').length < 6) throw err(400, 'weak_password', 'A senha precisa de pelo menos 6 caracteres.');
    if (String(password).length > 200) throw err(400, 'weak_password', 'Senha longa demais.');
    if (this.q.byEmail.get(email)) throw err(409, 'email_taken', 'Este e-mail já tem conta. Faça login.');
    const hash = hashPassword(String(password));
    if (currentUserId) {
      const cur = this.db.prepare('SELECT * FROM users WHERE id = ?').get(currentUserId);
      if (cur && cur.is_guest) { // upgrade guest, keeping progress
        this.db.prepare('UPDATE users SET email = ?, pass_hash = ?, is_guest = 0, name = ? WHERE id = ?').run(email, hash, cleanName(name, cur.name), cur.id);
        return { token: this.session(cur.id, now), userId: cur.id, upgraded: true };
      }
    }
    const id = this.game.createUser({ name: cleanName(name, email.split('@')[0]), email, passHash: hash, now });
    return { token: this.session(id, now), userId: id, created: true };
  }

  login(email, password, now) {
    email = String(email || '').trim().toLowerCase().slice(0, 200);
    const f = this.fails.get(email);
    if (f && now - f.at < FAIL_WINDOW && f.n >= MAX_FAILS) throw err(429, 'locked_out', 'Muitas tentativas com este e-mail. Tente de novo em 15 minutos.');
    const row = this.q.byEmail.get(email);
    if (!row || !checkPassword(String(password || '').slice(0, 200), row.pass_hash)) {
      const cur = f && now - f.at < FAIL_WINDOW ? f : { n: 0, at: now };
      cur.n++; this.fails.set(email, cur);
      if (this.fails.size > 20000) for (const [k, v] of this.fails) if (now - v.at > FAIL_WINDOW) this.fails.delete(k);
      throw err(401, 'bad_login', 'E-mail ou senha incorretos.');
    }
    this.fails.delete(email);
    return { token: this.session(row.id, now), userId: row.id };
  }

  // ------------------------------------------------------------------ Google OAuth (browser flow, no SDK needed in the app)
  googleEnabled() { return !!(this.cfg.googleClientId && this.cfg.googleClientSecret); }
  googleRedirectUri() { return this.cfg.publicUrl.replace(/\/$/, '') + '/auth/google/callback'; }

  /** One-time code (5 min) so the browser never carries the session token when linking Google. */
  linkCode(userId, now = Date.now()) {
    for (const [k, v] of this.linkCodes) if (now - v.at > 5 * 60e3) this.linkCodes.delete(k);
    const c = token(16); this.linkCodes.set(c, { at: now, userId }); return c;
  }
  takeLinkCode(c, now = Date.now()) {
    const v = this.linkCodes.get(String(c || '')); if (!v) return null;
    this.linkCodes.delete(String(c)); return now - v.at <= 5 * 60e3 ? v.userId : null;
  }

  /** [challenge] = sha256(verifier) made by the app; only the app that started the login can redeem the result. */
  googleStart(linkUserId, challenge) {
    if (!this.googleEnabled()) throw err(501, 'google_disabled', 'Login com Google indisponível no momento.');
    if (!/^[a-f0-9]{64}$/.test(String(challenge || ''))) throw err(400, 'old_app', 'Atualize o Capi Coin para entrar com o Google.');
    const state = token(16);
    const now = Date.now();
    for (const [k, v] of this.oauthStates) if (now - v.at > 15 * 60e3) this.oauthStates.delete(k);
    if (this.oauthStates.size > 5000) throw err(429, 'rate_limited', 'Muitas tentativas. Espere um pouco.');
    this.oauthStates.set(state, { at: now, link: linkUserId || null, challenge: String(challenge) });
    const p = new URLSearchParams({
      client_id: this.cfg.googleClientId, redirect_uri: this.googleRedirectUri(), response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }

  async googleCallback(code, state, now) {
    const st = this.oauthStates.get(state);
    if (!st || now - st.at > 15 * 60e3) throw err(400, 'bad_state', 'Sessão de login expirada. Tente de novo.');
    this.oauthStates.delete(state);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: this.cfg.googleClientId, client_secret: this.cfg.googleClientSecret, redirect_uri: this.googleRedirectUri(), grant_type: 'authorization_code' }),
    });
    const j = await res.json();
    if (!res.ok || !j.id_token) throw err(401, 'google_failed', 'O Google recusou o login.');
    const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8'));
    if (payload.aud !== this.cfg.googleClientId || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw err(401, 'google_failed', 'Token do Google inválido.');
    const sub = String(payload.sub), email = payload.email && payload.email_verified ? String(payload.email).toLowerCase() : null;
    let row = this.q.byGoogle.get(sub);
    if (!row && st.link) {
      const cur = this.db.prepare('SELECT * FROM users WHERE id = ?').get(st.link);
      if (cur && cur.is_guest) {
        this.db.prepare('UPDATE users SET google_sub = ?, email = COALESCE(email, ?), is_guest = 0, name = ? WHERE id = ?').run(sub, email && !this.q.byEmail.get(email) ? email : null, cleanName(payload.given_name || payload.name, cur.name), cur.id);
        row = { id: cur.id };
      }
    }
    if (!row && email) {
      const byMail = this.q.byEmail.get(email);
      if (byMail) { this.db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, byMail.id); row = byMail; }
    }
    if (!row) {
      const id = this.game.createUser({ name: cleanName(payload.given_name || payload.name, 'Capi'), email, googleSub: sub, now });
      row = { id };
    }
    // hand the app a one-time code bound to its challenge instead of the session token
    for (const [k, v] of this.oauthCodes) if (now - v.at > 5 * 60e3) this.oauthCodes.delete(k);
    const oneTime = token(24);
    this.oauthCodes.set(oneTime, { at: now, userId: row.id, challenge: st.challenge });
    return { code: oneTime, userId: row.id };
  }

  /** App redeems the one-time code with its verifier. */
  googleExchange(code, verifier, now) {
    const v = this.oauthCodes.get(String(code || ''));
    if (!v) throw err(400, 'bad_code', 'Login expirado. Tente de novo.');
    this.oauthCodes.delete(String(code));
    if (now - v.at > 5 * 60e3 || sha(String(verifier || '')) !== v.challenge) throw err(400, 'bad_code', 'Login expirado. Tente de novo.');
    return { token: this.session(v.userId, now), userId: v.userId };
  }

  /** HTML page that bounces the browser back into the app. */
  bouncePage(code, message) {
    const url = `${this.cfg.appScheme}://login?code=${encodeURIComponent(code || '')}${message ? '&error=' + encodeURIComponent(message) : ''}`;
    const safe = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capi Coin</title><meta http-equiv="refresh" content="0;url=${safe(url)}">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a0b2e;color:#fff;font-family:system-ui,sans-serif;text-align:center}
a{display:inline-block;margin-top:24px;padding:18px 34px;border-radius:40px;background:#43a047;color:#fff;font-weight:800;font-size:20px;text-decoration:none;box-shadow:0 6px 0 #1b5e20}</style></head>
<body><div><div style="font-size:64px">🪙</div><h2>${message ? safe(message) : 'Login concluído!'}</h2><a href="${safe(url)}">Voltar ao Capi Coin</a></div>
<script>setTimeout(function(){location.href=${JSON.stringify(url)}},50)</script></body></html>`;
  }
}

module.exports = { Auth, hashPassword, checkPassword };
