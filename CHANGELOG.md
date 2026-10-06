# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

First release.

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

### Building blocks
- `ops list|get|set|attach|detach|validate|download`, `receipts download`, `categories list`,
  `accounts list`, `export` (CSV/JSON/JSONL), `api` (authenticated escape hatch).
- `login --from-browser chrome|brave|edge|arc` (macOS; Linux best effort) and `--with-token`,
  `logout`, `whoami`, profiles, `DOUGS_SESSION` / `DOUGS_COMPANY` / `DOUGS_PROFILE`.
- `commands --json`, `schema <type>`, `doctor` (API drift detection).
- Tables on a TTY, JSON when piped, `--jsonl`, structured errors and stable exit codes.
