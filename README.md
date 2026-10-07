# dougs-cli

**An unofficial command-line client for [Dougs](https://www.dougs.fr), the French online
accounting platform — for humans and AI agents.**

It turns the bookkeeping chores that take hours in the web UI — matching receipts, fixing VAT,
categorising, pre-closing checks — into commands that take minutes, with every bulk change
proposed as a reviewable plan first.

> [!IMPORTANT]
> **Not affiliated with, endorsed by or supported by Dougs.** dougs-cli uses the same private
> HTTP API as the Dougs web app, with your own session. That API is undocumented and may change
> at any time; `dougs doctor` tells you when it has. You remain responsible for your accounts:
> review plans before applying them, and keep your accountant in the loop. Nothing here is tax
> advice, and the CLI never files anything with the tax administration.

```text
$ dougs todo
Missing receipt (3, 1 over 150 € need a full invoice)
ID     DATE        WORDING               AMOUNT  DETAIL
10007  2026-08-28  CB FICTIONAL CAMERA  -389.00  no document; 389.00 € > 150 € needs a full invoice
10004  2026-08-14  CB PAPER CO           -12.00  no document for a 12.00 € expense
…
VAT to check (1)
10003  2026-08-09  FICTICLOUD INC        -24.00  4.00 € of deductible French VAT booked, but … [fix]

5 items need attention: 3 missing receipts · 1 uncategorized · 1 VAT to check
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/architecture-dark.png">
  <img alt="dougs-cli runs on your computer: workflows read from Dougs, the plan engine writes through the same API client, using the session you logged in with" src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/architecture-light.png">
</picture>

*Everything runs locally: workflows only read, every write goes through the plan engine, and your session stays in your OS keychain.*

## Install

Requires **Node.js 22.13 or newer**.

```sh
npm install -g dougs-cli
dougs --version
```

## 60-second quickstart

```sh
# 1. Log in with your Dougs email and password (and your 2FA code, if you use one).
dougs login

# 2. Check everything works.
dougs whoami
dougs doctor

# 3. See what needs attention.
dougs todo

# 4. Look at operations.
dougs ops list --unvalidated --limit 20
dougs ops get 10001
```

## Logging in

| | |
|---|---|
| `dougs login` | The default. Asks for your email, your password (not echoed) and, when your account has two-factor authentication, the code from your authenticator app or the one Dougs emails you. |
| `dougs login --from-browser chrome` | Reuse the session of a browser where you are logged in to app.dougs.fr (also `brave`, `edge`, `arc`; macOS, Linux best effort). The only way for accounts that sign in with Google. Such sessions refresh themselves from the browser. |
| `pbpaste \| dougs login --with-token` | Paste the `auth_session` cookie value copied from your browser's dev tools. |
| `dougs login --email you@example.com < password.txt` | Scripts: the password comes from stdin. If Dougs asks for a second factor it stops with `MFA_NEEDS_TERMINAL`. |
| `DOUGS_SESSION=… dougs …` | CI and sandboxes: nothing is stored. |

Your password goes only to Dougs and is never stored; only the session that comes back is kept,
in the **macOS Keychain**, or the **Secret Service** on Linux (through libsecret's `secret-tool`).
Without one (Windows, containers, or `DOUGS_CREDENTIAL_STORE=file`) it goes in the config file
with mode 0600, and `dougs login` says so. Sessions saved by earlier builds move to the OS store
on first use.

`dougs whoami` shows when the session expires, `dougs doctor` warns a week before and fails once
it has, and `dougs login --check` exits 0 (valid) or 3 (missing or expired) without printing
anything, for scripts and agents to call before long runs. `dougs logout` forgets the session;
`dougs logout --remote` also ends it on Dougs.

## Workflows

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/monthly-routine-dark.png">
  <img alt="The monthly routine: dougs todo, receipts match, vat check, rules apply, dougs apply, vat summary, then file the VAT return in Dougs" src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/monthly-routine-light.png">
</picture>

*A typical month: find what is missing, propose fixes as plans, apply them, then check the VAT figures before filing in Dougs.*

Every workflow that changes data works the same way: **propose → review → apply**.

```sh
dougs <workflow> … --plan fixes.plan.json   # writes a plain-JSON plan, changes nothing
less fixes.plan.json                         # each step says what changes and why
dougs apply fixes.plan.json --dry-run        # re-reads each operation, shows before → after
dougs apply fixes.plan.json                  # asks once, writes, verifies every change
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/safety-loop-dark.png">
  <img alt="A workflow proposes a plan file; you review it; dougs apply checks guard-rails before writing each step to Dougs, then re-reads and verifies it" src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/safety-loop-light.png">
</picture>

*Nothing changes until you apply a reviewed plan, and each step is checked before and verified after it is written.*

`apply` is idempotent: steps already done are skipped, so re-running a half-applied plan file is safe.
If an operation changed since the plan was made, its step is a `conflict` (exit 7) unless you pass
`--force`. After every write the operation is re-read: anything else Dougs changed is reported as
a side effect.

Guard-rails on every change:

- **Validated operations are reopened, edited and validated again**, as the Dougs web app does
  (Dougs refuses direct edits to them). Both steps appear in the report. If a run is interrupted
  in between, re-running the same plan file validates the operation again; after a single
  command, run `dougs ops validate <id>` (the error says so).
- **Locked operations are never edited, validated or detached** (`LOCKED`); dougs-cli never asks
  Dougs to unlock a ledger. Attaching a receipt stays allowed.
- **Filed periods are protected**: edits, validations and detaches in a period whose VAT return is
  filed, or in a closed year, are refused and left out of plans unless `--allow-filed-periods`.
- **Side effects exit 7**: if Dougs changes anything the step did not ask for, it is listed in
  the report and the command exits 7.
- **Validation is refused** when Dougs would show errors on the operation.
- **Fixes need strong evidence**: plans only include VAT fixes backed by Dougs' reverse-charge
  code, an explicit reverse-charge invoice, or a vendor in your rules file; add
  `--include-warnings` for the rest after reviewing them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/write-sequence-dark.png">
  <img alt="Sequence of one apply step on a validated operation: read, check guard-rails, reopen, save, set the VAT exemption reason, validate again, read back" src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/write-sequence-light.png">
</picture>

*One step on an operation Dougs already validated: reopen, edit, validate again, then read it back to catch side effects.*

Plans are data, so they are treated as untrusted: an `attach` step can only upload receipt files
(`.pdf .png .jpg .jpeg .heic .webp`) from the plan's directory or the current directory, and the
preview and confirmation list the absolute path of every file that would be uploaded. Use
`--allow-any-path` only for plans you wrote or trust.

### The morning worklist — `dougs todo`

One list of everything that needs a human: overdue declarations first, then missing receipts
(with the 150 € full-invoice rule),
uncategorized and unvalidated operations, VAT suspects and operations your local rules would
change. Fast enough to run daily (it never downloads documents).

```sh
dougs todo                       # grouped tables
dougs todo --from 2026-07-01 --json
dougs todo --plan todo.plan.json # the fixable items, as a plan
```

### Match invoices to bank lines — `dougs receipts match`

Point it at a folder of PDFs (e.g. invoices exported from email). It reads each document's
totals, dates and supplier name, and scores operations by exact amount (TTC, HT, or the
original foreign-currency amount), date proximity (−10 to +40 days) and vendor name.

```sh
dougs receipts match ./inbox
dougs receipts match ./inbox --plan receipts.plan.json   # confident matches only (--min-score, default 0.8)
dougs apply receipts.plan.json
```

Only operations **without** a document are targets by default (`--include-attached` to widen);
files whose best match already has a document are reported as excluded. A file already attached
(same name, or the same invoice/receipt number, e.g. `Invoice-0042.pdf` vs `Receipt-0042.pdf`) is
skipped. A file named `<opId>_name.pdf` — what `receipts download` writes — goes to that
operation or is skipped, never anywhere else; the prefix is stripped from the name Dougs shows. A
date in the file name is taken as the document's date and must be within a few days of the
operation. Ambiguous and unmatched files are listed separately with their candidates. Scanned PDFs and images without a text layer are matched by file name only
(e.g. `2026-08-02_nimbus_48.00.pdf`).

### Audit VAT — `dougs vat check`

```sh
dougs vat check --from 2026-07-01 --to 2026-08-31
dougs vat check --from 2026-01-01 --plan vat.plan.json
```

Rules: TTC ≠ HT + VAT; rates other than 0/2.1/5.5/10/20 %; **reverse-charge suspects** — a
foreign supplier booked with deductible French VAT (Dougs regularly does this for US SaaS);
exemptions recorded with the wrong zone; zero VAT without an exemption reason; invoice VAT that
differs from the booked VAT.

Supplier origin comes from a built-in registry of common foreign SaaS (extendable in your rules
file), from Dougs' own reading of the attached invoice (supplier country, VAT, reverse-charge
code) and, as a fallback, from the PDF text (VAT numbers, "reverse charge", "autoliquidation").
An invoice that itself charges VAT always wins. Fixes are only planned when unambiguous.

