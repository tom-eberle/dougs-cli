import { createInterface } from 'node:readline/promises';
import { DougsError } from '../output/errors.js';
export async function confirm(
  yes = false,
  tty = !!(process.stdin.isTTY && process.stdout.isTTY),
): Promise<void> {
  if (yes) return;
  if (!tty)
    throw new DougsError(
      'CONFIRMATION_REQUIRED',
      'Mutation requires confirmation',
      2,
      're-run with --yes, or preview with --dry-run',
    );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (
      !/^y(es)?$/i.test(
        (await rl.question('Apply these changes? [y/N] ')).trim(),
      )
    )
      throw new DougsError('CANCELLED', 'No changes applied', 2);
  } finally {
    rl.close();
  }
}
