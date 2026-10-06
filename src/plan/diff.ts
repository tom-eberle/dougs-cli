import { uploadName } from '../api/dougs.js';
import type { Breakdown, Operation } from '../api/schemas.js';
import { DougsError, ExitCode } from '../output/errors.js';
import { sameCents, vatFromGross } from '../util/money.js';
import type { Change, Expectation, PlanStep, SetChanges, SetStep } from './types.js';

/** The breakdown a set-step targets: explicit id, else the single main one. */
export function targetBreakdown(op: Operation, step: Pick<SetStep, 'breakdown'>): Breakdown {
  if (step.breakdown) {
    const b = op.breakdowns.find((x) => x.id === step.breakdown);
    if (!b)
      throw new DougsError('NOT_FOUND', `Operation ${op.id} has no breakdown ${step.breakdown}`, {
        exitCode: ExitCode.notFound,
      });
    return b;
  }
  const mains = op.breakdowns.filter((b) => !b.isCounterpart);
  if (mains.length !== 1)
    throw new DougsError(
      'SPLIT_OPERATION',
      `Operation ${op.id} has ${mains.length} main breakdowns`,
      {
        exitCode: ExitCode.usage,
        hint: `add "breakdown": "<id>" to the step (ids: ${mains.map((b) => b.id).join(', ') || 'none'})`,
      },
    );
  return mains[0]!;
}

function vatRateSatisfied(b: Breakdown, rate: number): boolean {
  const expected = vatFromGross(b.amount, rate);
  const rateOk = rate === 0 ? !b.vatRate : b.vatRate === rate;
  return rateOk && sameCents(b.vatAmount, expected, 0.011) && b.vatExemptReason === null;
}

function vatExemptSatisfied(b: Breakdown, kind: string): boolean {
  return b.vatExemptReason === kind && b.vatAmount === 0;
}

/** Field-level check of one set-change against a breakdown/operation. */
export function setFieldSatisfied(
  op: Operation,
  b: Breakdown,
  field: keyof SetChanges,
  value: unknown,
): boolean {
  switch (field) {
    case 'category':
      return b.category?.id === value;
    case 'vatRate':
      return vatRateSatisfied(b, value as number);
    case 'vatExempt':
      return vatExemptSatisfied(b, value as string);
    case 'memo':
      return (op.memo ?? null) === (value ?? null);
  }
}

/** True when the operation already is in the state the step asks for. */
export function isSatisfied(op: Operation, step: PlanStep): boolean {
  switch (step.action) {
    case 'attach':
      return op.attachments.some((a) => a.filename === (step.name ?? uploadName(step.file)));
    case 'detach':
      return !op.attachments.some((a) => a.id === step.attachmentId);
    case 'validate':
      return op.validated;
    case 'set': {
      const b = targetBreakdown(op, step);
      return (Object.entries(step.set) as [keyof SetChanges, unknown][]).every(([field, value]) =>
        setFieldSatisfied(op, b, field, value),
      );
    }
  }
}

/** State captured into a plan's `expect`, compared again at apply time. */
export function observe(op: Operation, breakdown?: Breakdown): Required<Expectation> {
  const b = breakdown ?? op.breakdowns.filter((x) => !x.isCounterpart)[0];
  return {
    category: b?.category?.id ?? -1,
    vatRate: b?.vatRate ?? null,
    vatAmount: b?.vatAmount ?? null,
    vatExemptReason: b?.vatExemptReason ?? null,
    memo: op.memo,
    validated: op.validated,
    attachments: op.attachments.length,
  };
}

/**
 * Values a field may legitimately hold besides its plan-time value: the step's
 * own target (and intermediate states), so a partially applied step resumes
 * instead of being reported as changed by someone else.
 */
function targetValues(
  step: PlanStep,
  b: Breakdown | undefined,
): Partial<Record<keyof Expectation, unknown[]>> {
  switch (step.action) {
    case 'validate':
      return { validated: [true] };
    case 'attach':
    case 'detach':
      return {};
    case 'set': {
      const s = step.set;
      const t: Partial<Record<keyof Expectation, unknown[]>> = {};
      if (s.category !== undefined) t.category = [s.category];
      if (s.memo !== undefined) t.memo = [s.memo];
      if (s.vatExempt !== undefined) {
        t.vatAmount = [0];
        t.vatRate = [null, 0];
        t.vatExemptReason = [s.vatExempt];
      }
      if (s.vatRate !== undefined && b) {
        t.vatAmount = [vatFromGross(b.amount, s.vatRate)];
        t.vatRate = [s.vatRate];
        t.vatExemptReason = [null];
      }
      return t;
    }
  }
}

/** Expectation fields that no longer hold. Empty when the op is unchanged. */
export function driftedFields(op: Operation, step: PlanStep): string[] {
  if (!step.expect) return [];
  const b = step.action === 'set' ? targetBreakdown(op, step) : undefined;
  const current = observe(op, b);
  const allowed = targetValues(step, b);
  const same = (a: unknown, c: unknown) => JSON.stringify(a) === JSON.stringify(c);
  return (Object.keys(step.expect) as (keyof Expectation)[]).filter((key) => {
    const value = current[key];
    if (same(value, step.expect?.[key])) return false;
    if (step.action === 'attach' && key === 'attachments') return false;
    return !(allowed[key] ?? []).some((target) => same(value, target));
  });
}

/** Before → after for review output. */
export function describeChanges(op: Operation, step: PlanStep): Change[] {
  switch (step.action) {
    case 'attach':
      return [
        {
          field: 'attachments',
          from: op.attachments.length,
          to: `+ ${step.name ?? uploadName(step.file)}`,
        },
      ];
    case 'detach': {
      const att = op.attachments.find((a) => a.id === step.attachmentId);
      return [{ field: 'attachments', from: att?.filename ?? step.attachmentId, to: null }];
    }
    case 'validate':
      return [{ field: 'validated', from: op.validated, to: true }];
    case 'set': {
      const b = targetBreakdown(op, step);
      const changes: Change[] = [];
      const s = step.set;
      if (s.category !== undefined && b.category?.id !== s.category)
        changes.push({ field: 'category', from: b.category?.id ?? -1, to: s.category });
      if (s.vatRate !== undefined) {
        changes.push({ field: 'vatRate', from: b.vatRate, to: s.vatRate });
        changes.push({
          field: 'vatAmount',
          from: b.vatAmount,
          to: vatFromGross(b.amount, s.vatRate),
        });
        if (b.vatExemptReason)
          changes.push({ field: 'vatExemptReason', from: b.vatExemptReason, to: null });
      }
      if (s.vatExempt !== undefined) {
        if (b.vatAmount !== 0) changes.push({ field: 'vatAmount', from: b.vatAmount, to: 0 });
        if (b.vatExemptReason !== s.vatExempt)
          changes.push({ field: 'vatExemptReason', from: b.vatExemptReason, to: s.vatExempt });
      }
      if (s.memo !== undefined && (op.memo ?? null) !== (s.memo ?? null))
        changes.push({ field: 'memo', from: op.memo, to: s.memo });
      return changes;
    }
  }
}
