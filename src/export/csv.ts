/** Minimal, dependency-free CSV writer (RFC 4180 quoting). */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return (columns ?? []).join(',') + '\n';
  const cols = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown): string => {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((col) => escape(row[col])).join(','));
  }
  return lines.join('\n') + '\n';
}
