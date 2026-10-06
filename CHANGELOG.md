# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `--vat-exempt` / `vatExempt` accept every purchase reason Dougs offers: `not-applicable`
  (supplier under the VAT franchise, "TVA non applicable") and `outside-eu-not-imported`, besides
  `outside-eu`, `inside-eu` and `no-document`. Purchase exemptions are refused on sales lines.

### Fixed
- `receipts match` only targets operations without a document by default (`--include-attached`
  to widen) and reports how many files it excluded; invoice/receipt files with the same number
  count as the same document; `<opId>_name` files go to that operation or are skipped; a date in
  the file name decides the billing period, so a month-off charge no longer scores 1.00.

## [0.1.0] — 2026-10-06

First release, **experimental**: the write path is guarded and tested against a model of the
Dougs API, but mutations have not yet been exercised widely against the live service. Review
plans, start with `--dry-run`, and keep your accountant in the loop.

### Workflows
- `dougs todo`: one worklist of missing receipts (with the 150 € full-invoice rule),
  uncategorized, unvalidated, VAT-suspect and rule-matching operations, with suggested fixes.
- `dougs receipts match`: match local PDFs/images to operations by amount (TTC, HT, original
  currency), date window and vendor name; writes attach plans for confident matches.
- `dougs vat check`: arithmetic, rate, reverse-charge, missing-exemption and invoice-VAT checks,
  using Dougs' own invoice reading and PDF text; writes fix plans for unambiguous cases.
- `dougs vat summary`: monthly CA3 estimate, side by side with the filed declaration.
- `dougs rules init|apply`: local, versionable categorisation rules and a starter file inferred
  from history.
- `dougs close-check`: pre-closing report (receipts, categories, validation, VAT, duplicates,
  document totals).
- `dougs apply`: review and execute plans — idempotent, resumable, verifies every write, audit
  report.

### Safety
- Plans are treated as untrusted input: attach steps upload only receipt file types from the
  plan's directory or the current directory (symlinks resolved) unless `--allow-any-path`;
  previews and confirmations show every file's absolute path.
- CSV export neutralizes spreadsheet formulas in text columns.
- Human output strips terminal control characters coming from data; JSON is never altered.

- Never sends `?force=true`: locked operations are refused (`LOCKED`) for edits, validation and
  detaching; periods covered by a filed VAT return (CA3, CA12) and closed years are protected
  (`--allow-filed-periods`); validation is refused when Dougs would show errors; every write is
  checked for side effects (exit 7) and partial application.
- VAT fixes are planned only on strong evidence (`--include-warnings` for the rest); the attached
  invoice wins over the built-in vendor list.
- `vat summary` shows Dougs' filed return or draft side by side, the declaration status and
  lateness, and takes box 22 from the last filed return as Dougs does; `todo`/`close-check` report
  overdue declarations.

### Building blocks
- `ops list|get|set|attach|detach|validate|download`, `receipts download`, `categories list`,
  `accounts list`, `export` (CSV/JSON/JSONL), `api` (authenticated escape hatch).
- `login --from-browser chrome|brave|edge|arc` (macOS; Linux best effort) and `--with-token`,
  `logout`, `whoami`, profiles, `DOUGS_SESSION` / `DOUGS_COMPANY` / `DOUGS_PROFILE`.
- `commands --json`, `schema <type>`, `doctor` (API drift detection).
- Tables on a TTY, JSON when piped, `--jsonl`, structured errors and stable exit codes.
