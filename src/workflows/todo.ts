import { z } from 'zod';
import type { OperationRecord } from '../api/dougs.js';
import { operationSchema } from '../api/schemas.js';
import type { StepDraft } from '../plan/types.js';
import {
  type CategoryIndex,
  type Finding,
  missingReceipt,
  SEVERITIES,
  uncategorized,
  unvalidated,
} from './findings.js';
import { evaluateRules, type RulesFile, ruleStep } from './rules.js';
import { checkVat } from './vat.js';
import { VendorRegistry } from './vendors.js';

export const TODO_REASONS = [
  'MISSING_RECEIPT',
  'UNCATEGORIZED',
  'UNVALIDATED',
  'VAT_SUSPECT',
  'RULE_MATCH',
] as const;
export type TodoReason = (typeof TODO_REASONS)[number];

export const todoItemSchema = z
  .object({
    op: operationSchema,
    reasons: z.array(
      z.object({
        code: z.enum(TODO_REASONS),
        severity: z.enum(SEVERITIES),
        detail: z.string(),
        rule: z.string().optional().describe('For VAT_SUSPECT: the vat check rule that fired'),
      }),
    ),
    suggestion: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe('Plan steps (without ids) that would fix it'),
  })
  .describe('One operation that needs attention, with machine-readable reasons');
export type TodoItem = Omit<z.infer<typeof todoItemSchema>, 'suggestion'> & {
  suggestion?: StepDraft[];
};

export interface TodoOptions {
  rules: RulesFile;
  categories?: CategoryIndex;
}

/** Cheap, local checks only (no document downloads) so the worklist stays fast. */
export function buildTodo(records: readonly OperationRecord[], options: TodoOptions): TodoItem[] {
  const vendors = new VendorRegistry(options.rules.vendors);
  const policy = { noReceiptCategories: new Set(options.rules.noReceiptCategories) };
  const items: TodoItem[] = [];
  for (const { op } of records) {
    const reasons: TodoItem['reasons'] = [];
    const suggestion: StepDraft[] = [];
    const add = (f: Finding | null, code: TodoReason) => {
      if (f)
        reasons.push({
          code,
          severity: f.severity,
          detail: f.detail,
          ...(code === 'VAT_SUSPECT' ? { rule: f.code } : {}),
        });
    };
    add(missingReceipt(op, policy), 'MISSING_RECEIPT');
    add(uncategorized(op), 'UNCATEGORIZED');
    add(unvalidated(op), 'UNVALIDATED');
    for (const f of checkVat(op, { vendors, categories: options.categories })) {
      add(f, 'VAT_SUSPECT');
      if (f.fix) suggestion.push(f.fix);
    }
    const outcome = evaluateRules(options.rules, op);
    const step = outcome ? ruleStep(op, outcome) : null;
    if (outcome && step) {
      reasons.push({ code: 'RULE_MATCH', severity: 'info', detail: step.why });
      // A rule and a VAT fix may overlap; the rule is the user's explicit intent.
      suggestion.splice(0, suggestion.length, step);
    }
    if (reasons.length) items.push({ op, reasons, ...(suggestion.length ? { suggestion } : {}) });
  }
  return items;
}

export function countByReason(items: readonly TodoItem[]): Record<TodoReason, number> {
  const counts = Object.fromEntries(TODO_REASONS.map((r) => [r, 0])) as Record<TodoReason, number>;
  for (const item of items)
    for (const code of new Set(item.reasons.map((r) => r.code))) counts[code]++;
  return counts;
}
