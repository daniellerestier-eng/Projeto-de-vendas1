'use strict';
const crypto = require('node:crypto');
const { err, uuid } = require('./util');
const { tx } = require('./db');
const { applyGive, rewardMult, passFix } = require('./game');

/**
 * Catálogo de itens pagos (preço em centavos de R$). Edite à vontade.
 * give.coinsVm é multiplicado pelo nível da vila do jogador na hora do crédito.
 */
const CATALOG = [
  { id: 'starter', title: 'Oferta Iniciante', desc: '150 giros + 100 gemas + 2 petiscos', price: 290, give: { spins: 150, gems: 100, petiscos: 2 }, once: true, tag: 'SÓ 1 VEZ', icon: 'starter', tab: 'ofertas' },
  { id: 'mega_box', title: 'Caixa Mega Capi', desc: '600 giros + 300 gemas + 5 petiscos + 3 escudos', price: 2990, give: { spins: 600, gems: 300, petiscos: 5, shields: 3 }, tag: '-60%', icon: 'chest', tab: 'ofertas' },
  { id: 'spins_100', title: '100 giros', price: 490, give: { spins: 100 }, icon: 'spins', tab: 'giros' },
  { id: 'spins_400', title: '400 giros', price: 1490, give: { spins: 400 }, tag: 'Popular', icon: 'spins', tab: 'giros' },
  { id: 'spins_1200', title: '1.200 giros', price: 3990, give: { spins: 1200 }, tag: 'Melhor valor', icon: 'spins', tab: 'giros' },
  { id: 'gems_120', title: '120 gemas', price: 490, give: { gems: 120 }, icon: 'gems', tab: 'gemas' },
  { id: 'gems_650', title: '650 gemas', price: 1990, give: { gems: 650 }, tag: 'Popular', icon: 'gems', tab: 'gemas' },
  { id: 'gems_1500', title: '1.500 gemas', price: 3990, give: { gems: 1500 }, tag: 'Melhor valor', icon: 'gems', tab: 'gemas' },
  { id: 'coins_s', title: 'Saco de moedas', price: 490, give: { coinsVm: 600000 }, icon: 'coins', tab: 'moedas' },
  { id: 'coins_m', title: 'Baú de moedas', price: 1490, give: { coinsVm: 2200000 }, tag: 'Popular', icon: 'coins', tab: 'moedas' },
  { id: 'coins_l', title: 'Cofre de moedas', price: 3990, give: { coinsVm: 7000000 }, tag: 'Melhor valor', icon: 'coins', tab: 'moedas' },
  // Mega Atualização 2: Passe do Carnaval, roupas exclusivas da Capi e Roda da Sorte Premium
  { id: 'pass_premium', title: 'Passe Premium', desc: 'Libera a trilha premium do Passe do Carnaval nesta temporada', price: 1490, give: { passPremium: 1 }, tag: 'TEMPORADA', icon: 'pass', tab: 'especial', kind: 'pass' },
  { id: 'pass_plus', title: 'Passe Premium + 10 níveis', desc: 'Trilha premium e já sobe 10 níveis do passe', price: 2990, give: { passPremium: 1, passTiers: 10 }, tag: '+10 NÍVEIS', icon: 'pass', tab: 'especial', kind: 'pass' },
  { id: 'outfit_folia', title: 'Roupa Folia', desc: 'Cocar de plumas · +1 ficha a cada barra cheia', price: 990, give: { outfit: 'folia' }, tag: 'EXCLUSIVA', icon: 'outfit_folia', tab: 'especial', outfit: 'folia' },
  { id: 'outfit_rainha', title: 'Rainha da Bateria', desc: 'Coroa e colar de ouro · +10% moedas em tudo', price: 1990, give: { outfit: 'rainha' }, tag: 'LENDÁRIA', icon: 'outfit_rainha', tab: 'especial', outfit: 'rainha' },
  { id: 'pwheel_1', title: '1 giro na Roda Premium', desc: 'Prêmios de até 2.000 giros', price: 490, give: { pwheel: 1 }, icon: 'pwheel', tab: 'especial' },
  { id: 'pwheel_6', title: '6 giros na Roda Premium', desc: 'Pague 5, leve 6', price: 1990, give: { pwheel: 6 }, tag: '+1 GRÁTIS', icon: 'pwheel', tab: 'especial' },
];
/** Items that make no sense to buy again right now (already owned / already active). */
function owned(u, it, now = Date.now()) {
  if (it.once && u.st.starterBought) return true;
  if (it.outfit && u.st.outfit && Array.isArray(u.st.outfit.owned) && u.st.outfit.owned.includes(it.outfit)) return true;
  if (it.kind === 'pass' && passFix(u.st, now).premium) return true;
  return false;
}

