/** Minimal ANSI styling. Disabled unless explicitly enabled for a TTY. */
let enabled = false;

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length;
}
