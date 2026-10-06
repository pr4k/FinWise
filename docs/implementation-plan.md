# FinWise detailed implementation plan

Implementation update: a runnable Rust core now exists; see [backend coverage](../backend/README.md). Authentication, manual ledger, account access, basic analytics/budgets, dated balance checks, and deterministic Money Manager XLSX/bank CSV imports are implemented and tested with synthetic files. Deterministic reconciliation now includes partial matches, correction/duplicate-merge previews, atomic missing-entry creation, and closure snapshots. The connected import interface and supplied Money Manager workbook now pass local acceptance checks; advanced reconciliation UI, broader real-source validation, granular shared-allocation access, AI, exports, and NAS release validation remain pending.

Status: responsive front-end preview and several backend slices are implemented; the milestones below remain the target release plan. SQLite is confirmed for v1. Read with [architecture.md](architecture.md) and the [analytics and budget module specification](analytics-and-budgets.md).

## Progress tracker (2026-09-30)

This tracker marks delivered code, not milestone acceptance. A milestone is **partial** until its UI, real-file/device validation, and release checks pass. See [backend/README.md](../backend/README.md) for route-level coverage and limitations.

- [x] Rust/Axum server, SQLite migrations, authentication, CSRF, account permissions, audit events, OpenAPI and generated TypeScript API types.
- [x] Manual ledger for expense, income, refund and transfer; account balances and dated balance checks; basic reports and monthly budgets.
- [x] Durable multipart imports, Money Manager XLSX and bank CSV parsing, saved source mappings, preview, exact-overlap reuse, reciprocal transfer pairing, idempotent commit, source evidence download, and parse-job progress/recovery. Tested with synthetic fixtures.
- [x] Account/month reconciliation API, immutable bank observations, deterministic candidates, value-conserving partial matches, rejection, correction/duplicate-merge previews, missing-entry creation, stale closure detection, and access-safe retries. Synthetic integration tests only.
- [x] Container/Compose baseline and SIGTERM shutdown; Compose configuration validated. Image build/runtime and NAS acceptance remain unverified.
- [x] Connect the static responsive frontend to authenticated backend routes for import mapping/preview/commit, accounts, transactions, budgets, analytics, statements, and basic reconciliation. Browser acceptance uses an isolated temporary database.
- [ ] Complete split transaction editing, advanced reconciliation decisions, family workflows, and responsive device acceptance.
- [ ] Validate adapters and totals against redacted real exports, including the 71-row Money Manager sample and target bank/card formats.
- [ ] Validate bank/card reconciliation against real statements, complete shared-allocation access, advanced analytics and alerts, PDF/AI, exports, backups, and NAS release checks.

| Milestone | Status | What remains before acceptance |
|---|---|---|
| M0 — formats and design | Partial | Real export fixtures, NAS profile, ADRs, supported-format matrix. |
| M1 — foundation | Partial | Svelte app, container build/runtime acceptance, full job leasing/retry policy, browser and NAS checks. |
| M2 — ledger | Partial | Production transaction screens, settlement obligations, query/index validation, full UI checks. |
| M3 — import and dashboard | Partial | Real-export validation, import wizard, source-aware category UI, full dashboard and undo/correction flow. |
| M4 — family and budgets | Partial | Beneficiary privacy, responsibility splits, contribution links and family UI. |
| M4A — analytics | Partial | Full metric/coverage policy, comparisons, pacing, alerts, charts and exports. |
| M5 — reconciliation | Partial | Deterministic matching, corrections/duplicate merges, closure snapshots and dated balance checks exist; review UI, provider closing-balance verification, broader formats and real-file validation remain. |
| M6 — PDF and AI | Not started | PDF/OCR adapters, optional AI providers, secret handling and evaluation. |
| M7 — NAS release | Partial | Docker/Compose baseline exists; image/runtime validation, backup/restore, export, benchmarks and NAS release validation remain. |

## 1. Delivery strategy

Build vertical slices that can run on the NAS at every milestone. The first usable slice imports a real Money Manager export and shows correct monthly totals. The first complete release adds independent partner access, family budgets, statement reconciliation, and optional AI extraction.

Current preview baseline: `web/index.html`, `web/styles.css`, and `web/app.js` provide Overview, Analytics, Transactions, Categories, Accounts, Statements, Budgets, Imports, Reconcile, and AI Settings screens with phone/tablet/desktop layouts. The Categories and Statements views use sanitized structural/sample data. The baseline uses client-side-only interactions and is not connected to the Rust/SQLite API. The backend now has a synthetic-fixture-tested Money Manager XLSX and bank CSV adapter; the UI and remaining milestones still need real workflows.

Mobile responsiveness is required throughout v1, not a final styling pass. Each UI milestone includes phone, tablet, and desktop layouts and the architecture's responsive acceptance checks. Existing estimates remain provisional and include responsive work; re-estimate after the initial responsive shell and device checks.

