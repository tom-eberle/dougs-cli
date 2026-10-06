import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { Dougs } from '../api/dougs.js';
import { DougsError, ExitCode, usageError } from '../output/errors.js';
import { style } from '../output/style.js';
import { renderTable } from '../output/table.js';
import { buildPlan, type StepDraft } from '../plan/types.js';
import { addDays, parseMonthOption, previousMonth, today } from '../util/dates.js';
import { formatAmount, formatSigned } from '../util/money.js';
import { plural } from '../util/text.js';
import { VERSION } from '../version.js';
import { runCloseCheck } from '../workflows/close-check.js';
import type { CategoryIndex } from '../workflows/findings.js';
import { DEFAULT_RULES_FILE, inferRules, loadRules, planRules } from '../workflows/rules.js';
import { buildTodo, countByReason, TODO_REASONS, type TodoItem } from '../workflows/todo.js';
import {
  compareWithDeclaration,
  estimateCa3,
  runVatCheck,
  type VatSummary,
} from '../workflows/vat.js';
import { VendorRegistry } from '../workflows/vendors.js';
import { type Context, contextOf } from './context.js';
import { addListFilters, fetchOperations, filterFromOptions } from './ops.js';
import { renderFindings } from './render.js';
import {
  addDocumentsOption,
  addPlanOption,
  addRangeOptions,
  PLAN_NEXT_STEP,
  parsePositiveInt,
  rangeOf,
  rulesOption,
  withExamples,
  writePlan,
} from './shared.js';

function setSummary(set: object): string {
  return Object.entries(set)
    .map(([k, v]) => `${k}=${v ?? '∅'}`)
    .join(' ');
}

async function categoriesOrNull(ctx: Context, dougs: Dougs): Promise<CategoryIndex | undefined> {
  try {
    return await dougs.categoryIndex();
  } catch (e) {
    ctx.out.warn(`categories unavailable, some VAT checks are skipped (${(e as Error).message})`);
    return undefined;
  }
}

function progress(ctx: Context, label: string) {
  let last = 0;
  return (done: number, total: number) => {
    if (done === total || Date.now() - last > 1500) {
      last = Date.now();
      ctx.out.info(style.dim(`  ${label} ${done}/${total}`));
    }
  };
}

async function maybeWritePlan(
  dougs: Dougs,
  path: string | undefined,
  command: string,
  steps: StepDraft[],
) {
  if (!path) return null;
  await writePlan(path, buildPlan(dougs.company, `dougs-cli ${VERSION} ${command}`, steps));
  return path;
}

const REASON_TITLES: Record<string, string> = {
  MISSING_RECEIPT: 'Missing receipt',
  UNCATEGORIZED: 'Uncategorized',
  UNVALIDATED: 'Waiting for validation',
  VAT_SUSPECT: 'VAT to check',
  RULE_MATCH: 'A local rule would change it',
  POSSIBLE_DUPLICATE: 'Possible duplicates',
  DOCUMENT_AMOUNT_MISMATCH: 'Document amount differs',
  VAT_TOTAL_MISMATCH: 'TTC ≠ HT + VAT',
  VAT_RATE_INVALID: 'Invalid VAT rate',
  REVERSE_CHARGE_SUSPECT: 'Reverse charge suspected (foreign supplier billed with French VAT)',
  ZERO_VAT_NO_REASON: 'Zero VAT without exemption reason',
  DOCUMENT_VAT_MISMATCH: 'Invoice VAT ≠ booked VAT',
};

