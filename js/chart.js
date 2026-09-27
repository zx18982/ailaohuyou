/* ============================================================
   chart.js — 自研 Canvas K 线引擎
   支持：K线+成交量 / EMA·VWAP / 十字光标 / 画线工具 / 逐根揭示 / 交易标记
   ============================================================ */
import { ema, vwap, clamp, barTime } from './core.js';

const PAD_R = 62;          // 右侧价格轴
const PAD_B = 22;          // 底部时间轴
const VOL_RATIO = 0.18;    // 默认成交量占比
const MIN_VOL_RATIO = 0.08;// 成交量区最小占比
const MAX_VOL_RATIO = 0.45;// 成交量区最大占比
const GAP = 5;             // 主副图间隙

export class Chart {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    host.appendChild(this.canvas);

    this.bars = [];
    this.reveal = 0;          // 已揭示根数（回放）
    this.mas = { ema9: true, ema20: true, ema60: true, vwap: true };
    this.markers = [];        // {i, price, type:'buy'|'sell'|'entry'|'exit', label}
    this.overlays = [];       // [{kind:'seg'|'label'|'buy'|'sell'|'flat', ...}] 市场报告叠加
    this.drawings = [];       // {type:'hline'|'trend', ...}
    this.tool = 'cursor';
    this.pending = null;      // 正在拖拽的图形
    this.hoverIdx = -1;
    this.mouse = null;
    this._follow = true;       // 自动跟随最新揭示（回放自动滚动到右边缘）
    this._playing = false;     // 外部 play/pause 同步；松手且正在播放时恢复跟随
    this._drag = null;         // 拖动平移状态
    this._splitDrag = null;    // 拖动成交量/主图分割线状态
    this.volRatio = VOL_RATIO; // 成交量区占比，可通过拖动分割线调整
    this._viewSpan = 120;      // 回放默认可见窗口（根数）：约 2 小时，9:30 居中
    this.pendingOrder = null; // {price, side} 挂单价位预览
    this.onPricePick = null;  // 点选价位回调
    this.upColor = '#26a69a';     // 源站/美股习惯：涨=绿
    this.downColor = '#ef5350';   // 跌=红

