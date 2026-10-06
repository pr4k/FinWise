# FinWise Rust backend

The repository now contains a runnable Axum + SQLx/SQLite core. This is **a partial implementation of the full API specification**, not a release of all planned milestones. The static browser interface now calls the API for the basic workflows, including import mapping, preview, and commit.

## Run

From the repository root, with Rust 1.94 or later:

```sh
FINWISE_INSECURE_LOCAL_COOKIES=true cargo run -p finwise-api
```

Open `http://127.0.0.1:3000`. The same process serves `web/` and `/api/v1`. Migrations run automatically, with foreign keys enabled and SQLite WAL mode. The default database is `data/finwise.sqlite`. Stop with Ctrl-C.

Secure cookies are the default. The local HTTP override requires binding to a loopback address. Outside local development, use an HTTPS reverse proxy and omit the override. CORS is not enabled. This core is not yet the hardened NAS release described in the implementation plan.

| Environment variable | Default |
|---|---|
| `FINWISE_BIND` | `127.0.0.1:3000` |
| `FINWISE_DATA_DIR` | `data` |
| `DATABASE_URL` | SQLite file inside the data directory |
| `FINWISE_WEB_DIR` | `web` |
| `FINWISE_INSECURE_LOCAL_COOKIES` | `false` |
| `FINWISE_UPLOAD_FILE_MAX_BYTES` | `8388608` (8 MiB; clamped to 1 KiB–32 MiB) |

Container deployment instructions are in [deploy/README.md](../deploy/README.md). The server handles SIGINT and SIGTERM for graceful shutdown.

The binary reads process environment variables; `.env.example` is documentation, not automatically loaded configuration.

## Implemented routes

- Bootstrap, login/logout, rotating server-side sessions, CSRF, current user, invites, member roles and revocation.
- Accounts, private/shared access, explicit member grants, categories, hierarchy validation, archive/restore.
- Manual expense, income, refund and transfer transactions; revision-checked edits, voids and audit history.
- Account opening balances, dated balance checks, immutable observed/calculated snapshots, computed stale status, and monthly recorded account activity.
- Summary, expense/income category, transaction-type, merchant, daily/monthly series, account and transfer reports, coverage metadata, and transaction drilldowns. Transaction lists can combine account, account-type, and transaction-type filters.
- Personal/family monthly budgets, revisions, lifecycle, copy and tracking.
- Multipart CSV/XLSX imports with durable parse jobs, preview and mapping, idempotent commit, source profiles, transfer review, original-file download, and bank observations. The supplied bank-statement XLSX layout is supported alongside flat bank CSV.
- Account/month reconciliation sessions, deterministic candidates, signed partial matches, rejections, atomic missing-entry creation, correction/duplicate-merge previews, closure/reopen, and stale detection.
- Household name/timezone/currency/locale settings; liveness and database readiness.
- OpenAPI 3.1 at `/api/v1/openapi.json`, generated browser DTO types, and contract drift checks.

Every listed feature has limitations below. The OpenAPI document marks each operation with `x-implemented`. Known deferred routes return `501 not_implemented` after normal authentication/CSRF validation; unknown `/api/*` routes return JSON `404`, never the frontend HTML.

**Deferred:** PDF parsing, real-source format validation and additional bank adapters; category merges; budget contributions and alerts; AI configuration/secrets/providers; exports; backups/restore and NAS release validation. Container build/Compose files exist in `deploy/`; image build/runtime validation requires a running Docker daemon. Provider key and restore requests are never accepted as successfully processed.

## Import workflow

`POST /api/v1/imports` accepts `multipart/form-data`: one `manifest` JSON part and up to four `files[]` parts in the same order as `manifest.files`. Each manifest entry needs `source_kind` (`money_manager` or `bank_statement`) and may include `mapping`. CSV must be UTF-8; XLSX must match the supported Money Manager table layout. The default file limit is 8 MiB, and parsing also limits rows, columns, and expanded workbook content. Upload requires `Idempotency-Key` and the session CSRF token. Source bytes and raw rows are kept in SQLite; the original is available through the authorized, audited `GET /source-files/{id}/download` route.

