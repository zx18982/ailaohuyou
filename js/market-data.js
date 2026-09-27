/* ============================================================
   market-data.js — 市场报告真实数据加载层
   数据源：data/market/ (由 tools/scrape_market_real.py 抓取)
   - dates.json            有数据的交易日清单（日期选择器"已推送"标记）
   - pro_data/QQQ-YYYY-MM-DD.json  单日结构化报告（v7 结构）
   说明：K 线 OHLC 来自源站真实行情缓存 tj_kline_cache（Yahoo QQQ 1 分钟，
   由 tools/scrape_kline.py 抓取并预计算 bars/VWAP/EMA20/前日线到 data/market/kline/）。
   分段背景 / 买卖点 / 分段总览 / 分段详述 / 全天分析 全部来自真实 pro_data。
   ============================================================ */
import { mulberry32, hashStr } from './core.js';

const SYMBOL = 'QQQ';
const BASE = 'data/market';

let _datesCache = null;
let _promise = null;

export async function loadDates() {
  if (_datesCache) return _datesCache;
  if (_promise) return _promise;
  _promise = fetch(`${BASE}/dates.json`)
    .then(r => r.ok ? r.json() : [])
    .then(d => { _datesCache = d; return d; })
    .catch(() => { _datesCache = []; return []; });
  return _promise;
}

export function getReportDatesSync() { return _datesCache || []; }

