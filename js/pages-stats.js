/* ============================================================
   pages-stats.js — 数据统计 / 排行榜
   ============================================================ */
import {
  $, el, esc, money, moneyS, px, rs, cls, store, toast,
  genDay, tradingDays, parseDate, fmtDate, mulberry32, hashStr, barTime
} from './core.js';
import { Chart } from './chart.js';
import { genTrades, daySummary, genLeaderboard } from './mock.js';

/* ============================================================
   迷你图（纯 SVG）
   ============================================================ */
function lineChart(series, w, h, opt = {}) {
  const pad = opt.pad ?? { l: 8, r: 8, t: 8, b: 8 };
  const vals = series.map(p => p.v);
  let hi = Math.max(...vals, 0), lo = Math.min(...vals, 0);
  const span = (hi - lo) || 1;
  hi += span * .1; lo -= span * .1;
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const X = i => pad.l + (series.length < 2 ? iw / 2 : i / (series.length - 1) * iw);
  const Y = v => pad.t + ih - (v - lo) / (hi - lo) * ih;

  const zeroY = Y(0);
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  const area = `${pad.l},${zeroY} ${pts} ${pad.l + iw},${zeroY}`;
  const last = series[series.length - 1]?.v ?? 0;
  const col = last >= 0 ? '#26a69a' : '#ef5350';

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
    <defs><linearGradient id="lg${opt.id || ''}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity=".28"/>
      <stop offset="1" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${pad.l}" y1="${zeroY}" x2="${w - pad.r}" y2="${zeroY}" stroke="#2e3547" stroke-width="1"/>
    <polygon points="${area}" fill="url(#lg${opt.id || ''})"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}

