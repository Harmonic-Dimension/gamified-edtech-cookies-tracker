import { escapeHtml } from './format.js';

/**
 * A deliberately small Markdown renderer, used only to display this project's
 * own documentation (docs/METHODOLOGY.md) inside the dashboard. It supports
 * exactly the constructs those documents use: headings, paragraphs, bullet and
 * numbered lists, pipe tables, fenced and inline code, bold, links and rules.
 *
 * All input is HTML-escaped first, so it cannot inject markup.
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeLines: string[] = [];
  let tableRows: string[][] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const [header, ...body] = tableRows;
    out.push('<table><thead><tr>' + header.map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>');
    for (const row of body) {
      out.push('<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>');
    }
    out.push('</tbody></table>');
    tableRows = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 1, 6); // h1 is the page title
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    // Pipe table rows; the |---|---| separator line is skipped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      tableRows.push(cells);
      continue;
    }
    flushTable();

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    if (listType) {
      // Continuation of the previous list item.
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }

  if (inCode && codeLines.length) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

function inline(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = /^(https?:|\/|#|[\w.\-/]+\.md)/i.test(href) ? href : '#';
    return `<a href="${safeHref}">${label}</a>`;
  });
  return html;
}
