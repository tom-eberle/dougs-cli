import { isAbsolute, resolve } from 'node:path';
import type { Dougs } from '../api/dougs.js';
import { EXEMPTION_VALUES, normalizeOperation, percentToRate } from '../api/normalize.js';
import type { Operation, RawBreakdown, RawOperation } from '../api/schemas.js';
import { DougsError, ExitCode, errorPayload } from '../output/errors.js';
import { cents, vatFromGross } from '../util/money.js';
import { describeChanges, driftedFields, isSatisfied, targetBreakdown } from './diff.js';
import type { ApplyReport, Plan, PlanStep, SetChanges, SetStep, StepResult } from './types.js';

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  continueOnError?: boolean;
  /** Directory relative attach paths are resolved against (the plan file's). */
  baseDir?: string;
  onResult?: (result: StepResult) => void;
}

function rawBreakdown(raw: RawOperation, id: string): RawBreakdown {
  const b = raw.breakdowns.find((x) => String(x.id) === id);
  if (!b)
    throw new DougsError('NOT_FOUND', `Breakdown ${id} disappeared from operation ${raw.id}`, {
      exitCode: ExitCode.notFound,
    });
  return b;
}

/** Category first: an uncategorized breakdown has no associations, hence no exemption slot. */
async function setCategory(
  dougs: Dougs,
  raw: RawOperation,
  id: string,
  category: number,
): Promise<RawOperation> {
  const b = rawBreakdown(raw, id);
  if (b.categoryId === category) return raw;
  return dougs.updateOperation(raw, {
    ...b,
    categoryId: category,
    resolvedCategoryId: category,
    resolvedCategoryPath: [category],
    isManuallyCategorized: true,
  });
}

/**
 * VAT exemption takes two passes: zeroing the VAT is what makes Dougs offer the
 * `vatExemptionReason` association, so the reason can only be set afterwards.
 */
async function setExemption(
  dougs: Dougs,
  raw: RawOperation,
  id: string,
  kind: keyof typeof EXEMPTION_VALUES,
) {
  let b = rawBreakdown(raw, id);
  if (b.categoryId === -1)
    throw new DougsError(
      'CATEGORY_REQUIRED',
      `Operation ${raw.id} is uncategorized; Dougs needs a category before a VAT exemption`,
      {
        exitCode: ExitCode.usage,
        hint: 'add "category" to the same set step (see: dougs categories list)',
      },
    );
  let op = raw;
  if (b.vatAmount !== 0 || b.vatRate != null) {
    op = await dougs.updateOperation(op, {
      ...b,
      manualVatAmount: 0,
      vatAmount: 0,
      vatAmountWithRecoverageRate: 0,
      vatRate: null,
      isVatAmountManuallyModified: true,
      amountExcludingTaxesWithRecoverageRate: b.amount,
    });
    b = rawBreakdown(op, id);
  }
  if (b.associations && !b.associations.some((a) => a.name === 'vatExemptionReason'))
    throw new DougsError(
      'EXEMPTION_UNAVAILABLE',
      `Dougs offers no VAT exemption for operation ${raw.id} in its current category`,
      {
        exitCode: ExitCode.rejected,
        hint: 'set a purchase category that carries VAT (e.g. software, advertising) first',
      },
    );
  const reason = EXEMPTION_VALUES[kind];
  if (b.associationData?.vatExemptionReason === reason) return op;
  return dougs.updateOperation(op, {
    ...b,
    associationData: { ...(b.associationData ?? {}), vatExemptionReason: reason },
  });
}

/** Mirrors the web app's VAT edit (vatAmount + manualVatAmount), plus the rate. */
async function setVatRate(
  dougs: Dougs,
  raw: RawOperation,
  id: string,
  percent: number,
): Promise<RawOperation> {
  const b = rawBreakdown(raw, id);
  const vat = vatFromGross(b.amount, percent);
  const associationData = { ...(b.associationData ?? {}) };
  delete associationData.vatExemptionReason;
  return dougs.updateOperation(raw, {
    ...b,
    vatRate: percent === 0 ? null : percentToRate(percent),
    vatAmount: vat,
    manualVatAmount: vat,
    vatAmountWithRecoverageRate: vat,
    isVatAmountManuallyModified: true,
    amountExcludingTaxesWithRecoverageRate: cents(b.amount - vat),
    associationData,
  });
}

