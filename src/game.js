'use strict';
const { err, dayOf, msToNextDay, roundNice, randInt, rand, rnd, pick, shuffle, mulberry32, friendCode, fmt } = require('./util');
const { tx } = require('./db');

// ------------------------------------------------------------------ constants
const MAX_SPINS = 80;
const REGEN_MS = 3 * 60 * 1000;
const MAX_SHIELDS = 3;
const MAX_LEVEL = 5;
const BETS = [1, 2, 3, 5, 10, 20, 50, 100];
const PET_AWAKE_MS = 4 * 3600 * 1000;
const SYM = { COIN: 0, BAG: 1, RAID: 2, HAMMER: 3, SHIELD: 4, ENERGY: 5, CAPI: 6, GEM: 7, TICKET: 8 };
const SYM_COUNT = 9;

const THEMES = [ // Rio de Janeiro edition: 15 islands, each with its own 5 buildings
  ['Morro da Capi', ['Barraco Colorido', "Caixa d'Água", 'Laje do Baile', 'Birosca', 'Quadra de Samba']],
  ['Copacabana', ['Prédio da Orla', 'Posto Salva-Vidas', 'Quiosque de Coco', 'Barraca de Praia', 'Palace Hotel']],
  ['Ipanema', ['Casa do Surfista', 'Mirante do Arpoador', 'Banca de Jornal', 'Feira Hippie', 'Surf Shop']],
  ['Pão de Açúcar', ['Casa da Urca', 'Estação do Bondinho', 'Mirante da Urca', 'Cais dos Pescadores', 'Morro do Bondinho']],
  ['Corcovado', ['Chalé da Serra', 'Trenzinho', 'Capela da Mata', 'Loja de Lembranças', 'Capi Redentora']],
  ['Lapa', ['Sobrado Colonial', 'Arcos da Lapa', 'Escadaria de Azulejos', 'Bar do Samba', 'Catedral Cônica']],
  ['Santa Teresa', ['Casarão', 'Bondinho Amarelo', 'Ateliê do Artista', 'Boteco da Ladeira', 'Parque das Ruínas']],
  ['Maracanã', ['Casa do Torcedor', 'Torre de Refletores', 'Churrasquinho', 'Loja de Camisas', 'Estádio']],
  ['Sambódromo', ['Barracão da Escola', 'Arquibancada', 'Carro Alegórico', 'Ateliê de Fantasias', 'Arco da Apoteose']],
  ['Jardim Botânico', ['Estufa', 'Palmeiras Imperiais', 'Chafariz', 'Orquidário', 'Lago das Vitórias-Régias']],
  ['Floresta da Tijuca', ['Casa na Árvore', 'Cascatinha', 'Mirante da Mata', 'Capelinha', 'Vista Chinesa']],
  ['São Conrado', ['Casa de Vidro', 'Rampa de Voo Livre', 'Quiosque de Açaí', 'Hotel Redondo', 'Pedra da Gávea']],
  ['Barra da Tijuca', ['Condomínio', 'Torre Espelhada', 'Lagoa dos Pedalinhos', 'Food Truck', 'Arena']],
  ['Paquetá', ['Casinha de Paquetá', 'Farol da Ilha', 'Estação das Barcas', 'Peixaria', 'Castelinho']],
  ['Centro do Rio', ['Sobrado do Centro', 'Torre do Relógio', 'Bonde VLT', 'Confeitaria', 'Museu do Futuro']],
];
const themeOf = (v) => THEMES[(v - 1) % THEMES.length];

const PETS = {
  quati: { name: 'Quati Fuçador', role: 'raid', unlockVillage: 2, gemCost: 300, desc: '+1 buraco e mais moedas nos saques' },
  onca: { name: 'Onça Guerreira', role: 'attack', unlockVillage: 4, gemCost: 300, desc: 'Mais moedas nos ataques' },
  tucano: { name: 'Tucano Guardião', role: 'defense', unlockVillage: 6, gemCost: 300, desc: 'Chance de bloquear ataques sem escudo' },
};
const PET_MAX_LEVEL = 10;

const BOT_NAMES = ['Tatu Bandido', 'Onça Pintada', 'Macaco Pirata', 'Tucano Ladrão', 'Jacaré Rei', 'Preguiça Ninja', 'Lobo-Guará',
  'Arara Malandra', 'Quati Esperto', 'Boto Rosa', 'Sagui Fujão', 'Tamanduá Bravo', 'Mico-Leão', 'Ema Veloz', 'Seriema', 'Capivarão',
  'Jabuti Sábio', 'Saci Sapeca', 'Curupira', 'Cuca Malvada'];

// ------------------------------------------------------------------ economy helpers
const rewardMult = (v) => Math.pow(1.5, v - 1);
const costMult = (v) => Math.pow(1.56, v - 1) * (1 + 0.04 * (v - 1));
function buildCost(st, slot, level = st.levels[slot]) {
  return roundNice(2600 * (1 + level * 0.75) * (1 + slot * 0.14) * costMult(st.village));
}
function repairCost(st, slot) { return roundNice(buildCost(st, slot, st.levels[slot]) * 0.5); } // rebuild the level an attack knocked down, half price
const villageProgress = (st) => st.levels.reduce((a, b) => a + b, 0);
const villageComplete = (st) => st.levels.every((l) => l >= MAX_LEVEL) && st.damaged.every((d) => !d);

function newState(now) {
  return {
    v: 2, coins: 5000, gems: 30, spins: MAX_SPINS, lastRegen: now, shields: 1,
    village: 1, levels: [0, 0, 0, 0, 0], damaged: [false, false, false, false, false],
    bet: 1, petiscos: 1,
    pets: { quati: { unlocked: false, level: 1, xp: 0 }, onca: { unlocked: false, level: 1, xp: 0 }, tucano: { unlocked: false, level: 1, xp: 0 } },
    activePet: null, petAwakeUntil: 0,
    wheelDay: -1, missions: null, streak: { lastDay: -1, count: 0 },
    stats: { spins: 0, attacks: 0, raids: 0, builds: 0, bestWin: 0, villages: 0, blocks: 0 },
    pending: { attack: null, raid: null },
    starterBought: false, giftsCollectedDay: -1, giftsCollectedToday: 0,
    recentTargets: [], tickets: 3, ticketProg: 6, trail: null, timed: { day: -1, idx: 0, nextAt: 0 }, lastRaidCheck: now, mini: null,
  };
}

function regen(st, now) {
  if (st.spins >= MAX_SPINS) { st.lastRegen = now; return; }
  const n = Math.floor((now - st.lastRegen) / REGEN_MS);
  if (n > 0) {
    st.spins = Math.min(MAX_SPINS, st.spins + n);
    st.lastRegen += n * REGEN_MS;
    if (st.spins >= MAX_SPINS) st.lastRegen = now;
  }
}

function petAwake(st, pet, now) { return st.activePet === pet && st.petAwakeUntil > now && st.pets[pet] && st.pets[pet].unlocked; }
function petXp(st, pet, n = 1) {
  const p = st.pets[pet]; if (!p) return;
  p.xp += n;
  while (p.level < PET_MAX_LEVEL && p.xp >= p.level * 5) { p.xp -= p.level * 5; p.level++; }
}
const petAttackBonus = (lv) => 0.3 + 0.07 * (lv - 1);
const petRaidBonus = (lv) => 0.2 + 0.05 * (lv - 1);
const petBlockChance = (lv) => 0.25 + 0.04 * (lv - 1);

