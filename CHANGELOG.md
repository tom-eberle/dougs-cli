# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-07

First release, **experimental**: the write path is guarded and tested against a model of the
Dougs API, and exercised on a real company only in a limited way. Review plans, start with
`--dry-run`, and keep your accountant in the loop.

### Workflows
- `dougs todo`: one worklist with overdue declarations first, then missing receipts (with the
  150 € full-invoice rule; transfers, capital, loans, subsidies, FX and tax settlements are
  skipped unless `--strict`), uncategorized, unvalidated, VAT-suspect and rule-matching
  operations, with suggested fixes.
- `dougs receipts match`: match local PDFs/images to operations by amount (TTC, HT, original
  currency), date and vendor name. Only operations without a document are targets by default
  (`--include-attached`); invoice/receipt files with the same number count as the same
  document; `<opId>_name` files go to that operation (when amount or date agrees) or are skipped;
  a date in the file name decides the billing period.
- `dougs vat check`: arithmetic, rate, reverse-charge, missing-exemption and invoice-VAT checks,
  using Dougs' own invoice reading and PDF text. The attached invoice wins over the built-in
  vendor list; lines outside VAT (bank fees, insurance, transfers…) are never flagged.
- `dougs vat summary`: monthly CA3 estimate beside Dougs' filed return or draft, with the
  declaration's status, due date and lateness; box 22 from the last filed return, as Dougs does.
- `dougs rules init|apply`: local, versionable categorisation rules (unvalidated operations by
  default) and a starter file inferred from history.
- `dougs close-check`: pre-closing report (receipts, categories, validation, VAT, duplicates,
  document totals, overdue declarations).
- `dougs apply`: review and execute plans — idempotent, resumable, verifies every write, audit
  report.

### VAT exemptions
- `--vat-exempt` / `vatExempt` cover every reason Dougs offers: on purchases `outside-eu`,
  `inside-eu`, `outside-eu-not-imported`, `not-applicable` (supplier under the VAT franchise,
  "TVA non applicable") and `no-document`; on sales `outside-eu`, `inside-eu` and
  `not-applicable`. The line decides purchase vs sales values (a supplier refund is a purchase).

### Safety
- Never sends `?force=true`: locked operations are refused (`LOCKED`) for edits, validation and
  detaching; periods covered by a filed VAT return (CA3, CA12) and closed years are protected
  (`--allow-filed-periods`); validation is refused when Dougs would show errors.
- Validated operations are reopened, edited and validated again, as the web app does; an
  operation validated at plan time ends validated, even when a plan is re-run after an
  interruption. A refused reopening is `VALIDATED_READONLY`; a 403 on a write never triggers a
  session refresh.
- Every write is re-read and checked for side effects (exit 7) and partial application
  (`PARTIALLY_APPLIED`, with what was saved).
- Plans contain only strong-evidence VAT fixes (`--include-warnings` for the rest) and only steps
  apply would accept; refused ones are listed as `notPlannable` with the reason.
- Plans are treated as untrusted input: attach steps upload only receipt file types from the
  plan's directory or the current directory (symlinks resolved, read once) unless
  `--allow-any-path`; previews and confirmations show every file's absolute path.
- CSV export neutralizes spreadsheet formulas in text columns; human output strips terminal
  control characters coming from data; JSON is never altered.

### Building blocks
- `ops list|get|set|attach|detach|validate|download`, `receipts download`, `categories list`,
  `accounts list`, `export` (CSV/JSON/JSONL), `api` (authenticated escape hatch).
- `login`: email and password with the second factor Dougs asks for (authenticator app or email
  code), like the web app; `--email` with the password on stdin for scripts; `--from-browser
  chrome|brave|edge|arc` (macOS; Linux best effort; the only way for Google sign-in) and
  `--with-token`. Without a terminal, plain `login` exits 2 with a hint instead of prompting.
- Sessions are kept in the macOS Keychain or the Linux Secret Service (`secret-tool`), else in the
  0600 config file with a notice (`DOUGS_CREDENTIAL_STORE=file` forces it); the password is never
  stored. Their expiry is recorded (and kept current when Dougs renews the cookie): `whoami`
  shows it, `doctor` warns a week ahead and fails once expired, `login --check` exits 0 or 3.
  A store that cannot be read (locked keychain over SSH) is `CREDENTIAL_STORE_LOCKED` (exit 3)
  with an unlock hint; a logout that cannot remove the stored item says so and exits 1.
- `logout` (`--remote` also ends the session on Dougs), `whoami`, profiles, `DOUGS_SESSION` /
  `DOUGS_COMPANY` / `DOUGS_PROFILE`.
- `commands --json`, `schema <type>`, `doctor` (API drift detection).
- Tables on a TTY, JSON when piped, `--jsonl`, structured errors and stable exit codes.

### Known issues
- Customer refunds (money paid back to a customer) get sales exemption values by symmetry with
  supplier refunds; no real instance has been seen yet, so preview such a change with
  `--dry-run` first.
- Some server behaviours modelled in the test harness are marked ASSUMED
  (`test/helpers/fake-api.ts`); the live service may differ.
