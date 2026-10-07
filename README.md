# dougs-cli

[![CI](https://github.com/tom-eberle/dougs-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/tom-eberle/dougs-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dougs-cli)](https://www.npmjs.com/package/dougs-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/tom-eberle/dougs-cli/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)
[![Unofficial](https://img.shields.io/badge/Dougs-unofficial-lightgrey)](#is-it-safe)

**Hand your Dougs bookkeeping chores to your AI agent — receipts, VAT fixes, categorisation and
pre-filing checks — while you just approve.**

[Dougs](https://www.dougs.fr) is the French online accounting platform. dougs-cli lets the AI
agent you already use (Claude Code, Codex, Cursor…) work in your Dougs books for you, and asks
for your yes before anything changes.

- **Missing receipts, found and attached.** Your agent collects the invoices from your mailbox or
  supplier sites and attaches each one to the right bank line.
- **VAT fixed where Dougs gets it wrong**, typically foreign software subscriptions booked with
  French VAT when they should be reverse charge.
- **Your VAT return checked before you file it**, overdue returns and missing documents flagged,
  and the year-end checklist done in minutes instead of an afternoon.

> In a first real session on a small company's books, it found 3 overdue VAT returns, attached
> 22 missing invoices and fixed 30+ VAT and category errors, each batch reviewed by the owner
> before it was applied.

## Get started

1. **Install** it (you need [Node.js](https://nodejs.org) 22.13 or newer):
   ```sh
   npm install -g dougs-cli
   ```
2. **Log in** with your Dougs email and password (and your 2FA code, if you use one):
   ```sh
   dougs login
   ```
3. **Ask your agent** (Claude Code, Codex, Cursor or any agent that can run commands):
   > Read the dougs skill and tell me what needs attention in my books.

Your agent reads the skill with `dougs skill`, looks at your books and reports back. It proposes
changes and waits for your approval before touching anything.

*Unofficial: not affiliated with or endorsed by Dougs. See [Is it safe?](#is-it-safe).*

## Jobs you can hand to your agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/jobs-dark.png">
  <img alt="Seven jobs: find missing receipts, fix foreign software VAT, sort recurring expenses, check the VAT return, spot what is overdue, run the year-end checklist, answer money questions. For each, what the agent does, what you decide, and the typical time by hand versus with the agent." src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/jobs-light.png">
</picture>

*Typical times for a small company, by hand vs with your agent. They are approximate and depend
on how many operations you have.*

<details>
<summary>The same, as text</summary>

| Job | What your agent does | What you decide | Typical time, by hand → with agent |
|---|---|---|---|
| Find missing receipts (inbox, supplier sites) | Collects the PDFs, matches each to its bank line | Approve the list; nothing is uploaded before | ~1 h → ~10 min for about 20 receipts |
| Fix VAT on foreign software subscriptions | Spots reverse charge Dougs missed, proposes the fix | Approve the fixes | ~45 min → ~5 min for about 10 |
| Sort recurring expenses | Writes your own rules, applies them every month | Approve the rules once, then each month's list | ~30 min → ~2 min a month |
| Check the VAT return before filing | Compares it with your books, box by box | File it in Dougs yourself | ~45 min → ~5 min a return |
| Spot overdue returns and missing documents | Lists them, oldest first, with due dates | Decide what to do, or ask your accountant | ~20 min → ~1 min |
| Year-end checklist | Runs every check: duplicates, totals, VAT, receipts | Fix or explain, with your accountant | ~½ day → ~30 min |
| Answer questions ("ads spend this quarter?") | Exports and adds up, shows the lines behind it | Check the answer | ~20 min → ~1 min |

</details>

## Before and after

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/before-after-dark.png">
  <img alt="Before: open each operation, hunt invoices in email, fix VAT line by line, recheck the VAT return, which takes hours. After: ask your agent, it gathers and checks, you review one list and approve, which takes minutes of your time." src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/before-after-light.png">
</picture>

*Same books, same checks. Your agent does the legwork; you make the decisions.*

## Things you can ask your agent

Copy, paste and change the month. Your agent understands English and French.

| Ask | Demandez | What you get |
|---|---|---|
| "What needs attention in my Dougs books?" | « Qu'est-ce qui demande mon attention dans ma compta Dougs ? » | Overdue VAT returns first, then missing receipts, uncategorised expenses and VAT to check, in plain words. |
| "Update my Dougs books for September: receipts, VAT and categories." | « Mets à jour ma compta Dougs de septembre : justificatifs, TVA et catégories. » | One list of proposed changes for the month, each with its reason, applied after your OK. |
| "Find the invoices for my September expenses in my email and attach them in Dougs." | « Retrouve dans mes mails les factures de mes dépenses de septembre et joins-les dans Dougs. » | Invoices matched to their bank lines and uploaded once you approve. Your agent needs access to your mailbox. |
| "Check the VAT on my foreign software subscriptions and fix what Dougs got wrong." | « Vérifie la TVA de mes abonnements logiciels étrangers et corrige ce que Dougs a mal saisi. » | The subscriptions booked with French VAT that should be reverse charge, with the fix for each. |
| "Before I file, compare my September VAT return with my books." | « Avant que je la dépose, compare ma déclaration de TVA de septembre avec ma compta. » | A box-by-box comparison with Dougs' draft, and what explains any gap. |
| "Do I have overdue VAT returns or missing documents?" | « Est-ce que j'ai des déclarations de TVA en retard ou des justificatifs manquants ? » | Deadlines first, with due dates, then the documents to find. |
| "Set up rules so my recurring subscriptions are always categorised the same way." | « Crée des règles pour que mes abonnements récurrents soient toujours classés pareil. » | Rules based on your history, applied to new expenses each month after your OK. |
| "Which expenses over 150 € still have no invoice?" | « Quelles dépenses de plus de 150 € n'ont toujours pas de facture ? » | The list to chase: above 150 € a full invoice is expected, not just a till receipt. |
| "How much did I spend on advertising this quarter?" | « Combien j'ai dépensé en publicité ce trimestre ? » | A total, with the operations behind it. |
| "Run the year-end checklist for 2026." | « Fais la check-list de clôture de l'exercice 2026. » | Missing receipts, possible duplicates, VAT doubts and documents whose totals don't match, before closing. |

## Your month, step by step

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/monthly-routine-dark.png">
  <img alt="Your agent finds what needs attention, gathers receipts, fixes VAT and sorts expenses; you approve, which is the only way changes reach Dougs; your agent checks the VAT return; you file it in Dougs." src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/monthly-routine-light.png">
</picture>

*The agent prepares everything. Nothing reaches Dougs until you approve, and you still file the
VAT return yourself.*

## Is it safe?

- **Nothing changes without your approval.** Your agent first shows you the list of changes, each
  with its reason. Dougs is only touched after you say yes. Looking is always safe.
- **Locked or already-declared months are never touched.** Operations in a month whose VAT return
  is filed, or in a closed year, are left alone unless you explicitly ask.
- **Everything is checked and logged.** After each change, dougs-cli reads the operation back to
  make sure it is right, and keeps a report of what changed.
- **Your password stays yours.** It goes only to Dougs and is never stored, and your agent never
  sees it.

**What it does not do**

- It does not file your VAT return: you file it in Dougs, as today.
- It does not replace your accountant's judgement. Its findings are suggestions; ask your
  accountant when in doubt. Nothing here is tax advice.
- It is unofficial: not affiliated with, endorsed or supported by Dougs. It uses the same private
  interface as the Dougs web app, which can change at any time; `dougs doctor` tells you when it
  has.

---

## How it works

dougs-cli is a command-line program that runs on your computer and talks to Dougs with your own
session, exactly like the web app does. Your agent runs its commands; so can you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/architecture-dark.png">
  <img alt="dougs-cli runs on your computer: workflows read from Dougs, the plan engine writes through the same API client, using the session you logged in with" src="https://raw.githubusercontent.com/tom-eberle/dougs-cli/main/docs/images/architecture-light.png">
</picture>

*Everything runs locally: workflows only read, every write goes through the plan engine, and your session is kept in your OS credential store when there is one.*

When your agent asks what needs attention, it runs `dougs todo` and gets this (in JSON):

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

### Command-line quickstart

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
on first use. The store keeps the session out of plain files and backups; like the 0600 file, it
is readable by programs running as you. Where the store is locked (e.g. the macOS login keychain
over SSH or in cron), commands stop with `CREDENTIAL_STORE_LOCKED` (exit 3) and say how to unlock
it, or use `DOUGS_SESSION`, or `DOUGS_CREDENTIAL_STORE=file dougs login` on such machines.

`dougs whoami` shows when the session expires, `dougs doctor` warns a week before and fails once
it has, and `dougs login --check` exits 0 (valid) or 3 (missing, expired or locked) without printing
anything, for scripts and agents to call before long runs. `dougs logout` forgets the session
(if the store is locked it says the session is still there and exits 1); `dougs logout --remote`
also ends it on Dougs.

## Workflows in detail

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
| `dougs skill` | The guide for AI agents ([skills/dougs/SKILL.md](skills/dougs/SKILL.md)); `--path` prints its location |
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

## Driving it from an agent: the details

dougs-cli is designed to be driven by agents: stable JSON, self-description, and mutations that
go through plans a human can review.

- Point your agent at the skill: `dougs skill` prints it (recipes, guard-rails, how to talk to a
  non-technical user), `dougs skill --path` says where it is. In Claude Code you can install it
  as a skill: `mkdir -p ~/.claude/skills/dougs && cp "$(dougs skill --path)" ~/.claude/skills/dougs/`.
  See also [AGENTS.md](AGENTS.md).
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

## For developers

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