function unlockPetsByVillage(st) {
  const out = [];
  for (const [k, d] of Object.entries(PETS)) {
    if (!st.pets[k].unlocked && st.village >= d.unlockVillage) { st.pets[k].unlocked = true; out.push(k); }
  }
  return out;
}

// ------------------------------------------------------------------ missions + streak
const MISSION_POOL = [
  { type: 'spin', label: 'Gire {n} vezes', targets: [30, 60, 100] },
  { type: 'attack', label: 'Ataque {n} vila(s)', targets: [1, 2, 3] },
  { type: 'raid', label: 'Faça {n} saque(s)', targets: [1, 2] },
  { type: 'build', label: 'Construa ou melhore {n}x', targets: [2, 3, 5] },
  { type: 'wheel', label: 'Gire a Roda da Sorte', targets: [1] },
  { type: 'gift', label: 'Envie {n} presente(s) a amigos', targets: [1, 3] },
  { type: 'bigwin', label: 'Consiga {n} trinca(s) na máquina', targets: [3, 5, 8] },
];
const MISSION_REWARDS = [{ spins: 15 }, { spins: 20 }, { spins: 25 }, { gems: 5 }, { gems: 8 }, { petiscos: 1 }];
const ALL_MISSIONS_BONUS = { spins: 40, gems: 10 };
// free prize ladder: the first one 5 minutes after the day starts, each next one a bit later (resets daily)
const TIMED = [
  { min: 5, give: { spins: 5 } }, { min: 10, give: { coinsVm: 4000 } }, { min: 15, give: { spins: 10 } },
  { min: 20, give: { coinsVm: 9000, gems: 2 } }, { min: 30, give: { spins: 15, tickets: 1 } }, { min: 45, give: { coinsVm: 20000 } },
  { min: 60, give: { spins: 25, gems: 5 } }, { min: 90, give: { spins: 30, tickets: 1 } },
];
const MAX_TICKETS = 15;
const TICKET_EVERY_SPINS = 30;      // every 30 spins used (a x3 bet uses 3) fills the ticket bar...
const TICKETS_PER_GOAL = 5;         // ...and pays 5 tickets
const TICKET_DROP_CHANCE = 0.20;    // plus a 20% chance of +1 ticket on any spin
// Daily party: one bonus per day, rotating (Brazil day). Gives players a reason to come back every day.
const DAILY_EVENTS = [
  { id: 'martelo', name: 'Dia do Martelo', desc: 'Todo ataque rende o dobro de moedas hoje.' },
  { id: 'saque', name: 'Dia do Saque', desc: 'Todo saque rende 50% a mais de moedas hoje.' },
  { id: 'ficha', name: 'Dia da Ficha', desc: 'A barra de fichas paga 8 fichas e a chance de ficha na roleta sobe para 35%.' },
  { id: 'moedas', name: 'Chuva de Moedas', desc: 'Trincas de moedas e de sacos valem o dobro hoje.' },
  { id: 'festa', name: 'Festa nos Minigames', desc: 'Os minigames pagam o dobro de moedas hoje.' },
];
function dailyEvent(now) { const d = dayOf(now); return DAILY_EVENTS[((d % DAILY_EVENTS.length) + DAILY_EVENTS.length) % DAILY_EVENTS.length]; }
function ticketsPerGoal(now) { return dailyEvent(now).id === 'ficha' ? 8 : TICKETS_PER_GOAL; }
function ticketChance(now) { return dailyEvent(now).id === 'ficha' ? 0.35 : TICKET_DROP_CHANCE; }
// Daily party trail: every spin adds points (= spins used); each milestone pays automatically. Resets every day.
const TRAIL = [
  { pts: 10, give: { coinsVm: 2500 } }, { pts: 30, give: { spins: 10 } }, { pts: 60, give: { tickets: 2 } },
  { pts: 100, give: { coinsVm: 12000, gems: 2 } }, { pts: 160, give: { spins: 25 } }, { pts: 240, give: { tickets: 4, gems: 3 } },
  { pts: 340, give: { coinsVm: 40000, spins: 40 } }, { pts: 480, give: { spins: 60, gems: 10, tickets: 5 } },
];
function trailFix(st, now) { const d = dayOf(now); if (!st.trail || st.trail.day !== d) st.trail = { day: d, pts: 0, idx: 0 }; }
function trailAdd(st, n, now) {
  trailFix(st, now);
  st.trail.pts += n;
  const got = [];
  while (st.trail.idx < TRAIL.length && st.trail.pts >= TRAIL[st.trail.idx].pts) { got.push({ step: st.trail.idx + 1, give: applyGive(st, TRAIL[st.trail.idx].give, now) }); st.trail.idx++; }
  return got;
}
function trailInfo(st, now) {
  trailFix(st, now);
  const i = st.trail.idx, done = i >= TRAIL.length;
  return { pts: st.trail.pts, idx: i, steps: TRAIL.length, from: i > 0 ? TRAIL[i - 1].pts : 0, to: done ? TRAIL[TRAIL.length - 1].pts : TRAIL[i].pts, next: done ? null : (TRAIL[i].give.coinsVm ? { ...TRAIL[i].give, coinsVm: undefined, coins: roundNice(TRAIL[i].give.coinsVm * rewardMult(st.village)) } : TRAIL[i].give), endsMs: msToNextDay(now) };
}
// Rio minigames. score caps + per-second caps keep the rewards honest even if a client lies.
const MINI = {
  futevolei: { name: 'Altinha em Copacabana', dur: 30, cap: 90, perSec: 4, coins: 450, spinEvery: 12 },
  bloco: { name: 'Bloco de Carnaval', dur: 35, cap: 140, perSec: 6, coins: 300, spinEvery: 20 },
  bondinho: { name: 'Bondinho do Pão de Açúcar', dur: 20, cap: 300, perSec: 60, coins: 45, spinEvery: 60 },
};
const STREAK = [{ spins: 10 }, { spins: 15 }, { spins: 20, gems: 5 }, { spins: 25 }, { spins: 30, petiscos: 1 }, { spins: 40, gems: 10 }, { spins: 60, gems: 20, petiscos: 2 }];

function ensureMissions(st, userId, now) {
  const day = dayOf(now);
  if (st.missions && st.missions.day === day) return;
  const r = mulberry32(userId * 7919 + day * 104729);
  const pool = MISSION_POOL.slice();
  const list = [];
  for (let i = 0; i < 3; i++) {
    const m = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const n = m.targets[Math.floor(r() * m.targets.length)];
    const reward = MISSION_REWARDS[Math.floor(r() * MISSION_REWARDS.length)];
    list.push({ id: i, type: m.type, label: m.label.replace('{n}', n), target: n, progress: 0, claimed: false, reward });
  }
  st.missions = { day, list, bonusClaimed: false };
}

function missionProgress(st, type, n = 1) {
  if (!st.missions) return;
  for (const m of st.missions.list) if (m.type === type && !m.claimed) m.progress = Math.min(m.target, m.progress + n);
}

function applyGive(st, give, now) {
  const g = { ...give };
  if (g.coinsVm) { g.coins = (g.coins || 0) + roundNice(g.coinsVm * rewardMult(st.village)); delete g.coinsVm; }
  if (g.coins) st.coins += g.coins;
  if (g.spins) st.spins += g.spins;
  if (g.gems) st.gems += g.gems;
  if (g.petiscos) st.petiscos += g.petiscos;
  if (g.shields) st.shields = Math.min(MAX_SHIELDS, st.shields + g.shields);
  if (g.tickets) st.tickets = Math.min(MAX_TICKETS, (st.tickets || 0) + g.tickets);
  return g;
}

