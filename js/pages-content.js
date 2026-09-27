/* ============================================================
   pages-content.js — 视频频道 / 书籍报告 / 互动答疑 / 首页 / VIP专区
   ============================================================ */
import { $, el, esc, money, moneyS, cls, store, toast, genDay, tradingDays, hashStr, mulberry32 } from './core.js';
import { genTrades, BOOKS } from './mock.js';

/* ============================================================
   视频频道
   ============================================================ */
export async function videosPage(ctx) {
  const { mount } = ctx;
  let data = null, cat = 'all', kw = '';

  mount.className = 'view pad';
  mount.innerHTML = `<div class="center-empty">正在读取视频索引…</div>`;

  try {
    const r = await fetch('data/videos.json');
    data = await r.json();
  } catch (e) {
    mount.innerHTML = `<div class="center-empty">
      无法读取 data/videos.json<br><span class="fs11">请通过本地 HTTP 服务访问（不要直接双击 index.html）</span></div>`;
    return;
  }

  function filtered() {
    const k = kw.trim().toLowerCase();
    return data.cats
      .map(c => ({ ...c, items: c.items.filter(v => !k || v.n.toLowerCase().includes(k) || v.f.toLowerCase().includes(k)) }))
      .filter(c => (cat === 'all' || c.id === cat) && c.items.length);
  }

  function render() {
    const list = filtered();
    const shown = list.reduce((s, c) => s + c.items.length, 0);

    mount.innerHTML = `
      <div class="stats">
        <div class="page-head">
          <div>
            <div class="page-title">视频频道</div>
            <div class="page-sub">${data.total} 节系统课程 + 每日复盘 · 已加载 ${shown} 节</div>
          </div>
          <div class="row" style="gap:8px">
            <input class="inp" placeholder="搜索课程…" style="width:180px" value="${esc(kw)}" data-f="kw">
            <select class="inp" data-f="cat" style="width:140px">
              <option value="all"${cat === 'all' ? ' selected' : ''}>全部分类</option>
              ${data.cats.map(c => `<option value="${esc(c.id)}"${cat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="vgrid">
          ${list.map(c => `
            <div class="vcat">
              <div class="vcat-h">${esc(c.name)} <span class="dim">(${c.items.length})</span></div>
              <div class="vlist">
                ${c.items.map(v => `
                  <div class="vitem" data-path="${esc(data.root + '/' + v.p)}" data-n="${esc(v.n)}">
                    <span class="vthumb">▶</span>
                    <div class="vmeta">
                      <div class="vt">${esc(v.n)}</div>
                      <div class="vdim">${(v.mb).toFixed(1)} MB · ${esc(v.ext.toUpperCase())}</div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  mount.addEventListener('click', e => {
    const v = e.target.closest('.vitem');
    if (v) {
      const path = v.dataset.path;
      const n = v.dataset.n;
      const mask = el(`
        <div class="mask" data-close>
          <div class="modal" style="max-width:720px;width:90vw">
            <div class="modal-h"><h3>${esc(n)}</h3><button class="x" data-x>×</button></div>
            <div class="modal-b" style="padding:0">
              <video src="/api/video?path=${encodeURIComponent(path)}" controls style="width:100%;display:block;max-height:70vh;background:#000"></video>
            </div>
          </div>
        </div>`);
      document.getElementById('modal-root').appendChild(mask);
      mask.addEventListener('click', ev => { if (ev.target === mask || ev.target.closest('[data-x]')) mask.remove(); });
      return;
    }
  });

  mount.addEventListener('input', e => {
    const f = e.target.dataset.f;
    if (f === 'kw') { kw = e.target.value; render(); }
  });
  mount.addEventListener('change', e => {
    const f = e.target.dataset.f;
    if (f === 'cat') { cat = e.target.value; render(); }
  });

  render();
}

/* ============================================================
   书籍报告
   ============================================================ */
export function booksPage(ctx) {
  const { mount } = ctx;
  let cur = null;

  function render() {
    if (cur) {
      mount.className = 'view';
      mount.innerHTML = `
        <div class="page" style="height:100%">
          <div class="tv-bar">
            <button class="rbtn" data-act="back">‹</button>
            <b class="fs14">${esc(cur.title)}</b>
            <span class="badge">${cur.pages} 页</span>
            <span class="spacer"></span>
            <a class="btn btn-sm" href="/api/pdf?path=${encodeURIComponent(cur.path)}" target="_blank">在系统阅读器中打开</a>
          </div>
          <div style="flex:1;min-height:0">
            <iframe class="pdf-view" src="/api/pdf?path=${encodeURIComponent(cur.path)}"></iframe>
          </div>
        </div>`;
      return;
    }

    mount.className = 'view pad';
    mount.innerHTML = `
      <div class="stats">
        <div class="page-head">
          <div>
            <div class="page-title">书籍报告</div>
            <div class="page-sub">培训指引、交易计划与出版教材 · 共 ${BOOKS.length} 份</div>
          </div>
        </div>
        <div class="bgrid">
          ${BOOKS.map(b => `
            <div class="bcard" data-id="${b.id}">
              <div class="bcover"><span class="bt">${esc(b.title)}</span></div>
              <div class="bn">${esc(b.title)}</div>
              <div class="bm">${esc(b.sub)} · ${b.pages} 页</div>
              <div class="bm" style="line-height:1.6;margin-top:5px">${esc(b.desc)}</div>
              <div class="mt8"><span class="badge gold">${esc(b.tag)}</span></div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  mount.addEventListener('click', e => {
    if (e.target.closest('[data-act=back]')) { cur = null; render(); return; }
    const b = e.target.closest('.bcard');
    if (b) { cur = BOOKS.find(x => x.id === b.dataset.id); render(); }
  });

  render();
}

/* ============================================================
   互动答疑（接入抓取数据 + 图片灯箱）
   ============================================================ */
export async function qaPage(ctx) {
  const { mount } = ctx;
  let list = [], kw = '', tag = 'all', busy = true;

  mount.className = 'view pad';
  mount.innerHTML = `<div class="center-empty">正在加载问答数据…</div>`;

  try {
    const r = await fetch('data/qa_export/threads.json');
    list = await r.json();
  } catch (e) {
    /* fallback mock */
    const { genQA } = await import('./mock.js');
    list = genQA();
  }
  busy = false;

  function filtered() {
    const k = kw.trim().toLowerCase();
    return list.filter(q => {
      if (tag !== 'all' && !(q.tags || []).includes(tag)) return false;
      if (!k) return true;
      return (q.title || '').toLowerCase().includes(k) || (q.body || '').toLowerCase().includes(k);
    });
  }

  const tags = Array.from(new Set(list.flatMap(q => q.tags || [])));

  function render() {
    const qs = filtered();
    mount.innerHTML = `
      <div class="stats">
        <div class="page-head">
          <div>
            <div class="page-title">互动答疑</div>
            <div class="page-sub">提问、讨论、讲师答疑 · 共 ${list.length} 条</div>
          </div>
          <div class="row" style="gap:8px">
            <input class="inp" placeholder="搜索问题…" style="width:180px" value="${esc(kw)}" data-f="kw">
            <select class="inp" data-f="tag" style="width:120px">
              <option value="all"${tag === 'all' ? ' selected' : ''}>全部标签</option>
              ${tags.map(t => `<option value="${esc(t)}"${tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${busy ? '<div class="center-empty">加载中…</div>' : ''}
        <div class="qalist">
          ${qs.map(q => `
            <div class="qacard" data-id="${q.id}">
              <div class="qatop">
                <span class="badge ${q.replies ? 'up' : ''}">${q.replies || 0} 回复</span>
                <span class="dim fs11">${esc(q.author || '匿名')} · ${esc(q.time || '')}</span>
                ${(q.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}
              </div>
              <div class="qatitle">${esc(q.title)}</div>
              <div class="qabody">${esc(q.body || '').slice(0, 160)}${(q.body || '').length > 160 ? '…' : ''}</div>
            </div>`).join('')}
          ${!qs.length ? '<div class="center-empty">没有找到匹配的问题</div>' : ''}
        </div>
      </div>`;
  }

  mount.addEventListener('input', e => { if (e.target.dataset.f === 'kw') { kw = e.target.value; render(); } });
  mount.addEventListener('change', e => { if (e.target.dataset.f === 'tag') { tag = e.target.value; render(); } });

  render();
}

/* ============================================================
   首页
   ============================================================ */
export function homePage(ctx) {
  const { mount } = ctx;
  const days = tradingDays(45);
  const today = days[days.length - 1];
  const tds = days.slice(-7);

  function statCard(n, v, sub, c = '') {
    return `<div class="kpi"><div class="k">${n}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`;
  }

  mount.className = 'view pad';
  mount.innerHTML = `
    <div class="home">
      <div class="hero">
        <div class="hero-t">爱老虎油</div>
        <div class="hero-s">专注一种策略，交易一个标的 · QQQ 1 分钟日内交易训练营</div>
        <div class="hero-a">
          <a class="btn btn-primary" href="#/replay">回放复盘</a>
          <a class="btn" href="#journal">交易日志</a>
        </div>
      </div>

      <div class="sec">
        <div class="sec-h">最近 7 个交易日 · 点击日期进入交易日志</div>
        <div class="week">
          ${tds.map(d => `
            <div class="day" data-date="${d}">
              <div class="dd">${d.slice(8)}</div>
              <div class="dm">${d.slice(5, 7)}月</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="sec">
        <div class="sec-h">今日概况 · ${today}</div>
        <div class="kpi-grid">
          ${statCard('标的', 'QQQ', '纳斯达克 100 ETF')}
          ${statCard('周期', '1 分钟', '日内交易')}
          ${statCard('训练日', String(days.length), '已覆盖交易日')}
          ${statCard('状态', '可复盘', '真实 Yahoo 行情已同步', 'up')}
        </div>
      </div>

      <div class="sec">
        <div class="sec-h">核心功能</div>
        <div class="feat-grid">
          ${[
            ['🎬', '回放复盘', '逐根 K 线回放历史行情，毫秒级练习入场与出场，含模拟下单。', '#/replay'],
            ['📈', '实时分析', '盘中以 1 分钟 K 线跟踪 QQQ，配合模拟盘验证判断。', '#/live'],
            ['📔', '交易日志', '记录每笔交易的价格、数量、R 倍数与三段心态复盘。', '#/journal'],
            ['📊', '数据统计', '盈亏曲线、周统计、R 分布与标签分析，量化你的执行。', '#/stats'],
            ['🏆', '排行榜', '与同期学员同场竞技，查看人气入场点与常见问题。', '#/rank'],
            ['🎥', '视频频道', '180 节系统课程 + 每日复盘，从基础到稳定盈利。', '#/videos'],
            ['📚', '书籍报告', '培训指引、交易计划与出版教材，随时查阅。', '#/books'],
            ['💬', '互动答疑', '提问、讨论、讲师答疑，问题不过夜。', '#/qa']
          ].map(([ic, t, d, href]) => `
            <div class="feat" onclick="location.hash='${href}'">
              <div class="ic">${ic}</div>
              <div class="t">${t}</div>
              <div class="d">${d}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="sec" style="padding-bottom:60px">
        <div class="card" style="padding:22px;text-align:center">
          <div style="font-size:16px;font-weight:600;margin-bottom:7px">专业交易员是怎么变专业的？</div>
          <div style="color:var(--dim);font-size:13px;margin-bottom:15px">
            答案只有两个字：复盘。用一根一根的 K 线，反复训练你的眼睛和手。
          </div>
          <a class="btn btn-primary" href="#/replay">立即开始逐根复盘</a>
        </div>
      </div>
    </div>`;

  mount.addEventListener('click', e => {
    const day = e.target.closest('.day');
    if (day && day.dataset.date) location.hash = `#/journal?date=${day.dataset.date}`;
  });
}

/* ============================================================
   VIP专区
   ============================================================ */
export function vipPage(ctx) {
  const { mount } = ctx;
  mount.className = 'view pad';
  mount.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">VIP 专区</div>
          <div class="page-sub">LV · T700 专业版会员专享内容</div>
        </div>
      </div>
      <div class="center-empty" style="height:360px">
        正在接入会员专享内容…<br>
        <span class="fs11">请通过 rijindoudoujin.com 账号同步解锁高阶课程与每日私域复盘</span>
      </div>
    </div>`;
}