function renderTodo(items: readonly TodoItem[]): string {
  if (!items.length) return style.green('✓ Nothing to do.');
  const counts = countByReason(items);
  const blocks: string[] = [];
  for (const reason of TODO_REASONS) {
    const list = items.filter((i) => i.reasons.some((r) => r.code === reason));
    if (!list.length) continue;
    const urgent =
      reason === 'MISSING_RECEIPT'
        ? list.filter((i) => i.reasons.some((r) => r.code === reason && r.severity === 'error'))
            .length
        : 0;
    blocks.push(
      `${style.bold(REASON_TITLES[reason] ?? reason)} ${style.dim(`(${list.length}${urgent ? `, ${urgent} over 150 € need a full invoice` : ''})`)}`,
    );
    blocks.push(
      renderTable(
        [
          { header: 'ID', value: (i: TodoItem) => i.op.id },
          { header: 'DATE', value: (i: TodoItem) => i.op.date },
          { header: 'WORDING', value: (i: TodoItem) => i.op.wording, flex: true, max: 36 },
          {
            header: 'AMOUNT',
            value: (i: TodoItem) => formatSigned(i.op.amount, i.op.direction),
            align: 'right',
          },
          {
            header: 'DETAIL',
            value: (i: TodoItem) => {
              const r = i.reasons.find((x) => x.code === reason)!;
              const text = r.severity === 'error' ? style.red(r.detail) : r.detail;
              return i.suggestion && (reason === 'VAT_SUSPECT' || reason === 'RULE_MATCH')
                ? `${text} ${style.cyan('[fix]')}`
                : text;
            },
            flex: true,
          },
        ],
        list,
      ),
      '',
    );
  }
  const summary = TODO_REASONS.filter((r) => counts[r]).map(
    (r) => `${counts[r]} ${REASON_TITLES[r]?.toLowerCase()}`,
  );
  blocks.push(
    style.dim(`${plural(items.length, 'operation')} need attention: ${summary.join(' · ')}`),
  );
  if (items.some((i) => i.suggestion))
    blocks.push(
      style.dim(
        'Fixable items: re-run with --plan todo.plan.json, review, then dougs apply todo.plan.json',
      ),
    );
  return blocks.join('\n');
}

function renderSummary(s: VatSummary): string {
  const declared = s.meta.declaration?.filed;
  const header = [
    style.bold(`CA3 estimate for ${s.meta.month}`),
    style.dim(
      `${plural(s.meta.operations, 'operation')}${s.meta.unvalidated ? `, ${s.meta.unvalidated} not yet validated` : ''}${s.meta.uncategorized ? `, ${s.meta.uncategorized} uncategorized` : ''}. Estimate only — not a filing.`,
    ),
    '',
  ];
  const lines = s.lines.filter((l) => (l.estimate ?? 0) !== 0 || (l.declared ?? 0) !== 0);
  const table = renderTable(
    [
      { header: 'BOX', value: (l: VatSummary['lines'][number]) => l.box },
      { header: 'LABEL', value: (l) => l.label, flex: true, max: 60 },
      { header: 'ESTIMATE', value: (l) => formatAmount(l.estimate), align: 'right' },
      ...(declared
        ? [
            {
              header: 'DECLARED',
              value: (l: VatSummary['lines'][number]) =>
                l.declared === null ? '—' : String(l.declared),
              align: 'right' as const,
            },
            {
              header: 'DIFF',
              value: (l: VatSummary['lines'][number]) =>
                l.difference === null
                  ? ''
                  : Math.abs(l.difference) > 1
                    ? style.yellow(String(l.difference))
                    : style.dim(String(l.difference)),
              align: 'right' as const,
            },
          ]
        : []),
    ],
    lines,
  );
  const decl = s.meta.declaration;
  const footer = decl
    ? decl.filed
      ? style.dim(`Compared with Dougs declaration "${decl.label ?? decl.id}" (whole euros).`)
      : style.dim(
          `Dougs declaration "${decl.label ?? decl.id}" is not filed yet; no figures to compare.`,
        )
    : style.dim('No Dougs CA3 declaration found for this month.');
  return [...header, table, '', footer, ...s.notes.map((n) => style.dim(`• ${n}`))].join('\n');
}

