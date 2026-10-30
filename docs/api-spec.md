# FinWise HTTP API specification

### Implemented budget commitments

`POST/PATCH /api/v1/planned-items` accepts `budget_commitment: true` for a dated expense with a category and optional budget destination. `GET /api/v1/budgets/{id}/commitments` lists authorized commitments for the budget month; tracking and `/budgets/{id}/people` add committed totals and available after commitments alongside recorded spending. `POST /api/v1/planned-items/{id}/match` takes `transaction_id` and `reason` with the plan revision, and links one visible posted expense of the same month, amount, currency, category, and scope. `DELETE` on the same path takes a reason and revision to unmatch. Matching and unmatching are audited; expense and account balances come from the transaction itself. An unmatched posted payment may temporarily appear alongside its commitment until a member reviews and matches it. Pending payments and automatic matching remain future work.

`GET /api/v1/budgets/{id}/forecast` returns the effective allowance, recorded spending, unmatched commitments, elapsed variable spending, period day counts, estimate, headroom, formula version, and quality flags. It uses household-local calendar days. A numeric current-rate estimate appears only after seven elapsed days and is labeled `limited_history`; prior complete-month coverage is not yet established. Matched posted bills are excluded from the variable daily rate. A possible unlinked posted payment is flagged for review without silently clearing its commitment. Before day eight, or for a past or future budget month, the status is `unavailable` and numeric estimate fields are null. Negative variable spending is floored at a zero future rate and flagged. This is budget headroom, not a cash balance or a high-confidence forecast.

`POST /api/v1/budgets/{id}/plan-preview` accepts proposed name, income, savings goal, category lines and People allowances with the current revision. It validates the complete plan and returns before/after totals, category and People changes, funding gaps, an unfunded warning and a preview hash. `POST /api/v1/budgets/{id}/amendments` accepts the returned `proposal` and `preview_hash`, a 1–500 character reason, and the same revision. A worsening negative funding gap also needs `accept_unfunded: true`. A changed revision or preview hash fails with conflict. The amendment and reason are audited. Direct PATCH of an existing budget is rejected so edits use the review step.

### Opt-in quick expense entry

`GET /api/v1/quick-transactions/options` and `POST /api/v1/quick-transactions` are the only unauthenticated expense-entry routes. They are disabled by default and derive the user and household from owner-managed, server-stored settings. `GET` and `PATCH /api/v1/settings/quick-expense` require an owner session; PATCH also requires CSRF and a revision. POST requires an `Idempotency-Key` and creates an ordinary expense transaction with the configured user's permissions. These routes must stay on a trusted LAN or private VPN, outside any public proxy or tunnel. See [Apple Shortcuts quick expenses](quick-expense-shortcuts.md) for configuration, payloads, responses, curl examples, and iPhone setup.

### Opt-in widget analytics

`GET /api/v1/widgets/spending` is an unauthenticated, read-only summary using the configured member's accessible ledger, the household base currency, and timezone. It is disabled by default. `scope=personal` is the default; `scope=family` and `scope=combined` are available only after the owner enables Family scopes in Settings. `GET /api/v1/widgets/accounts` exposes the selected member's accessible account balances and latest transaction dates only after the owner enables a separate accounts switch in Settings. The owner manages these switches through authenticated `GET` and `PATCH /api/v1/settings/widgets`; PATCH requires CSRF and a revision. Successful widget responses permit a five-minute private cache. Keep the widget routes on a trusted LAN or private VPN, outside any public proxy or tunnel. See [Widget API](widgets-api.md) for filters, response shape, calculation rules, and curl examples.

`GET /api/v1/widgets/expense-calendar?scope=family&month=2026-10` uses the spending widget switch and returns `month`, `currency`, `complete`, and numeric `days[].expense` for each elapsed household-local calendar date. Its Family and Combined scopes require the Family scope switch. `account_id` optionally selects one account; omission includes all accessible accounts. Settings offers selectors and a copyable URL for scope and account. `complete` describes date coverage, not ledger import completeness. See [Widget API](widgets-api.md) for the full contract.

### Settle up, investments, and savings plans

`GET/POST /settle-ups` stores private, per-person obligations with `person`, `direction` (`owed_to_me` or `i_owe`), `kind`, exact decimal `amount`, `currency`, `date`, and `description`. `POST /settle-ups/splits` accepts a purchase `total`, `my_share`, named `shares`, and `paid_by` (`me` or a name among the shares); their exact minor-unit sum must equal the total. If you paid, it creates a receivable for each other person. If another person paid, it creates a payable for your share. An optional `transaction_id` links a purchase you paid to an accessible, active expense with the same total and currency; a transaction can have only one split. Splits do not create expenses. `POST /settle-ups/{id}/repayments` takes `amount` and `date`, requires the current revision, and cannot exceed the remaining balance. `PATCH /settle-ups/{id}` corrects obligation details, while keeping a split share amount locked. `DELETE /settle-ups/{id}/repayments/{payment_id}` removes a mistaken repayment with the current obligation revision. Revisions remain in the audit history.

`DELETE /settle-ups/{id}` requires the current revision and hides the obligation from active lists and analytics. For a split it deletes all obligations in that split as one transaction; the linked expense stays in the ledger. Audit snapshots are retained, and a deleted split no longer blocks a new split for the same expense.

