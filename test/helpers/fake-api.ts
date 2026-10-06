import {
  COMPANY,
  type RawOpFixture,
  rawAccounts,
  rawCategories,
  rawUser,
  recoverage,
} from './fixtures.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response> | undefined;

/**
 * In-memory stand-in for the Dougs API, faithful to the behaviours the CLI
 * depends on: date-descending pagination by validation status, edits read from
 * `breakdowns` (not `updatedBreakdown`), the exemption slot appearing once VAT
 * is zero, and file downloads redirecting to signed storage.
 */
export class FakeDougs {
  ops = new Map<string, RawOpFixture>();
  requests: RecordedRequest[] = [];
  vendorInvoices = new Map<string, unknown>();
  declarations: { summary: Record<string, unknown>; form: Record<string, unknown> | null }[] = [];
  accountingYears = [{ id: 1, openingDate: '2025-03-01', closingDate: '2025-12-31', closed: true }];
  /** Server-side side effects of an operation update (e.g. re-categorization side effects). */
  onUpdate?: (previous: RawOpFixture, next: RawOpFixture) => void;
  files = new Map<string, Uint8Array>();
  session = 'synthetic-session-value';
  overrides: Handler[] = [];
  nextAttachmentId = 900_000;

  constructor(ops: RawOpFixture[] = []) {
    for (const op of ops) this.ops.set(String(op.id), structuredClone(op));
  }

