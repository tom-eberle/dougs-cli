/**
 * Regression tests for the v0.1 review findings (B1, S1–S12, selected N items),
 * each driven through the FakeDougs harness.
 */
import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiClient, type Fetch } from '../src/api/client.js';
import { normalizeCategory, normalizeOperation } from '../src/api/normalize.js';
import { rawOperationSchema } from '../src/api/schemas.js';
import { pickCa3 } from '../src/commands/workflows.js';
import { applyPlan, executeStep } from '../src/plan/apply.js';
import { expectFor } from '../src/plan/diff.js';
import { buildPlan, type PlanStep, type StepDraft } from '../src/plan/types.js';
import type { CategoryIndex } from '../src/workflows/findings.js';
import { matchReceipts, type ReceiptDocument } from '../src/workflows/receipts.js';
import { checkVat, type DocumentEvidence, estimateCa3 } from '../src/workflows/vat.js';
import { VendorRegistry } from '../src/workflows/vendors.js';
import { FakeDougs } from './helpers/fake-api.js';
import {
  breakdown,
  COMPANY,
  type OpOptions,
  type RawOpFixture,
  rawCategories,
  rawOp,
} from './helpers/fixtures.js';
import { dougsFor, runCli, tempHome } from './helpers/run.js';

const toOp = (raw: RawOpFixture) =>
  normalizeOperation(rawOperationSchema.parse(raw), { company: COMPANY });
const op = (o: OpOptions) => toOp(rawOp(o));
const categories: CategoryIndex = new Map(rawCategories().map((c) => [c.id, normalizeCategory(c)]));
const step = (s: StepDraft, id = 's1') => ({ id, ...s }) as PlanStep;

function evidence(partial: Partial<DocumentEvidence>): DocumentEvidence {
  return {
    source: 'vendor-invoice',
    zone: null,
    vatAmount: null,
    chargesVat: false,
    reverseCharge: false,
    totals: [],
    currency: 'EUR',
    ...partial,
  };
}

function filedAugust(api: FakeDougs) {
  api.declarations.push({
    summary: {
      id: 80,
      type: 'CA3-2026',
      label: 'TVA - Août 2026',
      periodStartDate: '2026-08-01',
      periodEndDate: '2026-08-31',
      status: 'completed',
      confirmedAt: '2026-09-20',
    },
    form: { '08': 0 },
  });
}

describe('B1 locked operations', () => {
  it('refuses edits and validation on locked operations, in preview and apply, without ?force', async () => {
    const api = new FakeDougs([
      rawOp({ id: 1, locked: 'manual' }),
      rawOp({ id: 2, locked: 'date', validated: false }),
    ]);
    for (const args of [
      ['ops', 'set', '1', '--memo', 'x', '--yes'],
      ['ops', 'validate', '2', '--yes'],
      ['ops', 'set', '1', '--memo', 'x', '--dry-run'],
    ]) {
      const r = await runCli(api, args);
      expect(r.code, args.join(' ')).toBe(5);
      expect(r.error().code).toBe('LOCKED');
    }
    expect(api.writes).toHaveLength(0);
  });

  it('maps the server’s locked-ledger response to LOCKED (exit 5)', async () => {
    const api = new FakeDougs([rawOp({ id: 3 })]);
    api.overrides.push((req) =>
      req.method === 'POST'
        ? Response.json(
            { message: 'Locked', statusCode: 400 },
            {
              status: 400,
              headers: { 'X-Message-Code': 'accountingLine.lockedByDateWithAccountingNumber' },
            },
          )
        : undefined,
    );
    const r = await runCli(api, ['ops', 'set', '3', '--memo', 'x', '--yes']);
    expect(r.code).toBe(5);
    expect(r.error().code).toBe('LOCKED');
    expect(api.writes.every((w) => !w.query.has('force'))).toBe(true);
  });
});

describe('S1 failed exemption is rolled back or reported', () => {
  it('restores the VAT when Dougs offers no exemption slot', async () => {
    const api = new FakeDougs([rawOp({ id: 10, amount: 120 })]);
    api.onUpdate = (_prev, next) => {
      for (const b of next.breakdowns) b.associations = [{ name: 'supplier', slots: {} }];
    };
    await expect(
      executeStep(
        dougsFor(api),
        step({ op: '10', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'EXEMPTION_UNAVAILABLE',
      message: expect.stringContaining('restored'),
    });
    expect(toOp(api.ops.get('10')!)).toMatchObject({ vatAmount: 20, vatExemptReason: null });
  });

  it('reports a partial write with the changes that stuck', async () => {
    const api = new FakeDougs([rawOp({ id: 11, amount: 120, validated: false })]);
    let posts = 0;
    api.onUpdate = (prev, next) => {
      posts++;
      for (const b of next.breakdowns) b.associations = [{ name: 'supplier', slots: {} }];
      if (posts > 1) next.breakdowns = structuredClone(prev.breakdowns); // the restore is ignored
    };
    const report = await applyPlan(
      dougsFor(api),
      buildPlan(COMPANY, 't', [
        { op: '11', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' },
      ]),
    );
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'PARTIALLY_APPLIED' },
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'breakdown 11 vatAmount', from: 20, to: 0 }),
      ]),
    });
  });
});

describe('S2 side effects are reported', () => {
  it('flags changes Dougs made that the step did not ask for', async () => {
    const api = new FakeDougs([
      rawOp({ id: 20, category: 'ads', exemption: 'exemption:outbound:outsideEuropeanUnion' }),
    ]);
    api.onUpdate = (_prev, next) => {
      next.validated = false; // server un-validates on edit
    };
    const report = await applyPlan(
      dougsFor(api),
      buildPlan(COMPANY, 't', [{ op: '20', action: 'set', set: { category: 77 }, why: 'x' }]),
    );
    expect(report.meta.sideEffects).toBe(1);
    expect(report.results[0]).toMatchObject({
      status: 'applied',
      sideEffects: [{ field: 'validated', from: true, to: false }],
    });
  });
});

