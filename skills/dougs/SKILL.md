---
name: dougs
description: Run French bookkeeping workflows on Dougs (app.dougs.fr) with the dougs CLI — find what needs attention, match invoices to bank lines, audit VAT (including reverse charge on foreign suppliers), preview the monthly CA3, apply categorisation rules and run pre-closing checks. Use when the user mentions Dougs, their accounting operations, receipts/justificatifs, TVA/VAT, CA3, categories or closing the books.
---

# Dougs bookkeeping with the `dougs` CLI

`dougs` is an unofficial CLI over the Dougs web app's private API. It prints JSON when piped
(always add `--json` anyway) and never prompts when not in a terminal.

## Ground rules

1. **Read freely, write only through reviewed plans.** Produce a plan file, summarise it for the
   user, wait for approval, then `dougs apply <plan> --yes --report <plan>.report.json`.
2. **Never handle credentials.** Check with `dougs login --check` (exit 0 valid, 3 not) before
   long runs. On exit 3, ask the user to run `dougs login` in their own terminal (email,
   password and 2FA code), or `dougs login --from-browser chrome` for Google sign-in. Never ask
   for, type or store their password or session cookie. `CREDENTIAL_STORE_LOCKED` means the
   keychain is locked (SSH, cron): relay the hint; don't suggest logging in again first.
3. **Branch on exit codes**: 0 ok · 2 usage or confirmation required · 3 auth · 4 not found ·
   5 rejected by Dougs · 6 network/API changed (run `dougs doctor --json`) · 7 plan partially
   failed, conflicts, or side effects (read the report).
4. **Findings are signals.** Explain them; let the user (or their accountant) decide anything that
   is a matter of judgement. Never fabricate documents or change amounts.

## Orientation

```sh
dougs login --check --json             # is the session valid? when does it expire?
dougs whoami --json                    # user, companies, active company, auth source
dougs doctor --json                    # auth + API shape check
dougs commands --json                  # every command, flag and example
dougs schema todo-item                 # JSON Schema of an output (also: plan, finding, operation…)
dougs categories list --search <text> --json   # category ids for --category / rules
```

## Recipes

**Morning worklist**
```sh
dougs todo --json --limit 100
```
Items with `reasons[0].code == "OVERDUE_DECLARATION"` come first (`op: null`, see
`declaration`): tell the user, they have deadlines. Other items: `op` (normalized operation),
`reasons[]` (`MISSING_RECEIPT` — severity `error` means
> 150 € and a full invoice is required; `UNCATEGORIZED`; `UNVALIDATED`; `VAT_SUSPECT` with
`rule`; `RULE_MATCH`), optional `suggestion[]` (plan steps). `dougs todo --plan todo.plan.json`
writes the suggestions as a plan.

**Attach invoices the user downloaded**
```sh
dougs receipts match ./inbox --json                       # review matched / ambiguous / unmatched
dougs receipts match ./inbox --plan receipts.plan.json    # confident matches only
dougs apply receipts.plan.json --dry-run --json
```
For ambiguous files, show the candidates and ask; you can then write `attach` steps by hand.

