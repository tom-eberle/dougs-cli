import { z } from 'zod';
import type { Dougs, EcommerceSaleLine } from '../api/dougs.js';
import type { Breakdown, Operation, RawEcommerceSale, RawOperation } from '../api/schemas.js';
import { DougsError, ExitCode, toDougsError } from '../output/errors.js';
import { cents } from '../util/money.js';
import {
  type Change,
  toCents,
  type Ventilation,
  type VentilationZone,
  ventilationNetCents,
} from './types.js';

/*
 * E-commerce ventilation: a monthly `dispatch:ecommerce:salesChannel` operation
 * that splits what a sales channel (an app store, a marketplace) collected into
 * sales lines (by VAT zone) and commission lines (by payment processor).
 *
 * Observed behaviour of the Dougs API this relies on (see docs/API.md):
 * - An empty ventilation has no breakdowns at all. Lines are added with
 *   `POST …/ecommerceSales` (amount 0), then given an amount with
 *   `POST …/ecommerceSales/{breakdownId}`, sending the line back with the new
 *   amount, as the web app does. No delete endpoint is known, so lines are
 *   never removed: a re-run reuses an empty line instead of adding another.
 * - Dougs maintains the counterpart breakdown (`section: "main"`,
 *   `isCounterpart`) itself, asynchronously: right after the line writes the
 *   operation can have amount 0 and no counterpart at all; a few seconds later
 *   (live: ~6 s) the counterpart exists and both it and the operation amount
 *   equal sales − fees. Validating before that is refused (the lines do not add
 *   up), so after writing, the operation is polled until the net is there.
 * - Commission lines get their VAT exemption reason from Dougs (the slot is not
 *   editable), so the CLI never sets it.
 */

export const ECOMMERCE_DISPATCH = 'dispatch:ecommerce:salesChannel';
export const SALES_SECTION = 'ecommerceDispatch:sales:service';
export const FEES_SECTION = 'ecommerceDispatch:fees';

/**
 * How each sales zone is created, by the web app's request. Other kinds of
 * sales (French VAT rates, goods) would get their own entries.
 */
const ZONE_SALES: Record<
  VentilationZone,
  { saleId: string; create: Record<string, string>; update: Record<string, string> }
> = {
  'inside-eu': {
    saleId: 'exemption:inbound:insideEuropeanUnion',
    create: {
      sectionId: 'service',
      subSectionId: 'fr',
      selectedZone: 'exonerateSale',
      packageId: 'over150',
    },
    update: { sectionId: 'service', subSectionId: 'fr' },
  },
  'outside-eu': {
    saleId: 'exemption:inbound:outsideEuropeanUnion',
    create: {
      sectionId: 'service',
      subSectionId: 'fr',
      selectedZone: 'exonerateSale',
      packageId: 'over150',
    },
    update: { sectionId: 'service', subSectionId: 'fr' },
  },
};
const FEE_IDS = { sectionId: 'fees', subSectionId: 'fees' };

interface Target {
  kind: 'sales' | 'fees';
  /** Zone for sales, payment processor id for fees. */
  key: string;
  amount: number;
}

function targets(v: Ventilation): Target[] {
  return [
    ...v.sales.map((s) => ({ kind: 'sales' as const, key: s.zone, amount: s.amount })),
    ...(v.fees ?? []).map((f) => ({
      kind: 'fees' as const,
      key: String(f.paymentsProcessorId),
      amount: f.amount,
    })),
  ];
}

const label = (t: Target) => `${t.kind} ${t.key}`;

/** A line of the target's kind: exempt sale of that zone, or commission of that processor. */
function isTargetLine(b: Breakdown, t: Target): boolean {
  if (b.isRefund) return false;
  return t.kind === 'sales'
    ? b.section === SALES_SECTION &&
        b.direction === 'income' &&
        b.vatExemptReason === t.key &&
        b.vatAmount === 0
    : b.section === FEES_SECTION &&
        b.direction === 'expense' &&
        String(b.paymentsProcessorId) === t.key;
}

