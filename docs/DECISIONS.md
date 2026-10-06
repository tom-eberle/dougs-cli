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
  the category). We compute the amount from the gross (`gross − gross / (1 + rate)`), send it the
  same way plus the rate, and verify the resulting VAT amount on re-read.
- **Memo edits** send the whole operation with the unchanged main breakdown as
  `updatedBreakdown`, like the reference scripts (the web app omits it; the server accepts both).
- **Validation** is the same update call with `validated: true` — there is no separate endpoint.
- Every write is followed by a re-read; a 200 that changed nothing is reported as `VERIFY_FAILED`.

## Plans and apply

- `expect` is checked per field. Fields the step itself changes may also hold the step's target
  (or an intermediate value), so a half-applied step (e.g. VAT zeroed but no exemption reason yet)
  resumes instead of being reported as "changed by someone else".
- Attach paths in plan files are **relative to the plan file**, so a plan and its documents can be
  moved together. Attach steps need no `expect`; the same file name already attached = satisfied.
- Single-op commands (`ops set/attach/detach/validate`) build an in-memory plan and run it through
  the same executor; a single failing step keeps its own exit code, several use exit 7.

## Workflows

- **`todo` is cheap** (no document downloads) so it can run every morning; document-based VAT
  checks live in `vat check` and `close-check`.
- **Document evidence prefers Dougs' own invoice reading** (`GET /vendor-invoices/{id}`: supplier
  country, VAT amount, reverse-charge code `AE`) and falls back to PDF text extraction.
- **An invoice that charges VAT is authoritative**: a foreign supplier whose invoice shows VAT
  (e.g. an EU company registered for French VAT) is not flagged as reverse charge.
- **Invoice VAT is only compared when the invoice total equals the operation amount**: one
  invoice often covers several bank lines (and vice versa).
- **`MISSING_RECEIPT` over 150 €** is severity `error` with `evidence.invoiceRequired: true`
  rather than a separate code, so agents filtering on the code see every missing receipt.
- **`close-check --year`** uses the Dougs accounting year that closes in that year when one
  exists, otherwise the calendar year.
- **`vat summary`** compares against the filed CA3 (whole euros) only for months Dougs has filed;
  open months have no figures server-side. Box 22 comes from the previous filed month's box 27.
  Reverse-charge purchases are self-assessed at 20 %.
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
- **CSV export neutralizes formulas**: text columns (wording, memo, category, category_group)
  starting with `= + - @`, tab or CR get a leading `'`. Numbers stay numbers; JSON is untouched.
- **No terminal escapes from data.** All human output (tables, key/values, errors, prompts,
  progress) is stripped of C0/C1 control characters. Our own colours use a per-process random
  marker that is turned into ESC only after sanitizing, so data cannot forge them. JSON output is
  never altered.

## Housekeeping

- The User-Agent links to the npm package page until a public repository URL exists.
- `node:sqlite` is loaded lazily (only for `login --from-browser` and cookie refresh) with its
  Node 22 experimental warning suppressed, so other commands keep stderr clean.
