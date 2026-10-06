import { z } from 'zod';
import { type Category, type Operation, operationSchema } from '../api/schemas.js';
import {
  attachStepSchema,
  detachStepSchema,
  type StepDraft,
  setStepSchema,
  validateStepSchema,
} from '../plan/types.js';

export const SEVERITIES = ['error', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CODES = [
  'MISSING_RECEIPT',
  'UNCATEGORIZED',
  'UNVALIDATED',
  'VAT_SUSPECT',
  'RULE_MATCH',
  'POSSIBLE_DUPLICATE',
  'DOCUMENT_AMOUNT_MISMATCH',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** Sub-codes of VAT_SUSPECT, also used by `vat check`. */
export const VAT_RULES = [
  'VAT_TOTAL_MISMATCH',
  'VAT_RATE_INVALID',
  'REVERSE_CHARGE_SUSPECT',
  'ZERO_VAT_NO_REASON',
  'DOCUMENT_VAT_MISMATCH',
] as const;
export type VatRule = (typeof VAT_RULES)[number];

const draftSchema = z
  .union([
    setStepSchema.omit({ id: true }),
    attachStepSchema.omit({ id: true }),
    detachStepSchema.omit({ id: true }),
    validateStepSchema.omit({ id: true }),
  ])
  .describe('A plan step without its id');

export const findingSchema = z.object({
  code: z.enum([...FINDING_CODES, ...VAT_RULES]),
  severity: z.enum(SEVERITIES),
  detail: z.string(),
  op: operationSchema,
  evidence: z.record(z.string(), z.unknown()).optional(),
  fix: draftSchema.optional().describe('Suggested plan step, when the fix is unambiguous'),
  related: z.array(z.string()).optional().describe('Other operation ids involved (duplicates)'),
});
export type Finding = Omit<z.infer<typeof findingSchema>, 'code' | 'fix'> & {
  code: FindingCode | VatRule;
  fix?: StepDraft;
};

/** Receipts above this gross amount must be a full invoice, not a till receipt. */
export const INVOICE_THRESHOLD = 150;

/** Dougs category names that never need a justifying document. */
const NO_RECEIPT_CATEGORY_NAMES = new Set(
  [
    'Virement compte à compte',
    'Capital souscrit',
    "Apport d'argent personnel",
    'Gains de change',
    'Pertes de change',
    'Commissions Paypal',
    'Commissions e-commerce',
    'Encaissement e-commerce',
    'Banque',
  ].map((n) => n.toLowerCase()),
);

export interface ReceiptPolicy {
  noReceiptCategories: ReadonlySet<number>;
}

function needsReceipt(op: Operation, policy: ReceiptPolicy): boolean {
  if (op.direction !== 'expense' || op.amount < 1) return false;
  if (op.type?.startsWith('dispatch')) return false;
  const mains = op.breakdowns.filter((b) => !b.isCounterpart);
  return !mains.every(
    (b) =>
      b.category &&
      (policy.noReceiptCategories.has(b.category.id) ||
        NO_RECEIPT_CATEGORY_NAMES.has(b.category.name.toLowerCase())),
  );
}

export function missingReceipt(op: Operation, policy: ReceiptPolicy): Finding | null {
  if (op.attachments.length > 0 || !needsReceipt(op, policy)) return null;
  const invoice = op.amount > INVOICE_THRESHOLD;
  return {
    code: 'MISSING_RECEIPT',
    severity: invoice ? 'error' : 'warning',
    detail: invoice
      ? `no document; ${op.amount.toFixed(2)} € > ${INVOICE_THRESHOLD} € needs a full invoice`
      : `no document for a ${op.amount.toFixed(2)} € expense`,
    op,
    evidence: { invoiceRequired: invoice },
  };
}

export function uncategorized(op: Operation): Finding | null {
  const count = op.breakdowns.filter((b) => !b.isCounterpart && !b.category).length;
  if (!count) return null;
  return {
    code: 'UNCATEGORIZED',
    severity: 'warning',
    detail: 'no category (Dougs category -1)',
    op,
  };
}

export function unvalidated(op: Operation): Finding | null {
  return op.validated
    ? null
    : { code: 'UNVALIDATED', severity: 'info', detail: 'not yet validated in Dougs', op };
}

export type CategoryIndex = ReadonlyMap<number, Category>;
