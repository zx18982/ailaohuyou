/* ============================================================
   mock.js — 演示数据（交易日志 / 排行榜 / 答疑 / 报告 / 市场报告）
   全部由种子伪随机生成，保证每次刷新一致
   ============================================================ */
import { mulberry32, hashStr, genDay, barTime, pick, ema, vwap } from './core.js';

/* ---------------- 交易日志 ---------------- */
export const TAGS = ['入场', '仓位管理', '心态', '整体单笔交易评价', '客观问题'];
export const TAG_DETAIL = {
  '入场': ['入场过晚', '入场过早', '入场犹豫', '计划外入场', '入场点位不理想', '入场信心不足'],
  '仓位管理': ['仓位偏满', '仓位偏轻', '止盈过小', '止盈过大', '止损过宽', '未及时挪止损'],
  '心态': ['FOMO', '害怕亏损', '拿不住', '急于翻本', '过度交易', '耐心不足'],
  '整体单笔交易评价': ['符合计划', '执行到位', '虽有盈利但执行差', '明显失误', '可接受'],
  '客观问题': ['盘整无机会', '假突破', '流动性不足', '滑点过大', '行情突变']
};

/** 生成某日交易记录 */
export function genTrades(dateStr) {
  const rnd = mulberry32(hashStr('T' + dateStr));
  const day = genDay(dateStr);
  const n = Math.floor(rnd() * 4);            // 0–3 笔
  const out = [];
  for (let k = 0; k < n; k++) {
    const side = rnd() < 0.62 ? 'long' : 'short';
    const entryIdx = 8 + Math.floor(rnd() * 250);
    const hold = 6 + Math.floor(rnd() * 45);
    const exitIdx = Math.min(389, entryIdx + hold);
    const ep = day.bars[entryIdx].c;
    const xp = day.bars[exitIdx].c;
    const qty = pick([50, 100, 100, 150, 200, 300]);
    const pnl = (side === 'long' ? xp - ep : ep - xp) * qty;
    /* R：以固定风险 1R = $300 折算，取整到 0.01 */
    const r = Math.round(pnl / 300 * 100) / 100;

    const cats = [];
    const pool = [...TAGS];
    const cnt = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < cnt && pool.length; i++) cats.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    const tags = cats.map(c => pick(TAG_DETAIL[c]));

    out.push({
      id: 'T' + (k + 1),
      side,
      entryTime: barTime(entryIdx), exitTime: barTime(exitIdx),
      entryIdx, exitIdx,
      entryPrice: ep, exitPrice: xp,
      qty, pnl, r,
      cats, tags,
      note1: pick([
        '开盘冲高后回踩 VWAP 企稳，判断多头仍占优，选择在回踩位入场。',
        '关键位附近出现放量长下影，认为支撑有效，按计划入场做多。',
        '趋势明确，价格回撤到 EMA20 附近，顺势跟进。',
        '盘整区间上沿被突破，等待回撤确认后入场。'
      ]),
      note2: pick([
        '持仓初期波动不大，心态平稳，按计划持有。',
        '中途出现一次快速回撤，接近止损位，一度想提前离场，但按纪律持有。',
        '盈利扩大后开始担心回吐，有提前止盈的冲动。',
        '持仓过程中量能萎缩，判断趋势力度不足。'
      ]),
      note3: pick([
        '达到目标位后按计划止盈，整体执行符合预期。',
        '入场偏晚导致盈亏比下降，下次应在确认信号出现时立即执行。',
        '持仓心态不稳导致提前离场，错过了更大行情，需要改进。',
        '止损设置过窄被扫，实际上方向判断正确，应放宽止损。'
      ])
    });
  }
  return out;
}

