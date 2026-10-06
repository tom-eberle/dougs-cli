import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { DougsError, ExitCode } from '../output/errors.js';
import { style } from '../output/style.js';
import { applyPlan } from '../plan/apply.js';
import { planSchema } from '../plan/types.js';
import { contextOf } from './context.js';
import { renderApplyReport } from './render.js';
import { addMutationOptions, withExamples } from './shared.js';

export async function readPlan(path: string) {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    throw new DougsError(
      'PLAN_INVALID',
      missing ? `Plan file not found: ${path}` : `Plan file is not valid JSON: ${path}`,
      {
        exitCode: ExitCode.usage,
      },
    );
  }
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DougsError(
      'PLAN_INVALID',
      `${path}: ${issue?.path.join('.') || 'plan'}: ${issue?.message}`,
      {
        exitCode: ExitCode.usage,
        hint: 'see: dougs schema plan',
      },
    );
  }
  return parsed.data;
}

export function registerApplyCommand(program: Command): void {
  withExamples(
    addMutationOptions(
      program
        .command('apply <plan>')
        .description(
          'Review and execute a plan: re-reads each operation, skips what is already done, verifies every write',
        )
        .option('--force', 'Apply steps even if the operation changed since the plan was made')
        .option('--continue-on-error', 'Keep going after a failed step')
        .option('--report <file>', 'Also write the JSON result report (audit log) to this file'),
    ),
    'apply receipts.plan.json --dry-run',
    'apply vat.plan.json --yes --report vat.report.json',
    'apply rules.plan.json --yes --continue-on-error --json',
  ).action(
    async (
      path: string,
      o: {
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        continueOnError?: boolean;
        report?: string;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const plan = await readPlan(path);
      const dougs = await ctx.dougs();
      const baseDir = dirname(resolve(path));
      ctx.out.info(style.dim(`Checking ${plan.steps.length} step(s) against the current state…`));
      const preview = await applyPlan(dougs, plan, {
        dryRun: true,
        force: o.force,
        continueOnError: true,
        baseDir,
      });
      let report = preview;
      if (!o.dryRun && preview.meta.planned > 0) {
        if (ctx.out.human) ctx.runtime.stderr.write(`${renderApplyReport(preview)}\n\n`);
        await ctx.confirm(
          `Apply ${preview.meta.planned} change(s) to company ${dougs.company}?`,
          o.yes,
        );
        report = await applyPlan(dougs, plan, {
          force: o.force,
          continueOnError: o.continueOnError,
          baseDir,
          onResult: (r) =>
            ctx.out.info(
              style.dim(`  ${r.step} ${r.status}${r.error ? `: ${r.error.message}` : ''}`),
            ),
        });
      }
      if (o.report)
        await writeFile(o.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      ctx.out.result(report, renderApplyReport);
      if (report.meta.failed || report.meta.pending) ctx.exitCode = ExitCode.partial;
    },
  );
}