    this._bind();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(host);
  }

  destroy() { this._ro?.disconnect(); this.canvas.remove(); }

  /* ---------------- 数据 ---------------- */
  setBars(bars) {
    this.bars = bars;
    this._calc();
    this._initView();
    this.render();
  }
  setReveal(n) {
    this.reveal = clamp(n, 0, this.bars.length);
    if (this._follow) this._applyFollow();
    this.render();
  }
  /* 可见窗口以当前揭示位（playback cursor）为中心，类似源站默认布局：
     9:30 初始居中，左右均能看到盘前/盘中；播放时窗口平滑跟随光标滚动。
     全天揭示完毕后吸附到最右端。 */
  _applyFollow() {
    const SPAN = this._viewSpan;
    const rev = this.reveal;
    const total = this.bars.length;
    if (rev >= total) {
      const from = Math.max(0, total - SPAN);
      this._view = { from, to: total };
      return;
    }
    /* 以当前播放头（已揭示的最后一根）为中心，使 9:30 初始居中；
       右侧留白区域为尚未播放的未来 K 线，逐帧播放时再逐根显现。 */
    const half = Math.floor(SPAN / 2);
    let from = (rev - 1) - half;
    if (from < 0) from = 0;
    let to = Math.min(total, from + SPAN);
    from = Math.max(0, to - SPAN);
    this._view = { from, to };
  }
  /* 恢复"跟随最新"并吸附到右边缘（外部 play / 拖动松手且正在播放时调用） */
  followLatest() {
    this._applyFollow();
    this._follow = true;
    this.render();
  }
  /* 外部同步播放状态：true=正在自动播放（松手后自动恢复跟随）；false=暂停（停在拖到的位置） */
  setPlaying(p) { this._playing = !!p; }
  setMarkers(m) { this.markers = m; this.render(); }
  setOverlays(o) { this.overlays = o || []; this.render(); }

  setPrevDay(pd) {
    this.prevDay = pd && { high: pd.high, low: pd.low, close: pd.close };
    this.render();
  }

  /* 前日高/低/收 参考线（金色虚线 + 左右标签） */
  _prevLevels(r) {
    if (!this.prevDay) return;
    const c = this.ctx;
    const items = [
      ['high', '前高', this.prevDay.high],
      ['low', '前低', this.prevDay.low],
      ['close', '前收', this.prevDay.close]
    ];
    for (const [, lab, val] of items) {
      if (val == null) continue;
      const y = Math.round(this.yAt(val, r)) + .5;
      if (y < 0 || y > this.priceH) continue;
      c.strokeStyle = 'rgba(245,158,11,.55)';
      c.lineWidth = 1; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
      c.setLineDash([]);
      /* 左侧标签 */
      c.fillStyle = 'rgba(245,158,11,.9)';
      c.font = '10px ui-monospace,monospace'; c.textAlign = 'left';
      c.fillText(`${lab} ${val.toFixed(2)}`, 12, y - 4);
      /* 右侧价格标签 */
      c.fillStyle = 'rgba(245,158,11,.85)';
      c.fillRect(this.w - PAD_R + 2, y - 8, PAD_R - 6, 16);
      c.fillStyle = '#0b0e13'; c.textAlign = 'left';
      c.fillText(val.toFixed(2), this.w - PAD_R + 6, y + 4);
    }
  }

  setCloud(on) {
    if (on) {
      this.cloudA = this._ichi('spanA', 9, 26);
      this.cloudB = this._ichi('spanB', 26, 52);
    } else {
      this.cloudA = this.cloudB = null;
    }
    this.render();
  }

  /* 一目均衡表：基于 high/low 数组计算各线 */
  _ichi(kind, fast, slow) {
    const n = this.bars.length;
    const out = new Array(n).fill(null);
    const hh = i => { let mx = -Infinity; for (let k = i - fast + 1; k <= i; k++) if (this.bars[k]?.h > mx) mx = this.bars[k].h; return mx; };
    const ll = i => { let mn =  Infinity; for (let k = i - fast + 1; k <= i; k++) if (this.bars[k]?.l < mn) mn = this.bars[k].l; return mn; };
    const hh2 = i => { let mx = -Infinity; for (let k = i - slow + 1; k <= i; k++) if (this.bars[k]?.h > mx) mx = this.bars[k].h; return mx; };
    const ll2 = i => { let mn =  Infinity; for (let k = i - slow + 1; k <= i; k++) if (this.bars[k]?.l < mn) mn = this.bars[k].l; return mn; };
    const tenkan = new Array(n).fill(null);
    const kijun  = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i >= fast - 1) tenkan[i] = (hh(i) + ll(i)) / 2;
      if (i >= slow - 1) kijun[i]  = (hh2(i) + ll2(i)) / 2;
    }
    for (let i = 0; i < n; i++) {
      if (kind === 'spanA' && tenkan[i] != null && kijun[i] != null) {
        out[i] = (tenkan[i] + kijun[i]) / 2;
      } else if (kind === 'spanB' && kijun[i] != null) {
        out[i] = (hh2(i) + ll2(i)) / 2;
      }
    }
    return out;
  }
  setMA(k, v) { this.mas[k] = v; this.render(); }
  setTool(t) { this.tool = t; this.pending = null; this.host.style.cursor = t === 'cursor' ? 'default' : 'crosshair'; }
  clearDrawings() { this.drawings = []; this.render(); }
  undoDrawing() { this.drawings.pop(); this.render(); }

  _calc() {
    if (!this.bars.length) return;
    this.e9 = ema(this.bars, 9);
    this.e20 = ema(this.bars, 20);
    this.e60 = ema(this.bars, 60);
    this.vw = vwap(this.bars);
    /* 09:30 ET（RTH 开盘）索引，作为默认视图左锚点 */
    this.rthStart = this.bars.findIndex(b => barTime(b) === '09:30');
    if (this.rthStart < 0) this.rthStart = 0;
    this._indCache = {};
  }

  /* 将 #RRGGBB 转为 rgba(alpha) */
  _color(col, alpha) {
    const r = parseInt(col.slice(1, 3), 16);
    const g = parseInt(col.slice(3, 5), 16);
    const b = parseInt(col.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ---------------- 尺寸 ---------------- */
  _resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(120, r.width);
    this.h = Math.max(120, r.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  /* 可见范围：默认全部已揭示；可调用 setView() 切换 */
  get view() { return this._view; }
  _initView() {
    /* 初始视图以 9:30 居中（源站默认布局），展示约 1 小时盘前 + 1 小时盘中 */
    const A = this.rthStart || 0;
    const SPAN = this._viewSpan;
    const half = Math.floor(SPAN / 2);
    const from = Math.max(0, A - half);
    const to = Math.min(this.bars.length || 0, from + SPAN);
    this._view = { from, to };
  }
  setView(from, to) {
    this._view = { from, to };
    this.render();
  }
  get plotW() { return this.w - PAD_R - 8; }
  get mainH() { return Math.max(60, (this.h - PAD_B - GAP) * (1 - this.volRatio)); }
  get priceH() { return Math.round(this.mainH); }
  get volTop() { return this.priceH + GAP; }
  get volH() { return this.h - PAD_B - this.volTop; }

  xAt(i) {
    const { from, to } = this.view;
    const n = Math.max(1, to - from);
    return 8 + (i - from + 0.5) * (this.plotW / n);
  }
  idxAt(x) {
    const { from, to } = this.view;
    const n = Math.max(1, to - from);
    const i = Math.floor((x - 8) / (this.plotW / n)) + from;
    return clamp(i, 0, this.bars.length - 1);
  }

  /* ---------------- 价格坐标 ---------------- */
  _range() {
    const { from, to } = this.view;
    /* 仅依据已揭示区间计算价格/成交量刻度，未播放（未来）区域不计入，
       使已揭示 K 线占据合理纵向空间，逐帧播放时随揭示范围自然缩放。 */
    const vt = Math.min(to, this.reveal);
    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (let i = from; i < vt; i++) {
      const b = this.bars[i]; if (!b) continue;
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      if (b.v > vmax) vmax = b.v;
    }
    if (this.mas.ema60) for (let i = from; i < vt; i++) if (this.e60?.[i] != null) { hi = Math.max(hi, this.e60[i]); lo = Math.min(lo, this.e60[i]); }
    if (this.mas.vwap) for (let i = from; i < vt; i++) if (this.vw?.[i] != null) { hi = Math.max(hi, this.vw[i]); lo = Math.min(lo, this.vw[i]); }
    if (!isFinite(hi)) { hi = 100; lo = 99; }
    const pad = (hi - lo) * 0.08 || 0.5;
    return { hi: hi + pad, lo: lo - pad, vmax: vmax || 1 };
  }
  yAt(p, r = this._range()) { return this.priceH - (p - r.lo) / (r.hi - r.lo) * this.priceH; }
  pAt(y, r = this._range()) { return r.lo + (this.priceH - y) / this.priceH * (r.hi - r.lo); }

  /* ---------------- 渲染 ---------------- */
  render() {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#0b0e13';
    c.fillRect(0, 0, this.w, this.h);
    if (!this.bars.length || !this.reveal) { this._empty(); return; }

    const r = this._range();
    this._grid(r);
    this._overlaysBg(r);   // 分段背景 + 水平线（画在蜡烛下）
    this._volume(r);
    this._candles(r);
    if (this.cloudA && this.cloudB) this._ichimokuCloud(this.cloudA, this.cloudB, r);
    this._lines(r);
    this._prevLevels(r);
    this._drawings(r);
    this._markers(r);
    this._overlaysFg(r);   // 文字标签 + 买卖点 + 竖线（画在蜡烛上）
    this._lastPrice(r);
    this._axes(r);
    this._splitter();
    this._pendingPrice(r);
    this._crosshair(r);
  }

  _empty() {
    const c = this.ctx;
    c.fillStyle = '#7c869a';
    c.font = '13px sans-serif';
    c.textAlign = 'center';
    c.fillText('加载中…', this.w / 2, this.h / 2);
  }

  _grid(r) {
    const c = this.ctx;
    c.strokeStyle = '#161b26'; c.lineWidth = 1;
    c.fillStyle = '#7c869a'; c.font = '11px ui-monospace,monospace'; c.textAlign = 'left';

    /* 价格：取更细步长，让右侧标识更密集（源站约每 $0.20-$0.50 一条） */
    const span = r.hi - r.lo;
    const raw = span / 18;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;

    c.beginPath();
    for (let p = Math.ceil(r.lo / step) * step; p <= r.hi; p += step) {
      const y = Math.round(this.yAt(p, r)) + .5;
      if (y < 0 || y > this.priceH) continue;
      c.moveTo(8, y); c.lineTo(this.w - PAD_R, y);
    }
    c.stroke();

    /* 价格标签 */
    for (let p = Math.ceil(r.lo / step) * step; p <= r.hi; p += step) {
      const y = this.yAt(p, r);
      if (y < 8 || y > this.priceH - 2) continue;
      c.fillText(p.toFixed(2), this.w - PAD_R + 7, y + 3.5);
    }

    /* 时间刻度：根据窗口跨度自动选择 10/5/1 分钟标签密度；
       仅标注已揭示区域，未播放的未来区间默认留空（竖线/标签均不画）。 */
    const { from, to } = this.view;
    const vt = Math.min(to, this.reveal);
    const bars = vt - from;
    let stepMin;
    if (bars > 90) stepMin = 10;
    else if (bars > 45) stepMin = 5;
    else stepMin = 1;
    c.textAlign = 'center';
    for (let i = from; i < vt; i++) {
      const t = barTime(this.bars[i]);
      const mm = parseInt(t.split(':')[1], 10);
      const show = (mm % stepMin === 0);
      if (!show && i !== from) continue;
      const x = Math.round(this.xAt(i)) + .5;
      c.strokeStyle = '#161b26';
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h - PAD_B); c.stroke();
      c.fillStyle = '#7c869a';
      c.fillText(t, x, this.h - PAD_B + 14);
    }
  }

  _candles(r) {
    const c = this.ctx;
    const { from, to } = this.view;
    const n = Math.max(1, to - from);
    const slot = this.plotW / n;
    const bw = Math.max(1.2, Math.min(10, slot * 0.82));

    for (let i = from; i < to; i++) {
      if (i >= this.reveal) break;            // 未播放（未来）K 线默认不绘制；点击播放后逐帧显示
      const b = this.bars[i]; if (!b) continue;
      const up = b.c >= b.o;
      const isPre = i < this.rthStart;
      const alpha = isPre ? 0.32 : 1.0;       // 盘前 K 线更浅（与源站一致）
      const col = up ? this._color(this.upColor, alpha) : this._color(this.downColor, alpha);
      const x = this.xAt(i);
      const yo = this.yAt(b.o, r), yc = this.yAt(b.c, r);
      const yh = this.yAt(b.h, r), yl = this.yAt(b.l, r);

      // 影线：更细，与实体同色
      c.strokeStyle = col; c.lineWidth = 0.8;
      c.beginPath();
      c.moveTo(Math.round(x) + .5, yh);
      c.lineTo(Math.round(x) + .5, yl);
      c.stroke();

      // 实体：更宽，与源站一致
      const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
      c.fillStyle = col;
      if (bw <= 2) {
        c.fillRect(Math.round(x) - .5, top, 1, hgt);
      } else {
        const w = Math.max(2, bw);
        c.fillRect(x - w / 2, top, w, hgt);
      }
    }
  }

  _volume(r) {
    const c = this.ctx;
    const { from, to } = this.view;
    const n = Math.max(1, to - from);
    const slot = this.plotW / n;
    const bw = Math.max(1.2, Math.min(10, slot * 0.82));
    const top = this.volTop, H = this.volH;

    c.strokeStyle = '#161b26';
    c.beginPath(); c.moveTo(8, top + H + .5); c.lineTo(this.w - PAD_R, top + H + .5); c.stroke();

    for (let i = from; i < to; i++) {
      if (i >= this.reveal) break;            // 未播放（未来）成交量默认不绘制
      const b = this.bars[i]; if (!b) continue;
      const isPre = i < this.rthStart;
      const alpha = isPre ? 0.22 : 0.75;       // 盘前成交量更浅，盘中更醒目
      let col;
      if (this.segColorMode && this.segments) {
        const seg = this._segAt(i);
        if (seg === 'bull')      col = this._color('#26a69a', alpha);
        else if (seg === 'bear') col = this._color('#ef5350', alpha);
        else                     col = `rgba(150,150,160,${alpha})`;
      } else {
        const up = b.c >= b.o;
        col = up ? this._color(this.upColor, alpha) : this._color(this.downColor, alpha);
      }
      c.fillStyle = col;
      const hh = Math.max(1, b.v / r.vmax * H);
      c.fillRect(this.xAt(i) - bw / 2, top + H - hh, bw, hh);
    }

    /* 成交量右侧刻度（0 / 1/2 vmax / vmax） */
    c.fillStyle = '#7c869a'; c.font = '10px ui-monospace,monospace'; c.textAlign = 'left';
    const volFmt = (v) => {
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
      return v.toFixed(0);
    };
    const volLabels = [0, r.vmax * 0.25, r.vmax * 0.5, r.vmax * 0.75, r.vmax];
    for (const v of volLabels) {
      const y = top + H - (v / r.vmax) * H;
      c.fillText(volFmt(v), this.w - PAD_R + 7, y + 3.5);
    }
  }

  setSegments(segs, mode) {
    /* segs: [{start, end, dir:bull|bear|flat}]; mode: 'color' | null */
    this.segments = segs || [];
    this.segColorMode = !!mode;
    this.render();
  }

  _segAt(i) {
    if (!this.segments) return null;
    for (const s of this.segments) {
      if (i >= s.startIndex && i < (s.endIndex == null ? Infinity : s.endIndex + 1)) return s.dir;
    }
    return null;
  }

  _line(data, r, color, width = 1.2) {
    if (!data) return;
    const c = this.ctx, { from, to } = this.view;
    const vt = Math.min(to, this.reveal); // 均线/VPWAP 不画进未揭示（未来）区域
    c.strokeStyle = color; c.lineWidth = width;
    c.beginPath();
    let started = false;
    for (let i = from; i < vt; i++) {
      const v = data[i];
      if (v == null) { started = false; continue; }
      const x = this.xAt(i), y = this.yAt(v, r);
      if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
    }
    c.stroke();
  }

  _lines(r) {
    if (this.mas.ema9) this._line(this.e9, r, '#f0b429', 1.1);
    if (this.mas.ema20) this._line(this.e20, r, '#c084fc', 1.25);  // 紫
    if (this.mas.ema60) this._line(this.e60, r, '#4a9eff', 1.1);   // 蓝
    if (this.mas.vwap) this._line(this.vw, r, '#22d3ee', 1.4);   // 青
  }

  _drawings(r) {
    const c = this.ctx;
    const all = this.pending ? [...this.drawings, this.pending] : this.drawings;
    c.lineWidth = 1.4;
    for (const d of all) {
      c.strokeStyle = d.color || '#f0b429';
      c.setLineDash(d.type === 'hline' ? [5, 4] : []);
      if (d.type === 'hline') {
        const y = Math.round(this.yAt(d.price, r)) + .5;
        c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
        c.setLineDash([]);
        c.fillStyle = d.color || '#f0b429';
        c.fillRect(this.w - PAD_R + 2, y - 8, PAD_R - 6, 16);
        c.fillStyle = '#0b0e13'; c.font = '10px ui-monospace,monospace'; c.textAlign = 'left';
        c.fillText(d.price.toFixed(2), this.w - PAD_R + 6, y + 3.5);
      } else if (d.type === 'trend') {
        const x1 = this.xAt(d.i1), y1 = this.yAt(d.p1, r);
        const x2 = this.xAt(d.i2), y2 = this.yAt(d.p2, r);
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      }
      c.setLineDash([]);
    }
  }

  _markers(r) {
    const c = this.ctx;
    for (const m of this.markers) {
      if (m.i >= this.reveal) continue;
      const x = this.xAt(m.i), y = this.yAt(m.price, r);
      if (x < 0 || x > this.w - PAD_R) continue;

      if (m.type === 'entry') {
        c.fillStyle = '#4a9eff';
        this._tri(x, y, 1, m.label);
      } else if (m.type === 'exit') {
        c.fillStyle = '#a78bfa';
        this._tri(x, y, -1, m.label);
      } else {
        c.fillStyle = m.type === 'buy' ? this.upColor : this.downColor;
        this._tri(x, y, m.type === 'buy' ? 1 : -1, m.label);
      }
      if (m.label) {
        c.fillStyle = '#cbd5e1'; c.font = '10px ui-monospace,monospace'; c.textAlign = 'center';
        c.fillText(m.label, x, y + (m.type === 'buy' || m.type === 'entry' ? 18 : -10));
      }
    }
  }

  _tri(x, y, dir, ) {
    const c = this.ctx, s = 5.5;
    c.beginPath();
    if (dir > 0) { c.moveTo(x, y + s); c.lineTo(x - s, y + s + 5); c.lineTo(x + s, y + s + 5); }
    else { c.moveTo(x, y - s); c.lineTo(x - s, y - s - 5); c.lineTo(x + s, y - s - 5); }
    c.closePath(); c.fill();
  }

  /* 平仓/止损：圆环 + 横杠 */
  _circleMinus(x, y, color) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = 1.6; c.fillStyle = 'transparent';
    c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(x - 3.5, y); c.lineTo(x + 3.5, y); c.stroke();
  }

  /* 止盈：绿菱形（空心） */
  _diamond(x, y, color) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = 1.5; c.fillStyle = 'transparent';
    c.beginPath();
    c.moveTo(x, y - 5.5); c.lineTo(x + 5.5, y);
    c.lineTo(x, y + 5.5); c.lineTo(x - 5.5, y);
    c.closePath(); c.stroke();
  }

  /* X 圆（未触发/不建议） */
  _xcross(x, y, color) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = 1.4; c.fillStyle = 'transparent';
    c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
    c.beginPath();
    c.moveTo(x - 3.5, y - 3.5); c.lineTo(x + 3.5, y + 3.5);
    c.moveTo(x + 3.5, y - 3.5); c.lineTo(x - 3.5, y + 3.5);
    c.stroke();
  }

  /* 缠论笔：灰三角下指 */
  _triDownGray(x, y) {
    const c = this.ctx;
    c.fillStyle = '#9aa1ad';
    c.beginPath();
    c.moveTo(x, y + 5.5); c.lineTo(x - 5, y - 5.5); c.lineTo(x + 5, y - 5.5);
    c.closePath(); c.fill();
  }

  /* 圆点（信号点） */
  _dot(x, y, color) {
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
  }

  /* 一目均衡表云图：填充两条线之间的区域（绿/红染色） */
  _ichimokuCloud(spanA, spanB, r) {
    const c = this.ctx;
    if (!spanA || !spanB) return;
    const { from, to } = this.view;
    c.lineWidth = 0.6;
    let started = false;
    c.beginPath();
    for (let i = from; i < to; i++) {
      const a = spanA[i], b = spanB[i];
      if (a == null || b == null) { started = false; continue; }
      const x = this.xAt(i), ya = this.yAt(a, r), yb = this.yAt(b, r);
      if (!started) { c.moveTo(x, ya); started = true; } else c.lineTo(x, ya);
    }
    for (let i = to - 1; i >= from; i--) {
      const b = spanB[i];
      if (b == null) continue;
      c.lineTo(this.xAt(i), this.yAt(b, r));
    }
    c.closePath();
    c.fillStyle = 'rgba(38,166,154,0.10)';
    c.fill();
    c.strokeStyle = 'rgba(38,166,154,0.35)';
    c.stroke();
  }

  /* 缠论日线（中线）— 简单以 EMA60 近似 */
  _chanLine(r) {
    if (!this.e60) return;
    this._line(this.e60, r, '#a78bfa', 1);
  }

  /* ---------------- 市场报告叠加层（背景层：分段背景 + 水平线） ---------------- */
  _overlaysBg(r) {
    const c = this.ctx;
    const COL = {
      bull: 'rgba(239,83,80,0.14)', bear: 'rgba(38,166,154,0.14)', flat: 'rgba(120,130,160,0.10)',
      bullLine: '#ef5350', bearLine: '#26a69a', flatLine: '#94a3b8'
    };
    if (!this.overlays || !this.overlays.length) return;
    for (const o of this.overlays) {
      if (o.kind === 'seg') {
        const x1 = this.xAt(o.startIndex);
        const revX = this.xAt(this.reveal);                 // 不画进未揭示（未来）区域
        let x2 = o.endIndex == null ? this.w - PAD_R : this.xAt(o.endIndex);
        x2 = Math.min(x2, revX);
        if (x1 > this.w - PAD_R || x2 < 8) continue;
        const bx1 = Math.max(8, x1), bx2 = Math.min(this.w - PAD_R, x2);
        c.fillStyle = COL[o.dir] || COL.flat;
        c.fillRect(bx1, 0, bx2 - bx1, this.h - PAD_B);
        /* 段起 / 段终 边线 */
        c.fillStyle = o.dir === 'bull' ? COL.bullLine : o.dir === 'bear' ? COL.bearLine : COL.flatLine;
        c.fillRect(bx1 - 1, 0, 2, this.h - PAD_B);
        if (o.endIndex != null) c.fillRect(bx2 - 1, 0, 2, this.h - PAD_B);
      } else if (o.kind === 'hline') {
        const y = Math.round(this.yAt(o.price, r)) + .5;
        c.strokeStyle = o.color || 'rgba(160,175,200,.4)';
        c.lineWidth = 1; c.setLineDash(o.dash || [3, 3]);
        c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y);
        c.stroke(); c.setLineDash([]);
      }
    }
  }

  /* ---------------- 市场报告叠加层（前景层：文字标签 + 买卖点 + 竖线 + 段顶标签） ---------------- */
  _overlaysFg(r) {
    const c = this.ctx;
    const COL = {
      bullLine: '#ef5350', bearLine: '#26a69a', flatLine: '#94a3b8'
    };
    if (!this.overlays || !this.overlays.length) return;
    for (const o of this.overlays) {
      if (o.kind === 'seg') {
        /* 段顶方向标签（前景，始终可见） */
        const x1 = this.xAt(o.startIndex);
        const x2 = o.endIndex == null ? this.w - PAD_R : this.xAt(o.endIndex);
        if (x1 > this.w - PAD_R || x2 < 8) continue;
        const cx = (Math.max(8, x1) + Math.min(this.w - PAD_R, x2)) / 2;
        c.fillStyle = o.dir === 'bull' ? COL.bullLine : o.dir === 'bear' ? COL.bearLine : COL.flatLine;
        c.font = 'bold 11px ui-monospace,monospace'; c.textAlign = 'center';
        const lab = o.label || (o.dir === 'bull' ? '多头' : o.dir === 'bear' ? '空头' : '盘整');
        c.fillStyle = 'rgba(11,14,19,.9)';
        const w = c.measureText(lab).width + 12;
        c.fillRect(cx - w / 2, 4, w, 16);
        c.fillStyle = o.dir === 'bull' ? COL.bullLine : o.dir === 'bear' ? COL.bearLine : COL.flatLine;
        c.fillText(lab, cx, 16);
      } else if (o.kind === 'label') {
        /* 文字标签：{i, price, text, color} */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        c.fillStyle = o.color || '#cbd5e1';
        c.font = '10px ui-monospace,monospace'; c.textAlign = 'center';
        c.fillText(o.text, x, y + (o.dy || 0));
      } else if (o.kind === 'buy' || o.kind === 'sell' || o.kind === 'flat' ||
                 o.kind === 'entry' || o.kind === 'stop' || o.kind === 'mark') {
        /* 买卖点：{i, price, label, kind} */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        const isUp = (o.kind === 'buy' || o.kind === 'entry');
        const isDot = (o.kind === 'flat' || o.kind === 'mark');
        const col = (o.kind === 'buy' || o.kind === 'entry') ? this.upColor
                  : (o.kind === 'sell' || o.kind === 'stop') ? this.downColor : '#94a3b8';
        c.fillStyle = col;
        if (isDot) {
          c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
        } else {
          c.beginPath();
          if (isUp) { c.moveTo(x, y - 6); c.lineTo(x - 5, y - 11); c.lineTo(x + 5, y - 11); }
          else { c.moveTo(x, y + 6); c.lineTo(x - 5, y + 11); c.lineTo(x + 5, y + 11); }
          c.closePath(); c.fill();
        }
        if (o.label) {
          c.fillStyle = col; c.font = '10px ui-monospace,monospace'; c.textAlign = 'center';
          c.fillText(o.label, x, isUp ? y - 14 : y + 22);
        }
      } else if (o.kind === 'vline') {
        /* 竖线：{i, color} */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i);
        c.strokeStyle = o.color || 'rgba(160,175,200,.4)';
        c.lineWidth = 1; c.setLineDash(o.dash || [3, 3]);
        c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, this.h - PAD_B);
        c.stroke(); c.setLineDash([]);
      } else if (o.kind === 'close' || o.kind === 'stop') {
        /* 平仓 ⊖ (金) / 止损 ⊖ (红) */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        const col = o.kind === 'close' ? '#c9a84c' : '#ef5350';
        this._circleMinus(x, y, col);
        if (o.label) {
          c.fillStyle = col; c.font = '10px ui-monospace,monospace'; c.textAlign = 'center';
          c.fillText(o.label, x, o.kind === 'close' ? y - 12 : y + 22);
        }
      } else if (o.kind === 'tp') {
        /* 止盈 ◇ 绿 */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        this._diamond(x, y, '#66bb6a');
        if (o.label) {
          c.fillStyle = '#66bb6a'; c.font = '10px ui-monospace,monospace'; c.textAlign = 'center';
          c.fillText(o.label, x, y - 12);
        }
      } else if (o.kind === 'signal') {
        /* 信号点 圆点 */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        this._dot(x, y, this.upColor);
      } else if (o.kind === 'untriggered') {
        /* 未触发/不建议 X 圆 */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        this._xcross(x, y, '#9e9e9e');
      } else if (o.kind === 'chanPen') {
        /* 缠论笔 ▼ 灰 */
        if (o.i >= this.reveal) continue;
        const x = this.xAt(o.i), y = this.yAt(o.price, r);
        if (x < 0 || x > this.w - PAD_R) continue;
        this._triDownGray(x, y);
      } else if (o.kind === 'topBot') {
        /* 段顶/段底水平线：{price, color, type:'top'|'bot'|'range'} */
        const y = Math.round(this.yAt(o.price, r)) + .5;
        if (y < 0 || y > this.priceH) continue;
        c.strokeStyle = o.color || 'rgba(150,150,160,.5)';
        c.lineWidth = 1; c.setLineDash(o.dash || [4, 3]);
        c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
        c.setLineDash([]);
      } else if (o.kind === 'prevHigh' || o.kind === 'prevLow' || o.kind === 'prevClose') {
        const y = Math.round(this.yAt(o.price, r)) + .5;
        if (y < 0 || y > this.priceH) continue;
        c.strokeStyle = o.color || 'rgba(160,175,200,.4)';
        c.lineWidth = 1; c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
        c.setLineDash([]);
        if (o.showLabel !== false) {
          c.fillStyle = o.color || 'rgba(160,175,200,.6)';
          c.font = '10px ui-monospace,monospace'; c.textAlign = 'left';
          const txt = o.kind === 'prevHigh' ? '前高' : o.kind === 'prevLow' ? '前低' : '前收';
          c.fillText(txt + ' ' + o.price.toFixed(2), 12, y - 4);
        }
      }
    }
  }

  _lastPrice(r) {
    if (!this.reveal) return;
    const b = this.bars[this.reveal - 1]; if (!b) return;
    const c = this.ctx, y = Math.round(this.yAt(b.c, r)) + .5;
    const col = b.c >= b.o ? this.upColor : this.downColor;

    // 当前价位水平线 + 右侧标签
    c.strokeStyle = col; c.lineWidth = 1;
    c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
    c.fillStyle = col;
    c.fillRect(this.w - PAD_R + 2, y - 8, PAD_R - 6, 16);
    c.fillStyle = '#0b0e13'; c.font = 'bold 11px ui-monospace,monospace'; c.textAlign = 'left';
    c.fillText(b.c.toFixed(2), this.w - PAD_R + 6, y + 4);

    // 当前 bar 垂直虚线（playback cursor），与源站一致
    const x = Math.round(this.xAt(this.reveal - 1)) + .5;
    c.strokeStyle = 'rgba(220,230,255,.45)'; c.lineWidth = 1; c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h - PAD_B); c.stroke(); c.setLineDash([]);
  }

  _pendingPrice(r) {
    if (!this.pendingOrder) return;
    const c = this.ctx, y = Math.round(this.yAt(this.pendingOrder.price, r)) + .5;
    const col = this.pendingOrder.side === 'buy' ? this.upColor : this.downColor;
    c.strokeStyle = col; c.lineWidth = 1; c.setLineDash([6, 4]);
    c.beginPath(); c.moveTo(8, y); c.lineTo(this.w - PAD_R, y); c.stroke();
    c.setLineDash([]);
    c.fillStyle = col;
    c.fillRect(this.w - PAD_R + 2, y - 8, PAD_R - 6, 16);
    c.fillStyle = '#0b0e13'; c.font = 'bold 11px ui-monospace,monospace'; c.textAlign = 'left';
    c.fillText(this.pendingOrder.price.toFixed(2), this.w - PAD_R + 6, y + 4);
  }

  _axes(r) {
    const c = this.ctx;
    c.strokeStyle = '#232936'; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(this.w - PAD_R + .5, 0); c.lineTo(this.w - PAD_R + .5, this.h - PAD_B);
    c.moveTo(0, this.h - PAD_B + .5); c.lineTo(this.w, this.h - PAD_B + .5);
    c.stroke();

    /* 图例：头部信息栏已展示，不再在画布内重复绘制 */
    // const on = [];
    // if (this.mas.ema9) on.push(['EMA9', '#f0b429']);
    // if (this.mas.ema20) on.push(['EMA20', '#c084fc']);
    // if (this.mas.ema60) on.push(['EMA60', '#4a9eff']);
    // if (this.mas.vwap) on.push(['VWAP', '#22d3ee']);
    // c.font = '11px ui-monospace,monospace'; c.textAlign = 'left';
    // let x = 12;
    // for (const [n, col] of on) {
    //   c.fillStyle = col; c.fillText(n, x, 15);
    //   x += c.measureText(n).width + 11;
    // }
  }

  /* 主图/成交量之间的可拖动分割线 */
  _splitter() {
    const c = this.ctx;
    const y = this.priceH;
    const hover = this.mouse && this._isOverSplitter(this.mouse.x, this.mouse.y);
    const active = !!this._splitDrag;

    /* 可拖拽区域背景条（hover 时高亮） */
    if (hover || active) {
      c.fillStyle = 'rgba(240,180,41,.10)';
      c.fillRect(8, y - 5, this.w - PAD_R - 8, 10);
    }

    c.strokeStyle = active || hover ? '#f0b429' : '#4a5568';
    c.lineWidth = active || hover ? 2.5 : 1.5;
    c.beginPath();
    c.moveTo(8, y + .5); c.lineTo(this.w - PAD_R, y + .5);
    c.stroke();

    /* 抓握手柄 */
    const cx = (8 + this.w - PAD_R) / 2;
    c.fillStyle = active || hover ? '#f0b429' : '#4a5568';
    c.beginPath();
    c.arc(cx - 18, y + .5, 2.2, 0, Math.PI * 2);
    c.arc(cx, y + .5, 2.2, 0, Math.PI * 2);
    c.arc(cx + 18, y + .5, 2.2, 0, Math.PI * 2);
    c.fill();
  }
  _isOverSplitter(x, y) {
    return x >= 8 && x <= this.w - PAD_R && Math.abs(y - this.priceH) <= 6;
  }

  _crosshair(r) {
    if (!this.mouse || this.tool !== 'cursor') return;
    const c = this.ctx, { x, y } = this.mouse;
    if (x < 8 || x > this.w - PAD_R || y > this.h - PAD_B) return;

    const i = this.idxAt(x);
    if (i >= this.reveal) return;
    const b = this.bars[i]; if (!b) return;

    c.strokeStyle = 'rgba(160,175,200,.35)'; c.lineWidth = 1; c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(Math.round(x) + .5, 0); c.lineTo(Math.round(x) + .5, this.h - PAD_B);
    c.moveTo(8, Math.round(y) + .5); c.lineTo(this.w - PAD_R, Math.round(y) + .5);
    c.stroke(); c.setLineDash([]);

    /* 价格标签 */
    c.fillStyle = '#2a3142';
    c.fillRect(this.w - PAD_R + 2, y - 8, PAD_R - 6, 16);
    c.fillStyle = '#dfe5ef'; c.font = '11px ui-monospace,monospace'; c.textAlign = 'left';
    c.fillText(this.pAt(y, r).toFixed(2), this.w - PAD_R + 6, y + 4);

    /* 时间标签 */
    const tw = 46;
    c.fillStyle = '#2a3142';
    c.fillRect(x - tw / 2, this.h - PAD_B + 2, tw, 16);
    c.fillStyle = '#dfe5ef'; c.textAlign = 'center';
    c.fillText(barTime(this.bars[i]), x, this.h - PAD_B + 13.5);

    /* OHLC 浮层 */
    const rows = [
      ['时间', barTime(this.bars[i])],
      ['开', b.o.toFixed(2)], ['高', b.h.toFixed(2)],
      ['低', b.l.toFixed(2)], ['收', b.c.toFixed(2)],
      ['量', (b.v / 1000).toFixed(0) + 'K']
    ];
    c.font = '11px ui-monospace,monospace';
    let wMax = 0;
    for (const [k, v] of rows) wMax = Math.max(wMax, c.measureText(k + '  ' + v).width);
    const bw = wMax + 18, bh = rows.length * 15 + 10;
    let bx = x + 14, by = 10;
    if (bx + bw > this.w - PAD_R) bx = x - bw - 14;
    c.fillStyle = 'rgba(18,22,31,.95)';
    c.strokeStyle = '#2e3547'; c.lineWidth = 1;
    c.beginPath(); c.roundRect(bx, by, bw, bh, 5); c.fill(); c.stroke();
    rows.forEach(([k, v], n) => {
      c.textAlign = 'left'; c.fillStyle = '#7c869a';
      c.fillText(k, bx + 9, by + 19 + n * 15);
      c.textAlign = 'right';
      c.fillStyle = n === 5 ? '#dfe5ef' : (parseFloat(v) >= this.bars[i].o ? this.upColor : this.downColor);
      if (k === '时间' || k === '量') c.fillStyle = '#dfe5ef';
      c.fillText(v, bx + bw - 9, by + 19 + n * 15);
    });
  }

  /* ---------------- 交互 ---------------- */
  _panTo(px) {
    if (!this._drag) return;
    const { from, to } = this._view;
    const n = Math.max(1, to - from);
    const slot = this.plotW / n;
    const dIdx = Math.round((px - this._drag.x0) / slot);
    const span = this._drag.span;
    const maxFrom = Math.max(0, this.bars.length - span); // 可在全天范围内自由平移（右侧留白区为未播放部分）
    const nf = clamp(this._drag.from0 - dIdx, 0, maxFrom);
    this._view = { from: nf, to: nf + span };
    this.render();
  }
  _endDrag() {
    if (!this._drag) return;
    this._drag = null;
    this.canvas.style.cursor = this.tool === 'cursor' ? 'default' : 'crosshair';
    // 正在播放则松手后恢复"跟随最新"；暂停则停在用户拖到的位置
    if (this._playing) this.followLatest();
  }
  /* 滚轮缩放：以光标处 bar 为锚点改变可见根数 _viewSpan。
     缩放幅度按滚轮 deltaY 平滑计算（单步最大约 12%，避免变化过快）；
     播放时缩放后继续跟随最新边，暂停时停在缩放位置。 */
  zoomAt(mx, deltaY) {
    const { from, to } = this._view;
    const oldSpan = Math.max(1, to - from);
    const MIN = 20, MAX = this.bars.length;
    const intensity = Math.min(Math.abs(deltaY), 120) / 120;       // 0..1，平滑
    const factor = deltaY < 0 ? (1 - 0.10 * intensity) : (1 + 0.10 * intensity);
    let newSpan = Math.round(oldSpan * factor);
    newSpan = clamp(newSpan, MIN, MAX);
    const a = this.idxAt(mx);
    let nf = a - (a - from) * (newSpan / oldSpan);
    let nt = nf + newSpan;
    if (nt > this.bars.length) { nt = this.bars.length; nf = nt - newSpan; }
    if (nf < 0) { nf = 0; nt = Math.min(newSpan, this.bars.length); }
    this._viewSpan = newSpan;
    this._view = { from: Math.round(nf), to: Math.round(nt) };
    if (this._playing) { this._follow = true; this._applyFollow(); }
    else { this._follow = false; }
    this.render();
  }
  _bind() {
    const cv = this.canvas;

    cv.addEventListener('mousemove', e => {
      const r = cv.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };

      if (this._splitDrag) {
        const total = this.h - PAD_B - GAP;
        if (total > 0) {
          this.volRatio = clamp((total - this.mouse.y) / total, MIN_VOL_RATIO, MAX_VOL_RATIO);
        }
        this.render();
        return;
      }

      if (this._drag) { this._panTo(this.mouse.x); return; }

      if (this.pending) {
        if (this.pending.type === 'trend') {
          this.pending.i2 = this.idxAt(this.mouse.x);
          this.pending.p2 = this.pAt(this.mouse.y, this._range());
        }
      }

      /* 分割线悬停光标 */
      if (!this._drag && !this._splitDrag && this.tool === 'cursor') {
        if (this._isOverSplitter(this.mouse.x, this.mouse.y)) {
          cv.style.cursor = 'row-resize';
        } else {
          cv.style.cursor = 'default';
        }
      }
      this.render();
    });

    cv.addEventListener('mouseleave', () => {
      if (this._splitDrag) { this._splitDrag = null; this.canvas.style.cursor = 'default'; this.render(); return; }
      if (this._drag) { this._endDrag(); return; }
      this.mouse = null; this.render();
    });

    cv.addEventListener('mousedown', e => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;

      /* 拖动 K 线/成交量高度分割线 */
      if (this._isOverSplitter(x, y)) {
        this._splitDrag = { y0: y, ratio0: this.volRatio };
        this._follow = false;
        cv.style.cursor = 'row-resize';
        e.preventDefault();
        return;
      }

      if (x < 8 || x > this.w - PAD_R) return;

      /* 默认 cursor 工具：拖动平移 K 线（与源站一致） */
      if (this.tool === 'cursor') {
        const span = this._view.to - this._view.from;
        this._drag = { x0: x, from0: this._view.from, span, touch: false };
        this._follow = false;
        cv.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }

      const rg = this._range();

      if (this.tool === 'hline') {
        this.drawings.push({ type: 'hline', price: this.pAt(y, rg), color: '#f0b429' });
        this.render();
      } else if (this.tool === 'trend') {
        this.pending = { type: 'trend', i1: this.idxAt(x), p1: this.pAt(y, rg), i2: this.idxAt(x), p2: this.pAt(y, rg), color: '#f0b429' };
      } else if (this.tool === 'erase') {
        this.drawings.pop(); this.render();
      } else if (this.tool === 'price' && this.onPricePick) {
        this.pendingOrder = { price: this.pAt(y, rg), side: this.onPricePick.side };
        this.onPricePick.cb(this.pAt(y, rg));
        this.render();
      }
    });

    cv.addEventListener('mouseup', () => {
      if (this._splitDrag) { this._splitDrag = null; this.canvas.style.cursor = 'default'; this.render(); return; }
      if (this._drag) { this._endDrag(); return; }
      if (this.pending) { this.drawings.push(this.pending); this.pending = null; this.render(); }
    });

    /* 触摸拖动平移（移动端） */
    cv.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      const r = cv.getBoundingClientRect();
      const x = e.touches[0].clientX - r.left, y = e.touches[0].clientY - r.top;
      if (x < 8 || x > this.w - PAD_R) return;
      const span = this._view.to - this._view.from;
      this._drag = { x0: x, from0: this._view.from, span, touch: true };
      this._follow = false;
      this.mouse = { x, y };
      e.preventDefault();
    }, { passive: false });
    cv.addEventListener('touchmove', e => {
      if (!this._drag) return;
      const r = cv.getBoundingClientRect();
      const x = e.touches[0].clientX - r.left;
      this.mouse = { x, y: e.touches[0].clientY - r.top };
      this._panTo(x);
      e.preventDefault();
    }, { passive: false });
    cv.addEventListener('touchend', () => {
      if (this._drag) this._endDrag();
    });

    /* 滚轮缩放 K 线（仅在 cursor 浏览工具下，避免与绘图工具冲突） */
    cv.addEventListener('wheel', e => {
      if (this.tool !== 'cursor') return;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      e.preventDefault();
      this.zoomAt(mx, e.deltaY);
    }, { passive: false });

    cv.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.pending = null; this.render();
    });
  }
}

/* roundRect polyfill (老 Safari) */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    this.beginPath();
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}