describe('S3 filed periods and closed years', () => {
  it('refuses edits in a month whose VAT return is filed, unless --allow-filed-periods', async () => {
    const api = new FakeDougs([rawOp({ id: 30, date: '2026-08-10' })]);
    filedAugust(api);
    const refused = await runCli(api, ['ops', 'set', '30', '--memo', 'x', '--yes']);
    expect(refused.code).toBe(2);
    expect(refused.error()).toMatchObject({
      code: 'FILED_PERIOD',
      hint: expect.stringContaining('--allow-filed-periods'),
    });
    expect(api.writes).toHaveLength(0);
    expect(
      (await runCli(api, ['ops', 'set', '30', '--memo', 'x', '--yes', '--allow-filed-periods']))
        .code,
    ).toBe(0);
  });

  it('refuses edits in a closed accounting year, but still allows attaching receipts', async () => {
    const dir = tempHome();
    writeFileSync(join(dir, 'r.pdf'), '%PDF-1.4 synthetic');
    const api = new FakeDougs([rawOp({ id: 31, date: '2025-06-01' })]);
    expect(
      (await runCli(api, ['ops', 'set', '31', '--category', '69', '--yes'])).error().code,
    ).toBe('FILED_PERIOD');
    const attach = await runCli(api, [
      'ops',
      'attach',
      '31',
      join(dir, 'r.pdf'),
      '--yes',
      '--allow-any-path',
    ]);
    expect(attach.code).toBe(0);
  });

  it('keeps filed-period fixes out of plans, and rules apply defaults to unvalidated operations', async () => {
    const api = new FakeDougs([
      rawOp({ id: 32, date: '2026-08-05', wording: 'FICTICLOUD', vatRate: 20 }),
      rawOp({ id: 33, date: '2026-09-05', wording: 'FICTICLOUD', vatRate: 20, validated: false }),
    ]);
    filedAugust(api);
    const dir = tempHome();
    const rules = join(dir, 'r.json');
    writeFileSync(
      rules,
      JSON.stringify({
        rules: [{ match: { wording: 'FICTICLOUD' }, set: { vatExempt: 'outside-eu' } }],
      }),
    );
    const plan = join(dir, 'p.plan.json');
    const r = await runCli(api, ['rules', 'apply', '--rules', rules, '--plan', plan]);
    expect(r.json()).toMatchObject({ meta: { operations: 1, steps: 1 }, steps: [{ op: '33' }] });
    const all = await runCli(api, [
      'rules',
      'apply',
      '--rules',
      rules,
      '--include-validated',
      '--plan',
      plan,
    ]);
    expect(all.json()).toMatchObject({
      meta: { operations: 2, steps: 1, heldBackFiledPeriods: 1 },
    });
    expect(all.stderr).toContain('--allow-filed-periods');
  });
});

describe('S4/S5 evidence strength', () => {
  const vendors = new VendorRegistry();

  it('lets the invoice override the built-in vendor list (S4)', () => {
    const o = op({ wording: 'CLOUDFLARE', exemption: 'exemption:outbound:insideEuropeanUnion' });
    const ev = evidence({ zone: 'inside-eu', country: 'IE', vatAmount: 0, reverseCharge: true });
    expect(checkVat(o, { vendors, categories, evidence: ev })).toEqual([]);
  });

  it('does not propose removing VAT that the invoice itself charges (S5)', () => {
    const o = op({ wording: 'EU MARKETPLACE', amount: 120, vatRate: 20 });
    const ev = evidence({
      source: 'pdf',
      zone: 'inside-eu',
      country: 'LU',
      vatAmount: null,
      chargesVat: true,
    });
    expect(checkVat(o, { vendors, categories, evidence: ev })).toEqual([]);
  });

  it('never attaches a fix from the PDF VAT-number heuristic alone (S5)', () => {
    const o = op({ wording: 'SOME SHOP', amount: 120, vatRate: 20 });
    const [f] = checkVat(o, {
      vendors,
      categories,
      evidence: evidence({ source: 'pdf', zone: 'inside-eu', country: 'DE' }),
    });
    expect(f).toMatchObject({ code: 'REVERSE_CHARGE_SUSPECT', severity: 'warning' });
    expect(f?.fix).toBeUndefined();
  });

  it('treats Dougs’ reverse-charge code or a rules-file vendor as strong evidence (S5)', () => {
    const o = op({ wording: 'FICTICLOUD', amount: 120, vatRate: 20 });
    const strong = checkVat(o, {
      vendors,
      categories,
      evidence: evidence({ zone: 'outside-eu', country: 'US', vatAmount: 0, reverseCharge: true }),
    });
    expect(strong[0]).toMatchObject({
      severity: 'error',
      fix: { set: { vatExempt: 'outside-eu' } },
    });
    const custom = new VendorRegistry([
      { name: 'Ficticloud', match: 'FICTICLOUD', zone: 'outside-eu' },
    ]);
    expect(checkVat(o, { vendors: custom, categories })[0]).toMatchObject({ severity: 'error' });
  });
});

