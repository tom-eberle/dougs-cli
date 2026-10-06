import { table } from './table.js';
export interface OutputOptions {
  json?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
}
export function isJson(
  options: OutputOptions,
  tty = process.stdout.isTTY,
): boolean {
  return !!(options.json || options.jsonl || !tty);
}
export function output(
  data: unknown,
  options: OutputOptions = {},
  rows?: Record<string, unknown>[],
): void {
  if (options.jsonl) {
    for (const item of Array.isArray(data) ? data : [data])
      process.stdout.write(`${JSON.stringify(item)}\n`);
  } else if (isJson(options))
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else
    process.stdout.write(
      `${rows ? table(rows) : Array.isArray(data) ? table(data.map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : { value: item }))) : JSON.stringify(data, null, 2)}\n`,
    );
}
