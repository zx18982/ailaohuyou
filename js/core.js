/* ============================================================
   core.js — 工具 / 行情生成 / 指标 / 存储
   ============================================================ */

/* ---------------- 通用工具 ---------------- */
export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function rnd(a, b) { return a + Math.random() * (b - a); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* 可复现伪随机 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---------------- 格式化 ---------------- */
export const money = (v, dec = 2) =>
  (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
export const moneyS = (v, dec = 2) => (v > 0 ? '+' : '') + money(v, dec);
export const px = v => v.toFixed(2);
export const rs = v => (v > 0 ? '+' : '') + v.toFixed(2) + 'R';
export const pct = (v, dec = 1) => v.toFixed(dec) + '%';

export const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export const sign = v => (v > 0 ? '+' : v < 0 ? '-' : '');

/* 时间戳/分钟索引 → HH:MM（支持真实行情时间戳与合成数据索引） */
export function barTime(x) {
  // 真实行情 bar 对象或时间戳：按 America/New_York 格式化
  if (x && typeof x === 'object' && x.t > 1e9) x = x.t;
  if (typeof x === 'number' && x > 1e9) {
    const d = new Date(x * 1000);
    const hh = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' });
    const mm = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, minute: '2-digit' });
    return (hh + ':' + mm).replace(/:(\d)$/, ':0$1'); // 确保分钟始终两位
  }
  // 合成数据索引（0 = 09:30）
  const m = 9 * 60 + 30 + (x || 0);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

export function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function weekdayCN(d) { return '日一二三四五六'[d.getDay()]; }

/* ---------------- 存储 ---------------- */
const NS = 'ddj.';
export const store = {
  get(k, def = null) {
    try { const v = localStorage.getItem(NS + k); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch {} },
  del(k) { localStorage.removeItem(NS + k); }
};

export function toast(msg, kind = '') {
  const root = $('#toast-root');
  if (!root) return;
  const n = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  root.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transition = '.3s'; setTimeout(() => n.remove(), 300); }, 2000);
}

/* ============================================================
   行情生成 — QQQ 1 分钟 K 线（09:30–16:00，390 根）
   同一日期永远生成同一份数据（种子伪随机）
   ============================================================ */
const BARS = 390;

/** U 型波动率：开盘与收盘波动大，午间小 */
function volShape(i) {
  const x = i / (BARS - 1);
  return 0.55 + 1.25 * Math.exp(-9 * x) + 0.85 * Math.exp(-7 * (1 - x));
}

const dayCache = new Map();

export function genDay(dateStr) {
  if (dayCache.has(dateStr)) return dayCache.get(dateStr);

  const rnd = mulberry32(hashStr('QQQ' + dateStr));
  const base = 690 + Math.floor(rnd() * 60);
  let price = base + (rnd() - 0.5) * 3;

  /* 当日性格：趋势 / 盘整 / 反转 */
  const mood = rnd();
  const trendDrift = mood < 0.34 ? (rnd() * 0.016 + 0.004)
    : mood < 0.68 ? -(rnd() * 0.016 + 0.004)
      : (rnd() - 0.5) * 0.01;
  const dayVol = 0.14 + rnd() * 0.2;

  const bars = [];
  let prevClose = price;

  for (let i = 0; i < BARS; i++) {
    const o = prevClose;
    /* 波动聚集：叠加一层慢随机，制造趋势段 */
    const shock = (rnd() - 0.5) * 2 - 1;
    const step = trendDrift * (0.4 + 0.6 * Math.sin(i / BARS * Math.PI * (1 + rnd() * 0.6)));
    const sigma = dayVol * volShape(i) * 0.055;
    let c = o + step + sigma * shock;
    /* 少量尖刺 */
    if (rnd() < 0.012) c += (rnd() - 0.5) * 5;

    const body = Math.abs(c - o);
    const wick = body * (0.25 + rnd() * 1.1) + sigma * 0.4;
    const h = Math.max(o, c) + wick * rnd();
    const l = Math.min(o, c) - wick * rnd();
    const v = Math.round((0.5 + volShape(i) * (0.6 + rnd() * 1.4)) * 46000 * (1 + body * 1.6));

    bars.push({ i, t: i, o, h, l, c, v });
    prevClose = c;
  }

  const day = {
    date: dateStr, sym: 'QQQ', bars,
    open: bars[0].o, close: bars[BARS - 1].c,
    high: Math.max(...bars.map(b => b.h)),
    low: Math.min(...bars.map(b => b.l)),
    vol: bars.reduce((s, b) => s + b.v, 0)
  };
  day.change = day.close - day.open;
  day.changePct = day.change / day.open * 100;

  dayCache.set(dateStr, day);
  return day;
}

/* ---------------- 指标 ---------------- */
export function ema(bars, n, key = 'c') {
  const k = 2 / (n + 1), out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i][key];
    if (v == null) continue;
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function vwap(bars) {
  const out = new Array(bars.length).fill(null);
  let cp = 0, cv = 0;
  for (let i = 0; i < bars.length; i++) {
    const typ = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cp += typ * bars[i].v; cv += bars[i].v;
    out[i] = cv ? cp / cv : typ;
  }
  return out;
}

export function sma(bars, n, key = 'c') {
  const out = new Array(bars.length).fill(null);
  let s = 0;
  for (let i = 0; i < bars.length; i++) {
    s += bars[i][key];
    if (i >= n) s -= bars[i - n][key];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/* ---------------- 交易日列表 ---------------- */
export function tradingDays(n = 45, endDate = new Date('2026-09-04')) {
  const out = [], d = new Date(endDate);
  while (out.length < n) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.push(fmtDate(d));
    d.setDate(d.getDate() - 1);
  }
  return out.reverse();
}

/* 取最近一个交易日 */
export function lastTradingDay() {
  const d = new Date();
  if (d.getHours() < 9) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}
