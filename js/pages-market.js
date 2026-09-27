/* ============================================================
   pages-market.js — 市场报告频道（深度复刻版）
   图表 + 报告渲染由 js/market-chart.js（lightweight-charts，1:1 移植源站）完成；
   本页负责：日期选择器、数据加载、K线/报告装配、导入导出。
   ============================================================ */
import { $, $$, el, esc, store, toast, fmtDate, parseDate } from './core.js';
import { renderMarketChart, disposeMarketChart } from './market-chart.js';
import { loadDates, getReport, getReportDatesSync } from './market-data.js';

/* 有数据的日期集合（由 data/market/dates.json 构建，启动时异步加载） */
let REPORT_DATES = new Set();
let LATEST_DATE = '2026-09-25';

/* ============================================================
   CalPicker — 自定义日期选择器
   - 顶部 chip 显示当前日期
   - 点击展开月历（橙边头部 + 月份切换 + 已推送小蓝点）
   - 有数据的日期：小蓝点 + 可点
   - 没数据的日期：灰显 + 不可点
   ============================================================ */
/* 日历弹层的「外部点击/Esc 关闭」监听器句柄。
   全页只保留一份：每次重建选择器前先摘掉旧的，避免监听器只增不减（内存泄漏 + 重复触发）。 */
let calDocClick = null;
let calDocKey = null;

function buildCalPicker({ date, hasData, onPick }) {
  let viewYear, viewMonth;
  const d0 = parseDate(date);
  viewYear = d0.getFullYear(); viewMonth = d0.getMonth();
  const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function pad(n) { return String(n).padStart(2, '0'); }

  /* 只渲染「月历网格」。头部（月份箭头 / 标题 / 关闭）保持常驻不重建 ——
     这样点击箭头时被点的按钮始终留在文档里，不会被 innerHTML 替换成孤立节点，
     也就不会让 document 上的外部点击判断误判为"点了外面"。 */
  function gridCells() {
    const first = new Date(viewYear, viewMonth, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      const prevDays = new Date(viewYear, viewMonth, 0).getDate() - (startWeekday - 1 - i);
      cells.push({ d: prevDays, out: true });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      const dstr = `${viewYear}-${pad(viewMonth + 1)}-${pad(i)}`;
      cells.push({ d: i, dstr, has: hasData(dstr), out: false, isToday: dstr === date });
    }
    let tail = 1;
    while (cells.length < 42) { cells.push({ d: tail++, out: true }); }
    return cells.map(c => {
      if (c.out) return `<span class="cal-cell out">${c.d}</span>`;
      if (!c.has) return `<span class="cal-cell nodata" data-pick="${c.dstr}">${c.d}</span>`;
      return `<span class="cal-cell ${c.isToday ? 'sel':''}" data-pick="${c.dstr}">${c.d}<i class="cal-dot"></i></span>`;
    }).join('');
  }

  function render() {
    return `
      <div class="cal-wrap">
        <button class="cal-chip" id="cal-chip">
          <span class="cal-icn">📅</span>
          <span class="cal-date">${esc(date)}</span>
        </button>
        <button class="btn btn-sm" id="btn-today">回到今天</button>
        <div class="cal-pop" id="cal-pop" hidden>
          <div class="cal-head">
            <button class="cal-nav" data-cal-nav="-1" title="上个月" aria-label="上个月">‹</button>
            <div class="cal-title" id="cal-title">${monthName[viewMonth]} ${viewYear}</div>
            <button class="cal-nav" data-cal-nav="1" title="下个月" aria-label="下个月">›</button>
            <button class="cal-close" data-cal-close title="关闭" aria-label="关闭">×</button>
          </div>
          <div class="cal-week"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
          <div class="cal-grid" id="cal-grid">${gridCells()}</div>
          <div class="cal-foot"><span class="dot-blue"></span>已推送</div>
        </div>
      </div>
    `;
  }

  /* 切月：仅更新标题文字与网格内容，头部按钮原地保留 */
  function gotoMonth(pop, delta) {
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    else if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    const t = $('#cal-title', pop);
    if (t) t.textContent = `${monthName[viewMonth]} ${viewYear}`;
    const g = $('#cal-grid', pop);
    if (g) g.innerHTML = gridCells();
  }

  function attach(root) {
    const chip = $('#cal-chip', root);
    const pop  = $('#cal-pop', root);
    const wrap = root.querySelector('.cal-wrap');   // 选择器自身范围（chip + 回到今天 + 弹层）
    if (!chip || !pop || !wrap) return;
    const isOpen = () => !pop.hidden;
    const openPop = () => { pop.hidden = false; };
    const closePop = () => { pop.hidden = true; };

    chip.addEventListener('click', e => { e.stopPropagation(); isOpen() ? closePop() : openPop(); });

    const todayBtn = root.querySelector('#btn-today');
    if (todayBtn) todayBtn.addEventListener('click', () => { onPick(LATEST_DATE); closePop(); });

    pop.addEventListener('click', e => {
      const t = e.target;
      const nav = t.closest('[data-cal-nav]');
      if (nav) { gotoMonth(pop, +nav.dataset.calNav); return; }
      if (t.closest('[data-cal-close]')) { closePop(); return; }
      const cell = t.closest('[data-pick]');
      if (cell) {
        const dstr = cell.dataset.pick;
        if (cell.classList.contains('nodata')) {
          cell.classList.add('shake');
          setTimeout(() => cell.classList.remove('shake'), 300);
          return;
        }
        closePop();
        onPick(dstr);
      }
    });

    /* 外部点击关闭：判定范围是「选择器自身」(.cal-wrap)，而不是整个页面视图 ——
       否则点图表/空白处日历会一直挂着不关。
       优先用事件派发时快照的传播路径（composedPath）判定，即使 handler 内部重建过 DOM、
       e.target 已脱离文档也不会误判成"外部点击"。 */
    const onDocClick = e => {
      if (!isOpen()) return;
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(wrap) >= 0 || wrap.contains(e.target)) return;
      closePop();
    };
    const onDocKey = e => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { closePop(); return; }
      if (e.key === 'ArrowLeft') { gotoMonth(pop, -1); e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { gotoMonth(pop, 1); e.preventDefault(); return; }
    };
    if (calDocClick) { document.removeEventListener('click', calDocClick); calDocClick = null; }
    if (calDocKey) { document.removeEventListener('keydown', calDocKey); calDocKey = null; }
    calDocClick = onDocClick;
    calDocKey = onDocKey;
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  }

  return { render, attach };
}

