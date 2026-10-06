import { basename } from 'node:path';
import { z } from 'zod';
import { DougsError, ExitCode, usageError } from '../output/errors.js';
import { analyzeDocumentText, type DocumentFacts, extractPdfText } from '../pdf/extract.js';
import { mimeType } from '../plan/attachments.js';
import { type DateRange, inRange } from '../util/dates.js';
import { includesLoose } from '../util/text.js';
import { type Cache, DAY } from './cache.js';
import type { ApiClient } from './client.js';
import { normalizeAccount, normalizeCategory, normalizeOperation } from './normalize.js';
import {
  type Account,
  type Attachment,
  type Category,
  type Operation,
  type RawBreakdown,
  type RawCategory,
  type RawOperation,
  type RawVendorInvoice,
  rawAccountingYearSchema,
  rawAccountSchema,
  rawCategorySchema,
  rawDeclarationSchema,
  rawDeclarationSummarySchema,
  rawOperationSchema,
  rawVendorInvoiceSchema,
} from './schemas.js';

export const PAGE_SIZE = 40;

export const DECLARATION_STATUSES = ['completed', 'ready_to_complete', 'upcoming'] as const;
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number];
export type DeclarationSummary = z.infer<typeof rawDeclarationSummarySchema> & {
  status: DeclarationStatus;
};

/**
 * Any VAT return: monthly/quarterly CA3, annual CA12 (simplified regime), or a
 * declaration in Dougs' `vat:*` group.
 */
export function isVatReturn(d: { type: string; group?: string | null }): boolean {
  return /^(CA3|CA12|3310|3517)/i.test(d.type) || !!d.group?.startsWith('vat');
}

/** Answers "why must this date not be edited?" (null when it may be). */
export interface PeriodGuard {
  reason(date: string): string | null;
}

export type ValidationStatus = 'all' | 'validated' | 'unvalidated';

export interface OperationFilter extends DateRange {
  status?: ValidationStatus;
  search?: string;
  direction?: 'expense' | 'income';
  category?: number;
  missingReceipt?: boolean;
  /** Stop after this many matches (newest first). Omit for everything. */
  limit?: number;
}

export interface OperationRecord {
  raw: RawOperation;
  op: Operation;
}

/** Strip the local `{opId}_` prefix: Dougs displays the uploaded filename. */
export function uploadName(file: string): string {
  return basename(file).replace(/^\d+_/, '');
}

function parseOrDrift<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new DougsError(
    'API_SHAPE',
    `Unexpected ${what} shape from Dougs (${issue?.path.join('.') || 'root'}: ${issue?.message})`,
    { exitCode: ExitCode.network, hint: 'the private API may have changed; run: dougs doctor' },
  );
}

function matchesFilter(op: Operation, f: OperationFilter): boolean {
  if (!inRange(op.date, f)) return false;
  if (f.direction && op.direction !== f.direction) return false;
  if (f.missingReceipt && op.attachments.length > 0) return false;
  if (
    f.category !== undefined &&
    !op.breakdowns.some((b) => !b.isCounterpart && (b.category?.id ?? -1) === f.category)
  )
    return false;
  if (f.search && !includesLoose(`${op.wording} ${op.memo ?? ''}`, f.search)) return false;
  return true;
}

/** Company-scoped access to the Dougs API, returning normalized data. */
export class Dougs {
  private accountNames?: Promise<Map<string, string>>;

  constructor(
    readonly client: ApiClient,
    readonly company: string,
    private readonly cache: Cache,
  ) {}

  private path(suffix = ''): string {
    return `/companies/${this.company}${suffix}`;
  }

  opPath(id: string): string {
    if (!/^\d+$/.test(id)) throw usageError(`Operation ids are numeric, got "${id}"`);
    return this.path(`/operations/${id}`);
  }

  // ── operations ──────────────────────────────────────────────────────

  async operationsPage(validated: boolean, offset: number): Promise<RawOperation[]> {
    const query = `limit=${PAGE_SIZE}&offset=${offset}&needsAttention=false&validated=${validated}`;
    const page = await this.client.get(this.path(`/operations?${query}`));
    return parseOrDrift(z.array(rawOperationSchema), page, 'operations list');
  }

