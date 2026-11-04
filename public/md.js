// Small, safe Markdown renderer: everything is HTML-escaped first, links are limited to
// http(s)/mailto/relative URLs. Supports headings, paragraphs, bold/italic/strike, inline and
// fenced code, links, autolinks, nested lists, task lists, blockquotes, tables and rules.
(function () {
  'use strict';
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(u) ? u : null;
  }

  function inline(src) {
    const keep = [];
    const hold = (html) => { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; };
    let s = String(src);
    s = s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_, t, c) => hold('<code>' + esc(c.trim() ? c : c) + '</code>'));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) => { const url = safeUrl(u); return url ? hold('<img alt="' + esc(alt) + '" src="' + esc(url) + '">') : m; });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, t, u) => {
      const url = safeUrl(u);
      return url ? hold('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">') + t + hold('</a>') : t;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (m, pre, u) => pre + hold('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>'));
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
    return s;
  }

  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function indentOf(l) { const m = /^[ \t]*/.exec(l)[0]; return m.replace(/\t/g, '    ').length; }

  function isBlockStart(line, next) {
    if (line == null) return false;
    return FENCE.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST.test(line) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes('|') && next != null && TABLE_SEP.test(next) && next.includes('-'));
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function dedent(lines) {
    const ind = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
    return lines.map((l) => l.replace(/\t/g, '    ').slice(Number.isFinite(ind) ? ind : 0));
  }

  function parseList(lines, i) {
    const base = indentOf(lines[i]);
    const ordered = /^\s*\d/.test(lines[i]);
    const start = ordered ? parseInt(lines[i].trim(), 10) : 1;
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base && items.length) { items[items.length - 1].sub.push(''); i = j; continue; }
        if (j < lines.length && indentOf(lines[j]) === base && LIST.test(lines[j])) { i = j; continue; }
        break;
      }
      const ind = indentOf(line);
      const m = LIST.exec(line);
      if (m && ind === base) { items.push({ text: m[3], sub: [] }); i++; continue; }
      if (ind > base && items.length) { items[items.length - 1].sub.push(line); i++; continue; }
      if (!m && items.length && !isBlockStart(line, lines[i + 1])) { items[items.length - 1].text += '\n' + line.trim(); i++; continue; }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>';
    for (const it of items) {
      let text = it.text;
      let box = '';
      const t = /^\[([ xX])\]\s+/.exec(text);
      if (t) { box = '<input type="checkbox" disabled' + (t[1] !== ' ' ? ' checked' : '') + '> '; text = text.slice(t[0].length); }
      html += '<li' + (box ? ' class="task"' : '') + '>' + box + text.split('\n').map(inline).join('<br>');
      if (it.sub.length) html += render(dedent(it.sub).join('\n'));
      html += '</li>';
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  function render(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m = FENCE.exec(line);
      if (m) {
        const fence = m[1];
        const buf = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && !lines[i].trim().slice(fence.length).trim())) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code' + (m[2] ? ' data-lang="' + esc(m[2]) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) { const n = m[1].length; out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
        const cell = (tag, c, k) => '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c || '') + '</' + tag + '>';
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k], k)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && (/^\s*>/.test(lines[i]) || !isBlockStart(lines[i], lines[i + 1]))) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }
      if (LIST.test(line)) { const r = parseList(lines, i); out.push(r.html); i = r.next; continue; }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { buf.push(lines[i]); i++; }
      out.push('<p>' + buf.map((l) => inline(l.trim())).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  const api = { renderMarkdown: render, escapeHtml: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') Object.assign(window, api);
})();