### Preview the monthly return — `dougs vat summary`

```sh
dougs vat summary --month 2026-08
```

Estimates the CA3 boxes from operations — collected VAT by rate, reverse-charge bases (EU and
non-EU) and the self-assessed VAT, deductible VAT on goods/services and fixed assets, credit or
amount due. Dougs' own figures are shown side by side with the differences: the filed return, or
Dougs' draft for a month that is still open, together with its due date and whether it is
overdue. It is an estimate, clearly labelled as such.

### Your own categorisation rules — `dougs rules`

`dougs.rules.json` is a small, versionable file of rules stronger than Dougs' auto-categorisation:

```json
{
  "rules": [
    { "match": { "wording": "FICTICLOUD", "direction": "expense" },
      "set": { "category": 77, "vatExempt": "outside-eu" } },
    { "match": { "wording": "/NIMBUS HOSTING/i" },
      "set": { "category": 77, "vatExempt": "inside-eu" } },
    { "match": { "amountMin": 1000, "account": "Main" }, "set": { "memo": "Check the contract" } }
  ],
  "vendors": [{ "name": "Ficticloud", "match": "FICTICLOUD", "zone": "outside-eu" }],
  "noReceiptCategories": [153]
}
```

Match on `wording` (substring, or `/regex/flags`), `direction`, `amountMin`/`amountMax`,
`account`; set `category`, `vatRate`, `vatExempt`, `memo`. `vatExempt` is why a line has no
French VAT (on a sale: `outside-eu`, `inside-eu` or `not-applicable`); for purchases: `outside-eu`, `inside-eu`, `outside-eu-not-imported`, `not-applicable` (the supplier
charges no VAT, e.g. a micro-entrepreneur: "TVA non applicable, art. 293 B CGI") or
`no-document`. First match wins; only operations that
differ get a step.

