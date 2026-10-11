'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Minimal .env loader (no dependencies). Existing env vars win. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const err = (status, code, message) => new ApiError(status, code, message);

/** Brazil (UTC-3) calendar day number, used for daily resets. */
function dayOf(ms) { return Math.floor((ms - 3 * 3600e3) / 86400e3); }
function msToNextDay(ms) { return (dayOf(ms) + 1) * 86400e3 + 3 * 3600e3 - ms; }

function roundNice(v) {
  if (v < 1000) return Math.round(v / 10) * 10;
  let mag = 1;
  while (v / mag >= 100) mag *= 10;
  return Math.round(v / mag) * mag;
}

function randInt(n) { return crypto.randomInt(n); }
function rand() { return crypto.randomInt(1 << 30) / (1 << 30); }
function rnd(a, b) { return a + rand() * (b - a); }
function pick(arr) { return arr[randInt(arr.length)]; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Deterministic PRNG for daily missions. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function uuid() { return crypto.randomUUID(); }

function friendCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[randInt(A.length)];
  return 'CAPI-' + s;
}

function ensureDir(file) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); }

function fmt(n) {
  const a = Math.abs(n);
  const t = (d) => { let s = d >= 100 ? d.toFixed(0) : d >= 10 ? d.toFixed(1) : d.toFixed(2); if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s.replace('.', ','); };
  if (a < 10000) return n.toLocaleString('pt-BR');
  if (a < 1e6) return t(n / 1e3) + 'K';
  if (a < 1e9) return t(n / 1e6) + 'M';
  if (a < 1e12) return t(n / 1e9) + 'B';
  return t(n / 1e12) + 'T';
}

module.exports = { loadEnv, ApiError, err, dayOf, msToNextDay, roundNice, randInt, rand, rnd, pick, shuffle, mulberry32, token, uuid, friendCode, ensureDir, fmt };