async function applySet(
  dougs: Dougs,
  raw: RawOperation,
  op: Operation,
  step: SetStep,
): Promise<void> {
  const id = targetBreakdown(op, step).id;
  const s: SetChanges = step.set;
  let current = raw;
  if (s.category !== undefined) current = await setCategory(dougs, current, id, s.category);
  if (s.vatExempt !== undefined) current = await setExemption(dougs, current, id, s.vatExempt);
  if (s.vatRate !== undefined) current = await setVatRate(dougs, current, id, s.vatRate);
  if (s.memo !== undefined && (current.memo ?? null) !== (s.memo ?? null))
    await dougs.updateOperation({ ...current, memo: s.memo });
}

async function perform(
  dougs: Dougs,
  raw: RawOperation,
  op: Operation,
  step: PlanStep,
  baseDir: string,
) {
  switch (step.action) {
    case 'set':
      return applySet(dougs, raw, op, step);
    case 'attach': {
      const path = isAbsolute(step.file) ? step.file : resolve(baseDir, step.file);
      return dougs.attachFiles(step.op, [{ path, name: step.name }]);
    }
    case 'detach':
      return dougs.detachAttachment(step.op, step.attachmentId);
    case 'validate':
      await dougs.updateOperation({ ...raw, validated: true });
  }
}

function summary(op: Operation): StepResult['operation'] {
  return { date: op.date, wording: op.wording, amount: op.amount, direction: op.direction };
}

/** Execute one step: re-read, skip if satisfied or drifted, write, verify. */
export async function executeStep(
  dougs: Dougs,
  step: PlanStep,
  options: ApplyOptions = {},
): Promise<StepResult> {
  const base = { step: step.id, op: step.op, action: step.action, why: step.why };
  const { raw, op } = await dougs.getOperation(step.op);
  const result = { ...base, operation: summary(op), changes: describeChanges(op, step) };
  if (isSatisfied(op, step))
    return { ...result, changes: [], status: 'skipped', reason: 'already satisfied' };
  const drift = driftedFields(op, step);
  if (drift.length && !options.force)
    return {
      ...result,
      status: 'skipped',
      reason: `operation changed since the plan was made (${drift.join(', ')}); review it or re-run with --force`,
    };
  if (options.dryRun) return { ...result, status: 'planned' };

  await perform(dougs, raw, op, step, options.baseDir ?? process.cwd());
  const after = normalizeOperation(await dougs.getRaw(step.op), { company: dougs.company });
  if (!isSatisfied(after, step))
    throw new DougsError(
      'VERIFY_FAILED',
      `Dougs accepted the change to operation ${step.op}, but re-reading it does not show it`,
      {
        exitCode: ExitCode.rejected,
        hint: 'inspect it with: dougs ops get <id>; Dougs may process attachments asynchronously',
      },
    );
  return { ...result, status: 'applied' };
}

/** Run a plan step by step. Stops at the first failure unless continueOnError. */
export async function applyPlan(
  dougs: Dougs,
  plan: Plan,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  if (plan.company !== dougs.company)
    throw new DougsError(
      'COMPANY_MISMATCH',
      `Plan is for company ${plan.company}, but company ${dougs.company} is selected`,
      {
        exitCode: ExitCode.usage,
        hint: `re-run with --company ${plan.company}`,
      },
    );
  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  let stopped = false;
  for (const step of plan.steps) {
    let result: StepResult;
    if (stopped) {
      result = {
        step: step.id,
        op: step.op,
        action: step.action,
        why: step.why,
        changes: [],
        status: 'pending',
        reason: 'not attempted after an earlier failure',
      };
    } else {
      try {
        result = await executeStep(dougs, step, options);
      } catch (error) {
        const { error: e } = errorPayload(error);
        result = {
          step: step.id,
          op: step.op,
          action: step.action,
          why: step.why,
          changes: [],
          status: 'failed',
          error: e,
        };
        if (!options.continueOnError) stopped = true;
      }
    }
    results.push(result);
    options.onResult?.(result);
  }
  const count = (status: StepResult['status']) => results.filter((r) => r.status === status).length;
  return {
    meta: {
      company: plan.company,
      createdBy: plan.createdBy,
      dryRun: !!options.dryRun,
      total: plan.steps.length,
      applied: count('applied'),
      planned: count('planned'),
      skipped: count('skipped'),
      failed: count('failed'),
      pending: count('pending'),
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    results,
  };
}
