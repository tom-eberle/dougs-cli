import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawOperationSchema } from '../src/api/schemas.js';
import { applyPlan, executeStep } from '../src/plan/apply.js';
import { buildPlan, type PlanStep, planSchema } from '../src/plan/types.js';
import { FakeDougs, type RecordedRequest } from './helpers/fake-api.js';
import { COMPANY, dispatchOp, PROCESSOR, type RawOpFixture, rawOp } from './helpers/fixtures.js';
import { dougsFor, runCli, tempHome } from './helpers/run.js';

const INSIDE = 'exemption:inbound:insideEuropeanUnion';
const OUTSIDE = 'exemption:inbound:outsideEuropeanUnion';

const toOp = (raw: RawOpFixture) =>
  normalizeOperation(rawOperationSchema.parse(raw), { company: COMPANY });

function ventilate(op: string, overrides: Record<string, unknown> = {}): PlanStep {
  return {
    id: 's1',
    op,
    action: 'ventilate',
    why: 'synthetic monthly store report',
    expect: { validated: false },
    ventilate: {
      sales: [
        { zone: 'inside-eu', amount: 100 },
        { zone: 'outside-eu', amount: 300.5 },
      ],
      fees: [{ paymentsProcessorId: PROCESSOR, amount: 50.25 }],
      net: 350.25,
      validate: true,
      ...overrides,
    },
  } as PlanStep;
}

const salesWrites = (api: FakeDougs): RecordedRequest[] =>
  api.writes.filter((r) => r.path.includes('/ecommerceSales'));
const creates = (api: FakeDougs) =>
  salesWrites(api).filter((r) => r.path.endsWith('/ecommerceSales'));
const updates = (api: FakeDougs) =>
  salesWrites(api).filter((r) => /\/ecommerceSales\/\d+$/.test(r.path));
const body = (r: RecordedRequest) =>
  (r.body as { ecommerceSale: Record<string, unknown> }).ecommerceSale;

function writePlan(steps: PlanStep[]): string {
  const file = join(tempHome(), 'ventilation.plan.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      company: COMPANY,
      createdAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'test',
      steps,
    }),
  );
  return file;
}