Critical path: sample validation → ledger and permissions → deterministic imports → useful personal reports → family budgets → analytics and budget tracking → deterministic reconciliation → PDF/AI extraction → release hardening.

Effort estimates below are planning ranges for one experienced developer working full-time, including normal testing. Total: roughly **20–30 engineer-weeks**, with a useful personal dashboard in approximately 5–8 weeks. This includes expanded analytics and budget tracking, account-wise balance/flow insights, account-specific multi-statement/reconciliation workflows, daily balance checks, and source-aware category editing. Bank format diversity, model quality, and NAS compatibility are the largest uncertainties. Re-estimate after the sample spike; these are not committed delivery dates. Part-time elapsed time will be longer.

## 2. Decisions to confirm during discovery

| Input | Proposed default | Consequence if different |
|---|---|---|
| Money Manager vendor/platform/export | CSV/XLSX adapter after sample inspection | May require legacy XLS, localized headers, or different transfer rules. |
| Banks and statement formats | First two actual banks; structured exports before PDFs | More layouts increase extraction work, especially scans. |
| NAS CPU/RAM/container support | Linux amd64/arm64 with Docker-compatible runtime | Older ARM or restricted appliances may need separate hosting. |
| AI privacy | Disabled until configured; local preferred, cloud opt-in | Cloud support needs provider configuration and data-transmission controls. |
| Currency | Single household reporting currency in v1 | Multi-currency materially expands ledger and reconciliation scope. |
| Partner privacy | Private account evidence; explicitly shared family allocations | Fully pooled finances can simplify visibility configuration. |
| Budget style | Monthly category limits and contribution targets | Envelope budgeting and detailed cash forecasting are later features. |

Collect redacted examples: one normal month from each partner, overlapping exports, one edited re-export, bank CSV/Excel, a text PDF, and a scanned PDF if relevant. Preserve representative dates, signs, duplicate rows, and formatting while replacing identifying details. Samples are implementation inputs, not a prerequisite to reviewing this plan.

## 3. Repository structure

```text
FinWise/
  Cargo.toml
  crates/
    finwise-domain/       # Money, event invariants, policies, matching logic
    finwise-app/          # Use cases, transactions, permissions, orchestration
    finwise-infra/        # SQLx repositories, files, import and AI adapters
    finwise-server/       # Axum routes, auth, jobs, static frontend serving
  web/                   # SvelteKit static app and generated API types
  migrations/            # Versioned SQLite migrations
  fixtures/              # Synthetic/anonymized files + expected results
  tests/                 # Cross-module and API integration tests
  deploy/                # Dockerfile, Compose, sample config
  docs/                  # Architecture, ADRs, user and contributor guides
  .github/workflows/     # CI and release workflows
```

Domain code must not depend on Axum, SQLx, or a specific AI vendor. Adapters implement narrow interfaces. Start with modules inside these crates; avoid creating a crate per feature. Generate frontend types from the API schema and check drift in CI.

## 4. Milestone 0 — validate formats and lock design decisions

Estimate: 0.5–1 week. Dependencies: access to representative formats and hardware specifications.

Tasks:

1. Inspect exports for row structure, date locale, currency precision, account names, stable transaction IDs, transfer representation, and category hierarchy.
   Include examples for bank/debit, credit card, cash, and friend-settlement accounts; record each statement file's account identity, statement period, pending/posted behavior, card payment lines, and any split/repayment conventions.
2. Build a fixture manifest with expected row counts, sums, duplicate multiplicities, and statement balances. Record unknowns instead of inventing expected totals.
3. Run small parser spikes for the actual Money Manager export and two bank formats. Test PDF text extraction before choosing OCR dependencies.
4. Record NAS architecture, available RAM, filesystem, reverse proxy, and backup destination. Distinguish app hardware from optional AI hardware.
5. Write ADRs for SQLite, static Svelte, ledger/evidence separation, family allocation semantics, currency scope, and AI opt-in behavior.
6. Agree the initial license candidate and supported-format matrix. Confirm dependency and PDF/OCR redistribution constraints before committing to bundled tools.

Acceptance: every v1 source has a fixture and a stated support level; ambiguous signs, dates, transfers, and duplicate rules are documented; hardware assumptions are explicit.

Deliverable: fixture pack, adapter specifications, ADRs, revised estimates. Unknown bank formats may remain unsupported but must not silently pass as supported.

## 5. Milestone 1 — executable foundation and access controls

Estimate: 1–1.5 weeks. Depends on M0 design decisions.

Tasks:

