# Transaction intelligence

Economic classification is independent of an imported transaction's ledger `event_type`. The classification module is the shared reporting policy for Overview, Analytics, budget tracking, category and person matrices, forecasts, and spending widgets. Account balances continue to use unchanged signed account movements and verified balance anchors.

## Storage and migration

Migration 0015 adds a classification object to existing transaction documents and a review index. It reuses `resources`, investment records, and `audit_events`, rather than introducing parallel ledger or audit tables. Original uploads and source references remain intact. The first correction also preserves the stored `original_allocations`.

On startup, an existing file-backed database without migration 0015 gets a consistent SQLite `VACUUM INTO` backup next to the database, named `DATABASE.before-classification-UUID.sqlite`. Unix backup permissions are owner-only. Backup failure prevents migration. In-memory databases need no file backup. Existing manual ledger entries retain their authority; uncertain imported classifications remain pending review. Reading suggestions does not persist a historical correction. There are no materialized financial summaries to rebuild: reports calculate directly from classified allocations.

This development change does not start the new application against the household database. Migration applies on the next normal startup. A separately verified snapshot was created in the ignored `backups/` directory during implementation.

## Classification policy

Transactions carry `classification.transaction_type`, `status`, `confidence_score`, and `classification_source`, with optional confirmation timestamp, related transaction ID, and holding ID. Allocations can independently carry `transaction_type`, category, scope, and member ownership. Splits must sum exactly to the original magnitude.

Explicit manual classifications take precedence. Confirmed transfer ledgers and generated investment movements are trusted evidence. Saved description/merchant rules only apply automatically to newly created matching records; conflicting rules with equal priority require review. Categories designated for investments or card settlement apply to their individual allocation, allowing mixed purchases. Description patterns and historical confirmed merchant decisions produce suggestions. Equal opposite amounts on distinct authorized accounts within three days produce a suggestion and candidate link, never confirmation from amount alone. Matching context includes neighboring months and is independent of list filters and pagination.

Income, consumption, refunds, investment flows, debt, transfers, reimbursements, adjustments, and unknown amounts occupy exclusive reconciliation buckets. Unknown amounts are excluded from earnings and consumption. Investment withdrawals reduce net contributions, not investment returns. Portfolio valuation and realized/unrealized performance remain with the existing investment module.

A reimbursement settles a receivable by default. An explicit expense offset requires the original counted consumption expense, matching scope and category, and remaining reimbursable amount. Corrections, ordinary edits, voiding and undo cannot remove or reduce the original expense below its approved offsets. Paid-on-behalf receivable portions are excluded from consumption and linked to Settle Up obligations. Confirmed transfer pairs update both classifications atomically, preserving their separate account movements.

Baseline holding links from classification also record the classified investment portion through the existing holding funding workflow. Full-history holdings retain the holding reference; purchase/sale funding evidence must be linked to its specific trade on Investments. Neither classification nor a cash withdrawal invents a valuation or cost basis. Existing holding funding must be unlinked before changing its economic purpose or undoing its classification.

All money is parsed and summed in checked integer minor units using each currency's precision. No exchange rates are assumed. Overview has a currency selector; account funds remain grouped by currency. Budget percentages can exceed 100%; only the progress-bar fill is capped. Only active budgets appear in Overview budget utilization.

## Review and corrections

Overview shows up to five pending transactions for the selected month, scope and currency. Ranking is amount in minor units × uncertainty × actionability, with a stable ID tie-breaker. Confirmation updates the review queue, KPIs, and affected reporting sections in place so the next pending item appears. Transaction filter and sort changes also update in place: controls retain focus, expanded panels stay open, scroll position is preserved, and unaffected review choices remain intact. Failed refreshes leave the current data visible with an error message. Unknown purposes remain in Needs Review, including after an explicit manual Unknown selection.

The classification editor supports purpose/category corrections, scope and member splits, refund/reimbursement links, transfer pairs, investment references, and audit history. Transaction details offer revision-checked classification undo. A transfer-pair undo restores both sides only while the counterpart still has its linked revision. Investment funding must be unlinked first.

Apply to similar transactions previews matching rows and requires explicit selection approval. Bulk changes are atomic and revision checked. Saving a rule is optional. Manual decisions are never overwritten by automatic rules.

## Paid on Behalf and reimbursements

Choose **Paid on Behalf** in transaction classification, or select a purchase from **Settle up → Paid on Behalf**. Enter the person, attributable amount, and optional description. The amount must be positive and cannot exceed the original outgoing transaction. The classifier divides the purchase into your expense and the receivable portion, preserving category/scope attribution and all original account movements. Internal transfers are excluded; classify the original purchase rather than its credit-card bill payment.

