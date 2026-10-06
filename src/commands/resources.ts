import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { z } from 'zod';
import { Cache } from '../api/cache.js';
import { type ListOptions, Resources } from '../api/resources.js';
import { normalizeOperation } from '../api/schemas.js';
import { usage } from '../output/errors.js';
import { output } from '../output/format.js';
import { applyPlan } from '../plan/apply.js';
import { confirm } from '../plan/diff.js';
import { type PlanStep, setSchema } from '../plan/types.js';
import { context, type GlobalOptions } from './context.js';
import { example, options } from './core.js';
export const number = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) usage('Expected a finite number');
  return n;
};
export function range(c: Command): Command {
  return c
    .option('--from <date>', 'Inclusive start, YYYY-MM-DD')
    .option('--to <date>', 'Inclusive end, YYYY-MM-DD');
}
export function mutation(c: Command): Command {
  return c
    .option('--dry-run', 'Show diff without writing')
    .option('--yes', 'Confirm changes without prompting');
}
export async function resources(cmd: Command): Promise<Resources> {
  const ctx = await context(options(cmd));
  return new Resources(
    ctx.client,
    ctx.company,
    new Cache(ctx.company, ctx.options.cache !== false),
  );
}
export function opRows(ops: ReturnType<typeof normalizeOperation>[]) {
  return ops.map((o) => ({
    id: o.id,
    date: o.date,
    wording: o.wording,
    amount: o.amount,
    direction: o.direction,
    category: o.category?.name ?? 'uncategorized',
    vat: o.vatAmount,
    validated: o.validated,
    receipts: o.attachments.length,
  }));
}
export async function single(cmd: Command, steps: PlanStep[]) {
  const o = cmd.optsWithGlobals<
    GlobalOptions & { dryRun?: boolean; yes?: boolean }
  >();
  const r = await resources(cmd);
  const plan = {
    version: 1 as const,
    company: r.company,
    createdAt: new Date().toISOString(),
    createdBy: 'dougs-cli 0.1.0 ops',
    steps,
  };
  const preview = await applyPlan(r, plan, { dryRun: true });
  if (o.dryRun) {
    output(preview, o);
    return;
  }
  if (!o.yes) process.stderr.write(`${JSON.stringify(preview, null, 2)}\n`);
  await confirm(o.yes);
  const report = await applyPlan(r, plan);
  output(report, o);
  if (report.meta.failed) process.exitCode = 7;
}
export function registerResources(program: Command): void {
  const ops = example(
    program
      .command('ops')
      .description('Inspect and edit accounting operations'),
    'ops list --unvalidated --limit 10',
    'ops get 10001',
  );
  example(
    range(
      ops
        .command('list')
        .description(
          'List operations; local filters, automatic 40-row pagination',
        ),
    )
      .option('--validated', 'Booked only')
      .option('--unvalidated', 'Pending only')
      .option('--search <text>', 'Case-insensitive wording search')
      .option('--missing-receipt', 'No attachments')
      .option('--category <id>', 'Category id, -1 for uncategorized', number)
      .option('--expense', 'Expenses only')
      .option('--income', 'Income only')
      .option('--limit <n>', 'Maximum output rows', number, 50)
      .option('--all', 'Return all matching rows')
      .option('--raw', 'Untouched API objects'),
    'ops list --from 2026-08-01 --expense --missing-receipt',
    'ops list --all --jsonl',
  ).action(async (_local, cmd: Command) => {
    const o = cmd.optsWithGlobals<
      GlobalOptions & ListOptions & { raw?: boolean }
    >();
    const result = await (await resources(cmd)).list(o);
    output(o.raw ? result.raw : result.data, o, opRows(result.data));
  });
  example(
    ops
      .command('get <id>')
      .description('Inspect one operation')
      .option('--raw', 'Untouched API object'),
    'ops get 10001 --json',
  ).action(async (id: string, _local, cmd: Command) => {
    const r = await resources(cmd);
    const raw = await r.get(id);
    output(
      cmd.opts().raw
        ? raw
        : normalizeOperation(raw, r.company, (await r.accounts()).data),
      options(cmd),
    );
  });
  example(
    mutation(
      ops
        .command('set <ids...>')
        .description('Set category, VAT treatment or memo'),
    )
      .option('--category <id>', 'Category id', number)
      .option('--vat-rate <rate>', 'Percent, e.g. 20', number)
      .option('--vat-exempt <reason>', 'outside-eu, inside-eu, no-document')
      .option('--memo <text>', 'Operation memo'),
    'ops set 10001 --category 77 --vat-exempt outside-eu --dry-run',
  ).action(async (ids: string[], _local, cmd: Command) => {
    const o = cmd.opts();
    const set = setSchema.parse({
      category: o.category,
      vatRate: o.vatRate,
      vatExempt: o.vatExempt,
      memo: o.memo,
    });
    await single(
      cmd,
      ids.map((op, i) => ({
        id: `s${i + 1}`,
        op,
        action: 'set',
        set,
        why: 'Requested operation edit',
      })),
    );
  });
  example(
    mutation(
      ops
        .command('attach <id> <files...>')
        .description(
          'Attach local documents; remove leading numeric filename prefix',
        ),
    ).option('--name <name>', 'Display name (one file only)'),
    'ops attach 10001 ./invoice.pdf --dry-run',
  ).action(async (id: string, files: string[], _local, cmd: Command) => {
    if (cmd.opts().name && files.length !== 1)
      usage('--name requires one file');
    await single(
      cmd,
      files.map((file, i) => ({
        id: `s${i + 1}`,
        op: id,
        action: 'attach',
        file,
        name: cmd.opts().name,
        why: 'Requested receipt attachment',
      })),
    );
  });
  example(
    mutation(
      ops
        .command('detach <id> <attachmentId>')
        .description('Remove a source-document attachment'),
    ),
    'ops detach 10001 501 --dry-run',
  ).action(async (op: string, attachmentId: string, _local, cmd: Command) =>
    single(cmd, [
      {
        id: 's1',
        op,
        action: 'detach',
        attachmentId,
        why: 'Requested attachment removal',
      },
    ]),
  );
  example(
    mutation(
      ops
        .command('validate <ids...>')
        .description('Validate operations using the web app update contract'),
    ),
    'ops validate 10001 --dry-run',
  ).action(async (ids: string[], _local, cmd: Command) =>
    single(
      cmd,
      ids.map((op, i) => ({
        id: `s${i + 1}`,
        op,
        action: 'validate',
        why: 'Requested validation',
      })),
    ),
  );
  example(
    ops
      .command('download <id>')
      .description('Download an operation’s attachments')
      .option('-o, --output <dir>', 'Destination directory', 'receipts'),
    'ops download 10001 -o ./receipts',
  ).action(async (id: string, _local, cmd: Command) => {
    const r = await resources(cmd);
    output(await r.download(await r.get(id), cmd.opts().output), options(cmd));
  });
  const receipts = example(
    program
      .command('receipts')
      .description('Download and match accounting documents'),
    'receipts download --from 2026-08-01 -o ./receipts',
  );
  example(
    range(
      receipts
        .command('download')
        .description(
          'Download attachments, skipping files with matching name and size',
        ),
    ).option('-o, --output <dir>', 'Destination directory', 'receipts'),
    'receipts download --from 2026-08-01 --to 2026-08-31 -o ./receipts',
  ).action(async (_local, cmd: Command) => {
    const r = await resources(cmd);
    const list = await r.list({ ...cmd.opts(), all: true });
    const result = [];
    for (const raw of list.raw)
      result.push(...(await r.download(raw, cmd.opts().output)));
    output(result, options(cmd));
  });
  const categories = example(
    program.command('categories').description('Category ids and parent paths'),
    'categories list --search logiciel',
  );
  example(
    categories
      .command('list')
      .description('List assignable categories (24-hour cache)')
      .option('--search <text>', 'Search name/path')
      .option('--raw', 'Untouched API payload'),
    'categories list --search logiciel --json',
  ).action(async (_local, cmd: Command) => {
    const result = await (await resources(cmd)).categories();
    const search = cmd.opts().search as string | undefined;
    output(
      cmd.opts().raw
        ? result.raw
        : result.data.filter(
            (c) =>
              !search ||
              c.path.join(' ').toLowerCase().includes(search.toLowerCase()),
          ),
      options(cmd),
    );
  });
  const accounts = example(
    program
      .command('accounts')
      .description('Bank accounts and native-currency live balances'),
    'accounts list',
  );
  example(
    accounts
      .command('list')
      .description('List accounts; balances are in each account currency')
      .option('--raw', 'Untouched API payload'),
    'accounts list --json',
  ).action(async (_local, cmd: Command) => {
    const result = await (await resources(cmd)).accounts();
    output(cmd.opts().raw ? result.raw : result.data, options(cmd));
  });
  example(
    range(
      program
        .command('export')
        .description(
          'Export flat transactions with VAT, category and receipt columns',
        ),
    )
      .option('--format <format>', 'csv, json, jsonl', 'csv')
      .option('-o, --output <file>', 'Write to a file'),
    'export --from 2026-08-01 --to 2026-08-31 -o august.csv',
  ).action(async (_local, cmd: Command) => {
    const o = cmd.optsWithGlobals<
      GlobalOptions & ListOptions & { format: string; output?: string }
    >();
    const format = z.enum(['csv', 'json', 'jsonl']).parse(o.format);
    const ops = (await (await resources(cmd)).list({ ...o, all: true })).data;
    const rows = ops.map((op) => ({
      date: op.date,
      wording: op.wording,
      amount_ttc: op.amount,
      amount_ht: op.amountExcludingVat,
      vat: op.vatAmount,
      vat_rate: op.vatRate,
      is_expense: op.direction === 'expense',
      category: op.category?.name ?? '',
      category_group: op.category?.path[0] ?? '',
      memo: op.memo ?? '',
      validated: op.validated,
      has_receipt: op.attachments.length > 0,
      dougs_id: op.id,
    }));
    const text =
      format === 'csv'
        ? csv(rows)
        : format === 'jsonl'
          ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
          : JSON.stringify(rows, null, 2) + '\n';
    if (o.output) {
      await writeFile(o.output, text, { mode: 0o600 });
      output({ file: o.output, count: rows.length, format }, o);
    } else if (o.json || o.jsonl) output(rows, o);
    else process.stdout.write(text);
  });
}
export function csv(rows: Record<string, unknown>[]): string {
  const keys = [
    'date',
    'wording',
    'amount_ttc',
    'amount_ht',
    'vat',
    'vat_rate',
    'is_expense',
    'category',
    'category_group',
    'memo',
    'validated',
    'has_receipt',
    'dougs_id',
  ];
  const escape = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return (
    [
      keys.join(','),
      ...rows.map((r) => keys.map((k) => escape(r[k])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