function barChart(series, w, h, opt = {}) {
  const pad = { l: 8, r: 8, t: 6, b: 6 };
  const vals = series.map(p => p.v);
  const hi = Math.max(...vals, 0), lo = Math.min(...vals, 0);
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const bw = Math.max(1, iw / series.length * .72);
  const step = iw / series.length;
  const Y = v => pad.t + ih - (v - lo) / ((hi - lo) || 1) * ih;
  const zero = Y(0);

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
    <line x1="${pad.l}" y1="${zero}" x2="${w - pad.r}" y2="${zero}" stroke="#2e3547"/>
    ${series.map((p, i) => {
    const y = Y(p.v), top = Math.min(y, zero), hh = Math.max(1, Math.abs(zero - y));
    return `<rect x="${(pad.l + i * step + (step - bw) / 2).toFixed(1)}" y="${top.toFixed(1)}"
        width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="1.5"
        fill="${p.v >= 0 ? '#26a69a' : '#ef5350'}" opacity=".85"/>`;
  }).join('')}
  </svg>`;
}

function scatter(pts, w, h) {
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const ys = pts.map(p => p.y);
  const hi = Math.max(...ys, 1), lo = Math.min(...ys, -1);
  const X = i => pad.l + (pts.length < 2 ? iw / 2 : i / (pts.length - 1) * iw);
  const Y = v => pad.t + ih - (v - lo) / ((hi - lo) || 1) * ih;
  const zero = Y(0);

  const ticks = [lo, (lo + hi) / 2, hi];

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
    ${ticks.map(t => `<line x1="${pad.l}" y1="${Y(t)}" x2="${w - pad.r}" y2="${Y(t)}" stroke="#1c2333"/>
      <text x="${pad.l - 5}" y="${Y(t) + 3.5}" fill="#7c869a" font-size="9.5" text-anchor="end"
        font-family="ui-monospace,monospace">${t.toFixed(1)}R</text>`).join('')}
    <line x1="${pad.l}" y1="${zero}" x2="${w - pad.r}" y2="${zero}" stroke="#3a4256"/>
    ${pts.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.4"
      fill="${p.y >= 0 ? '#26a69a' : '#ef5350'}" opacity=".8"/>`).join('')}
    <text x="${pad.l}" y="${h - 6}" fill="#7c869a" font-size="9.5">第 1 单</text>
    <text x="${w - pad.r}" y="${h - 6}" fill="#7c869a" font-size="9.5" text-anchor="end">最近</text>
  </svg>`;
}

/* ============================================================
   数据统计
   ============================================================ */
export function statsPage(ctx) {
  const { mount } = ctx;
  const days = tradingDays(90);
  const all = days.map(d => ({ d, trades: genTrades(d) }));
  const withTrade = all.filter(x => x.trades.length);

  /* --- KPI --- */
  const allTrades = withTrade.flatMap(x => x.trades);
  const total = allTrades.reduce((s, t) => s + t.pnl, 0);
  const totalR = allTrades.reduce((s, t) => s + t.r, 0);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const rate = allTrades.length ? wins / allTrades.length * 100 : 0;
  const avgWin = wins ? allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const losses = allTrades.length - wins;
  const avgLoss = losses ? Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / losses) : 0;
  const pf = avgLoss ? avgWin / avgLoss : 0;
  const greenDays = withTrade.filter(x => x.trades.reduce((s, t) => s + t.pnl, 0) > 0).length;

  /* --- 本月每日盈亏 --- */
  const month = days.filter(d => d.startsWith('2026-09') || d.startsWith(days[days.length - 1].slice(0, 7)));
  const mSeries = month.map(d => {
    const x = all.find(a => a.d === d);
    return { d, v: x ? x.trades.reduce((s, t) => s + t.pnl, 0) : 0 };
  });
  let cum = 0;
  const cumSeries = mSeries.map(p => ({ d: p.d, v: (cum += p.v) }));

  /* --- 周统计 --- */
  const weeks = [];
  for (let i = 0; i < withTrade.length; i += 5) {
    const chunk = withTrade.slice(i, i + 5);
    const ts = chunk.flatMap(x => x.trades);
    if (!ts.length) continue;
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    const w = ts.filter(t => t.pnl > 0).length;
    const aw = w ? ts.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / w : 0;
    const al = ts.length - w ? Math.abs(ts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / (ts.length - w)) : 0;
    let streak = 0, cur = 0;
    for (const t of ts) { if (t.pnl > 0) { cur++; streak = Math.max(streak, cur); } else cur = 0; }
    weeks.push({
      name: `第 ${weeks.length + 1} 周`,
      range: chunk[0].d.slice(5) + ' ~ ' + chunk[chunk.length - 1].d.slice(5),
      pnl, rate: w / ts.length * 100, pf: al ? aw / al : 0,
      avg: pnl / ts.length, streak,
      best: Math.max(...ts.map(t => t.pnl)),
      bestDay: Math.max(...chunk.map(x => x.trades.reduce((s, t) => s + t.pnl, 0))),
      greenPct: chunk.filter(x => x.trades.reduce((s, t) => s + t.pnl, 0) > 0).length / chunk.length * 100,
      cnt: ts.length
    });
  }

  /* --- R 分布 --- */
  const rPts = allTrades.slice(-240).map((t, i) => ({ x: i, y: t.r }));

  /* --- 盈亏区间 --- */
  const buckets = [
    { n: '< -2R', test: v => v < -2 },
    { n: '-2R ~ -1R', test: v => v >= -2 && v < -1 },
    { n: '-1R ~ 0', test: v => v >= -1 && v < 0 },
    { n: '0 ~ 1R', test: v => v >= 0 && v < 1 },
    { n: '1R ~ 2R', test: v => v >= 1 && v < 2 },
    { n: '2R ~ 3R', test: v => v >= 2 && v < 3 },
    { n: '> 3R', test: v => v >= 3 }
  ].map(b => ({ n: b.n, c: allTrades.filter(t => b.test(t.r)).length }));
  const bmax = Math.max(...buckets.map(b => b.c), 1);

  /* --- 标签统计 --- */
  const tagMap = new Map();
  for (const t of allTrades) for (const g of (t.tags || [])) tagMap.set(g, (tagMap.get(g) || 0) + 1);
  const tagStat = [...tagMap.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 14);
  const tmax = Math.max(...tagStat.map(t => t.n), 1);

  mount.className = 'view pad';
  mount.innerHTML = `
    <div class="stats">
      <div class="page-head">
        <div>
          <div class="page-title">数据统计</div>
          <div class="page-sub">近 ${days.length} 个交易日 · ${allTrades.length} 笔交易</div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-sm" onclick="location.reload()">刷新</button>
      </div>

      <div class="kpis">
        <div class="kpi"><div class="k">累计净盈亏</div><div class="v ${cls(total)}">${moneyS(total)}</div><div class="s">${rs(totalR)} 累计</div></div>
        <div class="kpi"><div class="k">胜率</div><div class="v">${rate.toFixed(1)}%</div><div class="s">${wins} 胜 / ${losses} 负</div></div>
        <div class="kpi"><div class="k">盈亏比</div><div class="v">${pf.toFixed(2)}</div><div class="s">均盈 ${money(avgWin)} / 均亏 ${money(avgLoss)}</div></div>
        <div class="kpi"><div class="k">平均单笔</div><div class="v ${cls(total / (allTrades.length || 1))}">${moneyS(total / (allTrades.length || 1))}</div><div class="s">共 ${allTrades.length} 笔</div></div>
        <div class="kpi"><div class="k">盈利天数占比</div><div class="v">${(greenDays / (withTrade.length || 1) * 100).toFixed(0)}%</div><div class="s">${greenDays} / ${withTrade.length} 天</div></div>
        <div class="kpi"><div class="k">最大连胜</div><div class="v up">${Math.max(...weeks.map(w => w.streak), 0)}</div><div class="s">单周统计</div></div>
      </div>

      <!-- 实战交易记录 月历 -->
      <div class="card mb12">
        <div class="card-h"><h3>实战交易记录</h3><span class="fs11 dim">点击某天跳转交易日志</span></div>
        <div class="card-b" id="calbox"></div>
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card">
          <div class="card-h"><h3>每日盈亏 · 本月</h3><span class="fs11 dim">柱=当日 线=累计</span></div>
          <div class="card-b">
            ${barChart(mSeries, 560, 110)}
            <div class="mt8">${lineChart(cumSeries, 560, 90, { id: 'cum' })}</div>
            <div class="row mt8 fs11 dim">
              <span>起始 ${mSeries[0]?.d.slice(5)}</span><span class="spacer"></span>
              <span>累计 <b class="${cls(cumSeries[cumSeries.length - 1]?.v)} num">${moneyS(cumSeries[cumSeries.length - 1]?.v || 0)}</b></span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>近 ${Math.min(240, allTrades.length)} 单收益 R 分布 · 本年</h3></div>
          <div class="card-b">${scatter(rPts, 560, 210)}</div>
        </div>
      </div>

      <div class="grid mt12" style="grid-template-columns:1fr 1fr">
        <div class="card">
          <div class="card-h"><h3>盈亏区间分布</h3></div>
          <div class="card-b tight">
            <table>
              <thead><tr><th>盈亏区间</th><th class="num">发生次数</th><th style="width:44%">占比</th></tr></thead>
              <tbody>
                ${buckets.map(b => `
                  <tr>
                    <td class="num">${b.n}</td>
                    <td class="num">${b.c}</td>
                    <td><div class="bar-h"><i style="width:${b.c / bmax * 100}%;background:${b.n.startsWith('<') || b.n.startsWith('-') ? '#ef5350' : '#26a69a'}"></i></div></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>标签统计 · 全部</h3></div>
          <div class="card-b tight" style="max-height:266px;overflow:auto">
            <table>
              <thead><tr><th>标签</th><th class="num">次数</th><th style="width:44%">频次</th></tr></thead>
              <tbody>
                ${tagStat.map(t => `
                  <tr>
                    <td><span class="chip">${esc(t.name)}</span></td>
                    <td class="num">${t.n}</td>
                    <td><div class="bar-h"><i style="width:${t.n / tmax * 100}%;background:#f0b429"></i></div></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card mt12">
        <div class="card-h"><h3>周统计</h3><span class="fs11 dim">每 5 个交易日为一周</span></div>
        <div class="card-b tight" style="overflow:auto">
          <table>
            <thead><tr>
              <th>周</th><th>区间</th><th class="num">累计盈利</th><th class="num">胜率</th>
              <th class="num">盈亏比</th><th class="num">平均单笔</th><th class="num">最大连胜</th>
              <th class="num">单笔最高</th><th class="num">单日最高</th><th class="num">盈利天数</th><th class="num">笔数</th>
            </tr></thead>
            <tbody>
              ${weeks.map(w => `
                <tr>
                  <td>${w.name}</td>
                  <td class="dim num">${w.range}</td>
                  <td class="num ${cls(w.pnl)}">${moneyS(w.pnl)}</td>
                  <td class="num">${w.rate.toFixed(0)}%</td>
                  <td class="num">${w.pf.toFixed(2)}</td>
                  <td class="num ${cls(w.avg)}">${moneyS(w.avg)}</td>
                  <td class="num">${w.streak}</td>
                  <td class="num up">${money(w.best)}</td>
                  <td class="num up">${money(w.bestDay)}</td>
                  <td class="num">${w.greenPct.toFixed(0)}%</td>
                  <td class="num dim">${w.cnt}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  /* 月历 */
  renderCal(all, $('#calbox', mount));

  mount.addEventListener('click', e => {
    const day = e.target.closest('.day');
    if (day && day.dataset.date) location.hash = `#/journal?date=${day.dataset.date}`;
  });
}

function renderCal(all, box) {
  if (!box) return;
  const byDate = new Map(all.map(x => [x.d, x.trades]));
  const months = [...new Set(all.map(x => x.d.slice(0, 7)))].slice(-2);

  box.innerHTML = months.map(m => {
    const [y, mo] = m.split('-').map(Number);
    const first = new Date(y, mo - 1, 1);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const pad = first.getDay();

    let cells = '';
    for (let i = 0; i < pad; i++) cells += '<td><div class="day empty"></div></td>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${m}-${String(d).padStart(2, '0')}`;
      const trades = byDate.get(ds);
      const wd = new Date(y, mo - 1, d).getDay();
      if (wd === 0 || wd === 6 || !trades) {
        cells += `<td><div class="day ${trades ? '' : 'pad'}"><span class="d">${d}</span></div></td>`;
        continue;
      }
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      cells += `<td><div class="day ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}" data-date="${ds}" title="${ds}  ${moneyS(pnl)}">
        <span class="d">${d}</span><span class="p">${pnl > 0 ? '+' : ''}${(pnl / 1000).toFixed(1)}k</span></div></td>`;
      if (wd === 6) cells += '</tr><tr>';
    }
    const monthPnl = all.filter(x => x.d.startsWith(m))
      .reduce((s, x) => s + x.trades.reduce((a, t) => a + t.pnl, 0), 0);

    return `
      <div class="mb12">
        <div class="row mb8">
          <b class="fs14">${y} 年 ${mo} 月</b>
          <span class="spacer"></span>
          <span class="fs12 dim">月度盈亏</span>
          <b class="num ${cls(monthPnl)} fs14">${moneyS(monthPnl)}</b>
        </div>
        <table class="cal">
          <thead><tr>${['日', '一', '二', '三', '四', '五', '六'].map(w => `<th>${w}</th>`).join('')}</tr></thead>
          <tbody><tr>${cells}</tr></tbody>
        </table>
      </div>`;
  }).join('');
}