class Payments {
  constructor(db, game, cfg) {
    this.db = db; this.game = game; this.cfg = cfg;
    this.api = (cfg.mpApiBase || 'https://api.mercadopago.com').replace(/\/$/, '');
  }

  enabled() { return !!this.cfg.mpAccessToken; }

  catalogFor(u) {
    const vm = rewardMult(u.st.village);
    return CATALOG.filter((it) => !owned(u, it)).map((it) => ({
      id: it.id, title: it.title, desc: it.desc || null, price: it.price, tag: it.tag || null, icon: it.icon, tab: it.tab,
      give: it.give.coinsVm ? { ...it.give, coins: Math.round(it.give.coinsVm * vm / 1000) * 1000, coinsVm: undefined } : it.give,
    }));
  }

  async mp(method, path, body, idem) {
    const headers = { Authorization: `Bearer ${this.cfg.mpAccessToken}`, 'Content-Type': 'application/json' };
    if (idem) headers['X-Idempotency-Key'] = idem;
    const res = await fetch(this.api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      console.error('[mercadopago]', method, path, res.status, text.slice(0, 400));
      throw err(502, 'mp_error', (j && (j.message || j.error)) ? `Mercado Pago: ${j.message || j.error}` : 'Falha ao falar com o Mercado Pago.');
    }
    return j;
  }

  static expiry(now, minutes) {
    // ISO 8601 with Brazil offset, as Mercado Pago expects: 2026-10-10T18:30:00.000-03:00
    const d = new Date(now + minutes * 60e3 - 3 * 3600e3);
    return d.toISOString().replace('Z', '-03:00');
  }