`GET/POST /investments` stores private investments or emergency funds with a currency, optional target, and optional monthly addition goal. `PATCH /investments/{id}` updates the plan. An optional `visibility` of `shared` allows other household members to see that holding's monthly net additions in the household report; holdings are private by default and their details remain owner-only. `PUT /investments/{id}/months/{month}` records that month's `contribution` and `withdrawal` as exact decimal strings, with an optional closing `value`. Repeating a month with its current revision corrects the record. The API returns `net_contributions` as opening value plus cumulative contributions less withdrawals, and `gain_loss = closing value − net_contributions` when a valuation is available. Month records are sorted chronologically and cannot withdraw more than the opening value plus contributions.

For an existing portfolio, set `opening_value` and `opening_month` when creating or editing the holding. This is a valuation baseline, creates no account movement, and is not counted as a new monthly contribution. The opening gain/loss is zero; later gain/loss compares a recorded valuation with the opening value plus subsequent contributions less withdrawals. The opening month must be no later than any monthly record. A month may have `value: null` while its valuation is pending; gain/loss is unavailable after an unvalued money movement until a valuation is entered.

An investment may also have one `sip` schedule on create or PATCH: `{amount, day, start_month, end_month?, status}`. Amount is a positive decimal string in the holding currency, day is 1–31, months use `YYYY-MM`, and status is `active` or `paused`. PATCH with `sip: null` removes it. The planned day falls on the last day in shorter months. A SIP is a planning schedule; it does not create monthly contributions, valuations, or ledger transactions.

`POST /investments/{id}/sip/{month}/process` with `account_id`, optional `transaction_date` and `value`, and the current investment revision manually records one active SIP contribution for that month. The date defaults to the scheduled day and must be in the selected month. The account must be active and use the investment currency. The action adds an investment debit to Transactions. The valuation stays pending unless `value` is supplied; an existing valuation for that month requires an updated value after the SIP. A processed month cannot be processed again; use the monthly record endpoint to correct its amount, date, account, or valuation.

`POST /investments` may include `initial_record: {month, principal, current_value, account_id?, transaction_date?}` to save a first monthly contribution and valuation atomically with the holding. Principal is a positive new contribution, current value is nonnegative, and both are exact decimal strings. The stored month has that principal as its contribution and zero withdrawal. When an active account in the holding currency is selected, `transaction_date` must fall in the record month and an investment transaction debits the account. Later monthly records accept the same `account_id` and `transaction_date` fields; contributions debit and withdrawals credit that account. These investment movements appear in Transactions and account balances, but have no expense allocation and do not increase spending totals. Older monthly records without an account remain valuation-only until corrected with an account.

`PATCH /investments/{id}/movements/{movement_id}` corrects the amount, account, or date of one linked contribution or withdrawal and recalculates its month without replacing other movements. `DELETE` on the same path retires one movement. Both require the holding revision and invalidate affected reconciliation links. A monthly `PUT` can update a valuation while several movements exist, but changes to their aggregate amount, account, or date must use the individual movement routes.

`GET /investments/report?month=YYYY-MM&currency=INR&scope=combined` and Household 360 use the same recorded-flow calculation over the entire selected month. `contributed` and `withdrawn` include posted external funding, linked payments, and the unbacked portion of legacy monthly contribution/withdrawal records. Tagged allocations not linked to holdings are reported separately: `unassigned_net` is tagged contributions minus tagged refunds; `pending_funding` is their unsigned review volume. `net_invested = contributed - withdrawn + unassigned_net` is the comparable monthly headline. Posted movements and linked evidence are counted once, and purchases funded from investment cash do not count again after the external transfer. Personal scope attributes flows to the payer (or account owner), while family scope includes shared holdings/accounts and family tagged allocations. Combined totals compare with the sum of visible Household 360 member totals, not necessarily a single member. `personal_net_invested` and `personal_unassigned_net` identify the signed-in member’s portion of the selected scope, using explicit `paid_by_user_id`, then account ownership for imports/account movements, or the author for older manual expenses and refunds. A family allocation does not assign its payment to the viewer. Portfolio valuations and cash balances retain their dated cutoff and are separate from monthly flows.

`POST /investments/{id}/linked-transactions` links an existing expense or refund whose full allocation uses investment-tracked categories. An expense adds to the holding's contribution; a refund adds to its withdrawal. The existing ledger movement stays in place. The optional `replace_movement_id` retires a matching generated portfolio movement from the same account and month so the balance is counted once. The optional `value` updates the monthly current value; otherwise the recorded value stays unchanged. `DELETE /investments/{id}/linked-transactions/{transaction_id}` removes the contribution or withdrawal link without deleting the ledger transaction. Linked transactions must be unlinked before they can be edited or deleted. Both endpoints require the holding revision.

`DELETE /investments/{id}/months/{month}` removes one monthly record and recalculates later net additions and value change; it rejects a deletion that would leave withdrawals greater than contributions. `DELETE /investments/{id}` hides the holding and its monthly records from active views and analytics. Both require the current investment revision and retain audit history. Linked investment transactions are voided when a month is corrected or removed, or when the holding is deleted.

Budgets accept an optional `savings_goal` alongside expected income and category limits. The browser compares expected income, limits, savings goal, recorded income, actual category spending, and unbudgeted spending. These planning records do not create bank/cash transactions or automatically move funds.

### Implemented monthly data reset