1. Scaffold Rust workspace and SvelteKit static build; serve UI and `/api/v1` from Axum. Implement the [HTTP API contract](api-spec.md), publish OpenAPI 3.1, and add generated TypeScript client types with CI drift checks. Add typed configuration, structured errors, request IDs, and secret redaction.
2. Create migrations for users, households, memberships, sessions, account permissions, jobs, and audit events. Enable foreign keys per connection and configure WAL/busy handling.
3. Implement one-time bootstrap, login/logout, expiring invites, session revocation, CSRF protection, secure cookies, and password hashing.
4. Introduce a request authorization context and household/account-scoped repository interfaces. Background jobs must use an equivalent authorization policy and recheck permissions before committing.
5. Add durable job leasing, heartbeat, retry/backoff, cancellation, and progress events. Prove recovery after process restart before adding expensive extraction work.
6. Add container build, local development Compose, health/readiness endpoints, lint/type-check CI, and a migration test database.
7. Build the responsive application shell, phone bottom navigation, desktop sidebar, shared accessible form/sheet/dialog components, safe-area spacing, and viewport test harness. Verify navigation and forms at 320, 390, 768, 1024, and 1440 px before expanding screens.

Current code supplies the visual responsive shell and screens. This milestone remains responsible for replacing the temporary static preview with the chosen Svelte application, Rust-served assets/API, and shared production components.

Acceptance: a fresh NAS deployment can bootstrap, create two logins, restart without losing data, serve direct frontend routes, and deny unauthorized access to another user's records. API failures never return the SPA fallback.

Validation: API tests for session lifecycle, CSRF, cross-household access, private evidence access, expired invites, concurrent bootstrap attempts, and job restart/lease recovery. Build the production frontend, not just the development server.

## 6. Milestone 2 — canonical ledger and transaction screens

Estimate: 2–2.5 weeks. Depends on M1. Includes the distinct balance and event behavior for bank, credit-card, cash, and friend-settlement accounts.

Tasks:

1. Implement checked Money/currency/date types and event constructors for expense, income, transfer, refund, and opening balance.
2. Add accounts, categories, transactions, movements, allocations, revisions, and audit migrations with integrity constraints.
   Define account subtypes and rules for bank assets, credit-card liabilities, cash balances, and friend-settlement receivable/payable clearing accounts. Model cash counts, immutable end-of-day balance checks, and open settlement obligations explicitly; do not count card repayments or IOU repayments as spending.
3. Implement manual create/edit/void and expected-revision conflict handling. A mutation and its audit event must commit together.
4. Build paginated transaction list, filters, detail drawer, category editing, split allocation editor, and evidence placeholders. Show “Entered by” member attribution, distinct from account owner/payer, on every row and detail; audit the creator and later editors.
   Provide phone transaction cards and full-page detail/split editors with complete amounts, labels, and explicit batch-selection controls.
5. Implement monthly income/spending/category queries using authorized allocations. Keep cash flow, spending, and account balance calculations distinct.
6. Add indexes and query plans for household/account/date filtering. Preserve unknown opening-balance state in responses.
7. From the reconciliation workspace, expose authorized create/edit/void actions for the selected tracked transaction. Reuse ledger validation, revision checks, permissions, and audit events; edits invalidate affected bank-match links for review, and voids remain visible in history.

Acceptance: transfers and card repayments do not inflate expenses; refunds reduce the correct category; split totals equal the expense; editing a stale revision returns a conflict. Reports equal a hand-calculated fixture.

Validation: property tests for money overflow and allocation conservation; domain tests for refunds/transfers/rounding; DB tests for constraints and rollback; frontend check for large amount strings without JavaScript precision loss.

## 7. Milestone 3 — Money Manager import and personal dashboard

Estimate: 3–4 weeks. Depends on M2; this is the first personal-use release and includes source-aware category management.

Tasks:

1. Add private file storage, scoped hashes, batches, raw rows, normalized observations, source profiles, and account/category aliases.
   A batch may contain multiple files for different accounts/periods; retain a per-file job, mapping, status, source reference, and idempotent commit outcome.
2. Implement generic CSV mapping and a versioned adapter for the attached Money Manager XLSX shape. Preserve Excel serial dates/times, emoji and raw category labels, optional subcategories, notes, description, and row provenance. Validate INR/Amount; in this sample the third numeric column is ambiguously headed “Accounts” but duplicates Amount on all 71 rows, so flag and ignore it as an account field.
   Treat `Income/Expense` values as event type. In the sample, Category means an expense/income label for `Exp.`/`Income`, while all 14 transfer rows use a Category label matching an account name; resolve it as the transfer counterpart account. Across all staged files, automatically pair Transfer-In and Transfer-Out into one transfer event with two account movements only when account aliases are reciprocal, amount/currency match exactly, timing is inside the configured window, and the candidate is unique. Retain both source observations. Keep one-sided or ambiguous transfers in a dedicated review queue; never map them to expense categories.
3. Build multi-file upload wizard: source/owner → choose multiple statements → per-file account/period/locale mapping → per-file preview and balance checks → account-scoped commit summary.
   Include phone multi-select file picker, file queue and independent retry/omit, stacked mapping/preview layouts, interrupted-upload retry, and recovery of server-side job progress after browser backgrounding.
