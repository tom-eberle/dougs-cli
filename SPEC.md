# dougs-cli — specification (v0.1)

Unofficial command-line client for [Dougs](https://www.dougs.fr), the French online
accounting platform. Built for **humans and AI agents** to run the recurring
bookkeeping workflows that take hours in the web UI — matching receipts, fixing VAT,
categorising, pre-closing checks — in minutes, safely.

> Not affiliated with or endorsed by Dougs. Uses the same private HTTP API as the
> Dougs web app, which may change without notice.

---

## 1. Design principles (borrowed from wrangler, gh, stripe, superwall)

1. **Workflows first, CRUD second.** Top-level commands map to real accounting jobs
   (`todo`, `receipts match`, `vat check`, `rules apply`, `close-check`). Raw
   resource commands (`ops get/set/attach`) exist as building blocks.
2. **Plan → review → apply.** Every bulk mutation is a two-step process:
   `dougs <workflow> --plan plan.json` writes a declarative, human-readable plan;
   `dougs apply plan.json` executes it. Plans are the contract between an agent that
   proposes and a human/agent that approves. Single-op mutations support
   `--dry-run` and the same diff output.
3. **Machine-readable by default when piped.** stdout carries data only; logs,
   progress and spinners go to stderr. `--json` forces JSON; JSON is automatic when
   stdout is not a TTY. `--jsonl` streams list output one object per line.
4. **Never hang an agent.** No interactive prompt when stdin/stdout isn't a TTY.
   A mutation that would ask for confirmation in a TTY instead exits with code 2 and
   a hint (`re-run with --yes`). No pagers.
5. **Structured, actionable errors.** In JSON mode, errors go to stderr as
   `{"error":{"code":"AUTH_EXPIRED","message":"…","hint":"run: dougs login --from-browser chrome","status":401}}`.
   Stable exit codes (§6).
6. **Self-describing.** Every command's `--help` has 1–3 real examples.
   `dougs commands --json` dumps the full command tree (names, args, flags, types,
   descriptions). `dougs schema <type>` prints the JSON Schema of each output type.
   The repo ships `AGENTS.md` and an agent skill (`skills/dougs/SKILL.md`).
7. **Stable normalized output.** Commands return normalized objects (§5) validated
   by zod schemas, not raw API blobs. `--raw` returns the untouched API payload.
8. **Escape hatch.** `dougs api <METHOD> <path>` (like `gh api`) for anything not
   wrapped yet, with `{company}` placeholder substitution and auth handled.
9. **Idempotent and resumable.** Re-running `apply` on a partially-applied plan
   skips steps already satisfied (checks current state before each write).
10. **Polite.** Honest `User-Agent: dougs-cli/<version> (+repo url)`; max 4 concurrent
    requests; retries with exponential backoff only for GET and only on 429/5xx/network.
11. **Secrets never leak.** The session cookie is redacted in `--verbose` logs,
    errors and plan files.

## 2. Stack

- TypeScript (strict), ESM, Node **≥ 22.13** (uses built-in `fetch` and `node:sqlite`).
- Runtime deps kept minimal: `commander`, `zod` (v4, for `z.toJSONSchema`), a PDF
  text extractor (`unpdf` or `pdfjs-dist`). Tables/colours hand-rolled or tiny deps.
- Build with `tsup` (single ESM bundle, `bin: { dougs: dist/cli.js }`).
- Tests: `vitest`, HTTP via an injectable fetch + **synthetic** fixtures.
- Lint/format: `biome`. CI: GitHub Actions on Node 22 and 24 (lint, typecheck, test, build).
- License MIT. Package name `dougs-cli`, binary `dougs`.

## 3. Auth, config, profiles

- `dougs login --from-browser <chrome|brave|edge|arc>` — reads the `auth_session`
  cookie for `app.dougs.fr` from the browser's cookie DB (macOS first: keychain
  "<Browser> Safe Storage" → PBKDF2-SHA1 1003 iters → AES-128-CBC, IV = 16 spaces,
  `v10` prefix; newer DB versions prepend a 32-byte SHA-256 of the host to the
  plaintext — strip it). Searches all browser profiles, picks the freshest.
  Linux (`peanuts` / libsecret) best-effort; Windows: not supported in v0.1, use
  `--with-token`.
- `dougs login --with-token` — reads the cookie value from stdin (like `gh auth login --with-token`).
- `DOUGS_SESSION` env var overrides stored credentials (CI/agents).
- On a 401/403 when the credential came from a browser, transparently re-read the
  browser cookie once before failing (sessions rotate).
