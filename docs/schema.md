# Output and input contracts

Every JSON shape the CLI prints or reads has a zod schema in the source and a JSON Schema at
runtime:

```sh
dougs schema                 # list the types
dougs schema operation       # JSON Schema of one type
dougs schema plan > plan.schema.json
```

Conventions everywhere:

- Amounts are EUR numbers with at most 2 decimals; amounts are **positive** and paired with a
  `direction` (`expense` | `income`).
- VAT rates are **percent** (`20`, `5.5`, `2.1`); `null` means no rate.
- VAT exemptions on purchases use short names — `outside-eu`, `inside-eu`,
  `outside-eu-not-imported`, `not-applicable` (supplier charges no VAT, e.g. a French
  micro-entrepreneur under art. 293 B CGI), `no-document` — or the raw Dougs
  value for anything else (e.g. `exemption:inbound:outsideEuropeanUnion` on sales).
- Ids are strings. Dates are `YYYY-MM-DD`.
- Lists print a JSON array (`--jsonl`: one object per line). Reports print `{ "meta": …, … }`.

## `operation`

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `date` | string | `YYYY-MM-DD` |
| `wording` | string | Bank wording |
| `type` | string \| null | `bank`, `expense`, `miscellaneous:manual`, `dispatch:…` |
| `amount` | number | Positive, EUR |
| `direction` | `expense` \| `income` | |
| `original` | `{ amount, currency }` \| null | Native amount for foreign-currency lines |
| `validated` | boolean | Validated in Dougs |
| `locked` | boolean | Locked in Dougs (manually or by a closed period); the CLI will not edit it |
| `memo` | string \| null | |
| `account` | `{ id, name }` \| null | Bank account |
| `breakdowns` | `breakdown[]` | Accounting lines |
| `category`, `vatRate`, `vatAmount`, `amountExcludingVat`, `vatExemptReason` | | Mirrors of the single main breakdown; `null` for split operations |
| `attachments` | `attachment[]` | Justifying documents |
| `url` | string | Opens the operation in the Dougs web app |

### `breakdown`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Use as `breakdown` in a plan step for split operations |
| `isCounterpart` | boolean | The automatic bank side; never edited |
| `section` | string \| null | `main`, `ecommerceDispatch:fees`, … |
| `direction` | `expense` \| `income` | Can differ from the operation (fees inside a payout) |
| `isRefund` | boolean | A refund: reverses VAT of the opposite flow |
| `vatApplicable` | boolean | False when VAT does not apply to the line (bank fees, transfers…): no VAT, no exemption |
| `category` | `{ id, name, path }` \| null | `null` = uncategorized (Dougs `-1`); `path` = `[group, name]` |
| `amount` | number | Gross (TTC) |
| `amountExcludingVat` | number | Net (HT) |
| `vatRate` | number \| null | Percent |
| `vatAmount` | number | |
| `recoverableVat` | number | Deductible part (lower for partially recoverable categories); HT + this = TTC |
| `vatExemptReason` | string \| null | See conventions |

### `attachment`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Attachment id (for `ops detach`) |
| `documentId`, `fileId` | string | |
| `filename` | string | As shown in Dougs |
| `mimeType` | string \| null | |
| `type` | string | `vendorInvoice`, `salesInvoice`, `other`, `unknown` (classification is async) |
| `vendorInvoiceId` | string \| null | Dougs' parsed invoice, when classified as one |
| `downloadPath` | string \| null | Use `dougs ops download` |

## `todo-item` (`dougs todo`)

```jsonc
{
  "op": { /* operation */ },
  "reasons": [
    { "code": "MISSING_RECEIPT", "severity": "error", "detail": "no document; 180.00 € > 150 € needs a full invoice" },
    { "code": "VAT_SUSPECT", "rule": "REVERSE_CHARGE_SUSPECT", "severity": "error", "detail": "…" }
  ],
  "suggestion": [ /* plan steps without ids */ ]
}
```

Reason codes: `OVERDUE_DECLARATION` (listed first; such items have `op: null` and a
`declaration` `{ id, type, label, periodStart, periodEnd, dueDate, isLate, status }`),
`MISSING_RECEIPT` (severity `error` above 150 €, where a full invoice is mandatory),
`UNCATEGORIZED`, `UNVALIDATED`, `VAT_SUSPECT` (with `rule`), `RULE_MATCH`. Suggestions only come
from strong evidence unless `--include-warnings`.

