export function operation() {
  return {
    id: 10001,
    companyId: 999999,
    date: '2026-08-15',
    wording: 'FICTIONAL ORBIT TOOLS',
    amount: 84,
    isInbound: false,
    validated: false,
    memo: null as string | null,
    deleted: false,
    excluded: false,
    breakdowns: [
      {
        id: 41,
        amount: 84,
        isCounterpart: false,
        categoryId: 77,
        resolvedCategoryId: 77,
        resolvedCategoryPath: [77],
        categoryWording: 'Software',
        categoryGroup: { name: 'Services' },
        vatRate: 0.2 as number | null,
        vatAmount: 14,
        amountExcludingTaxesWithRecoverageRate: 70,
        associationData: {} as Record<string, unknown>,
      },
    ],
    transaction: { accountId: 88, currency: 'EUR', changeRate: 1, amount: -84 },
    sourceDocumentAttachments: [] as {
      id: number;
      sourceDocument: {
        id: number;
        type: string;
        file: { id: string; name: string; size?: number };
      };
    }[],
  };
}
