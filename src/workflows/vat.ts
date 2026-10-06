import { z } from 'zod';
import type { Dougs, OperationRecord } from '../api/dougs.js';
import type { Breakdown, Operation, RawVendorInvoice } from '../api/schemas.js';
import { isEuCountry } from '../pdf/extract.js';
import { observe } from '../plan/diff.js';
import { mapLimit } from '../util/concurrency.js';
import { cents, FRENCH_VAT_RATES, sameCents } from '../util/money.js';
import type { CategoryIndex, Finding, VatRule } from './findings.js';
import type { VendorRegistry, VendorZone } from './vendors.js';

/** What the attached documents say about the supplier and its VAT. */
export interface DocumentEvidence {
  source: 'vendor-invoice' | 'pdf';
  zone: VendorZone | 'domestic' | 'foreign' | null;
  country?: string | null;
  vatAmount: number | null;
  reverseCharge: boolean;
  totals: number[];
  currency: string | null;
}

function zoneFromCountry(country: string | null | undefined): DocumentEvidence['zone'] {
  if (!country) return null;
  const c = country.toUpperCase();
  if (c === 'FR' || c === 'MC') return 'domestic';
  if (c === 'EU') return 'outside-eu'; // non-EU business registered under the OSS scheme
  return isEuCountry(c) ? 'inside-eu' : 'outside-eu';
}

export function evidenceFromVendorInvoice(v: RawVendorInvoice): DocumentEvidence | null {
  if (v.prefillStatus && v.prefillStatus !== 'prefilled') return null;
  const reverseCharge = (v.vatBreakdown ?? []).some((b) => b.categoryCode === 'AE');
  return {
    source: 'vendor-invoice',
    zone: zoneFromCountry(v.supplierCountry),
    country: v.supplierCountry ?? null,
    vatAmount: v.vatAmount ?? null,
    reverseCharge,
    totals: v.amount != null ? [v.amount] : [],
    currency: v.currency ?? null,
  };
}

/** Prefer Dougs' own invoice reading (cheap JSON); fall back to PDF text. */
export async function documentEvidence(
  dougs: Dougs,
  op: Operation,
): Promise<DocumentEvidence | null> {
  for (const att of op.attachments) {
    if (!att.vendorInvoiceId) continue;
    const evidence = evidenceFromVendorInvoice(
      await dougs.vendorInvoice(att.vendorInvoiceId).catch(() => ({ id: '' })),
    );
    if (evidence) return evidence;
  }
  for (const att of op.attachments) {
    const facts = await dougs.attachmentFacts(att).catch(() => null);
    if (!facts) continue;
    const foreign = facts.vatNumbers.filter((n) => n.country !== 'FR');
    const zone = foreign.some((n) => isEuCountry(n.country))
      ? 'inside-eu'
      : foreign.length
        ? 'outside-eu'
        : facts.reverseCharge
          ? 'foreign'
          : null;
    return {
      source: 'pdf',
      zone,
      country: foreign[0]?.country ?? null,
      vatAmount: facts.vatAmounts.length === 1 ? facts.vatAmounts[0]! : null,
      reverseCharge: facts.reverseCharge,
      totals: facts.totals,
      currency: facts.currency,
    };
  }
  return null;
}

function mainBreakdown(op: Operation): Breakdown | null {
  const mains = op.breakdowns.filter((b) => !b.isCounterpart);
  return mains.length === 1 ? mains[0]! : null;
}

function vatFinding(
  op: Operation,
  rule: VatRule,
  severity: Finding['severity'],
  detail: string,
  extra: Partial<Finding> = {},
): Finding {
  return { code: rule, severity, detail, op, ...extra };
}

export interface VatContext {
  vendors: VendorRegistry;
  categories?: CategoryIndex;
  evidence?: DocumentEvidence | null;
}

const EXEMPT_LABEL: Record<VendorZone, string> = {
  'outside-eu': 'outside the EU',
  'inside-eu': 'in another EU country',
};

