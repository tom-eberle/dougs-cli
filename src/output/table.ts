export function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return 'No results.';
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) =>
    (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—'))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 90);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => cell(r[k]).length)),
  );
  return [
    keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join('  '),
    ...rows.map((r) =>
      keys.map((k, i) => cell(r[k]).padEnd(widths[i] ?? 0)).join('  '),
    ),
  ].join('\n');
}
