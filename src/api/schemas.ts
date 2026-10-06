import { z } from 'zod';

/*
 * Raw API shapes (loose: unknown fields pass through untouched) and the
 * normalized shapes the CLI prints. Raw schemas list only what we rely on, so
 * `dougs doctor` can detect drift early.
 */

const id = z.union([z.number(), z.string()]);

// ───────────────────────────── raw ─────────────────────────────

export const rawAssociationSchema = z.looseObject({
  name: z.string(),
  slots: z.record(z.string(), z.unknown()).optional(),
});

export const rawBreakdownSchema = z.looseObject({
  id,
  amount: z.number(),
  isCounterpart: z.boolean(),
  isInbound: z.boolean().optional(),
  section: z.string().optional(),
  categoryId: z.number(),
  resolvedCategoryId: z.number().optional(),
  resolvedCategoryPath: z.array(z.number()).optional(),
  categoryWording: z.string().optional(),
  categoryGroup: z
    .looseObject({ id: z.number().optional(), name: z.string().optional() })
    .nullable()
    .optional(),
  vatRate: z.number().nullable().optional(),
  vatAmount: z.number(),
  vatAmountWithRecoverageRate: z.number().optional(),
  manualVatAmount: z.number().nullable().optional(),
  isVatAmountManuallyModified: z.boolean().optional(),
  amountExcludingTaxesWithRecoverageRate: z.number(),
  associationData: z.record(z.string(), z.unknown()).nullable().optional(),
  associations: z.array(rawAssociationSchema).nullable().optional(),
});
export type RawBreakdown = z.infer<typeof rawBreakdownSchema>;

