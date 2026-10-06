import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawOperationSchema } from '../src/api/schemas.js';
import { applyPlan, executeStep } from '../src/plan/apply.js';
import { observe } from '../src/plan/diff.js';
import { buildPlan, type PlanStep, planSchema, type StepDraft } from '../src/plan/types.js';
import { FakeDougs } from './helpers/fake-api.js';
import { COMPANY, type RawOpFixture, rawOp } from './helpers/fixtures.js';
import { dougsFor, tempHome } from './helpers/run.js';

const toOp = (raw: RawOpFixture) =>
  normalizeOperation(rawOperationSchema.parse(raw), { company: COMPANY });

function step(draft: StepDraft, id = 's1'): PlanStep {
  return { id, ...draft } as PlanStep;
}

function opPosts(api: FakeDougs) {
  return api.writes.filter((r) => r.method === 'POST' && /\/operations\/\d+$/.test(r.path));
}

describe('set: category + VAT exemption', () => {
  it('sets the category first, then zeroes VAT, then sets the reason (two passes), via `breakdowns`', async () => {
    const raw = rawOp({ id: 1, category: 'uncategorized', vatRate: 20, amount: 84 });
    const api = new FakeDougs([raw]);
    const result = await executeStep(
      dougsFor(api),
      step({
        op: '1',
        action: 'set',
        set: { category: 77, vatExempt: 'outside-eu' },
        why: 'synthetic US supplier',
        expect: observe(toOp(raw)),
      }),
    );
    expect(result.status).toBe('applied');
    const posts = opPosts(api);
    expect(posts).toHaveLength(3);
    const [category, zero, reason] = posts.map(
      (p) => p.body as RawOpFixture & { updatedBreakdown: unknown },
    );
    // The server reads the edit from `breakdowns`; `updatedBreakdown` marks the changed one.
    expect(category!.breakdowns[0]).toMatchObject({
      categoryId: 77,
      resolvedCategoryPath: [77],
      isManuallyCategorized: true,
    });
    expect(category!.updatedBreakdown).toEqual(category!.breakdowns[0]);
    expect(zero!.breakdowns[0]).toMatchObject({
      vatAmount: 0,
      manualVatAmount: 0,
      vatAmountWithRecoverageRate: 0,
      vatRate: null,
      isVatAmountManuallyModified: true,
      amountExcludingTaxesWithRecoverageRate: 84,
    });
    expect(zero!.breakdowns[0]!.associationData.vatExemptionReason).toBeUndefined();
    expect(reason!.breakdowns[0]!.associationData.vatExemptionReason).toBe(
      'exemption:outbound:outsideEuropeanUnion',
    );
    // Never ?force=true: that would unlock locked ledgers (see B1).
    expect(posts.every((p) => !p.query.has('force'))).toBe(true);
    expect(toOp(api.ops.get('1')!)).toMatchObject({
      category: { id: 77 },
      vatAmount: 0,
      vatExemptReason: 'outside-eu',
    });
  });

  it('is idempotent: re-applying a satisfied step writes nothing', async () => {
    const api = new FakeDougs([
      rawOp({ id: 2, exemption: 'exemption:outbound:outsideEuropeanUnion' }),
    ]);
    const result = await executeStep(
      dougsFor(api),
      step({ op: '2', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' }),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'already satisfied' });
    expect(api.writes).toHaveLength(0);
  });

  it('resumes a half-applied exemption (VAT already zeroed) despite its old expectation', async () => {
    const raw = rawOp({ id: 3, vatRate: 20, amount: 60 });
    const expectation = observe(toOp(raw));
    raw.breakdowns[0] = {
      ...raw.breakdowns[0]!,
      vatAmount: 0,
      vatRate: null,
      amountExcludingTaxesWithRecoverageRate: 60,
      associations: [{ name: 'vatExemptionReason', slots: {} }],
    };
    const api = new FakeDougs([raw]);
    const result = await executeStep(
      dougsFor(api),
      step({
        op: '3',
        action: 'set',
        set: { vatExempt: 'inside-eu' },
        why: 'x',
        expect: expectation,
      }),
    );
    expect(result.status).toBe('applied');
    expect(opPosts(api)).toHaveLength(1); // only the reason pass
  });

  it('refuses an exemption on an uncategorized operation with an actionable error', async () => {
    const api = new FakeDougs([rawOp({ id: 4, category: 'uncategorized', vatRate: null })]);
    await expect(
      executeStep(
        dougsFor(api),
        step({ op: '4', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'CATEGORY_REQUIRED',
      hint: expect.stringContaining('category'),
    });
  });

  it('reports when Dougs offers no exemption slot', async () => {
    const api = new FakeDougs([rawOp({ id: 5 })]);
    api.overrides.push((req) => {
      if (req.method !== 'POST') return undefined;
      const body = req.body as RawOpFixture;
      body.breakdowns[0]!.associations = [{ name: 'supplier', slots: {} }];
      api.ops.set('5', body);
      return Response.json(body);
    });
    await expect(
      executeStep(
        dougsFor(api),
        step({ op: '5', action: 'set', set: { vatExempt: 'inside-eu' }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'EXEMPTION_UNAVAILABLE',
    });
  });

  it('detects a write the server silently ignored (VERIFY_FAILED)', async () => {
    const api = new FakeDougs([rawOp({ id: 6, category: 'ads' })]);
    api.overrides.push((req) =>
      req.method === 'POST' ? Response.json(api.ops.get('6')) : undefined,
    );
    await expect(
      executeStep(dougsFor(api), step({ op: '6', action: 'set', set: { category: 77 }, why: 'x' })),
    ).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      exitCode: 5,
    });
  });
});

describe('set: VAT rate, memo; validate; attach; detach', () => {
  it('sets a VAT rate from the gross amount and clears an exemption', async () => {
    const api = new FakeDougs([
      rawOp({ id: 10, amount: 120, exemption: 'exemption:outbound:outsideEuropeanUnion' }),
    ]);
    await executeStep(
      dougsFor(api),
      step({ op: '10', action: 'set', set: { vatRate: 20 }, why: 'French supplier after all' }),
    );
    expect(toOp(api.ops.get('10')!)).toMatchObject({
      vatRate: 20,
      vatAmount: 20,
      amountExcludingVat: 100,
      vatExemptReason: null,
    });
  });

  it('updates the memo, sending the unchanged main breakdown as updatedBreakdown', async () => {
    const api = new FakeDougs([rawOp({ id: 11 })]);
    await executeStep(
      dougsFor(api),
      step({ op: '11', action: 'set', set: { memo: 'Annual plan' }, why: 'x' }),
    );
    expect(api.ops.get('11')!.memo).toBe('Annual plan');
    const body = opPosts(api)[0]!.body as RawOpFixture & { updatedBreakdown?: unknown };
    expect(body.updatedBreakdown).toEqual(body.breakdowns[0]);
    expect(body.breakdowns[0]!.categoryId).toBe(77);
  });

  it('validates an operation', async () => {
    const api = new FakeDougs([rawOp({ id: 12, validated: false })]);
    expect(
      (await executeStep(dougsFor(api), step({ op: '12', action: 'validate', why: 'x' }))).status,
    ).toBe('applied');
    expect(api.ops.get('12')!.validated).toBe(true);
  });

  it('uploads with the "<digits>_" prefix stripped, and skips once attached', async () => {
    const dir = tempHome();
    const file = join(dir, '12345_invoice-aug.pdf');
    writeFileSync(file, '%PDF-1.4 synthetic');
    const api = new FakeDougs([rawOp({ id: 13 })]);
    const dougs = dougsFor(api);
    const s = step({ op: '13', action: 'attach', file, why: 'x' });
    expect((await executeStep(dougs, s, { baseDir: dir })).status).toBe('applied');
    const form = api.writes[0]!.body as FormData;
    expect((form.get('file') as File).name).toBe('invoice-aug.pdf');
    expect((await executeStep(dougs, s, { baseDir: dir })).status).toBe('skipped');
  });

  it('detaches an attachment', async () => {
    const raw = rawOp({ id: 14, attachments: [{ name: 'wrong.pdf' }] });
    const api = new FakeDougs([raw]);
    const attId = String(raw.sourceDocumentAttachments[0]!.id);
    await executeStep(
      dougsFor(api),
      step({ op: '14', action: 'detach', attachmentId: attId, why: 'x' }),
    );
    expect(api.ops.get('14')!.sourceDocumentAttachments).toHaveLength(0);
    expect(api.writes[0]).toMatchObject({
      method: 'DELETE',
      path: `/companies/${COMPANY}/operations/14/source-document-attachments/${attId}`,
    });
  });
});

describe('applyPlan', () => {
  it('skips steps whose operation changed since planning, unless forced', async () => {
    const raw = rawOp({ id: 20, category: 'ads' });
    const api = new FakeDougs([raw]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '20', action: 'set', set: { category: 77 }, why: 'x', expect: { category: 12 } },
    ]);
    const report = await applyPlan(dougsFor(api), plan);
    expect(report.results[0]).toMatchObject({
      status: 'conflict',
      reason: expect.stringContaining('category'),
    });
    expect(api.writes).toHaveLength(0);
    expect((await applyPlan(dougsFor(api), plan, { force: true })).meta.applied).toBe(1);
  });

  it('never writes in dry-run and reports before → after', async () => {
    const api = new FakeDougs([rawOp({ id: 21, category: 'ads' })]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '21', action: 'set', set: { category: 77 }, why: 'x' },
    ]);
    const report = await applyPlan(dougsFor(api), plan, { dryRun: true });
    expect(report.meta).toMatchObject({ dryRun: true, planned: 1, applied: 0 });
    expect(report.results[0]!.changes).toEqual([{ field: 'category', from: 69, to: 77 }]);
    expect(api.writes).toHaveLength(0);
  });

  it('stops at the first failure (remaining steps pending) unless continue-on-error', async () => {
    const api = new FakeDougs([
      rawOp({ id: 22, validated: false }),
      rawOp({ id: 23, validated: false }),
    ]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '999', action: 'validate', why: 'missing op' },
      { op: '22', action: 'validate', why: 'x' },
      { op: '23', action: 'validate', why: 'x' },
    ]);
    const stopped = await applyPlan(dougsFor(api), plan);
    expect(stopped.meta).toMatchObject({ failed: 1, pending: 2, applied: 0 });
    expect(stopped.results[0]!.error).toMatchObject({ code: 'NOT_FOUND' });
    const continued = await applyPlan(dougsFor(api), plan, { continueOnError: true });
    expect(continued.meta).toMatchObject({ failed: 1, applied: 2, pending: 0 });
  });

  it('refuses a plan for another company', async () => {
    const plan = buildPlan('123456', 'test', []);
    await expect(applyPlan(dougsFor(new FakeDougs()), plan)).rejects.toMatchObject({
      code: 'COMPANY_MISMATCH',
      exitCode: 2,
    });
  });

  it('asks for a breakdown id on split operations', async () => {
    const raw = rawOp({ id: 24, amount: 100 });
    raw.breakdowns.push({ ...raw.breakdowns[0]!, id: 999 });
    const report = await applyPlan(
      dougsFor(new FakeDougs([raw])),
      buildPlan(COMPANY, 't', [{ op: '24', action: 'set', set: { category: 69 }, why: 'x' }]),
    );
    expect(report.results[0]!.error).toMatchObject({
      code: 'SPLIT_OPERATION',
      hint: expect.stringContaining('breakdown'),
    });
  });
});