4. Implement same-file detection, stable-ID matching where available, multiplicity-aware overlap detection, and review of changed/ambiguous rows.
5. Implement idempotent transactional commit from accepted source observations to ledger events; retries return the previous outcome.
6. Add dashboard totals, category breakdown, monthly trends, import freshness, and unverified coverage indicators. Link each event to its original source row.
7. Build a first-class Categories screen with editable canonical categories and source mappings. Show transaction counts, event kind, source/subcategory labels, and mapped category; support create, rename, parent, archive/restore, merge preview, search, and bulk recategorization preview.
   Keep mappings by source profile + source label + subcategory + event kind. `Other` appears as both expense and income in the sample and must map separately. Transfer-counterpart mappings live under account mappings, never in budget categories.
   Editing an import mapping changes future imports only. Changing existing transactions requires a separate impact preview and explicit confirmation. Preserve original labels and use stable category IDs so display renames don't break history.
8. Surface paired transfers in a separate Transactions view/filter, showing source account → destination account, paired source rows, and status. Transfers change account balances, but not expenses, income, or budgets.
   Let authorized users edit a tracked transaction's event type, including reclassifying an expense/income as an internal transfer. Require distinct source and destination accounts; preview both account balance effects and the change to spending/budget totals, then commit as an audited revision. Preserve the original Money Manager row and category as provenance. If bank evidence is already linked, invalidate that match for review rather than silently carrying it across a type change. The type edit must not create a second ledger event.
9. Provide controlled undo for an untouched batch and a reviewed correction path for batches with later edits or links.

Acceptance:

- Import the same file twice: totals and event count remain unchanged.
- Import overlapping or reordered periods: known occurrences are reused; new occurrences appear exactly once.
- Two genuinely identical purchases survive deduplication.
- Invalid dates, currency, signs, and unknown accounts appear as actionable row errors.
- A crash during commit leaves either the complete accepted commit or no ledger changes.
- Dashboard totals match fixture totals by month and category.
- Sample fixture yields 71 rows, 7 account labels, 22 distinct Category labels, 7 populated subcategory cells, 54 expenses, 3 income rows, and 14 transfer rows; no transfer contributes to budget spending.
- The final duplicate “Accounts” column is flagged as suspicious and never overwrites account identity. A filename suggesting Sep 30 does not make rows ending Sep 21 complete coverage.
- Source category edits, event-kind-specific mappings, and transfer account mappings remain distinct; future remapped imports preserve original provenance.

Deliverable: tagged personal preview build with install instructions and supported export formats. No AI dependency is needed to use it.

## 8. Milestone 4 — couple/family mode and monthly budgets

Estimate: 1.5–2.5 weeks. Depends on M3.

Tasks:

1. Complete partner invitation/onboarding, account visibility controls, joint accounts, and member-specific import mappings.
2. Add explicit personal/family allocations and payer/beneficiary responsibility metadata. Shared allocations expose only permitted fields and evidence.
3. Implement Family overview, shared transaction creation, personal/family monthly budget plans, leaf-category limits, planned income, contribution targets, and budget-versus-actual views using the shared reporting policy.
4. Support equal, percentage, and fixed responsibility splits with deterministic minor-unit rounding; add optional settlement recording as transfers.
5. Detect possible same-expense records across partner imports and provide a reviewed merge/link flow. Protect source evidence permissions during merge.
6. Add draft/active/archived plan states, next-month copying into an independent draft, overspend/unbudgeted indicators, expected-revision edits, and immutable plan history. Keep carryover off for v1.
7. Link realized contributions explicitly to eligible transfers into shared funds; keep direct family spending, responsibility shares, and settlement balances separate.
8. Build phone budget cards and stacked family split/contribution forms; verify that the keyboard and sticky navigation cannot obscure amounts, errors, or save controls.

Acceptance: one shared ₹3,000 expense appears once in Family spending; two ₹1,500 responsibility shares sum correctly; a partner settlement changes obligations but not spending. Personal transactions remain absent from partner searches, dashboard totals, exports, and source downloads.

Validation: two-session browser test for each partner's view, mixed personal/family splits, revoked permissions, same expense imported by both members, and parent-category rollup without double counting.

### Milestone 4A — analytics and budget tracking

Estimate: 3–4 weeks. Depends on M3 imports and M4 family permissions/budget lifecycle. This milestone is required for v1; basic personal summaries still ship in M3. Detailed behavior is defined in [the module specification](analytics-and-budgets.md).

Tasks:

