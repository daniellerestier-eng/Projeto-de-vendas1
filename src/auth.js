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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanName = (n, fallback) => {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
  return s.length >= 2 ? s : fallback;
};

class Auth {
  constructor(db, game, cfg) {
    this.db = db; this.game = game; this.cfg = cfg;
    this.oauthStates = new Map();
    this.q = {
      session: db.prepare('SELECT s.token, s.user_id FROM sessions s WHERE s.token = ?'),
      touch: db.prepare('UPDATE sessions SET last_used = ? WHERE token = ?'),
      newSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used) VALUES (?,?,?,?)'),
      delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      byGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
      byDevice: db.prepare('SELECT * FROM users WHERE device_id = ? AND is_guest = 1 ORDER BY id DESC LIMIT 1'),
    };
  }

  session(userId, now = Date.now()) {
    const t = token();
    this.q.newSession.run(t, userId, now, now);
    return t;
  }

  /** Returns user id for a bearer token or null. */
  resolve(tok, now = Date.now()) {
    if (!tok) return null;
    const s = this.q.session.get(tok);
    if (!s) return null;
    this.q.touch.run(now, tok);
    return s.user_id;
  }

  logout(tok) { this.q.delSession.run(tok); }

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
    email = String(email || '').trim().toLowerCase();
    const row = this.q.byEmail.get(email);
    if (!row || !checkPassword(String(password || ''), row.pass_hash)) throw err(401, 'bad_login', 'E-mail ou senha incorretos.');
    return { token: this.session(row.id, now), userId: row.id };
  }

  // ------------------------------------------------------------------ Google OAuth (browser flow, no SDK needed in the app)
  googleEnabled() { return !!(this.cfg.googleClientId && this.cfg.googleClientSecret); }
  googleRedirectUri() { return this.cfg.publicUrl.replace(/\/$/, '') + '/auth/google/callback'; }

  googleStart(linkUserId) {
    if (!this.googleEnabled()) throw err(501, 'google_disabled', 'Login com Google indisponível no momento.');
    const state = token(16);
    const now = Date.now();
    for (const [k, v] of this.oauthStates) if (now - v.at > 15 * 60e3) this.oauthStates.delete(k);
    this.oauthStates.set(state, { at: now, link: linkUserId || null });
    const p = new URLSearchParams({
      client_id: this.cfg.googleClientId, redirect_uri: this.googleRedirectUri(), response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }

  async googleCallback(code, state, now) {
    const st = this.oauthStates.get(state);
    if (!st) throw err(400, 'bad_state', 'Sessão de login expirada. Tente de novo.');
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
    return { token: this.session(row.id, now), userId: row.id };
  }

  /** HTML page that bounces the browser back into the app. */
  bouncePage(tok, message) {
    const url = `${this.cfg.appScheme}://login?token=${encodeURIComponent(tok || '')}${message ? '&error=' + encodeURIComponent(message) : ''}`;
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