// ------------------------------------------------------------------ slot machine
function randomSym() {
  const w = [30, 14, 10, 14, 10, 10, 4, 5, 6];
  let x = randInt(w.reduce((a, b) => a + b, 0));
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
  return 0;
}
const TRIPLES = [[0.100, SYM.HAMMER], [0.055, SYM.RAID], [0.060, SYM.SHIELD], [0.055, SYM.ENERGY], [0.035, SYM.BAG], [0.065, SYM.COIN], [0.015, SYM.GEM], [0.006, SYM.CAPI], [0.03, SYM.TICKET]];
function rollOutcome() {
  let x = rand();
  for (const [p, s] of TRIPLES) { x -= p; if (x < 0) return { reels: [s, s, s], near: false }; }
  const o = [randomSym(), randomSym(), randomSym()];
  let near = false;
  if (rand() < 0.22) { const sp = pick([SYM.HAMMER, SYM.RAID, SYM.CAPI, SYM.BAG, SYM.GEM]); o[0] = sp; o[1] = sp; near = true; }
  if (o[0] === o[1] && o[1] === o[2]) o[2] = (o[2] + 1 + randInt(SYM_COUNT - 1)) % SYM_COUNT;
  return { reels: o, near: near || (o[0] === o[1] && [SYM.HAMMER, SYM.RAID, SYM.CAPI, SYM.BAG, SYM.GEM].includes(o[0])) };
}

