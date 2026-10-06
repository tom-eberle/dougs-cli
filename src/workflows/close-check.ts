import { z } from 'zod';
import type { Dougs, OperationRecord } from '../api/dougs.js';
import type { Operation } from '../api/schemas.js';
import { mapLimit } from '../util/concurrency.js';
import { daysBetween } from '../util/dates.js';
import { sameCents } from '../util/money.js';
import { merchantKey } from '../util/text.js';
import {
  type CategoryIndex,
  type Finding,
  findingSchema,
  missingReceipt,
  uncategorized,
  unvalidated,
} from './findings.js';
import type { RulesFile } from './rules.js';
import { checkVat, type DocumentEvidence, documentEvidence } from './vat.js';
import { VendorRegistry } from './vendors.js';

export const closeCheckSchema = z
  .object({
    meta: z.object({
      year: z.number(),
      from: z.string(),
      to: z.string(),
      operations: z.number(),
      documentsChecked: z.number(),
      counts: z.record(z.string(), z.number()).describe('Findings per code'),
      bySeverity: z.object({ error: z.number(), warning: z.number(), info: z.number() }),
    }),
    findings: z.array(findingSchema),
  })
  .describe('Pre-closing report for an accounting year');
export type CloseCheck = Omit<z.infer<typeof closeCheckSchema>, 'findings'> & {
  findings: Finding[];
};

/** Same amount and direction, same merchant, within 3 days. */
export function findDuplicates(ops: readonly Operation[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...ops].sort((a, b) => a.date.localeCompare(b.date));
  const reported = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const key = merchantKey(a.wording);
    if (!key) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (daysBetween(a.date, b.date) > 3) break;
      if (
        a.direction !== b.direction ||
        !sameCents(a.amount, b.amount) ||
        merchantKey(b.wording) !== key
      )
        continue;
      const pair = `${a.id}:${b.id}`;
      if (reported.has(pair)) continue;
      reported.add(pair);
      findings.push({
        code: 'POSSIBLE_DUPLICATE',
        severity: 'warning',
        detail: `same amount (${a.amount.toFixed(2)} €) and merchant as operation ${a.id} on ${a.date}`,
        op: b,
        related: [a.id],
      });
    }
  }
  return findings;
}

/** The attached document's total matches none of TTC, HT or the original-currency amount. */
export function documentAmountMismatch(op: Operation, ev: DocumentEvidence | null): Finding | null {
  if (!ev?.totals.length) return null;
  const targets = [op.amount, op.amountExcludingVat, op.original?.amount].filter(
    (v): v is number => v != null,
  );
  const fxTolerance = (ev.currency ?? 'EUR') !== 'EUR' ? 0.03 : 0;
  const ok = ev.totals.some((t) =>
    targets.some(
      (target) => sameCents(t, target, 0.05) || Math.abs(t - target) <= target * fxTolerance,
    ),
  );
  if (ok) return null;
  return {
    code: 'DOCUMENT_AMOUNT_MISMATCH',
    severity: 'warning',
    detail: `attached document total ${ev.totals[0]!.toFixed(2)}${ev.currency ? ` ${ev.currency}` : ''} ≠ operation ${op.amount.toFixed(2)} €; wrong document attached?`,
    op,
    evidence: { document: ev },
  };
}

export interface CloseCheckOptions {
  year: number;
  from: string;
  to: string;
  rules: RulesFile;
  categories?: CategoryIndex;
  documents: boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function runCloseCheck(
  dougs: Dougs,
  records: readonly OperationRecord[],
  options: CloseCheckOptions,
): Promise<CloseCheck> {
  const ops = records.map((r) => r.op);
  const vendors = new VendorRegistry(options.rules.vendors);
  const policy = { noReceiptCategories: new Set(options.rules.noReceiptCategories) };
  const evidence = new Map<string, DocumentEvidence | null>();
  const withDocs = options.documents
    ? ops.filter((op) => op.direction === 'expense' && op.attachments.length)
    : [];
  let done = 0;
  await mapLimit(withDocs, 4, async (op) => {
    evidence.set(op.id, await documentEvidence(dougs, op));
    options.onProgress?.(++done, withDocs.length);
  });

  const findings: Finding[] = [];
  for (const op of ops) {
    for (const f of [missingReceipt(op, policy), uncategorized(op), unvalidated(op)])
      if (f) findings.push(f);
    findings.push(
      ...checkVat(op, { vendors, categories: options.categories, evidence: evidence.get(op.id) }),
    );
    const mismatch = documentAmountMismatch(op, evidence.get(op.id) ?? null);
    if (mismatch) findings.push(mismatch);
  }
  findings.push(...findDuplicates(ops));

  const counts: Record<string, number> = {};
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.code] = (counts[f.code] ?? 0) + 1;
    bySeverity[f.severity]++;
  }
  const rank = { error: 0, warning: 1, info: 2 };
  findings.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.code.localeCompare(b.code) ||
      b.op.date.localeCompare(a.op.date),
  );
  return {
    meta: {
      year: options.year,
      from: options.from,
      to: options.to,
      operations: ops.length,
      documentsChecked: withDocs.length,
      counts,
      bySeverity,
    },
    findings,
  };
}