describe('plan schema', () => {
  it('accepts the documented example and rejects bad input', () => {
    const plan = {
      version: 1,
      company: COMPANY,
      createdAt: '2026-08-01T10:00:00.000Z',
      createdBy: 'dougs-cli 0.1.0 receipts match',
      steps: [
        {
          id: 's1',
          op: '123',
          action: 'attach',
          file: './inbox/inv.pdf',
          why: 'amount 48.00 = op amount',
        },
        {
          id: 's2',
          op: '456',
          action: 'set',
          set: { category: 77, vatExempt: 'outside-eu' },
          expect: { vatAmount: 8, category: -1 },
          why: 'foreign supplier',
        },
      ],
    };
    expect(planSchema.parse(plan)).toEqual(plan);
    expect(planSchema.safeParse({ ...plan, steps: [plan.steps[0], plan.steps[0]] }).success).toBe(
      false,
    );
    expect(
      planSchema.safeParse({ ...plan, steps: [{ ...plan.steps[1], set: { vatRate: 19 } }] })
        .success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        ...plan,
        steps: [{ ...plan.steps[1], set: { vatRate: 20, vatExempt: 'inside-eu' } }],
      }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({ ...plan, steps: [{ ...plan.steps[0], extra: true }] }).success,
    ).toBe(false);
  });
});