/** All VAT findings for one operation. Pure: documents are fetched by the caller. */
export function checkVat(op: Operation, ctx: VatContext): Finding[] {
  const findings: Finding[] = [];
  for (const b of op.breakdowns) {
    if (b.isCounterpart) continue;
    const drift = cents(b.amount - (b.amountExcludingVat + b.vatAmount));
    if (Math.abs(drift) > 0.01)
      findings.push(
        vatFinding(
          op,
          'VAT_TOTAL_MISMATCH',
          'error',
          `TTC ${b.amount.toFixed(2)} ≠ HT ${b.amountExcludingVat.toFixed(2)} + VAT ${b.vatAmount.toFixed(2)} (off by ${drift.toFixed(2)})`,
        ),
      );
    if (b.vatRate !== null && !(FRENCH_VAT_RATES as readonly number[]).includes(b.vatRate))
      findings.push(
        vatFinding(
          op,
          'VAT_RATE_INVALID',
          'error',
          `VAT rate ${b.vatRate}% is not a French rate (0, 2.1, 5.5, 10, 20)`,
        ),
      );
  }
  if (op.direction !== 'expense') return findings;
  const b = mainBreakdown(op);
  if (!b) return findings;

  const vendor = ctx.vendors.find(op.wording);
  const ev = ctx.evidence ?? null;
  const zone: VendorZone | null =
    vendor?.zone ?? (ev?.zone === 'inside-eu' || ev?.zone === 'outside-eu' ? ev.zone : null);
  const why = vendor
    ? `${vendor.name} is established ${EXEMPT_LABEL[vendor.zone]}`
    : ev?.zone === 'inside-eu' || ev?.zone === 'outside-eu'
      ? `the invoice shows a supplier ${EXEMPT_LABEL[ev.zone]}${ev.country ? ` (${ev.country})` : ''}`
      : null;
  const evidence = { vendor: vendor?.name ?? null, document: ev ?? null };
  const fix = (kind: VendorZone) =>
    b.category
      ? {
          op: op.id,
          action: 'set' as const,
          set: { vatExempt: kind },
          expect: observe(op, b),
          why: `${why}; reverse charge, no French VAT to deduct`,
        }
      : undefined;

  // An invoice that itself charges VAT is authoritative: the supplier billed VAT
  // (e.g. an EU company registered for French VAT), so this is not reverse charge.
  const invoiceChargesVat = !!ev && !ev.reverseCharge && (ev.vatAmount ?? 0) > 0;
  if (b.vatAmount > 0 && !invoiceChargesVat) {
    const docSaysZero = ev?.vatAmount === 0 || ev?.reverseCharge;
    if (zone && why) {
      findings.push(
        vatFinding(
          op,
          'REVERSE_CHARGE_SUSPECT',
          'error',
          `${b.vatAmount.toFixed(2)} € of deductible French VAT booked, but ${why}`,
          {
            evidence,
            fix: fix(zone),
          },
        ),
      );
    } else if (ev?.zone === 'foreign' && docSaysZero) {
      findings.push(
        vatFinding(
          op,
          'REVERSE_CHARGE_SUSPECT',
          'warning',
          `invoice mentions reverse charge but ${b.vatAmount.toFixed(2)} € of VAT is booked; supplier country unknown`,
          {
            evidence,
          },
        ),
      );
    }
  } else if (
    b.vatExemptReason &&
    zone &&
    (b.vatExemptReason === 'outside-eu' || b.vatExemptReason === 'inside-eu') &&
    b.vatExemptReason !== zone
  ) {
    findings.push(
      vatFinding(
        op,
        'REVERSE_CHARGE_SUSPECT',
        'warning',
        `exempted as ${b.vatExemptReason}, but ${why}`,
        { evidence, fix: fix(zone) },
      ),
    );
  } else if (!b.vatExemptReason && b.vatAmount === 0 && b.category) {
    const category = ctx.categories?.get(b.category.id);
    const expectsVat =
      zone !== null ||
      (category ? (category.defaultVatRate ?? 0) > 0 && !category.vatOptional : false);
    if (expectsVat)
      findings.push(
        vatFinding(
          op,
          'ZERO_VAT_NO_REASON',
          'warning',
          zone && why
            ? `no VAT and no exemption reason; ${why}`
            : `no VAT and no exemption reason, but "${b.category.name}" normally carries VAT`,
          { evidence, fix: zone ? fix(zone) : undefined },
        ),
      );
  }

  // Only compare VAT when the document is for this exact amount: one invoice
  // often covers several bank lines (or the reverse), and then VAT differs legitimately.
  const sameDocument = ev?.totals.some((t) => sameCents(t, b.amount, 0.05));
  if (
    ev &&
    sameDocument &&
    ev.vatAmount !== null &&
    (ev.currency ?? 'EUR') === 'EUR' &&
    !ev.reverseCharge &&
    !sameCents(ev.vatAmount, b.vatAmount, 0.02)
  )
    findings.push(
      vatFinding(
        op,
        'DOCUMENT_VAT_MISMATCH',
        'warning',
        `invoice VAT ${ev.vatAmount.toFixed(2)} € ≠ booked VAT ${b.vatAmount.toFixed(2)} €`,
        { evidence },
      ),
    );
  return findings;
}

