/* ============================================================
   pages-trade.js — 回放复盘 / 实时分析 / 交易日志
   ============================================================ */
import {
  $, $$, el, esc, money, moneyS, px, rs, cls, sign, barTime, genDay, tradingDays,
  fmtDate, parseDate, weekdayCN, store, toast, clamp, ema, vwap
} from './core.js';
import { Chart } from './chart.js';
import { genTrades, daySummary, TAGS, TAG_DETAIL } from './mock.js';
import {
  loadReplayDay, loadDates, stepAvailableDate, nearestAvailableDate, getReport
} from './market-data.js';

/* ET HH:MM 格式化（用于把 pro_data 的 HH:MM 对应到 RTH 索引） */
const ET_FMT = new Intl.DateTimeFormat('en-US',
  { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
function toHHMM(t) {
  const s = ET_FMT.format(new Date(t * 1000));
  return s.replace(/:(\d)$/, ':0$1'); // 确保分钟始终两位（某些环境会返回 :0 而非 :00）
}

const TOOL_ICONS = {
  cursor: '<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>',
  hline: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg>',
  trend: '<svg viewBox="0 0 24 24"><path d="M4 20L20 4"/></svg>',
  price: '<svg viewBox="0 0 24 24"><path d="M12 3v18M7 8h10M7 16h10"/></svg>',
  erase: '<svg viewBox="0 0 24 24"><path d="M20 20H8.5L3 14.5a2 2 0 010-3l8-8a2 2 0 013 0l6 6a2 2 0 010 3L13 20"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'
};

const START_EQUITY = 0;

/* ============================================================
   模拟交易引擎
   ============================================================ */
class Sim {
  constructor() { this.reset(); }
  reset() {
    this.pos = 0; this.entry = 0; this.qty = 100;
    this.realized = 0; this.orders = []; this.fills = [];
  }
  unrealized(price) { return this.pos ? (price - this.entry) * this.pos : 0; }
  equity(price) { return START_EQUITY + this.realized + this.unrealized(price); }

  market(side, price, qty = this.qty) {
    if (!qty || qty <= 0) return;
    const signed = side === 'buy' ? qty : -qty;

    if (this.pos === 0) {
      this.pos = signed; this.entry = price;
    } else if (Math.sign(this.pos) === Math.sign(signed)) {
      this.entry = (this.entry * Math.abs(this.pos) + price * qty) / (Math.abs(this.pos) + qty);
      this.pos += signed;
    } else {
      const closeQty = Math.min(qty, Math.abs(this.pos));
      this.realized += (price - this.entry) * Math.sign(this.pos) * closeQty;
      this.pos -= Math.sign(this.pos) * closeQty;
      const remain = qty - closeQty;
      if (remain > 0) { this.pos = Math.sign(signed) * remain; this.entry = price; }
      else if (this.pos === 0) this.entry = 0;
    }
    this.fills.push({ i: this._i ?? 0, side, price, qty });
  }

  flat(price) {
    if (!this.pos) return;
    const q = Math.abs(this.pos);
    this.realized += (price - this.entry) * this.pos;
    this.fills.push({ i: this._i ?? 0, side: this.pos > 0 ? 'sell' : 'buy', price, qty: q });
    this.pos = 0; this.entry = 0;
  }

  addOrder(o) { this.orders.push({ ...o, id: 'O' + Date.now() + Math.random().toString(36).slice(2, 6) }); }

  /** 价格穿越检测，返回被触发的订单 */
  checkOrders(prev, cur) {
    if (!this.orders.length) return [];
    const hit = [];
    this.orders = this.orders.filter(o => {
      let trig = false;
      if (o.type === 'limit') {
        trig = o.side === 'buy' ? cur <= o.price : cur >= o.price;
      } else { // stop
        trig = o.side === 'buy' ? cur >= o.price : cur <= o.price;
      }
      if (trig) { hit.push(o); return false; }
      return true;
    });
    return hit;
  }
}

/* ============================================================
   通用：K 线 + 交易面板 页面骨架
   ============================================================ */
/* ============================================================
   通用：K 线 + 交易面板 页面骨架（1:1 源站「回放复盘」终端）
   ============================================================ */
function buildTV(host, opt) {
  const { date, replay, onDateChange } = opt;
  const day = opt.day || genDay(date);
  const dates = opt.dates || null;

  /* 默认播放头停在 09:30（RTH 开盘第一根），点击播放后从 9:30 开始逐帧推进。
     reveal 语义为"已揭示根数"，最后绘制的是 reveal-1，故 +1 让 9:30 成为当前蜡烛。
     窗口左锚点同样为 9:30（见 chart.js _applyFollow / _initView）。 */
  const rthStart = day.bars.findIndex(b => toHHMM(b.t) === '09:30');
  const defaultReveal = rthStart >= 0 ? rthStart + 1 : Math.min(147, day.bars.length);

  /* 指标尾值 */
  const e20arr = ema(day.bars, 20);
  const vwarr = vwap(day.bars);
  const ema20Val = e20arr[e20arr.length - 1] ?? day.close;
  const vwapVal = vwarr[vwarr.length - 1] ?? day.close;
  const prev = day.prevDay || {};
  // OHLC 将按当前 reveal 动态计算，见 updateHeaderOHLC()

  /* 交易模拟引擎 */
  const sim = new Sim();

  /* 工具条图标 */
  const TOOLS = [
    { k: 'cursor', t: '光标', svg: '<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>' },
    { k: 'cross',  t: '十字线', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M12 2v7M12 15v7M2 12h7M15 12h7"/></svg>' },
    { k: 'hline',  t: '水平线', svg: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg>' },
    { k: 'trend',  t: '趋势线', svg: '<svg viewBox="0 0 24 24"><path d="M4 20L20 4"/></svg>' },
    { k: 'rect',   t: '矩形', svg: '<svg viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="10" rx="1"/></svg>' },
    { k: 'text',   t: '文字', svg: '<svg viewBox="0 0 24 24"><path d="M8 7h8M10 7v10M14 7v10"/></svg>' },
    { k: 'erase',  t: '撤销', svg: '<svg viewBox="0 0 24 24"><path d="M20 20H8.5L3 14.5a2 2 0 010-3l8-8a2 2 0 013 0l6 6a2 2 0 010 3L13 20"/></svg>' },
    { k: 'clear',  t: '清空', svg: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>' }
  ];

  const root = el(`
    <div class="rd-desk">
      <div class="rd-main">
        <!-- 左侧工具条 -->
        <div class="rd-tools">
          ${TOOLS.map(t => `<button class="rd-tool${t.k === 'cursor' ? ' on' : ''}" data-tool="${t.k}" title="${t.t}">${t.svg}</button>`).join('')}
        </div>

        <!-- 中间：图表区 -->
        <div class="rd-center">
          <div class="rd-header">
            <div class="rd-htabs">
              <button class="on" data-mode="day">全天</button>
              <button data-mode="analysis">分析</button>
              <button data-mode="aux">辅助</button>
            </div>
            <button class="rd-close-day" data-act="closeday" style="display:none">关闭全天</button>
            <div class="rd-hinfo">
              <span class="rd-hsym">QQQ</span>
              <span class="rd-hintv">1m</span>
              <span class="rd-hohlc" data-f="ohlc">
                <span class="rd-hohlc-k">O</span><b data-f="o">--</b>
                <span class="rd-hohlc-k">H</span><b data-f="h">--</b>
                <span class="rd-hohlc-k">L</span><b data-f="l">--</b>
                <span class="rd-hohlc-k">C</span><b data-f="c">--</b>
              </span>
              <span class="rd-hchg" data-f="chg">--</span>
            </div>
            <div class="rd-hinds">
              <span class="ind ema20"><i></i>EMA20 ${px(ema20Val)}</span>
              <span class="ind vwap"><i></i>VWAP ${px(vwapVal)}</span>
              <span class="ind prev"><i></i>前日 ${px(prev.high || 0)} ${px(prev.low || 0)} ${px(prev.close || 0)}</span>
            </div>
            <div class="rd-hdate rd-datepick" data-act="datepick">
              <span class="rd-date">${date}</span>
              <span class="rd-date-arrow">▼</span>
              <div class="rd-datepop" style="display:none"></div>
            </div>
          </div>

          <div class="rd-chart-wrap"></div>

          <div class="rd-footer">
            <div class="rd-timepick">
              <span class="rd-clock" data-act="timepick">11:56</span>
              <div class="rd-timepop" style="display:none"></div>
            </div>
            <button class="rd-fbtn" data-act="prev" title="上一根">上一根</button>
            <button class="rd-fbtn rd-play" data-act="play" title="播放/暂停">▶</button>
            <button class="rd-fbtn" data-act="next" title="下一根">下一根</button>
            <div class="rd-gran">
              <button class="on" data-gran="min">分钟</button>
              <button data-gran="sec">秒</button>
            </div>
            <button class="rd-fbtn" data-act="start" title="开始">▶</button>
            <div class="rd-speed">
              <span>速度</span>
              <input type="range" min="1" max="30" step="1" value="1">
              <b data-f="spd">1x</b>
            </div>
            <div class="rd-progress" data-act="progress"><i></i></div>
            <span class="rd-idx" data-f="idx">0 / 391</span>
            <div class="rd-datenav">
              <span class="rd-prevdate">--</span>
              <span class="rd-curdate">${date}</span>
            </div>
            <button class="rd-fbtn" data-act="reset" title="重置交易">重置</button>
          </div>

          <div class="rd-filmstrip" data-rp="filmstrip" style="display:none"></div>
          <div class="rd-analysis" data-rp="analysis" style="display:none"></div>
        </div>

        <!-- 右侧交易面板 -->
        <div class="rd-right">
          <div class="rd-right-tabs">
            <button class="on" data-rtab="trade">交易</button>
            <button data-rtab="compare">对比</button>
          </div>
          <div class="rd-trade" data-rpane="trade">
            <div class="rd-stat">
              <div class="rd-stat-row"><span class="rd-stat-k">POSITION</span><span class="rd-stat-v pos ${sim.pos > 0 ? 'long' : sim.pos < 0 ? 'short' : ''}">${sim.pos > 0 ? 'Long' : sim.pos < 0 ? 'Short' : 'Flat'}</span></div>
              <div class="rd-stat-row"><span class="rd-stat-k">UNREALIZED P&L</span><span class="rd-stat-v ${cls(sim.unrealized(day.close))}">${(sim.unrealized(day.close) >= 0 ? '+' : '') + money(sim.unrealized(day.close))}</span></div>
              <div class="rd-stat-row"><span class="rd-stat-k">MARKET PRICE</span><span class="rd-stat-v num">$${px(day.close)}</span></div>
              <div class="rd-stat-row"><span class="rd-stat-k">REALIZED P&L</span><span class="rd-stat-v ${cls(sim.realized)}">${(sim.realized >= 0 ? '+' : '') + money(sim.realized)}</span></div>
              <div class="rd-stat-row"><span class="rd-stat-k">EQUITY</span><span class="rd-stat-v num ${cls(sim.equity(day.close))}">${(sim.equity(day.close) >= 0 ? '+' : '') + money(sim.equity(day.close))}</span></div>
            </div>

            <div class="rd-qty">
              <span class="rd-qty-l">Qty</span>
              <button data-act="qty-">−</button>
              <input type="number" value="${sim.qty}" step="50" min="0" data-f="qty">
              <button data-act="qty+">+</button>
            </div>

            <div class="rd-otype">
              <button class="on" data-otype="market">MARKET</button>
              <button data-otype="limit">LIMIT</button>
              <button data-otype="stop">STOP</button>
              <button data-otype="stoplimit">STOP LIMIT</button>
            </div>

            <div class="rd-actions">
              <button class="rd-buy" data-act="buy">Buy</button>
              <button class="rd-sell" data-act="sell">Sell</button>
              <button class="rd-flat" data-act="flat" ${sim.pos ? '' : 'disabled'}>Flat</button>
            </div>

            <div class="rd-quick">
              <button class="rd-qbuy" data-act="qbuy">+ Buy</button>
              <button class="rd-qsell" data-act="qsell">+ Sell</button>
            </div>

            <div class="rd-pend-hint" data-act="pickprice">
              <span>Stop/Limit Order - click to add</span>
            </div>

            <div class="rd-sec-h">PENDING ORDERS <span class="rd-count">${sim.orders.length}</span></div>
            <div class="rd-orders">
              ${sim.orders.length ? sim.orders.map(o => `
                <div class="rd-order">
                  <span class="rd-oside ${o.side}">${o.side.toUpperCase()}</span>
                  <span class="rd-otype-tag">${o.type.toUpperCase()}</span>
                  <span class="rd-oprice">${px(o.price)}</span>
                  <span class="rd-oqty">${o.qty}</span>
                  <button class="rd-odel" data-del="${o.id}">×</button>
                </div>`).join('') : '<div class="rd-empty">暂无挂单</div>'}
            </div>

            <div class="rd-sec-h">FILLS <span class="rd-count">${sim.fills.length}</span></div>
            <div class="rd-orders">
              ${sim.fills.length ? sim.fills.slice(-6).reverse().map(f => `
                <div class="rd-order">
                  <span class="rd-oside ${f.side}">${f.side.toUpperCase()}</span>
                  <span class="rd-oprice">${px(f.price)}</span>
                  <span class="rd-oqty">${barTime(day.bars[f.i])} × ${f.qty}</span>
                </div>`).join('') : '<div class="rd-empty">暂无成交</div>'}
            </div>
          </div>

          <div class="rd-compare" data-rpane="compare" style="display:none">
            <div class="center-empty" style="height:120px">对比功能<br><span class="fs11">后续接入多标的同屏对比</span></div>
          </div>
        </div>
      </div>
    </div>`);

  host.innerHTML = '';
  host.appendChild(root);

  const chartWrap = $('.rd-chart-wrap', root);
  const chart = new Chart(chartWrap);

  /* 默认只显示 EMA20 + VWAP */
  chart.mas = { ema9: false, ema20: true, ema60: false, vwap: true };

  const S = {
    reveal: replay ? Math.min(defaultReveal, day.bars.length) : day.bars.length,
    playing: false,
    speed: 1, // 默认 1x；base(min)=0.5 → 1 根/2 秒（慢回放，逐帧可跟随）；最高 30x
    orderType: 'market', // market | limit | stop | stoplimit
    orderSide: 'buy',
    timer: null,
    raf: null,
    showAnalysis: false,
    mode: replay ? 'analysis' : 'day',
    granularity: 'min', // min | sec
    allDay: !replay,
    frameNotes: [],    // 逐帧分析卡片数据
    report: null
  };

  chart.setBars(day.bars);
  if (day.prevDay) chart.setPrevDay(day.prevDay);
  chart.setReveal(S.reveal);

  /* 工具条激活 */
  function setTool(t) {
    $$('.rd-tool', root).forEach(x => x.classList.toggle('on', x.dataset.tool === t));
    if (t === 'clear') { chart.clearDrawings(); t = 'cursor'; }
    if (t === 'erase') { chart.undoDrawing(); t = 'cursor'; }
    chart.setTool(t);
    if (t === 'price') {
      chart.onPricePick = { side: S.orderSide, cb: p => renderPanel() };
    }
  }

  /* 顶部模式 tab */
  function setModeTab(m) {
    S.mode = m;
    $$('.rd-htabs button', root).forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    const closeBtn = $('.rd-close-day', root);
    const filmstrip = $('[data-rp=filmstrip]', root);
    const panel = $('[data-rp=analysis]', root);

    if (m === 'day') {
      S.allDay = true;
      if (closeBtn) closeBtn.style.display = '';
      if (filmstrip) filmstrip.style.display = 'none';
      chart.setReveal(day.bars.length);
      if (!S.showAnalysis) toggleAnalysis();
    } else if (m === 'analysis') {
      S.allDay = false;
      if (closeBtn) closeBtn.style.display = 'none';
      if (panel) panel.style.display = 'none';
      chart.setOverlays([]);
      S.showAnalysis = false;
      if (filmstrip) { filmstrip.style.display = ''; renderFilmstrip(); }
      chart.setReveal(S.reveal);
      ensureFrameNotes();
    } else {
      S.allDay = false;
      if (closeBtn) closeBtn.style.display = 'none';
      if (filmstrip) filmstrip.style.display = 'none';
      if (panel) panel.style.display = 'none';
      chart.setOverlays([]);
      S.showAnalysis = false;
      chart.setReveal(S.reveal);
    }
    updateBar();
  }

  /* 右侧面板 tab */
  function setRightTab(name) {
    $$('.rd-right-tabs button', root).forEach(b => b.classList.toggle('on', b.dataset.rtab === name));
    $$('[data-rpane]', root).forEach(p => p.style.display = p.dataset.rpane === name ? '' : 'none');
  }

  /* 当前价 */
  function curPrice() {
    const i = clamp(S.reveal - 1, 0, day.bars.length - 1);
    return day.bars[i]?.c ?? day.close;
  }

  /* 播放粒度：分钟/秒 */
  function setGranularity(g) {
    S.granularity = g;
    $$('.rd-gran button', root).forEach(b => b.classList.toggle('on', b.dataset.gran === g));
  }

  function stepSize() {
    // 分钟：每次 1 根；秒：每次 5 根（快速跳过）
    return S.granularity === 'min' ? 1 : 5;
  }

  /* 刷新订单类型按钮 */
  function setOrderType(t) {
    S.orderType = t;
    $$('.rd-otype button', root).forEach(b => b.classList.toggle('on', b.dataset.otype === t));
    const hint = $('.rd-pend-hint span', root);
    if (hint) {
      const txt = t === 'market' ? 'Market Order - click to execute' : `${t.toUpperCase()} Order - click chart price to add`;
      hint.textContent = txt;
    }
    /* 非市价单自动进入选价模式 */
    if (t === 'market') {
      chart.setTool('cursor');
      $$('.rd-tool', root).forEach(x => x.classList.toggle('on', x.dataset.tool === 'cursor'));
    } else {
      chart.setTool('price');
      $$('.rd-tool', root).forEach(x => x.classList.toggle('on', x.dataset.tool === 'price'));
      chart.onPricePick = { side: S.orderSide, cb: p => renderPanel() };
    }
    renderPanel();
  }

  /* 右侧面板渲染 */
  function renderPanel() {
    const price = curPrice();
    const un = sim.unrealized(price);
    const eq = sim.equity(price);

    $('.rd-stat-row:nth-child(1) .rd-stat-v', root).className = `rd-stat-v pos ${sim.pos > 0 ? 'long' : sim.pos < 0 ? 'short' : ''}`;
    $('.rd-stat-row:nth-child(1) .rd-stat-v', root).textContent = sim.pos > 0 ? 'Long' : sim.pos < 0 ? 'Short' : 'Flat';

    setVal(2, (un >= 0 ? '+' : '') + money(un), cls(un));
    setVal(3, '$' + px(price), '');
    setVal(4, (sim.realized >= 0 ? '+' : '') + money(sim.realized), cls(sim.realized));
    setVal(5, (eq >= 0 ? '+' : '') + money(eq), cls(eq));

    const qInp = $('[data-f=qty]', root);
    if (qInp && document.activeElement !== qInp) qInp.value = sim.qty;

    const flatBtn = $('[data-act=flat]', root);
    if (flatBtn) flatBtn.disabled = !sim.pos;

    /* pending / fills */
    renderOrders();
  }

  function setVal(n, val, cname) {
    const v = $(`.rd-stat-row:nth-child(${n}) .rd-stat-v`, root);
    if (!v) return;
    v.textContent = val;
    v.className = 'rd-stat-v num' + (cname ? ' ' + cname : '');
  }

  function renderOrders() {
    const box = $('.rd-orders', root);
    if (!box) return;
    const head = box.previousElementSibling;
    const count = head ? head.querySelector('.rd-count') : null;
    if (count) count.textContent = sim.orders.length;

    if (!sim.orders.length) { box.innerHTML = '<div class="rd-empty">暂无挂单</div>'; return; }
    box.innerHTML = sim.orders.map(o => `
      <div class="rd-order">
        <span class="rd-oside ${o.side}">${o.side.toUpperCase()}</span>
        <span class="rd-otype-tag">${o.type.toUpperCase()}</span>
        <span class="rd-oprice">${px(o.price)}</span>
        <span class="rd-oqty">${o.qty}</span>
        <button class="rd-odel" data-del="${o.id}">×</button>
      </div>`).join('');
  }

  function renderFills() {
    const sec = $$('.rd-sec-h', root)[1];
    const box = sec?.nextElementSibling;
    if (sec) {
      const count = sec.querySelector('.rd-count');
      if (count) count.textContent = sim.fills.length;
    }
    if (!box) return;
    if (!sim.fills.length) { box.innerHTML = '<div class="rd-empty">暂无成交</div>'; return; }
    box.innerHTML = sim.fills.slice(-6).reverse().map(f => `
      <div class="rd-order">
        <span class="rd-oside ${f.side}">${f.side.toUpperCase()}</span>
        <span class="rd-oprice">${px(f.price)}</span>
        <span class="rd-oqty">${barTime(day.bars[f.i])} × ${f.qty}</span>
      </div>`).join('');
  }

  function renderMarkers() {
    const m = sim.fills.map(f => ({ i: f.i, price: f.price, type: f.side, label: '' }));
    chart.setMarkers(m);
  }

  function updateBar() {
    const clock = $('.rd-clock', root);
    if (clock) clock.textContent = barTime(day.bars[S.reveal - 1]);
    const idx = $('[data-f=idx]', root);
    if (idx) idx.textContent = `${S.reveal} / ${day.bars.length}`;
    const pr = $('.rd-progress i', root);
    if (pr) pr.style.width = (S.reveal / day.bars.length * 100) + '%';
    /* 日期导航 */
    const curIdx = dates ? dates.indexOf(date) : -1;
    const prevD = curIdx > 0 ? dates[curIdx - 1] : '--';
    const pd = $('.rd-prevdate', root); if (pd) pd.textContent = prevD;
    updateHeaderOHLC();
  }

  function updateHeaderOHLC() {
    const n = S.reveal || day.bars.length;
    const visible = day.bars.slice(0, n);
    if (!visible.length) return;
    const o = visible[0].o;
    const c = visible[visible.length - 1].c;
    const h = Math.max(...visible.map(b => b.h));
    const l = Math.min(...visible.map(b => b.l));
    const change = c - o;
    const changePct = o ? (change / o * 100) : 0;
    const ob = $('[data-f=ohlc] [data-f=o]', root); if (ob) { ob.textContent = px(o); ob.className = ''; }
    const hb = $('[data-f=ohlc] [data-f=h]', root); if (hb) { hb.textContent = px(h); hb.className = ''; }
    const lb = $('[data-f=ohlc] [data-f=l]', root); if (lb) { lb.textContent = px(l); lb.className = ''; }
    const cb = $('[data-f=ohlc] [data-f=c]', root); if (cb) { cb.textContent = px(c); cb.className = cls(change); }
    const chg = $('[data-f=chg]', root);
    if (chg) {
      chg.textContent = `${sign(change)}${px(Math.abs(change))} (${sign(changePct)}${Math.abs(changePct).toFixed(2)}%)`;
      chg.className = `rd-hchg ${cls(change)}`;
    }
    // 指标尾值也随 reveal 更新
    const lastIdx = Math.max(0, n - 1);
    const ema20Now = e20arr[lastIdx] ?? c;
    const vwapNow = vwarr[lastIdx] ?? c;
    const emaEl = $('.rd-hinds .ind.ema20', root);
    const vwapEl = $('.rd-hinds .ind.vwap', root);
    if (emaEl) emaEl.innerHTML = `<i></i>EMA20 ${px(ema20Now)}`;
    if (vwapEl) vwapEl.innerHTML = `<i></i>VWAP ${px(vwapNow)}`;
  }

  function setReveal(n) {
    const prev = curPrice();
    S.reveal = clamp(n, 1, day.bars.length);
    if (S.mode !== 'day') chart.setReveal(S.reveal);
    const cur = curPrice();
    const hit = sim.checkOrders(prev, cur);
    for (const o of hit) {
      sim.market(o.side, o.price, o.qty);
      toast(`${o.side === 'buy' ? '买入' : '卖出'} ${o.qty} @ ${px(o.price)} 已成交`, 'ok');
    }
    chart.pendingOrder = null;
    updateBar();
    renderPanel();
    renderMarkers();
    renderFills();
    if (S.mode === 'analysis') renderFilmstrip();
  }

  function exec(side) {
    const price = curPrice();
    sim._i = S.reveal - 1;
    if (S.orderType === 'market') {
      sim.market(side, price);
      toast(`${side === 'buy' ? '买入' : '卖出'} ${sim.qty} @ ${px(price)}`, 'ok');
    } else {
      if (!chart.pendingOrder) return toast('请先点击图表选择价位', 'err');
      const type = S.orderType === 'stoplimit' ? 'stop' : S.orderType;
      sim.addOrder({ side, type, price: chart.pendingOrder.price, qty: sim.qty });
      toast(`已挂${type === 'limit' ? '限价' : '止损'}${side === 'buy' ? '买' : '卖'}单 @ ${px(chart.pendingOrder.price)}`, 'ok');
      chart.pendingOrder = null;
      chart.setTool('cursor');
      $$('.rd-tool', root).forEach(x => x.classList.toggle('on', x.dataset.tool === 'cursor'));
    }
    renderPanel(); renderMarkers(); renderFills();
  }

  function quick(side) {
    chart.setTool('price');
    S.orderSide = side;
    chart.onPricePick = { side, cb: p => {
      const type = S.orderType === 'stoplimit' ? 'stop' : (S.orderType === 'market' ? 'limit' : S.orderType);
      sim.addOrder({ side, type, price: p, qty: sim.qty });
      toast(`已挂${type === 'limit' ? '限价' : '止损'}${side === 'buy' ? '买' : '卖'}单 @ ${px(p)}`, 'ok');
      chart.pendingOrder = null;
      chart.setTool('cursor');
      $$('.rd-tool', root).forEach(x => x.classList.toggle('on', x.dataset.tool === 'cursor'));
      renderPanel(); renderMarkers(); renderFills();
    }};
    toast('请点击图表选择挂单价位');
  }

  /* 事件委托 */
  root.addEventListener('click', e => {
    const card = e.target.closest('[data-jump]');
    if (card) { pause(); setReveal(+card.dataset.jump + 1); return; }
    const b = e.target.closest('[data-act],[data-tool],[data-mode],[data-rtab],[data-otype],[data-gran],[data-del]');
    if (!b) return;

    if (b.dataset.tool) { setTool(b.dataset.tool); return; }
    if (b.dataset.mode) { setModeTab(b.dataset.mode); return; }
    if (b.dataset.rtab) { setRightTab(b.dataset.rtab); return; }
    if (b.dataset.otype) { setOrderType(b.dataset.otype); return; }
    if (b.dataset.gran) { setGranularity(b.dataset.gran); return; }
    if (b.dataset.del) { sim.orders = sim.orders.filter(o => o.id !== b.dataset.del); renderPanel(); return; }

    switch (b.dataset.act) {
      case 'datepick': toggleDatePicker(); break;
      case 'timepick': toggleTimePicker(); break;
      case 'prev': pause(); setReveal(S.reveal - stepSize()); break;
      case 'next': pause(); setReveal(S.reveal + stepSize()); break;
      case 'play':
      case 'start': S.playing ? pause() : play(); break;
      case 'closeday': setModeTab('analysis'); break;
      case 'end': pause(); setReveal(day.bars.length); break;
      case 'reset': sim.reset(); chart.pendingOrder = null; renderPanel(); renderMarkers(); renderFills(); toast('已重置交易'); break;
      case 'buy': exec('buy'); break;
      case 'sell': exec('sell'); break;
      case 'flat': sim._i = S.reveal - 1; sim.flat(curPrice()); renderPanel(); renderMarkers(); renderFills(); break;
      case 'qbuy': quick('buy'); break;
      case 'qsell': quick('sell'); break;
      case 'qty-': sim.qty = Math.max(0, sim.qty - 50); renderPanel(); break;
      case 'qty+': sim.qty += 50; renderPanel(); break;
      case 'pickprice': chart.setTool('price'); chart.onPricePick = { side: S.orderSide, cb: p => renderPanel() }; toast('请点击图表选择价位'); break;
    }
  });

  root.addEventListener('change', e => {
    const f = e.target.dataset.f;
    if (f === 'qty') { sim.qty = Math.max(0, parseInt(e.target.value) || 0); renderPanel(); }
  });

  root.addEventListener('input', e => {
    if (e.target.type === 'range') {
      S.speed = +e.target.value;
      const spd = $('[data-f=spd]', root);
      if (spd) spd.textContent = S.speed + 'x';
    }
  });

  /* 播放 */
  let last = 0;
  function tick(ts) {
    if (!S.playing) return;
    if (!last) last = ts;
    const dt = (ts - last) / 1000;
    last = ts;
    const base = S.granularity === 'sec' ? 2 : 0.5; // min: 1x=1 根/2 秒（慢回放）；sec: 快速跳过
    S._acc = (S._acc || 0) + dt * S.speed * base;
    if (S._acc >= 1) {
      const step = Math.floor(S._acc) * stepSize();
      S._acc -= Math.floor(S._acc);
      if (S.reveal + step >= day.bars.length) { setReveal(day.bars.length); pause(); }
      else setReveal(S.reveal + step);
    }
    S.raf = requestAnimationFrame(tick);
  }
  function play() {
    chart.setPlaying(true);
    if (S.reveal >= day.bars.length) setReveal(1);
    S.playing = true; last = 0; S._acc = 0;
    const btn = $('[data-act=start]', root);
    if (btn) { btn.textContent = '❚❚'; btn.classList.add('on'); }
    chart.followLatest();
    S.raf = requestAnimationFrame(tick);
  }
  function pause() {
    S.playing = false; last = 0;
    chart.setPlaying(false);
    const btn = $('[data-act=start]', root);
    if (btn) { btn.textContent = '▶'; btn.classList.remove('on'); }
    if (S.raf) cancelAnimationFrame(S.raf);
  }

  /* 实时模式 */
  if (!replay) {
    S.timer = setInterval(() => { renderPanel(); }, 1000);
  }

  /* 市场分析叠加（默认关闭） */
  function toggleAnalysis() {
    S.showAnalysis = !S.showAnalysis;
    const panel = $('[data-rp=analysis]', root);
    if (S.showAnalysis) {
      getReport(date).then(rep => {
        if (!rep) { toast('该日暂无市场分析数据', 'err'); S.showAnalysis = false; return; }
        applyAnalysis(rep, panel);
      }).catch(() => { toast('分析数据加载失败', 'err'); S.showAnalysis = false; });
    } else {
      chart.setOverlays([]);
      if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    }
  }

  function applyAnalysis(rep, panel) {
    const hhmmIdx = {};
    day.bars.forEach(b => { hhmmIdx[toHHMM(b.t)] = b.i; });
    const ov = [];
    for (const s of (rep.segments || [])) {
      const si = hhmmIdx[s.start], ei = hhmmIdx[s.end];
      if (si == null || ei == null) continue;
      ov.push({ kind: 'seg', startIndex: si, endIndex: ei,
        dir: s.dir === 'long' ? 'bull' : s.dir === 'short' ? 'bear' : 'flat', label: s.label });
    }
    for (const m of (rep.markers || [])) {
      const i = hhmmIdx[m.t]; if (i == null || !m.price) continue;
      const kind = m.kind === 'entry' ? 'entry' : m.kind === 'close' ? 'close'
        : m.kind === 'tp' ? 'tp' : m.kind === 'stop' ? 'stop' : 'signal';
      ov.push({ kind, i, price: m.price, label: m.label });
    }
    chart.setOverlays(ov);

    let html = '';
    if (rep.morning && rep.morning.summary)
      html += `<div class="rd-a-sec"><div class="rd-a-h">早盘概要</div><div class="rd-a-b">${esc(rep.morning.summary)}</div></div>`;
    if (rep.advice)
      html += `<div class="rd-a-sec"><div class="rd-a-h">操作建议</div><div class="rd-a-b">${esc(rep.advice)}</div></div>`;
    if (rep.segments && rep.segments.length) {
      html += `<div class="rd-a-sec"><div class="rd-a-h">分段总览 (${rep.segments.length})</div><div class="rd-a-list">`;
      for (const s of rep.segments) {
        const cl = s.dir === 'long' ? 'bull' : s.dir === 'short' ? 'bear' : 'flat';
        html += `<div class="rd-a-row ${cl}"><span class="rd-a-range">${esc(s.start)}–${esc(s.end)}</span><span class="rd-a-label">${esc(s.label || '')}</span></div>`;
      }
      html += `</div></div>`;
    }
    if (panel) { panel.innerHTML = html; panel.style.display = ''; }
  }

  /* ---------------- 逐帧分析（分析模式底部胶片） ---------------- */
  async function ensureFrameNotes() {
    if (S.frameNotes.length) return;
    const rep = await getReport(date);
    S.report = rep;
    S.frameNotes = buildFrameNotes(rep);
  }

  function buildFrameNotes(rep) {
    const notes = day.bars.map(b => {
      const time = toHHMM(b.t);
      return { i: b.i, time, text: '还不能确定方向，需要等待', dir: null, event: null, tag: '待定' };
    });
    if (!rep) return notes;

    // 优先使用 pro_data.minutes 的逐分钟 note/tag，与源站胶片条 1:1 对齐
    const minutes = rep.minutes || [];
    if (minutes.length) {
      const hhmmIdx = {};
      day.bars.forEach(b => { hhmmIdx[toHHMM(b.t)] = b.i; });
      for (const m of minutes) {
        const i = hhmmIdx[m.time];
        if (i == null) continue;
        const dir = m.dir === '多' ? 'long' : m.dir === '空' ? 'short' : null;
        notes[i] = {
          i, time: m.time,
          text: (m.note || '还不能确定方向，需要等待').trim(),
          dir,
          event: null,
          eventLabel: null,
          tag: m.tag || m.effectiveTag || '待定'
        };
      }
      return notes;
    }

    // 退化：按段落到每根 bar
    const hhmmIdx = {};
    day.bars.forEach(b => { hhmmIdx[toHHMM(b.t)] = b.i; });
    for (const s of (rep.segments || [])) {
      const si = hhmmIdx[s.start], ei = hhmmIdx[s.end];
      if (si == null || ei == null) continue;
      const dir = s.dir === 'long' ? 'long' : s.dir === 'short' ? 'short' : null;
      const concise = dir === 'long' ? '看多，等回撤做多的机会'
                    : dir === 'short' ? '看空，等反弹做空的机会'
                    : '还不能确定方向，需要等待';
      const segText = s.label && !/^多头趋势$|^空头趋势$|^无方向$/.test(s.label)
        ? s.label.replace(/\*\*/g, '').trim().slice(0, 40)
        : concise;
      for (let i = si; i <= ei; i++) {
        if (!notes[i]) continue;
        notes[i].dir = dir;
        notes[i].text = segText;
        if (i === si) notes[i].isSegmentStart = true;
      }
    }

    for (const m of (rep.markers || [])) {
      const i = hhmmIdx[m.t];
      if (i == null) continue;
      notes[i].event = m.kind;
      notes[i].eventLabel = m.label;
      notes[i].text = m.label
        ? `${m.label}${notes[i].dir ? (notes[i].dir === 'long' ? '，偏多' : '，偏空') : ''}`
        : notes[i].text;
    }
    return notes;
  }

  function filmstripCard(n, isCurrent) {
    const cl = n.dir === 'long' ? 'bull' : n.dir === 'short' ? 'bear' : 'flat';
    const ev = n.eventLabel ? `<span class="rd-f-event">${esc(n.eventLabel)}</span>` : '';
    return `
      <div class="rd-f-card ${cl}${isCurrent ? ' current' : ''}" data-jump="${n.i}">
        <div class="rd-f-time">${n.time}</div>
        <div class="rd-f-text">${esc(n.text)}</div>
        ${ev}
      </div>`;
  }

  function renderFilmstrip() {
    const box = $('[data-rp=filmstrip]', root);
    if (!box) return;
    if (!S.frameNotes.length) {
      box.innerHTML = '<div class="rd-f-empty">加载逐帧分析中…</div>';
      ensureFrameNotes().then(() => renderFilmstrip());
      return;
    }
    // 显示当前帧前后各 30 帧（共 61 帧），避免一次性渲染 390 个卡片
    const half = 30;
    const start = Math.max(0, S.reveal - 1 - half);
    const end = Math.min(S.frameNotes.length, S.reveal - 1 + half + 1);
    const visible = S.frameNotes.slice(start, end);
    const curIdx = S.reveal - 1;
    box.innerHTML = visible.map(n => filmstripCard(n, n.i === curIdx)).join('');
    // 滚动到当前帧
    const cur = box.querySelector('.rd-f-card.current');
    if (cur) {
      const boxW = box.clientWidth;
      const curL = cur.offsetLeft;
      const curW = cur.clientWidth;
      box.scrollTo({ left: curL - boxW / 2 + curW / 2, behavior: 'smooth' });
    }
  }

  /* ---------------- 可拖动进度条 ---------------- */
  function initProgressDrag() {
    const bar = $('[data-act=progress]', root);
    if (!bar) return;
    let dragging = false;
    const move = e => {
      if (!dragging) return;
      const rect = bar.getBoundingClientRect();
      const x = (e.clientX || e.touches?.[0]?.clientX || 0) - rect.left;
      const pct = clamp(x / rect.width, 0, 1);
      const idx = Math.max(1, Math.round(pct * day.bars.length));
      pause();
      setReveal(idx);
    };
    const up = () => { dragging = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up); };
    bar.addEventListener('mousedown', e => { dragging = true; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); move(e); });
    bar.addEventListener('touchstart', e => { dragging = true; window.addEventListener('touchmove', move); window.addEventListener('touchend', up); move(e); }, { passive: false });
  }

  /* ---------------- 日期选择器 — 源站日历弹层风格 ---------------- */
  let datePickerOpen = false;
  let timePickerOpen = false;
  let dpViewYear, dpViewMonth;
  function onDocClickDate(e) {
    if (!datePickerOpen) return;
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
    const pick = root.querySelector('.rd-datepick');
    const pop = $('.rd-datepop', root);
    if (path.indexOf(pick) >= 0 || (pop && path.indexOf(pop) >= 0)) return;
    closeDatePicker();
  }
  function toggleDatePicker() {
    datePickerOpen = !datePickerOpen;
    const pop = $('.rd-datepop', root);
    if (!pop) return;
    if (datePickerOpen) {
      const d0 = parseDate(date);
      dpViewYear = d0.getFullYear(); dpViewMonth = d0.getMonth();
      renderDatePicker(pop);
      pop.style.display = 'block';
      setTimeout(() => document.addEventListener('click', onDocClickDate), 0);
    } else {
      closeDatePicker();
    }
  }
  function closeDatePicker() {
    datePickerOpen = false;
    const pop = $('.rd-datepop', root);
    if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; }
    document.removeEventListener('click', onDocClickDate);
  }
  function dpGotoMonth(pop, delta) {
    dpViewMonth += delta;
    if (dpViewMonth < 0) { dpViewMonth = 11; dpViewYear--; }
    else if (dpViewMonth > 11) { dpViewMonth = 0; dpViewYear++; }
    renderDatePicker(pop);
  }

  /* ---------------- 时间选择器（点击控制栏当前时间） ---------------- */
  function toggleTimePicker() {
    timePickerOpen = !timePickerOpen;
    const pop = $('.rd-timepop', root);
    if (!pop) return;
    if (timePickerOpen) {
      renderTimePicker(pop);
      pop.style.display = 'block';
      setTimeout(() => document.addEventListener('click', closeTimePicker, { once: true }), 0);
    } else {
      pop.style.display = 'none';
      pop.innerHTML = '';
    }
  }
  function closeTimePicker(e) {
    if (e && e.target.closest('.rd-timepick')) return;
    timePickerOpen = false;
    const pop = $('.rd-timepop', root);
    if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; }
  }
  function renderTimePicker(pop) {
    const presets = [
      { label: 'Open', time: '09:30' },
      { label: '10:30', time: '10:30' },
      { label: '11:30', time: '11:30' },
      { label: '12:30', time: '12:30' },
      { label: '13:30', time: '13:30' },
      { label: '14:30', time: '14:30' },
      { label: '15:30', time: '15:30' },
      { label: 'Close', time: '16:00' }
    ];
    const cur = barTime(day.bars[S.reveal - 1]);
    let html = '<div class="rd-tp-head"><span>QUICK</span></div>';
    html += '<div class="rd-tp-quick">';
    for (const p of presets) {
      const active = p.time === cur ? ' active' : '';
      html += `<button class="rd-tp-btn${active}" data-tpick="${p.time}">${p.label}</button>`;
    }
    html += '</div>';
    html += '<div class="rd-tp-custom"><span>CUSTOM</span>';
    html += `<input type="time" class="rd-tp-input" value="${cur}">`;
    html += '<button class="rd-tp-go" data-tpick="custom">GO</button>';
    html += '</div>';
    pop.innerHTML = html;

    const go = (t) => {
      if (!t) return;
      closeTimePicker();
      jumpToTime(t);
    };
    pop.querySelectorAll('[data-tpick]').forEach(el => el.addEventListener('click', ev => {
      ev.stopPropagation();
      let t = el.dataset.tpick;
      if (t === 'custom') {
        const input = $('.rd-tp-input', pop);
        t = input ? input.value : null;
      }
      go(t);
    }));
    const input = $('.rd-tp-input', pop);
    if (input) input.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(input.value); });
  }
  function jumpToTime(t) {
    pause();
    const idx = day.bars.findIndex(b => toHHMM(b.t) === t);
    if (idx < 0) return toast(`未找到 ${t} 的时刻`, 'err');
    setReveal(idx + 1);
    toast(`已跳转至 ${t}`, 'ok');
  }

  function renderDatePicker(pop) {
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function pad(n) { return String(n).padStart(2, '0'); }
    function hasData(dstr) { return dates && dates.includes(dstr); }

    const first = new Date(dpViewYear, dpViewMonth, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(dpViewYear, dpViewMonth + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      const prevDays = new Date(dpViewYear, dpViewMonth, 0).getDate() - (startWeekday - 1 - i);
      cells.push({ d: prevDays, out: true });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      const dstr = `${dpViewYear}-${pad(dpViewMonth + 1)}-${pad(i)}`;
      cells.push({ d: i, dstr, has: hasData(dstr), out: false, isSel: dstr === date });
    }
    let tail = 1;
    while (cells.length < 42) { cells.push({ d: tail++, out: true }); }

    const grid = cells.map(c => {
      if (c.out) return `<span class="dp-cal-cell out">${c.d}</span>`;
      if (!c.has) return `<span class="dp-cal-cell nodata" data-pick="${c.dstr}">${c.d}</span>`;
      return `<span class="dp-cal-cell ${c.isSel ? 'sel' : ''}" data-pick="${c.dstr}">${c.d}<span class="dp-cal-dots"><i class="dp-k-dot"></i><i class="dp-notes-dot"></i></span></span>`;
    }).join('');

    pop.innerHTML = `
      <div class="dp-cal-head">
        <button class="dp-cal-nav" data-dp-nav="-1" title="上个月" aria-label="上个月">‹</button>
        <div class="dp-cal-title">${monthName[dpViewMonth]} ${dpViewYear}</div>
        <button class="dp-cal-nav" data-dp-nav="1" title="下个月" aria-label="下个月">›</button>
      </div>
      <div class="dp-cal-week"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="dp-cal-grid">${grid}</div>
      <div class="dp-cal-foot"><span class="dp-cal-dot dp-k-dot"></span>K<span class="dp-cal-dot dp-notes-dot"></span>Notes</div>
    `;

    pop.querySelectorAll('[data-dp-nav]').forEach(btn => btn.addEventListener('click', ev => {
      ev.stopPropagation();
      dpGotoMonth(pop, +btn.dataset.dpNav);
    }));
    pop.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', ev => {
      ev.stopPropagation();
      if (el.classList.contains('nodata')) {
        el.classList.add('shake');
        setTimeout(() => el.classList.remove('shake'), 300);
        return;
      }
      closeDatePicker();
      onDateChange(el.dataset.pick);
    }));
  }

  updateBar();
  renderPanel();
  renderFills();
  chart.onPricePick = { side: S.orderSide, cb: () => renderPanel() };
  setModeTab(S.mode);
  initProgressDrag();
  if (S.mode === 'analysis') ensureFrameNotes();
  // 源站「回放复盘」默认不自动播放，由用户手动点击开始（▶）后再逐帧回放


  return {
    destroy() {
      pause();
      clearInterval(S.timer);
      chart.destroy();
    }
  };
}

