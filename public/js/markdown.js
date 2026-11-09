// A small, safe Markdown renderer for model replies.
//
// Safety model: every piece of source text is HTML-escaped; the only markup
// in the output is markup this file writes itself. Links are limited to
// http(s) and mailto. Raw HTML in the source is shown as text.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/;
const FENCE_RE = /^( *)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}>/;

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return blocks(lines);
}

// Inline-only rendering (bold, code, links…) for short UI strings.
export function renderInline(text) {
  return inline(text);
}

function blocks(lines) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    let m = line.match(FENCE_RE);
    if (m) {
      const indent = m[1].length;
      const fence = m[2];
      const close = new RegExp(`^ *${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(stripIndent(lines[i], indent));
        i++;
      }
      if (i < lines.length) i++; // closing fence
      out += codeBlock(body.join('\n'), m[3]);
      continue;
    }

    m = line.match(HEADING_RE);
    if (m) {
      const level = m[1].length;
      out += `<h${level}>${inline(m[2] || '')}</h${level}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out += '<hr>';
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE_RE.test(lines[i]) || !startsBlock(lines, i))) {
        body.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      out += `<blockquote>${blocks(body)}</blockquote>`;
      continue;
    }

    if (isTableStart(lines, i)) {
      const [html, next] = table(lines, i);
      out += html;
      i = next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const [html, next] = list(lines, i);
      out += html;
      i = next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i].trim());
      i++;
    }
    out += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return out;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || isTableStart(lines, i);
}

function stripIndent(line, n) {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// ----- code -----------------------------------------------------------------

function codeBlock(code, lang) {
  const label = lang ? escapeHtml(lang.slice(0, 24)) : 'code';
  return (
    '<div class="code-block">' +
    `<div class="code-head"><span class="code-lang">${label}</span>` +
    '<button type="button" class="code-copy" data-copy-code aria-label="Copy code">' +
    '<svg class="i" aria-hidden="true"><use href="#i-copy"/></svg><span>Copy</span></button></div>' +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`
  );
}

// ----- lists ----------------------------------------------------------------

function list(lines, start) {
  const first = lines[start].match(LIST_RE);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let cur = null;
  let i = start;
  let sawBlank = false;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line continues the list only if more list content follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const nm = lines[j].match(LIST_RE);
      const sameLevelItem = nm && indentOf(lines[j]) <= base + 1 && /\d/.test(nm[2]) === ordered;
      if (indentOf(lines[j]) > base + 1 || sameLevelItem) {
        if (cur) cur.lines.push('');
        sawBlank = true;
        i++;
        continue;
      }
      break;
    }

    const m = line.match(LIST_RE);
    const ind = indentOf(line);
    if (m && ind <= base + 1) {
      if (/\d/.test(m[2]) !== ordered) break; // different list type starts a new list
      cur = { lines: [m[3] || ''], contentIndent: ind + m[2].length + 1 };
      items.push(cur);
      i++;
      continue;
    }
    if (ind > base + 1 && cur) {
      cur.lines.push(stripIndent(line, cur.contentIndent));
      i++;
      continue;
    }
    // Lazy continuation of the previous item's paragraph.
    if (cur && !sawBlank && !startsBlock(lines, i)) {
      cur.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const body = items.map((it) => `<li>${blocks(it.lines)}</li>`).join('');
  return [`<${tag}${attr}>${body}</${tag}>`, i];
}

// ----- tables ---------------------------------------------------------------

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && isTableSep(lines[i + 1]);
}

function isTableSep(line) {
  return line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cell += '|';
      k++;
    } else if (ch === '`') {
      inCode = !inCode;
      cell += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function table(lines, start) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
  );
  const cls = (k) => (align[k] ? ` class="al-${align[k]}"` : '');
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const n = head.length;
  const th = head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join('');
  const tb = rows
    .map((r) => `<tr>${Array.from({ length: n }, (_, k) => `<td${cls(k)}>${inline(r[k] || '')}</td>`).join('')}</tr>`)
    .join('');
  return [`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`, i];
}

// ----- inline ---------------------------------------------------------------

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text) {
  const tokens = [];
  const hold = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, '');

  // Code spans first, so nothing inside them is interpreted.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escapeHtml(code.trim() ? code.replace(/^ (.*) $/, '$1') : code)}</code>`));
  // Backslash escapes.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch) => hold(escapeHtml(ch)));
  // Images are not loaded (privacy); show them as links.
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, alt, url) => {
    const href = safeUrl(url);
    return href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || 'image')}</a>`) : m;
  });
  // Links.
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label, url) => {
    const href = safeUrl(url);
    if (!href) return m;
    return hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`) + label + hold('</a>');
  });
  // Autolinks.
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, (m, url) => {
    const href = safeUrl(url);
    return href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]*[^\s<>\u0000.,:;"')\]!?*_])/g, (m, pre, url) => {
    const href = safeUrl(url);
    return href ? pre + hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : m;
  });

  s = escapeHtml(s);

  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}

// Puts the streaming caret right after the last piece of visible text.
export function appendCaret(root) {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  let node = root;
  for (;;) {
    let last = node.lastChild;
    while (last && last.nodeType === Node.TEXT_NODE && !last.textContent.trim()) last = last.previousSibling;
    if (!last || last.nodeType !== Node.ELEMENT_NODE) break;
    if (['BR', 'HR', 'svg', 'BUTTON'].includes(last.nodeName)) break;
    node = last;
  }
  node.append(caret);
}