- Config at `$XDG_CONFIG_HOME/dougs-cli/config.json` (default `~/.config/…`), file
  mode 0600: `{ profiles: { default: { session, source, companyId } }, activeProfile }`.
- `--profile <name>` / `DOUGS_PROFILE`; `--company <id>` / `DOUGS_COMPANY`; if a user
  has exactly one company it is selected automatically.
- `dougs logout`, `dougs whoami` (user + companies + active company + auth source).
- `DOUGS_API_BASE` overrides `https://app.dougs.fr` (tests only).

## 4. Commands

### 4.1 Workflows (the reason this tool exists)

**`dougs todo [--from] [--to] [--limit]`** — the morning worklist. One list of
everything that needs a human/agent, each item with a machine-readable `reason`
and, where possible, a `suggestion`:
- `MISSING_RECEIPT` — expense with no attachment (flag `>150 €` separately: a full
  invoice is mandatory, a till receipt isn't enough).
- `UNCATEGORIZED` — breakdown with `categoryId = -1`.
- `UNVALIDATED` — operation not yet validated in Dougs.
- `VAT_SUSPECT` — see `vat check` rules.
- `RULE_MATCH` — a local rule (§4.1 rules) would change this op.
Human output: grouped table with counts per reason. JSON: array of
`{ op: Operation, reasons: [{code, detail}], suggestion?: PlanStep[] }`.

**`dougs receipts match <files or dirs…> [--from] [--to] [--plan out.json]`** —
match local PDFs/images (e.g. invoices exported from email) to operations.
Extract text from each PDF, detect total amount(s), date(s), vendor/merchant names
and VAT numbers; score candidate operations by amount equality (exact cents, also
try HT/TTC and currency-converted totals within ±2 %), date proximity (−10/+40 days),
and vendor-name similarity with the bank wording. Output per file: best match +
score + runner-ups; unmatched files and ambiguous matches reported separately.
`--plan` writes `attach` steps for confident matches only (threshold configurable,
`--min-score`). Files already attached to the target op (same filename) are skipped.
Uploaded filename strips a leading `{digits}_` prefix (Dougs displays the upload name).

**`dougs vat check [--from] [--to] [--plan out.json]`** — VAT audit. Rules:
- amount TTC ≠ HT + VAT (> 0.01 € off).
- rate not in {0, 2.1, 5.5, 10, 20}.
- **Reverse-charge suspects**: supplier known (vendor registry, §4.4) or detected
  (attached PDF shows a non-FR VAT number / "reverse charge" / "autoliquidation" /
  0.00 VAT) as foreign, but Dougs booked deductible French VAT → suggest
  `set vat-exempt outside-eu|inside-eu`. (Real recurring issue: Dougs auto-books US
  SaaS like Cloudflare at 20 % deductible VAT.)
- zero-VAT expense without `vatExemptionReason`.
- PDF VAT amount ≠ Dougs VAT amount (when a PDF is attached; uses cached text extraction).
`--plan` writes fix steps for the unambiguous cases.

**`dougs vat summary --month YYYY-MM`** — preview of the monthly CA3 numbers computed
from operations (collected VAT by rate, deductible VAT on goods/services, reverse-charge
bases intra-EU / extra-EU and the self-assessed VAT, net due or credit). Explicitly
labelled an estimate. If a Dougs endpoint exposes the actual declaration draft, show
it side by side and highlight differences.

**`dougs rules apply [--rules dougs.rules.json] [--unvalidated-only] [--plan out.json]`**
— local, versionable categorisation rules, stronger than Dougs' own:
```json
{ "rules": [
  { "match": { "wording": "CLOUDFLARE", "direction": "expense" },
    "set": { "category": 77, "vatExempt": "outside-eu" } },
  { "match": { "wording": "/HETZNER/i" },
    "set": { "category": 77, "vatExempt": "inside-eu" } } ] }
```
Match keys: `wording` (substring or `/regex/flags`), `direction`, `amountMin/Max`,
`account`. Set keys: `category`, `vatRate`, `vatExempt`, `memo`. Produces a plan;
only ops whose current state differs get a step. `dougs rules init` writes a starter
file inferred from history (most frequent category + VAT treatment per normalized
merchant over validated ops).

**`dougs close-check --year YYYY`** — pre-closing report: missing receipts (and
>150 € without invoice), uncategorised, unvalidated, VAT suspects, possible
duplicates (same amount ±3 days, same merchant), attachments whose PDF amount
disagrees. Exit code 0 even with findings; summary counts in JSON `meta`.

**`dougs apply <plan.json> [--yes] [--dry-run]`** — execute a plan (§5.3). Shows
the before→after diff per step; in a TTY asks once for confirmation; non-TTY needs
`--yes`. Re-reads each op before writing; skips already-satisfied steps; stops at
the first error unless `--continue-on-error`; prints a result report
(`applied | skipped | failed` per step) usable as an audit log (`--report out.json`).

### 4.2 Resources (building blocks)

- `dougs ops list [--validated|--unvalidated] [--from] [--to] [--search <text>]
  [--missing-receipt] [--category <id>] [--expense|--income] [--limit N (default 50)]
  [--all]` — paginates the API (page size 40) transparently.
- `dougs ops get <id> [--raw]`
- `dougs ops set <id…> [--category <id>] [--vat-rate <r>] [--vat-exempt
  outside-eu|inside-eu|no-document] [--memo <text>] [--dry-run] [--yes]`
  — implemented on top of the same step executor as `apply`.
- `dougs ops attach <id> <file…> [--name <display name>]` / `dougs ops detach <id> <attachmentId>`
- `dougs ops validate <id…>` — only if the endpoint is found (§7).
- `dougs ops download <id> [-o dir]` — download the op's attachments.
- `dougs receipts download [--from] [--to] [-o dir]` — bulk download, files named
  `{opId}_{filename}`, skip files already present (by name + size).
- `dougs categories list [--search]` — id, name, parent path (needed by agents for `--category`).
- `dougs accounts list` — bank accounts and balances.
- `dougs export [--from] [--to] [--format csv|json|jsonl] [-o file]` — flat
  transaction export: date, wording, amount_ttc, amount_ht, vat, vat_rate,
  is_expense, category, category_group, memo, validated, has_receipt, dougs_id.
- `dougs api <METHOD> <path> [-d @file|-|json] [-F key=value…] [--raw]`
- `dougs commands --json`, `dougs schema <operation|plan|todo-item|…>`
- `dougs doctor` — auth OK? API reachable? Fetch a sample of ops and validate them
  against the raw zod schema; report unknown/missing fields (early warning that
  Dougs changed its API).

Global flags: `--json`, `--jsonl`, `--profile`, `--company`, `--verbose` (HTTP log to
stderr, cookie redacted), `--quiet`, `--no-color` (and `NO_COLOR`), `--version`.

### 4.3 Caching
`~/.cache/dougs-cli/<company>/`: extracted PDF text keyed by file id (immutable),
categories list (24 h TTL). `--no-cache` bypasses. Never cache sessions there.

### 4.4 Vendor registry
Built-in small registry of common foreign SaaS suppliers and their establishment
(e.g. Cloudflare/Anthropic/OpenAI/Convex/Sentry/PostHog/RevenueCat/Resend/Expo/
OpenRouter → outside EU; Hetzner → inside EU; TikTok Information Technologies UK →
outside EU), overridable/extendable in the rules file under `"vendors"`. Matching is
on normalized bank wording.

## 5. Data contracts

### 5.1 Operation (normalized)
```ts
{ id: string, date: "YYYY-MM-DD", wording: string, amount: number /* signed? see impl note */,
  direction: "expense" | "income", validated: boolean, memo: string | null,
  account: { id, name } | null,
  breakdowns: [{ id, isCounterpart: boolean, category: { id, name, path: string[] } | null,
                 amount: number, amountExcludingVat: number, vatRate: number | null,
                 vatAmount: number, vatExemptReason: "outside-eu"|"inside-eu"|"no-document"|string|null }],
  // convenience mirrors of the single main (non-counterpart) breakdown:
  category, vatRate, vatAmount, amountExcludingVat, vatExemptReason,
  attachments: [{ id, fileId, filename, type /* vendorInvoice|unknown|… */ }],
  url: "https://app.dougs.fr/app/c/<company>/…" }
```
Document in `docs/schema.md`; amounts in EUR as numbers with 2 decimals.

### 5.2 Exit codes
0 ok · 1 unexpected · 2 usage / confirmation required · 3 auth missing/expired ·
4 not found · 5 rejected by API (4xx) · 6 network / 5xx after retries · 7 plan
partially failed.

### 5.3 Plan file
```json
{ "version": 1, "company": "<id>", "createdAt": "…", "createdBy": "dougs-cli 0.1.0 receipts match",
  "steps": [
    { "id": "s1", "op": "123", "action": "attach", "file": "./inbox/inv.pdf",
      "why": "amount 48.00 = op amount, date +1d, vendor 'Hetzner' in wording (score 0.97)" },
    { "id": "s2", "op": "456", "action": "set",
      "set": { "category": 77, "vatExempt": "outside-eu" },
      "expect": { "vatAmount": 8.0, "category": -1 },
      "why": "Cloudflare is established outside the EU; invoice shows 0.00 VAT" } ] }
```
Actions: `set`, `attach`, `detach`, `validate`. `expect` = state observed at plan
time; `apply` warns (and skips unless `--force`) if the op changed since.
Every step has a human-readable `why`. Plans are plain JSON so agents and humans can
edit them.

## 6. Known API behaviour (port faithfully)

Base `https://app.dougs.fr`, cookie `auth_session=<value>`, `Accept: application/json`.
- List: `GET /companies/{c}/operations?limit=40&offset=N&needsAttention=false&validated=true|false`
- Get: `GET /companies/{c}/operations/{op}`
- Update: `POST /companies/{c}/operations/{op}?force=true` with body = full operation,
  `breakdowns` patched, and `updatedBreakdown` = the patched breakdown. **The server
  reads the edit from `breakdowns`**; `updatedBreakdown` only flags which one changed.
  Sending only `updatedBreakdown` returns 200 and changes nothing — always verify by
  re-reading.
- Category change: set `categoryId`, `resolvedCategoryId`, `resolvedCategoryPath=[id]`,
  `isManuallyCategorized=true`. Uncategorised (`-1`) breakdowns have no
  `associations`, so set the category **before** any exemption.
- VAT exemption = **two passes**: (1) zero VAT: `manualVatAmount=0, vatAmount=0,
  vatAmountWithRecoverageRate=0, vatRate=null, isVatAmountManuallyModified=true,
  amountExcludingTaxesWithRecoverageRate=amount`; the response now contains a
  `vatExemptionReason` association; (2) set
  `associationData.vatExemptionReason` to `exemption:outbound:outsideEuropeanUnion`
  | `exemption:outbound:insideEuropeanUnion` | `exemption:outbound:noAccountingDocument`.
- Attach: `POST /companies/{c}/operations/{op}/source-document-attachments/actions/create-from-formdata`
  multipart, field `file` (repeatable). Classification is async (`type` goes
  `unknown` → `vendorInvoice`).
- Detach: `DELETE /companies/{c}/operations/{op}/source-document-attachments/{attachmentId}`
- Bind an existing vendor invoice: `POST /companies/{c}/vendor-invoices/{id}/actions/attach-operations {operationIds:[…]}`
- Vendor invoice: `GET /companies/{c}/vendor-invoices/{uuid}`
- File: `GET /files/{uuid}/actions/download` → redirect to signed S3 URL (follow it
  **without** sending the cookie to S3).
- Accounts: `GET /companies/{c}/accounts`

## 7. To discover (from the web app's JS bundle and live read-only calls)

Find and document in `docs/API.md` (endpoint, method, params, response shape —
**no real company data**): current user + list of companies; categories list;
validating an operation; VAT declaration drafts / history (for `vat summary`);
anything else that directly serves the workflows above. Unknown → leave the command
out and list it in `docs/API.md` under "Not yet supported".

## 8. Testing & data hygiene (public repo from day one)

- Unit tests for: cookie decryption (with a generated test vector), normalization,
  plan diff/apply logic (mock fetch, including the two-pass exemption and
  idempotent re-apply), receipt scoring, VAT rules, rules matching, exit codes, JSON
  error format, non-TTY confirmation refusal.
- Fixtures are **synthetic**: invented company id (e.g. `999999`), fake merchants,
  fake op ids, fake amounts. Never copy real API responses, real company ids, VAT
  numbers, IBANs, names, emails or cookies into the repo.
- `npm test` must pass offline.

## 9. Repo layout
```
src/cli.ts                 commander wiring, global flags, output mode
src/commands/*.ts          one file per command group
src/api/client.ts          fetch wrapper, auth, retries, errors, pagination
src/api/schemas.ts         zod: raw API + normalized types
src/auth/browser-cookies.ts
src/plan/{types,diff,apply}.ts
src/workflows/{todo,receipts,vat,rules,close-check}.ts
src/pdf/extract.ts
src/output/{format,table,errors}.ts
test/…  fixtures/…  docs/{API.md,schema.md}  skills/dougs/SKILL.md
AGENTS.md  README.md  CHANGELOG.md  LICENSE  SPEC.md
```

## 10. Out of scope for v0.1
Password/2FA login, Windows cookie decryption, MCP server mode, app-store revenue
ventilation (Apple/Google EU vs non-EU split — planned v0.2), filing anything with
the tax administration.