  /**
   * Fetch operations newest-first. Dougs returns each list (validated /
   * unvalidated) sorted by date descending, so paging stops as soon as a page
   * ends before `from`, or once `limit` matches are certain.
   */
  async listOperations(filter: OperationFilter = {}): Promise<OperationRecord[]> {
    const status = filter.status ?? 'all';
    const lists = status === 'all' ? [true, false] : [status === 'validated'];
    const accounts = await this.accountNameMap();
    const streams = await Promise.all(
      lists.map((validated) => this.collect(validated, filter, accounts)),
    );
    const merged = new Map<string, OperationRecord>();
    for (const record of streams.flat()) merged.set(record.op.id, record);
    const sorted = [...merged.values()].sort(
      (a, b) => b.op.date.localeCompare(a.op.date) || Number(b.op.id) - Number(a.op.id),
    );
    return filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
  }

  private async collect(
    validated: boolean,
    filter: OperationFilter,
    accounts: Map<string, string>,
  ): Promise<OperationRecord[]> {
    const out: OperationRecord[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.operationsPage(validated, offset);
      let sorted = true;
      for (let i = 0; i < page.length; i++) {
        const raw = page[i]!;
        if (i > 0 && raw.date > page[i - 1]!.date) sorted = false;
        if (raw.deleted || raw.excluded) continue;
        const op = normalizeOperation(raw, { company: this.company, accounts });
        if (matchesFilter(op, filter)) out.push({ raw, op });
      }
      if (page.length < PAGE_SIZE) break;
      const oldest = page.at(-1)?.date ?? '';
      if (sorted && filter.from && oldest < filter.from) break;
      if (sorted && filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
  }

  async getRaw(id: string): Promise<RawOperation> {
    return parseOrDrift(rawOperationSchema, await this.client.get(this.opPath(id)), 'operation');
  }

  async getOperation(id: string): Promise<OperationRecord> {
    const raw = await this.getRaw(id);
    return {
      raw,
      op: normalizeOperation(raw, { company: this.company, accounts: await this.accountNameMap() }),
    };
  }

  /**
   * Persist an edit the way the web app does: POST the full operation with the
   * patched `breakdowns`. The server reads the change from `breakdowns`;
   * `updatedBreakdown` only flags which one changed. Returns the re-read state.
   */
  async updateOperation(raw: RawOperation, breakdown?: RawBreakdown): Promise<RawOperation> {
    const body: Record<string, unknown> = { ...raw };
    if (breakdown) {
      body.breakdowns = raw.breakdowns.map((b) =>
        String(b.id) === String(breakdown.id) ? breakdown : b,
      );
      body.updatedBreakdown = breakdown;
    }
    await this.client.post(this.opPath(String(raw.id)), body);
    return this.getRaw(String(raw.id));
  }

  /** Upload documents already read and validated by the caller (see plan/attachments). */
  async attachFiles(opId: string, files: { bytes: Uint8Array; name: string }[]): Promise<void> {
    const form = new FormData();
    for (const file of files)
      form.append(
        'file',
        new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: mimeType(file.name) }),
        file.name,
      );
    await this.client.post(
      `${this.opPath(opId)}/source-document-attachments/actions/create-from-formdata`,
      form,
    );
  }

  async detachAttachment(opId: string, attachmentId: string): Promise<void> {
    if (!/^\d+$/.test(attachmentId))
      throw usageError(`Attachment ids are numeric, got "${attachmentId}"`);
    await this.client.delete(`${this.opPath(opId)}/source-document-attachments/${attachmentId}`);
  }

  // ── reference data ──────────────────────────────────────────────────

  async accounts(): Promise<{ raw: unknown; data: Account[] }> {
    const raw = await this.client.get(this.path('/accounts'));
    const parsed = parseOrDrift(z.array(rawAccountSchema), raw, 'accounts');
    return { raw, data: parsed.map(normalizeAccount) };
  }

  private accountNameMap(): Promise<Map<string, string>> {
    this.accountNames ??= this.accounts().then(
      ({ data }) => new Map(data.map((a) => [a.id, a.name])),
      () => new Map(),
    );
    return this.accountNames;
  }

  /** Full category tree (~2.5 MB), cached for 24 h. */
  async rawCategories(): Promise<RawCategory[]> {
    const cached = await this.cache.getJson<unknown>('categories.json', DAY);
    const raw = cached ?? (await this.client.get(this.path('/categories?full=true')));
    const parsed = parseOrDrift(z.array(rawCategorySchema), raw, 'categories');
    if (cached === undefined) await this.cache.setJson('categories.json', raw);
    return parsed;
  }