describe('S6–S8 single-operation edits', () => {
  it('ops set --breakdown works on split operations (S6)', async () => {
    const raw = rawOp({ id: 60, amount: 100 });
    raw.breakdowns = [
      breakdown(60, 60, { id: 601 }),
      breakdown(60, 40, { id: 602, category: 'ads' }),
    ];
    const api = new FakeDougs([raw]);
    const r = await runCli(api, [
      'ops',
      'set',
      '60',
      '--breakdown',
      '602',
      '--vat-rate',
      '10',
      '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ results: [{ status: 'applied' }] });
    expect(toOp(api.ops.get('60')!).breakdowns[1]).toMatchObject({ vatRate: 10 });
  });

  it('uploads with a MIME type and sends exactly the bytes that were checked (S7, TOCTOU)', async () => {
    const dir = tempHome();
    const file = join(dir, 'inv.pdf');
    writeFileSync(file, '%PDF-1.4 checked bytes');
    const api = new FakeDougs([rawOp({ id: 70 })]);
    await executeStep(
      dougsFor(api),
      step({ op: '70', action: 'attach', file: './inv.pdf', why: 'x' }),
      { baseDir: dir },
    );
    const sent = (api.writes[0]!.body as FormData).get('file') as File;
    expect(sent.type).toBe('application/pdf');
    expect(await sent.text()).toBe('%PDF-1.4 checked bytes');
  });

  it('re-validates at apply time: a file swapped for a symlink after the preview is refused (TOCTOU)', async () => {
    const dir = tempHome();
    const outside = tempHome();
    writeFileSync(join(outside, 'secret.pdf'), 'not for upload');
    writeFileSync(join(dir, 'inv.pdf'), '%PDF-1.4');
    const api = new FakeDougs([rawOp({ id: 71 })]);
    const dougs = dougsFor(api);
    const s = step({ op: '71', action: 'attach', file: './inv.pdf', why: 'x' });
    expect((await executeStep(dougs, s, { baseDir: dir, dryRun: true })).status).toBe('planned');
    rmSync(join(dir, 'inv.pdf'));
    symlinkSync(join(outside, 'secret.pdf'), join(dir, 'inv.pdf'));
    await expect(executeStep(dougs, s, { baseDir: dir })).rejects.toMatchObject({
      code: 'UNSAFE_ATTACHMENT',
    });
    expect(api.writes).toHaveLength(0);
  });

  it('refuses to validate what Dougs would show errors for (S8)', async () => {
    const api = new FakeDougs([
      rawOp({ id: 80, validated: false, category: 'uncategorized', vatRate: null }),
      rawOp({ id: 81, validated: false, errors: [{ code: 'missing' }] }),
      rawOp({ id: 82, validated: false, vatRate: 0, requiredExemption: true }),
      rawOp({ id: 83, validated: false }),
    ]);
    for (const id of ['80', '81', '82']) {
      const r = await runCli(api, ['ops', 'validate', id, '--yes']);
      expect(r.code, id).toBe(2);
      expect(r.error().code).toBe('NOT_VALIDATABLE');
    }
    expect((await runCli(api, ['ops', 'validate', '83', '--yes'])).code).toBe(0);
  });
});

describe('S9 CA3 estimate', () => {
  it('a supplier refund reduces deductible VAT instead of adding collected VAT (S9a)', () => {
    const refund = op({ amount: 120, income: true, refund: true, vatRate: 20 });
    const purchase = op({ amount: 240, vatRate: 20 });
    const { boxes } = estimateCa3([purchase, refund], categories);
    expect(boxes).toMatchObject({ A1: 0, '08:VAT': 0, '20': 20 });
  });

  it('uses the recoverable part of VAT (S9b) and leaves it to the server on rate edits', async () => {
    const fuel = op({ amount: 120, category: 'fuel', vatRate: 20 });
    expect(checkVat(fuel, { vendors: new VendorRegistry(), categories })).toEqual([]);
    expect(estimateCa3([fuel], categories).boxes['20']).toBe(16);
    const api = new FakeDougs([rawOp({ id: 90, amount: 110, category: 'fuel', vatRate: 0 })]);
    await executeStep(
      dougsFor(api),
      step({ op: '90', action: 'set', set: { vatRate: 10 }, why: 'x' }),
    );
    const b = toOp(api.ops.get('90')!).breakdowns[0]!;
    expect(b).toMatchObject({ vatAmount: 10, recoverableVat: 8, amountExcludingVat: 102 });
  });

  it('picks the latest filed (corrective) CA3 for a month (S9c)', () => {
    const base = { type: 'CA3-2026', periodStartDate: '2026-03-01', periodEndDate: '2026-03-31' };
    const picked = pickCa3(
      [
        { ...base, id: 2, status: 'completed' as const, confirmedAt: '2026-05-01' },
        { ...base, id: 1, status: 'completed' as const, confirmedAt: '2026-04-20' },
      ].reverse(),
      '2026-03',
    );
    expect(picked?.id).toBe(2);
  });
});

describe('S10 concurrent session refresh', () => {
  it('refreshes once and retries every concurrent 401 with the new session', async () => {
    let refreshes = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
      const cookie = (init.headers as Record<string, string>).Cookie;
      await new Promise((r) => setTimeout(r, 5));
      return cookie === 'auth_session=fresh'
        ? Response.json({ ok: true })
        : new Response('', { status: 401 });
    }) as unknown as Fetch;
    const client = new ApiClient({
      session: 'stale',
      baseUrl: 'https://dougs.example.test',
      fetch,
      sleep: async () => {},
      refreshSession: async () => {
        refreshes++;
        return 'fresh';
      },
    });
    const results = await Promise.all([
      client.get('/a'),
      client.get('/b'),
      client.get('/c'),
      client.get('/d'),
    ]);
    expect(results).toEqual(Array(4).fill({ ok: true }));
    expect(refreshes).toBe(1);
  });
});

describe('S11 publishing hygiene', () => {
  it('runs the full check before publishing and declares the repository', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.prepublishOnly).toBe('npm run check');
    expect(pkg.repository.url).toContain('github.com/tom-eberle/dougs-cli');
    expect(pkg.bugs.url).toContain('/issues');
    expect(pkg.homepage).toContain('github.com/tom-eberle/dougs-cli');
  });
});