/** 某日汇总 */
export function daySummary(trades) {
  const win = trades.filter(t => t.pnl > 0).length;
  const loss = trades.filter(t => t.pnl < 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const r = trades.reduce((s, t) => s + t.r, 0);
  return {
    pnl, r, win, loss,
    rate: trades.length ? win / trades.length * 100 : 0,
    count: trades.length,
    best: trades.length ? Math.max(...trades.map(t => t.pnl)) : 0,
    worst: trades.length ? Math.min(...trades.map(t => t.pnl)) : 0
  };
}

/** 生成一段时期内的每日记录（用于统计页与月历） */
export function genJournal(days) {
  const map = {};
  for (const d of days) map[d] = genTrades(d);
  return map;
}

/* ---------------- 排行榜 ---------------- */
const NICKS = ['向光而生', 'Tom', 'Rye', '企鹅', 'Kui', '冯伟', '蓝色的光头', 'PeterLyu',
  '酸辣汤味', 'Derek', '堂堂先生', '老泉', '朝下', 'Pc_oo', '我的新林林', '海风',
  '逆旅', '慢慢来', '知行合一', '小满'];

export const ISSUE_TAGS = ['入场过晚', '入场犹豫', '入场点位不理想', '仓位偏满', '入场信心不足',
  '计划外入场', '止盈过小', '未及时挪止损', '入场和仓位管理都有问题', '信心不足未能入场'];

export function genLeaderboard(dateStr, mode = 'day') {
  const rnd = mulberry32(hashStr('L' + mode + dateStr));
  const day = genDay(dateStr);
  const n = 12;
  const list = [];
  const used = new Set();

  for (let i = 0; i < n; i++) {
    let name;
    do { name = pick(NICKS); } while (used.has(name) && used.size < NICKS.length);
    used.add(name);

    const legs = [];
    let total = 0;
    const nTrades = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < nTrades; k++) {
      const side = rnd() < 0.6 ? 'long' : 'short';
      const i1 = 6 + Math.floor(rnd() * 300);
      const i2 = Math.min(389, i1 + 5 + Math.floor(rnd() * 60));
      const p1 = day.bars[i1].c, p2 = day.bars[i2].c;
      const r = Math.round(((side === 'long' ? p2 - p1 : p1 - p2) * 2.2) * 100) / 100;
      total += r;
      legs.push({ side, i1, i2, p1, p2, r });
    }
    total = Math.round(total * 100) / 100;

    const tags = [];
    const cnt = Math.floor(rnd() * 3);
    for (let k = 0; k < cnt; k++) {
      const t = pick(ISSUE_TAGS);
      if (!tags.includes(t)) tags.push(t);
    }

    list.push({ name, r: total, legs, tags });
  }
  list.sort((a, b) => b.r - a.r);

  /* 人气入场点 Top5 */
  const buckets = new Map();
  for (const t of list) for (const l of t.legs) {
    const key = Math.round(l.i1 / 6) * 6;
    const b = buckets.get(key) || { i: key, n: 0, price: 0, sum: 0 };
    b.n++; b.sum += l.p1; b.price = b.sum / b.n;
    buckets.set(key, b);
  }
  const hot = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 5)
    .map(b => ({ i: b.i, price: b.price, n: b.n }));

  /* 问题标签统计 */
  const tf = new Map();
  for (const t of list) for (const g of t.tags) tf.set(g, (tf.get(g) || 0) + 1);
  const tagStat = [...tf.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);

  return { date: dateStr, mode, list, hot, tagStat, submitted: list.length, total: 16 };
}

/* ---------------- 互动答疑 ---------------- */
const QA_SEED = [
  { t: '关于标普的定位，欢迎大家留言', a: '日进斗斗金', tags: ['QQQ', '置顶'], n: 4, h: 26 },
  { t: '关于加仓与本金大小', a: '蓝色的光头', tags: ['仓位管理'], n: 2, h: 2 },
  { t: '8/28 11:23 的盘口变化', a: 'PeterLyu', tags: ['QQQ'], n: 1, h: 20 },
  { t: '关于日内短线交易的止损问题', a: '酸辣汤味', tags: ['止损'], n: 2, h: 26 },
  { t: '关于交易日志的填写问题', a: 'Derek', tags: ['交易日志'], n: 1, h: 50 },
  { t: '盘整区间内如何避免频繁交易', a: '我的新林林', tags: ['其他标的'], n: 5, h: 50 },
  { t: '08/26 全天复盘观后感', a: '日进斗斗金', tags: ['复盘'], n: 4, h: 50 },
  { t: '关于忽略前高的处理方式', a: '堂堂先生', tags: ['QQQ', '已受理'], n: 7, h: 50 },
  { t: '做 QQQ 加仓时如何切分仓位', a: '老泉', tags: ['QQQ', '仓位管理'], n: 1, h: 50 },
  { t: '关于限价单的深度选择', a: '朝下', tags: ['订单'], n: 1, h: 50 },
  { t: '盘整区间放量突破后回撤怎么处理', a: 'Pc_oo', tags: ['QQQ'], n: 1, h: 74 },
  { t: '模拟盘阶段应该练多久再上实盘', a: '海风', tags: ['心态'], n: 3, h: 74 }
];