**VAT audit (e.g. before the monthly return)**
```sh
dougs vat check --from 2026-08-01 --to 2026-08-31 --json
dougs vat check --from 2026-08-01 --to 2026-08-31 --plan vat.plan.json
dougs vat summary --month 2026-08 --json
```
`REVERSE_CHARGE_SUSPECT` = a supplier established outside France booked with deductible French
VAT, or exempted with the wrong zone. Severity `error` = strong evidence (Dougs' reverse-charge
code, an explicit reverse-charge invoice, a vendor in the rules file); plans contain only those.
Warnings (built-in vendor list, Dougs' reading of the supplier country) need the user's review;
only then use `--include-warnings`. `vat summary` is an estimate, shown beside Dougs' filed return
or draft.

**Rules**
```sh
dougs rules init --json                                   # starter dougs.rules.json from history
dougs rules apply --unvalidated-only --plan rules.plan.json --json
```

**Pre-closing**
```sh
dougs close-check --year 2025 --json      # meta.counts, findings[] (exit 0 even with findings)
```

**Single operations** (each still previews and needs `--yes` non-interactively)
```sh
dougs ops get 10001 --json
dougs ops set 10001 --category 77 --vat-exempt outside-eu --dry-run --json
dougs ops attach 10001 ./invoice.pdf --yes --json
dougs ops validate 10001 --yes --json
```

## Writing a plan by hand

```json
{
  "version": 1,
  "company": "999999",
  "createdAt": "2026-08-31T09:00:00.000Z",
  "createdBy": "agent: monthly VAT review",
  "steps": [
    { "id": "s1", "op": "10002", "action": "set",
      "set": { "category": 77, "vatExempt": "outside-eu" },
      "expect": { "vatAmount": 8 },
      "why": "Invoice shows a US supplier and 0.00 VAT (reverse charge)" },
    { "id": "s2", "op": "10005", "action": "attach", "file": "./inbox/invoice-aug.pdf",
      "why": "Total 48.00 EUR on 2026-08-01 matches the 2026-08-02 debit" }
  ]
}
```

- `vatExempt` says why there is no French VAT. On a **sale** (e.g. a B2B service invoiced to a
  company outside the EU): `outside-eu`, `inside-eu` or `not-applicable`. On a purchase: `outside-eu` / `inside-eu`
  (foreign supplier, reverse charge), `outside-eu-not-imported` (goods bought abroad, not
  imported), `not-applicable` (the supplier charges no VAT — e.g. a French micro-entrepreneur
  whose invoice says "TVA non applicable, art. 293 B du CGI"; fix this when Dougs added 20 % VAT
  after a re-categorization, often reported as a side effect), `no-document` (receipt lost).
- Actions: `set` (`category`, `vatRate` in percent, `vatExempt`, `memo`), `attach` (`file`
  relative to the plan, optional `name`), `detach` (`attachmentId`), `validate`.
- Attach files must be receipts (`.pdf .png .jpg .jpeg .heic .webp`) inside the plan's directory or
  the current directory; otherwise `apply` refuses the whole plan (`UNSAFE_ATTACHMENT`, exit 2).
  Put the plan next to the documents rather than asking for `--allow-any-path`.
- Add `expect` with the values you saw (from `ops get --json`) so `apply` skips the step if
  someone changed the operation meanwhile. Use `"category": -1` for uncategorized.
- Split operations (several breakdowns) need `"breakdown": "<id>"` on `set` steps.
- Check it with `dougs apply plan.json --dry-run --json` (exit 2 + `PLAN_INVALID` explains schema
  errors) before asking for approval.

## Refusals to expect (don't work around them silently)

- `LOCKED` (exit 5): the operation is locked in Dougs; only an accountant can unlock it.
- `FILED_PERIOD` (exit 2): its VAT return is filed or the year is closed. Ask the user before
  `--allow-filed-periods`; such changes usually require a corrective return.
- `NOT_VALIDATABLE` (exit 2): fix the reported problems first.
- Editing a validated operation reopens it and validates it again (both appear in `changes`).
  `VALIDATED_READONLY` (exit 5): Dougs refused to reopen it (often under accountant review);
  ask the user. `NOT_REVALIDATED`: the edit worked but the operation needs fixing before
  `dougs ops validate`. A 403 on a write is never a login problem; don't ask the user to log in.
- `conflict` steps (apply exit 7): the operation changed since planning; re-plan.
- `notPlannable` in `vat check` / `rules apply` output: fixes apply would refuse (locked, filed
  period, no exemption possible…). Report them; don't try to force them through `ops set`.
- Zero VAT on bank fees, insurance, salaries or transfers is normal (`vatApplicable: false`):
  never add an exemption there.
- `MISSING_RECEIPT` skips transfers between accounts, capital, loans, subsidies, FX and tax
  settlements (`needsDocument: false` categories); use `--strict` only when asked.
- `sideEffects` on applied steps (exit 7): Dougs changed something else too; report it to the user.

## Data notes

- Amounts are positive EUR with `direction` (`expense` / `income`); VAT rates are percent.
- `category: null` means uncategorized. `vatExemptReason`: `outside-eu`, `inside-eu`,
  `outside-eu-not-imported`, `not-applicable`, `no-document`, or a raw Dougs value (sales).
- `attachments[].type` becomes `vendorInvoice` a little after an upload (classification is
  asynchronous).
- Use `--all` on lists when you need everything; the default limit is 50.
