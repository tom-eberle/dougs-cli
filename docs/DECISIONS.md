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
- **Filtering is local.** The server's `q-date` only supports a month or a single day, and `q`
  text search missed obvious matches, so `--from/--to/--search` are applied client-side.
- **401 vs 403.** 401 means the session is gone (exit 3). 403 is also returned for endpoints the
  user may not access with a valid session, so it maps to `FORBIDDEN` (exit 5) — after one
  transparent browser-cookie refresh when the credential came from a browser.
- **VAT rate edits** mirror the web app's VAT edit (`vatAmount` + `manualVatAmount`, computed from
  the gross amount) and also send the rate; verification checks the resulting VAT amount.
- **Memo edits** send the whole operation without `updatedBreakdown`, as the web app does.
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

## Housekeeping

- The User-Agent links to the npm package page until a public repository URL exists.
- `node:sqlite` is loaded lazily (only for `login --from-browser` and cookie refresh) with its
  Node 22 experimental warning suppressed, so other commands keep stderr clean.
