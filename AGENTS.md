# AGENTS.md

Guidance for AI agents — both agents **using** dougs-cli to do bookkeeping, and agents
**working on** this repository.

## Using dougs-cli

Read [`skills/dougs/SKILL.md`](skills/dougs/SKILL.md) first (`dougs skill` prints it); it has the
recipes and how to talk to a non-technical user. The essentials:

- Always pass `--json` (JSON is also the default when stdout is not a terminal). Errors are one
  JSON line on stderr: `{"error":{"code","message","hint","status"}}`. Branch on the exit code
  (0 ok, 2 usage/confirmation, 3 auth, 4 not found, 5 rejected, 6 network/API shape, 7 partial).
- Discover rather than guess: `dougs commands --json` (every command, flag, example),
  `dougs schema <type>` (JSON Schemas), `dougs categories list --search <text> --json` (ids).
- **Never change data directly in bulk.** Write a plan (`--plan file.json` on `todo`,
  `vat check`, `receipts match`, `rules apply`, or a hand-written plan following
  `dougs schema plan`), show it to the human, and only then run `dougs apply file.json --yes`.
  Every step needs a `why` a human can check.
- Mutations without `--yes` exit with code 2 (`CONFIRMATION_REQUIRED`) when not in a terminal —
  that is the safety net, not an error to work around silently.
- Run `dougs apply plan.json --dry-run` before applying; keep the `--report` output as an audit
  log.
- Before a long run, call `dougs login --check` (exit 0 valid, 3 missing or expired; silent
  unless `--json`). On exit code 3, ask the human to run `dougs login` in their own terminal
  (or `--from-browser chrome`, or to provide `DOUGS_SESSION`). Never ask for, type, print or
  store their password or session cookie yourself.
- On exit code 6 with `API_SHAPE`, run `dougs doctor --json` and report it: Dougs may have changed
  its private API.
- Accounting judgement stays with humans: `vat check` and `close-check` findings are signals,
  not verdicts. Do not invent invoices, change amounts, or validate operations you have not
  verified.

## Working on this repository

```sh
npm install
npm run check          # = lint + typecheck + test + build; must pass before every commit
node dist/cli.js …     # run the built CLI
```

Layout:

```
src/cli.ts             process entry: real stdin/stdout/fetch → program.run()
src/program.ts         commander wiring, global flags, error → exit code
src/commands/*.ts      one file per command group; render.ts = human tables
src/api/client.ts      fetch wrapper: cookie auth, retries, concurrency, error mapping
src/api/dougs.ts       company-scoped endpoints (pagination, updates, documents, declarations)
src/api/schemas.ts     zod: raw API shapes (loose) + normalized output shapes
src/api/normalize.ts   raw → normalized (percent VAT, short exemption names)
src/auth/              browser cookie decryption, config/profiles
src/plan/              plan types, diff/satisfaction checks, the step executor
src/workflows/         todo, receipts, vat, rules, close-check, vendor registry
src/pdf/extract.ts     PDF text + amount/date/VAT-number heuristics
src/output/            Output (stdout/stderr discipline), tables, errors, colours
test/                  vitest; test/helpers/fake-api.ts is an in-memory Dougs
docs/                  API.md (what we know about the API), schema.md, DECISIONS.md
```

Conventions:

- TypeScript strict, ESM, Node ≥ 22.13; Biome for lint/format (`npm run format`).
- Runtime dependencies stay minimal (`commander`, `zod`, `unpdf`). Ask before adding one.
- Every command has 1–3 real examples (`withExamples`), human output via a renderer, and the same
  data as JSON. Data → stdout, everything else → stderr through `Output`.
- New output shapes get a zod schema and an entry in `dougs schema` (`src/commands/meta.ts`).
- Every mutation goes through the plan executor (`src/plan/apply.ts`): re-read, skip if
  satisfied, write, re-read to verify.
- Tests run offline against `FakeDougs`. When the real API surprises you, encode the behaviour
  in the fake and add a test.
- Record non-obvious choices in `docs/DECISIONS.md` and API findings in `docs/API.md`.

**Data hygiene — this repository is public.** Never commit real company ids, VAT numbers, IBANs,
names, emails, operation ids, amounts tied to real merchants, cookies or tokens — not in code,
tests, fixtures, docs or commit messages. Fixtures are synthetic (company `999999`, invented
merchants). Live API calls during development are read-only (GET).