## `finding` (`vat check`, `close-check`)

`{ code, severity, detail, op, declaration?, evidence?, fix?, related? }` — `op` is null for
declaration findings; `fix` is a plan step without an id. Severity `error` means strong evidence
(Dougs' reverse-charge code, an explicit reverse-charge invoice with 0 VAT, or a vendor from your
rules file); plans include warning-level fixes only with `--include-warnings`. `related` lists
other operation ids (duplicates). `evidence.strength` is `strong` or `weak`.

| Code | Meaning |
|---|---|
| `VAT_TOTAL_MISMATCH` | TTC ≠ HT + VAT by more than 0.01 € |
| `VAT_RATE_INVALID` | Rate not in 0, 2.1, 5.5, 10, 20 |
| `REVERSE_CHARGE_SUSPECT` | Foreign supplier (built-in registry, rules file, or the invoice) booked with French VAT, or exempted with the wrong zone |
| `ZERO_VAT_NO_REASON` | Zero VAT, no exemption reason, but the category or supplier implies one |
| `DOCUMENT_VAT_MISMATCH` | The invoice's VAT differs from the booked VAT (same total) |
| `MISSING_RECEIPT`, `UNCATEGORIZED`, `UNVALIDATED` | As in `todo` (close-check) |
| `POSSIBLE_DUPLICATE` | Same merchant and amount within 3 days (`warning` if same day and wording) |
| `DOCUMENT_AMOUNT_MISMATCH` | Attached document total matches neither TTC, HT nor the original-currency amount |
| `OVERDUE_DECLARATION` | A declaration Dougs marks as late is not filed (close-check) |

`evidence.document` (when documents were read): `{ source: "vendor-invoice" | "pdf", zone, country,
vatAmount, reverseCharge, totals, currency }`.

## `plan` (input of `dougs apply`)

```jsonc
{
  "version": 1,
  "company": "999999",
  "createdAt": "2026-08-31T09:00:00.000Z",
  "createdBy": "dougs-cli 0.1.0 vat check",
  "steps": [
    { "id": "s1", "op": "10001", "action": "attach", "file": "./inbox/invoice.pdf",
      "why": "amount 48.00 = TTC, date +1d, vendor 'NIMBUS' in wording (score 1.00)" },
    { "id": "s2", "op": "10002", "action": "set",
      "set": { "category": 77, "vatExempt": "outside-eu" },
      "expect": { "category": -1, "vatAmount": 8 },
      "why": "Fictional SaaS is established outside the EU; reverse charge" },
    { "id": "s3", "op": "10003", "action": "detach", "attachmentId": "700001", "why": "wrong document" },
    { "id": "s4", "op": "10004", "action": "validate", "why": "reviewed" }
  ]
}
```

| Step field | Notes |
|---|---|
| `action` | `set`, `attach`, `detach`, `validate` |
| `set` | Any of `category` (id), `vatRate` (percent), `vatExempt` (`outside-eu`/`inside-eu`/`outside-eu-not-imported`/`not-applicable`/`no-document`, purchases only), `memo` (string or null). `vatRate` and `vatExempt` are exclusive |
| `breakdown` | Optional breakdown id, required for split operations |
| `file`, `name` | Attach: path relative to the plan file; display name defaults to the file name without a leading `<digits>_`. Only `.pdf .png .jpg .jpeg .heic .webp`, inside the plan's directory or the current directory (symlinks resolved) unless `apply --allow-any-path` |
| `expect` | State seen when planning (`category` with `-1` for uncategorized, `vatRate`, `vatAmount`, `vatExemptReason`, `memo`, `validated`, `attachments` count). If it changed, `apply` skips the step unless `--force` |
| `why` | Required; shown on review |

## `apply-report` (`dougs apply`, `dougs ops set|attach|detach|validate`)