```sh
dougs rules init                                   # infer a starter file from your validated history
dougs rules apply --plan rules.plan.json             # unvalidated operations by default
dougs categories list --search logiciel            # find category ids
```

### Before closing the year — `dougs close-check`

```sh
dougs close-check --year 2025
```

Missing receipts (and > 150 € without an invoice; transfers between your accounts, capital, loans,
subsidies, FX and tax settlements are skipped unless `--strict`), uncategorized and unvalidated operations, VAT
suspects, possible duplicates and attached documents whose total does not match. Uses the Dougs
accounting year that closes in that year (else the calendar year). Exit code 0 even with
findings; counts are in the JSON `meta`.

## Building blocks

| Command | |
|---|---|
| `dougs ops list` | `--validated/--unvalidated`, `--from/--to`, `--search`, `--missing-receipt`, `--category`, `--expense/--income`, `--limit` (50) / `--all`, `--raw` |
| `dougs ops get <id>` | One operation with breakdowns and documents (`--raw` for the API object) |
| `dougs ops set <id…>` | `--category`, `--vat-rate`, `--vat-exempt outside-eu\|inside-eu\|outside-eu-not-imported\|not-applicable\|no-document`, `--memo`, `--dry-run`, `--yes` |
| `dougs ops attach <id> <file…>` / `ops detach <id> <attachmentId>` | Upload or remove documents |
| `dougs ops validate <id…>` | Mark as validated |
| `dougs ops download <id>` / `receipts download` | Save documents as `<opId>_<filename>`, skipping existing files |
| `dougs categories list`, `dougs accounts list` | Reference data |
| `dougs export` | Flat CSV/JSON/JSONL export (date, wording, amounts, VAT, category, receipt, id) |
| `dougs api <METHOD> <path>` | Any endpoint, authenticated, `{company}` substituted (like `gh api`) |
| `dougs commands --json`, `dougs schema <type>` | Machine-readable command tree and JSON Schemas |
| `dougs doctor` | Auth, reachability and API-shape drift check |

