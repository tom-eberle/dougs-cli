import { expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { Resources } from '../src/api/resources.js';
import { normalizeOperation, rawOperationSchema } from '../src/api/schemas.js';
import { applyPlan, execute, observed } from '../src/plan/apply.js';
import { planSchema } from '../src/plan/types.js';
import { operation } from './fixtures.js';

it('performs category first, zero VAT, then exemption; re-apply skips', async () => {
  let raw = operation();
  raw.breakdowns[0]!.categoryId = -1;
  raw.breakdowns[0]!.resolvedCategoryId = -1;
  const bodies: (typeof raw)[] = [];
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as typeof raw;
          bodies.push(body);
          raw = body;
        }
        return Response.json(raw);
      },
    }),
    '999999',
  );
  const step = {
    id: 's1',
    op: '10001',
    action: 'set' as const,
    set: { category: 77, vatExempt: 'outside-eu' as const },
    why: 'synthetic foreign supplier',
  };
  expect((await execute(r, step)).status).toBe('applied');
  expect(bodies).toHaveLength(3);
  expect(bodies[0]?.breakdowns[0]?.vatAmount).toBe(14);
  expect(bodies[1]?.breakdowns[0]?.vatAmount).toBe(0);
  expect(
    bodies[1]?.breakdowns[0]?.associationData.vatExemptionReason,
  ).toBeUndefined();
  expect(
    bodies[2]?.breakdowns[0]?.associationData.vatExemptionReason,
  ).toContain('outsideEuropeanUnion');
  expect((await execute(r, step)).status).toBe('skipped');
  expect(bodies).toHaveLength(3);
});
it('resumes partially completed exemption without stale expectation refusal', async () => {
  const raw = operation();
  const before = observed(
    normalizeOperation(rawOperationSchema.parse(raw), '999999'),
  );
  raw.breakdowns[0]!.vatAmount = 0;
  raw.breakdowns[0]!.vatRate = null;
  raw.breakdowns[0]!.amountExcludingTaxesWithRecoverageRate = 84;
  let state = raw;
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async (_url, init) => {
        if (init?.method === 'POST') state = JSON.parse(String(init.body));
        return Response.json(state);
      },
    }),
    '999999',
  );
  expect(
    (
      await execute(r, {
        id: 's1',
        op: '10001',
        action: 'set',
        set: { vatExempt: 'inside-eu' },
        expect: before,
        why: 'resume',
      })
    ).status,
  ).toBe('applied');
});
it('skips stale state, supports force, and never writes in dry-run', async () => {
  let writes = 0;
  let raw = operation();
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          writes++;
          raw = JSON.parse(String(init.body));
        }
        return Response.json(raw);
      },
    }),
    '999999',
  );
  const step = {
    id: 's1',
    op: '10001',
    action: 'set' as const,
    set: { memo: 'reviewed' },
    expect: { amount: 85 },
    why: 'test',
  };
  expect((await execute(r, step)).reason).toContain('state changed');
  expect((await execute(r, step, { force: true, dryRun: true })).status).toBe(
    'dry-run',
  );
  expect(writes).toBe(0);
  expect((await execute(r, step, { force: true })).status).toBe('applied');
});
it('reports partial failure and continue-on-error separately', async () => {
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async () => new Response('{}', { status: 422 }),
    }),
    '999999',
  );
  const plan = planSchema.parse({
    version: 1,
    company: '999999',
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    steps: [
      { id: 's1', op: '10001', action: 'validate', why: 'test' },
      { id: 's2', op: '10002', action: 'validate', why: 'test' },
    ],
  });
  const stopped = await applyPlan(r, plan);
  expect(stopped.meta).toMatchObject({ failed: 1, pending: 1 });
  expect(
    (await applyPlan(r, plan, { continueOnError: true })).meta,
  ).toMatchObject({ failed: 2, pending: 0 });
  await expect(
    applyPlan(new Resources(r.client, '888888'), plan),
  ).rejects.toMatchObject({ code: 'COMPANY_MISMATCH' });
});
it('rejects unsupported versions, extra secret fields and duplicate ids', () => {
  expect(planSchema.safeParse({ version: 2 }).success).toBe(false);
  const base = {
    version: 1,
    company: '999999',
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    steps: [],
  };
  expect(planSchema.safeParse({ ...base, session: 'fake' }).success).toBe(
    false,
  );
  expect(
    planSchema.safeParse({
      ...base,
      steps: [
        { id: 's1', op: '10001', action: 'validate', why: 'test' },
        { id: 's1', op: '10002', action: 'validate', why: 'test' },
      ],
    }).success,
  ).toBe(false);
});
