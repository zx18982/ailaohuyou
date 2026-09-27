/* ============================================================
   market-chart.js — K 线图文模块（1:1 移植自源站 market.js ma* 模块）
   依赖：window.LightweightCharts (js/lib/lightweight-charts.standalone.production.js)
   数据：rep = { date, symbol, bars:[{t,o,h,l,c,v}], vwap:[{time,value}],
                ema20:[{time,value}], segments, events, markdown, barNotes, prevDay }
   说明：bars 为真实 QQQ 1 分钟（含盘前）；VWAP/EMA20 由 market-data 预计算（同口径）。
   ============================================================ */
import { $ } from './core.js';
import { renderMarkdown, escapeHtml } from './md.js';

let LightweightCharts = window.LightweightCharts;

/* ── 图表语义色 / 主题（与源站逐值一致）── */
const MA_C_GREEN = '#26a69a', MA_C_RED = '#ef5350', MA_C_GOLD = '#c9a84c', MA_C_GRAY = '#9e9e9e', MA_C_TP = '#66bb6a';
const MA_CHART_THEME = {
  dark:  { bg: '#131722', grid: '#1e2430', text: '#a3a9b5', border: '#2a3140' },
  light: { bg: '#ffffff', grid: '#f2f4f7', text: '#5b6470', border: '#e6e8ec' },
};
const MA_SEG_COLOR = {
  long:  { fill: 'rgba(38,166,154,0.10)', aFill: 'rgba(38,166,154,0.30)', lane: '#26a69a', txt: '#4cc0b0', name: '多头' },
  short: { fill: 'rgba(239,83,80,0.10)',  aFill: 'rgba(239,83,80,0.30)',  lane: '#ef5350', txt: '#f2706c', name: '空头' },
  nodir: { fill: 'rgba(150,160,180,0.05)', aFill: 'rgba(150,160,180,0.20)', name: '无方向' },
};
const MA_OHLC_HINT = '<span style="opacity:.7">悬停 K 线查看 开 / 高 / 低 / 收 · EMA20 · VWAP</span>';
const MA_SVGNS = 'http://www.w3.org/2000/svg';
const MA_LABEL_BG = {
  '入场': '#26a69a', '加仓': '#26a69a', '可做多': '#2e9b8f', '等回多': '#3aa', '可做空': '#e07a78', '等回空': '#e07a78',
  '持仓中': '#888', '待定': '#aaa', '可加仓': '#d4a017', '趋势破坏/警告': '#c9a84c',
  '止盈': '#66bb6a', '平仓': '#c9a84c',
  '入场/平仓': '#26a69a', '加仓/平仓': '#26a69a',
  '入场/趋势破坏': '#26a69a', '加仓/趋势破坏': '#26a69a',
  '有信号但不建议': '#9e9e9e',
};

/* ── 模块状态 ── */
let _chartToken = 0;
let maTheme = 'dark';
let maChart = null, maCandle = null, maVol = null, maEma20Series = null, maVwapSeries = null, maRO = null, maSegRaf = null;
let maBars = [], maByMin = {}, maActiveStart = null, maMarkerSpecs = [];
let maSegs = [], maEvents = [], maBarNotes = null, maMarkdown = '', maPrevDay = null;
let maWrapEl = null, maChartEl = null, maSvgEl = null, maTipEl = null, maOhlcEl = null, maReportEl = null;
let maPrevLines = [];
let maSegRetryLeft = 0;
let maSplitCleanup = null;

/* ── 纯函数：ET 时间格式 ── */
function maFmtEt(sec) {
  return new Date(sec * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}
function maMinOfDayEt(sec) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date(sec * 1000));
  return parseInt(p.find(x => x.type === 'hour').value, 10) * 60 + parseInt(p.find(x => x.type === 'minute').value, 10);
}
function maIsRthEt(sec) { const t = maMinOfDayEt(sec); return t >= 9 * 60 + 30 && t < 16 * 60; }

/* 段方向 → 染色键。注意：数据层保持源站原始口径 seg.dir ∈ {'long','short',null}，
   不能写成 bull/bear（历史上因二次映射导致全部段落被判为空头）。 */
function maSegColorKey(seg) {
  if (seg && seg.dir === 'long') return 'long';
  if (seg && seg.dir === 'short') return 'short';
  return 'nodir';
}
function maPad5(s) { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (m[1].padStart(2, '0') + ':' + m[2]) : s; }
function maResolveBar(hhmm) {
  if (maByMin[hhmm]) return maByMin[hhmm];
  const [h, m] = hhmm.split(':').map(Number);
  for (let d = 1; d <= 2; d++) {
    for (const dd of [d, -d]) {
      const mm = h * 60 + m + dd; if (mm < 0) continue;
      const k = String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
      if (maByMin[k]) return maByMin[k];
    }
  }
  return null;
}

