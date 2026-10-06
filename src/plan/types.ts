import { z } from 'zod';
export const setSchema = z
  .strictObject({
    category: z.number().int().nonnegative().optional(),
    vatRate: z.number().min(0).max(100).optional(),
    vatExempt: z.enum(['outside-eu', 'inside-eu', 'no-document']).optional(),
    memo: z.string().nullable().optional(),
  })
  .refine((s) => Object.keys(s).length > 0, 'At least one change is required')
  .refine(
    (s) => !(s.vatRate !== undefined && s.vatExempt !== undefined),
    'vatRate and vatExempt are mutually exclusive',
  );
export type Changes = z.infer<typeof setSchema>;
export const expectSchema = z.strictObject({
  category: z.number().nullable().optional(),
  vatRate: z.number().nullable().optional(),
  vatAmount: z.number().nullable().optional(),
  vatExemptReason: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  validated: z.boolean().optional(),
  amount: z.number().optional(),
  date: z.string().optional(),
  attachments: z.array(z.string()).optional(),
});
const common = {
  id: z.string().min(1),
  op: z.string().regex(/^\d+$/),
  why: z.string().min(1),
  expect: expectSchema.optional(),
};
export const stepSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('set'), set: setSchema }),
  z.strictObject({
    ...common,
    action: z.literal('attach'),
    file: z.string().min(1),
    name: z.string().optional(),
  }),
  z.strictObject({
    ...common,
    action: z.literal('detach'),
    attachmentId: z.string().regex(/^\d+$/),
  }),
  z.strictObject({ ...common, action: z.literal('validate') }),
]);
export type PlanStep = z.infer<typeof stepSchema>;
export const planSchema = z
  .strictObject({
    version: z.literal(1),
    company: z.string().regex(/^\d+$/),
    createdAt: z.iso.datetime(),
    createdBy: z.string().min(1),
    steps: z.array(stepSchema),
  })
  .refine(
    (p) => new Set(p.steps.map((s) => s.id)).size === p.steps.length,
    'Step ids must be unique',
  );
export type Plan = z.infer<typeof planSchema>;
