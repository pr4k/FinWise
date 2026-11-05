# UI data loading performance

The 24 October 2026 changes target transaction loading identified from the system export and the running code. No production database was opened or modified during development.

## Bottlenecks addressed

- Transaction and transfer lists previously fetched and decoded every household transaction before applying date filters. They now push optional `from` (inclusive) and `to` (exclusive) into SQLite, using existing household/date expression indexes.
- Transaction lists and decorated report inputs previously fetched source references once per transaction and reconciliation data once per movement plus once per transaction. They now fetch sources in one query and active reconciliation links/observations in one query for the authorized set. Related-data query count is constant with respect to transaction count. Empty sets skip these queries.
- Import source lookups lacked an index on `(household_id, transaction_id)`. Migration `0013_transaction_sources.sql` adds it without rewriting financial documents.

Account authorization runs before evidence decoration. Transactions involving any inaccessible account stay hidden. Source-reference deduplication, active-link filtering, checked integer sums, decimal money formatting, and snapshot cursor validation are retained. API shapes and browser code are unchanged, so these improvements also apply to existing deployed clients after the server update.

## Validation and measurements

`backend/tests/read_performance.rs` checks batch/item equivalence, imported source deduplication, grouped reconciliation evidence, inactive links, private transfer exclusion, inclusive/exclusive and one-sided date bounds, and SQLite index selection. Existing API tests cover partial matching, edits invalidating evidence, pagination conflicts, and authorization revocation.

Run the synthetic timing check explicitly:

```sh
cargo test --locked --test read_performance transaction_read_benchmark -- --ignored --nocapture
```

One local debug-build run with a temporary file-backed WAL database, 6,000 transactions, and 6,000 import occurrences:

| Read path | Elapsed |
| --- | ---: |
| Separate item reads for all 6,000 transactions | 541 ms |
| One batched full-history read | 81 ms |
| Indexed monthly read, 100 transactions | 1.7 ms |

These are storage-layer measurements from a synthetic fixture, not production NAS timings or browser render timings. The item-read comparison illustrates query overhead; it is not an exact benchmark of the previous list implementation. No timing threshold is enforced in CI.

Other checks: `cargo test --locked --workspace`, `node --test web/tests/*.test.cjs`, `python3 scripts/generate_contract.py --check`, and replaying the exported schema in an empty SQLite database.

## Rollout

Restart or redeploy the updated server. Startup applies migration 0013 automatically to the application's database. Follow the existing backup process before a production upgrade. The clean-install schema export is for review and empty databases; startup migrations handle populated databases.

## Remaining architecture work

1. Measure initial account loading and the Analytics/Budgets workspaces on representative NAS data: request duration, response bytes, database wait, and browser rendering time. Account lists now batch their projections; single-account detail and report fan-out remain candidates for representative NAS profiling.
2. If account projection scans dominate, introduce a transaction-movement table indexed by household/account/date. Backfill and maintain it atomically with every transaction mutation, including imports and reset paths. Keep account balance visibility rules: an authorized account balance can include its side of a transfer even when the other leg is private.
3. If report fan-out dominates, add a combined workspace response that computes shared authorized inputs once. Keep permission scope and period explicit.
4. All-date collections still load and hash the full result on each page to preserve snapshot cursors. Replace this only with a versioned cursor contract that validates household ledger and access revisions before seeking by date/ID.
5. Retain one database connection until writer serialization is explicit. Increasing the pool alone can cause deferred read-to-write transaction races in revision and idempotency checks. Concurrent readers require a separate writer strategy and concurrency regression tests.

A framework rewrite, additional service, or different database is not required for the changes delivered here.

## Investment workspace follow-up

Investment tabs and holding filters now render the loaded workspace locally without reloading catalogs, reports, goals, or the ledger. Hidden tabs skip building their holding/activity tables, goals/review tables, and portfolio chart. Initial transaction loading uses the selected month's indexed date range. The link picker, trade evidence dialog, and SIP payment matcher fetch historical expense/refund candidates on demand, preserving access to older funding entries. Investment list/report/goal reads use the existing ten-second in-memory cache, invalidated by successful mutations and session changes.