const REPLY_SEED = [
  '这个问题我在视频里讲过，核心是先确定趋势方向，再找关键位，最后才是仓位。顺序不能反过来。',
  '建议先在回放里把同样的形态练 20 遍以上，形成肌肉记忆后再上实盘。',
  '止损位应该放在「如果到了这里说明我判断错了」的位置，而不是「我能承受亏多少」的位置。',
  '仓位大小取决于止损距离，先定止损再算股数，这样每笔风险才是可控的。',
  '盘整区间内最好的操作就是不操作，等突破确认后再介入。',
  '交易日志关键在坚持，哪怕当天没交易也要记录为什么没交易。'
];

export function genQA() {
  const rnd = mulberry32(20260904);
  return QA_SEED.map((q, i) => ({
    id: 'Q' + (i + 1),
    title: q.t, author: q.a, tags: q.tags,
    hours: q.h, replies: q.n,
    time: q.h < 24 ? `${q.h}小时前` : `${Math.floor(q.h / 24)}天前`,
    body: pick(REPLY_SEED),
    replyList: Array.from({ length: q.n }, (_, k) => ({
      author: k === 0 && q.a === '日进斗斗金' ? '日进斗斗金' : pick(NICKS),
      admin: k === 0 && q.a === '日进斗斗金',
      text: REPLY_SEED[(i + k) % REPLY_SEED.length],
      time: `${Math.max(1, q.h - k * 3)}小时前`
    }))
  }));
}

/* ---------------- 书籍报告 ---------------- */
export const BOOKS = [
  {
    id: 'b1', title: '网站线上培训交易计划', sub: '2026-09 期',
    desc: '线上培训的完整交易计划：标的、资金、仓位、止盈止损与风险控制规则。',
    pages: 6, date: '2026-09-01', tag: '培训',
    path: '/Users/goodin/学习/日进斗斗金/2026-09培训/网站线上培训交易计划.pdf'
  },
  {
    id: 'b2', title: '网站线上培训前指引', sub: '注册与上手',
    desc: '注册流程、回放复盘使用说明、交易日志填写规范与培训前准备清单。',
    pages: 4, date: '2026-09-01', tag: '指引',
    path: '/Users/goodin/学习/日进斗斗金/2026-09培训/网站线上培训前指引.pdf'
  },
  {
    id: 'b3', title: '股票日内交易入门', sub: '雷行健 · 2023 出版',
    desc: '作者出版的系统性教材，覆盖日内交易基础、策略、仓位管理与交易心理。',
    pages: 328, date: '2023-01-01', tag: '书籍',
    path: '/Users/goodin/学习/日进斗斗金/股票日内交易入门（雷行健）.pdf'
  }
];


/* ============================================================
   市场报告示例数据（贴合 supabase tj_market_analysis.pro_data）
   - 自己生成 bars（与截图同形态），不复刻任何具体文字
   - segments / markers / labels 走同一 schema，便于真实数据导入
   - genDailyReport(date) 给定任意日期生成完整报告（确定性伪随机）
   - REPORT_DATES 列出 2026-05-01 起所有"有数据"的工作日
   ============================================================ */

/** 把 "HH:MM" 转成绝对分钟（用于跨段比较） */
function h2m(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }

