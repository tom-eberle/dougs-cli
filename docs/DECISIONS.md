# Design decisions (v0.1)

Choices made where SPEC.md left room, with the reasoning. Newest last.

## Data contracts

- **Amounts are positive, with a `direction`.** Dougs stores operation amounts as positive EUR
  and a separate `isInbound`; we keep that (`amount` + `direction: expense|income`) instead of a
  signed number, so `amount` always matches the bank line and invoices. Human tables show a sign
  (`-48.00`, `+1200.00`).
- **VAT rates are percent** (`20`, `5.5`) everywhere in the CLI, plans and rules; the API's
  fractions (`0.2`) are converted at the edge.
- **Exemptions use short names** (`outside-eu`, `inside-eu`, `no-document`); other Dougs values
  (sales exemptions, `nonApplicable`, …) are passed through verbatim.
- **Mirrors are null on split operations.** `category`, `vatRate`, … mirror the single main
  breakdown and are `null` when there are several; edits then need an explicit `breakdown` id.
- **JSON shapes:** list commands (`ops list`, `categories list`, `accounts list`, `todo`) print a
  JSON array; reports (`vat check`, `vat summary`, `receipts match`, `close-check`, `apply`, `rules
  apply`) print an object with `meta` plus sections. Errors are a single JSON line on stderr.
- `todo` items carry `suggestion` steps **without ids**; they become a plan with `--plan`.

## API behaviour

- **Listing is newest-first per validation status**, verified live across all pages. We page each
  list (`validated=true|false`) independently and stop as soon as a page ends before `--from` or
  once `--limit` matches are certain. A page that is not date-sorted disables early stopping.
- **Filtering is local.** `q-date=YYYY-MM` is *not* a strict month filter: checked live against a
  full fetch, it returned hundreds of operations from other months for every month tried (it
  appears to match other fields too). `q` text search missed obvious matches. So
  `--from/--to/--search` are applied client-side, and early-stopping pagination does the
  narrowing instead.
- **401 vs 403.** 401 means the session is gone (exit 3). 403 is also returned for endpoints the
  user may not access with a valid session, so it maps to `FORBIDDEN` (exit 5) — after one
  transparent browser-cookie refresh when the credential came from a browser.
- **VAT rate edits are computed client-side.** The web app has no "change rate and let the server
  recompute" path: its VAT field sends `vatAmount` + `manualVatAmount` directly (rates come from
  the category). We compute the amount from the gross (`gross − gross / (1 + rate)`) and send the
  full breakdown exactly like the web app — only `vatAmount` and `manualVatAmount` changed (only
  `manualVatAmount` for a foreign-currency breakdown), plus the rate and a cleared exemption; the
  recoverable-VAT fields are sent unchanged for Dougs to recompute. The re-read checks the VAT
  amount, and the side-effect diff covers HT and recoverable VAT too.
- **Memo edits** send the whole operation with the unchanged main breakdown as
  `updatedBreakdown`, like the reference scripts (the web app omits it; the server accepts both).
- **Validation** is the same update call with `validated: true` — there is no separate endpoint.
- Every write is followed by a re-read; a 200 that changed nothing is reported as `VERIFY_FAILED`.
- **Never `?force=true`.** The web app only sends it after a locked-ledger error, for accountants,
  after a confirmation dialog: it unlocks the ledger. The CLI refuses `manuallyLocked` /
  `lockedByDate` operations with `LOCKED` (exit 5) in previews and at apply time, and maps the
  server's locked response to the same error. There is no unlock flag in v0.1.
- **Side effects are reported.** After each write the whole operation (every breakdown, memo,
  validation, attachments) is compared before/after; changes the step did not ask for are listed
  as `sideEffects` (e.g. Dougs un-validating an edited operation), and the command **exits 7**,
  so an agent that only checks exit codes still notices. A `VERIFY_FAILED` step also lists what
  the write did change.
- **Partial writes are visible.** If the VAT-exemption second pass is impossible, the first pass is
  rolled back; if anything still changed when a step fails, it fails as `PARTIALLY_APPLIED` and
  its `changes` list what was saved.
- **Validation** is refused (`NOT_VALIDATABLE`, exit 2) when Dougs would show errors.
- **Filed periods are protected.** `set`, `validate` and `detach` steps on operations in a period
  covered by a filed VAT return (monthly/quarterly CA3, annual CA12, any `vat:*` declaration) or
  in a closed accounting year are refused (`FILED_PERIOD`, exit 2) and left out of generated plans
  unless `--allow-filed-periods`. `LOCKED` applies to the same three actions. *Deviation:*
  `attach` stays allowed in both cases: adding a justifying document changes no accounting line,
  attaching late invoices to past months is the core of `receipts match`, and any server-side
  reaction would show as a side effect. Detach is guarded because removing the only invoice behind
  VAT already deducted on a filed return undermines that deduction. If the period list cannot be
  loaded, guarded mutations fail closed (`PERIODS_UNKNOWN`); attach-only runs never load it.
- **Concurrent 401s share one refresh.** All requests that hit 401/403 await a single browser
  cookie refresh and retry once with the new session; a later 401 is not retried with the same
  refreshed session.
- **`vat check` counts fixes as a plan would hold them** (filed periods excluded) even without
  `--plan`. `rules apply` has no `--include-warnings` (rules have no weak fixes).