1. Implement a shared reporting policy and typed filter/metric contracts for effective dates, currency, authorized allocations, refunds, comparisons, and snapshot revisions. Add coverage claims for expense/income periods; never infer completeness from latest transaction date.
2. Build indexed SQLite aggregate queries and APIs for summary, monthly/daily series, categories, merchants, family payer/responsibility breakdowns, per-account balances and signed period movements, transfer volume, and exact transaction drilldowns. Keep recorded surplus distinct from account balances.
3. Build Analytics navigation/screens with scope, period, and account selectors; insight types for income, spending, trends, account-wise balances/flows, transfers, family/payer, and data quality; plus ranked bars, trend lines, accessible table equivalents, and authorized report exports. Handle missing periods, zero comparison baselines, and incompatible filtered-budget comparisons explicitly.
4. Implement budget tracking calculations including negative actuals, zero limits, unbudgeted categories, total remaining, and original-versus-current plan variance. Add complete-month historical suggestions with acceptance before saving.
5. Add coverage-gated current-month pacing with explicit cutoff and assumptions. Suppress projections and “on track” labels for incomplete or stale coverage.
6. Add configurable in-app thresholds, deduplicated alert evaluation after committed changes, acknowledgement, refund resolution, and revision-safe reopening. Keep notification access aligned with plan visibility.
7. Ensure imports, refunds, recategorization, date/scope edits, plan revisions, and permission changes update every affected metric and alert. Use SQL aggregates first; introduce caches only if benchmarks justify them.
8. Extend portable exports and user documentation with reporting policy, coverage, comparison ranges, budget revisions, and contribution semantics.
9. Validate stacked phone charts/cards, touch-accessible values, equivalent data tables, filter sheets, and drilldown navigation. Desktop hover must not be the only way to read chart data.
10. Verify each account's `opening + signed movements = closing` independently; test credit-card owed balances, cash, ATM/card-payment transfers, unknown openings, transfer de-duplication in household totals, account-scoped coverage, and privacy-safe payer/member details.

Acceptance: the specification's ₹10,000 grocery budget example yields ₹4,500 actual, ₹5,500 category remaining, and 45% utilization everywhere; with ₹800 unbudgeted spending, overall remaining is ₹4,700. Missing exports never imply zero spending. Dashboard, budget, drilldown, and export agree at the same ledger revision. Transfers, duplicate imports, and accepting evidence matches do not inflate actuals.

Validation: golden aggregate fixtures; zero/negative/division cases; late refunds; leap-month comparison boundaries; mixed allocations; plan copy/revision isolation; concurrent edits; privacy checks for charts/coverage/alerts/exports; browser drilldown agreement; indexed-query p95 measurements against the standard 100,000-event profile. Add reconciliation-trigger integration checks in M5 once those actions exist.

Deliverable: usable Analytics and Budget Tracking screens with API contracts, permission-safe exports, documented calculation rules, and in-app alerts. Rollover, recurring commitments, and savings goals remain outside this milestone.

## 9. Milestone 5 — statement matching and daily balance reconciliation

Estimate: 3–4 weeks. Depends on M3 and M4 visibility policy; integrate ledger-change notifications and reporting checks from M4A.

Tasks:

1. Implement initial bank/card CSV/XLSX adapters; map each file to a canonical bank or credit-card account and normalize liability/debit/credit conventions. Support batches spanning multiple accounts and periods.
2. Store statement coverage, transaction/posted dates, references, opening/closing balances where present, and immutable observation revisions separately per source file and account. Do not add statement rows directly to spending totals.
3. Implement candidate generation, deterministic scoring, competing-candidate detection, and one-to-one assignment. Index candidate queries and bound time windows.
4. Add accepted link/group tables with consumed-amount constraints, row revisions, and reject history so dismissed proposals do not repeatedly reappear unchanged.
5. Build reconciliation workspace as two independently filterable/selectable panes: left canonical ledger items and right statement observations, each with its own unmatched/matched state. Keep a pinned comparison panel showing selected transaction details, signed amounts, dates, account, currency, balance/reference, source evidence, difference calculations, and why the candidate was suggested.
   Provide explicit select-on-each-side then Match, compare-next, reject, create-missing, correction, and multi-select split/group actions. Do not consume either row until the user confirms. Add keyboard actions and filters for Matched, Bank-only, Ledger-only, Conflict, Ambiguous, and Excluded.
   On phones show Ledger and Statement as switchable lists with the active comparison pinned and discrepancies visible; preserve selections while switching sides. Include the same workflows at tablet and desktop widths.
6. Implement atomic accept, reject, create-missing, correct-and-rematch, explicit fee creation, exclusion-with-reason, and undo actions.
   Add a possible-duplicate queue across ledger events/import observations. Before merging, show candidate events, account/currency/direction compatibility, member attribution, source evidence, retained canonical event, and effects on account balances, budgets, and accepted links. Require explicit confirmation; preserve both source records and audit history, and make unsafe cross-account/currency merges unavailable.
7. Add bounded one-to-many and many-to-one group suggestions with exact sum checks and manual confirmation; cap group size/search budget to avoid exponential scans.
8. Implement daily balance checks per account: enter a verified starting/opening balance and provider's posted/current balance plus as-of time; calculate `opening + signed posted ledger movements through cutoff`, show exact `actual - calculated` variance and likely causes, and retain immutable revisioned history. If opening balance is unknown, show the projection as incomplete.
   In the reconciliation workspace keep a live staged projection while the user reviews actions. Let authorized users add, edit, or void a tracked ledger transaction in the left pane; these use the normal ledger workflow, and the top calculated balance/variance updates immediately. Evidence-only match/unmatch changes transaction coverage but not account balance; confirming a missing event, correction, or duplicate merge updates the calculated balance and variance immediately. Clearly mark staged versus committed results, and never create a balancing adjustment automatically.