function shiftDay(d, n) {
  const dt = parseDate(d);
  do { dt.setDate(dt.getDate() + n); } while (dt.getDay() === 0 || dt.getDay() === 6);
  return fmtDate(dt);
}

/* ============================================================
   回放复盘
   ============================================================ */
export async function replayPage(ctx) {
  const { mount } = ctx;
  let dates = [];
  let date = ctx.params.date || null;
  let inst = null;

  async function render() {
    inst?.destroy();
    if (!dates.length) dates = await loadDates();
    if (!date || !dates.includes(date)) date = dates.length ? dates[dates.length - 1] : (date || '2026-05-01');
    const day = await loadReplayDay(date);
    if (!day) {
      mount.innerHTML = `<div class="center-empty">该交易日暂无真实行情数据<br><span class="fs11">${esc(date)} · 回放复盘仅支持已抓取的真实 QQQ 1 分钟行情日期</span></div>`;
      return;
    }
    inst = buildTV(mount, {
      date, replay: true, day, dates,
      onDateChange(d) { date = d; history.replaceState(null, '', `#/replay?date=${d}`); render(); }
    });
  }
  render();
  return () => inst?.destroy();
}

/* ============================================================
   实时分析
   ============================================================ */
export async function livePage(ctx) {
  const { mount } = ctx;
  let dates = [];
  let date = ctx.params.date || null;
  let inst = null;

  async function render() {
    inst?.destroy();
    if (!dates.length) dates = await loadDates();
    if (!date || !dates.includes(date)) date = dates.length ? dates[dates.length - 1] : (date || '2026-05-01');
    const day = await loadReplayDay(date);
    if (!day) {
      mount.innerHTML = `<div class="center-empty">该交易日暂无真实行情数据<br><span class="fs11">${esc(date)}</span></div>`;
      return;
    }
    inst = buildTV(mount, {
      date, replay: false, day, dates,
      onDateChange(d) { date = d; render(); }
    });
  }
  render();
  return () => inst?.destroy();
}