export interface VatCheckOptions {
  documents: boolean;
  categories?: CategoryIndex;
  vendors: VendorRegistry;
  onProgress?: (done: number, total: number) => void;
}

export async function runVatCheck(
  dougs: Dougs,
  records: readonly OperationRecord[],
  options: VatCheckOptions,
) {
  const withDocs = options.documents
    ? records.filter((r) => r.op.direction === 'expense' && r.op.attachments.length)
    : [];
  const evidence = new Map<string, DocumentEvidence | null>();
  let done = 0;
  await mapLimit(withDocs, 4, async ({ op }) => {
    evidence.set(op.id, await documentEvidence(dougs, op));
    options.onProgress?.(++done, withDocs.length);
  });
  const findings = records.flatMap(({ op }) =>
    checkVat(op, {
      vendors: options.vendors,
      categories: options.categories,
      evidence: evidence.get(op.id),
    }),
  );
  return { findings, documentsChecked: withDocs.length };
}

// ─────────────────────────── vat summary (CA3 estimate) ───────────────────────────

/** Official labels of the 3310-CA3 boxes the estimate fills. */
export const CA3_BOXES: Record<string, string> = {
  A1: 'Ventes, prestations de services',
  A3: 'Achats de prestations de services auprès d’un assujetti non établi en France',
  'A3:01': '… dont prestations autoliquidées, en UE',
  'A3:02': '… dont prestations autoliquidées, hors UE',
  E2: 'Autres opérations non imposables (E1/E2/F2 combined)',
  '08': 'Base hors taxe 20 %',
  '08:VAT': 'Taxe due 20 %',
  '9B': 'Base hors taxe 10 %',
  '9B:VAT': 'Taxe due 10 %',
  '09': 'Base hors taxe 5,5 %',
  '09:VAT': 'Taxe due 5,5 %',
  '16': 'Total de la TVA brute due',
  '19': 'TVA déductible – biens constituant des immobilisations',
  '20': 'TVA déductible – autres biens et services',
  '20:A': '… dont biens et services en France',
  '20:B': '… dont autoliquidés en UE',
  '20:C': '… dont autoliquidés hors UE',
  '22': 'Report du crédit',
  '23': 'Total TVA déductible',
  '25': 'Crédit de TVA',
  '28': 'TVA nette due',
};

export const vatSummaryLineSchema = z.object({
  box: z.string(),
  label: z.string(),
  estimate: z.number().nullable(),
  declared: z.number().nullable(),
  difference: z.number().nullable(),
});

export const vatSummarySchema = z
  .object({
    meta: z.object({
      month: z.string(),
      estimate: z.literal(true),
      operations: z.number(),
      unvalidated: z.number(),
      uncategorized: z.number(),
      declaration: z
        .object({ id: z.string(), label: z.string().nullable(), filed: z.boolean() })
        .nullable()
        .describe('The Dougs CA3 for this month, when one exists'),
    }),
    collectedByRate: z.array(z.object({ rate: z.number(), base: z.number(), vat: z.number() })),
    lines: z.array(vatSummaryLineSchema),
    notes: z.array(z.string()),
  })
  .describe('Monthly CA3 estimate, optionally side by side with the filed declaration');
export type VatSummary = z.infer<typeof vatSummarySchema>;

const SELF_ASSESSED_RATE = 20;

/**
 * Only revenue (PCG class 7) counts as a non-taxable sale; other untaxed income
 * (transfers between accounts, capital, loans, refunds) is not a CA3 line.
 */
