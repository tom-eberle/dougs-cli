import { basename } from 'node:path';
import { Resources, uploadName } from '../api/resources.js';
import {
  exemptionValues,
  normalizeOperation,
  type Operation,
  type RawBreakdown,
  type RawOperation,
  round,
} from '../api/schemas.js';
import { DougsError, errorObject } from '../output/errors.js';
import type { Changes, Plan, PlanStep } from './types.js';
export function satisfied(op: Operation, step: PlanStep): boolean {
  if (step.action === 'attach')
    return op.attachments.some(
      (a) => a.filename === (step.name ?? uploadName(step.file)),
    );
  if (step.action === 'detach')
    return !op.attachments.some((a) => a.id === step.attachmentId);
  if (step.action === 'validate') return op.validated;
  const s = step.set;
  const main = op.breakdowns.filter((b) => !b.isCounterpart);
  if (
    main.length !== 1 &&
    (s.category !== undefined ||
      s.vatRate !== undefined ||
      s.vatExempt !== undefined)
  )
    return false;
  return (
    (s.category === undefined || op.category?.id === s.category) &&
    (s.vatRate === undefined || op.vatRate === s.vatRate) &&
    (s.vatExempt === undefined ||
      (op.vatExemptReason === s.vatExempt &&
        op.vatAmount === 0 &&
        op.amountExcludingVat === op.amount)) &&
    (s.memo === undefined || op.memo === s.memo)
  );
}
export function observed(op: Operation) {
  return {
    category: op.category?.id ?? -1,
    vatRate: op.vatRate,
    vatAmount: op.vatAmount,
    vatExemptReason: op.vatExemptReason,
    memo: op.memo,
    validated: op.validated,
    amount: op.amount,
    date: op.date,
    attachments: op.attachments.map((a) => a.id).sort(),
  };
}
export function stale(op: Operation, step: PlanStep): boolean {
  const current = observed(op);
  return Object.entries(step.expect ?? {}).some(
    ([k, v]) =>
      JSON.stringify(current[k as keyof typeof current]) !== JSON.stringify(v),
  );
}
export function diff(op: Operation, step: PlanStep) {
  return {
    step: step.id,
    op: op.id,
    action: step.action,
    why: step.why,
    before: observed(op),
    after:
      step.action === 'set'
        ? step.set
        : step.action === 'attach'
          ? { filename: step.name ?? uploadName(step.file) }
          : step.action === 'detach'
            ? { remove: step.attachmentId }
            : { validated: true },
  };
}
function main(raw: RawOperation): RawBreakdown {
  const mains = raw.breakdowns.filter((b) => !b.isCounterpart);
  if (mains.length !== 1)
    throw new DougsError(
      'SPLIT_OPERATION',
      'Edit needs exactly one main breakdown',
      2,
      'inspect with ops get; edit split operations in the web app',
    );
  return mains[0]!;
}
async function update(
  resources: Resources,
  raw: RawOperation,
  b?: RawBreakdown,
): Promise<RawOperation> {
  await resources.client.request(
    'POST',
    `${resources.path(String(raw.id))}?force=true`,
    {
      ...raw,
      ...(b
        ? {
            breakdowns: raw.breakdowns.map((x) =>
              String(x.id) === String(b.id) ? b : x,
            ),
            updatedBreakdown: b,
          }
        : {}),
    },
  );
  return resources.get(String(raw.id));
}
export async function setOperation(
  resources: Resources,
  raw: RawOperation,
  changes: Changes,
): Promise<void> {
  let op = raw;
  if (changes.category !== undefined) {
    const b = main(op);
    op = await update(resources, op, {
      ...b,
      categoryId: changes.category,
      resolvedCategoryId: changes.category,
      resolvedCategoryPath: [changes.category],
      isManuallyCategorized: true,
    });
  }
  if (changes.vatExempt) {
    let b = main(op);
    if (b.categoryId === -1)
      throw new DougsError(
        'CATEGORY_REQUIRED',
        'Set a category before a VAT exemption',
        2,
        'include --category in the same change',
      );
    op = await update(resources, op, {
      ...b,
      manualVatAmount: 0,
      vatAmount: 0,
      vatAmountWithRecoverageRate: 0,
      vatRate: null,
      isVatAmountManuallyModified: true,
      amountExcludingTaxesWithRecoverageRate: b.amount,
    });
    b = main(op);
    op = await update(resources, op, {
      ...b,
      associationData: {
        ...b.associationData,
        vatExemptionReason: exemptionValues[changes.vatExempt],
      },
    });
  } else if (changes.vatRate !== undefined) {
    const b = main(op);
    const rate = changes.vatRate / 100;
    const vat = round(b.amount - b.amount / (1 + rate));
    const associationData = { ...b.associationData };
    delete associationData.vatExemptionReason;
    op = await update(resources, op, {
      ...b,
      vatRate: rate,
      manualVatAmount: vat,
      vatAmount: vat,
      vatAmountWithRecoverageRate: vat,
      isVatAmountManuallyModified: true,
      amountExcludingTaxesWithRecoverageRate: round(b.amount - vat),
      associationData,
    });
  }
  if (changes.memo !== undefined)
    await update(resources, { ...op, memo: changes.memo });
}
export interface StepResult {
  step: string;
  op: string;
  status: 'applied' | 'skipped' | 'failed' | 'dry-run';
  reason?: string;
  diff?: ReturnType<typeof diff>;
  error?: ReturnType<typeof errorObject>['error'];
}
export async function execute(
  resources: Resources,
  step: PlanStep,
  o: { dryRun?: boolean; force?: boolean } = {},
): Promise<StepResult> {
  const raw = await resources.get(step.op);
  const op = normalizeOperation(raw, resources.company);
  const base = { step: step.id, op: step.op };
  if (satisfied(op, step))
    return { ...base, status: 'skipped', reason: 'already satisfied' };
  if (stale(op, step) && !o.force)
    return {
      ...base,
      status: 'skipped',
      reason: 'state changed since plan; review or use --force',
      diff: diff(op, step),
    };
  if (o.dryRun) return { ...base, status: 'dry-run', diff: diff(op, step) };
  if (step.action === 'set') await setOperation(resources, raw, step.set);
  else if (step.action === 'attach')
    await resources.attach(
      step.op,
      step.file,
      step.name ? basename(step.name) : undefined,
    );
  else if (step.action === 'detach')
    await resources.client.request(
      'DELETE',
      `${resources.path(step.op)}/source-document-attachments/${step.attachmentId}`,
    );
  else await update(resources, { ...raw, validated: true });
  const after = normalizeOperation(
    await resources.get(step.op),
    resources.company,
  );
  if (!satisfied(after, step))
    throw new DougsError(
      'VERIFY_FAILED',
      'API accepted the request but the requested state was not observed',
      5,
      're-read the operation before retrying',
    );
  return { ...base, status: 'applied', diff: diff(op, step) };
}
export async function applyPlan(
  resources: Resources,
  plan: Plan,
  o: { dryRun?: boolean; force?: boolean; continueOnError?: boolean } = {},
) {
  if (plan.company !== resources.company)
    throw new DougsError(
      'COMPANY_MISMATCH',
      'Plan company differs from selected company',
      2,
      'select the plan company explicitly',
    );
  const results: StepResult[] = [];
  for (const step of plan.steps) {
    try {
      results.push(await execute(resources, step, o));
    } catch (error) {
      results.push({
        step: step.id,
        op: step.op,
        status: 'failed',
        error: errorObject(error).error,
      });
      if (!o.continueOnError) break;
    }
  }
  return {
    results,
    meta: {
      applied: results.filter((r) => r.status === 'applied').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      pending: plan.steps.length - results.length,
    },
  };
}