The upload response includes a batch ID, file IDs, and parse job IDs. Poll `GET /jobs/{id}` or subscribe to `GET /jobs/{id}/events`; `GET /imports/{batch_id}/files/{file_id}` reports parse state. `GET /imports/{batch_id}/preview?file_id=...` shows normalized rows, issues, and possible duplicate candidates without changing the ledger. Map source account names through `account_aliases`, and map source category/subcategory/event-kind combinations through `category_mappings`, either in the file mapping or saved source profile routes. Updating file mapping requires its revision. Preview and commit re-evaluate saved source mappings.

`POST /imports/{batch_id}/commit` requires the batch revision and an idempotency key. It creates supported Money Manager expense/income events, pairs unambiguous reciprocal transfers, and reuses exact overlapping occurrences. Rows with mapping or validation issues remain for review; possible edited duplicates require their item IDs in `accept_as_new` before creating another event. Bank CSV rows create source observations only. Linked bank files and unmatched observation counts appear in monthly account statements; reconciliation decisions explicitly link committed observations to ledger movements. Import commits currently use one SQLite transaction for all selected files, and source coverage remains unknown unless explicitly claimed. Parser support and mapping assumptions are validated with synthetic fixtures only; check a real export's preview before committing it.


Money Manager exports may put the human-readable transaction text in `Note` while leaving `Description` blank. The importer now displays `Description` when present and otherwise uses `Note`, preserving both original cells and their original fingerprint fields. Exact re-uploads, including files imported by the older parser, reuse the same occurrence/event and attach source references; they do not create another expense, income, or transfer. Source changes such as an edited note produce a review candidate rather than silently overwriting an existing ledger event. Genuine identical purchases remain distinct through occurrence counts.

To replace a month or year of your Money Manager entries, use Imports → Reimport Money Manager entries. Preview the exact transactions, then remove them and upload the workbook again. The cleanup voids only your imported transactions with solely your Money Manager source references, releases their import occurrence links, and retains the old transactions and source files in audit history. Manual entries, other members' imports, and bank-statement observations are not removed. A transaction can also be edited from its Details view or deleted individually; deletion is an audited void, and a later import can recreate its source row.

On startup the backend repairs display descriptions for untouched, revision-1 imported events with a blank source `Description` and a populated `Note`. Each repair advances the transaction revision and records an audit event; manually edited events are left alone. The original workbook and previously stored source rows remain unchanged. The import UI shows source description, exact reuses, unresolved rows, and commit outcomes separately.

## Request examples

Bootstrap is available once. All examples use synthetic values:

```sh
curl -i -c /tmp/finwise-cookies http://127.0.0.1:3000/api/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: setup-example-1' \
  -d '{"owner":{"name":"Owner","email":"owner@example.test","password":"replace-this-password"},"household":{"name":"Home","timezone":"Asia/Kolkata","base_currency":"INR"}}'
```

Use the response's `csrf_token` as `X-CSRF-Token` on authenticated mutations. `GET /api/v1/auth/csrf` returns it again. A session lasts seven days. Login replaces the presented session and CSRF token. Passwords use Argon2id; only hashes of session tokens are stored.

```json
POST /api/v1/accounts
{
  "name": "Bank",
  "subtype": "bank",
  "currency": "INR",
  "visibility": "private",
  "timezone": "Asia/Kolkata",
  "opening_balance": {
    "amount": "1000.00",
    "as_of": "2026-09-01T00:00:00+05:30"
  }
}
```

Account subtypes are `bank`, `credit_card`, `cash`, and `settle_up`. Opening balance is optional. For cards it is positive amount owed; all ledger movements retain asset-sign convention. Currency, subtype, opening balance, and account timezone become immutable after ledger activity; changing them requires the deferred migration workflow.

```json
POST /api/v1/transactions
{
  "event_type": "expense",
  "amount": "125.00",
  "currency": "INR",
  "effective_date": "2026-09-15",
  "effective_at": "2026-09-15T10:30:00+05:30",
  "description": "Groceries",
  "movements": [{"account_id": "ACCOUNT_ID", "amount": "-125.00"}],
  "allocations": [{"category_id": "CATEGORY_ID", "amount": "125.00", "scope": "personal"}]
}
```

All create/decision POST requests except login/logout require `Idempotency-Key`. Updates require `If-Match: 1` or `expected_revision: 1`. A retry of the same create returns the original resource. A different payload using the same key returns `409`. Bootstrap/invite acceptance retries preserve the resource result while issuing fresh session credentials rather than storing plaintext session tokens for replay.