// ------------------------------------------------------------------ the Game service
class Game {
  constructor(db) {
    this.db = db;
    this.q = {
      user: db.prepare('SELECT * FROM users WHERE id = ?'),
      save: db.prepare('UPDATE users SET state = ?, coins = ?, village = ?, progress = ?, name = ?, avatar = ?, last_seen = ? WHERE id = ?'),
      saveNoSeen: db.prepare('UPDATE users SET state = ?, coins = ?, village = ?, progress = ? WHERE id = ?'),
      insert: db.prepare('INSERT INTO users (name, email, pass_hash, google_sub, device_id, is_guest, is_bot, friend_code, avatar, coins, village, progress, state, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      byCode: db.prepare('SELECT id FROM users WHERE friend_code = ?'),
      event: db.prepare('INSERT INTO events (user_id, type, actor_id, actor_name, data, created_at) VALUES (?,?,?,?,?,?)'),
      friendsOf: db.prepare(`SELECT u.* FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE (f.a = ? OR f.b = ?) AND f.status = 'accepted'`),
      randomReal: db.prepare('SELECT * FROM users WHERE is_bot = 0 AND id != ? AND last_seen > ? ORDER BY RANDOM() LIMIT ?'),
      randomBots: db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY RANDOM() LIMIT ?'),
      botCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_bot = 1'),
      recentAttackers: db.prepare(`SELECT DISTINCT actor_id FROM events WHERE user_id = ? AND type IN ('attack','raid') AND actor_id IS NOT NULL AND created_at > ? ORDER BY id DESC LIMIT 5`),
    };
  }

  // ---------------------------------------------------------------- users
  createUser({ name, email = null, passHash = null, googleSub = null, deviceId = null, guest = false, bot = false, now = Date.now(), state = null }) {
    const st = state || newState(now);
    let code;
    for (let i = 0; i < 20; i++) { code = friendCode(); if (!this.q.byCode.get(code)) break; }
    const r = this.q.insert.run(name, email, passHash, googleSub, deviceId, guest ? 1 : 0, bot ? 1 : 0, code, randInt(6),
      st.coins, st.village, villageProgress(st), JSON.stringify(st), now, now);
    return Number(r.lastInsertRowid);
  }

  load(id) {
    const row = this.q.user.get(id);
    if (!row) return null;
    const st = JSON.parse(row.state);
    if (!st.recentTargets) st.recentTargets = [];
    if (st.tickets === undefined) st.tickets = 1;
    if (typeof st.ticketProg !== 'number') st.ticketProg = (st.stats && st.stats.spins ? st.stats.spins % TICKET_EVERY_SPINS : 0);
    if (!st.timed) st.timed = { day: -1, idx: 0, nextAt: 0 };
    if (!st.lastRaidCheck) st.lastRaidCheck = Date.now();
    return { row, st };
  }

  save(u, now = Date.now(), touchSeen = true) {
    const { row, st } = u;
    if (touchSeen) this.q.save.run(JSON.stringify(st), Math.floor(st.coins), st.village, villageProgress(st), row.name, row.avatar, now, row.id);
    else this.q.saveNoSeen.run(JSON.stringify(st), Math.floor(st.coins), st.village, villageProgress(st), row.id);
  }

  addEvent(userId, type, actor, data, now = Date.now()) {
    this.q.event.run(userId, type, actor ? actor.id : null, actor ? actor.name : null, data ? JSON.stringify(data) : null, now);
  }

  // ---------------------------------------------------------------- bots
  ensureBots(n = 40, now = Date.now()) {
    const have = this.q.botCount.get().n;
    for (let i = have; i < n; i++) {
      const st = newState(now);
      st.village = 1 + randInt(15);
      st.levels = st.levels.map(() => 1 + randInt(MAX_LEVEL));
      st.coins = roundNice(rnd(20000, 400000) * rewardMult(st.village));
      st.shields = randInt(3);
      const suffix = ['', ' Jr.', ' da Ilha', ' Dourado', ' Veloz'][Math.floor(i / BOT_NAMES.length) % 5];
      const name = BOT_NAMES[i % BOT_NAMES.length] + suffix;
      this.createUser({ name, bot: true, now, state: st });
    }
  }

  /** Bots "play" between visits so the world feels alive. */
  refreshBot(u, now) {
    const st = u.st;
    const idle = now - (st.botTick || 0);
    if (idle < 20 * 60 * 1000) return;
    st.botTick = now;
    st.damaged = st.damaged.map((d) => d && rand() < 0.3);
    st.levels = st.levels.map((l) => Math.min(MAX_LEVEL, l + (rand() < 0.25 ? 1 : 0)));
    st.coins = Math.max(st.coins, roundNice(rnd(30000, 500000) * rewardMult(st.village)));
    if (rand() < 0.4) st.shields = Math.min(MAX_SHIELDS, st.shields + 1);
    this.save(u, now, false);
  }

  // ---------------------------------------------------------------- profile
  /** Daily bookkeeping. Returns daily bonus object if granted now. */
  touch(u, now) {
    const st = u.st;
    regen(st, now);
    ensureMissions(st, u.row.id, now);
    if (st.activePet && st.petAwakeUntil <= now) { /* pet sleeping, keep selection */ }
    const incoming = this.incoming(u, now);
    this.timedFix(st, now);
    const day = dayOf(now);
    let bonus = null;
    if (st.streak.lastDay !== day) {
      st.streak.count = st.streak.lastDay === day - 1 ? st.streak.count + 1 : 1;
      st.streak.lastDay = day;
      const reward = STREAK[(st.streak.count - 1) % STREAK.length];
      const got = applyGive(st, reward, now);
      bonus = { day: ((st.streak.count - 1) % STREAK.length) + 1, streak: st.streak.count, reward: got, table: STREAK };
    }
    u.incoming = incoming;
    return bonus;
  }

  /**
   * While you're away (or between refreshes) other islands come for you: a bot attack knocks one of your
   * buildings down a level (shields and the Tucano block it), a bot raid takes a slice of your coins.
   */
  incoming(u, now) {
    const st = u.st;
    if (u.row.is_bot) return [];
    const last = st.lastRaidCheck || now;
    st.lastRaidCheck = now;
    if (st.stats.spins < 25 || villageComplete(st)) return [];
    const hours = Math.min(12, (now - last) / 3600e3);
    let n = 0;
    for (let h = hours; h > 0; h -= 2) if (rand() < Math.min(1, h / 2) * 0.55) n++;
    n = Math.min(3, n);
    const out = [];
    for (let i = 0; i < n; i++) {
      const bot = this.q.randomBots.all(1)[0];
      if (!bot) break;
      const actor = { id: bot.id, name: bot.name };
      if (rand() < 0.65) {
        const valid = [0, 1, 2, 3, 4].filter((k) => st.levels[k] > 0);
        if (!valid.length) continue;
        if (st.shields > 0) { st.shields--; this.addEvent(u.row.id, 'block', actor, { by: 'shield' }, now); out.push('block'); continue; }
        if (petAwake(st, 'tucano', now) && rand() < petBlockChance(st.pets.tucano.level)) { petXp(st, 'tucano'); this.addEvent(u.row.id, 'block', actor, { by: 'pet' }, now); out.push('block'); continue; }
        const k = pick(valid);
        st.levels[k]--;
        const destroyed = st.levels[k] === 0;
        st.damaged[k] = !destroyed;
        this.addEvent(u.row.id, 'attack', actor, { slot: k, building: themeOf(st.village)[1][k], level: st.levels[k], destroyed }, now);
        out.push('attack');
      } else {
        const lost = Math.min(Math.floor(st.coins * 0.12), roundNice(30000 * rewardMult(st.village)));
        if (lost <= 0) continue;
        st.coins -= lost;
        this.addEvent(u.row.id, 'raid', actor, { amount: lost }, now);
        out.push('raid');
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- free prize ladder
  timedFix(st, now) {
    const day = dayOf(now);
    if (st.timed.day !== day) st.timed = { day, idx: 0, nextAt: now + TIMED[0].min * 60e3 };
  }
  timedInfo(st, now) {
    this.timedFix(st, now);
    const t = TIMED[Math.min(st.timed.idx, TIMED.length - 1)];
    const give = { ...t.give };
    if (give.coinsVm) { give.coins = roundNice(give.coinsVm * rewardMult(st.village)); delete give.coinsVm; }
    return { idx: st.timed.idx, readyMs: Math.max(0, st.timed.nextAt - now), reward: give, steps: TIMED.length };
  }
  timedClaim(u, now) {
    const st = u.st;
    this.timedFix(st, now);
    if (now < st.timed.nextAt) throw err(409, 'not_ready', 'O prêmio ainda não está pronto.');
    const t = TIMED[Math.min(st.timed.idx, TIMED.length - 1)];
    const got = applyGive(st, t.give, now);
    st.timed.idx++;
    st.timed.nextAt = now + TIMED[Math.min(st.timed.idx, TIMED.length - 1)].min * 60e3;
    this.save(u, now);
    return { got, timed: this.timedInfo(st, now) };
  }

  // ---------------------------------------------------------------- minigames
  miniStart(u, game, now) {
    const st = u.st;
    const def = MINI[game];
    if (!def) throw err(400, 'bad_game', 'Minigame inválido.');
    if ((st.tickets || 0) < 1) throw err(400, 'no_tickets', 'Você está sem fichas. Cada giro enche a barra de fichas e ainda pode dar uma ficha extra.');
    st.tickets--;
    st.mini = { game, at: now, seed: randInt(1e9) };
    this.save(u, now);
    return { game, seed: st.mini.seed, dur: def.dur, tickets: st.tickets };
  }
  miniFinish(u, score, now) {
    const st = u.st;
    const m = st.mini;
    if (!m) throw err(409, 'no_game', 'Nenhum minigame em andamento.');
    const def = MINI[m.game];
    const elapsed = Math.max(0, (now - m.at) / 1000);
    let sc = Math.max(0, Math.floor(Number(score) || 0));
    sc = Math.min(sc, def.cap, Math.floor(elapsed * def.perSec) + 3);
    const vm = rewardMult(st.village);
    const give = { coins: roundNice(sc * def.coins * vm * (dailyEvent(now).id === 'festa' ? 2 : 1)) };
    const spins = Math.floor(sc / def.spinEvery);
    if (spins > 0) give.spins = spins;
    if (sc >= def.cap * 0.75) give.gems = 3;
    st.mini = null;
    const got = applyGive(st, give, now);
    if (got.coins > st.stats.bestWin) st.stats.bestWin = got.coins;
    st.stats.minis = (st.stats.minis || 0) + 1;
    this.save(u, now);
    return { score: sc, got, tickets: st.tickets };
  }

  publicVillage(u, extra = {}) {
    const st = u.st;
    return {
      id: u.row.id, name: u.row.name, avatar: u.row.avatar, village: st.village, levels: st.levels, damaged: st.damaged,
      bot: !!u.row.is_bot, coins: Math.floor(st.coins), ...extra,
    };
  }

  profile(u, now) {
    const st = u.st, r = u.row;
    const counts = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM events WHERE user_id = ? AND seen = 0) AS unread,
        (SELECT COUNT(*) FROM gifts WHERE to_id = ? AND collected = 0) AS gifts,
        (SELECT COUNT(*) FROM friends WHERE b = ? AND status = 'pending') AS requests,
        (SELECT MAX(id) FROM events WHERE user_id = ?) AS lastEvent`).get(r.id, r.id, r.id, r.id);
    const th = themeOf(st.village);
    return {
      id: r.id, name: r.name, avatar: r.avatar, email: r.email, guest: !!r.is_guest, google: !!r.google_sub, friendCode: r.friend_code,
      serverNow: now,
      coins: Math.floor(st.coins), gems: st.gems, spins: st.spins, maxSpins: MAX_SPINS, regenMs: REGEN_MS,
      nextSpinMs: st.spins >= MAX_SPINS ? 0 : Math.max(0, REGEN_MS - (now - st.lastRegen)),
      shields: st.shields, maxShields: MAX_SHIELDS, village: st.village, themeName: th[0], buildingNames: th[1],
      levels: st.levels, damaged: st.damaged, maxLevel: MAX_LEVEL,
      costs: st.levels.map((l, i) => (st.damaged[i] ? repairCost(st, i) : l >= MAX_LEVEL ? 0 : buildCost(st, i))),
      complete: villageComplete(st), bet: st.bet, bets: BETS,
      petiscos: st.petiscos, activePet: st.activePet, petAwakeMs: Math.max(0, st.petAwakeUntil - now),
      pets: Object.fromEntries(Object.entries(PETS).map(([k, d]) => [k, {
        ...d, unlocked: st.pets[k].unlocked, level: st.pets[k].level, xp: st.pets[k].xp, xpNext: st.pets[k].level * 5,
        bonus: d.role === 'attack' ? petAttackBonus(st.pets[k].level) : d.role === 'raid' ? petRaidBonus(st.pets[k].level) : petBlockChance(st.pets[k].level),
      }])),
      wheelReady: st.wheelDay !== dayOf(now), wheelResetMs: msToNextDay(now),
      missions: st.missions, missionsResetMs: msToNextDay(now), allMissionsBonus: ALL_MISSIONS_BONUS,
      streak: st.streak.count,
      pending: { attack: st.pending.attack ? { bet: st.pending.attack.bet } : null, raid: st.pending.raid ? { bet: st.pending.raid.bet, started: !!st.pending.raid.spots } : null },
      stats: st.stats, starterAvailable: !st.starterBought,
      rewardMult: rewardMult(st.village),
      tickets: st.tickets || 0, maxTickets: MAX_TICKETS, ticketEvery: TICKET_EVERY_SPINS, ticketProg: Math.min(TICKET_EVERY_SPINS, st.ticketProg || 0),
      ticketsPerGoal: ticketsPerGoal(now), ticketChance: ticketChance(now), spinsToTicket: Math.max(0, TICKET_EVERY_SPINS - (st.ticketProg || 0)),
      trail: trailInfo(st, now),
      dailyEvent: { ...dailyEvent(now), endsMs: msToNextDay(now) },
      timed: this.timedInfo(st, now), minigames: Object.fromEntries(Object.entries(MINI).map(([k, d]) => [k, { name: d.name, dur: d.dur }])),
      unread: counts.unread, giftsPending: counts.gifts, friendRequests: counts.requests, lastEventId: counts.lastEvent || 0,
    };
  }

  // ---------------------------------------------------------------- slot
  spin(u, bet, now) {
    const st = u.st;
    regen(st, now);
    ensureMissions(st, u.row.id, now);
    if (st.pending.attack || st.pending.raid) throw err(409, 'pending_action', 'Conclua seu ataque ou saque antes de girar de novo.');
    bet = BETS.includes(bet) ? bet : 1;
    if (st.spins < 1) throw err(400, 'no_spins', 'Você está sem giros. Novos giros chegam a cada 3 minutos.');
    while (bet > st.spins) bet = BETS[Math.max(0, BETS.indexOf(bet) - 1)];
    st.bet = bet;
    st.spins -= bet;
    st.stats.spins++;
    missionProgress(st, 'spin', 1);
    const ev = dailyEvent(now);
    // ticket bar: counts every spin used (bet included); pays when it fills. If tickets are full the bar waits, nothing is lost.
    let ticketGoal = 0, ticketDrop = 0;
    if (typeof st.ticketProg !== 'number') st.ticketProg = 0;
    st.ticketProg = Math.min(TICKET_EVERY_SPINS * 2, st.ticketProg + bet);
    while (st.ticketProg >= TICKET_EVERY_SPINS && (st.tickets || 0) < MAX_TICKETS) {
      const n = Math.min(ticketsPerGoal(now), MAX_TICKETS - (st.tickets || 0));
      st.tickets = (st.tickets || 0) + n; ticketGoal += n; st.ticketProg -= TICKET_EVERY_SPINS;
    }
    if ((st.tickets || 0) < MAX_TICKETS && rand() < ticketChance(now)) { st.tickets++; ticketDrop = 1; }
    const { reels, near } = rollOutcome();
    const vm = rewardMult(st.village);
    const res = { reels, near, bet, triple: reels[0] === reels[1] && reels[1] === reels[2], sym: reels[0], coins: 0, spins: 0, gems: 0, shield: 0, action: null };
    if (res.triple) {
      missionProgress(st, 'bigwin', 1);
      switch (reels[0]) {
        case SYM.COIN: res.coins = Math.floor(2500 * bet * vm * (ev.id === 'moedas' ? 2 : 1)); break;
        case SYM.BAG: res.coins = Math.floor(10000 * bet * vm * (ev.id === 'moedas' ? 2 : 1)); break;
        case SYM.TICKET: {
          const want = ev.id === 'ficha' ? 5 : 3;
          const room = Math.max(0, MAX_TICKETS - (st.tickets || 0));
          const n = Math.min(want, room);
          st.tickets = (st.tickets || 0) + n; res.tickets = n;
          if (n < want) res.coins = Math.floor(2000 * (want - n) * bet * vm);
          break;
        }
        case SYM.CAPI: res.coins = Math.floor(50000 * bet * vm); res.gems = 5; break;
        case SYM.ENERGY: res.spins = 15 * bet; break;
        case SYM.GEM: res.gems = Math.min(100, 5 * bet); break;
        case SYM.SHIELD:
          if (st.shields < MAX_SHIELDS) { st.shields++; res.shield = 1; } else res.coins = Math.floor(3000 * bet * vm);
          break;
        case SYM.HAMMER: st.pending.attack = { bet, at: now }; res.action = 'attack'; break;
        case SYM.RAID: st.pending.raid = { bet, at: now }; res.action = 'raid'; break;
      }
    } else {
      const coins = reels.filter((s) => s === SYM.COIN).length, bags = reels.filter((s) => s === SYM.BAG).length;
      res.coins = Math.floor((coins * 150 + bags * 600) * bet * vm);
      if (reels.filter((s) => s === SYM.ENERGY).length === 2) res.spins = 2 * bet;
    }
    st.coins += res.coins; st.spins += res.spins; st.gems += res.gems;
    if (res.coins > st.stats.bestWin) st.stats.bestWin = res.coins;
    res.vm = vm;
    res.ticket = ticketDrop;
    res.ticketGoal = ticketGoal;
    res.ticketsNow = st.tickets || 0;
    res.trail = trailAdd(st, bet + (res.triple && (res.action === 'attack' || res.action === 'raid') ? 5 * bet : 0), now);
    this.save(u, now);
    return res;
  }

  // ---------------------------------------------------------------- village
  build(u, slot, now) {
    const st = u.st;
    if (!(slot >= 0 && slot < 5)) throw err(400, 'bad_slot', 'Prédio inválido.');
    if (villageComplete(st)) throw err(409, 'complete', 'Vila completa! Viaje para a próxima ilha.');
    const dmg = st.damaged[slot];
    if (!dmg && st.levels[slot] >= MAX_LEVEL) throw err(409, 'max', 'Este prédio já está no máximo.');
    if (dmg && st.levels[slot] >= MAX_LEVEL) { st.damaged[slot] = false; this.save(u, now); return { slot, level: st.levels[slot], repaired: true, cost: 0, complete: villageComplete(st) }; }
    const cost = dmg ? repairCost(st, slot) : buildCost(st, slot);
    if (st.coins < cost) throw err(400, 'no_coins', 'Moedas insuficientes.');
    st.coins -= cost;
    if (dmg) { st.damaged[slot] = false; st.levels[slot] = Math.min(MAX_LEVEL, st.levels[slot] + 1); } else { st.levels[slot]++; st.stats.builds++; missionProgress(st, 'build', 1); }
    this.save(u, now);
    return { slot, level: st.levels[slot], repaired: dmg, cost, complete: villageComplete(st) };
  }

  nextVillage(u, now) {
    const st = u.st;
    if (!villageComplete(st)) throw err(409, 'not_complete', 'Termine a vila primeiro.');
    const reward = { spins: 30 + st.village * 5, gems: 10 };
    st.village++;
    st.levels = [0, 0, 0, 0, 0]; st.damaged = [false, false, false, false, false];
    st.stats.villages++;
    applyGive(st, reward, now);
    const unlocked = unlockPetsByVillage(st);
    for (const k of unlocked) this.addEvent(u.row.id, 'pet_unlock', null, { pet: k, name: PETS[k].name }, now);
    this.save(u, now);
    return { village: st.village, reward, unlockedPets: unlocked, themeName: themeOf(st.village)[0] };
  }

  // ---------------------------------------------------------------- attack
  candidates(u, now, n = 6) {
    const me = u.row.id;
    const friends = this.q.friendsOf.all(me, me, me).map((row) => ({ row, st: JSON.parse(row.state) }));
    const revengeIds = this.q.recentAttackers.all(me, now - 48 * 3600e3).map((r) => r.actor_id).filter((id) => id !== me);
    const revenge = revengeIds.map((id) => this.load(id)).filter(Boolean);
    const real = this.q.randomReal.all(me, now - 14 * 86400e3, n).map((row) => ({ row, st: JSON.parse(row.state) }));
    const bots = this.q.randomBots.all(n).map((row) => ({ row, st: JSON.parse(row.state) }));
    for (const b of bots) this.refreshBot(b, now);
    return { friends, revenge, real, bots };
  }

  attackStart(u, wantId, now) {
    const st = u.st;
    if (!st.pending.attack) throw err(409, 'no_attack', 'Você não tem um ataque disponível.');
    const c = this.candidates(u, now);
    const fid = new Set(c.friends.map((x) => x.row.id));
    const rid = new Set(c.revenge.map((x) => x.row.id));
    const seen = new Set();
    const options = [];
    const add = (x, tag) => { if (seen.has(x.row.id) || x.row.id === u.row.id) return; seen.add(x.row.id); options.push(this.publicVillage(x, { friend: fid.has(x.row.id), revenge: rid.has(x.row.id), tag })); };
    c.revenge.forEach((x) => add(x, 'revenge'));
    c.friends.forEach((x) => add(x, 'friend'));
    c.real.forEach((x) => add(x, 'player'));
    c.bots.forEach((x) => add(x, 'bot'));
    const opts = options.slice(0, 10);
    let target = null;
    if (wantId) target = opts.find((o) => o.id === wantId) || null;
    if (!target) {
      // a different rival every attack: skip the last ones, prefer real players that still have something to break
      const recent = new Set(st.recentTargets || []);
      const fresh = opts.filter((o) => !recent.has(o.id) && o.levels.some((l) => l > 0));
      const pool = fresh.length ? fresh : opts.filter((o) => !recent.has(o.id));
      const real = pool.filter((o) => !o.bot && !o.revenge);
      target = real.length && rand() < 0.75 ? pick(real) : (pool.find((o) => o.bot) || pool[0] || opts[0]);
    }
    if (!target) throw err(500, 'no_targets', 'Nenhum alvo disponível.');
    st.pending.attack.allowed = opts.map((o) => o.id);
    st.pending.attack.targetId = target.id;
    this.save(u, now);
    return { target, options: opts, bet: st.pending.attack.bet };
  }

  attackHit(u, targetId, slot, now) {
    const st = u.st;
    const p = st.pending.attack;
    if (!p) throw err(409, 'no_attack', 'Você não tem um ataque disponível.');
    if (!p.allowed || !p.allowed.includes(targetId)) throw err(400, 'bad_target', 'Alvo inválido.');
    return tx(this.db, () => {
      const t = this.load(targetId);
      if (!t) throw err(404, 'target_gone', 'Alvo não encontrado.');
      const ts = t.st;
      regen(ts, now);
      const vm = rewardMult(st.village);
      let reward = 6000 * p.bet * vm * rnd(0.85, 1.3) * (dailyEvent(now).id === 'martelo' ? 2 : 1);
      let blocked = null;
      if (ts.shields > 0) { ts.shields--; blocked = 'shield'; }
      else if (petAwake(ts, 'tucano', now) && rand() < petBlockChance(ts.pets.tucano.level)) { blocked = 'pet'; petXp(ts, 'tucano'); }
      let hitSlot = slot, levelBefore = 0, levelAfter = 0, destroyed = false;
      if (!blocked) {
        // every hit knocks the building down one level; a level-1 (precarious) building is destroyed
        const valid = [0, 1, 2, 3, 4].filter((i) => ts.levels[i] > 0);
        if (!valid.includes(hitSlot)) hitSlot = valid.length ? pick(valid) : -1;
        if (hitSlot >= 0) {
          levelBefore = ts.levels[hitSlot];
          ts.levels[hitSlot] = levelBefore - 1;
          levelAfter = ts.levels[hitSlot];
          destroyed = levelAfter === 0;
          ts.damaged[hitSlot] = !destroyed;
          if (destroyed) reward *= 1.25;
        }
      } else { reward *= 0.35; ts.stats.blocks = (ts.stats.blocks || 0) + 1; }
      let petBonus = 0;
      if (petAwake(st, 'onca', now)) { petBonus = Math.floor(reward * petAttackBonus(st.pets.onca.level)); petXp(st, 'onca'); }
      const total = Math.floor(reward) + petBonus;
      st.coins += total;
      st.stats.attacks++;
      missionProgress(st, 'attack', 1);
      st.pending.attack = null;
      st.recentTargets = [targetId, ...(st.recentTargets || []).filter((x) => x !== targetId)].slice(0, 6);
      if (total > st.stats.bestWin) st.stats.bestWin = total;
      const tName = themeOf(ts.village)[1][hitSlot] || null;
      if (!t.row.is_bot) {
        if (blocked) this.addEvent(t.row.id, 'block', u.row, { by: blocked }, now);
        else this.addEvent(t.row.id, 'attack', u.row, { slot: hitSlot, building: tName, level: levelAfter, destroyed }, now);
      }
      this.save(t, now, false);
      this.save(u, now);
      return { blocked, slot: hitSlot, building: tName, levelBefore, levelAfter, destroyed, reward: total, petBonus, target: this.publicVillage(t) };
    });
  }

  // ---------------------------------------------------------------- raid
  raidStart(u, now) {
    const st = u.st;
    const p = st.pending.raid;
    if (!p) throw err(409, 'no_raid', 'Você não tem um saque disponível.');
    if (p.spots) {
      const t = this.load(p.targetId);
      return { target: t ? this.publicVillage(t) : null, digs: p.digs, dug: p.dug.map((i) => ({ spot: i, value: p.spots[i], kind: p.kinds[i] })), bet: p.bet };
    }
    const c = this.candidates(u, now, 8);
    const recent = new Set(st.recentTargets || []);
    let pool = [...c.real, ...c.bots, ...c.friends].filter((x) => x.row.id !== u.row.id);
    if (pool.some((x) => !recent.has(x.row.id))) pool = pool.filter((x) => !recent.has(x.row.id));
    pool.sort((a, b) => b.st.coins - a.st.coins);
    const t = rand() < 0.6 ? pool[0] : pick(pool.slice(0, 4));
    if (!t) throw err(500, 'no_targets', 'Nenhum alvo disponível.');
    const vm = rewardMult(st.village);
    const pot = 20000 * p.bet * vm * rnd(0.8, 1.4);
    const shares = [0.45, 0.15, 0.15, 0.06, 0.06, 0.06, 0.02, 0.02, 0.02];
    const kinds = [3, 2, 2, 1, 1, 1, 0, 0, 0];
    const idx = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    p.spots = new Array(9); p.kinds = new Array(9);
    idx.forEach((spot, j) => { p.spots[spot] = roundNice(pot * shares[j]); p.kinds[spot] = kinds[j]; });
    p.targetId = t.row.id; p.dug = [];
    st.recentTargets = [t.row.id, ...(st.recentTargets || []).filter((x) => x !== t.row.id)].slice(0, 6);
    p.digs = 3 + (petAwake(st, 'quati', now) ? 1 : 0);
    p.petBonus = petAwake(st, 'quati', now) ? petRaidBonus(st.pets.quati.level) : 0;
    this.save(u, now);
    return { target: this.publicVillage(t), digs: p.digs, dug: [], bet: p.bet, petBonus: p.petBonus };
  }

  raidDig(u, spot, now) {
    const st = u.st;
    const p = st.pending.raid;
    if (!p || !p.spots) throw err(409, 'no_raid', 'Nenhum saque em andamento.');
    if (!(spot >= 0 && spot < 9) || p.dug.includes(spot)) throw err(400, 'bad_spot', 'Lugar inválido.');
    p.dug.push(spot);
    const base = p.spots[spot];
    const evk = dailyEvent(now).id === 'saque' ? 1.5 : 1;
    const value = Math.floor(base * (1 + (p.petBonus || 0)) * evk);
    st.coins += value;
    const res = { spot, value, kind: p.kinds[spot], left: p.digs - p.dug.length, done: false };
    if (p.dug.length >= p.digs) {
      res.done = true;
      const total = p.dug.reduce((a, i) => a + Math.floor(p.spots[i] * (1 + (p.petBonus || 0)) * evk), 0);
      res.total = total;
      res.all = p.spots.map((v, i) => ({ spot: i, value: v, kind: p.kinds[i] }));
      st.stats.raids++;
      missionProgress(st, 'raid', 1);
      if (p.petBonus) petXp(st, 'quati');
      if (total > st.stats.bestWin) st.stats.bestWin = total;
      tx(this.db, () => {
        const t = this.load(p.targetId);
        if (t) {
          const lost = Math.min(total, Math.floor(t.st.coins * 0.3));
          t.st.coins -= lost;
          if (!t.row.is_bot && lost > 0) this.addEvent(t.row.id, 'raid', u.row, { amount: lost }, now);
          this.save(t, now, false);
        }
        st.pending.raid = null;
        this.save(u, now);
      });
    } else this.save(u, now);
    return res;
  }

  // ---------------------------------------------------------------- daily wheel
  static WHEEL = [
    { label: '10 giros', give: { spins: 10 }, w: 20 }, { label: 'moedas', give: { coinsVm: 5000 }, w: 18 },
    { label: '25 giros', give: { spins: 25 }, w: 13 }, { label: 'escudo', give: { shields: 1 }, w: 12 },
    { label: 'petisco', give: { petiscos: 1 }, w: 10 }, { label: '15 gemas', give: { gems: 15 }, w: 10 },
    { label: '60 giros', give: { spins: 60 }, w: 6 }, { label: 'JACKPOT', give: { spins: 150, gems: 25 }, w: 1 },
  ];
  wheelInfo(st) {
    return Game.WHEEL.map((s) => ({ label: s.label, give: s.give.coinsVm ? { coins: roundNice(s.give.coinsVm * rewardMult(st.village)) } : s.give }));
  }
  wheelSpin(u, now) {
    const st = u.st;
    if (st.wheelDay === dayOf(now)) throw err(409, 'wheel_used', 'Você já girou a Roda da Sorte hoje. Ela volta amanhã.');
    let x = randInt(Game.WHEEL.reduce((a, s) => a + s.w, 0));
    let idx = 0;
    for (let i = 0; i < Game.WHEEL.length; i++) { x -= Game.WHEEL[i].w; if (x < 0) { idx = i; break; } }
    st.wheelDay = dayOf(now);
    const got = applyGive(st, Game.WHEEL[idx].give, now);
    missionProgress(st, 'wheel', 1);
    this.save(u, now);
    return { index: idx, got };
  }

  // ---------------------------------------------------------------- chests (coins) + gem shop
  static CHESTS = [
    { id: 0, name: 'Baú de Madeira', base: 30000, give: { spins: 12 } },
    { id: 1, name: 'Baú Dourado', base: 100000, give: { spins: 45, shields: 1, petiscos: 1 } },
    { id: 2, name: 'Baú Mágico', base: 300000, give: { spins: 140, shields: 3, petiscos: 3, gems: 10 } },
  ];
  chestList(st) { return Game.CHESTS.map((c) => ({ ...c, price: roundNice(c.base * rewardMult(st.village)) })); }
  chestBuy(u, kind, now) {
    const st = u.st;
    const c = this.chestList(st)[kind];
    if (!c) throw err(400, 'bad_chest', 'Baú inválido.');
    if (st.coins < c.price) throw err(400, 'no_coins', 'Moedas insuficientes.');
    st.coins -= c.price;
    const got = applyGive(st, c.give, now);
    this.save(u, now);
    return { kind, got };
  }

  static GEMSHOP = [
    { id: 'g_spins30', title: '30 giros', gems: 40, give: { spins: 30 }, icon: 'spins' },
    { id: 'g_spins120', title: '120 giros', gems: 140, give: { spins: 120 }, icon: 'spins', tag: 'Popular' },
    { id: 'g_coins', title: 'Saco de moedas', gems: 50, give: { coinsVm: 60000 }, icon: 'coins' },
    { id: 'g_coins_big', title: 'Cofre de moedas', gems: 180, give: { coinsVm: 260000 }, icon: 'coins', tag: 'Melhor valor' },
    { id: 'g_petisco', title: '1 petisco', gems: 30, give: { petiscos: 1 }, icon: 'petisco' },
    { id: 'g_petisco5', title: '5 petiscos', gems: 120, give: { petiscos: 5 }, icon: 'petisco' },
    { id: 'g_shield', title: '1 escudo', gems: 20, give: { shields: 1 }, icon: 'shield' },
    { id: 'g_chest', title: 'Baú Mágico', gems: 150, give: { spins: 140, shields: 3, petiscos: 3 }, icon: 'chest' },
  ];
  gemShop(st) {
    return Game.GEMSHOP.map((g) => ({ ...g, give: g.give.coinsVm ? { coins: roundNice(g.give.coinsVm * rewardMult(st.village)) } : g.give }));
  }
  gemBuy(u, id, now) {
    const st = u.st;
    const it = Game.GEMSHOP.find((g) => g.id === id);
    if (!it) throw err(400, 'bad_item', 'Item inválido.');
    if (st.gems < it.gems) throw err(400, 'no_gems', 'Gemas insuficientes.');
    if (it.give.shields && st.shields >= MAX_SHIELDS && Object.keys(it.give).length === 1) throw err(409, 'shields_full', 'Seus escudos já estão cheios.');
    st.gems -= it.gems;
    const got = applyGive(st, it.give, now);
    this.save(u, now);
    return { id, got };
  }

  // ---------------------------------------------------------------- pets
  petFeed(u, pet, now) {
    const st = u.st;
    if (!PETS[pet]) throw err(400, 'bad_pet', 'Pet inválido.');
    if (!st.pets[pet].unlocked) throw err(409, 'locked', 'Pet bloqueado.');
    if (st.petiscos < 1) throw err(400, 'no_petisco', 'Você não tem petiscos.');
    st.petiscos--;
    const base = st.activePet === pet && st.petAwakeUntil > now ? st.petAwakeUntil : now;
    st.activePet = pet;
    st.petAwakeUntil = base + PET_AWAKE_MS;
    petXp(st, pet, 1);
    this.save(u, now);
    return { pet, awakeMs: st.petAwakeUntil - now };
  }
  petSelect(u, pet, now) {
    const st = u.st;
    if (!PETS[pet] || !st.pets[pet].unlocked) throw err(409, 'locked', 'Pet bloqueado.');
    if (st.activePet !== pet) { st.activePet = pet; st.petAwakeUntil = 0; }
    this.save(u, now);
    return { pet };
  }
  petUnlock(u, pet, now) {
    const st = u.st;
    const d = PETS[pet];
    if (!d) throw err(400, 'bad_pet', 'Pet inválido.');
    if (st.pets[pet].unlocked) return { pet };
    if (st.gems < d.gemCost) throw err(400, 'no_gems', 'Gemas insuficientes.');
    st.gems -= d.gemCost;
    st.pets[pet].unlocked = true;
    if (!st.activePet) st.activePet = pet;
    this.save(u, now);
    return { pet };
  }

  // ---------------------------------------------------------------- missions
  missionClaim(u, id, now) {
    const st = u.st;
    ensureMissions(st, u.row.id, now);
    if (id === 'all') {
      if (st.missions.bonusClaimed || !st.missions.list.every((m) => m.claimed)) throw err(409, 'not_ready', 'Complete todas as missões.');
      st.missions.bonusClaimed = true;
      const got = applyGive(st, ALL_MISSIONS_BONUS, now);
      this.save(u, now);
      return { got };
    }
    const m = st.missions.list.find((x) => x.id === id);
    if (!m || m.claimed || m.progress < m.target) throw err(409, 'not_ready', 'Missão ainda não concluída.');
    m.claimed = true;
    const got = applyGive(st, m.reward, now);
    this.save(u, now);
    return { got };
  }

  // ---------------------------------------------------------------- friends / gifts
  friends(u, now) {
    const me = u.row.id, day = dayOf(now);
    const list = this.q.friendsOf.all(me, me, me).map((row) => {
      const st = JSON.parse(row.state);
      const sent = this.db.prepare('SELECT 1 FROM gifts WHERE from_id = ? AND to_id = ? AND day = ?').get(me, row.id, day);
      return { id: row.id, name: row.name, avatar: row.avatar, village: st.village, progress: villageProgress(st), lastSeen: row.last_seen, online: now - row.last_seen < 5 * 60e3, canGift: !sent };
    });
    list.sort((a, b) => (b.village - a.village) || (b.progress - a.progress));
    const requests = this.db.prepare(`SELECT u.id, u.name, u.avatar, u.village FROM friends f JOIN users u ON u.id = f.a WHERE f.b = ? AND f.status = 'pending' ORDER BY f.created_at DESC`).all(me);
    const sent = this.db.prepare(`SELECT u.id, u.name, u.avatar, u.village FROM friends f JOIN users u ON u.id = f.b WHERE f.a = ? AND f.status = 'pending'`).all(me);
    const gifts = this.db.prepare(`SELECT g.id, u.name, u.avatar FROM gifts g JOIN users u ON u.id = g.from_id WHERE g.to_id = ? AND g.collected = 0 ORDER BY g.id DESC LIMIT 100`).all(me);
    return { code: u.row.friend_code, friends: list, requests, sent, gifts, giftValue: 2 };
  }

  friendAdd(u, code, now) {
    code = String(code || '').trim().toUpperCase();
    if (!code.startsWith('CAPI-')) code = 'CAPI-' + code;
    const t = this.db.prepare('SELECT id, name, is_bot FROM users WHERE friend_code = ?').get(code);
    if (!t || t.is_bot) throw err(404, 'not_found', 'Código não encontrado.');
    const me = u.row.id;
    if (t.id === me) throw err(400, 'self', 'Esse é o seu código!');
    const existing = this.db.prepare('SELECT * FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').get(me, t.id, t.id, me);
    if (existing) {
      if (existing.status === 'accepted') throw err(409, 'already', 'Vocês já são amigos.');
      if (existing.a === t.id) { // they already invited me → accept
        this.db.prepare(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`).run(t.id, me);
        this.addEvent(t.id, 'friend_ok', u.row, null, now);
        return { status: 'accepted', name: t.name };
      }
      throw err(409, 'pending', 'Pedido já enviado.');
    }
    this.db.prepare(`INSERT INTO friends (a, b, status, created_at) VALUES (?, ?, 'pending', ?)`).run(me, t.id, now);
    this.addEvent(t.id, 'friend_req', u.row, null, now);
    return { status: 'pending', name: t.name };
  }

