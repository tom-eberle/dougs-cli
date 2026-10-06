import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { uploadName } from '../api/dougs.js';
import type { Operation } from '../api/schemas.js';
import { DougsError, ExitCode } from '../output/errors.js';
import { analyzeDocumentText, analyzeFilename, extractPdfText } from '../pdf/extract.js';
import { UPLOAD_EXTENSIONS } from '../plan/attachments.js';
import type { StepDraft } from '../plan/types.js';
import { daysBetween } from '../util/dates.js';
import { sameCents } from '../util/money.js';
import { merchantTokens, normalizeText } from '../util/text.js';

/** Same allow-list as uploads: a matched file must be attachable. */
export const RECEIPT_EXTENSIONS = UPLOAD_EXTENSIONS;

/** Window, in days, of an operation date relative to the document date. */
export const DATE_WINDOW = { before: 10, after: 40 } as const;
const FX_TOLERANCE = 0.02;

export interface ReceiptDocument {
  path: string;
  name: string;
  /** Normalized text used for vendor matching (PDF text + file name). */
  text: string;
  totals: number[];
  amounts: number[];
  dates: string[];
  currency: string | null;
  extracted: boolean;
}

/** Expand files and directories (recursively) into receipt files. */
export async function collectFiles(inputs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (path: string, explicit: boolean) => {
    const info = await stat(path).catch(() => null);
    if (!info)
      throw new DougsError('FILE_NOT_FOUND', `No such file or directory: ${path}`, {
        exitCode: ExitCode.usage,
      });
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        if (!entry.startsWith('.')) await visit(join(path, entry), false);
    } else if (RECEIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      out.push(resolve(path));
    } else if (explicit) {
      throw new DougsError(
        'USAGE',
        `Not a receipt file (${[...RECEIPT_EXTENSIONS].join(', ')}): ${path}`,
        {
          exitCode: ExitCode.usage,
        },
      );
    }
  };
  for (const input of inputs) await visit(input, true);
  return [...new Set(out)];
}

export async function readReceipt(path: string): Promise<ReceiptDocument> {
  const name = basename(path);
  const fromName = analyzeFilename(name);
  let text = '';
  if (extname(path).toLowerCase() === '.pdf')
    text = await extractPdfText(await readFile(path)).catch(() => '');
  const facts = analyzeDocumentText(text);
  return {
    path,
    name,
    text: normalizeText(`${name} ${text}`),
    totals: facts.totals.length ? facts.totals : fromName.amounts,
    amounts: [...new Set([...facts.amounts, ...fromName.amounts])],
    dates: [...new Set([...fromName.dates, ...facts.dates])],
    currency: facts.currency,
    extracted: text.trim().length > 0,
  };
}

export interface Score {
  total: number;
  amount: number;
  date: number;
  vendor: number;
  reasons: string[];
}

function amountScore(
  doc: ReceiptDocument,
  op: Operation,
): { score: number; reason: string | null } {
  const targets: [string, number][] = [['TTC', op.amount]];
  if (op.amountExcludingVat !== null && op.amountExcludingVat !== op.amount)
    targets.push(['HT', op.amountExcludingVat]);
  if (op.original) targets.push([op.original.currency, op.original.amount]);
  const candidates = doc.totals.length ? doc.totals : doc.amounts;
  for (const [label, target] of targets)
    for (const value of candidates)
      if (sameCents(value, target))
        return { score: 1, reason: `amount ${value.toFixed(2)} = ${label}` };
  for (const [label, target] of targets)
    for (const value of doc.amounts)
      if (sameCents(value, target))
        return {
          score: 0.85,
          reason: `amount ${value.toFixed(2)} = ${label} (not on a total line)`,
        };
  // A foreign-currency invoice paid from a EUR account: allow FX drift.
  if (doc.currency && doc.currency !== 'EUR')
    for (const value of candidates)
      if (op.amount > 0 && Math.abs(value - op.amount) / op.amount <= FX_TOLERANCE)
        return {
          score: 0.6,
          reason: `amount ${value.toFixed(2)} ${doc.currency} ≈ ${op.amount.toFixed(2)} EUR (±2 %)`,
        };
  return { score: 0, reason: null };
}

function dateScore(doc: ReceiptDocument, op: Operation): { score: number; reason: string | null } {
  if (!doc.dates.length) return { score: 0.4, reason: null };
  let best: { score: number; delta: number } | null = null;
  for (const date of doc.dates) {
    const delta = daysBetween(date, op.date);
    if (delta < -DATE_WINDOW.before || delta > DATE_WINDOW.after) continue;
    const score =
      delta === 0
        ? 1
        : delta > 0
          ? 1 - delta / (DATE_WINDOW.after * 1.5)
          : 1 - -delta / (DATE_WINDOW.before * 1.5);
    if (!best || score > best.score) best = { score, delta };
  }
  if (!best) return { score: 0, reason: null };
  return { score: best.score, reason: `date ${best.delta >= 0 ? '+' : ''}${best.delta}d` };
}