Money must be a decimal string. Supported currency exponents are explicit in `domain.rs`; unsupported currencies are rejected. Expense movements are negative; income/refund movements are positive. Transfers require two different same-currency accounts with equal opposite movements and an empty allocation array. Allocation magnitudes must sum exactly to the event magnitude. Missing/null category IDs mean Uncategorized.

`effective_at` is optional. Date-only transactions take effect at local midnight in the account timezone, falling back to the household timezone. Ambiguous midnight times require an explicit timestamp. Use `effective_at` when an intraday cutoff matters. A balance check never creates a balancing transaction.

```json
POST /api/v1/accounts/ACCOUNT_ID/balance-checks
{
  "amount": "875.00",
  "currency": "INR",
  "basis": "posted",
  "as_of": "2026-09-15T23:59:59+05:30",
  "timezone": "Asia/Kolkata",
  "expected_revision": 1
}
```

This returns calculated balance and `actual - calculated` variance. Missing opening balances produce null calculated/variance values with `complete:false`. Later ledger changes mark the snapshot stale without rewriting its original values. Account/month statements describe recorded activity and now list linked bank import files and unmatched observations; they do not infer a provider closing balance from CSV rows. No provider statement is fabricated for cash or settle-up accounts. Settlement obligations are deferred; settle-up accounts do not support balance checks.

`GET /api/v1/accounts/{id}/balance-at?as_of=<RFC3339>` recomputes the account at an exact instant. `GET /api/v1/accounts/{id}/ledger?from=<date>&to=<date>` lists signed movements and the balance after each timestamp. A saved check anchors balances on either side of its timestamp, even for an imported account without an opening amount. The displayed source is `balance_check`, `opening_balance`, or `unknown`; coverage remains unknown. Date-only entries sharing local midnight show the balance after the whole same-time group.

For an invite, the client generates a cryptographically random 32-byte token encoded as 64 hex characters, includes it as `token` in the invite request, and privately shares it with the invitee. Only the hash is stored. This avoids persisting the token in the idempotency response cache. `POST /invites/{token}/accept` accepts name/email/password for a new user and sets a session cookie, or uses the existing authenticated user. Proxy logs must redact invite-token URLs. No email is sent.


## Reconciliation workflow

1. Commit a bank CSV import. This stores immutable observations with stable occurrence IDs, signed amounts, references, and source coordinates; it creates no spending. Exact overlapping occurrences are reused. Direction and bank reference participate in observation identity.
2. `POST /reconciliation/sessions` with `account_id` and `month` creates one bank/card account-month session. `GET /reconciliation/sessions/{id}` returns current counts, unknown coverage, and stale closure status. Account access is required on every call and idempotent replay.
3. Read `/items?side=ledger` and `/items?side=statement` independently. Filter with `state=unmatched|partial|matched`; both support snapshot-bound cursors and limits. Ledger IDs are transaction IDs within the selected account, where each event has at most one movement. `/candidates?ledger_id=...` (or `observation_id`) suggests same-account/currency, same-direction rows within seven days. `POST /auto-match` accepts only unique unmatched pairs with the same date, signed amount, and currency.
4. `POST /matches` accepts `{ "decision":"accept", "allocations":[{ "ledger_id":"...", "ledger_revision":1, "observation_id":"...", "amount":"-120.00" }] }`. Include the session revision via `If-Match` or `expected_revision` and an idempotency key. Amounts are signed in asset convention, including cards. Each edge consumes the same value from both sides; many-to-many and partial matches are allowed, with at most 200 edges per request. Wrong signs, stale ledger revisions, and overconsumption fail atomically. Matching never changes ledger amounts or revisions.
5. `GET /matches` lists visible accepted/rejected/invalidated decisions. `POST /matches/{id}/reject` requires session revision, `match_revision`, and `reason`; it frees the linked value without deleting the event or source evidence. Rejecting an unaccepted suggestion requires no persisted decision; choose another candidate.
6. `POST /missing-ledger-entry` accepts `observation_id`, `transaction` (the ordinary transaction payload), and `reason`. It atomically creates and fully links one confirmed event for an entirely unmatched observation. A transfer still requires access to both accounts. Partially matched observations require explicit matching and ordinary ledger creation.
7. `POST /corrections` accepts `mode:"preview"`, `ledger_id`, `ledger_revision`, and `changes` (transaction patch fields). It returns `preview_token` and exact movement/spending/income/allocation impact. Submit the same changes with `mode:"apply"`, token, and reason to apply. This corrects existing events; create a separate fee through the ordinary ledger or missing-entry workflow. Currency changes are rejected.
8. `GET /duplicates` suggests same-date/type/currency/movement pairs; identical purchases can be genuine. `/duplicates/{candidate_id}/merge-preview` requires `survivor_id`, `discarded_id`, and both expected transaction revisions. `/merge` additionally requires the preview token and reason. It keeps survivor allocations, combines source provenance, redirects imported occurrence links, and voids the duplicate with a `merged_into` pointer. Both audit histories remain. Corrections/merges invalidate accepted bank links for review, including all edges in an affected group.
9. `/close` requires a nonempty `closing_evidence` object and a reason acknowledging unresolved rows and unknown coverage. It stores immutable counts, signed statement-movement minus ledger-movement variance, actor, timestamp, and a snapshot hash; this variance is not a provider closing-balance claim. Use balance checks for actual/provider balance comparisons. `/reopen` requires a reason and revision. Later ledger or observation changes make closure snapshots stale without rewriting history.

