import { cents } from '../util/money.js';
import { DEFAULT_API_BASE } from '../version.js';
import type {
  Account,
  Attachment,
  Breakdown,
  Category,
  Operation,
  RawAccount,
  RawBreakdown,
  RawCategory,
  RawOperation,
  VatExemptKind,
} from './schemas.js';

/** Dougs exemption values for purchases, by our short names. */
export const EXEMPTION_VALUES: Record<VatExemptKind, string> = {
  'outside-eu': 'exemption:outbound:outsideEuropeanUnion',
  'inside-eu': 'exemption:outbound:insideEuropeanUnion',
  'no-document': 'exemption:outbound:noAccountingDocument',
};

export function exemptionKind(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const known = Object.entries(EXEMPTION_VALUES).find(([, value]) => value === raw);
  return known ? known[0] : raw;
}

/** API rates are fractions (0.2); the CLI speaks percent (20). */
export function rateToPercent(rate: number | null | undefined): number | null {
  return rate == null ? null : Math.round(rate * 1000) / 10;
}

export function percentToRate(percent: number): number {
  return Math.round(percent * 10) / 1000;
}

/** The breakdown edits apply to: the single non-counterpart one ("main" section preferred). */
export function mainBreakdowns<T extends Pick<RawBreakdown, 'isCounterpart' | 'section'>>(
  breakdowns: readonly T[],
): T[] {
  return breakdowns.filter((b) => !b.isCounterpart);
}

export function operationUrl(company: string, opId: string): string {
  return `${DEFAULT_API_BASE}/app/c/${company}/accounting/operations/payments?operationId=${opId}`;
}

function normalizeBreakdown(b: RawBreakdown, opInbound: boolean): Breakdown {
  const uncategorized = b.categoryId === -1;
  const group = b.categoryGroup?.name;
  const name = b.categoryWording ?? '';
  return {
    id: String(b.id),
    isCounterpart: b.isCounterpart,
    section: b.section ?? null,
    direction: (b.isInbound ?? opInbound) ? 'income' : 'expense',
    category: uncategorized
      ? null
      : { id: b.categoryId, name, path: group ? [group, name] : [name] },
    amount: cents(b.amount),
    amountExcludingVat: cents(b.amountExcludingTaxesWithRecoverageRate),
    vatRate: rateToPercent(b.vatRate),
    vatAmount: cents(b.vatAmount),
    vatExemptReason: exemptionKind(b.associationData?.vatExemptionReason),
  };
}

function normalizeAttachment(a: RawOperation['sourceDocumentAttachments'][number]): Attachment {
  const doc = a.sourceDocument;
  return {
    id: String(a.id),
    documentId: String(doc.id),
    fileId: doc.file ? String(doc.file.id) : null,
    filename: doc.file?.name ?? '',
    mimeType: doc.file?.mimeType ?? null,
    type: doc.type,
    vendorInvoiceId: doc.type === 'vendorInvoice' && doc.externalId ? doc.externalId : null,
    downloadPath: doc.file?.url?.startsWith('/') ? doc.file.url : null,
  };
}

export interface NormalizeContext {
  company: string;
  accounts?: ReadonlyMap<string, string>;
}

export function normalizeOperation(raw: RawOperation, ctx: NormalizeContext): Operation {
  const breakdowns = raw.breakdowns.map((b) => normalizeBreakdown(b, raw.isInbound));
  const mains = breakdowns.filter((b) => !b.isCounterpart);
  const main = mains.length === 1 ? mains[0] : undefined;
  const tx = raw.transaction;
  const accountId = tx ? String(tx.accountId) : null;
  const foreign =
    tx?.originalCurrency && tx.originalCurrency !== 'EUR' && tx.originalAmount != null
      ? { amount: cents(Math.abs(tx.originalAmount)), currency: tx.originalCurrency }
      : tx?.currency && tx.currency !== 'EUR' && tx.amount != null
        ? { amount: cents(Math.abs(tx.amount)), currency: tx.currency }
        : null;
  const id = String(raw.id);
  return {
    id,
    date: raw.date.slice(0, 10),
    wording: raw.wording,
    type: raw.type ?? null,
    amount: cents(Math.abs(raw.amount)),
    direction: raw.isInbound ? 'income' : 'expense',
    original: foreign,
    validated: raw.validated,
    memo: raw.memo || null,
    account: accountId ? { id: accountId, name: ctx.accounts?.get(accountId) ?? '' } : null,
    breakdowns,
    category: main?.category ?? null,
    vatRate: main ? main.vatRate : null,
    vatAmount: main ? main.vatAmount : null,
    amountExcludingVat: main ? main.amountExcludingVat : null,
    vatExemptReason: main ? main.vatExemptReason : null,
    attachments: raw.sourceDocumentAttachments.map(normalizeAttachment),
    url: operationUrl(ctx.company, id),
  };
}

export function normalizeAccount(a: RawAccount): Account {
  return {
    id: String(a.id),
    name: a.accountName || a.name || a.bankName || '',
    bank: a.bankName ?? '',
    currency: a.currency ?? 'EUR',
    balance: a.metadata?.balance?.balance ?? null,
    balanceUpdatedAt: a.metadata?.balanceUpdatedAt ?? null,
    closed: a.closed ?? false,
    hidden: a.hidden ?? false,
  };
}

export function normalizeCategory(c: RawCategory): Category {
  const group = c.group?.name ?? null;
  return {
    id: c.id,
    name: c.wording,
    group,
    path: group ? [group, c.wording] : [c.wording],
    direction: c.isInbound == null ? 'both' : c.isInbound ? 'income' : 'expense',
    accountingNumber:
      c.accountingNumber != null
        ? String(c.accountingNumber)
        : c.resolvedAccountingNumbers?.length
          ? String(c.resolvedAccountingNumbers[0])
          : null,
    defaultVatRate: typeof c.vat?.rate === 'number' ? rateToPercent(c.vat.rate) : null,
    vatOptional: c.vat?.isOptional ?? false,
  };
}

/** True when the operation needs a justifying document and has none. */
export function hasReceipt(op: Pick<Operation, 'attachments'>): boolean {
  return op.attachments.length > 0;
}
