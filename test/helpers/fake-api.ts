import {
  COMPANY,
  type RawOpFixture,
  rawAccounts,
  rawCategories,
  rawSalesChannels,
  rawUser,
  recoverage,
  ventilationBreakdown,
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
 * In-memory stand-in for the Dougs API. Behaviours marked OBSERVED were seen
 * live or in the web app's code; those marked ASSUMED are plausible models,
 * not proof of how Dougs behaves — a passing test against them is not evidence.
 *
 * Faithful to the behaviours the CLI depends on: date-descending pagination by validation status, edits read from
 * `breakdowns` (not `updatedBreakdown`), the exemption slot appearing once VAT
 * is zero, and file downloads redirecting to signed storage.
 */
export class FakeDougs {
  ops = new Map<string, RawOpFixture>();
  requests: RecordedRequest[] = [];
  vendorInvoices = new Map<string, unknown>();
  declarations: { summary: Record<string, unknown>; form: Record<string, unknown> | null }[] = [];
  accountingYears = [{ id: 1, openingDate: '2025-03-01', closingDate: '2025-12-31', closed: true }];
  /** Operations whose un-validation Dougs refuses (e.g. under review by the accountant). */
  frozen = new Set<string>();
  /** Server-side side effects of an operation update (e.g. re-categorization side effects). */
  onUpdate?: (previous: RawOpFixture, next: RawOpFixture) => void;
  files = new Map<string, Uint8Array>();
  session = 'synthetic-session-value';
  overrides: Handler[] = [];
  nextAttachmentId = 900_000;
  nextBreakdownId = 800_000;
  salesChannels: unknown[] = rawSalesChannels();
  /** Reads of a ventilation until Dougs' asynchronous recompute shows (Infinity: never). */
  recomputeAfterReads = 2;
  pendingRecompute = new Map<string, number>();
  /**
   * Password login. OBSERVED (web app code): endpoints, request bodies and the
   * authenticated / mfaRequired / ssoRequired statuses. ASSUMED: HTTP 401 for a
   * wrong password or code, and a pending cookie carrying the MFA step.
   */
  account = {
    email: 'someone@example.test',
    password: 'synthetic-password',
    factors: [] as { type: 'totp' | 'email'; lastUsedAt?: string }[],
    code: '123456',
    sso: false,
    maxAgeSeconds: 30 * 86_400,
  };
  emailCodesSent = 0;
  anonymousCookies = 0;
  remoteLogouts = 0;
  private readonly pendingSession = 'synthetic-pending-mfa';

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
    if (req.method === 'POST' && req.path.startsWith('/auth/api/')) return this.auth(req);
    if (headers.get('cookie') !== `auth_session=${this.session}`) return this.unauthorized();
    return this.route(req);
  };

  /**
   * OBSERVED: an unknown, expired or missing session gets a 401 that also sets a brand-new
   * anonymous auth_session cookie with a future expiry.
   */
  unauthorized(message = 'Unauthorized'): Response {
    this.anonymousCookies++;
    const expires = new Date(Date.now() + 14 * 86_400_000).toUTCString();
    return Response.json(
      { message, statusCode: 401 },
      {
        status: 401,
        headers: {
          'set-cookie': `auth_session=synthetic-anonymous-${this.anonymousCookies}; Path=/; Expires=${expires}; HttpOnly`,
        },
      },
    );
  }

  private auth(req: RecordedRequest): Response {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = req.headers.get('cookie') === `auth_session=${this.pendingSession}`;
    const unauthorized = () => this.unauthorized();
    const withCookie = (data: unknown, value: string, maxAge: number) =>
      Response.json(data, {
        headers: {
          'set-cookie': `auth_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    if (req.path === '/auth/api/login') {
      if (body.email !== this.account.email || body.password !== this.account.password)
        return this.unauthorized('Identifiants invalides');
      if (this.account.sso) return Response.json({ status: 'ssoRequired' });
      if (this.account.factors.length)
        return withCookie(
          { status: 'mfaRequired', enabledAuthFactors: this.account.factors },
          this.pendingSession,
          600,
        );
      return withCookie({ status: 'authenticated' }, this.session, this.account.maxAgeSeconds);
    }
    if (req.path === '/auth/api/mfa/send-email') {
      if (!pending) return unauthorized();
      this.emailCodesSent++;
      return Response.json({});
    }
    if (req.path === '/auth/api/mfa/verify') {
      if (!pending || body.token !== this.account.code) return unauthorized();
      return withCookie({ status: 'authenticated' }, this.session, this.account.maxAgeSeconds);
    }
    return notFound();
  }

  private route(req: RecordedRequest): Response {
    const c = `/companies/${COMPANY}`;
    const { method, path } = req;
    if (method === 'GET' && path === '/users/me') return Response.json(rawUser());
    if (method === 'GET' && path === '/auth/api/logout') {
      this.remoteLogouts++;
      return Response.json({});
    }
    if (method === 'GET' && path === `${c}/accounts`) return Response.json(rawAccounts());
    if (method === 'GET' && path === `${c}/categories`) return Response.json(rawCategories());
    if (method === 'GET' && path === `${c}/salesChannels`) return Response.json(this.salesChannels);
    const sales = path.match(new RegExp(`^${c}/operations/(\\d+)/ecommerceSales(?:/(\\d+))?$`));
    if (sales) return this.ecommerceSales(req, sales[1]!, sales[2]);
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
      if (op) this.tickRecompute(op);
      return op
        ? Response.json(op)
        : Response.json({ message: 'Not Found', statusCode: 404 }, { status: 404 });
    }
    if (one && method === 'POST') {
      const current = this.ops.get(one[1]!);
      if (!current) return notFound();
      const sent = req.body as RawOpFixture & { updatedBreakdown?: unknown };
      // ASSUMED: the status code and body of the locked-ledger refusal. OBSERVED (web app
      // code): the X-Message-Code header value, and that force=true unlocks.
      if ((current.manuallyLocked || current.lockedByDate) && req.query.get('force') !== 'true')
        return Response.json(
          { message: 'Locked', statusCode: 400 },
          {
            status: 400,
            headers: { 'X-Message-Code': 'accountingLine.lockedByDateWithAccountingNumber' },
          },
        );
      // ASSUMED: server-side refusal of validation for operations with errors (the web
      // app refuses client-side; what the server does is unverified).
      // OBSERVED (live 403) + web app code (isReadOnly = validated || locked): a validated
      // operation can't be edited while it stays validated; un-validating it is allowed
      // (the validate toggle) unless the operation is frozen.
      if (current.validated) {
        if (!sent.validated && this.frozen.has(one[1]!))
          return Response.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 });
        const edited =
          sent.validated &&
          (JSON.stringify(sent.breakdowns) !== JSON.stringify(current.breakdowns) ||
            sent.memo !== current.memo);
        if (edited)
          return Response.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 });
      }
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
      // OBSERVED: the edit is read from `breakdowns`; updatedBreakdown is only a marker.
      const next: RawOpFixture = {
        ...current,
        memo: sent.memo,
        validated: sent.validated,
        breakdowns: structuredClone(sent.breakdowns),
      };
      for (const b of next.breakdowns) {
        // ASSUMED: Dougs recomputes the recoverable-VAT fields on update (the web app sends
        // them unchanged with a new VAT amount, which suggests it does).
        const rec = recoverage(b.categoryId);
        b.vatAmountWithRecoverageRate = Math.round(b.vatAmount * rec * 100) / 100;
        b.amountExcludingTaxesWithRecoverageRate =
          Math.round((b.amount - b.vatAmountWithRecoverageRate) * 100) / 100;
        // OBSERVED (live data): lines with hasVat=false never get an exemption slot.
        if (
          b.categoryId !== -1 &&
          b.hasVat !== false &&
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

  /**
   * E-commerce ventilation lines. OBSERVED (web app traffic): create with amount 0, then
   * update by breakdown id with the line sent back; the listing groups exempt service sales
   * under subsection `exonerateSale`. OBSERVED (live): right after the writes the operation
   * has amount 0 and no counterpart; seconds later Dougs creates the counterpart, and both it
   * and the amount equal sales − fees. Modelled as: the recompute lands on the
   * `recomputeAfterReads`-th read of the operation after the last write.
   * ASSUMED: validated operations refuse these writes with 403, like other edits.
   */
  private ecommerceSales(req: RecordedRequest, opId: string, breakdownId?: string): Response {
    const op = this.ops.get(opId);
    if (!op) return notFound();
    const lineOf = (b: RawOpFixture['breakdowns'][number]) => {
      const fee = b.section === 'ecommerceDispatch:fees';
      return {
        saleId: fee ? 'fees' : b.associationData.vatExemptionReason,
        label: fee ? 'Fictional Pay - ' : 'Exempt zone',
        flag: fee ? 'payment' : 'eu',
        amount: b.amount,
        taxRate: 0,
        vatAmount: 0,
        breakdownId: b.id,
        isRefund: false,
        ...(fee ? { paymentsProcessorId: b.associationData.paymentsProcessorId } : {}),
      };
    };
    const linesIn = (section: string) =>
      op.breakdowns.filter((b) => !b.isCounterpart && b.section === section).map(lineOf);
    if (req.method === 'GET' && !breakdownId)
      return Response.json({
        salesChannelName: 'Fictional App Store',
        totalAmount: this.salesTotal(op),
        totalVatAmount: 0,
        sections: [
          {
            sectionId: 'service',
            subSections: [
              { sectionId: 'service', subSectionId: 'fr', sales: [] },
              {
                sectionId: 'service',
                subSectionId: 'exonerateSale',
                sales: linesIn('ecommerceDispatch:sales:service'),
              },
            ],
          },
          {
            sectionId: 'fees',
            subSections: [
              { sectionId: 'fees', subSectionId: 'fees', sales: linesIn('ecommerceDispatch:fees') },
            ],
          },
          {
            sectionId: 'ecommerceExpenses',
            subSections: [
              { sectionId: 'ecommerceExpenses', subSectionId: 'ecommerceExpenses', sales: [] },
            ],
          },
        ],
      });
    if (req.method !== 'POST') return notFound();
    if (op.validated)
      return Response.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 });
    const sale = (req.body as { ecommerceSale?: Record<string, unknown> }).ecommerceSale;
    if (!sale) return Response.json({ message: 'Bad Request', statusCode: 400 }, { status: 400 });
    let b: RawOpFixture['breakdowns'][number] | undefined;
    if (!breakdownId) {
      const id = this.nextBreakdownId++;
      b =
        sale.saleId === 'fees'
          ? ventilationBreakdown(id, {
              kind: 'fee',
              processor: sale.paymentsProcessorId as number,
              amount: 0,
            })
          : ventilationBreakdown(id, { kind: 'sale', saleId: String(sale.saleId), amount: 0 });
      op.breakdowns.push(b);
    } else {
      b = op.breakdowns.find((x) => String(x.id) === breakdownId && !x.isCounterpart);
      if (!b) return notFound();
      b.amount = sale.amount as number;
      b.amountExcludingTaxesWithRecoverageRate = b.amount;
    }
    op.breakdowns = op.breakdowns.filter((x) => !x.isCounterpart);
    op.amount = 0;
    this.pendingRecompute.set(opId, this.recomputeAfterReads);
    return Response.json({
      ...lineOf(b),
      ...(breakdownId ? { totalAmount: this.salesTotal(op), totalVatAmount: 0 } : {}),
    });
  }

  /** Count a read of the operation towards its pending recompute; apply it when due. */
  private tickRecompute(op: RawOpFixture): void {
    const key = String(op.id);
    const left = this.pendingRecompute.get(key);
    if (left === undefined) return;
    if (left > 1) {
      this.pendingRecompute.set(key, left - 1);
      return;
    }
    this.pendingRecompute.delete(key);
    const net = Math.round((this.salesTotal(op) - total(op, 'ecommerceDispatch:fees')) * 100) / 100;
    op.breakdowns.push(
      ventilationBreakdown(this.nextBreakdownId++, { kind: 'counterpart', amount: net }),
    );
    op.amount = net;
  }

  private salesTotal(op: RawOpFixture): number {
    return total(op, 'ecommerceDispatch:sales:service');
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

function total(op: RawOpFixture, section: string): number {
  const sum = op.breakdowns
    .filter((b) => !b.isCounterpart && b.section === section)
    .reduce((s, b) => s + Math.round(b.amount * 100), 0);
  return sum / 100;
}

function notFound(): Response {
  return Response.json({ message: 'Not Found', statusCode: 404 }, { status: 404 });
}
