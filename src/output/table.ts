import { style, visibleLength } from './style.js';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
  /** Columns marked flexible shrink first when the terminal is too narrow. */
  flex?: boolean;
  max?: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;

function clean(text: string): string {
  return text.replace(CONTROL, ' ');
}

function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return '…'.slice(0, width);
  return `${[...text].slice(0, width - 1).join('')}…`;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const gap = ' '.repeat(Math.max(0, width - visibleLength(text)));
  return align === 'right' ? gap + text : text + gap;
}

/** Render rows as an aligned, borderless table (gh-style). */
export function renderTable<T>(
  columns: Column<T>[],
  rows: readonly T[],
  terminalWidth = process.stdout.columns || 120,
): string {
  const cells = rows.map((row) => columns.map((c) => clean(c.value(row))));
  const widths = columns.map((c, i) =>
    Math.min(
      c.max ?? Number.POSITIVE_INFINITY,
      Math.max(c.header.length, ...cells.map((r) => visibleLength(r[i] ?? ''))),
    ),
  );
  const gutter = 2 * (columns.length - 1);
  let overflow = widths.reduce((a, b) => a + b, 0) + gutter - terminalWidth;
  for (let i = 0; i < columns.length && overflow > 0; i++) {
    if (!columns[i]?.flex) continue;
    const shrink = Math.min(overflow, Math.max(0, (widths[i] ?? 0) - 12));
    widths[i] = (widths[i] ?? 0) - shrink;
    overflow -= shrink;
  }
  const line = (values: string[]) =>
    values
      .map((v, i) => pad(truncate(v, widths[i] ?? 0), widths[i] ?? 0, columns[i]?.align ?? 'left'))
      .join('  ')
      .trimEnd();
  return [style.bold(line(columns.map((c) => c.header))), ...cells.map(line)].join('\n');
}

/** Two-column "key  value" block for single objects. */
export function renderKeyValues(entries: [string, string][]): string {
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${style.dim(k.padEnd(width))}  ${clean(v)}`).join('\n');
}