/** 把绝对分钟转回 "HH:MM" */
function m2h(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/** 生成某日的 1 分钟 K 线（确定性） */
function genBars(date, seed) {
  const rnd = mulberry32(hashStr('RPT' + seed));
  const N = 391;
  const base = 690 + Math.floor(rnd() * 60);
  let p = base + (rnd() - 0.5) * 3;
  const mood = rnd();
  /* 三种日性格：上行 / 下行 / 盘整 */
  const trendDrift = mood < 0.34 ? (rnd() * 0.018 + 0.005)
    : mood < 0.68 ? -(rnd() * 0.018 + 0.005)
      : (rnd() - 0.5) * 0.012;
  const dayVol = 0.16 + rnd() * 0.2;
  const bars = [];
  for (let i = 0; i < N; i++) {
    const min = 9 * 60 + 30 + i;
    const o = p;
    const shock = (rnd() - 0.5) * 2 - 1;
    const step = trendDrift * (0.5 + 0.5 * Math.sin(i / N * Math.PI * (1 + rnd() * 0.6)));
    const x = i / (N - 1);
    const vShape = 0.55 + 1.25 * Math.exp(-9 * x) + 0.85 * Math.exp(-7 * (1 - x));
    const sigma = dayVol * vShape * 0.06;
    let c = o + step + sigma * shock;
    if (rnd() < 0.012) c += (rnd() - 0.5) * 5;
    const body = Math.abs(c - o);
    const wick = body * (0.3 + rnd() * 1.1) + sigma * 0.4;
    const h = Math.max(o, c) + wick * rnd();
    const l = Math.min(o, c) - wick * rnd();
    const v = Math.round((0.5 + vShape * (0.6 + rnd() * 1.4)) * 46000 * (1 + body * 1.6));
    bars.push({ t: m2h(min), o, h, l, c, v });
    p = c;
  }
  return bars;
}

/** 段模板池（用模板拼段，避免自然语言完全重复） */
const SEG_TEMPLATES = {
  bull: [
    '开盘后第一根 5 分钟 K 线收阳且量能温和，确认当日多头基调。{N} 出现回踩 EMA20 缩量企稳的入场信号，{N1} 完成第一次入场，仓位按计划 30%。{N2} 价格冲高至前高附近，K 线出现长上影，提示上方有阻力；{N3} 放量跌破 EMA20 触发第一次止损出场，亏损控制在 1R 以内。{N4} 二次回踩在 VWAP 附近出现多方炮形态，{N5} 出现第二次入场信号并完成加仓至 60%。随后价格沿 EMA20 上行，{N6} 出现顶部反转信号且量能放大，{N7} 价格跌破分时均线，全部仓位止盈离场，本段实现 +1.6R。',
    '本段价格在 EMA20 附近窄幅震荡，多空力量暂时均衡，未出现符合计划的入场信号，因此保持空仓观望。{N} 出现一根长下影探底 K 线，{N1} 出现长上影 K 线，构成疑似反转形态但未确认；{N2} 之后价格重心略微下移，{N3} 跌破段内低点，段终提示多头结构开始转弱。'
  ],
  bear: [
    '{N} 出现顶部反转 K 线组合（前低抬升被打破 + 长上影 + 放量），段内提示空头趋势可能启动。{N1} 价格跌破 EMA20 与 VWAP 双重支撑，出现空头入场信号；{N2} 完成空单入场，仓位 30%。{N3} 价格反抽至 VWAP 附近承压，未能突破前低，{N4} 出现第二根空头确认 K 线，{N5} 价格加速下行触及段内低点，按计划在 EMA60 附近止盈离场，本段实现 +0.9R。',
    '{N} 价格跌破盘整下沿并放量，确认空头趋势延续。{N1} 出现空头追加入场信号，加仓至 50%。{N2} 出现疑似底部反转信号，量能未配合，{N3} 价格再创新低，{N4} 出现长下影 K 线后价格反弹至 VWAP，{N5} 价格重新跌破 VWAP，按计划减仓至 20% 锁利润。'
  ],
  flat: [
    '午盘前价格进入窄幅盘整，量能明显萎缩，EMA20 与 VWAP 缠绕，未出现符合计划的顺势入场信号。期间 {N} / {N1} / {N2} 三次触碰盘整下沿均被快速收回，提示下方存在承接但缺乏上攻意愿。建议在价格突破盘整区间并伴随放量时再考虑入场，否则继续空仓等待。'
  ]
};

/** 用模板拼装段详述 */
function expandSegDetail(tpl, times) {
  let out = tpl;
  for (let i = 0; i < times.length; i++) out = out.replace(`{N${i === 0 ? '' : i}}`, times[i]);
  return out;
}

/** 给定日期生成完整市场报告（确定性伪随机） */
export function genDailyReport(date) {
  /* 周末无数据 */
  const dt = new Date(date + 'T12:00:00');
  const wd = dt.getDay();
  if (wd === 0 || wd === 6) return null;

  const rnd = mulberry32(hashStr('REPORT_' + date));
  const bars = genBars(date, date);
  const open = bars[0].o, close = bars[bars.length - 1].c;
  const high = Math.max(...bars.map(b => b.h));
  const low  = Math.min(...bars.map(b => b.l));
  const prevClose = open - (rnd() - 0.5) * 4;
  const prevHigh  = Math.max(prevClose, open) + rnd() * 1.5;
  const prevLow   = Math.min(prevClose, open) - rnd() * 1.5;

  /* 随机选 3–5 段：每段从 {09:30-10:30, 10:00-11:30, 11:00-13:00, 12:30-14:00, 13:30-15:30} 中拼接 */
  const winPools = [[0, 60], [60, 120], [120, 180], [180, 240], [240, 330]];
  const NSEG = 3 + Math.floor(rnd() * 3);   // 3–5
  const segs = [];
  const used = new Set();
  for (let k = 0; k < NSEG; k++) {
    let pool;
    for (let tries = 0; tries < 6; tries++) {
      const cand = winPools[Math.floor(rnd() * winPools.length)];
      if (!used.has(cand)) { pool = cand; used.add(cand); break; }
    }
    if (!pool) break;
    const dur = 18 + Math.floor(rnd() * 30);
    const startMin = pool[0] + Math.floor(rnd() * Math.max(1, pool[1] - pool[0] - dur));
    const endMin = Math.min(pool[1], startMin + dur);
    const start = m2h(9 * 60 + 30 + startMin);
    const end   = m2h(9 * 60 + 30 + endMin);
    const r = rnd();
    const dir = k === 0 ? (rnd() < 0.55 ? 'bull' : 'bear')
              : (segs[k - 1].dir === 'bull' ? (rnd() < 0.45 ? 'bear' : (rnd() < 0.7 ? 'bull' : 'flat'))
               : segs[k - 1].dir === 'bear' ? (rnd() < 0.45 ? 'bull' : (rnd() < 0.7 ? 'bear' : 'flat'))
               : (rnd() < 0.5 ? 'bull' : 'bear'));
    const tmplPool = SEG_TEMPLATES[dir];
    const tpl = tmplPool[Math.floor(rnd() * tmplPool.length)];
    /* 模板中的 N 占位：取段内几个时间点 */
    const times = [];
    const steps = (tpl.match(/{N\d*}/g) || []).length;
    for (let s = 0; s < steps; s++) {
      const offset = Math.floor((s + 1) / (steps + 1) * (endMin - startMin));
      times.push(m2h(9 * 60 + 30 + startMin + offset));
    }
    const detail = expandSegDetail(tpl, times);
    const labelMap = { bull: '多头趋势确认', bear: '空头趋势转换', flat: '盘整观察' };
    segs.push({
      start, end,
      dir,
      label: labelMap[dir],
      signals: rnd() < 0.7 ? (1 + Math.floor(rnd() * 2)) : 0,
      entries: rnd() < 0.5 ? (1 + Math.floor(rnd() * 2)) : 0,
      tps:     rnd() < 0.6 ? (1 + Math.floor(rnd() * 2)) : 0,
      detail,
      top:    Math.max(...bars.slice(startMin, endMin + 1).map(b => b.h)),
      bottom: Math.min(...bars.slice(startMin, endMin + 1).map(b => b.l))
    });
  }
  segs.sort((a, b) => h2m(a.start) - h2m(b.start));

  /* 标记：每个有 entries 的段生成 1–2 个 entry + 1 个 stop/tp */
  const M0 = 9 * 60 + 30;   // 09:30 的绝对分钟；bars 下标 = 绝对分钟 - M0
  const markers = [];
  for (const s of segs) {
    if (!s.entries) continue;
    const sm = h2m(s.start), em = h2m(s.end);
    const eMin = sm + Math.floor((em - sm) * 0.3);
    const xMin = sm + Math.floor((em - sm) * 0.8);
    const ePrice = bars[eMin - M0].c;
    const xPrice = bars[xMin - M0].c;
    markers.push({ t: m2h(eMin), price: ePrice, kind: 'entry', label: s.dir === 'bull' ? '入场' : '做空' });
    if (s.entries > 1) {
      const e2Min = sm + Math.floor((em - sm) * 0.5);
      markers.push({ t: m2h(e2Min), price: bars[e2Min - M0].c, kind: 'entry', label: '加仓' });
    }
    markers.push({
      t: m2h(xMin), price: xPrice,
      kind: s.dir === 'bull' ? 'tp' : 'stop',
      label: s.dir === 'bull' ? '止盈' : '止盈'
    });
  }

  /* 文字标签：段起 / 段终 + 关键位 */
  const labels = [];
  for (const s of segs) {
    const sm = h2m(s.start);
    const col = s.dir === 'bull' ? '#26a69a' : s.dir === 'bear' ? '#ef5350' : '#94a3b8';
    const labelText = s.dir === 'bull' ? '多头起' : s.dir === 'bear' ? '空头起' : '盘整';
    labels.push({ t: s.start, price: bars[sm - M0].c + 0.3, text: labelText, color: col, dy: -14 });
  }
  labels.push({ t: '09:30', price: open, text: '开盘', color: '#cbd5e1', dy: -16 });
  labels.push({ t: '15:59', price: close, text: '收盘', color: '#cbd5e1', dy: -16 });

  const morning = {
    date,
    summary: `昨日${prevClose > open ? '强势收涨' : '小幅震荡'}，盘前期指${prevClose > open ? '高开' : '平开'}。关注前一日高/低/收能否突破，否则谨防${prevClose > open ? '高开低走' : '区间震荡'}。开盘 5 分钟方向决定全天基调。`
  };
  const advice = `今日${segs.filter(s => s.dir === 'bull').length} 段多头 / ${segs.filter(s => s.dir === 'bear').length} 段空头 / ${segs.filter(s => s.dir === 'flat').length} 段盘整。建议关注上方 ${high.toFixed(2)} 与下方 ${low.toFixed(2)} 两个关键位，仓位单笔不超过 30%，严格执行 1R 止损。`;

  return {
    symbol: 'QQQ',
    date,
    bars,
    prevDay: { high: prevHigh, low: prevLow, close: prevClose },
    segments: segs,
    markers,
    labels,
    hlines: [
      { price: prevHigh, color: 'rgba(239,83,80,.35)' },
      { price: prevLow,  color: 'rgba(38,166,154,.35)' }
    ],
    morning,
    advice
  };
}

/** 缓存 */
const REPORT_CACHE = new Map();
/** 已发布报告日期集合（权威：只有这些日期有数据） */
const REPORT_DATE_SET = new Set(getReportDates());
export function getReport(date) {
  if (!REPORT_DATE_SET.has(date)) return null;   // 不在已发布范围 → 无数据（触发空状态页）
  if (REPORT_CACHE.has(date)) return REPORT_CACHE.get(date);
  const r = (date === '2026-09-04') ? SAMPLE_REPORT_0904 : genDailyReport(date);
  REPORT_CACHE.set(date, r);
  return r;
}

/** 2026-05-01 起所有有数据的日期（工作日，无缺失日） */
export function getReportDates() {
  const out = [];
  const end = new Date('2026-09-08T12:00:00');   // 当前"最新发布日"
  const start = new Date('2026-05-01T12:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    const wd = cur.getDay();
    if (wd !== 0 && wd !== 6) {
      out.push(cur.getFullYear() + '-' +
        String(cur.getMonth() + 1).padStart(2, '0') + '-' +
        String(cur.getDate()).padStart(2, '0'));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** 兼容旧 API：0904 / latest 仍返回专门定制版 */
const _SAMPLE_0904_BARS = (() => {
  const r = mulberry32(hashStr('RPT0904'));
  const bars = [];
  let p = 718.5;
  for (let i = 0; i < 391; i++) {
    const min = 9 * 60 + 30 + i;
    let drift = 0, volMul = 1;
    if (i < 30)        { drift = 0.06;  volMul = 0.9; }
    else if (i < 90)   { drift = -0.10; volMul = 1.4; }
    else if (i < 110)  { drift = 0.04;  volMul = 1.6; }
    else if (i < 200)  { drift = 0.00;  volMul = 0.7; }
    else if (i < 280)  { drift = -0.02; volMul = 0.8; }
    else               { drift = 0.01;  volMul = 0.9; }
    const o = p;
    const c = p + drift + (r() - 0.5) * 0.55;
    const h = Math.max(o, c) + r() * 0.35;
    const l = Math.min(o, c) - r() * 0.35;
    const v = Math.floor((80000 + r() * 600000) * volMul);
    bars.push({ t: m2h(min), o, h, l, c, v });
    p = c;
  }
  return bars;
})();

export const SAMPLE_REPORT_0904 = {
  symbol: 'QQQ',
  date: '2026-09-04',
  bars: _SAMPLE_0904_BARS,
  prevDay: { high: 722.50, low: 716.50, close: 718.20 },
  morning: {
    date: '2026-09-04',
    summary: '昨日纳指强势收涨，市场情绪偏暖。盘前期指小幅高开，市场对今日开盘偏多预期较高。需关注开盘后是否能放量突破前高，否则谨防高开低走。重点留意 09:30 第一根 5 分钟 K 线的方向与量能，决定当日多空基调。'
  },
  segments: [
    {
      start: '09:30', end: '10:11', dir: 'bull',
      label: '多头趋势确认', signals: 2, entries: 2,
      detail: '开盘后第一根 5 分钟 K 线收阳且量能温和，确认当日多头基调。09:37 出现回踩 EMA20 缩量企稳的入场信号，09:39 完成第一次入场，仓位按计划 30%。09:48 价格冲高至前高附近，K 线出现长上影，提示上方有阻力；09:50 放量跌破 EMA20 触发第一次止损出场，亏损控制在 1R 以内。09:55 二次回踩在 VWAP 附近出现多方炮形态，09:58 出现第二次入场信号并完成加仓至 60%。随后价格沿 EMA20 上行，10:08 出现顶部反转信号且量能放大，10:11 价格跌破分时均线，全部仓位止盈离场，本段实现 +1.6R。'
    },
    {
      start: '10:14', end: '10:46', dir: 'bull',
      label: '多头趋势确认', signals: 0, entries: 0,
      detail: '本段价格在 EMA20 附近窄幅震荡，多空力量暂时均衡，未出现符合计划的入场信号，因此保持空仓观望。10:18 出现一根长下影探底 K 线，10:22 出现长上影 K 线，构成疑似反转形态但未确认；10:30 之后价格重心略微下移，10:46 跌破段内低点，段终提示多头结构开始转弱。'
    },
    {
      start: '10:20', end: '11:09', dir: 'bear',
      label: '空头趋势转换', signals: 1, entries: 1,
      detail: '10:48 出现顶部反转 K 线组合（前低抬升被打破 + 长上影 + 放量），段内提示空头趋势可能启动。10:52 价格跌破 EMA20 与 VWAP 双重支撑，出现空头入场信号；10:54 完成空单入场，仓位 30%。11:02 价格反抽至 VWAP 附近承压，未能突破前低，11:05 出现第二根空头确认 K 线，11:09 价格加速下行触及段内低点，按计划在 EMA60 附近止盈离场，本段实现 +0.9R。'
    },
    {
      start: '11:12', end: '12:50', dir: 'flat',
      label: '盘整观察', signals: 0, entries: 0,
      detail: '午盘前价格进入窄幅盘整，量能明显萎缩，EMA20 与 VWAP 缠绕，未出现符合计划的顺势入场信号。期间 11:25 / 11:42 / 12:18 三次触碰盘整下沿均被快速收回，提示下方存在承接但缺乏上攻意愿。建议在价格突破盘整区间并伴随放量时再考虑入场，否则继续空仓等待。'
    },
    {
      start: '12:53', end: '14:10', dir: 'bear',
      label: '空头趋势延续', signals: 1, entries: 1,
      detail: '13:02 价格跌破盘整下沿并放量，确认空头趋势延续。13:05 出现空头追加入场信号，加仓至 50%。13:25 出现疑似底部反转信号，量能未配合，13:32 价格再创新低，14:05 出现长下影 K 线后价格反弹至 VWAP，14:10 价格重新跌破 VWAP，按计划减仓至 20% 锁利润。'
    }
  ],
  markers: [
    { t: '09:39', price: 718.92, kind: 'entry', label: '买入' },
    { t: '09:50', price: 720.14, kind: 'stop',  label: '止损' },
    { t: '09:58', price: 720.38, kind: 'entry', label: '加仓' },
    { t: '10:11', price: 722.48, kind: 'tp',    label: '止盈' },
    { t: '10:54', price: 720.66, kind: 'entry', label: '做空' },
    { t: '11:09', price: 718.04, kind: 'tp',    label: '止盈' },
    { t: '13:05', price: 717.88, kind: 'entry', label: '加空' },
    { t: '14:10', price: 716.62, kind: 'stop',  label: '减仓' }
  ],
  labels: [
    { t: '09:30', price: 718.50, text: '开盘',   color: '#cbd5e1', dy: -16, cat: 'morning' },
    { t: '09:37', price: 718.20, text: '缩量',   color: '#94a3b8', dy: 18,  cat: 'indicator' },
    { t: '09:39', price: 718.92, text: '入场',   color: '#26a69a', dy: 22,  cat: 'entry' },
    { t: '09:48', price: 721.40, text: '长上影', color: '#f0b429', dy: -16, cat: 'reversal' },
    { t: '09:50', price: 720.14, text: '止损',   color: '#ef5350', dy: 22,  cat: 'stop' },
    { t: '09:55', price: 720.10, text: '多方炮', color: '#4a9eff', dy: -16, cat: 'longUp' },
    { t: '09:58', price: 720.38, text: '入场',   color: '#26a69a', dy: 22,  cat: 'entry' },
    { t: '10:00', price: 722.48, text: '顶部',   color: '#a78bfa', dy: -16, cat: 'bullTop' },
    { t: '10:11', price: 722.10, text: '止盈',   color: '#26a69a', dy: -16, cat: 'stop' },
    { t: '10:48', price: 722.00, text: '反转',   color: '#ef5350', dy: -16, cat: 'reverse' },
    { t: '10:52', price: 720.92, text: '破位',   color: '#ef5350', dy: -16, cat: 'bear' },
    { t: '10:54', price: 720.66, text: '做空',   color: '#ef5350', dy: 22,  cat: 'entry' },
    { t: '11:00', price: 718.50, text: '加速',   color: '#ef5350', dy: -16, cat: 'bear' },
    { t: '11:09', price: 718.04, text: '止盈',   color: '#26a69a', dy: 22,  cat: 'stop' },
    { t: '11:25', price: 717.20, text: '探底',   color: '#94a3b8', dy: -16, cat: 'indicator' },
    { t: '12:53', price: 717.40, text: '破位',   color: '#ef5350', dy: -16, cat: 'bear' },
    { t: '13:05', price: 717.88, text: '加空',   color: '#ef5350', dy: 22,  cat: 'entry' },
    { t: '14:10', price: 716.62, text: '减仓',   color: '#94a3b8', dy: 22,  cat: 'reduce' }
  ],
  hlines: [
    { price: 722.50, color: 'rgba(247,180,30,0.4)' },
    { price: 716.50, color: 'rgba(239,83,80,0.4)' }
  ],
  advice: '今日早盘确认多头基调，但 10:00 附近见顶后空头迅速接管，全天呈先涨后跌结构。建议明日关注两个关键位：上方 722.50（前高 + EMA60 阻力），下方 716.50（今日低点 + 整数位）。若开盘后向上突破 722.50 伴随量能放大，可尝试短多跟进；反之若跌破 716.50，则空头趋势延续概率较大。仓位建议单笔不超过 30%，段内加仓不超过 60%，严格执行 1R 止损。'
};

export const SAMPLE_REPORT_LATEST = SAMPLE_REPORT_0904;