function m2h(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* 真实 QQQ 1 分钟 K 线（含盘前，timestamp 形式）；tj_kline_cache 抓取预计算产物。
   返回 { bars:[[t,o,h,l,c,v]...], vwap:[[t,v]...], ema20:[[t,v]...], prevDay:{high,low,close} }
   加载失败返回 null（调用方回退到确定性合成）。 */
export async function loadKline(date) {
  try {
    const res = await fetch(`${BASE}/kline/${SYMBOL}-${date}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

/* 按日期确定性合成 1 分钟 K 线（09:30–16:00，391 根）—— 仅作 K 线缓存缺失时的兜底 */
export function synthBars(dateStr) {
  const r = mulberry32(hashStr('RPT' + dateStr));
  const bars = [];
  let p = 690 + r() * 70;
  for (let i = 0; i < 391; i++) {
    const min = 9 * 60 + 30 + i;
    let drift = 0, volMul = 1;
    if (i < 30)        { drift =  0.05; volMul = 0.9; }
    else if (i < 90)   { drift = -0.08; volMul = 1.3; }
    else if (i < 120)  { drift =  0.04; volMul = 1.5; }
    else if (i < 210)  { drift =  0.00; volMul = 0.7; }
    else if (i < 300)  { drift = -0.02; volMul = 0.8; }
    else               { drift =  0.01; volMul = 0.9; }
    const o = p;
    const c = p + drift + (r() - 0.5) * 0.5;
    const h = Math.max(o, c) + r() * 0.3;
    const l = Math.min(o, c) - r() * 0.3;
    const v = Math.floor((80000 + r() * 600000) * volMul);
    bars.push({ t: m2h(min), o, h, l, c, v });
    p = c;
  }
  return bars;
}

/* 真实 K 线 maResolveBar 等价：在 bars（{t:unix}）里按 ET HH:MM 命中，±2 分钟回退 */
const _etHHMM = (() => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  return (t) => f.format(new Date(t * 1000));
})();
function barByHHMM(bars, hhmm) {
  for (const b of bars) if (_etHHMM(b.t) === hhmm) return b;
  const [h, m] = hhmm.split(':').map(Number);
  for (const d of [1, -1, 2, -2]) {
    const mm = h * 60 + m + d; if (mm < 0) continue;
    const k = String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
    for (const b of bars) if (_etHHMM(b.t) === k) return b;
  }
  return null;
}

/* 方向口径：直接沿用源站原始值 'long' | 'short' | null
   （曾经擅自重映射为 bull/bear/flat，导致 market-chart 里 `seg.dir === 'long'`
    恒为 false，全部段落被判成空头 —— 已修正，不再做二次映射。） */
function segDir(s) {
  return (s.dir === 'long' || s.dir === 'short') ? s.dir : null;
}

/* 事件类型 → marker 语义（与源站 pro_data.events 的 type 取值完全对齐） */
function evKind(type) {
  switch (type) {
    case 'entry': case 'entry_and_stop': return 'entry';
    case 'add': case 'add_and_stop': return 'add';
    case 'close': case 'trend_break': return 'close';
    case 'take_profit': return 'tp';
    case 'stop': return 'stop';
    case 'signal_entry_long': case 'signal_entry_short': case 'signal_add': case 'signal_exit': return 'signal';
    default: return null;
  }
}

function evLabel(type) {
  switch (type) {
    case 'entry': return '入场';
    case 'entry_and_stop': return '入场⚠止损';
    case 'add': return '加仓';
    case 'add_and_stop': return '加仓⚠止损';
    case 'close': return '平仓';
    case 'trend_break': return '平仓';
    case 'stop': return '止损';
    case 'take_profit': return '止盈';
    case 'signal_entry_long': return '多信号';
    case 'signal_entry_short': return '空信号';
    case 'signal_add': return '加仓信号';
    case 'signal_exit': return '离场信号';
    default: return '';
  }
}

/* 解析 markdown：分段总览表 / 分段详述 / 操作建议 */
function parseReportMarkdown(md) {
  const out = { overview: [], detailByRange: {}, advice: '', morning: '' };
  if (!md) return out;
  // 分段总览表
  const ov = md.match(/###\s*分段总览([\s\S]*?)(?=###|<!--|$)/);
  if (ov) {
    for (const ln of ov[1].split('\n')) {
      const m = ln.match(/\*\*\[([\d:]+)\s*[–-]\s*([\d:]+)\]\*\*\s*\|\s*(.+)/);
      if (m) out.overview.push({ start: m[1], end: m[2], text: m[3].trim() });
    }
  }
  // 分段详述
  const dt = md.match(/###\s*分段详述([\s\S]*?)(?=\n#{1,3}\s*操作建议|<!--|$)/);
  if (dt) {
    let cur = null;
    const flush = () => { if (cur) out.detailByRange[cur.range] = { title: cur.title, body: cur.body.trim().replace(/\*\*/g, '') }; };
    for (const ln of dt[1].split('\n')) {
      const m = ln.match(/^\*\*\[([\d:]+)\s*[–-]\s*([\d:]+)\]\s*(.+?)\*\*/);
      if (m) { flush(); cur = { range: m[1] + ' – ' + m[2], title: m[3].trim(), body: '' }; }
      else if (cur) {
        if (/^---+\s*$/.test(ln.trim())) { flush(); cur = null; }
        else cur.body += ln + '\n';
      }
    }
    flush();
  }
  // 操作建议
  const ad = md.match(/(?:##|###)\s*操作建议\s*\n([\s\S]*?)(?=\n#{1,3}\s|<!--|$)/);
  if (ad) out.advice = ad[1].trim();
  return out;
}

/* 真实 pro_data 未提供「操作建议」文本；据当日分段结构 + 事件归纳一段可操作摘要，
   保证卡片始终有内容，且结论完全由真实数据推导（不臆造价位）。 */
function buildAdvice(segments, markers, pd) {
  const n = segments.length;
  if (!n) return '';
  const bulls = segments.filter(s => s.dir === 'long').length;
  const bears = segments.filter(s => s.dir === 'short').length;
  const flats = segments.filter(s => !s.dir).length;
  const entries = markers.filter(m => m.kind === 'entry' || m.kind === 'add');
  const exits   = markers.filter(m => m.kind === 'close' || m.kind === 'tp' || m.kind === 'stop');
  const parts = [];
  parts.push(`全天共 ${n} 个分析段：${bulls} 段多头、${bears} 段空头、${flats} 段无方向`);
  if (entries.length) parts.push(`实际出现入场 ${entries.length} 次（${entries.map(e => e.t).join('、')}）`);
  else parts.push('全天没有出现有效入场窗口');
  if (exits.length) parts.push(`平仓/离场 ${exits.length} 次（${exits.map(e => e.t).join('、')}）`);
  if (bears > bulls)      parts.push('整体结构偏空，思路以反弹做空为主');
  else if (bulls > bears) parts.push('整体结构偏多，思路以回撤做多为主');
  else                    parts.push('多空结构相对均衡，宜等待方向明确后再动手');
  let out = parts.join('，') + '。';
  if (pd.time_window) out += `（监测窗口 ${pd.time_window}）`;
  return out;
}

export async function getReport(date) {
  let rec = null;
  try {
    const res = await fetch(`${BASE}/pro_data/${SYMBOL}-${date}.json`);
    if (!res.ok) return null;
    rec = await res.json();
  } catch (e) { return null; }
  const pd = rec.pro_data || {};

  /* 真实 K 线（tj_kline_cache → data/market/kline）；缺失则回退确定性合成 */
  const kd = await loadKline(date);
  let bars, vwap, ema20, prevDay;
  if (kd && kd.bars && kd.bars.length) {
    bars  = kd.bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
    vwap  = (kd.vwap  || []).map(p => ({ time: p[0], value: p[1] }));
    ema20 = (kd.ema20 || []).map(p => ({ time: p[0], value: p[1] }));
    prevDay = kd.prevDay || null;
  } else {
    const sb = synthBars(date).map(b => ({ t: 0, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    bars = sb; vwap = []; ema20 = [];
    prevDay = sb.length ? { high: sb[0].o * 1.02, low: sb[0].o * 0.98, close: sb[0].o } : null;
  }

  /* 过滤退化段（start===end，0 分钟、无事件、无内容），仅保留有意义的趋势段。
     保留源站原始 dir/state 与全部段级标记，供图表 1:1 还原（多头/空头染色、买卖点、趋势破坏等）。 */
  const rawSegs = (pd.segments || []).filter(s => s.start && s.end && s.start !== s.end);
  const segments = rawSegs.map(s => ({
    idx: s.idx, start: s.start, end: s.end,
    dir: segDir(s), state: s.state || (segDir(s) ? 'DIR' : 'NODIR'),
    entryTime: s.entryTime || null, exitTime: s.exitTime || null, titleHint: s.titleHint || null,
    addTimes: Array.isArray(s.addTimes) ? s.addTimes : [],
    takeProfitTimes: Array.isArray(s.takeProfitTimes) ? s.takeProfitTimes : [],
    includedClose: s.includedClose || null,
    hasEnteredInSegment: !!s.hasEnteredInSegment,
    hasAddedInSegment: !!s.hasAddedInSegment,
    hasExitedInSegment: !!s.hasExitedInSegment,
    label: s.dir === 'long' ? '多头趋势' : s.dir === 'short' ? '空头趋势' : '无方向',
    signals: 0, entries: 0, tps: 0, detail: ''
  }));

  const evts = pd.events || [];
  for (const e of evts) {
    if (e.segmentIdx == null) continue;
    const seg = segments.find(x => x.idx === e.segmentIdx);
    if (!seg) continue;
    if (e.type === 'entry') seg.entries++;
    if (e.type === 'add') seg.entries++;
    if (e.type === 'signal_entry_long' || e.type === 'signal_entry_short') seg.signals++;
    if (e.type === 'close') seg.tps++;
  }

  /* markers：price 用真实 bar 收盘价（按 ET HH:MM 命中，±2 分钟回退） */
  const markers = evts
    .map(e => { const b = barByHHMM(bars, e.time); const k = evKind(e.type); return { t: e.time, price: b ? b.c : 0, kind: k, label: evLabel(e.type) }; })
    .filter(m => m.kind);

  const parsed = parseReportMarkdown(rec.markdown || '');
  // 用总览/详述补全分段
  const ovByRange = {};
  for (const o of parsed.overview) ovByRange[o.start + ' – ' + o.end] = o.text;
  for (const s of segments) {
    const r0 = s.start + ' – ' + s.end;
    if (ovByRange[r0]) {
      const txt = ovByRange[r0];
      s.label = txt.split(/[,，]/)[0].trim() || s.label;
    }
    if (parsed.detailByRange[r0]) {
      s.detail = parsed.detailByRange[r0].body;
      if (!s.label || s.label === '多头趋势' || s.label === '空头趋势' || s.label === '无方向')
        s.label = parsed.detailByRange[r0].title || s.label;
    }
  }

  /* 优雅降级：markdown 未覆盖到的分段（极少数），用事件/方向合成详述，避免空面板 */
  for (const s of segments) {
    if (s.detail) continue;
    const dirTxt = s.dir === 'long' ? '多头' : s.dir === 'short' ? '空头' : '无方向';
    if (s.entries || s.tps || s.signals) {
      s.detail = `本段为${dirTxt}趋势，期间出现信号 ${s.signals} 次、入场 ${s.entries} 次、平仓/止盈 ${s.tps} 次（详见图表标记）。`;
    } else {
      s.detail = `（本段为${dirTxt}过渡段，站点未提供文字详述，请参考图表标记与「分段总览」。）`;
    }
  }

  // 早盘概要：首段详述正文
  const firstSeg = segments.find(s => parsed.detailByRange[s.start + ' – ' + s.end]);
  const morning = { date, summary: firstSeg ? parsed.detailByRange[firstSeg.start + ' – ' + firstSeg.end].body.replace(/\*\*/g, '').replace(/\n+/g, ' ').slice(0, 220) : '' };

  return {
    symbol: SYMBOL, date, bars, vwap, ema20, segments, events: evts, markers, labels: [],
    morning, advice: parsed.advice || buildAdvice(segments, markers, pd), markdown: rec.markdown || '',
    barNotes: pd.bar_notes || null, minutes: pd.minutes || null, prevDay, time_window: pd.time_window || '', source: rec.source || ''
  };
}

/* 用于"全天分析"面板：直接取 markdown */
export function getReportMarkdown(date) { return getReport(date); }

/* ============================================================
   回放复盘专用：把真实 K 线（tj_kline_cache）整理成回放页 day 对象
   保留全天数据（含盘前 04:00 ET 起），按时间戳升序排序，与源站
   「回放复盘」显示范围 1:1 对齐（首根 O = 开盘前盘前价，非 09:30 RTH 价）。
   缺失返回 null（调用方回退到种子数据或提示无数据）。
   ============================================================ */
export async function loadReplayDay(date, symbol = 'QQQ') {
  const kd = await loadKline(date);
  if (!kd || !Array.isArray(kd.bars) || !kd.bars.length) return null;
  // 保留全天数据（含盘前），按时间排序，与源站「回放复盘」显示范围 1:1 对齐
  const all = kd.bars.slice().sort((a, b) => a[0] - b[0]);
  if (!all.length) return null;

  const bars = all.map((b, i) => ({ i, t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
  const open = bars[0].o, close = bars[bars.length - 1].c;
  const high = Math.max(...bars.map(b => b.h));
  const low = Math.min(...bars.map(b => b.l));
  const vol = bars.reduce((s, b) => s + b.v, 0);

  return {
    date, sym: symbol, bars,
    open, close, high, low, vol,
    change: close - open,
    changePct: (close - open) / open * 100,
    prevDay: kd.prevDay || null
  };
}

/* 在已加载的可用日期列表里前后跳到相邻交易日 */
export function stepAvailableDate(date, dir, dates) {
  if (!dates || !dates.length) return date;
  const i = dates.indexOf(date);
  if (i < 0) return dir < 0 ? dates[dates.length - 1] : dates[0];
  return dates[Math.max(0, Math.min(dates.length - 1, i + dir))];
}

/* 找最近的有数据交易日（用于任意日期输入回落） */
export function nearestAvailableDate(date, dates) {
  if (!dates || !dates.length) return date;
  if (dates.includes(date)) return date;
  // 解析成可比较的 YYYY-MM-DD
  let best = dates[0], bestD = Infinity;
  for (const d of dates) {
    const diff = Math.abs(d < date ? date.localeCompare(d) : d.localeCompare(date));
    if (diff < bestD) { bestD = diff; best = d; }
  }
  return best;
}
