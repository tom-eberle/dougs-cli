/**
 * Synthetic fixtures. Everything here is invented: company 999999, fictional
 * merchants, made-up ids and amounts. Never paste real API responses here.
 */

export const COMPANY = '999999';

export interface RawBreakdownFixture {
  id: number;
  amount: number;
  isCounterpart: boolean;
  isInbound: boolean;
  isRefund: boolean;
  hasVat: boolean;
  section: string;
  categoryId: number;
  resolvedCategoryId: number;
  resolvedCategoryPath: number[];
  categoryWording: string;
  categoryGroup: { id: number; name: string };
  vatRate: number | null;
  vatAmount: number;
  vatAmountWithRecoverageRate: number;
  manualVatAmount: number | null;
  isVatAmountManuallyModified: boolean;
  amountExcludingTaxesWithRecoverageRate: number;
  associationData: Record<string, unknown>;
  associations: { name: string; slots: Record<string, unknown> }[] | null;
}

export interface RawAttachmentFixture {
  id: number;
  sourceDocument: {
    id: number;
    type: string;
    externalId: string | null;
    file: { id: number; name: string; url: string; mimeType: string };
  };
}

export interface RawOpFixture {
  id: number;
  companyId: number;
  type: string;
  date: string;
  wording: string;
  memo: string | null;
  amount: number;
  isInbound: boolean;
  validated: boolean;
  deleted: boolean;
  excluded: boolean;
  manuallyLocked: boolean;
  lockedByDate: boolean;
  errors: unknown[];
  breakdowns: RawBreakdownFixture[];
  transaction: {
    accountId: number;
    currency: string;
    amount: number;
    originalAmount: number | null;
    originalCurrency: string | null;
  } | null;
  sourceDocumentAttachments: RawAttachmentFixture[];
}

export const CATEGORIES = {
  software: {
    id: 77,
    name: 'Logiciels et abonnements',
    group: 'Frais de fonctionnement',
    rate: 0.2,
  },
  ads: { id: 69, name: 'Publicité', group: 'Frais de fonctionnement', rate: 0.2 },
  bankFees: { id: 12, name: 'Frais bancaires', group: 'Banque', rate: null },
  sales: { id: 301, name: 'Prestations de services', group: 'Ventes', rate: 0.2 },
  equipment: { id: 205, name: 'Matériel informatique', group: 'Immobilisations', rate: 0.2 },
  /** Partially recoverable VAT (like fuel for a passenger car). */
  fuel: { id: 610, name: 'Carburant', group: 'Véhicules', rate: 0.2, recoverage: 0.8 },
  uncategorized: { id: -1, name: 'Non catégorisé', group: 'Divers', rate: null },
} as const;
type CategoryKey = keyof typeof CATEGORIES;

let nextId = 10_000;

export interface OpOptions {
  id?: number;
  date?: string;
  wording?: string;
  amount?: number;
  income?: boolean;
  validated?: boolean;
  category?: CategoryKey;
  /** Percent; null for no VAT. Defaults to the category rate. */
  vatRate?: number | null;
  exemption?: string;
  attachments?: { name: string; type?: string; vendorInvoiceId?: string; mimeType?: string }[];
  memo?: string | null;
  original?: { amount: number; currency: string };
  deleted?: boolean;
  type?: string;
  /** A refund: money back from a supplier (income on an expense category) or to a customer. */
  refund?: boolean;
  locked?: 'manual' | 'date';
  errors?: unknown[];
  /** False for a line outside VAT (Dougs hasVat=false): no VAT, no exemption slot. */
  vatApplicable?: boolean;
  /** Make the exemption reason a required (non-optional) slot, as Dougs does for some categories. */
  requiredExemption?: boolean;
}

/** Share of VAT that is deductible for a category (1 unless partially recoverable). */
export function recoverage(categoryId: number): number {
  const cat = Object.values(CATEGORIES).find((c) => c.id === categoryId);
  return cat && 'recoverage' in cat ? cat.recoverage : 1;
}