function vendorScore(
  doc: ReceiptDocument,
  op: Operation,
): { score: number; reason: string | null } {
  const tokens = merchantTokens(op.wording);
  if (!tokens.length) return { score: 0, reason: null };
  const haystack = ` ${doc.text} `;
  const hits = tokens.filter(
    (t) => haystack.includes(` ${t} `) || (t.length >= 5 && haystack.includes(t)),
  );
  if (!hits.length) return { score: 0, reason: null };
  return {
    score: Math.min(1, hits.length / Math.min(tokens.length, 2)),
    reason: `vendor '${hits.join(' ')}' in wording`,
  };
}

/** Weighted score in [0, 1]; an amount match is required to score highly. */
export function scoreMatch(doc: ReceiptDocument, op: Operation): Score {
  const a = amountScore(doc, op);
  const d = dateScore(doc, op);
  const v = vendorScore(doc, op);
  const total = Math.round((0.55 * a.score + 0.25 * d.score + 0.2 * v.score) * 100) / 100;
  return {
    total,
    amount: a.score,
    date: d.score,
    vendor: v.score,
    reasons: [a.reason, d.reason, v.reason].filter((r): r is string => r !== null),
  };
}

const candidateSchema = z.object({
  op: z.string(),
  date: z.string(),
  wording: z.string(),
  amount: z.number(),
  score: z.number(),
  why: z.string(),
});
export const receiptsReportSchema = z
  .object({
    meta: z.object({
      files: z.number(),
      matched: z.number(),
      ambiguous: z.number(),
      unmatched: z.number(),
      alreadyAttached: z.number(),
      minScore: z.number(),
      plan: z.string().nullable(),
    }),
    matched: z.array(
      z.object({ file: z.string(), best: candidateSchema, runnersUp: z.array(candidateSchema) }),
    ),
    ambiguous: z.array(
      z.object({ file: z.string(), candidates: z.array(candidateSchema), reason: z.string() }),
    ),
    unmatched: z.array(
      z.object({
        file: z.string(),
        reason: z.string(),
        detected: z.object({ totals: z.array(z.number()), dates: z.array(z.string()) }),
      }),
    ),
    alreadyAttached: z.array(z.object({ file: z.string(), op: z.string() })),
  })
  .describe('Result of dougs receipts match');
export type ReceiptsReport = z.infer<typeof receiptsReportSchema>;
type Candidate = z.infer<typeof candidateSchema>;

export interface MatchOptions {
  minScore: number;
  /** Required gap between the best and second-best candidate to be confident. */
  margin?: number;
}

export function matchReceipts(
  docs: readonly ReceiptDocument[],
  ops: readonly Operation[],
  options: MatchOptions,
) {
  const margin = options.margin ?? 0.1;
  const report: Omit<ReceiptsReport, 'meta'> = {
    matched: [],
    ambiguous: [],
    unmatched: [],
    alreadyAttached: [],
  };
  const steps: StepDraft[] = [];
  const claimed = new Map<string, string>();
  for (const doc of docs) {
    const display = uploadName(doc.name);
    const attachedTo = ops.find((op) => op.attachments.some((a) => a.filename === display));
    if (attachedTo) {
      report.alreadyAttached.push({ file: doc.path, op: attachedTo.id });
      continue;
    }
    const ranked = ops
      .map((op) => ({ op, score: scoreMatch(doc, op) }))
      .filter((c) => c.score.amount > 0 && c.score.total >= 0.4)
      .sort(
        (a, b) =>
          b.score.total - a.score.total || a.op.attachments.length - b.op.attachments.length,
      );
    const toCandidate = ({ op, score }: (typeof ranked)[number]): Candidate => ({
      op: op.id,
      date: op.date,
      wording: op.wording,
      amount: op.amount,
      score: score.total,
      why: `${score.reasons.join(', ')} (score ${score.total.toFixed(2)})`,
    });
    const best = ranked[0];
    if (!best) {
      report.unmatched.push({
        file: doc.path,
        reason:
          doc.extracted || doc.amounts.length
            ? 'no operation with a matching amount near the document date'
            : 'no text could be extracted (scanned PDF or image?)',
        detected: { totals: doc.totals.slice(0, 5), dates: doc.dates.slice(0, 5) },
      });
      continue;
    }
    const second = ranked[1];
    const confident =
      best.score.total >= options.minScore &&
      (!second || best.score.total - second.score.total >= margin);
    if (!confident) {
      report.ambiguous.push({
        file: doc.path,
        candidates: ranked.slice(0, 3).map(toCandidate),
        reason:
          best.score.total < options.minScore
            ? `best score ${best.score.total.toFixed(2)} is below --min-score ${options.minScore}`
            : `${ranked.length} operations score within ${margin} of each other`,
      });
      continue;
    }
    const previous = claimed.get(best.op.id);
    if (previous) {
      report.ambiguous.push({
        file: doc.path,
        candidates: [toCandidate(best)],
        reason: `same operation as ${basename(previous)}`,
      });
      continue;
    }
    claimed.set(best.op.id, doc.path);
    report.matched.push({
      file: doc.path,
      best: toCandidate(best),
      runnersUp: ranked.slice(1, 3).map(toCandidate),
    });
    steps.push({
      op: best.op.id,
      action: 'attach',
      file: doc.path,
      why: toCandidate(best).why,
    });
  }
  return { report, steps };
}