describe('S12 open and overdue declarations', () => {
  function withOpenAugust() {
    const api = new FakeDougs([
      rawOp({
        id: 120,
        date: '2026-08-10',
        income: true,
        category: 'sales',
        amount: 1200,
        vatRate: 20,
      }),
    ]);
    api.declarations.push(
      {
        summary: {
          id: 91,
          type: 'CA3-2026',
          label: 'TVA - Août 2026',
          periodStartDate: '2026-08-01',
          periodEndDate: '2026-08-31',
          status: 'upcoming',
          isLate: true,
          dueDate: '2026-09-24',
        },
        form: { A1: 1000, '08:VAT': 200, '27': 0 },
      },
      {
        summary: {
          id: 90,
          type: 'CA3-2026',
          label: 'TVA - Juillet 2026',
          periodStartDate: '2026-07-01',
          periodEndDate: '2026-07-31',
          status: 'ready_to_complete',
          isLate: true,
          dueDate: '2026-08-24',
        },
        form: { '27': 40 },
      },
    );
    return api;
  }

  it('vat summary shows Dougs’ draft for an open month and its overdue status', async () => {
    const r = await runCli(withOpenAugust(), ['vat', 'summary', '--month', '2026-08']);
    const s = r.json() as {
      meta: { declaration: Record<string, unknown> };
      lines: { box: string; declared: number | null }[];
      notes: string[];
    };
    expect(s.meta.declaration).toMatchObject({
      status: 'upcoming',
      filed: false,
      isLate: true,
      dueDate: '2026-09-24',
      hasForm: true,
    });
    expect(s.lines.find((l) => l.box === 'A1')).toMatchObject({ declared: 1000 });
    expect(s.notes.join(' ')).toContain('if 2026-07 is filed as drafted, box 22 would be 40');
    const human = await runCli(
      withOpenAugust(),
      ['vat', 'summary', '--month', '2026-08', '--no-color'],
      { stdoutIsTTY: true },
    );
    expect(human.stdout).toContain('TVA - Août 2026: not filed, overdue since 2026-09-24');
    expect(human.stdout).toContain('DOUGS DRAFT');
  });

  it('todo and close-check list overdue declarations', async () => {
    const todo = (await runCli(withOpenAugust(), ['todo'])).json() as {
      op: unknown;
      declaration?: { id: string };
      reasons: { code: string }[];
    }[];
    expect(todo.slice(0, 2).map((i) => [i.op, i.declaration?.id, i.reasons[0]?.code])).toEqual([
      [null, '90', 'OVERDUE_DECLARATION'],
      [null, '91', 'OVERDUE_DECLARATION'],
    ]);
    const close = (
      await runCli(withOpenAugust(), ['close-check', '--year', '2026', '--no-documents'])
    ).json() as { meta: { counts: Record<string, number> } };
    expect(close.meta.counts.OVERDUE_DECLARATION).toBe(2);
  });
});

describe('N items', () => {
  it('N1: drift is a "conflict" and makes apply exit 7', async () => {
    const api = new FakeDougs([rawOp({ id: 130, category: 'ads' })]);
    const dir = tempHome();
    const plan = join(dir, 'p.plan.json');
    writeFileSync(
      plan,
      JSON.stringify(
        buildPlan(COMPANY, 't', [
          { op: '130', action: 'set', set: { category: 77 }, expect: { category: 12 }, why: 'x' },
        ]),
      ),
    );
    const r = await runCli(api, ['apply', plan, '--yes']);
    expect(r.code).toBe(7);
    expect(r.json()).toMatchObject({
      meta: { conflicts: 1, applied: 0 },
      results: [{ status: 'conflict' }],
    });
  });

  it('N2: a VAT step only expects the fields it touches', () => {
    const e = expectFor(op({ validated: false }), {
      action: 'set',
      set: { vatExempt: 'outside-eu' },
    });
    expect(Object.keys(e).sort()).toEqual(['category', 'vatAmount', 'vatExemptReason', 'vatRate']);
  });

  it('N4: a common file name attached elsewhere does not hide a match', () => {
    const doc: ReceiptDocument = {
      path: '/in/invoice.pdf',
      name: 'invoice.pdf',
      text: 'NIMBUS',
      totals: [48],
      amounts: [48],
      dates: ['2026-08-02'],
      dateSource: 'text',
      currency: 'EUR',
      extracted: true,
    };
    const ops = [
      op({ id: 140, amount: 48, date: '2026-08-02', wording: 'NIMBUS' }),
      op({ id: 141, amount: 9, attachments: [{ name: 'invoice.pdf' }] }),
    ];
    expect(matchReceipts([doc], ops, { minScore: 0.8 }).report.matched[0]?.best.op).toBe('140');
  });

  it('N5: an NFD file name counts as already attached', async () => {
    const dir = tempHome();
    const nfd = 'facture-été.pdf';
    writeFileSync(join(dir, nfd), '%PDF');
    const api = new FakeDougs([rawOp({ id: 150, attachments: [{ name: 'facture-été.pdf' }] })]);
    const r = await executeStep(
      dougsFor(api),
      step({ op: '150', action: 'attach', file: `./${nfd}`, why: 'x' }),
      { baseDir: dir },
    );
    expect(r.status).toBe('skipped');
  });

  it('N6: a malformed config is CONFIG_INVALID (exit 2)', async () => {
    const home = tempHome();
    await mkdir(join(home, 'config', 'dougs-cli'), { recursive: true });
    await writeFile(join(home, 'config', 'dougs-cli', 'config.json'), '{ not json');
    const r = await runCli(new FakeDougs(), ['whoami'], { home, loggedIn: false });
    expect(r.code).toBe(2);
    expect(r.error().code).toBe('CONFIG_INVALID');
  });

  it('N7: a failed PDF extraction is not cached', async () => {
    const api = new FakeDougs([rawOp({ id: 160, attachments: [{ name: 'broken.pdf' }] })]);
    const dougs = dougsFor(api);
    const att = toOp(api.ops.get('160')!).attachments[0]!;
    expect(await dougs.attachmentText(att)).toBeNull();
    expect(await dougs.attachmentText(att)).toBeNull();
    expect(api.requests.filter((r) => r.path.endsWith('/actions/download'))).toHaveLength(2);
  });

  it('N8: plan files are private (0600)', async () => {
    const dir = tempHome();
    const plan = join(dir, 'todo.plan.json');
    await runCli(new FakeDougs([rawOp({ id: 170 })]), ['todo', '--plan', plan]);
    expect(statSync(plan).mode & 0o777).toBe(0o600);
  });
});