/* ============================================================
   交易日志
   ============================================================ */
export function journalPage(ctx) {
  const { mount } = ctx;
  const KEY = 'journal';
  let edits = store.get(KEY, {});
  let date = ctx.params.date || '2026-08-28';
  let openId = null;
  let chart = null;
  let day = null;

  function tradesOf(d) {
    /* 用户编辑优先，未编辑则用生成的演示数据 */
    return edits[d] || genTrades(d);
  }
  function save() { store.set(KEY, edits); }

  async function render() {
    chart?.destroy();
    day = (await loadReplayDay(date)) || genDay(date);
    const trades = tradesOf(date);
    const sum = daySummary(trades);
    const d = parseDate(date);

    mount.innerHTML = `
      <div class="jr">
        <div class="jr-chart"></div>
        <div class="jr-side">
          <div class="jr-side-h">
            <div>
              <div class="row">
                <button class="rbtn" data-act="pd">‹</button>
                <input type="date" class="inp inp-sm" style="width:130px" value="${date}">
                <button class="rbtn" data-act="nd">›</button>
              </div>
              <div class="fs11 dim mt8">${date} 周${weekdayCN(d)}</div>
            </div>
            <span class="badge up">已保存</span>
          </div>
          <div class="jr-side-b">
            <div class="sum-grid">
              <div class="sum-cell"><div class="k">总盈亏</div><div class="v ${cls(sum.pnl)}">${moneyS(sum.pnl)}</div></div>
              <div class="sum-cell"><div class="k">盈 / 亏</div><div class="v"><span class="up">${sum.win}</span><span class="dim">/</span><span class="down">${sum.loss}</span></div></div>
              <div class="sum-cell"><div class="k">胜率</div><div class="v">${sum.rate.toFixed(0)}%</div></div>
              <div class="sum-cell"><div class="k">R 倍数</div><div class="v ${cls(sum.r)}">${rs(sum.r)}</div></div>
              <div class="sum-cell"><div class="k">最佳单笔</div><div class="v up">${sum.count ? money(sum.best) : '--'}</div></div>
              <div class="sum-cell"><div class="k">最差单笔</div><div class="v down">${sum.count ? money(sum.worst) : '--'}</div></div>
            </div>

            <div class="row mb12">
              <span class="fs12 muted">当日交易（${trades.length}）</span>
              <span class="spacer"></span>
              <button class="btn btn-sm btn-primary" data-act="add">+ 添加新交易</button>
            </div>

            <div id="tlist"></div>

            ${trades.length ? '' : '<div class="center-empty" style="height:160px">当天暂无交易记录<br><span class="fs11">点击右上角「添加新交易」开始记录</span></div>'}
          </div>
        </div>
      </div>`;

    /* 图表 */
    const host = $('.jr-chart', mount);
    chart = new Chart(host);
    chart.setBars(day.bars);
    chart.setReveal(day.bars.length);
    const mk = [];
    for (const t of trades) {
      mk.push({ i: t.entryIdx, price: t.entryPrice, type: 'entry', label: '入场' });
      mk.push({ i: t.exitIdx, price: t.exitPrice, type: 'exit', label: '出场' });
    }
    chart.setMarkers(mk);

    renderList(trades);
  }

  function renderList(trades) {
    const box = $('#tlist', mount);
    if (!box) return;
    box.innerHTML = trades.map((t, n) => `
      <div class="trade${openId === t.id ? ' open' : ''}" data-id="${t.id}">
        <div class="trade-h">
          <span class="caret">▶</span>
          <span class="idx">${n + 1}</span>
          <span class="ttl">
            <span class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? '做多' : '做空'}</span>
            ${t.entryTime} – ${t.exitTime}
          </span>
          <span class="num ${cls(t.pnl)}" style="font-size:13px">${moneyS(t.pnl)}</span>
          <span class="badge ${cls(t.r)}">${rs(t.r)}</span>
        </div>
        <div class="trade-b">
          <div class="leg">
            <span class="dir b">买入</span>
            <span class="lbl">时间</span><input value="${t.entryTime}" data-k="entryTime">
            <span class="lbl">价格</span><input value="${t.entryPrice.toFixed(2)}" data-k="entryPrice" type="number" step="0.01">
            <span class="lbl">数量</span><input value="${t.qty}" data-k="qty" type="number" step="50">
          </div>
          <div class="leg">
            <span class="dir s">卖出</span>
            <span class="lbl">时间</span><input value="${t.exitTime}" data-k="exitTime">
            <span class="lbl">价格</span><input value="${t.exitPrice.toFixed(2)}" data-k="exitPrice" type="number" step="0.01">
            <span class="lbl">盈亏</span>
            <span class="num ${cls(t.pnl)}" style="flex:1">${moneyS(t.pnl)} · ${rs(t.r)}</span>
          </div>

          <div class="field mt8">
            <label>入场前判断 · 入场理由与当时的心态（选填）</label>
            <textarea class="inp" data-k="note1">${esc(t.note1 || '')}</textarea>
          </div>
          <div class="field">
            <label>持仓中心态（选填）</label>
            <textarea class="inp" data-k="note2">${esc(t.note2 || '')}</textarea>
          </div>
          <div class="field">
            <label>出场决策与事后复盘（选填）</label>
            <textarea class="inp" data-k="note3">${esc(t.note3 || '')}</textarea>
          </div>

          <div class="field">
            <label>标签（可多选）</label>
            <div class="tagpick">
              ${TAGS.map(c => `<span class="chip click${t.cats.includes(c) ? ' sel' : ''}" data-cat="${c}">${c}</span>`).join('')}
            </div>
            <div class="tagpick mt8">
              ${(t.tags || []).map(g => `<span class="chip blue">${esc(g)}</span>`).join('')}
            </div>
          </div>

          <div class="row">
            <button class="btn btn-sm" data-act="dupe">复制此单</button>
            <span class="spacer"></span>
            <button class="btn btn-sm" data-act="del" style="color:var(--down)">删除</button>
            <button class="btn btn-sm btn-primary" data-act="saveone">保存</button>
          </div>
        </div>
      </div>`).join('');
  }

  /* 事件 */
  mount.addEventListener('click', e => {
    const h = e.target.closest('.trade-h');
    if (h) {
      const id = h.parentElement.dataset.id;
      openId = openId === id ? null : id;
      render();
      return;
    }
    const b = e.target.closest('[data-act],[data-cat]');
    if (!b) return;

    if (b.dataset.cat) {
      const id = b.closest('.trade').dataset.id;
      const list = tradesOf(date);
      const t = list.find(x => x.id === id);
      const c = b.dataset.cat;
      if (t.cats.includes(c)) t.cats = t.cats.filter(x => x !== c);
      else { t.cats.push(c); t.tags.push(TAG_DETAIL[c][0]); }
      edits[date] = list; save();
      render();
      return;
    }

    switch (b.dataset.act) {
      case 'pd': date = shiftDay(date, -1); openId = null; render(); break;
      case 'nd': date = shiftDay(date, 1); openId = null; render(); break;
      case 'add': {
        const list = tradesOf(date);
        const dref = day || genDay(date);
        const i1 = 20 + Math.floor(Math.random() * 200);
        const i2 = Math.min(389, i1 + 12);
        list.push({
          id: 'T' + Date.now(), side: 'long',
          entryTime: barTime(i1), exitTime: barTime(i2),
          entryIdx: i1, exitIdx: i2,
          entryPrice: dref.bars[i1].c, exitPrice: dref.bars[i2].c,
          qty: 100,
          pnl: (day.bars[i2].c - day.bars[i1].c) * 100,
          r: Math.round((day.bars[i2].c - day.bars[i1].c) * 100 / 300 * 100) / 100,
          cats: [], tags: [], note1: '', note2: '', note3: ''
        });
        edits[date] = list; save();
        openId = list[list.length - 1].id;
        render();
        break;
      }
      case 'del': {
        const id = b.closest('.trade').dataset.id;
        edits[date] = tradesOf(date).filter(x => x.id !== id);
        save(); render(); toast('已删除'); break;
      }
      case 'dupe': {
        const id = b.closest('.trade').dataset.id;
        const list = tradesOf(date);
        const t = list.find(x => x.id === id);
        list.push({ ...t, id: 'T' + Date.now() });
        edits[date] = list; save(); render(); toast('已复制'); break;
      }
      case 'saveone': {
        const wrap = b.closest('.trade');
        const id = wrap.dataset.id;
        const list = tradesOf(date);
        const t = list.find(x => x.id === id);
        wrap.querySelectorAll('[data-k]').forEach(inp => {
          const k = inp.dataset.k;
          t[k] = inp.type === 'number' ? parseFloat(inp.value) || 0 : inp.value;
        });
        t.pnl = (t.side === 'long' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) * t.qty;
        t.r = Math.round(t.pnl / 300 * 100) / 100;
        edits[date] = list; save(); render(); toast('已保存', 'ok'); break;
      }
    }
  });

  mount.addEventListener('change', e => {
    if (e.target.type === 'date') { date = e.target.value; openId = null; render(); }
  });

  render();
  return () => chart?.destroy();
}
