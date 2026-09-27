/* ============================================================
   md.js — 轻量 markdown → HTML（标题 / 加粗 / 表格 / 列表 / 段落 / 分隔线）
   无外部依赖，供 pages-market 与 market-chart 共用。
   ============================================================ */
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/→/g, '<span class="md-arrow">→</span>');
}

export function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', inTable = false, tableBuf = [];
  const closeTable = () => {
    if (!inTable) return;
    let rows = tableBuf.map(r => r.trim().split('|').filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === '')));
    rows = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c.trim())));
    if (rows.length >= 2) {
      const head = rows[0].map(c => `<th>${inline(c.trim())}</th>`).join('');
      const body = rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inline(c.trim())}</td>`).join('')}</tr>`).join('');
      html += `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    } else if (rows.length === 1) {
      html += `<table class="md-table"><thead><tr>${rows[0].map(c => `<th>${inline(c.trim())}</th>`).join('')}</tr></thead></table>`;
    }
    tableBuf = []; inTable = false;
  };
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(ln)) { inTable = true; tableBuf.push(ln); continue; }
    closeTable();
    if (/^###\s+/.test(ln)) html += `<h4>${inline(ln.replace(/^###\s+/, ''))}</h4>`;
    else if (/^##\s+/.test(ln)) html += `<h3>${inline(ln.replace(/^##\s+/, ''))}</h3>`;
    else if (/^#\s+/.test(ln)) html += `<h2>${inline(ln.replace(/^#\s+/, ''))}</h2>`;
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) html += '<hr class="md-hr">';
    else if (/^[-*]\s+/.test(ln)) html += `<li>${inline(ln.replace(/^[-*]\s+/, ''))}</li>`;
    else if (ln === '') html += '';
    else html += `<p>${inline(ln)}</p>`;
  }
  closeTable();
  return html;
}
