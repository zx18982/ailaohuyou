# 日进斗斗金 · 站点复刻说明

## 启动

```bash
cd /Users/zhangxiao/WorkBuddy/doudoujin
python3 serve.py 8765
# 浏览器打开 http://127.0.0.1:8765
```

不推荐直接双击 `index.html`——会触发 `fetch` CORS 限制，视频索引和 PDF 代理都依赖本地 HTTP。

## 文件结构

```
doudoujin/
├── index.html          入口
├── spec.md             复刻规格
├── serve.py            本地服务（静态托管 + 视频 open + PDF 同源代理）
├── css/style.css       深色交易终端风格设计系统
├── js/
│   ├── core.js         工具函数 / 存储 / 格式化
│   ├── mock.js         行情、交易、问答、书籍、选手模拟数据
│   ├── chart.js        Canvas K 线引擎（均线、成交量、十字光标、画线、买卖点）
│   ├── pages-trade.js  回放复盘 / 实时分析 / 交易日志
│   ├── pages-stats.js  数据统计 / 排行榜
│   ├── pages-market.js 市场报告频道（复刻 + 真实数据导入）
│   ├── pages-content.js 视频频道 / 书籍报告 / 互动答疑 / 首页
│   └── app.js          路由、顶栏、登录态、装配
├── data/videos.json    180 个视频的索引（只记路径，不占站点空间）
└── tools/              真实数据抓取脚本
```

## 9 个页面

| 路由 | 页面 | 复刻要点 |
|---|---|---|
| `#/home` | 首页 | Hero 标语 + 实战交易记录月历 + 核心功能导览 + 策略要点 |
| `#/journal` | 交易日志 | 当日汇总 / 逐笔增删改 / 入场前-持仓中-出场后三段心态 / 多选标签 / localStorage |
| `#/stats` | 数据统计 | 90 天 6 项指标 / 月历热力图 / 每日盈亏柱状+累计折线 / R 倍数散点 |
| `#/rank` | 排行榜 | 日榜/周榜/月榜切换 / 全员入场出场标记叠加 / 问题标签统计 / 人气入场 Top5 |
| `#/replay` | 回放复盘 | 1 分钟 K 线 / 60 根逐步揭示 / 上一根下一根 / 1×-3× 速度 / 1 秒跳进 / Reset Trades |
| `#/live` | 实时分析 | 同一图表引擎，1 分钟 K 线全量展示 |
| `#/market` | 市场报告 | 复刻 rijindoudoujin.com 市场报告频道 · 三组工具栏（分段/标记/指标）+ 图例行 · 1 分钟 K 线 + EMA20/VWAP/缠论中线/一目均衡表云图 · 分段时间背景 · 平仓⊖/止损⊖/止盈◇/信号点/缠论笔/段顶段底/前日线 · 分段总览与详述 · 真实数据导入 |
| `#/books` | 书籍报告 | 3 份本地 PDF 卡片 + Chrome PDF 阅读器 iframe 嵌入 + 跳系统阅读器 |
| `#/videos` | 视频频道 | 180 个本地 mp4 索引（8 个分类） / 搜索 / 点击调用系统播放器 |
| `#/qa` | 互动答疑 | 12 个主题 / 全部/QQQ/其他标的/管理员筛选 / 展开查看与回复 / 提问模态框 |

## 视频频道工作机制

`data/videos.json` 只记 `{分类, 标题, 相对路径, 大小, 扩展名}`，**视频文件本身 0 字节复制**。点击卡片：
1. 前端 `POST /api/open {path}` → Python 后端用 macOS `open` 命令唤起系统播放器
2. 后端兜底失败 → 复制绝对路径到剪贴板，提示用户去访达打开

## PDF 阅读器

`/api/pdf?path=…` 由后端读取本地 PDF 并以 `application/pdf` 流式返回，绕过 Chrome 的 `file://` 跨域限制。直接用 Chrome 内置 PDF.js 渲染，缩放/缩略图/翻页/搜索全能用。

## 复刻过程中视频没拍到的取舍

- 行情数据是种子伪随机生成（90 天 × 6.5 小时 × 每分钟 1 根），可基于日 K 调出趋势
- 交易日志、问答、持仓、挂单全部 `localStorage` 持久化
- 登录态仅前端模拟，刷新后由本地缓存恢复
- 视频不嵌入网页播放，点击转系统播放器

## 市场报告真实数据抓取

原站 `tj_market_analysis` 表受 Supabase RLS 保护，**必须登录后才能读取**。提供两条抓取路径：

**A. 浏览器控制台（最简单）**
```bash
# 复制 tools/scrape-console-snippet-v2.js 整段代码
# 在已登录 https://rijindoudoujin.com 的页面 DevTools Console 中粘贴执行
# 自动下载 2026-05-01 起的 market_reports_all_YYYY-MM-DD.json
```

**B. 命令行工具（支持分页 + 可选扩展表）**
```bash
# 1. 登录后从浏览器 DevTools → Application → Local Storage 找到
#    sb-bnhjlixwqrmzlchrpnoh-auth-token，复制其中的 access_token
# 2. 在同一 DevTools Network 面板任一 supabase.co/rest/v1 请求头里找到 apikey
# 3. 执行
export DDJ_SUPABASE_ANON_KEY=<APIKEY>
node tools/scrape-all-reports.js --token <ACCESS_TOKEN>
# 可选参数：
#   --since 2026-05-01        自定义起始日期
#   --out ./data/market       输出目录
#   --also calendar,leaderboard   附加抓交易日历 + 排行榜
```

抓取完成后：
- `data/market/market_reports_all.json` 完整行数据（按日期升序，自动分页）
- `data/market/pro_data/YYYY-MM-DD.json` 按日期拆分的 pro_data（可直接在市场报告页「导入真实数据」中使用）
- `data/market/index.csv` 报告索引（日期/标的/状态/bars数/segments数）
- `data/market/summary.json` 抓取摘要（日期范围、标的统计）

## 后续可扩展

- 接入真实行情（Tushare / Yahoo）
- 替换 HLS / WebRTC 走站内播放视频
- 用户系统接入（目前登录仅是 UI）
- 移动端布局适配（目前优化到 1280+ 桌面）