describe('re-review R items', () => {
  it('R1: box 22 comes from the last filed return, the draft chain is only a note', async () => {
    const api = new FakeDougs([rawOp({ id: 200, date: '2026-08-10' })]);
    const ca3 = (id: number, month: string, status: string, form: Record<string, unknown>) => ({
      summary: {
        id,
        type: 'CA3-2026',
        label: `TVA ${month}`,
        periodStartDate: `${month}-01`,
        periodEndDate: `${month}-28`,
        status,
        confirmedAt: status === 'completed' ? `${month}-28` : null,
      },
      form,
    });
    api.declarations.push(
      ca3(1, '2026-06', 'completed', { '27': 100 }),
      ca3(2, '2026-07', 'upcoming', { '27': 40 }),
      ca3(3, '2026-08', 'upcoming', { '22': 100 }),
    );
    const s = (await runCli(api, ['vat', 'summary', '--month', '2026-08'])).json() as {
      lines: {
        box: string;
        estimate: number | null;
        declared: number | null;
        difference: number | null;
      }[];
      notes: string[];
    };
    expect(s.lines.find((l) => l.box === '22')).toMatchObject({
      estimate: 100,
      declared: 100,
      difference: 0,
    });
    expect(s.notes.join(' ')).toContain('last filed return (2026-06)');
    expect(s.notes.join(' ')).toContain('box 22 would be 40');
  });

  it('R2: attach-only runs do not need the period list', async () => {
    const dir = tempHome();
    writeFileSync(join(dir, 'r.pdf'), '%PDF-1.4');
    const api = new FakeDougs([rawOp({ id: 210 })]);
    api.overrides.push((req) =>
      req.path.includes('/declarations') ? new Response('', { status: 403 }) : undefined,
    );
    expect(
      (await runCli(api, ['ops', 'attach', '210', join(dir, 'r.pdf'), '--yes', '--allow-any-path']))
        .code,
    ).toBe(0);
    const plan = join(dir, 'r.plan.json');
    writeFileSync(
      plan,
      JSON.stringify(
        buildPlan(COMPANY, 't', [
          { op: '210', action: 'attach', file: './r.pdf', name: 'second.pdf', why: 'x' },
        ]),
      ),
    );
    expect((await runCli(api, ['apply', plan, '--yes'])).code).toBe(0);
    const set = await runCli(api, ['ops', 'set', '210', '--memo', 'x', '--yes']);
    expect(set.code).toBe(6);
    expect(set.error().code).toBe('PERIODS_UNKNOWN');
  });

  it('R3: detach is refused on locked operations and in filed periods', async () => {
    const locked = rawOp({ id: 220, locked: 'manual', attachments: [{ name: 'only.pdf' }] });
    const filed = rawOp({ id: 221, date: '2026-08-03', attachments: [{ name: 'inv.pdf' }] });
    const api = new FakeDougs([locked, filed]);
    filedAugust(api);
    const r1 = await runCli(api, [
      'ops',
      'detach',
      '220',
      String(locked.sourceDocumentAttachments[0]!.id),
      '--yes',
    ]);
    expect([r1.code, r1.error().code]).toEqual([5, 'LOCKED']);
    const att = String(filed.sourceDocumentAttachments[0]!.id);
    const r2 = await runCli(api, ['ops', 'detach', '221', att, '--yes']);
    expect([r2.code, r2.error().code]).toEqual([2, 'FILED_PERIOD']);
    expect(api.writes).toHaveLength(0);
    expect(
      (await runCli(api, ['ops', 'detach', '221', att, '--yes', '--allow-filed-periods'])).code,
    ).toBe(0);
  });

  it('R4: an annual CA12 return protects its whole year', async () => {
    const api = new FakeDougs([rawOp({ id: 230, date: '2026-04-10' })]);
    api.declarations.push({
      summary: {
        id: 95,
        type: 'CA12-2026',
        group: 'vat:simplified',
        label: 'TVA annuelle 2026',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-12-31',
        status: 'completed',
      },
      form: null,
    });
    const r = await runCli(api, ['ops', 'set', '230', '--memo', 'x', '--yes']);
    expect([r.code, r.error().code]).toEqual([2, 'FILED_PERIOD']);
  });

  it('R5: a VAT-rate edit sends the full breakdown like the web app; foreign-currency sends only manualVatAmount', async () => {
    const api = new FakeDougs([
      rawOp({ id: 240, amount: 120, category: 'fuel', vatRate: 0, validated: false }),
    ]);
    const original = structuredClone(api.ops.get('240')!.breakdowns[0]!);
    await executeStep(
      dougsFor(api),
      step({ op: '240', action: 'set', set: { vatRate: 20 }, why: 'x' }),
    );
    const sent = (api.writes[0]!.body as RawOpFixture).breakdowns[0]!;
    expect(sent).toMatchObject({
      vatAmount: 20,
      manualVatAmount: 20,
      vatRate: 0.2,
      vatAmountWithRecoverageRate: original.vatAmountWithRecoverageRate,
      amountExcludingTaxesWithRecoverageRate: original.amountExcludingTaxesWithRecoverageRate,
      isVatAmountManuallyModified: original.isVatAmountManuallyModified,
    });

    const fx = rawOp({ id: 241, amount: 92, vatRate: 0, validated: false });
    (fx.breakdowns[0] as unknown as Record<string, unknown>).currencyConversion = {
      originalCurrency: 'USD',
      originalAmount: 100,
    };
    const api2 = new FakeDougs([fx]);
    let fxSent: RawOpFixture['breakdowns'][number] | undefined;
    api2.overrides.push((req) => {
      if (req.method !== 'POST') return undefined;
      fxSent = structuredClone((req.body as RawOpFixture).breakdowns[0]);
      const body = structuredClone(req.body as RawOpFixture);
      const b = body.breakdowns[0]!;
      b.vatAmount = b.manualVatAmount ?? b.vatAmount; // the server derives vatAmount from manualVatAmount
      b.vatAmountWithRecoverageRate = b.vatAmount;
      b.amountExcludingTaxesWithRecoverageRate = b.amount - b.vatAmount;
      api2.ops.set('241', body);
      return Response.json(body);
    });
    await executeStep(
      dougsFor(api2),
      step({ op: '241', action: 'set', set: { vatRate: 20 }, why: 'x' }),
    );
    expect(fxSent).toMatchObject({ vatAmount: 0, manualVatAmount: 15.33 });
  });

  it('R5: a recoverable-VAT change is caught as a side effect', async () => {
    const api = new FakeDougs([rawOp({ id: 250, amount: 120 })]);
    api.onUpdate = (_prev, next) => {
      next.breakdowns[0]!.vatAmountWithRecoverageRate = 0;
    };
    const report = await applyPlan(
      dougsFor(api),
      buildPlan(COMPANY, 't', [{ op: '250', action: 'set', set: { memo: 'x' }, why: 'x' }]),
    );
    expect(report.results[0]!.sideEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'breakdown 250 recoverableVat', from: 20, to: 0 }),
      ]),
    );
  });

  it('N-A: side effects make the command exit 7', async () => {
    const api = new FakeDougs([rawOp({ id: 260 })]);
    api.onUpdate = (_prev, next) => {
      next.validated = false;
    };
    const r = await runCli(api, ['ops', 'set', '260', '--memo', 'x', '--yes']);
    expect(r.code).toBe(7);
    expect(r.json()).toMatchObject({ meta: { applied: 1, sideEffects: 1 } });
  });

  it('N-B: VERIFY_FAILED reports what the write did change', async () => {
    const api = new FakeDougs([rawOp({ id: 270, category: 'ads' })]);
    api.onUpdate = (_prev, next) => {
      next.breakdowns[0]!.categoryId = 69; // ignores the category…
      next.memo = 'touched'; // …but changes something else
    };
    const report = await applyPlan(
      dougsFor(api),
      buildPlan(COMPANY, 't', [{ op: '270', action: 'set', set: { category: 77 }, why: 'x' }]),
    );
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'VERIFY_FAILED' },
      changes: [{ field: 'memo', to: 'touched' }],
    });
  });

  it('N-G: a 401 after a successful refresh is not retried pointlessly', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('', { status: 401 });
    }) as unknown as Fetch;
    const client = new ApiClient({
      session: 'stale',
      baseUrl: 'https://dougs.example.test',
      fetch,
      sleep: async () => {},
      refreshSession: async () => 'fresh',
    });
    await expect(client.get('/a')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    calls = 0;
    await expect(client.get('/b')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(calls).toBe(1);
  });
});