  async createPix(u, itemId, now = Date.now()) {
    if (!this.enabled()) throw err(503, 'payments_off', 'Pagamentos indisponíveis no momento. Tente mais tarde.');
    const it = CATALOG.find((c) => c.id === itemId);
    if (!it) throw err(400, 'bad_item', 'Item inválido.');
    if (it.once && u.st.starterBought) throw err(409, 'once', 'Essa oferta só pode ser comprada uma vez.');
    if (owned(u, it, now)) throw err(409, 'owned', 'Você já tem esse item.');
    // Reuse a still-valid pending order for the same item (avoids many open PIX charges)
    const open = this.db.prepare(`SELECT * FROM orders WHERE user_id = ? AND item_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`).get(u.row.id, itemId, now + 60e3);
    if (open) return this.orderView(open);
    const id = uuid();
    const email = u.row.email || `jogador${u.row.id}@capicoin.app`;
    const body = {
      transaction_amount: it.price / 100,
      description: `Capi Coin - ${it.title}`,
      payment_method_id: 'pix',
      external_reference: id,
      date_of_expiration: Payments.expiry(now, 30),
      payer: { email, first_name: u.row.name },
      metadata: { order_id: id, user_id: u.row.id, item_id: it.id },
    };
    if (/^https:\/\//.test(this.cfg.publicUrl || '')) body.notification_url = this.cfg.publicUrl.replace(/\/$/, '') + '/webhooks/mercadopago';
    const p = await this.mp('POST', '/v1/payments', body, id);
    const td = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
    this.db.prepare(`INSERT INTO orders (id, user_id, item_id, amount_cents, status, mp_payment_id, qr, qr_b64, ticket_url, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, u.row.id, it.id, it.price, p.status || 'pending', String(p.id), td.qr_code || null, td.qr_code_base64 || null, td.ticket_url || null, now + 30 * 60e3, now);
    return this.orderView(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  }

  orderView(o) {
    const it = CATALOG.find((c) => c.id === o.item_id) || {};
    return { orderId: o.id, itemId: o.item_id, title: it.title, amount: o.amount_cents, status: o.status, credited: !!o.credited, qr: o.qr, qrBase64: o.qr_b64, ticketUrl: o.ticket_url, expiresAt: o.expires_at };
  }

  /** Checks the payment with Mercado Pago and credits the order exactly once. */
  async check(orderId, now = Date.now()) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw err(404, 'no_order', 'Pedido não encontrado.');
    if (o.credited || !o.mp_payment_id || !this.enabled()) return { order: this.orderView(o), justCredited: false };
    const p = await this.mp('GET', `/v1/payments/${encodeURIComponent(o.mp_payment_id)}`);
    const status = String(p.status || 'pending');
    const amountOk = Math.round(Number(p.transaction_amount) * 100) === o.amount_cents;
    const refOk = String(p.external_reference || '') === o.id;
    let justCredited = false;
    if (status === 'approved' && amountOk && refOk) justCredited = this.credit(o.id, now);
    else if (status !== o.status) this.db.prepare('UPDATE orders SET status = ? WHERE id = ? AND credited = 0').run(status, o.id);
    return { order: this.orderView(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)), justCredited };
  }

  credit(orderId, now) {
    return tx(this.db, () => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o || o.credited) return false;
      const it = CATALOG.find((c) => c.id === o.item_id);
      const u = this.game.load(o.user_id);
      if (!it || !u) return false;
      const got = applyGive(u.st, it.give, now);
      if (it.once) u.st.starterBought = true;
      u.st.purchases = (u.st.purchases || 0) + 1;
      this.game.save(u, now, false);
      this.db.prepare(`UPDATE orders SET status = 'approved', credited = 1, paid_at = ? WHERE id = ?`).run(now, o.id);
      this.game.addEvent(o.user_id, 'payment', null, { item: it.title, got }, now);
      console.log(`[pix] pedido ${o.id} creditado (${it.id}) para usuário ${o.user_id}`);
      return true;
    });
  }

  /** Validates Mercado Pago's x-signature header when MP_WEBHOOK_SECRET is set. */
  validSignature(headers, dataId) {
    const secret = this.cfg.mpWebhookSecret;
    if (!secret) return true;
    const sig = String(headers['x-signature'] || '');
    const reqId = String(headers['x-request-id'] || '');
    const parts = Object.fromEntries(sig.split(',').map((kv) => kv.trim().split('=')));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${reqId};ts:${parts.ts};`;
    const h = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts.v1)); } catch (_) { return false; }
  }

  async webhook(query, body, headers) {
    const dataId = (body && body.data && body.data.id) || query['data.id'] || query.id;
    const type = (body && (body.type || body.topic)) || query.type || query.topic;
    if (!dataId || (type && !String(type).includes('payment'))) return { ignored: true };
    if (!this.validSignature(headers, dataId)) { console.warn('[webhook] assinatura inválida'); return { ignored: true }; }
    let o = this.db.prepare('SELECT id FROM orders WHERE mp_payment_id = ?').get(String(dataId));
    if (!o) {
      const p = await this.mp('GET', `/v1/payments/${encodeURIComponent(dataId)}`);
      if (p.external_reference) o = this.db.prepare('SELECT id FROM orders WHERE id = ?').get(String(p.external_reference));
      if (o) this.db.prepare('UPDATE orders SET mp_payment_id = ? WHERE id = ?').run(String(dataId), o.id);
    }
    if (!o) return { ignored: true };
    const r = await this.check(o.id);
    return { ok: true, credited: r.order.credited };
  }

  /** Background sweep: confirms recent pending orders even if no webhook arrives. */
  async sweep(now = Date.now()) {
    if (!this.enabled()) return;
    const rows = this.db.prepare(`SELECT id FROM orders WHERE status = 'pending' AND credited = 0 AND created_at > ? LIMIT 20`).all(now - 2 * 3600e3);
    for (const r of rows) { try { await this.check(r.id, now); } catch (e) { /* retry next sweep */ } }
  }
}

module.exports = { Payments, CATALOG };