```jsonc
{
  "meta": { "company": "999999", "createdBy": "…", "dryRun": false, "total": 4,
            "applied": 2, "planned": 0, "skipped": 1, "conflicts": 0, "failed": 1,
            "sideEffects": 0, "pending": 0,
            "startedAt": "…", "finishedAt": "…" },
  "results": [
    { "step": "s1", "op": "10001", "action": "attach", "status": "applied", "why": "…",
      "operation": { "date": "2026-08-02", "wording": "…", "amount": 48, "direction": "expense" },
      "changes": [{ "field": "attachments", "from": 0, "to": "+ invoice.pdf" }] },
    { "step": "s2", "op": "10002", "action": "set", "status": "skipped", "reason": "already satisfied", "changes": [] },
    { "step": "s3", "op": "10003", "action": "detach", "status": "failed",
      "error": { "code": "NOT_FOUND", "message": "…" }, "changes": [] }
  ]
}
```

Attach results also carry `file`: the resolved absolute path that is (or would be) uploaded.

Statuses: `applied`, `planned` (dry run), `skipped` (already satisfied), `conflict` (the
operation changed since planning; exit 7), `failed` (with `error`; a `PARTIALLY_APPLIED` failure
lists the saved changes in `changes`), `pending` (not attempted after a failure without
`--continue-on-error`). Applied results may carry `sideEffects`: changes Dougs made that the step
did not ask for.

## Other outputs

- `vat check` and `rules apply` also return `notPlannable: [{ op, action, code, reason }]`: fixes
  left out of the plan because apply would refuse them (`LOCKED`, `FILED_PERIOD`,
  `EXEMPTION_UNAVAILABLE`, …), counted in `meta.notPlannable`.
- `category` (`categories list`) includes `carriesVat`: false for categories outside VAT.
- `vat-summary`: `{ meta: { month, estimate: true, operations, unvalidated, uncategorized,
  declaration: { id, label, status, filed, dueDate, isLate, hasForm, corrective } }, collectedByRate:
  [{ rate, base, vat }], lines: [{ box, label, estimate, declared, difference }], notes }` —
  `declared` is the filed figure, or Dougs' draft for an open month.
- `receipts-match`: `{ meta, matched: [{ file, best, runnersUp }], ambiguous: [{ file,
  candidates, reason }], unmatched: [{ file, reason, detected }], alreadyAttached: [{ file, op }],
  alreadyDocumented: [{ file, op, existing, score }] }` — `alreadyDocumented` lists files whose
  best match already has another document (excluded unless `--include-attached`).
- `close-check`: `{ meta: { year, from, to, operations, documentsChecked, counts, bySeverity },
  findings: finding[] }`.
- `rules`: the rules file (`dougs schema rules`).

## Errors and exit codes

In JSON mode a failure prints one line on **stderr**:

```json
{"error":{"code":"AUTH_EXPIRED","message":"Dougs session is missing or expired","hint":"run: dougs login --from-browser chrome","status":401}}
```

| Exit | Meaning | Typical codes |
|---|---|---|
| 0 | OK (also for reports with findings) | |
| 1 | Unexpected | `UNEXPECTED` |
| 2 | Usage, or confirmation required | `USAGE`, `CONFIRMATION_REQUIRED`, `PLAN_INVALID`, `UNSAFE_ATTACHMENT`, `FILED_PERIOD`, `NOT_VALIDATABLE`, `SALES_EXEMPTION_UNSUPPORTED`, `RULES_INVALID`, `COMPANY_REQUIRED`, `SPLIT_OPERATION`, `CATEGORY_REQUIRED` |
| 3 | Auth missing or expired | `AUTH_MISSING`, `AUTH_EXPIRED`, `COOKIE_MISSING`, `KEYCHAIN_UNAVAILABLE` |
| 4 | Not found | `NOT_FOUND` |
| 5 | Rejected by Dougs | `API_REJECTED`, `FORBIDDEN`, `LOCKED`, `VALIDATED_READONLY`, `NOT_REVALIDATED`, `VERIFY_FAILED`, `EXEMPTION_UNAVAILABLE`, `PARTIALLY_APPLIED` |
| 6 | Network, 5xx after retries, or unexpected API shape | `NETWORK`, `API_UNAVAILABLE`, `API_SHAPE`, `PERIODS_UNKNOWN` |
| 7 | Plan partially failed, hit conflicts, or caused side effects | (see the report) |