describe('VAT exemption reasons', () => {
  it('normalizes purchase and sales reasons to short names, unknown values stay raw', () => {
    const kinds = {
      'exemption:outbound:outsideEuropeanUnion': 'outside-eu',
      'exemption:outbound:insideEuropeanUnion': 'inside-eu',
      'exemption:outbound:outsideEuropeanUnionNotImported': 'outside-eu-not-imported',
      'exemption:outbound:nonApplicable': 'not-applicable',
      'exemption:outbound:noAccountingDocument': 'no-document',
      'exemption:inbound:outsideEuropeanUnion': 'outside-eu',
      'exemption:inbound:insideEuropeanUnion': 'inside-eu',
      'exemption:inbound:nonApplicable': 'not-applicable',
      'exemption:inbound:someFutureReason': 'exemption:inbound:someFutureReason',
    };
    for (const [raw, kind] of Object.entries(kinds))
      expect(op({ exemption: raw }).vatExemptReason, raw).toBe(kind);
  });

  it('fixes VAT Dougs added on a franchise supplier (not-applicable, two passes)', async () => {
    // A French micro-entrepreneur ("TVA non applicable, art. 293 B CGI") booked with 20 % VAT.
    const api = new FakeDougs([
      rawOp({
        id: 400,
        wording: 'FICTIONAL FREELANCER',
        amount: 500,
        vatRate: 20,
        validated: false,
      }),
    ]);
    const r = await runCli(api, ['ops', 'set', '400', '--vat-exempt', 'not-applicable', '--yes']);
    expect(r.code).toBe(0);
    const reasons = api.writes.map(
      (w) => (w.body as RawOpFixture).breakdowns[0]!.associationData.vatExemptionReason,
    );
    expect(reasons).toEqual([undefined, 'exemption:outbound:nonApplicable']);
    expect(toOp(api.ops.get('400')!)).toMatchObject({
      vatAmount: 0,
      vatExemptReason: 'not-applicable',
    });
  });

  it('offers the new reasons on the command line, in plans and in rules files', async () => {
    const tree = (await runCli(new FakeDougs(), ['commands', '--json'])).json() as {
      subcommands: {
        name: string;
        subcommands: { name: string; flags: { name: string; choices?: string[] }[] }[];
      }[];
    };
    const set = tree.subcommands
      .find((c) => c.name === 'ops')!
      .subcommands.find((c) => c.name === 'set')!;
    expect(set.flags.find((f) => f.name === 'vatExempt')?.choices).toEqual([
      'outside-eu',
      'inside-eu',
      'outside-eu-not-imported',
      'not-applicable',
      'no-document',
    ]);
    const outcome = (await import('../src/workflows/rules.js')).rulesFileSchema.safeParse({
      rules: [
        { match: { wording: 'FREELANCER' }, set: { category: 77, vatExempt: 'not-applicable' } },
      ],
    });
    expect(outcome.success).toBe(true);
  });

  it('sales lines get the inbound value; purchase-only reasons are refused there', async () => {
    // A B2B service sold outside the EU (e.g. to a UAE company).
    const sale = rawOp({
      id: 410,
      income: true,
      category: 'sales',
      amount: 1000,
      vatRate: 20,
      validated: false,
    });
    const refund = rawOp({ id: 411, income: true, refund: true, amount: 120, validated: false });
    const api = new FakeDougs([sale, refund]);
    const r = await runCli(api, ['ops', 'set', '410', '--vat-exempt', 'outside-eu', '--yes']);
    expect(r.code).toBe(0);
    const reasons = api.writes.map(
      (w) => (w.body as RawOpFixture).breakdowns[0]!.associationData.vatExemptionReason,
    );
    expect(reasons.at(-1)).toBe('exemption:inbound:outsideEuropeanUnion');
    expect(toOp(api.ops.get('410')!)).toMatchObject({
      vatAmount: 0,
      vatExemptReason: 'outside-eu',
    });

    const noDoc = await runCli(api, [
      'ops',
      'set',
      '410',
      '--vat-exempt',
      'no-document',
      '--dry-run',
    ]);
    expect([noDoc.code, noDoc.error().code]).toEqual([2, 'SALES_EXEMPTION_UNSUPPORTED']);

    // A supplier refund is a purchase line: it gets the outbound value.
    expect(
      (await runCli(api, ['ops', 'set', '411', '--vat-exempt', 'not-applicable', '--yes'])).code,
    ).toBe(0);
    expect(api.ops.get('411')!.breakdowns[0]!.associationData.vatExemptionReason).toBe(
      'exemption:outbound:nonApplicable',
    );
  });
});