/**
 * Pair each target with an existing line: one already at the target amount,
 * else an empty one (left by an interrupted run). Non-empty lines no target
 * accounts for are conflicts: the ventilation holds other figures.
 */
function pairLines(op: Operation, v: Ventilation) {
  const lines = op.breakdowns.filter((b) => !b.isCounterpart);
  const used = new Set<string>();
  const pairs = targets(v).map((t) => {
    const free = lines.filter((b) => !used.has(b.id) && isTargetLine(b, t));
    const line =
      free.find((b) => toCents(b.amount) === toCents(t.amount)) ??
      free.find((b) => toCents(b.amount) === 0);
    if (line) used.add(line.id);
    return { target: t, line };
  });
  const conflicts = lines.filter((b) => !used.has(b.id) && toCents(b.amount) !== 0);
  return { pairs, conflicts };
}

function counterpartOf(op: Operation): Breakdown | undefined {
  return op.breakdowns.find((b) => b.isCounterpart);
}

/** Dougs has recomputed the ventilation: one counterpart, it and the operation amount at the net. */
function counterpartSettled(op: Operation, v: Ventilation): boolean {
  const cps = op.breakdowns.filter((b) => b.isCounterpart);
  const net = ventilationNetCents(v);
  return cps.length === 1 && toCents(cps[0]!.amount) === net && toCents(op.amount) === net;
}

/**
 * How long to wait for Dougs' asynchronous recompute of the counterpart after
 * the line writes. Mutable so tests can shorten it.
 */
