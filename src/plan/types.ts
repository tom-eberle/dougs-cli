import { z } from 'zod';
import { vatExemptKindSchema } from '../api/schemas.js';
import { FRENCH_VAT_RATES } from '../util/money.js';

/*
 * Plans are the contract between an agent that proposes changes and a human
 * (or agent) that approves them. Plain JSON, safe to edit by hand.
 */

export const setChangesSchema = z
  .strictObject({
    category: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Dougs category id (see: dougs categories list)'),
    vatRate: z
      .number()
      .refine((r) => (FRENCH_VAT_RATES as readonly number[]).includes(r), {
        message: `vatRate must be one of ${FRENCH_VAT_RATES.join(', ')}`,
      })
      .optional()
      .describe('Percent; sets the VAT amount from the gross amount and clears any exemption'),
    vatExempt: vatExemptKindSchema
      .optional()
      .describe(
        'Zero the VAT and record why: supplier outside the EU, inside the EU, or no document',
      ),
    memo: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (s) => Object.keys(s).length > 0,
    'set needs at least one of category, vatRate, vatExempt, memo',
  )
  .refine(
    (s) => s.vatRate === undefined || s.vatExempt === undefined,
    'vatRate and vatExempt are mutually exclusive',
  );
export type SetChanges = z.infer<typeof setChangesSchema>;

export const expectSchema = z
  .strictObject({
    category: z.number().int().optional().describe('-1 means uncategorized'),
    vatRate: z.number().nullable().optional(),
    vatAmount: z.number().nullable().optional(),
    vatExemptReason: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    validated: z.boolean().optional(),
    attachments: z.number().int().optional().describe('Number of attachments'),
  })
  .describe(
    'State observed when the plan was made; if it changed, apply reports the step as a conflict (exit 7) unless --force. `validated` is recorded to restore it after a reopen, not to detect drift.',
  );
export type Expectation = z.infer<typeof expectSchema>;

const stepBase = {
  id: z.string().min(1),
  op: z.string().regex(/^\d+$/, 'op must be a numeric operation id'),
  why: z.string().min(1).describe('Human-readable justification, shown on review'),
  expect: expectSchema.optional(),
};

export const setStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('set'),
  set: setChangesSchema,
  breakdown: z.string().optional().describe('Breakdown id; only needed for split operations'),
});

export const attachStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('attach'),
  file: z.string().min(1).describe('Path, relative to the plan file'),
  name: z
    .string()
    .optional()
    .describe('Display name in Dougs (default: file name without a leading "<digits>_")'),
});

export const detachStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('detach'),
  attachmentId: z.string().regex(/^\d+$/),
});

export const validateStepSchema = z.strictObject({ ...stepBase, action: z.literal('validate') });

/** Integer cents, so sums compare exactly (0.1 + 0.2 = 0.3). */
export const toCents = (eur: number): number => Math.round(eur * 100);

const amount = z
  .number()
  .positive()
  .refine((v) => Math.abs(v * 100 - toCents(v)) < 1e-6, 'amounts have at most 2 decimals')
  .describe('EUR, positive, at most 2 decimals');

/**
 * Zones of exempt service sales (`exemption:inbound:*`). Other kinds of sales
 * (French VAT rates, goods) are not supported yet.
 */
export const VENTILATION_ZONES = ['inside-eu', 'outside-eu'] as const;
export type VentilationZone = (typeof VENTILATION_ZONES)[number];

export const ventilationSchema = z
  .strictObject({
    sales: z
      .array(
        z.strictObject({
          zone: z
            .enum(VENTILATION_ZONES)
            .describe('Exempt service sales to customers inside / outside the EU'),
          amount,
        }),
      )
      .min(1)
      .describe('One line per zone'),
    fees: z
      .array(
        z.strictObject({
          paymentsProcessorId: z
            .number()
            .int()
            .positive()
            .describe("Payment processor of the operation's sales channel (Dougs id)"),
          amount,
        }),
      )
      .optional()
      .describe('Commissions kept by the platform, one line per payment processor'),
    net: z
      .number()
      .describe('sum(sales) − sum(fees), to the cent: what the counterpart line ends at'),
    validate: z.boolean().optional().describe('Validate the operation once it is filled'),
  })
  .refine((v) => new Set(v.sales.map((s) => s.zone)).size === v.sales.length, {
    message: 'each zone appears once in sales',
    path: ['sales'],
  })
  .refine(
    (v) => new Set((v.fees ?? []).map((f) => f.paymentsProcessorId)).size === (v.fees ?? []).length,
    { message: 'each paymentsProcessorId appears once in fees', path: ['fees'] },
  )
  .refine((v) => toCents(v.net) === ventilationNetCents(v), {
    message: 'net must equal sum(sales) − sum(fees) to the cent',
    path: ['net'],
  });