  get writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const req: RecordedRequest = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    };
    this.requests.push(req);
    if (url.hostname === 'storage.example.test') {
      const file = this.files.get(url.pathname);
      return file
        ? new Response(new Blob([file as Uint8Array<ArrayBuffer>]))
        : new Response('missing', { status: 404 });
    }
    for (const override of this.overrides) {
      const res = await override(req);
      if (res) return res;
    }
    if (headers.get('cookie') !== `auth_session=${this.session}`)
      return Response.json({ message: 'Unauthorized', statusCode: 401 }, { status: 401 });
    return this.route(req);
  };

  private route(req: RecordedRequest): Response {
    const c = `/companies/${COMPANY}`;
    const { method, path } = req;
    if (method === 'GET' && path === '/users/me') return Response.json(rawUser());
    if (method === 'GET' && path === `${c}/accounts`) return Response.json(rawAccounts());
    if (method === 'GET' && path === `${c}/categories`) return Response.json(rawCategories());
    if (method === 'GET' && path === `${c}/accounting-years`)
      return Response.json(this.accountingYears);
    if (method === 'GET' && path === `${c}/declarations/list-declarations`)
      return Response.json(
        this.declarations
          .map((d) => ({ status: 'completed', ...d.summary }))
          .filter((d) => d.status === (req.query.get('status') ?? 'completed'))
          .map(({ status: _status, ...summary }) => summary),
      );
    const decl = path.match(new RegExp(`^${c}/declarations/(\\d+)$`));
    if (method === 'GET' && decl) {
      const d = this.declarations.find((x) => String(x.summary.id) === decl[1]);
      return d ? Response.json({ ...d.summary, form: d.form }) : notFound();
    }
    const vi = path.match(new RegExp(`^${c}/vendor-invoices/(.+)$`));
    if (method === 'GET' && vi) {
      const v = this.vendorInvoices.get(decodeURIComponent(vi[1]!));
      return v ? Response.json(v) : notFound();
    }
    if (method === 'GET' && path === `${c}/operations`) return Response.json(this.list(req.query));
    const file = path.match(/^\/files\/([^/]+)\/actions\/download$/);
    if (method === 'GET' && file) {
      const key = `/${file[1]}`;
      return this.files.has(key)
        ? new Response(null, {
            status: 302,
            headers: { location: `https://storage.example.test${key}?X-Signature=abc` },
          })
        : notFound();
    }
    const att = path.match(
      new RegExp(`^${c}/operations/(\\d+)/source-document-attachments/(\\d+)$`),
    );
    if (method === 'DELETE' && att) {
      const op = this.ops.get(att[1]!);
      if (!op) return notFound();
      op.sourceDocumentAttachments = op.sourceDocumentAttachments.filter(
        (a) => String(a.id) !== att[2],
      );
      return new Response(null, { status: 204 });
    }
    const upload = path.match(
      new RegExp(
        `^${c}/operations/(\\d+)/source-document-attachments/actions/create-from-formdata$`,
      ),
    );
    if (method === 'POST' && upload) {
      const op = this.ops.get(upload[1]!);
      if (!op || !(req.body instanceof FormData)) return notFound();
      for (const entry of req.body.getAll('file')) {
        const name = (entry as File).name;
        const id = this.nextAttachmentId++;
        op.sourceDocumentAttachments.push({
          id,
          sourceDocument: {
            id,
            type: 'unknown',
            externalId: null,
            file: {
              id,
              name,
              url: `/files/uploaded-${id}/actions/download`,
              mimeType: 'application/pdf',
            },
          },
        });
      }
      return Response.json(op);
    }
    const one = path.match(new RegExp(`^${c}/operations/(\\d+)$`));
    if (one && method === 'GET') {
      const op = this.ops.get(one[1]!);
      return op
        ? Response.json(op)
        : Response.json({ message: 'Not Found', statusCode: 404 }, { status: 404 });
    }
    if (one && method === 'POST') {
      const current = this.ops.get(one[1]!);
      if (!current) return notFound();
      const sent = req.body as RawOpFixture & { updatedBreakdown?: unknown };
      // Like Dougs: locked ledgers refuse edits unless force=true (an accountant unlocking).
      if ((current.manuallyLocked || current.lockedByDate) && req.query.get('force') !== 'true')
        return Response.json(
          { message: 'Locked', statusCode: 400 },
          {
            status: 400,
            headers: { 'X-Message-Code': 'accountingLine.lockedByDateWithAccountingNumber' },
          },
        );
      if (sent.validated && !current.validated) {
        const invalid =
          current.errors.length > 0 ||
          sent.breakdowns.some((b) => !b.isCounterpart && b.categoryId === -1);
        if (invalid)
          return Response.json(
            { message: 'Operation has errors', statusCode: 400 },
            { status: 400 },
          );
      }
      // Like Dougs: the edit is read from `breakdowns`; updatedBreakdown is only a marker.
      const next: RawOpFixture = {
        ...current,
        memo: sent.memo,
        validated: sent.validated,
        breakdowns: structuredClone(sent.breakdowns),
      };
      for (const b of next.breakdowns) {
        // Server-computed recoverable VAT (partially recoverable categories).
        const rec = recoverage(b.categoryId);
        b.vatAmountWithRecoverageRate = Math.round(b.vatAmount * rec * 100) / 100;
        b.amountExcludingTaxesWithRecoverageRate =
          Math.round((b.amount - b.vatAmountWithRecoverageRate) * 100) / 100;
        if (
          b.categoryId !== -1 &&
          b.vatAmount === 0 &&
          !b.associations?.some((a) => a.name === 'vatExemptionReason')
        )
          b.associations = [...(b.associations ?? []), { name: 'vatExemptionReason', slots: {} }];
      }
      this.onUpdate?.(current, next);
      this.ops.set(one[1]!, next);
      return Response.json(next);
    }
    return notFound();
  }

  private list(query: URLSearchParams): RawOpFixture[] {
    const validated = query.get('validated') === 'true';
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 40);
    return [...this.ops.values()]
      .filter((op) => op.validated === validated)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .slice(offset, offset + limit);
  }

  pagesFetched(validated: boolean): number {
    return this.requests.filter(
      (r) => r.path.endsWith('/operations') && r.query.get('validated') === String(validated),
    ).length;
  }
}

function notFound(): Response {
  return Response.json({ message: 'Not Found', statusCode: 404 }, { status: 404 });
}