export function marketPage(ctx) {
  const { mount, params } = ctx;
  let date = params.date || LATEST_DATE;
  let report = null;

  function hasData(d) { return REPORT_DATES.has(d); }

  /* 让 K 线卡片精确填满「视口 − 顶栏 − 页头 − 日期卡」剩余高度：
     拖动/缩放窗口时图表随之伸缩，不会出现 660px 死高导致的底部塌陷或溢出。
     窗口尺寸变化时同时把分隔条的临时像素比例复位，改回 60/40 自适应比例，避免旧像素值撑破布局。 */
  function fitChartCard(resetSplit) {
    const card = mount.querySelector('.market-k-card');
    if (!card) return;
    if (resetSplit) {
      const stage = mount.querySelector('#market-k-stage');
      const rep = mount.querySelector('#market-k-report');
      if (stage) stage.style.flex = '';
      if (rep) { rep.style.flex = ''; rep.style.height = ''; rep.style.maxHeight = ''; }
    }
    const top = card.getBoundingClientRect().top;
    const h = Math.max(520, Math.round(window.innerHeight - top - 18));
    card.style.height = h + 'px';
  }
  const onWinResize = () => fitChartCard(true);
  window.addEventListener('resize', onWinResize);

  function render() {
    const cal = buildCalPicker({
      date, hasData,
      onPick: d => { date = d; load(); }
    });
    mount.className = 'view pad';
    mount.innerHTML = `
      <div class="stats" style="padding-top:6px">
        <div class="page-head">
          <div>
            <div class="page-title"><span class="dot-amber"></span>市场报告</div>
            <div class="page-sub">市场报告频道 · 每天收盘后更新 QQQ 市场分析</div>
          </div>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="btn-import">导入数据</button>
          <button class="btn btn-sm" id="btn-export">导出快照</button>
        </div>

        <div class="card" style="padding:12px 14px;margin-bottom:10px">
          <div class="row" style="gap:14px;flex-wrap:wrap;align-items:center">
            ${cal.render()}
            <span class="fs14" style="font-weight:600">${esc(report ? (report.symbol || 'QQQ') : 'QQQ')} · 1分钟</span>
          </div>
        </div>

        ${report ? `
        <div class="card market-k-card" style="padding:0;position:relative">
          <div id="market-ai-content" class="market-k-mode"></div>
        </div>
        ` : `
        <div class="empty-state">
          <div class="empty-emoji">📭</div>
          <div class="empty-title">今日全天分析尚未发布</div>
          <div class="empty-tip">可点击右上角 <span class="empty-pill">📅 日期</span> 切换日期，查看往期分析报告。</div>
          <div class="empty-tip dim mt6">所选日期 ${esc(date)} 不在数据列表中（共 ${getReportDatesSync().length} 个工作日有数据）</div>
        </div>
        `}
      </div>`;

    cal.attach(mount);

    mount.addEventListener('click', e => {
      if (e.target.id === 'btn-import') { showImport(); return; }
      if (e.target.id === 'btn-export') { doExport(); return; }
    });

    if (report) {
      renderMarketChart($('#market-ai-content', mount), report, {});
      fitChartCard();
    }
  }

  async function load() {
    const custom = store.get('market_custom', null);
    if (custom && custom.date === date) { report = custom.data; render(); return; }
    report = await getReport(date);
    render();
  }

  function doExport() {
    const blob = new Blob([JSON.stringify({ date, report }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `market-${date}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('快照已导出', 'ok');
  }

  function showImport() {
    const mask = el(`
      <div class="mask" data-close>
        <div class="modal" style="max-width:680px">
          <div class="modal-h">
            <h3>导入数据</h3>
            <button class="x" data-x>×</button>
          </div>
          <div class="modal-b">
            <p class="fs12 dim mb8">把 supabase <code>tj_market_analysis</code> 单行 JSON 贴到下面，或粘贴 <code>pro_data</code> 字段。</p>
            <textarea class="inp" id="imp-json" rows="14" placeholder='{"date":"2026-09-04","symbol":"QQQ","pro_data":{...}}'></textarea>
            <div class="fs11 dim mt6">导入后该日期将使用你的数据，再次刷新仍然保留。点"重置示例"恢复默认示例。</div>
          </div>
          <div class="modal-f">
            <button class="btn" data-act="reset">重置示例</button>
            <span class="spacer"></span>
            <button class="btn" data-x>取消</button>
            <button class="btn btn-primary" data-act="ok">导入并渲染</button>
          </div>
        </div>
      </div>`);
    document.getElementById('modal-root').appendChild(mask);
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.closest('[data-x]')) { mask.remove(); return; }
      if (e.target.dataset.act === 'reset') {
        store.del('market_custom');
        mask.remove(); load();
        toast('已恢复默认示例', 'ok'); return;
      }
      if (e.target.dataset.act === 'ok') {
        try {
          const raw = $('#imp-json', mask).value.trim();
          if (!raw) return toast('请粘贴 JSON', 'err');
          const obj = JSON.parse(raw);
          const data = obj.pro_data || obj;
          const dt = data.date || obj.date || date;
          if (!data.segments) data.segments = [];
          if (!data.events) data.events = [];
          store.set('market_custom', { date: dt, data });
          date = dt;
          mask.remove();
          load();
          toast('已导入：' + dt, 'ok');
        } catch (err) {
          toast('JSON 解析失败：' + err.message, 'err');
        }
      }
    });
  }

  /* 异步加载真实数据：先取日期清单，再决定默认日期并渲染 */
  (async () => {
    await loadDates();
    REPORT_DATES = new Set(getReportDatesSync());
    LATEST_DATE = [...REPORT_DATES].sort().pop() || LATEST_DATE;
    if (!REPORT_DATES.has(date)) date = LATEST_DATE;
    await load();
  })();

  return () => {
    window.removeEventListener('resize', onWinResize);
    if (calDocClick) { document.removeEventListener('click', calDocClick); calDocClick = null; }
    if (calDocKey) { document.removeEventListener('keydown', calDocKey); calDocKey = null; }
    try { disposeMarketChart(); } catch (e) {}
  };
}
