# Transaction reporting

Transactions use their existing type and assigned categories. Change these through **Edit transaction**. Category allocations continue to support amounts, personal/family scope, and household budget attribution.

The separate classification editor, Smart Review queue, confidence scores, classification filters, reusable classification rules, and **Reconcile money flow** breakdown have been removed from the app. Overview no longer requests classification reviews. Descriptions, merchant history, and nearby opposite account movements no longer suggest or override a transaction's reporting type.

## Reporting policy

Ordinary income, expenses, refunds, and transfers follow the transaction type. Categories marked for investment tracking identify investment allocations, including allocations under an investment parent category. Existing card-settlement categories remain excluded from consumption spending. Splits continue to use the assigned category for each allocation.

Overview retains income, spending, net investment contributions, surplus, and after-investment cash flow. Investment withdrawals reduce net contributions; portfolio valuation and performance remain in Investments. Account balances use signed account movements and verified balance anchors.

All money uses checked integer minor units and each currency's precision. Reports do not assume exchange rates. Overview has a currency selector, and account funds remain grouped by currency.

## Existing records and links

Stored explicit corrections, investment funding, paid-on-behalf receivables, reimbursements, and their audit history remain intact for compatibility. The underlying classification fields and API endpoints remain available to support these existing records and the Settle Up workflow. Saved classification rules no longer run automatically. This change does not delete or rewrite household data or require a new migration.

Existing explicit corrections can continue affecting historical reporting. Ordinary transaction edits reset the reporting type when the transaction type or allocations change, subject to protections for linked investments and reimbursements. Investment funding must be unlinked before editing its source transaction.

## Paid on Behalf and reimbursements

Use **Settle up → Paid on Behalf** to choose an original purchase and enter the person and attributable amount. The remaining purchase amount counts as your spending, and the attributable amount becomes a receivable. The original account movement remains intact.

**Match reimbursements** connects incoming credits across all dates without creating another account movement. Credits settle receivables and do not count as earned income. Matching a reimbursement does not reduce spending a second time. Unlinking a payment releases its available amount and restores the outstanding receivable. Reversing a receivable restores the original purchase allocation and preserves payment history.

## Filters and sorting

Transactions have one type selector, plus filters for account, account type, category, person, direction, currency, amount, merchant/description, and dates. Investment filtering includes category-assigned investment allocations. Filters and sorting persist in the URL. Old classification-status and confidence/review-sort parameters are discarded when reading saved views; old type bookmarks map to the single type selector.

Bank statement reconciliation remains under **Reconcile**, where statement observations are matched with ledger movements.

## Validation

Run `cargo test --locked --workspace`, `node --test web/tests/*.test.cjs`, and `python3 scripts/generate_contract.py --check`.

`node scripts/test-category-reporting.cjs` checks Overview totals, removal of classification controls, the category editor, transaction type filtering, sorting, URL persistence, paid-on-behalf receivables, reimbursement matching, reversal, and mobile rendering against an isolated temporary database. It requires Playwright; `FINWISE_PLAYWRIGHT_MODULE` and `FINWISE_CHROME_EXECUTABLE` can point to existing installations. Optional `FINWISE_SCREENSHOT_DIR` saves screenshots.