export const VENTILATION_POLL = { intervalMs: 1000, timeoutMs: 20_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Re-read until the lines and the recomputed net show; refuse to go on otherwise. */
async function waitForRecompute(dougs: Dougs, opId: string, v: Ventilation): Promise<void> {
  const deadline = Date.now() + VENTILATION_POLL.timeoutMs;
  for (;;) {
    const { op } = await dougs.getOperation(opId);
    const filled = ventilationLinesFilled(op, v);
    if (filled && counterpartSettled(op, v)) return;
    if (Date.now() >= deadline) {
      const cp = op.breakdowns.find((b) => b.isCounterpart);
      const seconds = Math.round(VENTILATION_POLL.timeoutMs / 1000);
      throw filled
        ? new DougsError(
            'NOT_RECOMPUTED',
            `Dougs has not recomputed operation ${opId} to the net ${(ventilationNetCents(v) / 100).toFixed(2)} after ${seconds} s (amount ${op.amount.toFixed(2)}, counterpart ${cp ? cp.amount.toFixed(2) : 'missing'}); it was not validated`,
            {
              exitCode: ExitCode.rejected,
              hint: 're-run the same plan in a minute: the lines are kept and it validates then',
            },
          )
        : new DougsError(
            'VERIFY_FAILED',
            `Dougs accepted the lines of operation ${opId}, but re-reading it does not show the planned figures; it was not validated`,
            { exitCode: ExitCode.rejected, hint: 'inspect it with: dougs ops get <id>' },
          );
    }
    await sleep(VENTILATION_POLL.intervalMs);
  }
}

/** Every target line exists at its amount, and no other line holds figures. */
export function ventilationLinesFilled(op: Operation, v: Ventilation): boolean {
  const { pairs, conflicts } = pairLines(op, v);
  return (
    !conflicts.length &&
    pairs.every((p) => p.line && toCents(p.line.amount) === toCents(p.target.amount))
  );
}

export function ventilationSatisfied(op: Operation, v: Ventilation): boolean {
  return (
    op.type === ECOMMERCE_DISPATCH &&
    ventilationLinesFilled(op, v) &&
    (!v.validate || op.validated) &&
    counterpartSettled(op, v)
  );
}

/** Why the operation cannot take this ventilation (null when it can). */
export function ventilationRefusal(op: Operation, v: Ventilation): DougsError | null {
  if (op.type !== ECOMMERCE_DISPATCH)
    return new DougsError(
      'NOT_ECOMMERCE_DISPATCH',
      `Operation ${op.id} is not an e-commerce ventilation (type ${op.type ?? 'unknown'})`,
      {
        exitCode: ExitCode.usage,
        hint: `ventilate steps target operations of type ${ECOMMERCE_DISPATCH}`,
      },
    );
  const { conflicts } = pairLines(op, v);
  if (conflicts.length)
    return new DougsError(
      'ALREADY_VENTILATED',
      `Operation ${op.id} already holds other figures (breakdown ${conflicts
        .map((b) => `${b.id}: ${b.section} ${cents(b.amount).toFixed(2)}`)
        .join(', ')})`,
      {
        exitCode: ExitCode.usage,
        hint: 'check it in Dougs (dougs ops get <id>); dougs-cli only fills empty ventilations and never deletes lines',
      },
    );
  return null;
}

/** Before → after for review output. */
export function describeVentilation(op: Operation, v: Ventilation): Change[] {
  const changes: Change[] = [];
  for (const { target, line } of pairLines(op, v).pairs)
    if (!line || toCents(line.amount) !== toCents(target.amount))
      changes.push({ field: label(target), from: line ? line.amount : null, to: target.amount });
  const cp = counterpartOf(op);
  const net = ventilationNetCents(v) / 100;
  if (!cp || toCents(cp.amount) !== toCents(net))
    changes.push({ field: 'net', from: cp ? cp.amount : null, to: net });
  return changes;
}

/** Breakdowns a ventilation writes, directly or through Dougs (the counterpart). */
export function isVentilationBreakdown(b: Breakdown): boolean {
  return b.isCounterpart || (b.section ?? '').startsWith('ecommerceDispatch:');
}

function salesChannelOf(raw: RawOperation): string | null {
  const parsed = z
    .looseObject({
      metadata: z
        .looseObject({ salesChannelId: z.union([z.number(), z.string()]).nullable().optional() })
        .nullable()
        .optional(),
    })
    .safeParse(raw);
  const id = parsed.success ? parsed.data.metadata?.salesChannelId : null;
  return id == null ? null : String(id);
}

/**
 * Names of the plan's payment processors, from the operation's sales channel
 * (the web app sends the name when adding a commission line). Refuses
 * processors that channel does not use.
 */
export async function processorLabels(
  dougs: Dougs,
  raw: RawOperation,
  v: Ventilation,
): Promise<Map<number, string>> {
  const wanted = (v.fees ?? []).map((f) => f.paymentsProcessorId);
  if (!wanted.length) return new Map();
  const channel = salesChannelOf(raw);
  if (channel === null)
    throw new DougsError(
      'PROCESSOR_UNKNOWN',
      `Operation ${raw.id} names no sales channel (metadata.salesChannelId), so its payment processors cannot be checked`,
      { exitCode: ExitCode.usage, hint: 'fill this ventilation in the Dougs web app' },
    );
  const channels = (await dougs.salesChannels()).filter((c) => String(c.id) === channel);
  const known = new Map<number, string>();
  for (const c of channels)
    for (const p of c.paymentsProcessorsWithDate)
      known.set(Number(p.paymentsProcessorId), p.paymentsProcessor?.name ?? '');
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length)
    throw new DougsError(
      'PROCESSOR_UNKNOWN',
      `Operation ${raw.id}: payment processor ${missing.join(', ')} is not linked to its sales channel`,
      {
        exitCode: ExitCode.usage,
        hint: known.size
          ? `processors of this channel: ${[...known].map(([id, name]) => `${id} (${name})`).join(', ')}`
          : 'link the payment processor to the sales channel in Dougs first',
      },
    );
  return known;
}