Run `dougs <command> --help` for flags and examples.

## Output, scripting and exit codes

- **Tables in a terminal, JSON when piped.** `--json` forces JSON; `--jsonl` streams lists one
  object per line. Data goes to stdout; progress and warnings go to stderr (`--quiet` silences
  them).
- **Never hangs.** Commands that change data ask once in a terminal; anywhere else they refuse
  with exit code 2 unless `--yes` is given. No pagers.
- **Structured errors.** In JSON mode: one line on stderr,
  `{"error":{"code":"AUTH_EXPIRED","message":"…","hint":"run: dougs login (or: dougs login --from-browser chrome)","status":401}}`.

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected error |
| 2 | Usage error, or confirmation required (`--yes`) |
| 3 | Not logged in / session expired |
| 4 | Not found |
| 5 | Rejected by Dougs (4xx), or a write that did not stick |
| 6 | Network error, Dougs unavailable, or unexpected API response |
| 7 | Plan partially failed, hit conflicts, or caused side effects |

Full contracts: [docs/schema.md](docs/schema.md).

## Using it from an AI agent

dougs-cli is designed to be driven by agents: stable JSON, self-description, and mutations that
go through plans a human can review.

- Point your agent at [`skills/dougs/SKILL.md`](skills/dougs/SKILL.md) (an agent skill with
  recipes and guard-rails) and [AGENTS.md](AGENTS.md).
- `dougs commands --json` lists every command, flag and example; `dougs schema <type>` gives JSON
  Schemas for outputs and plan files.
- In CI or sandboxes, pass the session with `DOUGS_SESSION` and the company with `DOUGS_COMPANY`.
- Call `dougs login --check` before a long run. Logging in stays with the human: an agent never
  types or stores the password or the cookie.

A typical agent loop: `dougs todo --json` → propose a plan (`vat check --plan`, `receipts match
--plan`, `rules apply --plan`, or a hand-written plan) → a human reviews → `dougs apply plan.json
--yes --report audit.json`.

## Configuration

| | |
|---|---|
| Config file | `$XDG_CONFIG_HOME/dougs-cli/config.json` (default `~/.config/…`), mode 0600: profiles, companies, session expiry |
| Session | macOS Keychain or Linux Secret Service (service `dougs-cli`, account = profile name); the config file when neither is available or with `DOUGS_CREDENTIAL_STORE=file` |
| Profiles | `--profile <name>` / `DOUGS_PROFILE`; `dougs login --profile work …` |
| Company | `--company <id>` / `DOUGS_COMPANY`; chosen automatically when you have one |
| Session override | `DOUGS_SESSION` (takes precedence over stored credentials) |
| Cache | `$XDG_CACHE_HOME/dougs-cli/<company>/` — categories (24 h), Dougs invoice data (24 h), extracted PDF text; `--no-cache` bypasses it. Never contains your session |

Sessions read from a browser refresh themselves: on a 401 the CLI re-reads the browser cookie once
and retries.

## Privacy and politeness

- Your password is never stored. The session cookie is kept in the OS credential store (or the
  0600 config file) and is redacted from logs (`--verbose`), errors and plans.
- Requests identify themselves (`User-Agent: dougs-cli/<version>`), run at most 4 at a time, and
  only GETs are retried (on 429/5xx/network errors, with backoff).
- Document downloads follow Dougs' signed storage links without sending your cookie to them.
- Text from Dougs (bank wordings, memos, file names) is stripped of terminal control characters
  before it is printed, and `export --format csv` neutralizes cells that a spreadsheet would run
  as formulas.

## Development

```sh
npm install
npm run check      # lint, typecheck, tests (offline, synthetic fixtures), build
node dist/cli.js --help
```

See [AGENTS.md](AGENTS.md) for the layout and conventions, [docs/API.md](docs/API.md) for what
is known about the Dougs API, and [docs/DECISIONS.md](docs/DECISIONS.md) for design choices.
Test fixtures are synthetic: never commit real API responses, company ids, VAT numbers, IBANs,
names or cookies.

The diagrams in this README are made with [archify](https://github.com/tt-a1i/archify); their
sources and how to regenerate them are in [docs/diagrams](docs/diagrams/README.md).

## License

[MIT](LICENSE). "Dougs" is a trademark of its owner, used here only to describe compatibility.