  /** Categories a user can pick (not hidden, assignable). */
  async categories(): Promise<Category[]> {
    const raw = await this.rawCategories();
    return raw
      .filter((c) => !c.hidden && c.isAssignable !== false && c.id !== -1)
      .map(normalizeCategory);
  }

  async categoryIndex(): Promise<Map<number, Category>> {
    return new Map((await this.rawCategories()).map((c) => [c.id, normalizeCategory(c)]));
  }

  async vendorInvoice(id: string): Promise<RawVendorInvoice> {
    const key = `vendor-invoices/${id}.json`;
    const cached = await this.cache.getJson<unknown>(key, DAY);
    const raw =
      cached ?? (await this.client.get(this.path(`/vendor-invoices/${encodeURIComponent(id)}`)));
    const parsed = parseOrDrift(rawVendorInvoiceSchema, raw, 'vendor invoice');
    if (cached === undefined && parsed.prefillStatus === 'prefilled')
      await this.cache.setJson(key, raw);
    return parsed;
  }

  async downloadAttachment(att: Attachment): Promise<Uint8Array> {
    const path =
      att.downloadPath ??
      (att.vendorInvoiceId ? (await this.vendorInvoice(att.vendorInvoiceId)).filePath : null);
    if (!path?.startsWith('/'))
      throw new DougsError('FILE_MISSING', `Attachment ${att.id} has no downloadable file`, {
        exitCode: ExitCode.notFound,
      });
    return this.client.download(path);
  }

  /** Extracted text of a PDF attachment; file contents are immutable, so cached forever. */
  async attachmentText(att: Attachment): Promise<string | null> {
    const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.filename);
    if (!isPdf || !att.fileId) return null;
    const key = `pdf-text/${att.fileId}.txt`;
    const cached = await this.cache.getText(key);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = await extractPdfText(await this.downloadAttachment(att));
    } catch {
      return null; // not cached: a failed download or parse is retried next time
    }
    await this.cache.setText(key, text);
    return text;
  }

  async attachmentFacts(att: Attachment): Promise<DocumentFacts | null> {
    const text = await this.attachmentText(att);
    return text ? analyzeDocumentText(text) : null;
  }

  async accountingYears(): Promise<z.infer<typeof rawAccountingYearSchema>[]> {
    return parseOrDrift(
      z.array(rawAccountingYearSchema),
      await this.client.get(this.path('/accounting-years')),
      'accounting years',
    );
  }

  /**
   * Declaration summaries for all states: `completed` (filed), `ready_to_complete`
   * and `upcoming` (open; Dougs computes a draft form for these too).
   */
  async declarations(): Promise<DeclarationSummary[]> {
    const lists = await Promise.all(
      DECLARATION_STATUSES.map(async (status) => {
        const raw = await this.client.get(
          this.path(`/declarations/list-declarations?status=${status}&limit=200&offset=0`),
        );
        return parseOrDrift(z.array(rawDeclarationSummarySchema), raw, 'declarations').map((d) => ({
          ...d,
          status,
        }));
      }),
    );
    return lists.flat().filter((d) => !d.disabled && !d.skipped);
  }

  /**
   * Which dates must not be edited without --allow-filed-periods: months covered
   * by a filed CA3 (editing them desynchronizes the ledger from the return) and
   * closed accounting years.
   */
  async periodGuard(): Promise<PeriodGuard> {
    const [declarations, years] = await Promise.all([this.declarations(), this.accountingYears()]);
    const filed = declarations.filter((d) => d.status === 'completed' && isVatReturn(d));
    const closed = years.filter((y) => y.closed);
    return {
      reason(date: string) {
        const d = filed.find(
          (x) => date >= x.periodStartDate.slice(0, 10) && date <= x.periodEndDate.slice(0, 10),
        );
        if (d)
          return `its VAT return (${d.label ?? d.periodStartDate.slice(0, 7)}) is already filed`;
        const y = closed.find(
          (x) => date >= x.openingDate.slice(0, 10) && date <= x.closingDate.slice(0, 10),
        );
        if (y)
          return `its accounting year (${y.openingDate.slice(0, 10)} → ${y.closingDate.slice(0, 10)}) is closed`;
        return null;
      },
    };
  }

  async declaration(id: string): Promise<z.infer<typeof rawDeclarationSchema>> {
    return parseOrDrift(
      rawDeclarationSchema,
      await this.client.get(this.path(`/declarations/${id}`)),
      'declaration',
    );
  }
}
