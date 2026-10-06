import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { DougsError, usage } from '../output/errors.js';
import { Cache } from './cache.js';
import type { ApiClient } from './client.js';
import {
  accountSchema,
  categorySchema,
  normalizeOperation,
  type Operation,
  type RawOperation,
  rawOperationSchema,
} from './schemas.js';
export interface ListOptions {
  validated?: boolean;
  unvalidated?: boolean;
  from?: string;
  to?: string;
  search?: string;
  missingReceipt?: boolean;
  category?: number;
  expense?: boolean;
  income?: boolean;
  limit?: number;
  all?: boolean;
}
export function validateFilters(o: ListOptions): void {
  if (o.validated && o.unvalidated)
    usage('Choose --validated or --unvalidated');
  if (o.expense && o.income) usage('Choose --expense or --income');
  for (const d of [o.from, o.to])
    if (d && !z.iso.date().safeParse(d).success)
      usage('Dates must be YYYY-MM-DD');
  if (o.from && o.to && o.from > o.to) usage('--from must not be after --to');
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1))
    usage('--limit must be a positive integer');
}
export const uploadName = (file: string) => basename(file).replace(/^\d+_/, '');
export const safeName = (name: string) =>
  basename(name.replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 180) || 'document';
export class Resources {
  constructor(
    public client: ApiClient,
    public company: string,
    private cache = new Cache(company),
  ) {}
  path(id?: string): string {
    if (id !== undefined && !/^\d+$/.test(id))
      usage('Operation id must be numeric');
    return `/companies/${this.company}/operations${id ? `/${id}` : ''}`;
  }
  async get(id: string): Promise<RawOperation> {
    const result = rawOperationSchema.safeParse(
      await this.client.request('GET', this.path(id)),
    );
    if (!result.success)
      throw new DougsError(
        'API_SHAPE',
        'Operation schema changed',
        6,
        'run dougs doctor',
      );
    return result.data;
  }
  async accounts() {
    const raw = await this.client.request(
      'GET',
      `/companies/${this.company}/accounts`,
    );
    const parsed = z
      .array(
        z.looseObject({
          id: z.union([z.number(), z.string()]),
          accountName: z.string().nullable().optional(),
          bankName: z.string().nullable().optional(),
          currency: z.string().optional(),
          closed: z.boolean().optional(),
          hidden: z.boolean().optional(),
          metadata: z
            .looseObject({
              balance: z
                .looseObject({ balance: z.number().nullable().optional() })
                .optional(),
              balanceUpdatedAt: z.string().optional(),
            })
            .optional(),
        }),
      )
      .parse(raw);
    return {
      raw,
      data: parsed.map((a) =>
        accountSchema.parse({
          id: String(a.id),
          name: a.accountName ?? a.bankName ?? '',
          bank: a.bankName ?? '',
          currency: a.currency ?? 'EUR',
          balance: a.metadata?.balance?.balance ?? null,
          balanceUpdatedAt: a.metadata?.balanceUpdatedAt ?? null,
          closed: a.closed ?? false,
          hidden: a.hidden ?? false,
        }),
      ),
    };
  }
  async categories() {
    const cached = await this.cache.get('categories', 86400000);
    const raw =
      cached ??
      (await this.client.request(
        'GET',
        `/companies/${this.company}/categories?full=true`,
      ));
    const parsed = z
      .array(
        z.looseObject({
          id: z.number(),
          wording: z.string(),
          groupName: z.string().nullable().optional(),
          parentId: z.number().nullable().optional(),
          isAssignable: z.boolean().optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .parse(raw);
    if (cached === undefined) await this.cache.set('categories', raw);
    const byId = new Map(parsed.map((c) => [c.id, c]));
    return {
      raw,
      data: parsed
        .filter((c) => c.isAssignable !== false && !c.hidden)
        .map((c) => {
          const path = [c.wording];
          let p = c.parentId;
          const visited = new Set([c.id]);
          while (p != null && !visited.has(p)) {
            visited.add(p);
            const parent = byId.get(p);
            if (!parent) break;
            path.unshift(parent.wording);
            p = parent.parentId;
          }
          if (path.length === 1 && c.groupName) path.unshift(c.groupName);
          return categorySchema.parse({ id: c.id, name: c.wording, path });
        }),
    };
  }
  async list(
    o: ListOptions = {},
  ): Promise<{ raw: RawOperation[]; data: Operation[] }> {
    validateFilters(o);
    const states = o.validated
      ? [true]
      : o.unvalidated
        ? [false]
        : [false, true];
    const collected: RawOperation[] = [];
    for (const validated of states)
      for (let offset = 0; ; offset += 40) {
        const page = z
          .array(rawOperationSchema)
          .safeParse(
            await this.client.request(
              'GET',
              `${this.path()}?limit=40&offset=${offset}&needsAttention=false&validated=${validated}`,
            ),
          );
        if (!page.success)
          throw new DougsError(
            'API_SHAPE',
            'Operations schema changed',
            6,
            'run dougs doctor',
          );
        collected.push(...page.data);
        if (page.data.length < 40) break;
      }
    const accounts = (await this.accounts()).data;
    const unique = new Map(collected.map((r) => [String(r.id), r]));
    const filtered = [...unique.values()]
      .filter((r) => !r.deleted && !r.excluded)
      .map((raw) => ({
        raw,
        op: normalizeOperation(raw, this.company, accounts),
      }))
      .filter(
        ({ op }) =>
          (!o.from || op.date >= o.from) &&
          (!o.to || op.date <= o.to) &&
          (!o.search ||
            op.wording.toLowerCase().includes(o.search.toLowerCase())) &&
          (!o.missingReceipt || op.attachments.length === 0) &&
          (o.category === undefined ||
            op.breakdowns.some((b) => (b.category?.id ?? -1) === o.category)) &&
          (!o.expense || op.direction === 'expense') &&
          (!o.income || op.direction === 'income'),
      )
      .sort(
        (a, b) =>
          b.op.date.localeCompare(a.op.date) || a.op.id.localeCompare(b.op.id),
      );
    const result = o.all ? filtered : filtered.slice(0, o.limit ?? 50);
    return { raw: result.map((r) => r.raw), data: result.map((r) => r.op) };
  }
  async fileInfo(raw: RawOperation, attachmentId: string) {
    const attachment = raw.sourceDocumentAttachments.find(
      (a) => String(a.id) === attachmentId,
    );
    if (!attachment)
      throw new DougsError('NOT_FOUND', 'Attachment not found', 4);
    let file = attachment.sourceDocument.file;
    if (
      !file &&
      attachment.sourceDocument.type === 'vendorInvoice' &&
      attachment.sourceDocument.externalId
    ) {
      const invoice = z
        .looseObject({
          file: z.looseObject({
            id: z.union([z.number(), z.string()]),
            name: z.string(),
            url: z.string().optional(),
            size: z.number().optional(),
          }),
        })
        .parse(
          await this.client.request(
            'GET',
            `/companies/${this.company}/vendor-invoices/${encodeURIComponent(attachment.sourceDocument.externalId)}`,
          ),
        );
      file = invoice.file;
    }
    if (!file)
      throw new DougsError(
        'FILE_MISSING',
        'Attachment has no downloadable file',
        4,
      );
    return file;
  }
  async fileBytes(
    raw: RawOperation,
    attachmentId: string,
  ): Promise<Uint8Array> {
    const file = await this.fileInfo(raw, attachmentId);
    const path = file.url?.startsWith('/')
      ? file.url
      : `/files/${file.id}/actions/download`;
    return this.client.download(path);
  }
  async download(raw: RawOperation, dir: string, prefix = true) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const results = [];
    for (const attachment of raw.sourceDocumentAttachments) {
      const file = await this.fileInfo(raw, String(attachment.id));
      const dest = join(
        dir,
        `${prefix ? `${raw.id}_` : ''}${safeName(file.name)}`,
      );
      const previous = await stat(dest).catch(() => null);
      if (previous && file.size !== undefined && previous.size === file.size) {
        results.push({ op: String(raw.id), file: dest, status: 'skipped' });
        continue;
      }
      const bytes = await this.fileBytes(raw, String(attachment.id));
      if (previous && previous.size === bytes.length) {
        results.push({ op: String(raw.id), file: dest, status: 'skipped' });
        continue;
      }
      const temp = `${dest}.${process.pid}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, dest);
      results.push({
        op: String(raw.id),
        file: dest,
        status: 'downloaded',
        size: bytes.length,
      });
    }
    return results;
  }
  async attach(id: string, file: string, name?: string): Promise<void> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([await readFile(file)]),
      name ?? uploadName(file),
    );
    await this.client.request(
      'POST',
      `${this.path(id)}/source-document-attachments/actions/create-from-formdata`,
      form,
    );
  }
}