export function breakdown(
  opId: number,
  amount: number,
  o: OpOptions & { id?: number } = {},
): RawBreakdownFixture {
  const cat = CATEGORIES[o.category ?? 'software'];
  const percent = o.vatRate !== undefined ? o.vatRate : cat.rate === null ? null : cat.rate * 100;
  const exempt = !!o.exemption;
  const vat =
    !exempt && percent ? Math.round((amount - amount / (1 + percent / 100)) * 100) / 100 : 0;
  return {
    id: o.id ?? opId * 10 + 1,
    amount,
    isCounterpart: false,
    isInbound: !!o.income,
    isRefund: !!o.refund,
    hasVat: o.vatApplicable ?? true,
    section: 'main',
    categoryId: cat.id,
    resolvedCategoryId: cat.id,
    resolvedCategoryPath: [cat.id],
    categoryWording: cat.name,
    categoryGroup: { id: 2, name: cat.group },
    vatRate: exempt || !percent ? null : percent / 100,
    vatAmount: vat,
    vatAmountWithRecoverageRate: Math.round(vat * recoverage(cat.id) * 100) / 100,
    manualVatAmount: null,
    isVatAmountManuallyModified: false,
    amountExcludingTaxesWithRecoverageRate:
      Math.round((amount - Math.round(vat * recoverage(cat.id) * 100) / 100) * 100) / 100,
    associationData: o.exemption ? { vatExemptionReason: o.exemption } : {},
    // Dougs only offers the exemption slot on categorized breakdowns without VAT.
    associations:
      cat.id === -1
        ? null
        : vat === 0 && (o.vatApplicable ?? true)
          ? [
              {
                name: 'vatExemptionReason',
                slots: o.requiredExemption ? { reason: { isOptional: false } } : {},
              },
            ]
          : [{ name: 'supplier', slots: {} }],
  };
}

export function rawOp(o: OpOptions = {}): RawOpFixture {
  const id = o.id ?? nextId++;
  const amount = o.amount ?? 48;
  return {
    id,
    companyId: Number(COMPANY),
    type: o.type ?? 'bank',
    date: o.date ?? '2026-08-15',
    wording: o.wording ?? 'FICTIONAL ORBIT TOOLS',
    memo: o.memo ?? null,
    amount,
    isInbound: !!o.income,
    validated: o.validated ?? true,
    deleted: !!o.deleted,
    excluded: false,
    manuallyLocked: o.locked === 'manual',
    lockedByDate: o.locked === 'date',
    errors: o.errors ?? [],
    breakdowns: [breakdown(id, amount, o)],
    transaction: {
      accountId: 501,
      currency: 'EUR',
      amount: o.income ? amount : -amount,
      originalAmount: o.original?.amount ?? null,
      originalCurrency: o.original?.currency ?? null,
    },
    sourceDocumentAttachments: (o.attachments ?? []).map((a, i) => ({
      id: id * 100 + i,
      sourceDocument: {
        id: id * 100 + i,
        type: a.type ?? 'vendorInvoice',
        externalId: a.vendorInvoiceId ?? null,
        file: {
          id: id * 1000 + i,
          name: a.name,
          url: `/files/00000000-0000-4000-8000-${String(id * 100 + i).padStart(12, '0')}/actions/download`,
          mimeType: a.mimeType ?? 'application/pdf',
        },
      },
    })),
  };
}

export function rawCategories() {
  return Object.values(CATEGORIES).map((c) => ({
    id: c.id,
    wording: c.name,
    hidden: false,
    isAssignable: true,
    isAbstract: false,
    isInbound: c.id === 301 ? true : c.id === -1 ? null : false,
    parentId: null,
    accountingNumber: c.id === 205 ? 218300 : c.id === 301 ? '706000' : 626100,
    group: { id: 2, name: c.group },
    vat: c.rate === null ? null : { rate: c.rate, isOptional: false, isReversable: true },
  }));
}

export function rawUser(
  companies = [
    { id: Number(COMPANY), legalName: 'Fictional Widgets SAS', brandName: 'Fictional Widgets' },
  ],
) {
  return {
    id: 4242,
    email: 'someone@example.test',
    profile: { fullName: 'Alex Example' },
    companies,
    companyIds: companies.map((c) => c.id),
  };
}

export function rawAccounts() {
  return [
    {
      id: 501,
      accountName: 'Main account',
      bankName: 'Example Bank',
      currency: 'EUR',
      closed: false,
      hidden: false,
      metadata: { balance: { balance: 1234.56 }, balanceUpdatedAt: '2026-08-31T08:00:00.000Z' },
    },
  ];
}