The investment report builds a transaction-to-holdings evidence index once, so ordinary unlinked expenses no longer scan every holding's records and trades. Linked amounts retain per-holding ownership rounding and legacy full-transaction links. Holding list pagination validates the snapshot of canonical documents before calculating FIFO and returns for only the requested page.

Regression checks cover request-free tab rendering, skipped hidden activity/chart work, selected-month initial requests, historical candidate loading, investment read-cache invalidation, and paginated calculated fields/cursor conflicts. Existing investment API checks cover funding splits, refunds, ownership, FIFO, XIRR, and private holdings. Browser interaction timings on actual NAS hardware have not been measured; the Activity tab still renders its selected holdings' monthly history when opened.

## Dashboard report loading

The Overview no longer builds and fetches its collapsed detailed reports before
rendering the dashboard. Opening Detailed reports & comparisons loads that region
once and hydrates its charts. Direct `#overview/reports` links still load the
reports immediately. Late responses are ignored after navigating or changing the
report context; a failed report read can be retried by reopening the disclosure.

The dashboard regression test deliberately delays detailed reports and verifies
that the main dashboard still renders without invoking them. This checks the
loading dependency, rather than asserting a timing target for production NAS data.

## Shared account and browser optimizations — 6 November 2026

Accounts lists and analytics account reports now load account movements and balance
checks once per batch. They retain authorization before projection, include only
the authorized side of private transfers in balances, preserve dated anchor and
card-sign rules, and keep missing balances unknown. Goal reservations are read
once per batch, including private goals whose amounts must still be reserved;
private goal names and IDs remain masked. Report movement totals use one pass.

Account ledgers build one current account-access map rather than querying access
for every transaction leg. Ledger anchors and balance-check histories reuse loaded
movements instead of rereading them at every observed check. Access grants and
revocations are read afresh for each request. The single-writer database policy
and existing pagination snapshot validation remain intact. No schema migration
or cross-request server cache is introduced.

The browser shares simultaneous identical GET requests without caching subsequent
uncached reads. Successful writes and session changes invalidate pending reuse;
requests with abort signals remain independent. Sign-in reuses its freshly loaded
catalogs for the first route instead of repeating the startup reads.

Ledger rows initially render summaries; movement/allocation detail is built from
already loaded records when expanded. Open rows remain populated across in-place
refreshes. Currency/date formatters and chart tick formatters are reused instead
of constructing them for every cell or tick. The appearance and visible row
summaries remain unchanged.

### Synthetic measurements

| Workload | Comparison path | Optimized path |
| --- | ---: | ---: |
| 24 accounts, 6,000 transactions; file-backed SQLite, debug build | Individual account reads: 282 ms | Batched projections: 94 ms |
| Render and parse 2,000 ledger rows in headless Chrome | Frozen previous renderer: 171 ms | Summary-first renderer: 23 ms |
| Initial ledger HTML, same 2,000 summaries | 2,680,512 characters | 1,270,732 characters |

These are local synthetic measurements, not production NAS timing guarantees.
The browser benchmark compares identical visible summaries and verifies that
collapsed details are absent initially, expand without a network read, and remain
available after an in-place refresh. Financial tests compare batch and individual
projections, actual expected amounts, private transfers and goals, access changes,
future observations, card balances, unknown anchors and check variance/staleness.

Run after building the current backend:

```sh
cargo test --locked --workspace
cargo test --locked --test account_read_performance account_batch_benchmark -- --ignored --nocapture
cargo build --locked -p finwise-api
node --test web/tests/*.test.cjs
node scripts/test-performance.cjs
node scripts/test-reference-layout.cjs
node scripts/test-navigation.cjs
node scripts/test-dashboard-regressions.cjs
```