9. Build Monthly Statements: select bank, card, cash, or settle-up account and month; show per-period activity, opening/closing values where defined, import source/coverage, and a route to reconciliation. Do not label cash/settlement activity as provider-issued statements.
10. Keep provider available balance separate from posted balance. For cards support current amount owed and statement closing balance as distinct comparison bases; for cash record counted balance; for settlement accounts show per-counterparty obligations instead of a bank-balance check.
11. Implement close/reopen, transaction-coverage and balance-check status indicators, and revisioned closure snapshots. Late edits mark affected later checks stale instead of rewriting them.
12. Verify the phone Ledger/Statement switch preserves the selected pair and discrepancy summary; keep Match/Compare reachable while each side is reviewed. Make statement month/account selectors, end-of-day amount entry, and variance review usable above the mobile keyboard.

Acceptance examples:

| Case | Expected behavior |
|---|---|
| One tracked purchase, one bank debit | One expense with an accepted evidence link. |
| Multiple statement files for bank and credit card | Each file previews/maps to its own account and period; a failure or retry in one file does not commit it twice or discard other previews. |
| Overlapping monthly statements for one card | Shared rows retain both file references and are counted/consumed once per card account. Similar transactions on separate accounts are never merged automatically. |
| Card purchase and bank card payment | Card purchase is the expense; card payment matches as a transfer between bank and card accounts, never against the purchase. |
| Money Manager internal transfer | A unique reciprocal Transfer-Out/Transfer-In pair is automatically linked into one transfer; both account balances update and spending/budget totals do not. Ambiguous or one-sided rows wait for review. |
| Cash activity | Cash spending does not appear as bank-only; compare against a dated cash count and show any difference explicitly. |
| Friend settles a shared meal | Expense is recorded once; the friend's share creates a receivable/settlement obligation; repayment clears it without adding income/spending again. |
| Desktop reconciliation | Select one left and one right row; comparison panel shows signed amounts, date gap, source, member who entered the ledger item, and delta before explicit match. |
| Duplicate resolution | A probable duplicate is review-only until confirmed; preview shows both source/author histories and projected balance/budget impact, then retains one canonical event with both provenances. |
| Phone reconciliation | Switch sides without losing the selection; compare and confirm remains reachable and readable. |
| End-of-day check | Enter a known starting balance and actual posted bank/card balance with as-of time; exact ledger variance is shown, an unresolved difference prevents clean status, and saving preserves the observed snapshot. Unknown starting balance remains explicitly incomplete. |
| Live projection | Pairing statement evidence leaves calculated balance unchanged; staged missing-event, correction, and duplicate-merge actions show their exact account-balance and actual-minus-calculated variance effect before commit. |
| Edit own tracked item | Add/edit/void an authorized ledger transaction from the tracked side; projected balance and variance change by the correct signed amount, affected accepted matches return to review, and voided source history remains auditable. |
| Reclassify transaction type | Convert expense/income to internal transfer and back; require two distinct accounts, update per-account movements, remove/add category spending and budget actuals correctly, invalidate incompatible bank matches, and retain source/category/edit audit history. |
| Reconciliation header | Before reviewing rows, show account, starting-balance date/value, actual-balance date/value, calculated balance, and signed difference; changing a staged ledger event refreshes the projection immediately. |
| Statement closing balance | Compare against ledger at the statement period cutoff, not today’s ledger total; posted/current and available values remain separate. |
| Monthly statements | Select a bank, credit card, cash, or settle-up account and month; see that period's source/coverage and activity, with correct opening/closing semantics. A missing file is shown as missing, not as zero activity. |
| Available balance | Display separately; never silently compare it to posted ledger balance as though they were the same basis. |
| Late correction | Earlier snapshots remain unchanged; later affected checks are marked stale and can be rerun. |
| Bank-only charge | Creating missing entry adds one expense; retry adds none. |
| Same amount, nearby dates, two candidates | Ambiguous; no automatic acceptance. |
| One bank debit, two tracked splits | Reviewed exact-total group; no duplicate consumption. |
| Fee or wrong recorded amount | Explicit correction/fee or unresolved difference. |
| Pending entry later posts | Preserve provenance and link/update via reviewed transition, not a second expense. |
| Cash expense or date outside coverage | Shown as outside bank verification scope. |
| Two concurrent accept actions | One atomic success, one conflict. |
| Incomplete statement or missing balances | No unsupported “fully reconciled” claim. |

Validation: labeled matching corpus with precision/recall reporting; accounting conservation tests; concurrency and retry tests; overlap coverage tests; closed-period edit invalidation. In this milestone all match proposals require user acceptance.