/* ============================================================
   排行榜
   ============================================================ */
export function rankPage(ctx) {
  const { mount } = ctx;
  let date = ctx.params.date || '2026-08-28';
  let mode = ctx.params.mode || 'day';
  let chart = null, chart2 = null;

  function render() {
    chart?.destroy(); chart2?.destroy();
    const data = genLeaderboard(date, mode);
    const day = genDay(date);

    mount.className = 'view pad';
    mount.innerHTML = `
      <div class="stats">
        <div class="page-head">
          <div>
            <div class="page-title">排行榜 <span class="badge gold">线上培训 · 第 1 期</span></div>
            <div class="page-sub">当日收益榜 ${date} · 提交 ${data.submitted}/${data.total}</div>
          </div>
          <span class="spacer"></span>
          <div class="tabs">
            ${[['day', '日榜'], ['month', '月榜'], ['all', '月榜(总)']].map(([k, n]) =>
      `<button data-mode="${k}" class="${mode === k ? 'on' : ''}">${n}</button>`).join('')}
          </div>
          <input type="date" class="inp inp-sm" style="width:132px" value="${date}">
        </div>

        <div class="grid" style="grid-template-columns:320px 1fr">
          <div class="card" style="align-self:start">
            <div class="card-h"><h3>${mode === 'day' ? '当日' : '本期'}收益榜</h3><span class="fs11 dim">按 R 排序</span></div>
            <div class="card-b tight" id="rlist"></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="card">
              <div class="card-h"><h3>全员入场 / 出场分布</h3><span class="fs11 dim">蓝=入场 紫=出场</span></div>
              <div class="card-b tight" style="height:330px"><div id="rchart" style="height:100%"></div></div>
            </div>

            <div class="grid" style="grid-template-columns:1fr 1fr">
              <div class="card">
                <div class="card-h"><h3>当天榜单统计</h3><span class="fs11 dim">问题标签频次</span></div>
                <div class="card-b tight" style="max-height:260px;overflow:auto">
                  <table>
                    <tbody>
                      ${data.tagStat.map(t => `
                        <tr><td><span class="chip">${esc(t.name)}</span></td>
                        <td class="num">${t.n} 人</td>
                        <td style="width:40%"><div class="bar-h"><i style="width:${t.n / (data.tagStat[0]?.n || 1) * 100}%;background:#f0b429"></i></div></td></tr>`).join('')
        || '<tr><td class="dim">暂无统计</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>

              <div class="card">
                <div class="card-h"><h3>人气入场点 Top 5</h3></div>
                <div class="card-b tight">
                  <table>
                    <thead><tr><th>#</th><th>时间</th><th class="num">价位</th><th class="num">人数</th></tr></thead>
                    <tbody>
                      ${data.hot.map((h, i) => `
                        <tr><td><b class="gold">${i + 1}</b></td>
                        <td class="num">${barTime(h.i)}</td>
                        <td class="num">${px(h.price)}</td>
                        <td class="num"><span class="badge gold">${h.n} 人</span></td></tr>`).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    /* 榜单 */
    $('#rlist', mount).innerHTML = data.list.map((t, i) => `
      <div class="rank-row ${i < 3 ? 'top' + (i + 1) : ''}" data-name="${esc(t.name)}">
        <span class="rank-no">${i + 1}</span>
        <div class="rank-name">
          <div class="n">${esc(t.name)}</div>
          <div class="m">${t.legs.map(l =>
      `${barTime(l.i1)}~${barTime(l.i2)} <span class="${l.r >= 0 ? 'up' : 'down'}">${rs(l.r)}</span>`).join(' · ')}</div>
          ${t.tags.length ? `<div class="mt8 flex-wrap">${t.tags.map(g => `<span class="chip" style="font-size:10.5px">${esc(g)}</span>`).join('')}</div>` : ''}
        </div>
        <span class="rank-r ${cls(t.r)}">${rs(t.r)}</span>
      </div>`).join('');

    /* 图表：叠加所有人标记 */
    const host = $('#rchart', mount);
    chart = new Chart(host);
    chart.setBars(day.bars);
    chart.setReveal(day.bars.length);
    const mk = [];
    for (const t of data.list) for (const l of t.legs) {
      mk.push({ i: l.i1, price: l.p1, type: 'entry' });
      mk.push({ i: l.i2, price: l.p2, type: 'exit' });
    }
    chart.setMarkers(mk);
  }

  mount.addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (b) { mode = b.dataset.mode; render(); }
  });
  mount.addEventListener('change', e => {
    if (e.target.type === 'date') { date = e.target.value; render(); }
  });

  render();
  return () => { chart?.destroy(); chart2?.destroy(); };
}