function isRevenue(categoryId: number | undefined, categories?: CategoryIndex): boolean {
  if (!categories) return true;
  const account = categoryId === undefined ? null : categories.get(categoryId)?.accountingNumber;
  return !!account?.startsWith('7');
}

/** Compute CA3 boxes (in EUR, cents) from the month's operations. */
export function estimateCa3(
  ops: readonly Operation[],
  categories?: CategoryIndex,
  previousCredit: number | null = null,
) {
  const collected = new Map<number, { base: number; vat: number }>();
  let nonTaxable = 0;
  const rc = { eu: 0, nonEu: 0 };
  let deductibleDomestic = 0;
  let deductibleAssets = 0;
  for (const op of ops) {
    for (const b of op.breakdowns) {
      if (b.isCounterpart) continue;
      if (b.direction === 'income') {
        if (b.vatAmount > 0 && b.vatRate) {
          const bucket = collected.get(b.vatRate) ?? { base: 0, vat: 0 };
          bucket.base += b.amountExcludingVat;
          bucket.vat += b.vatAmount;
          collected.set(b.vatRate, bucket);
        } else if (isRevenue(b.category?.id, categories)) nonTaxable += b.amount;
        continue;
      }
      if (b.vatExemptReason === 'inside-eu') rc.eu += b.amount;
      else if (b.vatExemptReason === 'outside-eu') rc.nonEu += b.amount;
      else if (b.vatAmount > 0) {
        const account = b.category ? categories?.get(b.category.id)?.accountingNumber : null;
        if (account?.startsWith('2')) deductibleAssets += b.vatAmount;
        else deductibleDomestic += b.vatAmount;
      }
    }
  }
  const at = (rate: number) => collected.get(rate) ?? { base: 0, vat: 0 };
  const selfEu = (rc.eu * SELF_ASSESSED_RATE) / 100;
  const selfNonEu = (rc.nonEu * SELF_ASSESSED_RATE) / 100;
  const collectedVat = [...collected.values()].reduce((s, v) => s + v.vat, 0);
  const line16 = collectedVat + selfEu + selfNonEu;
  const line20 = deductibleDomestic + selfEu + selfNonEu;
  const line23 = deductibleAssets + line20 + (previousCredit ?? 0);
  const boxes: Record<string, number | null> = {
    A1: [...collected.values()].reduce((s, v) => s + v.base, 0),
    A3: rc.eu + rc.nonEu,
    'A3:01': rc.eu,
    'A3:02': rc.nonEu,
    E2: nonTaxable,
    '08': at(20).base + rc.eu + rc.nonEu,
    '08:VAT': at(20).vat + selfEu + selfNonEu,
    '9B': at(10).base,
    '9B:VAT': at(10).vat,
    '09': at(5.5).base,
    '09:VAT': at(5.5).vat,
    '16': line16,
    '19': deductibleAssets,
    '20': line20,
    '20:A': deductibleDomestic,
    '20:B': selfEu,
    '20:C': selfNonEu,
    '22': previousCredit,
    '23': line23,
    '25': Math.max(0, line23 - line16),
    '28': Math.max(0, line16 - line23),
  };
  for (const key of Object.keys(boxes)) if (boxes[key] != null) boxes[key] = cents(boxes[key]!);
  const byRate = [...collected.entries()]
    .map(([rate, v]) => ({ rate, base: cents(v.base), vat: cents(v.vat) }))
    .sort((a, b) => b.rate - a.rate);
  return { boxes, byRate };
}

function declaredValue(
  form: Record<string, unknown> | null | undefined,
  box: string,
): number | null {
  if (!form) return null;
  if (box === 'E2') {
    const parts = ['E1', 'E2', 'F2']
      .map((k) => form[k])
      .filter((v): v is number => typeof v === 'number');
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  const v = form[box];
  return typeof v === 'number' ? v : null;
}

export function compareWithDeclaration(
  boxes: Record<string, number | null>,
  form: Record<string, unknown> | null | undefined,
): VatSummary['lines'] {
  return Object.entries(CA3_BOXES).map(([box, label]) => {
    const estimate = boxes[box] ?? null;
    const declared = declaredValue(form, box);
    const difference =
      estimate !== null && declared !== null ? Math.round(estimate) - declared : null;
    return { box, label, estimate, declared, difference };
  });
}
