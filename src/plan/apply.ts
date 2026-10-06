import type { Dougs, PeriodGuard } from '../api/dougs.js';
import { uploadName } from '../api/dougs.js';
import { EXEMPTION_VALUES, normalizeOperation, percentToRate } from '../api/normalize.js';
import type { Operation, RawBreakdown, RawOperation } from '../api/schemas.js';
import { DougsError, ExitCode, errorPayload, toDougsError } from '../output/errors.js';
import { vatFromGross } from '../util/money.js';
import { readUpload, resolveUpload } from './attachments.js';
import {
  describeChanges,
  driftedFields,
  expectedKeys,
  isSatisfied,
  snapshot,
  snapshotDiff,
  targetBreakdown,
} from './diff.js';
import type {
  ApplyReport,
  Change,
  Plan,
  PlanStep,
  SetChanges,
  SetStep,
  StepResult,
} from './types.js';

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  continueOnError?: boolean;
  /** Directory relative attach paths are resolved against (the plan file's). */
  baseDir?: string;
  /** Allow attach steps to upload files outside the plan directory and cwd. */
  allowAnyPath?: boolean;
  /** Filed VAT periods / closed years; set and validate steps there are refused. */
  periods?: PeriodGuard;
  allowFiledPeriods?: boolean;
  onResult?: (result: StepResult) => void;
}

/** A step failure that may have left changes behind (reported in the audit log). */
export class StepError extends DougsError {
  constructor(
    base: DougsError,
    readonly changes: Change[],
  ) {
    super(base.code, base.message, {
      exitCode: base.exitCode,
      hint: base.hint,
      status: base.status,
    });
  }
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
 * If the second pass turns out to be impossible, the first is rolled back so
 * deductible VAT is not silently lost.
 */
async function setExemption(
  dougs: Dougs,
  raw: RawOperation,
  id: string,
  kind: keyof typeof EXEMPTION_VALUES,
) {
  const original = rawBreakdown(raw, id);
  if (original.categoryId === -1)
    throw new DougsError(
      'CATEGORY_REQUIRED',
      `Operation ${raw.id} is uncategorized; Dougs needs a category before a VAT exemption`,
      {
        exitCode: ExitCode.usage,
        hint: 'add "category" to the same set step (see: dougs categories list)',
      },
    );
  let op = raw;
  let b = original;
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
  if (b.associations && !b.associations.some((a) => a.name === 'vatExemptionReason')) {
    if (b !== original) {
      const restored = rawBreakdown(await dougs.updateOperation(op, original), id);
      if (restored.vatAmount !== original.vatAmount)
        throw new DougsError(
          'PARTIALLY_APPLIED',
          `Operation ${raw.id}: VAT was zeroed but no exemption could be recorded, and restoring the VAT failed`,
          { exitCode: ExitCode.rejected, hint: 'fix the VAT by hand in Dougs: dougs ops get <id>' },
        );
    }
    throw new DougsError(
      'EXEMPTION_UNAVAILABLE',
      `Dougs offers no VAT exemption for operation ${raw.id} in its current category${b !== original ? ' (its VAT was restored)' : ''}`,
      {
        exitCode: ExitCode.rejected,
        hint: 'set a purchase category that carries VAT (e.g. software, advertising) first',
      },
    );
  }
  const reason = EXEMPTION_VALUES[kind];
  if (b.associationData?.vatExemptionReason === reason) return op;
  return dougs.updateOperation(op, {
    ...b,
    associationData: { ...(b.associationData ?? {}), vatExemptionReason: reason },
  });
}

/**
 * Mirrors the web app's VAT edit (vatAmount + manualVatAmount) plus the rate.
 * The recoverable-VAT fields are left for the server to compute, so partially
 * recoverable categories stay correct.
 */
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
  const {
    vatAmountWithRecoverageRate: _recoverable,
    amountExcludingTaxesWithRecoverageRate: _net,
    ...rest
  } = b;
  return dougs.updateOperation(raw, {
    ...rest,
    vatRate: percent === 0 ? null : percentToRate(percent),
    vatAmount: vat,
    manualVatAmount: vat,
    isVatAmountManuallyModified: true,
    associationData,
  } as RawBreakdown);
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
  // Like the reference scripts, send the (unchanged) main breakdown as
  // updatedBreakdown with a memo edit; the server ignores it otherwise.
  if (s.memo !== undefined && (current.memo ?? null) !== (s.memo ?? null))
    await dougs.updateOperation({ ...current, memo: s.memo }, rawBreakdown(current, id));
}

/** What the web app checks before letting a user validate an operation. */
export function validationProblems(raw: RawOperation): string[] {
  const problems: string[] = [];
  if (raw.errors?.length) problems.push(`Dougs reports ${raw.errors.length} error(s) on it`);
  const mains = raw.breakdowns.filter((b) => !b.isCounterpart);
  if (mains.some((b) => b.categoryId === -1)) problems.push('a breakdown is uncategorized');
  const signed = (inbound: boolean, amount: number) => (inbound ? amount : -amount);
  const total = mains.reduce((s, b) => s + signed(b.isInbound ?? raw.isInbound, b.amount), 0);
  if (mains.length && Math.abs(total - signed(raw.isInbound, raw.amount)) > 0.01)
    problems.push('its breakdowns do not add up to the operation amount');
  for (const b of mains) {
    const slot = b.associations?.find((a) => a.name === 'vatExemptionReason');
    const reason = (slot?.slots as { reason?: { isOptional?: boolean } } | undefined)?.reason;
    if (
      slot &&
      reason?.isOptional === false &&
      b.vatAmount === 0 &&
      !b.associationData?.vatExemptionReason
    )
      problems.push('zero VAT without the exemption reason Dougs requires');
  }
  return problems;
}