/* ── DOM 抓取 ── */
function maGrabEls() {
  maWrapEl = $('#market-k-wrap'); maChartEl = $('#market-k-main'); maSvgEl = $('#market-k-svg');
  maTipEl = $('#market-k-tip'); maOhlcEl = $('#market-k-ohlc'); maReportEl = $('#market-k-report');
  return !!(maWrapEl && maChartEl);
}
function maInitChart() {
  maGrabEls();
  if (typeof LightweightCharts === 'undefined' || !LightweightCharts) LightweightCharts = window.LightweightCharts;
  if (!maWrapEl || !maChartEl || typeof LightweightCharts === 'undefined' || !LightweightCharts) return false;
  const th = MA_CHART_THEME[maTheme];
  maChart = LightweightCharts.createChart(maChartEl, {
    width: maWrapEl.clientWidth, height: maChartEl.clientHeight,
    layout: { background: { type: 'solid', color: th.bg }, textColor: th.text, fontFamily: 'inherit' },
    grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
    rightPriceScale: { borderColor: th.border, scaleMargins: { top: 0.16, bottom: 0.22 } },
    timeScale: { borderColor: th.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: (t) => maFmtEt(t) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { labelBackgroundColor: '#5b6470' }, horzLine: { labelBackgroundColor: '#5b6470' } },
    localization: { timeFormatter: (t) => maFmtEt(t) },
    handleScale: true, handleScroll: true,
  });
  maCandle = maChart.addCandlestickSeries({ upColor: MA_C_GREEN, downColor: MA_C_RED, borderVisible: false, wickUpColor: MA_C_GREEN, wickDownColor: MA_C_RED, priceLineVisible: false, lastValueVisible: false });
  maVol = maChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'mavol' });
  maChart.priceScale('mavol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  maEma20Series = maChart.addLineSeries({ color: '#2872ad', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  maVwapSeries = maChart.addLineSeries({ color: '#d24dc0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  maChart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (typeof maScheduleSegRedraw === 'function') maScheduleSegRedraw(); });
  maChart.subscribeCrosshairMove((p) => { if (typeof maOnCrosshair === 'function') maOnCrosshair(p); });
  maChart.subscribeClick((p) => { if (typeof maOnClick === 'function') maOnClick(p); });
  maRO = new ResizeObserver(() => {
    if (!maChart) return;
    maChart.applyOptions({ width: maWrapEl.clientWidth, height: maChartEl.clientHeight });
    if (typeof maScheduleSegRedraw === 'function') maScheduleSegRedraw();
  });
  maRO.observe(maWrapEl);
  return true;
}

