import { z } from 'zod';
export const idSchema = z.union([z.string(), z.number()]);
const nullableNumber = z.number().nullable().optional();
export const rawBreakdownSchema = z.looseObject({
  id: idSchema,
  amount: z.number(),
  isCounterpart: z.boolean(),
  categoryId: z.number(),
  resolvedCategoryId: z.number().optional(),
  resolvedCategoryPath: z.array(z.number()).optional(),
  categoryWording: z.string().optional(),
  categoryGroup: z.looseObject({ name: z.string().optional() }).optional(),
  vatRate: nullableNumber,
  vatAmount: z.number(),
  amountExcludingTaxesWithRecoverageRate: z.number(),
  associationData: z.record(z.string(), z.unknown()).optional(),
});
export const rawFileSchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});
export const rawAttachmentSchema = z.looseObject({
  id: idSchema,
  sourceDocument: z.looseObject({
    id: idSchema,
    type: z.string(),
    file: rawFileSchema.nullable().optional(),
    externalId: z.string().nullable().optional(),
  }),
});
export const rawOperationSchema = z.looseObject({
  id: idSchema,
  companyId: idSchema.optional(),
  date: z.string(),
  wording: z.string(),
  amount: z.number(),
  isInbound: z.boolean(),
  validated: z.boolean(),
  memo: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
  excluded: z.boolean().optional(),
  breakdowns: z.array(rawBreakdownSchema),
  transaction: z
    .looseObject({
      accountId: idSchema,
      currency: z.string().optional(),
      changeRate: z.number().optional(),
      amount: z.number().optional(),
    })
    .nullable()
    .optional(),
  sourceDocumentAttachments: z.array(rawAttachmentSchema),
});
export type RawOperation = z.infer<typeof rawOperationSchema>;
export type RawBreakdown = z.infer<typeof rawBreakdownSchema>;
export const categorySchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.array(z.string()),
});
export const attachmentSchema = z.object({
  id: z.string(),
  fileId: z.string().nullable(),
  filename: z.string(),
  type: z.string(),
});
export const breakdownSchema = z.object({
  id: z.string(),
  isCounterpart: z.boolean(),
  category: categorySchema.nullable(),
  amount: z.number(),
  amountExcludingVat: z.number(),
  vatRate: z.number().nullable(),
  vatAmount: z.number(),
  vatExemptReason: z.string().nullable(),
});
export const operationSchema = z.object({
  id: z.string(),
  date: z.iso.date(),
  wording: z.string(),
  amount: z.number(),
  direction: z.enum(['expense', 'income']),
  validated: z.boolean(),
  memo: z.string().nullable(),
  account: z.object({ id: z.string(), name: z.string() }).nullable(),
  breakdowns: z.array(breakdownSchema),
  category: categorySchema.nullable(),
  vatRate: z.number().nullable(),
  vatAmount: z.number().nullable(),
  amountExcludingVat: z.number().nullable(),
  vatExemptReason: z.string().nullable(),
  attachments: z.array(attachmentSchema),
  url: z.string(),
});
export type Operation = z.infer<typeof operationSchema>;
export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  bank: z.string(),
  currency: z.string(),
  balance: z.number().nullable(),
  balanceUpdatedAt: z.string().nullable(),
  closed: z.boolean(),
  hidden: z.boolean(),
});
export const companySchema = z.object({ id: z.string(), name: z.string() });
export const userSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});
export const whoamiSchema = z.object({
  user: userSchema,
  companies: z.array(companySchema),
  activeCompany: z.string().nullable(),
  authSource: z.string(),
});
export const round = (n: number) =>
  Math.round((n + Number.EPSILON) * 100) / 100;
export const exemptionValues = {
  'outside-eu': 'exemption:outbound:outsideEuropeanUnion',
  'inside-eu': 'exemption:outbound:insideEuropeanUnion',
  'no-document': 'exemption:outbound:noAccountingDocument',
} as const;
export function normalizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return (
    Object.entries(exemptionValues).find(([, v]) => v === value)?.[0] ?? value
  );
}
export function normalizeOperation(
  raw: RawOperation,
  company: string,
  accounts: { id: string; name: string }[] = [],
): Operation {
  const breakdowns = raw.breakdowns.map((b) => ({
    id: String(b.id),
    isCounterpart: b.isCounterpart,
    category:
      b.categoryId === -1
        ? null
        : {
            id: b.resolvedCategoryId ?? b.categoryId,
            name: b.categoryWording ?? '',
            path: b.categoryGroup?.name
              ? [b.categoryGroup.name, b.categoryWording ?? '']
              : [b.categoryWording ?? ''],
          },
    amount: round(b.amount),
    amountExcludingVat: round(b.amountExcludingTaxesWithRecoverageRate),
    vatRate: b.vatRate == null ? null : round(b.vatRate * 100),
    vatAmount: round(b.vatAmount),
    vatExemptReason: normalizeReason(b.associationData?.vatExemptionReason),
  }));
  const mains = breakdowns.filter((b) => !b.isCounterpart);
  const main = mains.length === 1 ? mains[0] : undefined;
  const accountId = raw.transaction ? String(raw.transaction.accountId) : null;
  return operationSchema.parse({
    id: String(raw.id),
    date: raw.date.slice(0, 10),
    wording: raw.wording,
    amount: round(Math.abs(raw.amount)),
    direction: raw.isInbound ? 'income' : 'expense',
    validated: raw.validated,
    memo: raw.memo ?? null,
    account: accountId
      ? (accounts.find((a) => a.id === accountId) ?? {
          id: accountId,
          name: '',
        })
      : null,
    breakdowns,
    category: main?.category ?? null,
    vatRate: main?.vatRate ?? null,
    vatAmount: main?.vatAmount ?? null,
    amountExcludingVat: main?.amountExcludingVat ?? null,
    vatExemptReason: main?.vatExemptReason ?? null,
    attachments: raw.sourceDocumentAttachments.map((a) => ({
      id: String(a.id),
      fileId: a.sourceDocument.file ? String(a.sourceDocument.file.id) : null,
      filename: a.sourceDocument.file?.name ?? '',
      type: a.sourceDocument.type,
    })),
    url: `https://app.dougs.fr/app/c/${company}/accounting/operations/payments?operationId=${raw.id}`,
  });
}