export function registerWorkflowCommands(program: Command): void {
  // ── todo ────────────────────────────────────────────────────────────
  withExamples(
    addPlanOption(
      addRangeOptions(
        program
          .command('todo')
          .description('The morning worklist: everything that needs a human or an agent'),
      )
        .option('--limit <n>', 'Maximum number of items (newest first)', parsePositiveInt, 50)
        .option('--all', 'Return every item')
        .addOption(rulesOption()),
    ),
    'todo',
    'todo --from 2026-07-01 --limit 100 --json',
    'todo --plan todo.plan.json',
  ).action(
    async (
      o: {
        from?: string;
        to?: string;
        limit: number;
        all?: boolean;
        rules?: string;
        plan?: string;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const { rules } = await loadRules(o.rules);
      const dougs = await ctx.dougs();
      const [records, categories] = await Promise.all([
        fetchOperations(ctx, { ...rangeOf(o) }),
        categoriesOrNull(ctx, dougs),
      ]);
      const all = buildTodo(records, { rules, categories });
      const items = o.all ? all : all.slice(0, o.limit);
      if (items.length < all.length)
        ctx.out.info(
          style.dim(`Showing ${items.length} of ${all.length} items (use --all or --limit)`),
        );
      await maybeWritePlan(
        dougs,
        o.plan,
        'todo',
        items.flatMap((i) => i.suggestion ?? []),
      );
      if (o.plan) ctx.out.info(`wrote fixes to ${o.plan}; ${PLAN_NEXT_STEP(o.plan)}`);
      ctx.out.result(items, renderTodo);
    },
  );

  // ── vat ─────────────────────────────────────────────────────────────
  const vat = program.command('vat').description('VAT audit and monthly CA3 preview');

  withExamples(
    addPlanOption(
      addDocumentsOption(
        addRangeOptions(
          vat
            .command('check')
            .description('Audit VAT: arithmetic, rates, reverse charge, exemptions, invoice VAT'),
          ' (default: last 90 days)',
        ),
      ).addOption(rulesOption()),
    ),
    'vat check --from 2026-07-01 --to 2026-08-31',
    'vat check --from 2026-01-01 --plan vat.plan.json',
    'vat check --no-documents --json',
  ).action(
    async (
      o: { from?: string; to?: string; documents: boolean; plan?: string; rules?: string },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const range = rangeOf({
        from: o.from ?? (o.to ? undefined : addDays(today(), -90)),
        to: o.to,
      });
      const { rules } = await loadRules(o.rules);
      const dougs = await ctx.dougs();
      const [records, categories] = await Promise.all([
        fetchOperations(ctx, range),
        categoriesOrNull(ctx, dougs),
      ]);
      if (o.documents)
        ctx.out.info(style.dim('Reading attached invoices (cached after the first run)…'));
      const { findings, documentsChecked } = await runVatCheck(dougs, records, {
        documents: o.documents,
        categories,
        vendors: new VendorRegistry(rules.vendors),
        onProgress: progress(ctx, 'documents'),
      });
      const fixes = findings.filter((f) => f.fix).map((f) => f.fix!);
      const unique = [...new Map(fixes.map((f) => [`${f.op}`, f])).values()];
      const planPath = await maybeWritePlan(dougs, o.plan, 'vat check', unique);
      const counts: Record<string, number> = {};
      for (const f of findings) counts[f.code] = (counts[f.code] ?? 0) + 1;
      const report = {
        meta: {
          from: range.from ?? null,
          to: range.to ?? null,
          operations: records.length,
          documentsChecked,
          counts,
          fixes: unique.length,
          plan: planPath,
        },
        findings,
      };
      ctx.out.result(report, (r) =>
        [
          renderFindings(r.findings, (code) => REASON_TITLES[code] ?? code),
          '',
          style.dim(
            `${plural(r.meta.operations, 'operation')} checked, ${r.meta.documentsChecked} with documents read.`,
          ),
          r.meta.plan
            ? `${style.green('✓')} wrote ${r.meta.fixes} fix(es) to ${r.meta.plan}; ${PLAN_NEXT_STEP(r.meta.plan)}`
            : r.meta.fixes
              ? style.dim(
                  `${r.meta.fixes} unambiguous fix(es) available: re-run with --plan vat.plan.json`,
                )
              : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
  );

  withExamples(
    vat
      .command('summary')
      .description(
        'Estimate the monthly CA3 from operations, side by side with the Dougs declaration when filed',
      )
      .requiredOption('--month <YYYY-MM>', 'Declaration month'),
    'vat summary --month 2026-08',
    'vat summary --month 2026-03 --json',
  ).action(async (o: { month: string }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const range = parseMonthOption(o.month);
    const dougs = await ctx.dougs();
    const [records, categories, declarations] = await Promise.all([
      fetchOperations(ctx, range),
      categoriesOrNull(ctx, dougs),
      dougs.completedDeclarations().catch((e: Error) => {
        ctx.out.warn(`could not list declarations (${e.message})`);
        return [];
      }),
    ]);
    const ca3 = (month: string) =>
      declarations.find((d) => d.type.startsWith('CA3') && d.periodStartDate.startsWith(month));
    const current = ca3(o.month);
    const previous = ca3(previousMonth(o.month));
    const [currentForm, previousForm] = await Promise.all([
      current ? dougs.declaration(String(current.id)).then((d) => d.form ?? null) : null,
      previous ? dougs.declaration(String(previous.id)).then((d) => d.form ?? null) : null,
    ]);
    const previousCredit =
      typeof previousForm?.['27'] === 'number' ? (previousForm['27'] as number) : null;
    const ops = records.map((r) => r.op);
    const { boxes, byRate } = estimateCa3(ops, categories, previousCredit);
    const notes = [
      'Reverse-charge purchases are self-assessed at 20 % (services); adjust if some were goods or reduced-rate.',
      'Box 22 (credit carried forward) comes from the previous month’s filed declaration, when available.',
    ];
    if (!previousForm)
      notes.push(
        'Previous month’s declaration not found: box 22 is unknown and left out of box 23.',
      );
    const summary: VatSummary = {
      meta: {
        month: o.month,
        estimate: true,
        operations: ops.length,
        unvalidated: ops.filter((op) => !op.validated).length,
        uncategorized: ops.filter((op) =>
          op.breakdowns.some((b) => !b.isCounterpart && !b.category),
        ).length,
        declaration: current
          ? { id: String(current.id), label: current.label ?? null, filed: !!currentForm }
          : null,
      },
      collectedByRate: byRate,
      lines: compareWithDeclaration(boxes, currentForm),
      notes,
    };
    ctx.out.result(summary, renderSummary);
  });

  // ── rules ───────────────────────────────────────────────────────────
  const rulesCmd = program
    .command('rules')
    .description(`Local, versionable categorisation rules (${DEFAULT_RULES_FILE})`);

  withExamples(
    addPlanOption(
      addListFilters(
        rulesCmd
          .command('apply')
          .description(
            'Plan the changes your rules would make (only operations that differ get a step)',
          ),
      )
        .addOption(rulesOption())
        .option('--unvalidated-only', 'Same as --unvalidated'),
    ),
    'rules apply --unvalidated-only --plan rules.plan.json',
    'rules apply --rules ./config/dougs.rules.json --from 2026-01-01 --json',
  ).action(
    async (
      o: Parameters<typeof filterFromOptions>[0] & {
        rules?: string;
        unvalidatedOnly?: boolean;
        plan?: string;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const { rules, path } = await loadRules(o.rules);
      if (!path)
        throw new DougsError(
          'RULES_MISSING',
          `No rules file (looked for ./${DEFAULT_RULES_FILE})`,
          { exitCode: ExitCode.usage, hint: 'create one with: dougs rules init' },
        );
      if (!rules.rules.length) throw usageError(`${path} has no rules`);
      const filter = filterFromOptions({
        ...o,
        unvalidated: o.unvalidated || o.unvalidatedOnly,
        limit: undefined,
      });
      const records = await fetchOperations(ctx, filter);
      const result = planRules(rules, records);
      const dougs = await ctx.dougs();
      const planPath = await maybeWritePlan(dougs, o.plan, 'rules apply', result.steps);
      const report = {
        meta: {
          rules: path,
          operations: records.length,
          matched: result.matched,
          compliant: result.compliant,
          steps: result.steps.length,
          blocked: result.blocked.length,
          plan: planPath,
        },
        steps: result.steps,
        blocked: result.blocked,
      };
      ctx.out.result(report, (r) =>
        [
          r.steps.length
            ? renderTable(
                [
                  { header: 'OP', value: (s: StepDraft) => s.op },
                  {
                    header: 'SET',
                    value: (s: StepDraft) => (s.action === 'set' ? setSummary(s.set) : s.action),
                  },
                  { header: 'WHY', value: (s: StepDraft) => s.why, flex: true },
                ],
                r.steps,
              )
            : style.green('✓ Every matched operation already follows the rules.'),
          ...r.blocked.map((b) => style.yellow(`! ${b.op} ${b.wording}: ${b.reason}`)),
          '',
          style.dim(
            `${r.meta.operations} operations · ${r.meta.matched} matched a rule · ${r.meta.compliant} already compliant · ${r.meta.steps} to change`,
          ),
          r.meta.plan
            ? `${style.green('✓')} wrote ${r.meta.plan}; ${PLAN_NEXT_STEP(r.meta.plan)}`
            : r.steps.length
              ? style.dim('add --plan rules.plan.json to save these steps')
              : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
  );

  withExamples(
    addRangeOptions(
      rulesCmd
        .command('init')
        .description('Write a starter rules file inferred from your validated history')
        .option('-o, --output <file>', 'Where to write the rules', DEFAULT_RULES_FILE)
        .option('--min-count <n>', 'Minimum operations per merchant', parsePositiveInt, 2)
        .option('--force', 'Overwrite an existing file'),
      ' (default: last 12 months)',
    ),
    'rules init',
    'rules init --from 2025-01-01 --min-count 3 -o team.rules.json',
  ).action(
    async (
      o: { from?: string; to?: string; output: string; minCount: number; force?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      if (existsSync(o.output) && !o.force)
        throw usageError(`${o.output} already exists`, 're-run with --force to overwrite');
      const range = rangeOf({ from: o.from ?? addDays(today(), -365), to: o.to });
      const records = await fetchOperations(ctx, { ...range, status: 'validated' });
      const inferred = inferRules(
        records.map((r) => r.op),
        { minCount: o.minCount },
      );
      const file = {
        $comment: `Generated by dougs-cli ${VERSION} rules init from ${records.length} validated operations. Review before use; first matching rule wins.`,
        rules: inferred.map(({ stats: _stats, ...rule }) => rule),
        vendors: [],
        noReceiptCategories: [],
      };
      await writeFile(o.output, `${JSON.stringify(file, null, 2)}\n`);
      ctx.out.result(
        { file: o.output, rules: inferred.length, operations: records.length, inferred },
        (r) =>
          [
            r.inferred.length
              ? renderTable(
                  [
                    {
                      header: 'MATCH',
                      value: (x: (typeof inferred)[number]) => String(x.match.wording),
                    },
                    { header: 'SET', value: (x) => setSummary(x.set) },
                    { header: 'OPS', value: (x) => String(x.stats.operations), align: 'right' },
                    {
                      header: 'AGREE',
                      value: (x) => `${Math.round(x.stats.agreement * 100)}%`,
                      align: 'right',
                    },
                    { header: 'NAME', value: (x) => x.name ?? '', flex: true },
                  ],
                  r.inferred,
                )
              : style.yellow('No merchant appears often enough with a consistent category.'),
            '',
            `${style.green('✓')} wrote ${plural(r.rules, 'rule')} to ${r.file}; review it, then: dougs rules apply --plan rules.plan.json`,
          ].join('\n'),
      );
    },
  );

  // ── close-check ─────────────────────────────────────────────────────
  withExamples(
    addDocumentsOption(
      program
        .command('close-check')
        .description('Pre-closing report for an accounting year (exit code 0 even with findings)')
        .requiredOption(
          '--year <YYYY>',
          'Accounting year (the Dougs fiscal year ending that year, else the calendar year)',
          parsePositiveInt,
        )
        .addOption(rulesOption()),
    ),
    'close-check --year 2025',
    'close-check --year 2026 --no-documents --json | jq .meta',
  ).action(async (o: { year: number; documents: boolean; rules?: string }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const dougs = await ctx.dougs();
    const years = await dougs.accountingYears().catch(() => []);
    const fiscal = years.find((y) => y.closingDate.startsWith(String(o.year)));
    const from = fiscal?.openingDate.slice(0, 10) ?? `${o.year}-01-01`;
    const to = fiscal?.closingDate.slice(0, 10) ?? `${o.year}-12-31`;
    ctx.out.info(
      style.dim(
        `Accounting period ${from} → ${to}${fiscal ? ' (Dougs fiscal year)' : ' (calendar year)'}`,
      ),
    );
    const { rules } = await loadRules(o.rules);
    const [records, categories] = await Promise.all([
      fetchOperations(ctx, { from, to }),
      categoriesOrNull(ctx, dougs),
    ]);
    const report = await runCloseCheck(dougs, records, {
      year: o.year,
      from,
      to,
      rules,
      categories,
      documents: o.documents,
      onProgress: progress(ctx, 'documents'),
    });
    ctx.out.result(report, (r) =>
      [
        renderFindings(r.findings, (code) => REASON_TITLES[code] ?? code),
        '',
        style.dim(
          `${r.meta.from} → ${r.meta.to}: ${plural(r.meta.operations, 'operation')}, ${r.meta.bySeverity.error} errors, ${r.meta.bySeverity.warning} warnings, ${r.meta.bySeverity.info} info`,
        ),
      ].join('\n'),
    );
  });
}