## 10. Milestone 6 — PDF extraction and optional AI assistance

Estimate: 2.5–4.5 weeks. Depends on M5 and PDF/OCR spike.

Tasks:

1. Add text-PDF extraction with page references and deterministic templates for supported banks. Add isolated OCR only when fixtures require scans.
2. Add transient password handling for encrypted PDFs, page limits, subprocess timeouts, safe temp files, and cleanup after success/failure.
3. Define provider-neutral extraction/ranking request and response schemas. Implement local Ollama and one API-key-based cloud adapter after selecting a provider during implementation; local inference is optional for users choosing cloud setup.
4. Build Settings → AI Providers: select provider, paste API key, choose extraction/reconciliation models, test with synthetic data, save, replace/remove key, and enable each feature independently. Add user-owned configurations with explicit household-use grants, write-only secret APIs, encrypted SQLite credential storage with a separately mounted master key, and sanitized usage/error reporting. Implement the architecture's endpoint controls, configuration revision checks, and queued-job revocation behavior. Show source data transmission scope before cloud jobs.
5. Implement schema validation, source-span evidence, normalized row checks, balance/totals verification, uncertainty flags, bounded retries, and resumable jobs.
6. Build extraction review grid synchronized with original page/row evidence. Permit correction of extracted fields without modifying original artifacts.
7. Add optional merchant/category suggestions and difficult-match ranking constrained to authorized candidates. Preserve deterministic invariants after AI output.
8. Store model/prompt/schema versions and build an evaluation report by bank/layout/model. Avoid treating model self-reported confidence as verified accuracy.
9. Verify provider selection, API-key paste/reveal, model selection, connection test, save, and replacement on phone layouts with the virtual keyboard open. The responsive form must retain the same write-only secret behavior as desktop.

Acceptance: supported test statements reproduce exact monetary amounts and directions; low-quality scans, missing pages, unsupported layouts, and schema errors require review. A malicious instruction inside statement text cannot invoke tools, disclose secrets, or mutate the ledger. Disabling AI leaves structured imports and manual reconciliation fully usable.

Validation: fixture-level exact numeric/date comparison, extraction coverage checks, injected statement instructions, timeout/restart behavior, local provider outage, cloud opt-out with outbound-call assertions, cost caps, and evidence visibility under both user accounts. Test the complete paste-key → test → save → extraction/reconciliation flow with a mock provider, key replacement/removal, invalid credentials, model capability failures, shared-use permissions, endpoint/redirect controls, and queued-job revocation. Assert that secrets never appear in configuration reads, exports, browser persistence, job payloads, or logs. Test credential recovery with and without the deployment master key. No real user statements or provider keys in CI.

Exit gate: publish supported layouts and measured extraction results. If AI accuracy is insufficient, ship the feature as assisted/manual review; do not compensate by silently loosening checks. Automatic matching remains deferred until a separate precision evaluation justifies it.

## 11. Milestone 7 — NAS release and open-source readiness

Estimate: 2–3 weeks. Depends on all v1 features; operational work begins in M1.

Tasks:

1. Publish reproducible amd64/arm64 images, versioned Compose examples, health checks, non-root runtime, persistent volume permissions, and optional AI/OCR profiles.
2. Implement consistent DB+evidence backup with manifest, retention policy, encrypted destination guidance, and a restore command/runbook. Coordinate file garbage collection with backups.
3. Test upgrades from the prior release. Back up before migrations; document that rollback may require restoring the pre-upgrade backup rather than running old code against a new schema.
4. Add portable JSON/CSV export of ledger, allocations, budgets, and provenance metadata. Export is not a substitute for full backup; document both.
5. Complete upload/parser limits, CSV formula-safe exports, permission review, log scrubbing, dependency/license audit, and secret scanning.
6. Benchmark the documented standard data profile on actual NAS hardware. Measure idle/peak memory, import duration, p95 queries, cold frontend load, and reconciliation candidate counts.
7. Write installation, backup/restore, first import, partner privacy, budgeting, reconciliation, unsupported-format, and troubleshooting guides.
8. Add chosen LICENSE, CONTRIBUTING, SECURITY, issue templates, adapter contribution instructions, synthetic demo data, changelog, and release artifacts.
9. Complete responsive end-to-end checks and manual iOS Safari/Android Chrome validation for file uploads, keyboards, evidence viewers, orientation changes, and reconnects. Document tested browser/device versions and fix core-workflow blockers before release.

Acceptance: clean NAS install, import both partners, set family budget, reconcile a statement, reboot, upgrade, and restore to a fresh instance successfully. Released images run on claimed architectures. No hidden cloud dependency or telemetry is required for core features.

Release gate: reconcile fixture totals exactly, pass authorization regression tests, demonstrate backup restoration, publish resource measurements, and document remaining limitations. Mark the app beta until real monthly workflows validate it.

## 12. Validation matrix

