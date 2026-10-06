import { ExitCode } from '../output/errors.js';
import { applyPlan, executeStep } from '../plan/apply.js';
import { type ApplyReport, buildPlan, type StepDraft } from '../plan/types.js';
import { VERSION } from '../version.js';
import type { Context } from './context.js';
import { renderApplyReport } from './render.js';

export interface MutationOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/**
 * Single-command mutations (ops set/attach/detach/validate) run through the
 * same step executor as `apply`: preview, confirm, write, verify.
 */
export async function runSteps(
  ctx: Context,
  command: string,
  drafts: StepDraft[],
  options: MutationOptions,
): Promise<void> {
  const dougs = await ctx.dougs();
  const plan = buildPlan(dougs.company, `dougs-cli ${VERSION} ${command}`, drafts);
  const preview = await applyPlan(dougs, plan, {
    dryRun: true,
    force: options.force,
    continueOnError: true,
  });
  if (options.dryRun || preview.meta.planned === 0) {
    ctx.out.result(preview, renderApplyReport);
    if (preview.meta.failed) ctx.exitCode = ExitCode.partial;
    return;
  }
  if (ctx.out.human) ctx.runtime.stderr.write(`${renderApplyReport(preview)}\n\n`);
  await ctx.confirm(
    `Apply ${preview.meta.planned} change(s) to company ${dougs.company}?`,
    options.yes,
  );

  let report: ApplyReport;
  if (plan.steps.length === 1) {
    // One step: let its error surface with its own exit code (auth, rejected, …).
    const startedAt = new Date().toISOString();
    const result = await executeStep(dougs, plan.steps[0]!, { force: options.force });
    report = {
      meta: {
        company: plan.company,
        createdBy: plan.createdBy,
        dryRun: false,
        total: 1,
        applied: result.status === 'applied' ? 1 : 0,
        planned: 0,
        skipped: result.status === 'skipped' ? 1 : 0,
        failed: 0,
        pending: 0,
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      results: [result],
    };
  } else {
    report = await applyPlan(dougs, plan, {
      force: options.force,
      onResult: (r) => ctx.out.debug(`${r.step} ${r.status}`),
    });
  }
  ctx.out.result(report, renderApplyReport);
  if (report.meta.failed || report.meta.pending) ctx.exitCode = ExitCode.partial;
}