describe('editing validated operations (Dougs treats them as read-only)', () => {
  it('reopens, edits and validates again, reporting both steps', async () => {
    const api = new FakeDougs([rawOp({ id: 500, date: '2026-06-12', category: 'ads' })]);
    const r = await runCli(api, ['ops', 'set', '500', '--category', '77', '--yes']);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      results: [
        {
          status: 'applied',
          changes: [
            { field: 'validated', from: true, to: false },
            { field: 'category', from: 69, to: 77 },
            { field: 'validated', from: false, to: true },
          ],
        },
      ],
    });
    expect(api.writes.map((w) => (w.body as RawOpFixture).validated)).toEqual([false, false, true]);
    expect(toOp(api.ops.get('500')!)).toMatchObject({ validated: true, category: { id: 77 } });
  });

  it('a direct edit of a validated operation is what Dougs refuses (the 403 seen live)', async () => {
    const api = new FakeDougs([rawOp({ id: 501 })]);
    const raw = api.ops.get('501')!;
    const res = await api.fetch(`https://dougs.example.test/companies/${COMPANY}/operations/501`, {
      method: 'POST',
      headers: { cookie: `auth_session=${api.session}` },
      body: JSON.stringify({ ...raw, memo: 'direct' }),
    });
    expect(res.status).toBe(403);
  });

  it('maps a refused reopening to VALIDATED_READONLY with an accurate hint', async () => {
    const api = new FakeDougs([rawOp({ id: 502 })]);
    api.frozen.add('502');
    const r = await runCli(api, ['ops', 'set', '502', '--memo', 'x', '--yes']);
    expect(r.code).toBe(5);
    expect(r.error()).toMatchObject({
      code: 'VALIDATED_READONLY',
      hint: expect.stringContaining('web app'),
    });
    expect(r.error().hint).not.toContain('log in');
    expect(api.ops.get('502')!.validated).toBe(true);
  });

  it('does not refresh the session on a 403 for a write, and says it is not a login problem', async () => {
    let refreshes = 0;
    const fetch = (async (_url: string, init: RequestInit) =>
      init.method === 'POST'
        ? new Response('', { status: 403 })
        : Response.json({ ok: true })) as unknown as Fetch;
    const client = new ApiClient({
      session: 's',
      baseUrl: 'https://dougs.example.test',
      fetch,
      sleep: async () => {},
      refreshSession: async () => {
        refreshes++;
        return 'other';
      },
    });
    await expect(client.post('/x', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      hint: expect.stringContaining('session is fine'),
    });
    expect(refreshes).toBe(0);
  });

  it('puts the validation back when the edit itself fails', async () => {
    const api = new FakeDougs([rawOp({ id: 503, amount: 120 })]);
    api.onUpdate = (prev, next) => {
      // No exemption slot is ever offered for this category.
      for (const b of next.breakdowns) b.associations = [{ name: 'supplier', slots: {} }];
      if (!next.validated && prev.validated) return;
    };
    const report = await applyPlan(
      dougsFor(api),
      buildPlan(COMPANY, 't', [
        { op: '503', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' },
      ]),
    );
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'EXEMPTION_UNAVAILABLE' },
      changes: [],
    });
    expect(api.ops.get('503')!.validated).toBe(true);
  });
});

