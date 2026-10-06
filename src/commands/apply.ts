import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { output } from '../output/format.js';
import { applyPlan } from '../plan/apply.js';
import { confirm } from '../plan/diff.js';
import { planSchema } from '../plan/types.js';
import type { GlobalOptions } from './context.js';
import { example, options, schemas } from './core.js';
import { resources } from './resources.js';
export function registerApply(program: Command): void {
  schemas.plan = planSchema;
  example(
    program
      .command('apply <file>')
      .description(
        'Review and apply a version-1 plan, re-reading each operation',
      )
      .option('--yes', 'Approve without prompting')
      .option('--dry-run', 'Preview each step without writing')
      .option('--force', 'Apply despite changed expectations')
      .option('--continue-on-error', 'Continue after a failed step')
      .option('--report <file>', 'Write JSON audit report'),
    'apply ./receipts.plan.json --dry-run',
    'apply ./receipts.plan.json --yes --report ./apply-report.json',
  ).action(async (file: string, _local, cmd: Command) => {
    const o = cmd.optsWithGlobals<
      GlobalOptions & {
        yes?: boolean;
        dryRun?: boolean;
        force?: boolean;
        continueOnError?: boolean;
        report?: string;
      }
    >();
    const plan = planSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    for (const step of plan.steps)
      if (step.action === 'attach')
        step.file = resolve(dirname(resolve(file)), step.file);
    const r = await resources(cmd);
    const preview = await applyPlan(r, plan, {
      dryRun: true,
      force: o.force,
      continueOnError: true,
    });
    let report = preview;
    if (!o.dryRun) {
      if (!o.yes) process.stderr.write(`${JSON.stringify(preview, null, 2)}\n`);
      await confirm(o.yes);
      report = await applyPlan(r, plan, o);
    }
    if (o.report)
      await writeFile(o.report, JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
    output(report, o);
    if (report.meta.failed || report.meta.pending) process.exitCode = 7;
  });
}
