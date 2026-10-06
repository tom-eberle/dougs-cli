import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import { example, registerCore } from './commands/core.js';
import { registerResources } from './commands/resources.js';
import { DougsError, errorObject } from './output/errors.js';
import { isJson } from './output/format.js';

const program = new Command()
  .name('dougs')
  .description('Unofficial Dougs accounting CLI — plan, review, apply')
  .version('0.1.0')
  .option('--json', 'Output JSON (automatic when piped)')
  .option('--jsonl', 'Output one JSON object per line')
  .option('--profile <name>', 'Config profile (DOUGS_PROFILE)')
  .option('--company <id>', 'Company id (DOUGS_COMPANY)')
  .option('--verbose', 'Log HTTP methods and paths to stderr; secrets redacted')
  .option('--quiet', 'Suppress progress logs')
  .option('--no-color', 'Disable colors (also NO_COLOR)')
  .option('--no-cache', 'Bypass categories and PDF text caches');
program.exitOverride();
program.configureOutput({ writeErr: () => {} });
example(
  program,
  'todo --limit 10',
  'receipts match ./inbox --plan receipts.plan.json',
  'apply receipts.plan.json --dry-run',
);
registerCore(program);
registerResources(program);
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  else throw e;
});
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else {
    const e =
      error instanceof CommanderError
        ? new DougsError('USAGE', error.message, 2)
        : error instanceof z.ZodError
          ? new DougsError(
              'SCHEMA_INVALID',
              error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; '),
              2,
            )
          : error instanceof SyntaxError
            ? new DougsError('INVALID_JSON', 'Invalid JSON input', 2)
            : error;
    const data = errorObject(e);
    process.stderr.write(
      `${isJson(program.opts()) ? JSON.stringify(data) : `${data.error.code}: ${data.error.message}${data.error.hint ? `\nHint: ${data.error.hint}` : ''}`}\n`,
    );
    process.exitCode = e instanceof DougsError ? e.exitCode : 1;
  }
}