- **Keychain reads time out after 15 s.** *Deviation:* the review suggested skipping the
  transparent refresh when stdin is not a terminal. A timeout keeps the useful case (an
  already-authorized keychain item refreshes silently for agents) while guaranteeing a prompt
  nobody answers cannot hang a run.

## Plans and apply

- `expect` records only the fields a step touches (category, plus VAT fields for VAT steps,
  memo for memo steps, `validated` for validation), so attaching a receipt or validating an
  operation between planning and applying doesn't void an unrelated VAT fix. Fields the step
  itself changes may also hold the step's target (or an intermediate value), so a half-applied
  step resumes instead of being reported as "changed by someone else".
- A step whose expectation no longer holds gets status `conflict` (not `skipped`), and `apply`
  exits 7 so agents can tell "already done" from "not done because something changed".
- Attach paths in plan files are **relative to the plan file**, so a plan and its documents can be
  moved together. Attach steps need no `expect`; the same file name already attached = satisfied.
- Single-op commands (`ops set/attach/detach/validate`) build an in-memory plan and run it through
  the same executor; a single failing step keeps its own exit code, several use exit 7.

## Workflows

- **`todo` is cheap** (no document downloads) so it can run every morning; document-based VAT
  checks live in `vat check` and `close-check`.
- **Document evidence prefers Dougs' own invoice reading** (`GET /vendor-invoices/{id}`: supplier
  country, VAT amount, reverse-charge code `AE`) and falls back to PDF text extraction.
- **The invoice beats the vendor list.** Billing entities vary by customer region, so a document's
  supplier country wins over the built-in registry, which is only used without a document.
- **Fixes need strong evidence.** Severity `error` with a plannable fix only for Dougs'
  reverse-charge code `AE`, an explicit reverse-charge invoice with 0 VAT, or a vendor from the
  user's rules file. Other suspects are warnings; their fixes are planned only with
  `--include-warnings`, and the PDF VAT-number heuristic alone never produces a fix.
- **An invoice that charges VAT is authoritative**: a foreign supplier whose invoice shows VAT
  (e.g. an EU company registered for French VAT) is not flagged as reverse charge.
- **Invoice VAT is only compared when the invoice total equals the operation amount**: one
  invoice often covers several bank lines (and vice versa).
- **`MISSING_RECEIPT` over 150 €** is severity `error` with `evidence.invoiceRequired: true`
  rather than a separate code, so agents filtering on the code see every missing receipt.
- **`close-check --year`** uses the Dougs accounting year that closes in that year when one
  exists, otherwise the calendar year.
- **`vat summary`** compares with Dougs' figures in whole euros: the filed return (the latest one
  when there is a corrective return), or Dougs' own draft for open months. It reports the
  declaration status, due date and lateness. Box 22 is box 27 of the last *filed* return, as in
  Dougs' drafts (unfiled drafts don't chain); the chained projection from an unfiled previous
  month is given as a note only. Refund breakdowns reverse VAT of the opposite
  flow; only recoverable VAT is counted as deductible. Reverse-charge purchases are self-assessed
  at 20 %.
- **Overdue declarations** (Dougs `isLate`, not filed) are `OVERDUE_DECLARATION` items at the top
  of `todo` (with `op: null` and a `declaration`) and findings in `close-check`.
- **`rules apply` defaults to unvalidated operations**; `--include-validated` or `--validated`
  widen it. Filed-period protection applies on top.
- **`receipts download`** skips a file that already exists with a non-zero size (the API does not
  expose remote sizes without downloading).
- **Rules: first match wins**; only fields that differ produce a plan step. `rules init` keeps
  merchants seen at least twice whose category agrees in ≥ 80 % of validated operations.

## Security

- **Uploads from plans are constrained.** A plan may come from an agent or a shared file, so an
  `attach` step may only upload `.pdf .png .jpg .jpeg .heic .webp` files, resolved with `realpath`
  (symlinks followed), and only from the plan's directory or the current directory unless
  `--allow-any-path` is given. A plan with any disallowed upload is refused as a whole before
  anything is written. Previews and the confirmation prompt show each file's absolute path.
- **Uploads are read once.** At apply time the file is resolved (realpath, extension, folder),
  opened with `O_NOFOLLOW` and checked to be the same inode, and those bytes are uploaded with a
  MIME type — the path is never re-read later (no check/use race).
- **CSV export neutralizes formulas**: text columns (wording, memo, category, category_group)
  starting with `= + - @`, tab or CR get a leading `'`. Numbers stay numbers; JSON is untouched.
- **No terminal escapes from data.** All human output (tables, key/values, errors, prompts,
  progress) is stripped of C0/C1 control characters. Our own colours use a per-process random
  marker that is turned into ESC only after sanitizing, so data cannot forge them. JSON output is
  never altered.

## Housekeeping

- The User-Agent and package metadata point to the GitHub repository (created before publishing).
- FakeDougs marks each modelled server behaviour as OBSERVED or ASSUMED; tests against assumed
  behaviour are not evidence of how Dougs behaves.
- Plan files are written 0600 like reports: they contain wordings and amounts.
- A failed PDF extraction is not cached, so it is retried next time.
- `npm publish` runs `npm run check` first (`prepublishOnly`).
- `node:sqlite` is loaded lazily (only for `login --from-browser` and cookie refresh) with its
  Node 22 experimental warning suppressed, so other commands keep stderr clean.