/** The line object sent back with a new amount (as the web app does: no vatAmount). */
function withAmount(
  sale: RawEcommerceSale,
  amount: number,
  ids: Record<string, string>,
): Record<string, unknown> {
  const { vatAmount: _vat, totalAmount: _total, totalVatAmount: _totalVat, ...line } = sale;
  return { ...line, amount, ...ids };
}

/**
 * Create and fill the lines the operation still lacks. Lines already at their
 * amount are left alone and empty ones are reused, so an interrupted run
 * resumes without duplicates. Validation is left to the caller.
 */
export async function applyVentilation(
  dougs: Dougs,
  raw: RawOperation,
  opId: string,
  v: Ventilation,
): Promise<void> {
  const labels = await processorLabels(dougs, raw, v);
  const lines = await dougs.ecommerceSales(opId);
  const used = new Set<string>();
  const idOf = (l: EcommerceSaleLine) => String(l.sale.breakdownId);
  const plan = targets(v).map((t) => {
    const matches = (l: EcommerceSaleLine) =>
      l.sale.isRefund !== true &&
      (t.kind === 'sales'
        ? l.sectionId === 'service' && l.sale.saleId === ZONE_SALES[t.key as VentilationZone].saleId
        : l.sectionId === 'fees' &&
          l.sale.saleId === 'fees' &&
          String(l.sale.paymentsProcessorId) === t.key);
    const free = lines.filter((l) => !used.has(idOf(l)) && matches(l));
    const line =
      free.find((l) => toCents(l.sale.amount) === toCents(t.amount)) ??
      free.find((l) => toCents(l.sale.amount) === 0);
    if (line) used.add(idOf(line));
    return { target: t, existing: line?.sale };
  });
  const others = lines.filter((l) => !used.has(idOf(l)) && toCents(l.sale.amount) !== 0);
  if (others.length)
    throw new DougsError(
      'ALREADY_VENTILATED',
      `Operation ${opId} already holds other figures (line ${others
        .map((l) => `${idOf(l)}: ${l.sectionId} ${cents(l.sale.amount).toFixed(2)}`)
        .join(', ')})`,
      {
        exitCode: ExitCode.usage,
        hint: 'check it in Dougs (dougs ops get <id>); dougs-cli only fills empty ventilations and never deletes lines',
      },
    );

  const created: string[] = [];
  try {
    for (const { target, existing } of plan) {
      let sale = existing;
      if (target.kind === 'sales') {
        const def = ZONE_SALES[target.key as VentilationZone];
        if (!sale) {
          sale = await dougs.createEcommerceSale(opId, { ...def.create, saleId: def.saleId });
          created.push(String(sale.breakdownId));
        }
        if (toCents(sale.amount) !== toCents(target.amount))
          await dougs.updateEcommerceSale(
            opId,
            String(sale.breakdownId),
            withAmount(sale, target.amount, def.update),
          );
      } else {
        const processor = Number(target.key);
        if (!sale) {
          sale = await dougs.createEcommerceSale(opId, {
            ...FEE_IDS,
            saleId: 'fees',
            paymentsProcessorId: processor,
            label: labels.get(processor) ?? '',
          });
          created.push(String(sale.breakdownId));
        }
        if (toCents(sale.amount) !== toCents(target.amount))
          await dougs.updateEcommerceSale(
            opId,
            String(sale.breakdownId),
            withAmount(sale, target.amount, FEE_IDS),
          );
      }
    }
    // Before anyone validates: the lines must show, and Dougs must have recomputed the net.
    await waitForRecompute(dougs, opId, v);
  } catch (error) {
    const e = toDougsError(error);
    if (!created.length) throw e;
    throw new DougsError(
      e.code,
      `${e.message} (after adding line(s) ${created.join(', ')}; re-running the plan reuses them)`,
      { exitCode: e.exitCode, hint: e.hint, status: e.status },
    );
  }
}