/** Refusals that apply in previews and at apply time alike. */
function guard(raw: RawOperation, op: Operation, step: PlanStep, options: ApplyOptions): void {
  const writesLedger = step.action === 'set' || step.action === 'validate';
  if (writesLedger && op.locked)
    throw new DougsError(
      'LOCKED',
      `Operation ${op.id} is locked in Dougs (${raw.manuallyLocked ? 'manually' : 'by a closed period'})`,
      {
        exitCode: ExitCode.rejected,
        hint: 'unlock it in the Dougs web app (accountant action) if the change is really needed',
      },
    );
  const period = writesLedger ? options.periods?.reason(op.date) : null;
  if (period && !options.allowFiledPeriods)
    throw new DougsError(
      'FILED_PERIOD',
      `Operation ${op.id} (${op.date}) is in a closed period: ${period}`,
      {
        exitCode: ExitCode.usage,
        hint: 'editing it desynchronizes the books from what was filed; re-run with --allow-filed-periods if you really mean it',
      },
    );
  if (step.action === 'validate' && !op.validated) {
    const problems = validationProblems(raw);
    if (problems.length)
      throw new DougsError(
        'NOT_VALIDATABLE',
        `Operation ${op.id} cannot be validated: ${problems.join('; ')}`,
        {
          exitCode: ExitCode.usage,
          hint: 'fix it first (dougs ops get <id>), then validate',
        },
      );
  }
}

function summary(op: Operation): StepResult['operation'] {
  return { date: op.date, wording: op.wording, amount: op.amount, direction: op.direction };
}

/** Execute one step: re-read, check, skip if satisfied or drifted, write, verify. */
export async function executeStep(
  dougs: Dougs,
  step: PlanStep,
  options: ApplyOptions = {},
): Promise<StepResult> {
  const policy = {
    baseDir: options.baseDir ?? process.cwd(),
    cwd: process.cwd(),
    allowAnyPath: options.allowAnyPath,
  };
  // Validate an upload first, so an unsafe plan fails at preview time.
  const uploadPath = step.action === 'attach' ? resolveUpload(step.file, policy) : undefined;
  const base = {
    step: step.id,
    op: step.op,
    action: step.action,
    why: step.why,
    ...(uploadPath ? { file: uploadPath } : {}),
  };
  const { raw, op } = await dougs.getOperation(step.op);
  const result = { ...base, operation: summary(op), changes: describeChanges(op, step) };
  if (isSatisfied(op, step))
    return { ...result, changes: [], status: 'skipped', reason: 'already satisfied' };
  guard(raw, op, step, options);
  const drift = driftedFields(op, step);
  if (drift.length && !options.force)
    return {
      ...result,
      status: 'conflict',
      reason: `operation changed since the plan was made (${drift.join(', ')}); review it or re-run with --force`,
    };
  if (options.dryRun) return { ...result, status: 'planned' };

  const before = snapshot(op);
  try {
    if (step.action === 'attach') {
      // Read the exact bytes that were checked (no path re-read later: TOCTOU-safe).
      const upload = await readUpload(step.file, policy);
      await dougs.attachFiles(step.op, [
        { bytes: upload.bytes, name: step.name ?? uploadName(upload.path) },
      ]);
    } else if (step.action === 'detach') await dougs.detachAttachment(step.op, step.attachmentId);
    else if (step.action === 'validate') await dougs.updateOperation({ ...raw, validated: true });
    else await applySet(dougs, raw, op, step);
  } catch (error) {
    // Report what actually changed, so the audit log never claims "nothing" wrongly.
    const now = await dougs.getOperation(step.op).catch(() => null);
    const left = now ? snapshotDiff(before, snapshot(now.op)) : [];
    const e = toDougsError(error);
    if (!left.length) throw e;
    throw new StepError(
      new DougsError('PARTIALLY_APPLIED', `${e.message} (some changes were saved)`, {
        exitCode: e.exitCode,
        hint: e.hint,
      }),
      left,
    );
  }
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
  const sideEffects = snapshotDiff(before, snapshot(after), expectedKeys(op, step));
  return { ...result, status: 'applied', ...(sideEffects.length ? { sideEffects } : {}) };
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
      { exitCode: ExitCode.usage, hint: `re-run with --company ${plan.company}` },
    );
  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  let stopped = false;
  for (const step of plan.steps) {
    const base = { step: step.id, op: step.op, action: step.action, why: step.why };
    let result: StepResult;
    if (stopped) {
      result = {
        ...base,
        changes: [],
        status: 'pending',
        reason: 'not attempted after an earlier failure',
      };
    } else {
      try {
        result = await executeStep(dougs, step, options);
      } catch (error) {
        const { error: e } = errorPayload(error);
        const changes = error instanceof StepError ? error.changes : [];
        result = { ...base, changes, status: 'failed', error: e };
        if (!options.continueOnError) stopped = true;
      }
    }
    results.push(result);
    options.onResult?.(result);
  }
  return reportOf(plan, results, !!options.dryRun, startedAt);
}

export function reportOf(
  plan: Plan,
  results: StepResult[],
  dryRun: boolean,
  startedAt: string,
): ApplyReport {
  const count = (status: StepResult['status']) => results.filter((r) => r.status === status).length;
  return {
    meta: {
      company: plan.company,
      createdBy: plan.createdBy,
      dryRun,
      total: plan.steps.length,
      applied: count('applied'),
      planned: count('planned'),
      skipped: count('skipped'),
      conflicts: count('conflict'),
      failed: count('failed'),
      sideEffects: results.filter((r) => r.sideEffects?.length).length,
      pending: count('pending'),
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    results,
  };
}