  friendRespond(u, id, accept, now) {
    const me = u.row.id;
    const f = this.db.prepare(`SELECT * FROM friends WHERE a = ? AND b = ? AND status = 'pending'`).get(id, me);
    if (!f) throw err(404, 'not_found', 'Pedido não encontrado.');
    if (accept) {
      this.db.prepare(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`).run(id, me);
      this.addEvent(id, 'friend_ok', u.row, null, now);
    } else this.db.prepare('DELETE FROM friends WHERE a = ? AND b = ?').run(id, me);
    return { ok: true };
  }

  friendRemove(u, id) {
    const me = u.row.id;
    this.db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(me, id, id, me);
    return { ok: true };
  }

  giftSend(u, id, now) {
    const me = u.row.id, day = dayOf(now);
    const ok = this.db.prepare(`SELECT 1 FROM friends WHERE ((a = ? AND b = ?) OR (a = ? AND b = ?)) AND status = 'accepted'`).get(me, id, id, me);
    if (!ok) throw err(404, 'not_friend', 'Vocês não são amigos.');
    try { this.db.prepare('INSERT INTO gifts (from_id, to_id, day, created_at) VALUES (?,?,?,?)').run(me, id, day, now); }
    catch (_) { throw err(409, 'already', 'Você já enviou um presente hoje.'); }
    this.addEvent(id, 'gift', u.row, null, now);
    missionProgress(u.st, 'gift', 1);
    this.save(u, now);
    return { ok: true };
  }

  giftAll(u, now) {
    const f = this.friends(u, now);
    let sent = 0;
    for (const fr of f.friends) if (fr.canGift) { try { this.giftSend(u, fr.id, now); sent++; } catch (_) {} }
    return { sent };
  }

  giftsCollect(u, now) {
    const st = u.st, me = u.row.id, day = dayOf(now);
    if (st.giftsCollectedDay !== day) { st.giftsCollectedDay = day; st.giftsCollectedToday = 0; }
    const room = Math.max(0, 50 - st.giftsCollectedToday);
    const rows = this.db.prepare('SELECT id FROM gifts WHERE to_id = ? AND collected = 0 ORDER BY id LIMIT ?').all(me, room);
    if (!rows.length) return { collected: 0, spins: 0, limit: room === 0 };
    tx(this.db, () => {
      const upd = this.db.prepare('UPDATE gifts SET collected = 1 WHERE id = ?');
      for (const r of rows) upd.run(r.id);
      st.giftsCollectedToday += rows.length;
      st.spins += rows.length * 2;
      this.save(u, now);
    });
    return { collected: rows.length, spins: rows.length * 2 };
  }

  // ---------------------------------------------------------------- events + leaderboard
  events(u, limit = 40) {
    const rows = this.db.prepare('SELECT id, type, actor_id, actor_name, data, created_at, seen FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(u.row.id, limit);
    this.db.prepare('UPDATE events SET seen = 1 WHERE user_id = ? AND seen = 0').run(u.row.id);
    return rows.map((r) => ({ id: r.id, type: r.type, actorId: r.actor_id, actor: r.actor_name, data: r.data ? JSON.parse(r.data) : null, at: r.created_at, seen: !!r.seen }));
  }

  eventsSince(u, after) {
    const rows = this.db.prepare('SELECT id, type, actor_name, data, created_at FROM events WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 20').all(u.row.id, after || 0);
    return rows.map((r) => ({ id: r.id, type: r.type, actor: r.actor_name, data: r.data ? JSON.parse(r.data) : null, at: r.created_at }));
  }

  leaderboard(u) {
    const top = this.db.prepare('SELECT id, name, avatar, village, progress FROM users WHERE is_bot = 0 ORDER BY village DESC, progress DESC, id ASC LIMIT 50').all();
    const me = this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE is_bot = 0 AND (village > ? OR (village = ? AND progress > ?))').get(u.st.village, u.st.village, villageProgress(u.st));
    return { top, myRank: me.rank };
  }
}

module.exports = { Game, SYM, BETS, MAX_SPINS, REGEN_MS, PETS, THEMES, themeOf, rewardMult, applyGive, newState, villageComplete, fmt };
