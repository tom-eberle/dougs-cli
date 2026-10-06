import { ExitCode } from '../output/errors.js';
import { type ApplyOptions, applyPlan, executeStep } from '../plan/apply.js';
import {
  type ApplyReport,
  buildPlan,
  type Plan,
  type StepDraft,
  type StepResult,
} from '../plan/types.js';
import { VERSION } from '../version.js';
import type { Context } from './context.js';
import { renderApplyReport } from './render.js';

export interface MutationOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  allowAnyPath?: boolean;
}

/** The confirmation question, listing every local file that would be uploaded. */
export function confirmationQuestion(preview: ApplyReport, company: string): string {
  const uploads = preview.results
    .filter((r) => r.status === 'planned' && r.file)
    .map((r) => r.file!);
  const question = `Apply ${preview.meta.planned} change(s) to company ${company}?`;
  if (!uploads.length) return question;
  return `These local files will be uploaded to Dougs:\n${uploads.map((f) => `  ${f}`).join('\n')}\n${question}`;
}

function singleReport(
  plan: Plan,
  result: StepResult,
  dryRun: boolean,
  startedAt: string,
): ApplyReport {
  const is = (s: StepResult['status']) => (result.status === s ? 1 : 0);
  return {
    meta: {
      company: plan.company,
      createdBy: plan.createdBy,
      dryRun,
      total: 1,
      applied: is('applied'),
      planned: is('planned'),
      skipped: is('skipped'),
      failed: 0,
      pending: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    results: [result],
  };
}

/**
 * Single-command mutations (ops set/attach/detach/validate) run through the
 * same step executor as `apply`: preview, confirm, write, verify. With one
 * step, its error surfaces with its own exit code (usage, auth, rejected…).
 */
export async function runSteps(
  ctx: Context,
  command: string,
  drafts: StepDraft[],
  options: MutationOptions,
): Promise<void> {
  const dougs = await ctx.dougs();
  const plan = buildPlan(dougs.company, `dougs-cli ${VERSION} ${command}`, drafts);
  const single = plan.steps.length === 1 ? plan.steps[0]! : null;
  const base: ApplyOptions = { force: options.force, allowAnyPath: options.allowAnyPath };
  const run = async (dryRun: boolean): Promise<ApplyReport> => {
    const startedAt = new Date().toISOString();
    return single
      ? singleReport(plan, await executeStep(dougs, single, { ...base, dryRun }), dryRun, startedAt)
      : applyPlan(dougs, plan, { ...base, dryRun, continueOnError: dryRun });
  };

  const preview = await run(true);
  if (options.dryRun || preview.meta.planned === 0) {
    ctx.out.result(preview, renderApplyReport);
    if (preview.meta.failed) ctx.exitCode = ExitCode.partial;
    return;
  }
  if (ctx.out.human) ctx.out.humanError(`${renderApplyReport(preview)}\n\n`);
  await ctx.confirm(confirmationQuestion(preview, dougs.company), options.yes);
  const report = await run(false);
  ctx.out.result(report, renderApplyReport);
  if (report.meta.failed || report.meta.pending) ctx.exitCode = ExitCode.partial;
}