describe('ventilate: e-commerce dispatch', () => {
  it('dry-run shows every line, the net and the validation, and writes nothing', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const r = await runCli(api, [
      'apply',
      writePlan([ventilate('1000001')]),
      '--dry-run',
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      meta: { dryRun: true, planned: 1 },
      results: [
        {
          action: 'ventilate',
          status: 'planned',
          changes: [
            { field: 'sales inside-eu', from: null, to: 100 },
            { field: 'sales outside-eu', from: null, to: 300.5 },
            { field: `fees ${PROCESSOR}`, from: null, to: 50.25 },
            { field: 'net', from: null, to: 350.25 },
            { field: 'validated', from: false, to: true },
          ],
        },
      ],
    });
    expect(api.writes).toHaveLength(0);
  });

  it('creates and fills 2 sales lines and 1 commission line, then validates and verifies', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const result = await executeStep(dougsFor(api), ventilate('1000001'));
    expect(result).toMatchObject({ status: 'applied' });
    expect(result.sideEffects).toBeUndefined();

    // What the web app sends: an empty line first, then the line back with its amount.
    expect(creates(api).map(body)).toEqual([
      {
        sectionId: 'service',
        subSectionId: 'fr',
        saleId: INSIDE,
        selectedZone: 'exonerateSale',
        packageId: 'over150',
      },
      {
        sectionId: 'service',
        subSectionId: 'fr',
        saleId: OUTSIDE,
        selectedZone: 'exonerateSale',
        packageId: 'over150',
      },
      {
        sectionId: 'fees',
        subSectionId: 'fees',
        saleId: 'fees',
        paymentsProcessorId: PROCESSOR,
        label: 'Fictional Pay',
      },
    ]);
    const sent = updates(api).map(body);
    expect(sent.map((s) => [s.saleId, s.amount, s.sectionId, s.subSectionId])).toEqual([
      [INSIDE, 100, 'service', 'fr'],
      [OUTSIDE, 300.5, 'service', 'fr'],
      ['fees', 50.25, 'fees', 'fees'],
    ]);
    expect(sent.every((s) => !('vatAmount' in s) && typeof s.breakdownId === 'number')).toBe(true);

    // Validation went through the operation update, and Dougs recomputed the net.
    const last = api.writes.at(-1)!;
    expect(last.path).toBe(`/companies/${COMPANY}/operations/1000001`);
    expect((last.body as RawOpFixture).validated).toBe(true);
    const op = toOp(api.ops.get('1000001')!);
    expect(op).toMatchObject({ validated: true, amount: 350.25 });
    expect(op.breakdowns.find((b) => b.isCounterpart)?.amount).toBe(350.25);
    expect(
      op.breakdowns
        .filter((b) => !b.isCounterpart)
        .map((b) => [b.section, b.vatExemptReason, b.paymentsProcessorId, b.amount]),
    ).toEqual([
      ['ecommerceDispatch:sales:service', 'inside-eu', null, 100],
      ['ecommerceDispatch:sales:service', 'outside-eu', null, 300.5],
      ['ecommerceDispatch:fees', 'inside-eu', PROCESSOR, 50.25],
    ]);
  });

  it('is idempotent: an already filled ventilation is skipped without writes', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const dougs = dougsFor(api);
    await executeStep(dougs, ventilate('1000001'));
    const writes = api.writes.length;
    expect(await executeStep(dougs, ventilate('1000001'))).toMatchObject({
      status: 'skipped',
      reason: 'already satisfied',
      changes: [],
    });
    expect(api.writes).toHaveLength(writes);
  });

  it('without validate: leaves it open, the counterpart pending at the sales total', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const dougs = dougsFor(api);
    const step = ventilate('1000001', { validate: false });
    expect((await executeStep(dougs, step)).status).toBe('applied');
    const raw = api.ops.get('1000001')!;
    expect(raw.validated).toBe(false);
    expect(raw.breakdowns.find((b) => b.isCounterpart)?.amount).toBe(400.5);
    expect((await executeStep(dougs, step)).status).toBe('skipped');
  });

  it('rejects a plan whose net is not sales − fees to the cent', async () => {
    const step = ventilate('1000001', { net: 350.24 });
    const parsed = planSchema.safeParse(buildPlan(COMPANY, 't', [step]));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['steps', 0, 'ventilate', 'net'],
      message: expect.stringContaining('net'),
    });
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const r = await runCli(api, ['apply', writePlan([step]), '--dry-run']);
    expect(r.code).toBe(2);
    expect(r.error()).toMatchObject({ code: 'PLAN_INVALID' });
    // Duplicate zones and sub-cent amounts are refused too.
    expect(
      planSchema.safeParse(
        buildPlan(COMPANY, 't', [
          ventilate('1', {
            sales: [
              { zone: 'inside-eu', amount: 1 },
              { zone: 'inside-eu', amount: 2 },
            ],
            fees: [],
            net: 3,
          }),
        ]),
      ).success,
    ).toBe(false);
    expect(
      planSchema.safeParse(
        buildPlan(COMPANY, 't', [
          ventilate('1', { sales: [{ zone: 'inside-eu', amount: 1.005 }], fees: [], net: 1.005 }),
        ]),
      ).success,
    ).toBe(false);
  });

  it('refuses an operation that is not an e-commerce ventilation', async () => {
    const api = new FakeDougs([rawOp({ id: 1000002, validated: false })]);
    const report = await applyPlan(dougsFor(api), buildPlan(COMPANY, 't', [ventilate('1000002')]));
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'NOT_ECOMMERCE_DISPATCH' },
    });
    expect(api.writes).toHaveLength(0);
  });

  it('refuses a ventilation that already holds other figures', async () => {
    const api = new FakeDougs([
      dispatchOp({
        id: 1000003,
        lines: [
          { kind: 'sale', saleId: INSIDE, amount: 80 },
          { kind: 'counterpart', amount: 80 },
        ],
      }),
    ]);
    await expect(executeStep(dougsFor(api), ventilate('1000003'))).rejects.toMatchObject({
      code: 'ALREADY_VENTILATED',
      exitCode: 2,
    });
    expect(api.writes).toHaveLength(0);
  });

  it('refuses a payment processor the sales channel does not use, already in the preview', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    // 22222 exists, but only on another channel.
    api.salesChannels.push({
      id: 4343,
      name: 'Other Fictional Store',
      paymentsProcessorsWithDate: [
        { paymentsProcessorId: 22222, paymentsProcessor: { id: 22222, name: 'Other Pay' } },
      ],
    });
    const step = ventilate('1000001', {
      fees: [{ paymentsProcessorId: 22222, amount: 50.25 }],
    });
    await expect(executeStep(dougsFor(api), step, { dryRun: true })).rejects.toMatchObject({
      code: 'PROCESSOR_UNKNOWN',
      hint: expect.stringContaining(`${PROCESSOR} (Fictional Pay)`),
    });
    expect(api.writes).toHaveLength(0);
  });

  it('refuses fees when the operation names no sales channel', async () => {
    const raw = dispatchOp({ id: 1000001 });
    delete raw.metadata;
    const api = new FakeDougs([raw]);
    await expect(
      executeStep(dougsFor(api), ventilate('1000001'), { dryRun: true }),
    ).rejects.toMatchObject({ code: 'PROCESSOR_UNKNOWN' });
  });

  it('never validates lines that did not stick', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    // Dougs answers the commission update with 200 but keeps the amount at 0.
    api.overrides.push((req) => {
      const sale = (req.body as { ecommerceSale?: Record<string, unknown> } | undefined)
        ?.ecommerceSale;
      return /\/ecommerceSales\/\d+$/.test(req.path) && sale?.saleId === 'fees'
        ? Response.json({ ...sale, totalAmount: 0 })
        : undefined;
    });
    const report = await applyPlan(dougsFor(api), buildPlan(COMPANY, 't', [ventilate('1000001')]));
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'PARTIALLY_APPLIED', message: expect.stringContaining('not validated') },
    });
    expect(api.ops.get('1000001')!.validated).toBe(false);
    expect(
      api.writes.some(
        (r) => r.path.endsWith('/operations/1000001') && (r.body as RawOpFixture).validated,
      ),
    ).toBe(false);
  });

  it('resumes after a partial failure: reuses the empty line instead of adding another', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000001 })]);
    const dougs = dougsFor(api);
    // The amount update of the second sales line fails once.
    let failed = false;
    api.overrides.push((req) => {
      const b = req.body as { ecommerceSale?: { saleId?: string } } | undefined;
      if (
        failed ||
        !/\/ecommerceSales\/\d+$/.test(req.path) ||
        b?.ecommerceSale?.saleId !== OUTSIDE
      )
        return undefined;
      failed = true;
      return Response.json({ message: 'Bad Request', statusCode: 400 }, { status: 400 });
    });
    const plan = buildPlan(COMPANY, 't', [ventilate('1000001')]);
    const first = await applyPlan(dougs, plan);
    const outside = api.ops
      .get('1000001')!
      .breakdowns.find((b) => b.associationData.vatExemptionReason === OUTSIDE);
    expect(outside?.amount).toBe(0); // created, not filled
    expect(first.results[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'PARTIALLY_APPLIED',
        message: expect.stringContaining(`re-running the plan reuses them`),
      },
    });
    expect(first.results[0]!.error!.message).toContain(String(outside!.id));
    expect(first.results[0]!.changes.length).toBeGreaterThan(0);
    expect(api.ops.get('1000001')!.validated).toBe(false);

    const second = await applyPlan(dougs, plan);
    expect(second.results[0]).toMatchObject({ status: 'applied' });
    // 2 lines from the first run + only the commission line now: no duplicate sales line.
    expect(creates(api).map((r) => body(r).saleId)).toEqual([INSIDE, OUTSIDE, 'fees']);
    const lines = api.ops.get('1000001')!.breakdowns.filter((b) => !b.isCounterpart);
    expect(lines).toHaveLength(3);
    expect(toOp(api.ops.get('1000001')!)).toMatchObject({ validated: true, amount: 350.25 });
  });

  it('reopens an empty validated ventilation, fills it and validates it again', async () => {
    const api = new FakeDougs([dispatchOp({ id: 1000004, validated: true })]);
    const step = { ...ventilate('1000004', { validate: false }), expect: { validated: true } };
    const result = await executeStep(dougsFor(api), step as PlanStep);
    expect(result.status).toBe('applied');
    expect(result.changes[0]).toEqual({ field: 'validated', from: true, to: false });
    expect(result.changes.at(-1)).toEqual({ field: 'validated', from: false, to: true });
    expect(toOp(api.ops.get('1000004')!)).toMatchObject({ validated: true, amount: 350.25 });
  });

  it('refuses locked ventilations and filed periods like other edits', async () => {
    const locked = dispatchOp({ id: 1000005 });
    locked.lockedByDate = true;
    const api = new FakeDougs([locked]);
    await expect(executeStep(dougsFor(api), ventilate('1000005'))).rejects.toMatchObject({
      code: 'LOCKED',
    });
    const filed = new FakeDougs([dispatchOp({ id: 1000001 })]);
    await expect(
      executeStep(dougsFor(filed), ventilate('1000001'), {
        periods: { reason: () => 'its VAT return (July) is already filed' },
      }),
    ).rejects.toMatchObject({ code: 'FILED_PERIOD' });
    expect(api.writes.length + filed.writes.length).toBe(0);
  });
});