/* ── 渲染 K 线（盘前/盘后淡色 + EMA20 + VWAP）── */
function maRenderBars(bars, indicators) {
  maBars = bars || [];
  maByMin = {};
  maBars.forEach(b => { maByMin[maFmtEt(b.t)] = b; });
  maCandle.setData(maBars.map(b => {
    const d = { time: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
    if (!maIsRthEt(b.t)) { const c = b.c >= b.o ? 'rgba(38,166,154,0.40)' : 'rgba(239,83,80,0.40)'; d.color = c; d.borderColor = c; d.wickColor = c; }
    return d;
  }));
  maVol.setData(maBars.map(b => ({
    time: b.t, value: b.v,
    color: maIsRthEt(b.t) ? (b.c >= b.o ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)') : (b.c >= b.o ? 'rgba(38,166,154,0.16)' : 'rgba(239,83,80,0.16)'),
  })));
  let ind = indicators;
  if (!ind || !ind.vwap || !ind.ema20) ind = maComputeVwapEma(maBars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
  maEma20Series.setData(ind.ema20 || []);
  maVwapSeries.setData(ind.vwap || []);
}
function maComputeVwapEma(bars) {
  if (!bars || !bars.length) return { vwap: [], ema20: [] };
  let e20 = bars[0].close, cumPV = 0, cumV = 0;
  const vwap = [], ema = [], a = 2 / 21;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3, vol = b.volume > 0 ? b.volume : 1; cumPV += tp * vol; cumV += vol;
    e20 = b.close * a + e20 * (1 - a);
    vwap.push({ time: b.time, value: cumPV / cumV }); ema.push({ time: b.time, value: e20 });
  }
  return { vwap, ema20: ema };
}

function maSetDefaultView() {
  if (!maChart) return;
  if (!Array.isArray(maSegs) || !maSegs.length) { maChart.timeScale().fitContent(); return; }
  const sBar = maResolveBar(maPad5(maSegs[0].start)), eBar = maResolveBar(maPad5(maSegs[maSegs.length - 1].end));
  if (!sBar || !eBar) { maChart.timeScale().fitContent(); return; }
  maChart.timeScale().setVisibleRange({ from: sBar.t - 15 * 60, to: eBar.t + 15 * 60 });
}

function maDisposeChart() {
  if (maSplitCleanup) { try { maSplitCleanup(); } catch (e) {} maSplitCleanup = null; }
  if (maSegRaf) { try { cancelAnimationFrame(maSegRaf); } catch (e) {} maSegRaf = null; }
  if (maRO) { try { maRO.disconnect(); } catch (e) {} maRO = null; }
  if (maChart) { try { maChart.remove(); } catch (e) {} maChart = null; }
  maCandle = maVol = maEma20Series = maVwapSeries = null;
  maBars = []; maByMin = {}; maMarkerSpecs = []; maActiveStart = null;
  if (maSvgEl) { try { maSvgEl.innerHTML = ''; } catch (e) {} }
  if (maTipEl) { try { maTipEl.style.display = 'none'; } catch (e) {} }
}

/* ── 分段染色 + markers + 截止竖线 ── */
function maScheduleSegRedraw() { if (maSegRaf) return; maSegRaf = requestAnimationFrame(() => { maSegRaf = null; maDrawSegments(); }); }
function maTgOn(name) { const el = $('#market-k-tg-' + name); return el ? el.checked : true; }

function maDrawSegments() {
  if (!maSvgEl) return;
  while (maSvgEl.firstChild) maSvgEl.removeChild(maSvgEl.firstChild);
  if (!maChart) return;
  const ts = maChart.timeScale();
  const bs = (ts.options().barSpacing) || 6;
  const W = maWrapEl.clientWidth, H = maChartEl.clientHeight;
  let _axisW = 0;
  try { const ps = maChart.priceScale('right'); _axisW = (ps && typeof ps.width === 'function') ? (ps.width() || 0) : 0; } catch (e) {}
  maSvgEl.style.clipPath = _axisW > 0 ? ('inset(0 ' + _axisW + 'px 0 0)') : 'none';
  const LANE = 4;
  let _activeSkipped = false;
  maSegs.forEach(seg => {
    const key = maSegColorKey(seg);
    if (!maTgOn(key)) return;
    const active = (maActiveStart === seg.start);
    const sBar = maResolveBar(maPad5(seg.start)), eBar = maResolveBar(maPad5(seg.end));
    if (!sBar || !eBar) return;
    let x1 = ts.timeToCoordinate(sBar.t), x2 = ts.timeToCoordinate(eBar.t);
    if (x1 == null && x2 == null) { if (active) _activeSkipped = true; return; }
    if (x1 == null) x1 = 0; if (x2 == null) x2 = W;
    const left = Math.max(0, Math.min(x1, x2) - bs / 2);
    const right = Math.min(W, Math.max(x1, x2) + bs / 2);
    const w = Math.max(1, right - left);
    const col = MA_SEG_COLOR[key];
    const r = document.createElementNS(MA_SVGNS, 'rect');
    r.setAttribute('x', left); r.setAttribute('y', 0); r.setAttribute('width', w); r.setAttribute('height', H);
    r.setAttribute('fill', active ? col.aFill : col.fill);
    if (active && col.lane) { r.setAttribute('stroke', col.lane); r.setAttribute('stroke-width', '1.5'); r.setAttribute('stroke-opacity', '0.5'); }
    maSvgEl.appendChild(r);
    if (key === 'nodir') return;
    const lane = document.createElementNS(MA_SVGNS, 'rect');
    lane.setAttribute('x', left); lane.setAttribute('y', 0); lane.setAttribute('width', w); lane.setAttribute('height', LANE);
    lane.setAttribute('fill', col.lane); lane.setAttribute('opacity', active ? 1 : 0.65);
    maSvgEl.appendChild(lane);
    if (w > 46) {
      const t = document.createElementNS(MA_SVGNS, 'text');
      t.setAttribute('x', left + 6); t.setAttribute('y', LANE + 15);
      t.setAttribute('fill', col.txt); t.setAttribute('opacity', active ? 1 : 0.9);
      t.textContent = col.name;
      maSvgEl.appendChild(t);
    }
  });
  const lastSeg = maSegs[maSegs.length - 1];
  if (lastSeg) {
    const _last = maResolveBar(maPad5(lastSeg.end));
    if (_last) {
      let xe = ts.timeToCoordinate(_last.t);
      if (xe != null) {
        xe += bs / 2;
        const ln = document.createElementNS(MA_SVGNS, 'line');
        ln.setAttribute('x1', xe); ln.setAttribute('x2', xe); ln.setAttribute('y1', 0); ln.setAttribute('y2', H);
        ln.setAttribute('stroke', 'rgba(170,180,195,0.45)'); ln.setAttribute('stroke-width', 1); ln.setAttribute('stroke-dasharray', '4 4');
        maSvgEl.appendChild(ln);
        const tx = document.createElementNS(MA_SVGNS, 'text');
        tx.setAttribute('x', xe - 6); tx.setAttribute('y', H - 8); tx.setAttribute('text-anchor', 'end');
        tx.setAttribute('fill', 'rgba(170,180,195,0.85)'); tx.setAttribute('font-size', '10');
        tx.textContent = '分析数据至此';
        maSvgEl.appendChild(tx);
      }
    }
  }
  const showText = maTgOn('mktext');
  const GAP = 12;
  const unit = Math.max(3, Math.min(9, bs * 0.5));
  const placed = { below: [], above: [] };
  let _skipped = 0;
  maMarkerSpecs.forEach(s => {
    const x = ts.timeToCoordinate(s.t); if (x == null) { _skipped++; return; }
    const baseY = maCandle.priceToCoordinate(s.price); if (baseY == null) { _skipped++; return; }
    const R = unit * s.size, below = s.side === 'below';
    const cy = below ? baseY + GAP + R : baseY - GAP - R;
    if (s.shape === 'circle') {
      const c = document.createElementNS(MA_SVGNS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', cy); c.setAttribute('r', R); c.setAttribute('fill', s.color);
      maSvgEl.appendChild(c);
    } else if (s.shape === 'square') {
      const rr = document.createElementNS(MA_SVGNS, 'rect');
      rr.setAttribute('x', x - R); rr.setAttribute('y', cy - R); rr.setAttribute('width', R * 2); rr.setAttribute('height', R * 2);
      rr.setAttribute('rx', 1); rr.setAttribute('fill', s.color);
      maSvgEl.appendChild(rr);
    } else if (s.shape === 'circleMinus') {
      const c = document.createElementNS(MA_SVGNS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', cy); c.setAttribute('r', R * 0.92);
      c.setAttribute('fill', 'none'); c.setAttribute('stroke', s.color); c.setAttribute('stroke-width', Math.max(1.6, R * 0.3));
      maSvgEl.appendChild(c);
      const mbar = document.createElementNS(MA_SVGNS, 'line');
      mbar.setAttribute('x1', x - R * 0.5); mbar.setAttribute('y1', cy); mbar.setAttribute('x2', x + R * 0.5); mbar.setAttribute('y2', cy);
      mbar.setAttribute('stroke', s.color); mbar.setAttribute('stroke-width', Math.max(1.8, R * 0.34)); mbar.setAttribute('stroke-linecap', 'round');
      maSvgEl.appendChild(mbar);
    } else if (s.shape === 'diamond') {
      const d = R * 1.15;
      const poly = document.createElementNS(MA_SVGNS, 'polygon');
      poly.setAttribute('points', `${x},${cy - d} ${x + d},${cy} ${x},${cy + d} ${x - d},${cy}`);
      poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', s.color);
      poly.setAttribute('stroke-width', Math.max(1.6, R * 0.3)); poly.setAttribute('stroke-linejoin', 'round');
      maSvgEl.appendChild(poly);
    } else if (s.shape === 'circleX') {
      const c = document.createElementNS(MA_SVGNS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', cy); c.setAttribute('r', R);
      c.setAttribute('fill', 'none'); c.setAttribute('stroke', s.color); c.setAttribute('stroke-width', Math.max(1.4, R * 0.26));
      maSvgEl.appendChild(c);
      const r2 = R * 0.6, xw = Math.max(1.4, R * 0.28);
      [[x - r2, cy - r2, x + r2, cy + r2], [x + r2, cy - r2, x - r2, cy + r2]].forEach(p => {
        const ln = document.createElementNS(MA_SVGNS, 'line');
        ln.setAttribute('x1', p[0]); ln.setAttribute('y1', p[1]); ln.setAttribute('x2', p[2]); ln.setAttribute('y2', p[3]);
        ln.setAttribute('stroke', s.color); ln.setAttribute('stroke-width', xw); ln.setAttribute('stroke-linecap', 'round');
        maSvgEl.appendChild(ln);
      });
    } else {
      const h = R * 1.9, w = R * 1.7;
      const pts = s.shape === 'triUp'
        ? `${x},${cy - h / 2} ${x - w / 2},${cy + h / 2} ${x + w / 2},${cy + h / 2}`
        : `${x},${cy + h / 2} ${x - w / 2},${cy - h / 2} ${x + w / 2},${cy - h / 2}`;
      const tri = document.createElementNS(MA_SVGNS, 'polygon');
      tri.setAttribute('points', pts); tri.setAttribute('fill', s.color);
      maSvgEl.appendChild(tri);
    }
    if (showText && s.text) {
      const w = s.text.length * 10 + 4, lineH = 13, arr = placed[below ? 'below' : 'above'];
      let by = below ? cy + R + 12 : cy - R - 6;
      const mkbox = () => ({ x0: x - w / 2, x1: x + w / 2, y0: by - 10, y1: by + 3 });
      let bx = mkbox(), g = 0;
      while (g++ < 12 && arr.some(o => bx.x0 < o.x1 && bx.x1 > o.x0 && bx.y0 < o.y1 && bx.y1 > o.y0)) { by += below ? lineH : -lineH; bx = mkbox(); }
      arr.push(bx);
      const t2 = document.createElementNS(MA_SVGNS, 'text');
      t2.setAttribute('x', x); t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('y', by);
      t2.setAttribute('fill', s.color); t2.setAttribute('font-size', '11');
      t2.textContent = s.text;
      maSvgEl.appendChild(t2);
    }
  });
  if (((_skipped > 0 && maMarkerSpecs.length > 0) || _activeSkipped) && maSegRetryLeft > 0) {
    maSegRetryLeft--;
    requestAnimationFrame(() => maScheduleSegRedraw());
  }
}

function maEventsToMarkers() {
  const evs = Array.isArray(maEvents) ? maEvents : [];
  const segs = Array.isArray(maSegs) ? maSegs : [];
  /* 关键：段数组已过滤掉退化段，数组下标 ≠ 段 idx，必须按 idx 建索引查找 */
  const segByIdx = {};
  segs.forEach(s => { if (s.idx != null) segByIdx[s.idx] = s; });
  const pairedEntry = new Set(evs.filter(e => e.type === 'entry' || e.type === 'entry_and_stop').map(e => e.pairedSignalTime));
  const pairedAdd = new Set(evs.filter(e => e.type === 'add' || e.type === 'add_and_stop').map(e => e.pairedSignalTime));
  const dirOf = e => {
    const s = segByIdx[e.segmentIdx];
    if (s && (s.dir === 'long' || s.dir === 'short')) return s.dir;
    if (/short/.test(String(e.type || ''))) return 'short';
    return 'long';
  };
  const on = cat => maTgOn(cat);
  const specs = [];
  evs.forEach(e => {
    const bar = maResolveBar(maPad5(e.time)); if (!bar) return;
    const isLong = dirOf(e) === 'long';
    const sigSide = isLong ? 'above' : 'below';
    const exeSide = isLong ? 'below' : 'above';
    const at = side => ({ side, price: side === 'above' ? bar.h : bar.l });
    let s = null;
    switch (e.type) {
      case 'signal_entry_long': case 'signal_entry_short': {
        if (!on('signal')) return;
        const fired = pairedEntry.has(e.time);
        s = Object.assign({ t: bar.t, shape: fired ? 'circle' : 'circleX', size: 0.85, color: fired ? (isLong ? MA_C_GREEN : MA_C_RED) : MA_C_GRAY, text: fired ? (isLong ? '多·信号' : '空·信号') : '⚠未触发' }, at(sigSide));
        break;
      }
      case 'entry': case 'entry_and_stop':
        if (!on('entry')) return;
        s = Object.assign({ t: bar.t, shape: isLong ? 'triUp' : 'triDown', size: 1.6, color: isLong ? MA_C_GREEN : MA_C_RED, text: e.type === 'entry_and_stop' ? '入场⚠止损' : '入场' }, at(exeSide));
        break;
      case 'signal_add': {
        if (!on('signal')) return;
        const fired = pairedAdd.has(e.time);
        s = Object.assign({ t: bar.t, shape: fired ? 'circle' : 'circleX', size: 0.85, color: fired ? (isLong ? MA_C_GREEN : MA_C_RED) : MA_C_GRAY, text: fired ? '加·信号' : '⚠未触发' }, at(sigSide));
        break;
      }
      case 'add': case 'add_and_stop':
        if (!on('add')) return;
        s = Object.assign({ t: bar.t, shape: isLong ? 'triUp' : 'triDown', size: 1.05, color: isLong ? MA_C_GREEN : MA_C_RED, text: e.type === 'add_and_stop' ? '加仓⚠止损' : '加仓' }, at(exeSide));
        break;
      case 'close': {
        if (!on('break')) return;
        s = Object.assign({ t: bar.t, shape: 'circleMinus', size: 0.95, color: MA_C_GOLD, text: '平仓' }, at(sigSide));
        break;
      }
      case 'take_profit': {
        if (!on('tp')) return;
        s = Object.assign({ t: bar.t, shape: 'diamond', size: 1.0, color: MA_C_TP, text: '止盈' }, at(sigSide));
        break;
      }
      case 'trend_break': {
        const seg = segByIdx[e.segmentIdx];
        if (seg && seg.hasEnteredInSegment === false) return;
        if (!on('break')) return;
        s = Object.assign({ t: bar.t, shape: 'circleMinus', size: 0.95, color: MA_C_GOLD, text: '平仓' }, at(sigSide));
        break;
      }
      case 'signal_not_recommend':
        if (!on('signal')) return;
        s = Object.assign({ t: bar.t, shape: 'circleX', size: 0.85, color: MA_C_GRAY, text: '⚠不建议' }, at(sigSide));
        break;
    }
    if (s) specs.push(s);
  });
  maMarkerSpecs = specs;
  maSegRetryLeft = 8;
  maScheduleSegRedraw();
}

function maDrawPrevDay() {
  if (!maCandle) return;
  maPrevLines.forEach(pl => { try { maCandle.removePriceLine(pl); } catch (e) {} });
  maPrevLines = [];
  const _ph = $('#market-k-lg-ph'), _pl = $('#market-k-lg-pl'), _pc = $('#market-k-lg-pc');
  if (!maTgOn('prevday') || !maPrevDay) {
    if (_ph) _ph.textContent = '–'; if (_pl) _pl.textContent = '–'; if (_pc) _pc.textContent = '–';
    return;
  }
  const DS = (typeof LightweightCharts !== 'undefined' && LightweightCharts.LineStyle && LightweightCharts.LineStyle.Dashed) || 2;
  [['前高', maPrevDay.high, MA_C_RED], ['前低', maPrevDay.low, MA_C_GREEN], ['前收', maPrevDay.close, '#9aa1ad']].forEach(([title, price, color]) => {
    if (price == null) return;
    maPrevLines.push(maCandle.createPriceLine({ price, color, lineWidth: 1, lineStyle: DS, axisLabelVisible: true, title }));
  });
  if (_ph && maPrevDay.high != null) _ph.textContent = maPrevDay.high.toFixed(2);
  if (_pl && maPrevDay.low != null) _pl.textContent = maPrevDay.low.toFixed(2);
  if (_pc && maPrevDay.close != null) _pc.textContent = maPrevDay.close.toFixed(2);
}

function maOnCrosshair(param) {
  if (!maTipEl || !maOhlcEl) return;
  if (!param.time || !param.point || param.point.x < 0) { maTipEl.style.display = 'none'; maOhlcEl.innerHTML = MA_OHLC_HINT; maSetActive(null, false); return; }
  const hhmm = maFmtEt(param.time);
  const seg = maSegAtMinute(hhmm);
  maSetActive(seg ? seg.start : null, false);
  if (!maTgOn('hover')) { maTipEl.style.display = 'none'; maOhlcEl.innerHTML = MA_OHLC_HINT; return; }
  const cd = param.seriesData.get(maCandle);
  if (cd) {
    const chg = cd.close - cd.open, pct = cd.open ? chg / cd.open * 100 : 0;
    const col = chg >= 0 ? '#1f8a7d' : '#c0392b';
    const ema = param.seriesData.get(maEma20Series), vw = param.seriesData.get(maVwapSeries);
    maOhlcEl.innerHTML = `<b>${hhmm}</b>　开 <i>${cd.open.toFixed(2)}</i>　高 <i>${cd.high.toFixed(2)}</i>　低 <i>${cd.low.toFixed(2)}</i>　收 <i style="color:${col}">${cd.close.toFixed(2)}</i>　<span style="color:${col}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct.toFixed(2)}%)</span>`
      + (ema && ema.value != null ? `　·　EMA20 <i>${ema.value.toFixed(2)}</i>` : '')
      + (vw && vw.value != null ? `　·　VWAP <i>${vw.value.toFixed(2)}</i>` : '');
  } else { maOhlcEl.innerHTML = MA_OHLC_HINT; }
  const bn = maBarNotes && maBarNotes[hhmm];
  if (bn) {
    const bg = MA_LABEL_BG[bn.label] || '#778';
    maTipEl.innerHTML = `<div class="tt-time">${escapeHtml(hhmm)}</div>`
      + `<span class="tt-label" style="background:${bg};color:#fff">${escapeHtml(bn.label || '')}</span>`
      + `<div class="tt-note">${escapeHtml(bn.note || '')}</div>`;
    maTipEl.style.display = 'block';
    const wr = maWrapEl.getBoundingClientRect();
    let x = param.point.x + 16, y = param.point.y + 12;
    if (x + maTipEl.offsetWidth > wr.width) x = param.point.x - maTipEl.offsetWidth - 16;
    if (y + maTipEl.offsetHeight > wr.height) y = wr.height - maTipEl.offsetHeight - 6;
    maTipEl.style.left = Math.max(4, x) + 'px'; maTipEl.style.top = Math.max(4, y) + 'px';
  } else { maTipEl.style.display = 'none'; }
}
function maSegAtMinute(hhmm) {
  let hit = null;
  maSegs.forEach(s => { if (s.start <= hhmm && hhmm <= s.end) hit = s; });
  return hit;
}
function maOnClick(param) {
  if (!param.time) return;
  const seg = maSegAtMinute(maFmtEt(param.time));
  if (seg) maSetActive(seg.start, true);
}
function maSetActive(startHHMM, scroll) {
  if (maActiveStart === startHHMM && !scroll) return;
  maActiveStart = startHHMM;
  maScheduleSegRedraw();
  if (!maReportEl) return;
  maReportEl.querySelectorAll('.market-k-link.active').forEach(el => el.classList.remove('active'));
  if (startHHMM) {
    const els = maReportEl.querySelectorAll('.market-k-link[data-start="' + startHHMM + '"]');
    els.forEach(el => el.classList.add('active'));
    if (scroll && els.length) {
      const tgt = els[els.length - 1];
      const top = tgt.getBoundingClientRect().top - maReportEl.getBoundingClientRect().top + maReportEl.scrollTop - 12;
      maReportEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }
}

function maRenderReport() {
  if (!maReportEl) return;
  maReportEl.innerHTML = '<div class="market-mdout">' + renderMarkdown(maMarkdown || '') + '</div>';
  const re = /\[(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})\]/;
  maReportEl.querySelectorAll('table tr').forEach(tr => {
    const m = tr.textContent.match(re); if (!m) return;
    tr.dataset.start = maPad5(m[1]); tr.classList.add('market-k-link');
  });
  const segTimeRe = /(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/;
  maReportEl.querySelectorAll('p.market-seg-line, .market-seg-header').forEach(el => {
    const m = el.textContent.match(segTimeRe); if (!m) return;
    el.dataset.start = maPad5(m[1]); el.classList.add('market-k-link');
  });
  maReportEl.querySelectorAll('.market-k-link').forEach(el => {
    el.addEventListener('mouseenter', () => maSetActive(el.dataset.start, false));
    el.addEventListener('click', () => maSetActive(el.dataset.start, false));
  });
  const sticky = document.createElement('div'); sticky.id = 'market-k-sticky';
  maReportEl.insertBefore(sticky, maReportEl.firstChild);
  maReportEl.addEventListener('scroll', maUpdateSticky);
}
function maUpdateSticky() {
  const sticky = $('#market-k-sticky'); if (!sticky || !maReportEl) return;
  const heads = maReportEl.querySelectorAll('p.market-k-link[data-start]');
  const fold = maReportEl.getBoundingClientRect().top + 44;
  let cur = null;
  for (const h of heads) { if (h.getBoundingClientRect().top <= fold) cur = h; else break; }
  if (cur) { sticky.textContent = (cur.textContent || '').trim(); sticky.style.display = 'block'; }
  else sticky.style.display = 'none';
}

/* ── 脚手架 DOM ── */
function maScaffoldHtml(opts) {
  const adminTheme = (opts && opts.admin) ? '<button class="market-k-vbtn" id="market-k-btn-theme">浅色</button>' : '';
  return '<div id="market-k-root">'
    + '<div id="market-k-stage">'
    + '<div class="market-k-controls">'
    + '<span class="market-k-grp"><b>分段</b>'
    + '<label><input type="checkbox" id="market-k-tg-long" checked> 多头</label>'
    + '<label><input type="checkbox" id="market-k-tg-short" checked> 空头</label>'
    + '<label><input type="checkbox" id="market-k-tg-nodir"> 无方向</label>'
    + '</span><span class="market-k-sep"></span>'
    + '<span class="market-k-grp"><b>标记</b>'
    + '<label><input type="checkbox" id="market-k-tg-entry" checked> 入场</label>'
    + '<label><input type="checkbox" id="market-k-tg-add" checked> 加仓</label>'
    + '<label><input type="checkbox" id="market-k-tg-break" checked> 平仓</label>'
    + '<label><input type="checkbox" id="market-k-tg-tp" checked> 止盈</label>'
    + '<label title="信号点 / 未触发 / 不建议 等提示标记(默认关)"><input type="checkbox" id="market-k-tg-signal"> 信号提示</label>'
    + '<label title="在标记上叠加说明文字"><input type="checkbox" id="market-k-tg-mktext" checked> 文字</label>'
    + '</span><span class="market-k-sep"></span>'
    + '<span class="market-k-grp"><b>指标</b>'
    + '<label><input type="checkbox" id="market-k-tg-ema" checked> EMA20</label>'
    + '<label><input type="checkbox" id="market-k-tg-vwap" checked> VWAP</label>'
    + '<label><input type="checkbox" id="market-k-tg-vol" checked> 量</label>'
    + '<label><input type="checkbox" id="market-k-tg-prevday"> 前日线</label>'
    + '</span><span class="market-k-sep"></span>'
    + '<label><input type="checkbox" id="market-k-tg-hover" checked> 悬停读数</label>'
    + '<span class="market-k-sep"></span>'
    + '<button class="market-k-vbtn" id="market-k-btn-seg">分析段</button>'
    + '<button class="market-k-vbtn" id="market-k-btn-day">全天</button>'
    + adminTheme
    + '</div>'
    + '<div class="market-k-legend">'
    + '<span class="lg"><span class="sw" style="background:rgba(38,166,154,.18);border:1px solid rgba(38,166,154,.5)"></span>多头段</span>'
    + '<span class="lg"><span class="sw" style="background:rgba(239,83,80,.18);border:1px solid rgba(239,83,80,.5)"></span>空头段</span>'
    + '<span class="lg"><span class="sw" style="background:rgba(150,150,160,.12);border:1px solid rgba(150,150,160,.4)"></span>无方向</span>'
    + '<span class="lg"><span class="tri" style="border-bottom:8px solid #26a69a"></span>入场/加仓(多)</span>'
    + '<span class="lg"><span class="tri" style="border-top:8px solid #ef5350"></span>入场/加仓(空)</span>'
    + '<span class="lg"><svg width="13" height="13" style="vertical-align:-2px"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="#c9a84c" stroke-width="1.6"></circle><line x1="3.5" y1="6.5" x2="9.5" y2="6.5" stroke="#c9a84c" stroke-width="1.8" stroke-linecap="round"></line></svg> 平仓</span>'
    + '<span class="lg"><svg width="13" height="13" style="vertical-align:-2px"><polygon points="6.5,1.5 11.5,6.5 6.5,11.5 1.5,6.5" fill="none" stroke="#66bb6a" stroke-width="1.6" stroke-linejoin="round"></polygon></svg> 止盈</span>'
    + '<span class="lg"><span class="dot" style="background:#26a69a"></span>信号点(默认隐藏)</span>'
    + '<span class="lg"><svg width="13" height="13" style="vertical-align:-2px"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="#9e9e9e" stroke-width="1.4"></circle><line x1="3.5" y1="3.5" x2="9.5" y2="9.5" stroke="#9e9e9e" stroke-width="1.4" stroke-linecap="round"></line><line x1="9.5" y1="3.5" x2="3.5" y2="9.5" stroke="#9e9e9e" stroke-width="1.4" stroke-linecap="round"></line></svg> 未触发/不建议</span>'
    + '<span class="lg"><span class="ln" style="border-color:#ef5350"></span>前高 <b id="market-k-lg-ph">–</b></span>'
    + '<span class="lg"><span class="ln" style="border-color:#26a69a"></span>前低 <b id="market-k-lg-pl">–</b></span>'
    + '<span class="lg"><span class="ln" style="border-color:#9aa1ad"></span>前收 <b id="market-k-lg-pc">–</b></span>'
    + '</div>'
    + '<div id="market-k-ohlc"></div>'
    + '<div id="market-k-wrap"><div id="market-k-main"></div><svg id="market-k-svg"></svg><div id="market-k-tip"></div></div>'
    + '</div>'
    + '<div id="market-k-splitter" title="上下拖拽调整 K线 / 报告 比例"></div>'
    + '<div id="market-k-report"></div>'
    + '</div>';
}

function maBindToggles(opts) {
  const bind = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };
  ['long', 'short', 'nodir'].forEach(n => bind('market-k-tg-' + n, 'change', maDrawSegments));
  ['entry', 'add', 'break', 'tp', 'signal', 'mktext'].forEach(n => bind('market-k-tg-' + n, 'change', maEventsToMarkers));
  bind('market-k-tg-ema', 'change', e => { if (maEma20Series) maEma20Series.applyOptions({ visible: e.target.checked }); });
  bind('market-k-tg-vwap', 'change', e => { if (maVwapSeries) maVwapSeries.applyOptions({ visible: e.target.checked }); });
  bind('market-k-tg-vol', 'change', e => { if (maVol) maVol.applyOptions({ visible: e.target.checked }); });
  bind('market-k-tg-hover', 'change', e => { if (!e.target.checked && maTipEl) { maTipEl.style.display = 'none'; if (maOhlcEl) maOhlcEl.innerHTML = MA_OHLC_HINT; } });
  bind('market-k-btn-seg', 'click', maSetDefaultView);
  bind('market-k-btn-day', 'click', () => { if (maChart) maChart.timeScale().fitContent(); });
  bind('market-k-tg-prevday', 'change', maDrawPrevDay);
}

/* ── 图表尺寸自适应（窗口缩放 / 拖拽分隔条后调用）── */
function maResizeChart() {
  if (!maChart || !maWrapEl || !maChartEl) return;
  maChart.applyOptions({ width: maWrapEl.clientWidth, height: maChartEl.clientHeight });
  maScheduleSegRedraw();
}

/* ── K 线 / 报告 分隔条拖拽（源站交互，1:1 补实现）── */
function maBindSplitter() {
  if (maSplitCleanup) { try { maSplitCleanup(); } catch (e) {} maSplitCleanup = null; }
  const sp = $('#market-k-splitter'), stage = $('#market-k-stage');
  if (!sp || !stage || !maReportEl) return;
  let dragging = false, startY = 0, startRepH = 0, rootH = 0, spH = 0;
  const apply = (repH) => {
    const sh = Math.max(200, rootH - spH - repH);
    stage.style.flex = '0 0 ' + sh + 'px';
    maReportEl.style.flex = '0 0 ' + (rootH - spH - sh) + 'px';
    maReportEl.style.height = (rootH - spH - sh) + 'px';
    maReportEl.style.maxHeight = 'none';
    maResizeChart();
  };
  const onDown = (e) => {
    const root = $('#market-k-root'); if (!root || !maReportEl) return;
    dragging = true; startY = e.clientY;
    rootH = root.getBoundingClientRect().height;
    spH = sp.getBoundingClientRect().height + 6;
    startRepH = maReportEl.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    if (sp.setPointerCapture && e.pointerId != null) { try { sp.setPointerCapture(e.pointerId); } catch (err) {} }
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const repH = Math.max(150, Math.min(rootH - spH - 200, startRepH - dy));
    apply(repH);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  sp.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  maSplitCleanup = () => {
    sp.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
}

/* ── 渲染入口：把图表 + 报告渲染进 mount（替代源站 renderMemberChartReport 的 #market-ai-content）── */
export function renderMarketChart(mount, rep, opts) {
  opts = opts || {};
  maDisposeChart();
  const myToken = ++_chartToken;
  if (!rep) {
    mount.innerHTML = '<div class="market-empty-hint" style="font-size:14px;line-height:1.9;color:var(--text-2)">该日报告数据缺失。</div>';
    return;
  }
  mount.innerHTML = maScaffoldHtml(opts);
  maGrabEls();
  maMarkdown = rep.markdown || '';
  maBarNotes = (rep.barNotes && typeof rep.barNotes === 'object') ? rep.barNotes : null;
  maRenderReport();
  // 真实 K 线
  const bars = (rep.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  if (myToken !== _chartToken) return;
  if (!bars.length) { const stage = $('#market-k-stage'); if (stage) stage.style.display = 'none'; return; }
  maSegs = (Array.isArray(rep.segments) ? rep.segments : []).map(s => Object.assign({}, s, { start: maPad5(s.start), end: maPad5(s.end) }));
  maEvents = Array.isArray(rep.events) ? rep.events : [];
  maPrevDay = rep.prevDay || null;
  if (!maInitChart()) { const stage = $('#market-k-stage'); if (stage) stage.style.display = 'none'; return; }
  maRenderBars(bars, { vwap: rep.vwap || [], ema20: rep.ema20 || [] });
  maSetDefaultView();
  maEventsToMarkers();
  maDrawPrevDay();
  maBindToggles(opts);
  maBindSplitter();
  if (maOhlcEl) maOhlcEl.innerHTML = MA_OHLC_HINT;
  if (maWrapEl) maWrapEl.addEventListener('mouseleave', () => { if (maTipEl) maTipEl.style.display = 'none'; if (maOhlcEl) maOhlcEl.innerHTML = MA_OHLC_HINT; maSetActive(null, false); });
  requestAnimationFrame(() => { if (myToken === _chartToken) maDrawSegments(); });
}

export function disposeMarketChart() { maDisposeChart(); }