`POST /api/v1/data/reset-preview` accepts `{"months":["2026-09","2026-11"]}` and returns normalized months, a `counts` object, scope, and `preview_token`. Counts cover transactions, statement entries, reconciliation sessions, balance checks, budgets, and import rows. Select 1–24 calendar months; duplicate months are deduplicated. Both reset endpoints require an owner/admin session, CSRF token, and idempotency key.

`POST /api/v1/data/reset` accepts the same months plus `preview_token` and `"confirmation":"RESET"`. It recomputes the preview inside the write transaction and rejects changed data with `409`. The reset is atomic and retryable with the same idempotency key. In-progress imports and closed reconciliation sessions block reset; finish imports and explicitly reopen sessions first.

Scope is accounts the caller can access (including shared activity), their personal budgets, and family budgets. Private accounts and budgets belonging to other members are excluded. Transactions use effective dates; checks use their account/household timezone; budgets and sessions use their month. The operation voids transactions/checks, removes selected statement observations and their deduplication records, removes sessions and their review records/links, deletes selected budgets, and removes dated import rows for accessible accounts (plus the caller’s unmapped rows). Related ledger import occurrences are cleared so re-uploading can recreate entries. Original uploaded files, account setup/opening balances, categories/mappings, and audit snapshots remain. Multi-month files retain rows outside the selected months; uploading the file again is the supported reimport workflow. Removing movements can change balances in later months.

Status: target implementation contract, 2026-09-30. A Rust/Axum core now implements part of this contract, including deterministic Money Manager XLSX and bank CSV imports. See [backend coverage and limitations](../backend/README.md) for the implemented subset. The running server publishes OpenAPI 3.1 at `/api/v1/openapi.json`, with `x-implemented` flags, and browser DTO types are generated from the same schema source. Deferred routes return `501 not_implemented`; this document continues to describe the complete target API. Product and accounting rules come from [architecture.md](architecture.md), while report formulas come from [analytics-and-budgets.md](analytics-and-budgets.md).

## 1. API-wide contract

- Base path: `/api/v1`; serve the API and static Svelte app from one origin. Unknown `/api/*` paths return JSON `404`, never the SPA fallback.
- JSON uses `application/json; charset=utf-8`. Uploads are `multipart/form-data`. Dates without time are ISO `YYYY-MM-DD`; instants are RFC 3339 with offset. Periods are calendar dates in the household timezone and use `[from, to)` boundaries.
- Money is serialized as a decimal **string** plus ISO currency, for example `{"amount":"-1250.00","currency":"INR"}`. The server parses and calculates minor units using checked arithmetic. No JSON floating point for money. Amount signs follow the route's documented meaning; ledger transaction amounts are positive magnitudes while movements are signed.
- IDs are opaque strings. Timestamps are UTC instants; business dates remain local dates. Resources with mutable state include an integer `revision`.
- Collection endpoints return `{ "data": [...], "page": {"next_cursor": "..."}, "meta": {...} }`. Omit `next_cursor` at end. Default page size 50, maximum 200. Sort order is stable and cursor pagination is required for transaction/evidence lists.
- Every create/retry/commit/decision request that could be retried requires `Idempotency-Key` (UUID recommended). Reusing a key with the same principal and request body returns the original result; reusing it with a different body returns `409 idempotency_key_reused`.
- Every update/decision to an existing revision requires `If-Match: <revision>` or `expected_revision` in the body. A stale revision returns `409 revision_conflict` with the current revision; clients must reload and resolve rather than silently retry.
- Auth uses a server-side session in an `HttpOnly; Secure; SameSite=Lax` cookie. Mutating cookie-authenticated requests require the CSRF token from `GET /auth/csrf` in `X-CSRF-Token`; login rotates the session. Do not accept bearer tokens in browser storage. Reverse proxy HTTPS is required outside local development.
- APIs derive household/member identity from the session, never a client-supplied `user_id`. Private resources are indistinguishable from missing resources (`404`) for unauthorized users. Account access, evidence access, background jobs, exports, and aggregates all use the same authorization policy.
- Mutations append an audit event atomically with the change. Ledger/import decisions use normal domain validation and invalidate derived report caches/reconciliation links as specified. `X-Request-Id` is accepted if valid or generated by the server and returned on every response.
- Return `Cache-Control: no-store` on authenticated financial data, AI settings, file metadata, and downloads. No service-worker caching of private responses.

