/* ============================================================
   app.js — 路由 / 导航 / 启动
   ============================================================ */
import { $, $$, el, store, toast, esc } from './core.js';
import { replayPage, livePage, journalPage } from './pages-trade.js';
import { statsPage, rankPage } from './pages-stats.js';
import { videosPage, booksPage, qaPage, homePage, vipPage } from './pages-content.js';
import { marketPage } from './pages-market.js';

const NAV = [
  { k: 'home', n: '首页', f: homePage },
  { k: 'journal', n: '交易日志', f: journalPage },
  { k: 'stats', n: '数据统计', f: statsPage },
  { k: 'rank', n: '排行榜', f: rankPage },
  { k: 'replay', n: '回放复盘', f: replayPage },
  { k: 'live', n: '实时分析', f: livePage },
  { k: 'market', n: '市场报告', f: marketPage },
  { k: 'videos', n: '视频频道', f: videosPage },
  { k: 'qa', n: '互动答疑', f: qaPage },
  { k: 'vip', n: 'VIP专区', f: vipPage }
];

let cleanup = null;
const view = $('#view');

/* ---------------- 导航 ---------------- */
function renderNav(cur) {
  $('#nav').innerHTML = NAV.map(x =>
    `<a href="#/${x.k}" class="${x.k === cur ? 'on' : ''}">${x.n}</a>`).join('');
}

/* ---------------- 路由 ---------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  const params = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => params[k] = v);
  return { key: path.split('/')[0] || 'home', params };
}

function route() {
  const { key, params } = parseHash();
  const page = NAV.find(x => x.k === key) || NAV[0];

  try { cleanup?.(); } catch { }
  cleanup = null;
  view.className = 'view';
  view.innerHTML = '';

  renderNav(page.k);
  document.title = `${page.n} · 爱老虎油`;

  try {
    cleanup = page.f({ mount: view, params }) || null;
  } catch (e) {
    console.error(e, e.stack);
    view.innerHTML = `<div class="center-empty">
      页面渲染出错<br><span class="fs11">${esc(e.message)}</span></div>`;
  }
}

window.addEventListener('hashchange', route);

/* ---------------- 顶栏 ---------------- */
function initTopbar() {
  const logged = store.get('logged', true);

  $('#user-box').style.display = logged ? '' : 'none';
  $('#btn-wechat').style.display = logged ? '' : 'none';
  const ab = $('#btn-auth');
  ab.textContent = logged ? '退出' : '登录';
  ab.onclick = () => {
    if (store.get('logged', true)) {
      store.set('logged', false);
      toast('已退出登录');
      location.reload();
    } else {
      showAuth();
    }
  };

  $('#btn-wechat').onclick = () => {
    const mask = el(`
      <div class="mask" data-close>
        <div class="modal" style="max-width:340px">
          <div class="modal-h"><h3>微信搜一搜</h3><button class="x" data-x>×</button></div>
          <div class="modal-b" style="text-align:center">
            <div style="font-size:44px;margin:8px 0">🪙</div>
            <div style="font-weight:600;margin-bottom:5px">爱老虎油</div>
            <div class="fs12 dim" style="line-height:1.7">
              打开微信 → 搜索「爱老虎油」<br>获取每日复盘推送与培训通知
            </div>
          </div>
        </div>
      </div>`);
    document.getElementById('modal-root').appendChild(mask);
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.closest('[data-x]')) mask.remove();
    });
  };
}

function showAuth() {
  const mask = el(`
    <div class="mask" data-close>
      <div class="modal">
        <div class="modal-h">
          <h3>注册 爱老虎油</h3><button class="x" data-x>×</button>
        </div>
        <div class="modal-b">
          <div class="tabs mb12" style="width:100%">
            <button class="on" data-tab="reg" style="flex:1">注册</button>
            <button data-tab="login" style="flex:1">登录</button>
          </div>
          <div class="field"><label>邮箱</label><input class="inp" id="em" placeholder="you@example.com"></div>
          <div class="field"><label>密码</label><input class="inp" id="pw" type="password" placeholder="至少 8 位"></div>
          <div class="field" id="cf-wrap"><label>确认密码</label><input class="inp" id="pw2" type="password"></div>
          <div class="field"><label>邀请码（选填）</label><input class="inp" id="inv" placeholder="来自邀请人的邀请码"></div>
          <label class="row" style="cursor:pointer;font-size:12px;color:var(--text-2)">
            <input type="checkbox" id="agree" style="margin-right:7px">我已阅读并同意《服务协议》
          </label>
        </div>
        <div class="modal-f">
          <button class="btn" data-x>取消</button>
          <button class="btn btn-primary" id="ok">创建账号</button>
        </div>
      </div>
    </div>`);
  document.getElementById('modal-root').appendChild(mask);

  let tab = 'reg';
  mask.addEventListener('click', e => {
    if (e.target === mask || e.target.closest('[data-x]')) { mask.remove(); return; }

    const t = e.target.closest('[data-tab]');
    if (t) {
      tab = t.dataset.tab;
      $$('[data-tab]', mask).forEach(b => b.classList.toggle('on', b === t));
      $('#cf-wrap', mask).style.display = tab === 'reg' ? '' : 'none';
      $('#ok', mask).textContent = tab === 'reg' ? '创建账号' : '登录';
      $('.modal-h h3', mask).textContent = (tab === 'reg' ? '注册 ' : '登录 ') + '爱老虎油';
      return;
    }

    if (e.target.id === 'ok') {
      const em = $('#em', mask).value.trim();
      const pw = $('#pw', mask).value;
      if (!em.includes('@')) return toast('请输入有效邮箱', 'err');
      if (pw.length < 8) return toast('密码至少 8 位', 'err');
      if (tab === 'reg') {
        if (pw !== $('#pw2', mask).value) return toast('两次密码不一致', 'err');
        if (!$('#agree', mask).checked) return toast('请先同意服务协议', 'err');
      }
      store.set('logged', true);
      store.set('email', em);
      mask.remove();
      toast(tab === 'reg' ? '注册成功' : '登录成功', 'ok');
      location.reload();
    }
  });
}

/* ---------------- 启动 ---------------- */
initTopbar();
if (!location.hash) location.hash = '#/replay';
route();
