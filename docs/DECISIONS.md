# v0.1 decisions

- Operations use positive EUR magnitudes and a separate expense/income direction, as Dougs does. Raw bank transactions may carry signed native-currency amounts. Normalized VAT rates use percentage points (20); the API uses fractions (0.2).
- List and workflow commands include both validation states by default. Date and other filters are evaluated locally because the reference scripts establish that server date parameters are ignored. Deleted/excluded operations are omitted from accounting workflows.
- Convenience category/VAT mirrors are null when an operation has multiple main breakdowns. Automatic edits require exactly one main breakdown; no silent split allocation.
- Every mutation, including attachment/deletion and raw API writes, uses confirmation or --yes, with --dry-run available. Bulk workflow commands only generate plans.
- Browser SQLite is opened read-only so the active WAL is visible. Chrome timestamp integers exceed JavaScript's safe integer range; read timestamps as text before converting to seconds. Host digests are verified rather than guessed from printable bytes.
- DOUGS_EPHEMERAL=1 keeps configuration in process memory. Live development verification uses it and --no-cache to avoid writing credentials or accounting data anywhere. Normal users get the specified 0600 config file.
- The user-agent links to the npm package landing page until the project has a public repository URL; no remote is assumed or created.