### Standard error envelope

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "This transaction changed after it was loaded.",
    "fields": [],
    "current_revision": 8
  },
  "request_id": "req_01J..."
}
```

`fields` is an array of `{ "path": "amount", "code": "out_of_range", "message": "Amount must be positive." }`. Stable codes include `validation_error` (400), `unauthenticated` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `revision_conflict` (409), `idempotency_key_reused` (409), `unsupported_media_type` (415), `payload_too_large` (413), `rate_limited` (429), `job_not_retryable` (409), and `internal_error` (500). Never return SQL details, file paths, provider secrets, statement text, or stack traces.

## 2. Authentication and household

| Method and path | Purpose / request | Success |
|---|---|---|
| `GET /auth/bootstrap-status` | Check whether the one-time setup is still available and whether this deployment requires HTTPS. | `200 {"required":true,"requires_https":true}` |
| `POST /auth/bootstrap` | Create the first owner and household. One-time, rate-limited, idempotent. Body: owner name/email/password, household name/timezone/base currency. | `201 {"user":...,"household":...,"csrf_token":"..."}` + session cookie |
| `POST /auth/login` | Email/password. Rotate cookie and CSRF token. | `200 {"user":...,"household":...,"csrf_token":"..."}` |
| `POST /auth/logout` | Revoke current session. CSRF required. | `204` |
| `GET /auth/csrf` | Return a token bound to the current session. | `200 {"csrf_token":"..."}` |
| `GET /me` | Current user, active household, role, visible permissions, and capability flags. | `200 {"user":...,"household":...,"membership":...}` |
| `POST /households/{household_id}/invites` | Owner/admin invites by email and role; optionally set expiry. | `201 {"invite_id":"...","expires_at":"..."}` |
| `POST /invites/{token}/accept` | Accept invite for authenticated/new user; token is single use. | `200 membership` |
| `GET /households/{household_id}/members` | List active memberships visible to caller. | `200 collection` |
| `PATCH /households/{household_id}/members/{member_id}` | Change role or explicit shared-data grants; expected revision. | `200 membership` |
| `DELETE /households/{household_id}/members/{member_id}` | Revoke membership and sessions; jobs recheck access before commit. | `204` |

Bootstrap is disabled permanently after a household owner exists unless an explicit owner-only recovery procedure is used. Invite tokens are random, hashed at rest, short-lived, and not included in logs/referrers.

## 3. Accounts, categories, and ledger

### Accounts

| Method and path | Purpose |
|---|---|
| `GET /accounts?include_archived=false` | List accounts the caller may access, with subtype, currency, owner/visibility, latest balance/check status, and revision. |
| `POST /accounts` | Create bank, credit-card, cash, or settle-up account. Requires `Idempotency-Key`; name, subtype, currency, timezone/statement aliases, visibility. |
| `GET /accounts/{account_id}` | Detail and permissions-safe aliases. |
| `PATCH /accounts/{account_id}` | Edit name, subtype, card amount/date due, aliases, visibility, or active state; expected revision. Currency or timezone changes with activity still require a migration workflow. |
| `DELETE /accounts/{account_id}` | Owner retires an account from active lists; requires expected revision. Transactions, balances, and audit history remain. |
| `PUT /accounts/{account_id}/access/{member_id}` | Grant/revoke account access; owner/admin policy and audit. |
| `GET /accounts/{account_id}/statements?month=YYYY-MM` | Account/month opening/closing or amount owed, period movements, statement imports, coverage, unresolved count. Never synthesize a statement for cash or settle-up accounts. |
| `GET /accounts/{account_id}/balance-at?as_of=RFC3339` | Recompute account balance at an exact instant from the latest dated starting balance or check. Returns the anchor source and timestamp. |
| `GET /accounts/{account_id}/ledger?from=&to=&cursor=&limit=` | Account movements plus dated starting-balance and balance-check events, with the balance after each recorded instant. Date-only entries at the same instant share the after-group balance; inaccessible transfer details are redacted. |

Account response `balance` includes `amount`, `currency`, `basis` (`asset`, `amount_owed`, `cash_count`, `settlement_receivable`, `settlement_payable`), `as_of`, `complete`, and `coverage`. A missing opening value yields `complete:false`, not a guessed total.

A recorded balance check can anchor projections when the opening amount is unknown. For times before the check, the server subtracts intervening movements; for later times it adds them. The latest starting balance or observed check anchors displayed balances; check variance is independently calculated from the starting balance and recorded movements. Account balances identify whether they come from a starting amount, a check, or no anchor. A starting balance can be set or corrected at any date, with earlier transactions remaining visible.

### Categories and mappings

- `GET /categories?kind=expense|income|all&include_archived=false`
- `POST /categories` and `PATCH /categories/{category_id}` create/edit hierarchy, display name, kind, and parent. `DELETE` is not supported once referenced; use `POST /categories/{id}/archive` and `/restore`.
- `POST /categories/{id}/merge-preview` accepts `target_category_id`; returns affected transaction/allocation counts and budget/report consequences. `POST /categories/{id}/merge` applies the confirmed merge with expected revisions and audit.
- `GET /source-profiles`, `GET /source-profiles/{id}/category-mappings`; `PUT /source-profiles/{id}/category-mappings/{mapping_id}` maps source label + subcategory + event kind to a canonical category. Preserve raw labels. `PUT /source-profiles/{id}/account-aliases/{alias_id}` maps imported account names to accounts. Transfer counterpart aliases resolve to accounts, not categories.

### Transactions

`GET /transactions` accepts allowlisted filters: `account_id`, `account_type` (`bank`, `credit_card`, `cash`, `settle_up`), `member_id` (only if authorized), `category_id`, `event_type`, `reconciliation_state`, `from`, `to`, `q`, `cursor`, `limit`, `sort`. Account type matches any participating account leg, including either side of a transfer. Each item includes `id`, `event_type`, positive magnitude `amount`, `currency`, `effective_date`, description/merchant, category allocations, account movements, `entered_by`, payer/account owner if visible, `source_refs`, `revision`, and reconciliation status. Private names and evidence must not leak via aggregates or candidate text.

| Method and path | Purpose |
|---|---|
| `POST /transactions` | Create manual expense, income, refund, or transfer. Requires idempotency key. A transfer requires two different same-currency accounts and opposite equal movements. Expense/income allocations must balance to their magnitude. |
| `GET /transactions/{transaction_id}` | Detail with authorized provenance, allocations, movements, audit summary, and evidence links. |
| `PATCH /transactions/{transaction_id}` | Correct description/date/type/category/allocation/account movement; `If-Match` revision. Type conversion to transfer requires distinct accounts. Preserve original imported label and before/after audit values; invalidate affected reconciliation links and reports. |
| `POST /transactions/{transaction_id}/void` | Void, never hard-delete; reason required; expected revision and idempotency key. Preserve source history. |
| `DELETE /transactions/{transaction_id}` | User-facing delete; voids the event with a reason and expected revision, removes its active import occurrence link, and keeps audit/source history. |
| `GET /transactions/{transaction_id}/revisions` | Authorized before/after history; redact private source details. |
| `GET /transfers` | Canonical transfers counted once, with source/destination movements and linked observation status. Filters include account/month/status. |
| `GET /transfers/review-queue` | One-sided or ambiguous Money Manager transfer observations, visible only to authorized importer/account members. |
| `POST /transfers/review-queue/{item_id}/pair` | Explicitly pair counterpart observations/accounts; amount/currency invariants checked, idempotent. |
| `POST /transfers/review-queue/{item_id}/reject` | Reject a proposed pairing with reason; leaves observations available for independent review, never reclassifies as expense automatically. |

Changing a transaction from expense/income to transfer removes its category allocation from actuals and creates two account movements under one event; changing back requires a category/allocation and explicit movement account. Any accepted evidence link invalidated by the edit returns to reconciliation review.

## 4. Imports, source evidence, and jobs

| Method and path | Purpose |
|---|---|
| `POST /imports` | Create batch and upload multiple files via multipart. Parts: `manifest` JSON (source kind, optional owner/account/period per file) and `files[]`; returns per-file IDs and durable parse job. File max and batch limits are deployment-configured and enforced before storage. |
| `GET /imports` | Cursor-paginated authorized batch history. |
| `GET /imports/{batch_id}` | State, file outcomes, progress, warnings, coverage, and counts. |
| `GET /imports/{batch_id}/files/{file_id}` | File parse/map/preview metadata. Source bytes are retrieved through an authorized download route only. |
| `PATCH /imports/{batch_id}/files/{file_id}/mapping` | Choose parser/source profile, owner, account, date locale, amount/sign columns, category mapping, and period/coverage claim. Expected revision. |
| `GET /imports/{batch_id}/preview?file_id=...` | Paginated normalized observations, warnings, duplicate candidates, totals, rejected rows, and source coordinates. Preview has no ledger side effects. |
| `POST /imports/{batch_id}/commit` | Commit selected ready files/rows by account-scoped boundary. Requires expected batch revision and idempotency key. Bank statement uploads commit observations only; accepted Money Manager rows can create ledger events. |
| `POST /imports/money-manager/cleanup-preview` | With `period: YYYY-MM` or `YYYY`, list the caller's Money Manager transactions that would be voided and return a preview token. Mixed-source events are skipped. |
| `POST /imports/money-manager/cleanup` | Apply the exact preview token to void those events and release their occurrence links so a new upload can recreate them. Manual entries and bank observations remain. |
| `POST /imports/{batch_id}/files/{file_id}/retry` | Retry transient parse failure, idempotent. |
| `POST /imports/{batch_id}/files/{file_id}/omit` | Omit with reason; batch still reports incomplete coverage. |
| `POST /imports/{batch_id}/cancel` | Cancel cancellable work; committed file/account boundaries remain committed. |
| `GET /source-files/{file_id}/download` | Stream original for authorized source owner/account member with `no-store`, safe content disposition, and audit. |
| `GET /jobs/{job_id}` | Authorized job state/progress/error code/result link. |
| `GET /jobs/{job_id}/events` | Server-Sent Events (`text/event-stream`) for progress; only job metadata, no transaction text. Poll `GET /jobs/{id}` as fallback. |

Batch/file states: `uploaded → parsing → needs_mapping|needs_review → ready → committing → committed`; terminal `failed`, `cancelled`, or `omitted` states include safe error codes. Parsing and AI run asynchronously with bounded retry and restart recovery. Client disconnect does not cancel an accepted job. Multi-file commit returns one outcome per account/file; no partial transaction commit within a single selected account boundary.

Preview response must distinguish `expense`, `income`, `transfer_in`, `transfer_out`, `refund`, and `unknown`; include raw row reference, normalized dates, signed movement, category/account hints, validation issues, duplicate candidates, and proposed canonical action. Bank rows remain observations until a user accepts an explicit reconciliation action.

`GET /money-manager/changes?include_done=false&cursor=&limit=` lists authorized manual entries, manual corrections to imported transactions, statement-created entries, and applied amendments awaiting a Money Manager update. `POST /money-manager/changes/{transaction_id}/sync` accepts `{ "synced": true|false }` with the transaction revision and idempotency key. Completion is audited and does not alter ledger amounts or reconciliation revisions.

## 5. Reconciliation and balance checks

- `GET /reconciliation/sessions?account_id=&month=` lists/creates account-scoped review status and coverage.
- `POST /reconciliation/sessions` starts/reopens a session for one account and period; reason required to reopen a closed period.
- `GET /reconciliation/sessions/{session_id}/items?side=ledger|statement&state=&cursor=` independently paginates ledger movements and statement observations. Account identity and currency are hard matching boundaries except explicit cross-account transfer pairing.
- `GET /reconciliation/sessions/{session_id}/candidates?ledger_id=&observation_id=` returns candidate IDs, match signals, date/amount deltas, and safe explanation. It does not accept matches automatically.
- `POST /reconciliation/sessions/{session_id}/matches` explicitly accepts a selected group of ledger movements and observations; equal/partial allocated amounts must conserve value. Body includes selected IDs, allocation amounts, decision, and optional note. Requires idempotency and session revision.
- `POST /reconciliation/sessions/{session_id}/matches/{match_id}/reject` rejects a suggestion/accepted link with reason and revision.
- `POST /reconciliation/sessions/{session_id}/missing-ledger-entry` creates one confirmed ledger event from a selected observation atomically linked to it.
- `POST /reconciliation/sessions/{session_id}/corrections` applies explicit amount/date/account/type correction or fee event; preview impact before confirmation; preserve prior revision/evidence.
- `GET /reconciliation/sessions/{session_id}/duplicates` lists suspected duplicates with explainable evidence. `POST .../{candidate_id}/merge-preview` shows exact survivor, discarded duplicate, linked sources, allocations, and balance/report delta. `POST .../{candidate_id}/merge` requires explicit survivor and expected revisions; preserves both records' provenance and audit.
- `POST /reconciliation/sessions/{session_id}/close` records closing evidence, unresolved counts, ledger revision, and actor; a nonzero variance or unmatched rows require explicit explanation and remain visible as unresolved. `POST .../reopen` requires reason.
- Session `current` includes `balance_check_unresolved_count`; a check with a nonzero current variance or no computable starting balance counts as unresolved. Check corrections/removals change the session snapshot so a previously closed review becomes stale.
- `POST /accounts/{account_id}/balance-checks` records actual/provider balance, basis (`posted`, `current`, `statement_closing`, `cash_count`), as-of local timestamp/timezone, optional source observation, and expected account revision. Server calculates ledger balance at exactly the same cutoff and returns signed variance. Requires idempotency key.
- `GET /accounts/{account_id}/balance-checks?from=&to=` returns the manually entered check history, including removed entries, their historical snapshot, and the current computed amount and signed variance. A later ledger edit marks an old snapshot stale; it does not rewrite the historical check.
- `PATCH /accounts/{account_id}/balance-checks/{check_id}` corrects amount, basis, or timestamp with the check revision. `DELETE` on the same path removes the check from balance projection while retaining its audit history. Only the check creator or account owner may correct or remove it.

Candidate ranking can use AI, but all balance arithmetic and authorization are deterministic Rust domain logic. A match only links evidence; it does not change spending or balance. Missing-event creation, corrections, explicit duplicate merge, and transfer pairing do change projections and must return their exact impact.

## 6. Analytics, budgets, and exports

All report endpoints use the shared reporting policy and accept `scope=personal|family|combined`, `from`, `to`, optional `compare_from`, `compare_to`, `account_id`, `category_id`, `member_id` (authorized only), currency, and allowlisted dimensions. Require explicit periods or documented defaults. Responses echo canonical period boundaries, scope, filters, policy version, relevant revisions, coverage/completeness, and currency. Unknown coverage is never serialized as zero.

`GET /transactions?scope=personal|family|combined` applies the same allocation scope to the ledger list. Combined includes the signed-in member's personal allocations and shared family allocations, excludes other members' personal allocations, and returns each matching transaction once. The unspecialized `GET /transactions` remains available for full authorized ledger workflows.

| Method and path | Response purpose |
|---|---|
| `GET /analytics/summary` | Income, net spending, recorded surplus, unique transfer volume, budget status and unresolved counts; separate account-balance availability. |
| `GET /analytics/household` | Monthly per-member income, net spending, net invested, and expense categories for visible transactions and opted-in shared investment totals. Requires `from` and `to`; accepts `currency`. |
| `GET /analytics/series?grain=month|day&months=3|6|12` | Income/spending/net cash flow series and coverage per bucket; balance snapshots in a distinct series. |
| `GET /analytics/categories` | Category totals/share/change and drilldown cursor; refunds and Uncategorized retained. |
| `GET /analytics/income-categories` | Income totals by canonical category; clients can show parent and subcategory rollups. |
| `GET /analytics/types` | Recorded transaction counts and positive magnitudes by expense, income, refund, and transfer type. |
| `GET /analytics/merchants` | Ranked merchant totals/counts with period comparison and authorized drilldown. |
| `GET /analytics/accounts` | Per-account opening/closing or latest balance, signed movements, balance direction, coverage, reconciliation state and check variance. |
| `GET /analytics/transfers` | Canonical transfer volume once per event plus both account legs; never sum account legs as household transfer volume. |
| `GET /analytics/coverage` | Expense/income coverage by authorized account/member and period; permission-safe aggregates. |
| `GET /analytics/transactions` | Cursor drilldown using the exact report scope/filter/calculation. |
| `POST /analytics/exports` | Create CSV export job with bounded filters and policy version; returns job. Downloads are private, short-lived, authorized, and audited. |

Budgets:

- `GET /budgets?month=YYYY-MM&scope=personal|family` lists authorized plans; `POST /budgets` creates a draft plan with currency, month, scope, expected income, category limits and optional targets. A unique scope owner/currency/month plan is enforced.
- `GET /budgets/{id}` returns current revision, lifecycle, lines, and tracking; `PATCH /budgets/{id}` creates a new immutable revision with `If-Match` (does not overwrite history).
- `POST /budgets/{id}/activate`, `/archive`, and `/copy` perform explicit lifecycle transitions. Copy makes an independent draft of targets, never copies actuals or alerts.
- `GET /budgets/{id}/revisions` lists audit-safe plan snapshots; `GET /budgets/{id}/tracking?from=&to=` returns planned/actual/remaining/utilization, unbudgeted totals, per-line coverage and exact transaction links.
- `GET /budgets/{id}/people` returns visible expense/refund usage by explicit allocation destination. Legacy family allocations without a destination are Unassigned; personal usage belongs to the entering member. The response labels its account-visibility policy and does not imply complete household coverage. `budget_destination` on an expense/refund allocation accepts `shared`, `unassigned`, or a household user ID.
- `GET /budgets/{id}/allocations?category_id=&line_category_id=&destination=&cursor=&limit=` returns cursor-paginated expense/refund allocation rows for that plan's month, scope and currency. It uses the same account authorization as tracking and People, so private transactions are omitted for members without access. Refund amounts are negative; metadata includes the plan revision and report visibility. `line_category_id` selects the allocations counted under a budget line, including descendants for a pooled line; it cannot be combined with `category_id`.
- `GET /budgets/{id}/matrix?category_id=&line_category_id=&destination=` groups the same authorized expense/refund allocations by category and budget destination, returning exact net-spending cells and their sum. `category_id=uncategorized` selects allocations without a category. These cells show recorded usage, not additional allowances.
- A budget line may set `mode: pooled` to cover its category and descendants. Omitted or `exact` mode covers only the named category. A pooled line cannot coexist with a descendant limit in the same plan. Tracking folds posted spending and unmatched commitments into that line once; mode changes require a reviewed amendment.
- Optional `people_limits` on a family plan lists destination and amount pairs. When provided, their sum must equal the sum of category limits; duplicate or foreign-household destinations are rejected. The People response returns allowance and remaining for assigned limits. Personal plans derive the owner's allowance from category limits.
- `PUT /budgets/{id}/contribution-targets/{member_id}` sets member/month target with revision; `POST /budgets/{id}/contribution-links` links eligible canonical transfer amount and validates consumed amount does not exceed movement.
- `GET /budget-alerts?month=` lists in-app threshold alerts; `POST /budget-alerts/{id}/acknowledge` acknowledges for caller. Deduplicate by line, plan revision, threshold, and ledger revision.

Percentage changes are null with an explicit unavailable reason when baseline is zero or missing. For account selection, balances/amount-owed comparisons are snapshots, not spend deltas. Filtered analytics cannot be labeled as full-plan remaining. Every export must equal the corresponding authorized API drilldown.

## 7. AI provider configuration

Provider keys are write-only secrets. The app/backend, not the browser, contacts AI providers.

- `GET /settings/ai` returns provider IDs, endpoint labels, enabled tasks, model identifiers, key-configured boolean, secret revision, and safe limits; it never returns a key.
- `PUT /settings/ai/providers/{provider_id}` configures provider kind, validated endpoint, model IDs, tasks enabled, and request limits. Endpoint validation blocks loopback/link-local/private/cloud-metadata destinations except explicitly enabled local/LAN provider policy; prevent DNS rebinding and revalidate at connect time.
- `PUT /settings/ai/providers/{provider_id}/key` accepts `{ "api_key": "..." }` once over authenticated HTTPS, encrypts server-side using the mounted master key, then clears browser state. Response contains only `key_configured` and revision.
- `DELETE /settings/ai/providers/{provider_id}/key` removes key; `DELETE /settings/ai/providers/{provider_id}` disables/removes config after queued jobs are handled.
- `POST /settings/ai/providers/{provider_id}/test` uses bounded synthetic/non-sensitive prompt by default; it never sends bank statement text. Returns sanitized capability result, latency, model ID, safe error code.
- `PUT /settings/ai/tasks/{task}` assigns provider/model/revision and user or explicit household-use grants for `statement_extraction`, `column_mapping`, `reconciliation_assist`, or `category_suggestion`.
- `GET /settings/ai/usage?from=&to=` returns provider/model, task, timestamp, latency, token/cost estimates and safe result status; never prompt, transaction details, key, or extracted statement content.

Every extraction/reconciliation AI job captures configuration revision and allowed-use snapshot, rechecks permissions before execution/commit, and is cancelled or held if key/config/access is revoked. Cloud use requires task enablement and a just-in-time disclosure of which fields/source pages are sent. AI suggestions cannot directly mutate/accept ledger events or reconciliation links.

## 8. Operations, security, and implementation gates

- `GET /health/live` is process liveness only. `GET /health/ready` verifies migrations/database and required file volume without exposing secrets or financial values; rate-limit or protect detailed diagnostics.
- `GET /settings/household` and `PATCH /settings/household` control timezone, base currency, locale, and `family_only`. Enabling `family_only` atomically promotes personal allocations and budgets to Family and private accounts, categories, and planned expenses to shared household access. Existing shared budgets take precedence over colliding personal budgets, which are archived. Disabling it does not reverse the conversion. Money/currency changes with existing ledger events require an explicit migration plan.
- `POST /operations/backup` owner-only backup job; `GET /operations/backups` lists opaque manifest/status; `POST /operations/backups/{id}/restore` requires an explicit maintenance authorization and must never be reachable as an unauthenticated public route.
- CORS is disabled by default for same-origin NAS deployment. Configure proxy trusted hops explicitly; enforce request body, upload, page, CPU/time, and archive expansion limits. Reject path traversal, executable uploads, macros, and archive bombs. Serve source evidence as attachment with safe MIME handling.
- Apply per-user login and AI-test throttles; upload/job quotas; query date-range and export row caps. Log request ID, principal/household IDs, route template, status, and duration only. Redact cookies, CSRF, credentials, statement contents, source text, and query parameters containing secrets.
- Use SQL transactions for ledger+movement+allocation+audit, match decisions, duplicate merge, import commit boundaries, budget revision, and transfer pairing. No network/model call while holding DB transactions. SQLite foreign keys enabled on every connection; define WAL backup/restore behavior.

Implementation order: authentication/scopes and common errors → accounts/categories/ledger → jobs and Money Manager imports → household grants/budgets/analytics → bank observations/statements/reconciliation → AI configuration and assisted extraction → exports/backup hardening. Generate and validate OpenAPI in CI, compare generated TypeScript types for drift, and add route-level tests for authorization, idempotency, revision conflicts, money invariants, error envelopes, and mobile UI workflows. The static preview does not call these routes yet.

## 9. Core implementation payload conventions

The current executable contract chooses explicit request shapes where the target tables above describe semantics:

- Bootstrap: `{ "owner": { "name", "email", "password" }, "household": { "name", "timezone", "base_currency" } }`.
- Family members may set or correct a shared account's starting balance with `PATCH /accounts/{id}` containing only `opening_balance` and an optional `expected_revision` (or use `If-Match`). Other account settings remain restricted to the account owner.
- Account subtype values: `bank`, `credit_card`, `cash`, `settle_up`. Optional `opening_balance` contains a decimal `amount` and RFC 3339 `as_of`; card opening values represent amount owed. A starting balance can be edited with activity when dated no later than every active transaction and balance check. Changing account currency, subtype, or timezone with ledger activity remains blocked pending a migration workflow.
- Transactions contain `movements: [{ "account_id", "amount" }]` and `allocations: [{ "category_id", "amount", "scope" }]`; currency comes from the event. Null/omitted category means Uncategorized. Optional `effective_at` includes an offset; date-only records take effect at 10:00 AM in the account timezone. Supply the instant for intraday checks.
- Balance checks accept `amount`, optional matching `currency`, `basis`, RFC 3339 `as_of`, IANA `timezone`, and an expected account revision. Missing opening balances return null calculated balance/variance. Source-observation attachment is deferred.
- Budget lines are `{ "category_id", "amount" }`; `expected_income` is a decimal string. Copy requires a destination `month` and source revision.
- Account-access updates accept `granted: boolean` and expected account revision. Member mutations require their membership revision.
- Invite creation currently requires a client-generated cryptographically random 32-byte token, hex encoded in `token`; only its hash is persisted. The response remains `invite_id` and expiry. New-user acceptance supplies name/email/password and sets a session cookie. Bootstrap/acceptance retries issue fresh session credentials while preserving the created identity.
- Reports require explicit `from`/`to`; comparison periods are deferred. Family reporting currently includes only allocations whose full transaction accounts the caller may access, and labels that visibility restriction. Allocation-only sharing from private accounts remains a later milestone.

These are core-release limitations, not removals from the full target scope. The complete runbook and deferred feature list are maintained in the backend README.


### Reconciliation implementation payloads

The executable backend now implements account/month sessions, item/candidate reads, explicit partial matches, missing-entry creation, correction and duplicate-merge previews, close/reopen, and match rejection. See [reconciliation workflow](../backend/README.md#reconciliation-workflow) for complete request conventions and remaining limits. All decisions require session revision and idempotency; individual match allocations also require current ledger revisions. Signed allocation edges use `{ledger_id, ledger_revision, observation_id, amount}` and consume equal value on each side. Ledger IDs identify transactions within the session account.

Corrections use `mode: preview|apply`, `ledger_id`, `ledger_revision`, `changes`, and on apply `preview_token` plus `reason`. Duplicate decisions explicitly select `survivor_id`, `discarded_id`, and their revisions; apply requires the exact preview token. Added read routes `GET /reconciliation/sessions/{id}` and `GET /reconciliation/sessions/{id}/matches` expose current status and retained decisions. Closure requires `closing_evidence` and an explanation; stored movement variance is distinct from an observed balance-check variance. Unknown coverage remains unknown even with no unmatched rows. Fee events use ordinary ledger creation or the missing-entry workflow; rejected unaccepted suggestions are not persisted. Full-transaction account visibility remains the current privacy policy.

Account responses for bank, cash and investment-cash accounts include `funds`: `available`, `reserved`, `emergency_reserved`, `other_reserved`, `reservation_shortfall`, and a `goals` breakdown. The original `balance.amount` remains the full recorded ledger balance. Active goal allocations reserve against this balance: percentages use the full positive balance, fixed reservations retain their requested amount, and covered reserves are capped collectively at the positive balance. Emergency goals receive coverage first if later spending leaves a shortfall. Available funds equal recorded balance minus covered reserves; unknown balances remain unknown. Archived goals release their reservations. Reservations neither create expenses nor alter reconciliation or ledger entries. Private goals on an accessible shared account affect available funds but expose only a generic name and no goal identifier. Dashboard and account cards use available funds; account details show recorded, reserved and remaining funds separately. Separate emergency-fund holdings appear outside regular investment totals.