| Layer | Required checks |
|---|---|
| Domain | Amount precision, conservation, event signs, transfer/refund semantics, rounding. |
| Parsers | Golden input/output fixtures, localized dates, missing fields, malformed files, repeated headers, duplicate multiplicity. |
| Database | Real SQLite migrations, foreign keys, atomic rollback, concurrent decisions, revision and idempotency conflicts; account balance-direction and settlement-obligation constraints. |
| Authorization | Partner-private rows, aggregates, files, exports, jobs, audit events, and revoked membership. |
| Reconciliation | Labeled candidates, ambiguity, grouped sums, multi-file/account overlap, separate bank/card balance bases, daily variance and immutable history, cash-count variance, settlement repayment conservation, closed-period invalidation, balance/coverage states. |
| Analytics/budgets | Aggregate/drilldown equality, coverage gates, zero/negative metrics, period comparisons, plan revisions, unbudgeted spending, alert deduplication. |
| Browser | Multi-file uploads mapped to distinct accounts; account types; side-by-side ledger/statement selection and matching on desktop; selection-preserving comparison on phone; end-of-day bank/card balance checks and cash counts; partner budget; bank→review→resolve→close; keyboard accessibility. |
| Responsive UI | 320/390/768/1024/1440 px, 200% text zoom, portrait/landscape, touch targets, focus, long labels/amounts, phone upload/reconciliation/API-key flows; manual mobile file-picker and keyboard checks. |
| AI/OCR | Exact field accuracy, source grounding, unknown handling, malicious text, failure recovery, cloud opt-out. |
| Operations | Restart, resource limits, backup consistency, restore, migration upgrade, amd64/arm64 smoke tests. |

CI baseline: Rust formatting/clippy/tests; frontend type-check and build; migration and contract checks; golden parser fixtures; selected browser flows. Run model evaluations separately with synthetic data and pinned configuration so core CI does not depend on a paid or nondeterministic service.

## 13. Initial issue backlog

Each issue should include expected behavior, a fixture or example, API/schema impact, authorization policy, and its acceptance check.

| ID | Task | Depends on |
|---|---|---|
| FW-001 | Document actual exports, NAS profile, and privacy decisions | — |
| FW-002 | Create synthetic fixture pack and expected totals | FW-001 |
| FW-003 | Scaffold Rust/Svelte build and single-container deployment | FW-001 |
| FW-004 | Add database migrations, bootstrap, sessions, household scopes | FW-003 |
| FW-005 | Implement Money and ledger event invariants | FW-002, FW-003 |
| FW-006 | Implement ledger storage/API with revisions and audit | FW-004, FW-005 |
| FW-007 | Build transaction list and monthly summary | FW-006 |
| FW-008 | Add private import storage and durable jobs | FW-004 |
| FW-009 | Implement Money Manager parsing and normalization | FW-002, FW-008 |
| FW-010 | Add duplicate preview and idempotent import commit | FW-006, FW-009 |
| FW-011 | Build import wizard and source evidence detail | FW-007, FW-010 |
| FW-012 | Ship personal preview with import/dashboard smoke flow | FW-011 |
| FW-013 | Implement family allocation permissions and payer/responsibility views | FW-006, FW-011 |
| FW-014 | Add monthly budget lifecycle, revisions, and contribution links | FW-013 |
| FW-015 | Implement shared analytics metric contracts and coverage claims | FW-007, FW-013 |
| FW-016 | Build trend/category/merchant APIs, charts, drilldowns, and exports | FW-015 |
| FW-017 | Add budget tracking, coverage-gated pacing, and threshold alerts | FW-014, FW-015 |
| FW-018 | Validate analytics/budget equality, privacy, and NAS performance | FW-016, FW-017 |
| FW-019 | Implement the OpenAPI contract and generated typed frontend client | FW-003, API contract |

Subsequent milestones should be split into similarly sized issues once the first real import proves the source assumptions. Avoid freezing dozens of parser-specific tasks before the formats are known.

## 14. Scope control and risks

| Risk | Response |
|---|---|
| Export lacks stable IDs | Keep source evidence and occurrence counts; review ambiguous overlap. |
| Partners record one purchase twice | Detect across authorized shared allocations; explicit merge confirmation. |
| AI fabricates or drops statement rows | Evidence references, totals/coverage validation, mandatory review, manual fallback. |
| Local model exceeds NAS capacity | Separate LAN inference host or optional cloud; core app stays independent. |
| Private data leaks through reports | Apply policy to aggregate inputs, evidence, jobs, and caches; regression-test both accounts. |
| SQLite write contention | Short transactions, bounded workers, measure first; PostgreSQL is a later migration project. |
| Backups omit statement evidence | DB snapshot plus coordinated immutable-file manifest and restore drills. |
| Broad financial scope delays usefulness | Ship import/dashboard first; keep FX, investment, tax, and live banking outside v1. |

The next discovery action is FW-001/FW-002: validate actual exports and expected monthly totals against the synthetic-fixture-tested adapters. Do not claim format support from synthetic fixtures alone.