The feature extends the existing `settlement_obligations` JSON documents with `kind: paid_on_behalf`, `transaction_id`, and original classification/allocation snapshots. It reuses the existing `repayments` array and audit trail; no separate reimbursement ledger or migration is needed. Receivables retain existing private Settle Up permissions.

- Personal spending = purchase amount − amount paid on behalf.
- Outstanding = receivable principal − valid, non-reversed payments.
- Reimbursement income impact = zero; credit-card bill transfers also contribute zero spending.

**Match reimbursements** shows available incoming credits across all dates, prioritizing person-name suggestions. Nothing is applied automatically. Select one or several credits manually, adjust their amounts, and apply them together atomically. Credits can be shared between receivables only up to their available amount, including allocations to another household member's private receivables. Currency and account access must match. Existing confirmed transfers, investment movements, and expense-offset links cannot also fund reimbursements.

Matched credits retain their original date, amount, account movements, and ledger type. Their economic purpose becomes reimbursement, including any unused portion, which stays available to other receivables and never counts as earned income. A paid-on-behalf purchase is already excluded from spending, so matching its reimbursement does not offset spending again. For example, a ₹1,41,766 purchase fully paid for another person and fully reimbursed has zero outstanding, zero income impact, and zero spending impact, with status Settled.

**Unlink** marks a payment reversed and restores capacity/outstanding without deleting its record. **Reverse receivable** marks the obligation and all payments reversed, restores the source purchase's previous classification, and releases its credits. Credits retain reimbursement classification after unlink/reversal; they can be reclassified once no active links remain. Original money movements remain unchanged. Linked source movements and allocated credit portions cannot be invalidated through ordinary edits or classification undo. Payment history, reversed receivables, and audit snapshots remain available.

Manual payments remain supported by the existing Settle Up workflow. These are bookkeeping records; use matching to connect an already recorded bank credit without creating another account movement.

## Queries and API

The primary Transaction type dropdown filters economic classification, including investment allocations originally imported as expenses or refunds. Original ledger type is a separate advanced filter. Legacy Investment filter links are translated to economic classification, so the Family view includes contributions from all authorized household members.

The existing transaction list composes scope, exclusive date bounds, account, account type, person, category, original event type, economic type, classification status, currency, direction, amount bounds, and merchant/description search. `classification_status=pending` includes Suggested and Needs Review. Transfer direction matches the selected account's leg, or either leg if no account is selected.

Sort keys are `effective_date`, `amount`, `merchant`, `category`, `account`, `person`, `transaction_type`, `confidence`, and `review_status`. Prefix a key with `-` for descending; use `secondary_sort` for a second column. The default is descending date, followed by a stable transaction ID. Monetary sorts compare exact values. Sorting applies to the entire authorized filtered dataset before cursor pagination. Filters and sorting persist in URL parameters.

New endpoints, under `/api/v1`:

- `GET /classification-reviews`
- `POST /transactions/{id}/classification`
- `POST /transactions/{id}/classification-undo`
- `POST /classification-rules/preview`
- `POST /classification-rules/apply`
- `GET /settle-ups/{id}/reimbursement-candidates`
- `POST /settle-ups/{id}/repayments` with a single `transaction_id`/`amount`, or `matches: [{transaction_id, amount}]`
- `DELETE /settle-ups/{id}/repayments/{payment_id}` (audited unlink/reversal)
- `POST /settle-ups/{id}/reverse`

Mutations use the existing CSRF, idempotency and revision conventions. The generated OpenAPI contract and TypeScript types document request shapes. `analytics/summary` includes the four KPIs, after-investment cash flow, raw credit/debit reconciliation, pending count, and per-allocation contributions for drill-downs. These are reporting values, not bank balances.

## Validation

Run `cargo test --locked --workspace`, `node --test web/tests/*.test.cjs`, and `python3 scripts/generate_contract.py --check`. Integration tests cover exact split arithmetic, reimbursements versus expense offsets, debt and unknown exclusions, transfer-pair undo, card-payment double counting, matching across month boundaries, review priority, private-account access, revision-checked bulk approvals, sorting across cursor pages, linked investment portions, budget consumers, and backup-before-migration. Unit tests include zero-, two-, and three-decimal currencies and overflow.

`node scripts/test-classification.cjs` runs browser acceptance against an isolated temporary database. It requires Playwright; `FINWISE_PLAYWRIGHT_MODULE` and `FINWISE_CHROME_EXECUTABLE` can point to an existing installation. It checks desktop/mobile rendering, all four KPI cards, top-five reviews, confirmation-driven KPI updates, drill-downs, sorting, URL persistence, the split editor, cross-month multi-credit matching, unlinking, and receivable reversal. Optional `FINWISE_SCREENSHOT_DIR` saves screenshots for visual inspection.