The browser reconciliation view supports selecting multiple rows on both sides and previews the signed allocations before attaching them in one decision. It refreshes its comparison panel after a match without resetting the page position. When a selected statement amount or date differs from one ledger transaction, `POST /amendments` applies the statement value/date to the FinWise transaction, scales its category allocations, and records the original transaction values, source references, and reason. Balances, analytics, and budgets use the amended transaction. `GET /amendments` lists the source-app changes and marks those whose transaction changed again. The browser can download the pending Money Manager updates as CSV. Applied amendments cannot be cancelled without another ledger correction; their audit history and original values remain available.

All decision POSTs require idempotency keys and the current session revision. Read responses continue the conservative whole-transaction access policy; a transfer with an inaccessible other account is excluded from reconciliation details. Coverage stays unknown; matching all recorded rows does not assert complete source coverage. Queries and closure hashes currently run in Rust and need large-dataset benchmarking. Automatic candidate rejection persistence, provider closing-balance verification, and real-bank adapter acceptance remain pending.

Startup upgrades older committed bank evidence into immutable snapshots, checking the original occurrence fingerprint first. If legacy source mappings changed after commit or one legacy occurrence contains conflicting rows, startup stops with a safe error instead of inventing financial evidence; review/restore the original mapping before upgrading. New snapshots are never rebuilt from edited mappings.

## Reporting and privacy boundaries

Report requests require explicit `from` and `to` dates using `[from,to)` boundaries. Default scope is personal and currency is the household base currency. The maximum report interval is 3660 days. Reports retain unknown source coverage unless an explicit import claim supports it; recorded totals must not be treated as complete financial statements. Comparison periods and `months` shortcuts are not implemented and are rejected. Amounts remain strings; ratios such as utilization are JSON numbers.

Account access is required for ledger details, revisions and report inputs. Owners/admins cannot bypass private account permissions. The current conservative policy requires access to every movement account before returning a transaction; allocation-only family sharing from private accounts is deferred. Reports label this restriction as `authorized_accounts_only`. Account balance projections include authorized-account movements even if a transfer's other account is private, without exposing that other account.

Personal scope currently means personal allocations entered by the current user. Per-beneficiary allocation sharing and other-member report filters are deferred. Family scope counts explicitly family-scoped allocations from authorized transactions. Transfers never count as spending or income. Refunds reduce spending. Budget tracking uses the same policy. Partial-period tracking is marked `full_plan_period:false`.

Collection limits default to 50 and cap at 200. Transaction cursors are bound to the ordered result snapshot and filters; intervening edits cause a conflict requiring pagination restart. There is no report cache to invalidate. Core storage uses validated JSON resource documents in SQLite, with household/owner indexes and atomic before/after audit events. Query filtering currently runs in Rust; indexed SQL projections, large-dataset benchmarks and full normalized relational domain tables remain future work. One SQLite connection serializes writes and protects revision/idempotency decisions within this process. Run one backend process per database.

## Validation

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
python3 scripts/generate_contract.py --check
```

Regenerate `backend/openapi.json` and `web/src/lib/api/types.ts` with `python3 scripts/generate_contract.py`. The generator's DTO schemas define the implemented payload choices where the planning spec only describes semantics. The static preview is not wired to these types or routes yet. Automated tests use synthetic data and temporary/in-memory SQLite databases; no real financial data or provider keys are needed.
