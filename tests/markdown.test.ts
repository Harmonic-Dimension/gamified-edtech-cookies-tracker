import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/report/markdown.js';

describe('methodology renderer', () => {
  it('renders headings, lists, tables and code', () => {
    const html = renderMarkdown([
      '# Title',
      '',
      'Some **bold** text with `code` and a [link](https://example.com/x).',
      '',
      '* first',
      '* second',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```bash',
      'npm test',
      '```',
    ].join('\n'));
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com/x">link</a>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<pre><code>npm test</code></pre>');
  });

  it('escapes HTML in the source document', () => {
    const html = renderMarkdown('A <script>alert(1)</script> line');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not turn a javascript: link into an anchor target', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
  });
});