export const rawFileSchema = z.looseObject({
  id,
  name: z.string(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
});

export const rawAttachmentSchema = z.looseObject({
  id,
  sourceDocument: z.looseObject({
    id,
    type: z.string(),
    externalId: z.string().nullable().optional(),
    amount: z.number().nullable().optional(),
    date: z.string().nullable().optional(),
    file: rawFileSchema.nullable().optional(),
  }),
});
export type RawAttachment = z.infer<typeof rawAttachmentSchema>;

export const rawTransactionSchema = z.looseObject({
  accountId: id,
  currency: z.string().optional(),
  amount: z.number().optional(),
  originalAmount: z.number().nullable().optional(),
  originalCurrency: z.string().nullable().optional(),
  changeRate: z.number().nullable().optional(),
});

export const rawOperationSchema = z.looseObject({
  id,
  companyId: id.optional(),
  type: z.string().optional(),
  date: z.string(),
  wording: z.string(),
  memo: z.string().nullable().optional(),
  amount: z.number(),
  isInbound: z.boolean(),
  validated: z.boolean(),
  deleted: z.boolean().optional(),
  excluded: z.boolean().optional(),
  breakdowns: z.array(rawBreakdownSchema),
  transaction: rawTransactionSchema.nullable().optional(),
  sourceDocumentAttachments: z.array(rawAttachmentSchema).default([]),
});
export type RawOperation = z.infer<typeof rawOperationSchema>;

export const rawAccountSchema = z.looseObject({
  id,
  name: z.string().nullable().optional(),
  accountName: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  currency: z.string().optional(),
  closed: z.boolean().optional(),
  hidden: z.boolean().optional(),
  metadata: z
    .looseObject({
      balance: z.looseObject({ balance: z.number().nullable().optional() }).nullable().optional(),
      balanceUpdatedAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type RawAccount = z.infer<typeof rawAccountSchema>;

export const rawCategorySchema = z.looseObject({
  id: z.number(),
  wording: z.string(),
  hidden: z.boolean().optional(),
  isAssignable: z.boolean().optional(),
  isAbstract: z.boolean().optional(),
  isInbound: z.boolean().nullable().optional(),
  parentId: z.number().nullable().optional(),
  accountingNumber: z.union([z.number(), z.string()]).nullable().optional(),
  group: z.looseObject({ name: z.string().optional() }).nullable().optional(),
  vat: z
    .looseObject({
      rate: z
        .union([z.number(), z.string()])
        .nullable()
        .optional()
        .describe('Fraction, or a keyword like "fromEuCountries"'),
      isOptional: z.boolean().nullable().optional(),
      isReversable: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
export type RawCategory = z.infer<typeof rawCategorySchema>;

export const rawCompanySchema = z.looseObject({
  id,
  legalName: z.string().nullable().optional(),
  brandName: z.string().nullable().optional(),
  fullName: z.string().nullable().optional(),
});

export const rawUserSchema = z.looseObject({
  id,
  email: z.string().nullable().optional(),
  profile: z.looseObject({ fullName: z.string().nullable().optional() }).nullable().optional(),
  companies: z.array(rawCompanySchema).optional(),
  companyIds: z.array(id).optional(),
});

export const rawVendorInvoiceSchema = z.looseObject({
  id: z.string(),
  amount: z.number().nullable().optional(),
  vatAmount: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  prefillStatus: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  supplierCountry: z.string().nullable().optional(),
  supplierVatNumber: z.string().nullable().optional(),
  foreignSupplierChargedFrenchVat: z.boolean().nullable().optional(),
  vatBreakdown: z
    .array(
      z.looseObject({
        vatRate: z.number().nullable().optional(),
        vatAmount: z.number().nullable().optional(),
        categoryCode: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  date: z.string().nullable().optional(),
  fileId: id.nullable().optional(),
  fileName: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
});
export type RawVendorInvoice = z.infer<typeof rawVendorInvoiceSchema>;

export const rawDeclarationSummarySchema = z.looseObject({
  id,
  type: z.string(),
  label: z.string().optional(),
  periodStartDate: z.string(),
  periodEndDate: z.string(),
  isFilled: z.boolean().optional(),
});

export const rawDeclarationSchema = rawDeclarationSummarySchema.extend({
  form: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const rawAccountingYearSchema = z.looseObject({
  id,
  openingDate: z.string(),
  closingDate: z.string(),
  closed: z.boolean().optional(),
});

// ───────────────────────────── normalized ─────────────────────────────

export const VAT_EXEMPT_KINDS = ['outside-eu', 'inside-eu', 'no-document'] as const;
export const vatExemptKindSchema = z.enum(VAT_EXEMPT_KINDS);
export type VatExemptKind = z.infer<typeof vatExemptKindSchema>;

export const categoryRefSchema = z
  .object({
    id: z.number().int().describe('Dougs category id (use with --category)'),
    name: z.string(),
    path: z
      .array(z.string())
      .describe('Group then category name, e.g. ["Frais de fonctionnement", "Publicité"]'),
  })
  .describe('Category assigned to a breakdown');

export const breakdownSchema = z.object({
  id: z.string(),
  isCounterpart: z.boolean(),
  section: z.string().nullable(),
  category: categoryRefSchema.nullable().describe('null when uncategorized (Dougs categoryId -1)'),
  amount: z.number().describe('Gross amount (TTC) in EUR'),
  amountExcludingVat: z.number().describe('Net amount (HT) in EUR'),
  vatRate: z.number().nullable().describe('Percent, e.g. 20 or 5.5; null when none'),
  vatAmount: z.number().describe('VAT in EUR'),
  vatExemptReason: z
    .string()
    .nullable()
    .describe('outside-eu | inside-eu | no-document, or the raw Dougs value for other exemptions'),
});
export type Breakdown = z.infer<typeof breakdownSchema>;

export const attachmentSchema = z.object({
  id: z.string().describe('Attachment id (use with ops detach)'),
  documentId: z.string(),
  fileId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  type: z
    .string()
    .describe('vendorInvoice | salesInvoice | other | unknown (classification is async)'),
  vendorInvoiceId: z.string().nullable(),
  downloadPath: z.string().nullable().describe('Authenticated API path; use dougs ops download'),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const operationSchema = z
  .object({
    id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
    wording: z.string().describe('Bank wording'),
    type: z.string().nullable().describe('bank | expense | miscellaneous:manual | dispatch:…'),
    amount: z.number().describe('Always positive, in EUR; see direction'),
    direction: z.enum(['expense', 'income']),
    original: z
      .object({ amount: z.number(), currency: z.string() })
      .nullable()
      .describe('Native amount when the bank line was in a foreign currency'),
    validated: z.boolean(),
    memo: z.string().nullable(),
    account: z.object({ id: z.string(), name: z.string() }).nullable(),
    breakdowns: z.array(breakdownSchema),
    category: categoryRefSchema
      .nullable()
      .describe('Mirror of the single main breakdown; null if split'),
    vatRate: z.number().nullable(),
    vatAmount: z.number().nullable(),
    amountExcludingVat: z.number().nullable(),
    vatExemptReason: z.string().nullable(),
    attachments: z.array(attachmentSchema),
    url: z.string().describe('Link to the operation in the Dougs web app'),
  })
  .describe('A Dougs accounting operation (normalized)');
export type Operation = z.infer<typeof operationSchema>;

export const categorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  group: z.string().nullable(),
  path: z.array(z.string()),
  direction: z.enum(['expense', 'income', 'both']),
  accountingNumber: z.string().nullable().describe('French PCG account, e.g. "626100"'),
  defaultVatRate: z.number().nullable().describe('Percent'),
  vatOptional: z.boolean(),
});
export type Category = z.infer<typeof categorySchema>;

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  bank: z.string(),
  currency: z.string(),
  balance: z.number().nullable().describe('Live balance in the account currency'),
  balanceUpdatedAt: z.string().nullable(),
  closed: z.boolean(),
  hidden: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;

export const companySchema = z.object({ id: z.string(), name: z.string() });
export type Company = z.infer<typeof companySchema>;

export const whoamiSchema = z.object({
  user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
  companies: z.array(companySchema),
  activeCompany: z.string().nullable(),
  profile: z.string(),
  authSource: z.enum(['env', 'token', 'chrome', 'brave', 'edge', 'arc']),
});
export type Whoami = z.infer<typeof whoamiSchema>;
