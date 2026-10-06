import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawOperationSchema } from '../src/api/schemas.js';
import { matchReceipts, type ReceiptDocument, scoreMatch } from '../src/workflows/receipts.js';
import { COMPANY, type OpOptions, rawOp } from './helpers/fixtures.js';

const op = (o: OpOptions) =>
  normalizeOperation(rawOperationSchema.parse(rawOp(o)), { company: COMPANY });

function doc(partial: Partial<ReceiptDocument> & { name: string }): ReceiptDocument {
  return {
    path: `/inbox/${partial.name}`,
    text: partial.text ?? partial.name.toUpperCase(),
    totals: [],
    amounts: partial.totals ?? [],
    dates: [],
    currency: 'EUR',
    extracted: true,
    ...partial,
  };
}

describe('scoreMatch', () => {
  const nimbus = op({ id: 1, date: '2026-08-02', wording: 'PRLV NIMBUS HOSTING', amount: 48 });

  it('scores an exact amount, same-week date and vendor name highly, with reasons', () => {
    const s = scoreMatch(
      doc({
        name: 'nimbus.pdf',
        text: 'NIMBUS HOSTING GMBH INVOICE',
        totals: [48],
        dates: ['2026-08-01'],
      }),
      nimbus,
    );
    expect(s.total).toBeGreaterThanOrEqual(0.95);
    expect(s.reasons.join(', ')).toBe(
      "amount 48.00 = TTC, date +1d, vendor 'NIMBUS HOSTING' in wording",
    );
  });

  it('matches the HT amount and the original foreign-currency amount', () => {
    expect(scoreMatch(doc({ name: 'a.pdf', totals: [40] }), nimbus).reasons[0]).toBe(
      'amount 40.00 = HT',
    );
    const fx = op({ id: 2, amount: 46.2, original: { amount: 50, currency: 'USD' } });
    expect(scoreMatch(doc({ name: 'b.pdf', totals: [50], currency: 'USD' }), fx).reasons[0]).toBe(
      'amount 50.00 = USD',
    );
  });

  it('allows ±2 % for currency-converted totals', () => {
    const s = scoreMatch(doc({ name: 'c.pdf', totals: [48.9], currency: 'USD' }), nimbus);
    expect(s.amount).toBe(0.6);
  });

  it('rejects dates outside −10/+40 days and wrong amounts', () => {
    expect(
      scoreMatch(doc({ name: 'd.pdf', totals: [48], dates: ['2026-06-01'] }), nimbus).date,
    ).toBe(0);
    expect(scoreMatch(doc({ name: 'e.pdf', totals: [47.99] }), nimbus).amount).toBe(0);
  });
});

describe('matchReceipts', () => {
  const ops = [
    op({ id: 1, date: '2026-08-02', wording: 'PRLV NIMBUS HOSTING', amount: 48 }),
    op({ id: 2, date: '2026-08-05', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
    op({ id: 3, date: '2026-08-06', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
    op({
      id: 4,
      date: '2026-08-07',
      wording: 'CB PAPER CO',
      amount: 12,
      attachments: [{ name: 'paper-aug.pdf' }],
    }),
  ];

  it('separates confident, ambiguous, unmatched and already-attached files', () => {
    const { report, steps } = matchReceipts(
      [
        doc({
          name: '1001_nimbus-aug.pdf',
          text: 'NIMBUS HOSTING',
          totals: [48],
          dates: ['2026-08-01'],
        }),
        doc({ name: 'orbit.pdf', text: 'ORBIT TOOLS', totals: [19.99], dates: ['2026-08-05'] }),
        doc({ name: 'mystery.pdf', text: 'SOMETHING ELSE', totals: [999], dates: ['2026-08-05'] }),
        doc({ name: '2002_paper-aug.pdf', totals: [12] }),
      ],
      ops,
      { minScore: 0.8 },
    );
    expect(report.matched.map((m) => [m.file, m.best.op])).toEqual([
      ['/inbox/1001_nimbus-aug.pdf', '1'],
    ]);
    expect(report.ambiguous[0]).toMatchObject({
      file: '/inbox/orbit.pdf',
      candidates: [{ op: '2' }, { op: '3' }],
    });
    expect(report.unmatched[0]).toMatchObject({
      file: '/inbox/mystery.pdf',
      detected: { totals: [999] },
    });
    expect(report.alreadyAttached).toEqual([{ file: '/inbox/2002_paper-aug.pdf', op: '4' }]);
    expect(steps).toEqual([
      {
        op: '1',
        action: 'attach',
        file: '/inbox/1001_nimbus-aug.pdf',
        why: expect.stringContaining('score'),
      },
    ]);
  });

  it('never proposes two files for the same operation', () => {
    const { report, steps } = matchReceipts(
      [
        doc({ name: 'a.pdf', text: 'NIMBUS HOSTING', totals: [48], dates: ['2026-08-02'] }),
        doc({ name: 'b.pdf', text: 'NIMBUS HOSTING', totals: [48], dates: ['2026-08-02'] }),
      ],
      ops,
      { minScore: 0.8 },
    );
    expect(steps).toHaveLength(1);
    expect(report.ambiguous[0]!.reason).toContain('same operation as a.pdf');
  });

  it('respects --min-score', () => {
    const files = [doc({ name: 'x.pdf', totals: [48] })]; // amount only: score 0.65
    expect(matchReceipts(files, ops, { minScore: 0.6 }).steps).toHaveLength(1);
    expect(matchReceipts(files, ops, { minScore: 0.8 }).steps).toHaveLength(0);
  });
});
