import { expect, it } from 'vitest';
import { Cache } from '../src/api/cache.js';
import { ApiClient } from '../src/api/client.js';
import { Resources, safeName, uploadName } from '../src/api/resources.js';
import { csv } from '../src/commands/resources.js';
import { execute } from '../src/plan/apply.js';
import { operation } from './fixtures.js';

it('paginates both states in 40-row pages and filters locally', async () => {
  const paths: string[] = [];
  const client = new ApiClient({
    session: 'fake',
    fetch: async (url) => {
      const u = new URL(String(url));
      paths.push(u.pathname + u.search);
      if (u.pathname.endsWith('/accounts')) return Response.json([]);
      const offset = Number(u.searchParams.get('offset'));
      if (offset) return Response.json([]);
      return Response.json(
        Array.from({ length: 40 }, (_, i) => ({
          ...operation(),
          id:
            Number(u.searchParams.get('validated') === 'true' ? 20000 : 10000) +
            i,
          validated: u.searchParams.get('validated') === 'true',
        })),
      );
    },
  });
  const result = await new Resources(
    client,
    '999999',
    new Cache('999999', false),
  ).list({ unvalidated: true, from: '2026-08-01', limit: 5 });
  expect(result.data).toHaveLength(5);
  expect(paths.filter((p) => p.includes('operations'))).toHaveLength(2);
  expect(paths[1]).toContain('offset=40');
});
it('writes full patched breakdowns, then verifies category', async () => {
  let raw = operation();
  let writes = 0;
  const client = new ApiClient({
    session: 'fake',
    fetch: async (_url, init) => {
      if (init?.method === 'POST') {
        writes++;
        const body = JSON.parse(String(init.body)) as typeof raw & {
          updatedBreakdown: unknown;
        };
        expect(body.breakdowns[0]?.categoryId).toBe(78);
        expect(body.updatedBreakdown).toEqual(body.breakdowns[0]);
        raw = body;
      }
      return Response.json(raw);
    },
  });
  const r = new Resources(client, '999999');
  expect(
    (
      await execute(r, {
        id: 's1',
        op: '10001',
        action: 'set',
        set: { category: 78 },
        why: 'test',
      })
    ).status,
  ).toBe('applied');
  expect(writes).toBe(1);
});
it('detects silent ignored API updates', async () => {
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async () => Response.json(operation()),
    }),
    '999999',
  );
  await expect(
    execute(r, {
      id: 's1',
      op: '10001',
      action: 'set',
      set: { category: 78 },
      why: 'test',
    }),
  ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
});
it('validates via full operation update and re-read', async () => {
  let raw = operation();
  const r = new Resources(
    new ApiClient({
      session: 'fake',
      fetch: async (_url, init) => {
        if (init?.method === 'POST') raw = JSON.parse(String(init.body));
        return Response.json(raw);
      },
    }),
    '999999',
  );
  expect(
    (
      await execute(r, {
        id: 's1',
        op: '10001',
        action: 'validate',
        why: 'test',
      })
    ).status,
  ).toBe('applied');
  expect(raw.validated).toBe(true);
});
it('protects paths and CSV quoting', () => {
  expect(uploadName('10001_bill.pdf')).toBe('bill.pdf');
  expect(safeName('../../a.pdf')).toBe('a.pdf');
  expect(csv([{ wording: 'Invented, "Store"\nInvoice' }])).toContain(
    '"Invented, ""Store""\nInvoice"',
  );
});