export type Ventilation = z.infer<typeof ventilationSchema>;

export function ventilationNetCents(v: {
  sales: readonly { amount: number }[];
  fees?: readonly { amount: number }[];
}): number {
  const sum = (lines: readonly { amount: number }[]) =>
    lines.reduce((total, l) => total + toCents(l.amount), 0);
  return sum(v.sales) - sum(v.fees ?? []);
}

export const ventilateStepSchema = z
  .strictObject({
    ...stepBase,
    action: z.literal('ventilate'),
    ventilate: ventilationSchema,
  })
  .describe(
    'Fill an empty e-commerce ventilation (operation type dispatch:ecommerce:salesChannel) with sales and commission lines',
  );

export const planStepSchema = z.discriminatedUnion('action', [
  setStepSchema,
  attachStepSchema,
  detachStepSchema,
  validateStepSchema,
  ventilateStepSchema,
]);
export type PlanStep = z.infer<typeof planStepSchema>;
export type SetStep = z.infer<typeof setStepSchema>;
export type VentilateStep = z.infer<typeof ventilateStepSchema>;

export const planSchema = z
  .strictObject({
    version: z.literal(1),
    company: z.string().regex(/^\d+$/),
    createdAt: z.string(),
    createdBy: z.string(),
    steps: z.array(planStepSchema),
  })
  .refine(
    (p) => new Set(p.steps.map((s) => s.id)).size === p.steps.length,
    'step ids must be unique',
  )
  .describe('A reviewable list of changes, executed by: dougs apply <plan.json>');
export type Plan = z.infer<typeof planSchema>;

/** A step without its id; ids are assigned when the plan is assembled. */
export type StepDraft = PlanStep extends infer S
  ? S extends PlanStep
    ? Omit<S, 'id'>
    : never
  : never;

export const changeSchema = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type Change = z.infer<typeof changeSchema>;

export const STEP_STATUSES = [
  'applied',
  'planned',
  'skipped',
  'conflict',
  'failed',
  'pending',
] as const;

export const stepResultSchema = z.object({
  step: z.string(),
  op: z.string(),
  action: z.enum(['set', 'attach', 'detach', 'validate', 'ventilate']),
  status: z.enum(STEP_STATUSES),
  reason: z.string().optional(),
  why: z.string(),
  file: z
    .string()
    .optional()
    .describe('Attach steps: the resolved absolute path that is (or would be) uploaded'),
  operation: z
    .object({
      date: z.string(),
      wording: z.string(),
      amount: z.number(),
      direction: z.enum(['expense', 'income']),
    })
    .optional(),
  changes: z.array(changeSchema),
  sideEffects: z
    .array(changeSchema)
    .optional()
    .describe(
      'Changes Dougs made that the step did not ask for (seen when re-reading after the write)',
    ),
  error: z
    .object({ code: z.string(), message: z.string(), hint: z.string().optional() })
    .optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const applyReportSchema = z
  .object({
    meta: z.object({
      company: z.string(),
      createdBy: z.string(),
      dryRun: z.boolean(),
      total: z.number(),
      applied: z.number(),
      planned: z.number(),
      skipped: z.number(),
      conflicts: z
        .number()
        .describe('Steps not applied because the operation changed since planning'),
      failed: z.number(),
      sideEffects: z.number().describe('Applied steps where Dougs also changed something else'),
      pending: z.number(),
      startedAt: z.string(),
      finishedAt: z.string(),
    }),
    results: z.array(stepResultSchema),
  })
  .describe('Result of dougs apply; usable as an audit log');
export type ApplyReport = z.infer<typeof applyReportSchema>;

export function buildPlan(
  company: string,
  createdBy: string,
  drafts: StepDraft[],
  now = new Date(),
): Plan {
  return {
    version: 1,
    company,
    createdAt: now.toISOString(),
    createdBy,
    steps: drafts.map((d, i) => ({ id: `s${i + 1}`, ...d }) as PlanStep),
  };
}