describe('lines outside VAT (bank fees, insurance, transfers…)', () => {
  it('normalizes hasVat and the category’s VAT metadata', () => {
    expect(
      op({ category: 'bankFees', vatRate: null, vatApplicable: false }).breakdowns[0],
    ).toMatchObject({ vatApplicable: false });
    expect(categories.get(12)).toMatchObject({ carriesVat: false });
    expect(categories.get(77)).toMatchObject({ carriesVat: true });
  });

  it('does not flag zero VAT without a reason, even with a foreign invoice', () => {
    const vendors = new VendorRegistry();
    const lt = evidence({ zone: 'inside-eu', country: 'LT', vatAmount: 0, totals: [12] });
    const fee = op({
      wording: 'FICTIONAL BANK FEE',
      category: 'bankFees',
      vatRate: null,
      amount: 12,
      vatApplicable: false,
    });
    expect(checkVat(fee, { vendors, categories, evidence: lt })).toEqual([]);
    // The category metadata alone also suffices (no VAT config on bank fees).
    const optedIn = op({
      wording: 'FICTIONAL BANK FEE',
      category: 'bankFees',
      vatRate: null,
      amount: 12,
    });
    expect(checkVat(optedIn, { vendors, categories, evidence: lt })).toEqual([]);
  });

  it('apply refuses an exemption on a line outside VAT, already in the preview', async () => {
    const api = new FakeDougs([
      rawOp({
        id: 600,
        category: 'bankFees',
        vatRate: null,
        vatApplicable: false,
        validated: false,
      }),
    ]);
    const r = await runCli(api, ['ops', 'set', '600', '--vat-exempt', 'inside-eu', '--dry-run']);
    expect([r.code, r.error().code]).toEqual([5, 'EXEMPTION_UNAVAILABLE']);
    expect(api.writes).toHaveLength(0);
  });
});

describe('plans never contain steps apply would refuse', () => {
  it('rules apply lists them as not plannable, with the reason', async () => {
    const api = new FakeDougs([
      rawOp({
        id: 610,
        wording: 'FICTIONAL BANK',
        category: 'bankFees',
        vatRate: null,
        vatApplicable: false,
        validated: false,
      }),
      rawOp({
        id: 611,
        wording: 'FICTIONAL BANK',
        vatRate: 20,
        validated: false,
        locked: 'manual',
      }),
      rawOp({ id: 612, wording: 'FICTIONAL BANK', vatRate: 20, validated: false }),
    ]);
    const dir = tempHome();
    const rules = join(dir, 'r.json');
    writeFileSync(
      rules,
      JSON.stringify({
        rules: [{ match: { wording: 'FICTIONAL BANK' }, set: { vatExempt: 'inside-eu' } }],
      }),
    );
    const plan = join(dir, 'p.plan.json');
    const r = await runCli(api, ['rules', 'apply', '--rules', rules, '--plan', plan]);
    expect(r.json()).toMatchObject({
      meta: { steps: 1, notPlannable: 2 },
      steps: [{ op: '612' }],
      notPlannable: expect.arrayContaining([
        expect.objectContaining({ op: '610', code: 'EXEMPTION_UNAVAILABLE' }),
        expect.objectContaining({ op: '611', code: 'LOCKED' }),
      ]),
    });
    expect(JSON.parse(readFileSync(plan, 'utf8')).steps.map((s: { op: string }) => s.op)).toEqual([
      '612',
    ]);
  });

  it('vat check keeps a strong fix out of the plan when the operation is locked', async () => {
    const api = new FakeDougs([
      rawOp({
        id: 620,
        date: '2026-08-05',
        wording: 'FICTIONAL SAAS',
        vatRate: 20,
        locked: 'manual',
        attachments: [{ name: 'i.pdf', vendorInvoiceId: 'vi-620' }],
      }),
    ]);
    api.vendorInvoices.set('vi-620', {
      id: 'vi-620',
      prefillStatus: 'prefilled',
      supplierCountry: 'US',
      vatAmount: 0,
      amount: 48,
      currency: 'EUR',
      vatBreakdown: [{ categoryCode: 'AE' }],
    });
    const dir = tempHome();
    const plan = join(dir, 'v.plan.json');
    const r = await runCli(api, [
      'vat',
      'check',
      '--from',
      '2026-08-01',
      '--to',
      '2026-08-31',
      '--plan',
      plan,
    ]);
    expect(r.json()).toMatchObject({
      meta: { fixes: 0, notPlannable: 1 },
      notPlannable: [{ op: '620', code: 'LOCKED' }],
    });
    expect(JSON.parse(readFileSync(plan, 'utf8')).steps).toEqual([]);
  });
});

describe('movements that never need a receipt', () => {
  it('classifies categories by accounting class', () => {
    expect(categories.get(702)).toMatchObject({ needsDocument: false }); // 58 transfer
    expect(categories.get(703)).toMatchObject({ needsDocument: false }); // associate account
    expect(categories.get(704)).toMatchObject({ needsDocument: false }); // 16 loan
    expect(categories.get(705)).toMatchObject({ needsDocument: true }); // taxes: 631 needs one
    expect(categories.get(77)).toMatchObject({ needsDocument: true });
  });

  it('todo and close-check skip them by default; --strict includes them', async () => {
    const ops = () =>
      new FakeDougs([
        rawOp({ id: 700, date: '2025-06-01', category: 'transfer', vatRate: null, amount: 5000 }),
        rawOp({ id: 701, date: '2025-06-02', category: 'loan', vatRate: null, amount: 900 }),
        rawOp({
          id: 702,
          date: '2025-06-03',
          category: 'ownerContribution',
          vatRate: null,
          amount: 300,
        }),
        rawOp({ id: 703, date: '2025-06-04', wording: 'FICTIONAL SHOP', amount: 40 }),
      ]);
    const missing = (items: { op: { id: string } | null; reasons: { code: string }[] }[]) =>
      items.filter((i) => i.reasons.some((r) => r.code === 'MISSING_RECEIPT')).map((i) => i.op?.id);
    expect(missing((await runCli(ops(), ['todo'])).json() as never)).toEqual(['703']);
    expect(missing((await runCli(ops(), ['todo', '--strict'])).json() as never).sort()).toEqual([
      '700',
      '701',
      '702',
      '703',
    ]);
    const close = (
      await runCli(ops(), ['close-check', '--year', '2025', '--no-documents'])
    ).json() as { meta: { counts: Record<string, number> } };
    expect(close.meta.counts.MISSING_RECEIPT).toBe(1);
    const strict = (
      await runCli(ops(), ['close-check', '--year', '2025', '--no-documents', '--strict'])
    ).json() as { meta: { counts: Record<string, number> } };
    expect(strict.meta.counts.MISSING_RECEIPT).toBe(4);
  });
});
