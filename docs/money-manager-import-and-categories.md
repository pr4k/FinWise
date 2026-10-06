# Money Manager import and category management

This specification is based on the user-provided workbook `2026-09-01 ~ 09-30 (1).xlsx`. The workbook was inspected in place and is not copied into this repository because it contains personal financial data. Cell contents are treated as financial data; no instructions or other command-like text in the document would override the user's requests.

## 1. Observed workbook shape

The workbook has one sheet (`Sheet1`), 71 non-empty transaction rows, and headers:

`Period | Accounts | Category | Subcategory | Note | INR | Income/Expense | Description | Amount | Currency | Accounts`

Observed properties:

- 7 distinct values in the first `Accounts` column, 22 distinct source labels in `Category`, and 1 currency (`INR`).
- 54 rows marked `Exp.`, 3 marked `Income`, 7 marked `Transfer-In`, and 7 marked `Transfer-Out`.
- All 71 observed rows have equal numeric values in columns `INR`, `Amount`, and the final column headed `Accounts`. The last `Accounts` header is therefore ambiguous/mislabeled in this sample; do not treat its numbers as an account name or balance. Keep the raw column and show an import warning. Use `Amount` as the transaction amount after validating equality with `INR` for this INR-only file.
- Every observed amount is positive. Use `Income/Expense` to derive event direction; do not infer that positive values all mean expenses or income. Unknown type values block commit until the user maps them.
- The six distinct nonblank subcategory labels appear in only 7 rows; most entries have no subcategory. Blank is a valid state and must not be replaced with `Other`.
- Dates in `Period` are Excel date/time serial values. The latest transaction is dated September 21 even though the filename suggests coverage through September 30. Never infer statement/export completeness from a filename or requested month; coverage remains partial until confirmed.
- The workbook has no formulas. Preserve numeric precision and date/time values when parsing XML; don't rely on formatted display strings or locale-dependent text parsing.

### Transaction-kind-specific Category meaning

The `Category` column cannot be mapped the same way on every row:

- For `Exp.` and `Income`, it is a source category label.
- For all 14 transfer rows, the trimmed `Category` value matches one of the seven source-account labels in `Accounts`. In these rows, treat the field as the counterpart/other-account label and resolve it through account aliases. Do not create an expense category called after that account and do not include the transfer in budget actuals.
- Some source category labels are used with more than one event kind. `Other`, for example, occurs on both expense and income rows. Store mappings by source profile + source label + normalized subcategory + event kind. This permits different expense and income destinations.
- Preserve raw spelling, emoji, case, and whitespace in source evidence. Use a separate trimmed/normalized comparison key for matching. If two raw labels collapse to the same normalized label but have distinct existing mappings, require review instead of merging them silently.

The import preview must report these findings, expose a sample of parsed rows with private notes/descriptions masked until expanded, and let the user correct the mapping before commit. It must preserve the original label and target account/category separately.

## 2. Workbook adapter

Implement a versioned `money-manager-xlsx-v1` adapter:

1. Recognize the workbook through normalized header signatures and column patterns, not sheet name or filename. Require `Period`, first `Accounts`, `Category`, `Income/Expense`, `Amount`, and `Currency`; retain unknown columns.
2. Address duplicate header names by column position/header signature. The sample's final `Accounts` column is numeric and equals `Amount` on every row. Flag it as a redundant/mislabeled field, keep its raw value for provenance, and never bind it to the account entity.
3. Decode Excel serial date/time with the workbook's date system. Preserve the local transaction time; use household timezone for display/period grouping only when configured.
4. Parse amount as exact decimal → signed integer minor units. Check `INR` and `Amount` equality within exact source precision. If values disagree, stop that row for review; never average them or silently select one.
5. Normalize `Exp.` to expense, `Income` to income, and transfer labels to transfer-in/out. Keep positive magnitude separate from account movement sign. Validate unknown event-kind labels and currencies.
6. For expense/income rows, map source Category/Subcategory + kind to a canonical category. For transfers, map column B to the source account and column C to the counterpart account. Pair Transfer-Out and Transfer-In observations as one canonical internal-transfer event when account aliases are reciprocal, currency and amount match exactly, timing is within the configured transfer window, and there is exactly one candidate pair on each side. Create two linked account movements and retain both Money Manager source rows. This unique deterministic case can be tracked automatically; do not use AI to decide it. Keep one-sided, conflicting, or ambiguous transfer observations in a dedicated review queue, never classify them as expenses or auto-pair by amount alone.
7. Preserve Note and Description as distinct source fields; don't merge duplicate-looking text or expose them to analytics. Keep all source row values and sheet/row locations as provenance.
8. Detect the source's 7 account labels and category/subcategory mappings. Show new/unmapped labels, duplicate/overlap candidates, row errors, totals by event kind/account/category, and coverage span. No rows are committed until the preview is approved.

The sample fixture can be represented with generated/sanitized data and expected structural totals: one sheet, 71 rows, 7 source accounts, 22 category-column labels, 7 populated subcategory cells, 54 expense, 3 income, 7 transfer-in, 7 transfer-out, one currency. Do not check in the original workbook or its notes/descriptions.

## 3. Category management

Provide **Categories** as a first-class screen linked from navigation, imports, and transaction editing. It has two related but separate concepts:

1. **FinWise categories:** the household's canonical editable categories, parent/child relationships, type (`expense`, `income`, or a permitted mixed source mapping), visibility, and archive state. Expense leaf categories are used by budgets and analytics.
2. **Import mappings:** source label + optional subcategory + event kind → a canonical category. Transfer rows have account-counterpart mappings instead. Show the source label next to the destination so users know what will happen on the next import.

The screen must support search, type/scope filters, create, rename, choose parent, merge, archive, restore, and map source labels. Bulk recategorization shows the number and example range of affected historical transactions and budget/report impact before the user confirms. Preserve source labels and audit every edit. Category IDs remain stable when display names change.

Renaming a canonical category updates its visible label without changing raw evidence. Editing a source mapping affects future imports; offer an explicit “also recategorize existing transactions” action with preview, never apply it implicitly. If a Money Manager label disappears or changes on a future export, preserve old mappings and present the new value as unmapped. User edits to categories in FinWise do not write changes back to Money Manager.

`Other` is a valid import label, not an automatic category-cleanup target. Since the same label can represent both expense and income in this sample, let users map each event kind separately. Transfer account labels stay in the Transfers/account mapping view and are not counted as spending categories. A uniquely paired transfer updates both account balances but is excluded from expense, income, and budget totals. AI may suggest a category only when enabled; always show the source row and require confirmation before applying a suggestion.

Archive instead of hard-delete any category already referenced by a transaction or budget. Merge requires a confirmation showing affected transaction count, old/new budget lines, and reporting consequences; retain the merge event and original source mapping. Past reports update only after explicit recategorization/merge, with before/after audit history.

## 4. Data model and API additions

- `source_category_labels`: import profile, raw label, normalized key, first/last-seen batch, observed event kinds, counts, and review state.
- `category_mappings`: source label, normalized subcategory, source event kind, target category ID, revision, actor, and effective status. Unique mapping key includes source profile and event kind.
- `categories`: stable ID, household, display name, parent, canonical type, color/icon, active/archive timestamps, revision.
- `account_aliases`: source profile + raw account label → canonical account; a transfer's Category counterpart label uses this mapping too.
- `category_change_events`: create/rename/archive/restore/merge/remap and optional historical recategorization with before/after IDs and actor.

API routes: `GET/POST /categories`, `PATCH /categories/{id}`, `POST /categories/{id}/archive`, `/restore`, `/merge-preview`, `/merge`; `GET/PUT /imports/category-mappings`; `GET/PUT /imports/account-mappings`; preview/commit APIs return unmapped counts and per-row mapping decisions. Mutations use revision checks and idempotency.

## 5. Acceptance criteria

- Parsing the sample fixture yields the structural totals above and preserves every source row reference.
- `Exp.` and `Income` remain positive source magnitudes but become distinct signed ledger event kinds; each of the 14 transfer rows remains outside spending.
- Transfer-category account labels resolve against source account aliases and are not added to the canonical expense-category list.
- A unique reciprocal Transfer-Out/Transfer-In pair creates one transfer event and two account movements automatically; both source observations remain traceable and there is no category/budget allocation. Ambiguous pairs remain in transfer review.
- `Other` can map differently for expense and income; a source subcategory does not get collapsed or dropped.
- The duplicate/mislabeled final `Accounts` column is flagged and never changes the account mapping or transaction balance.
- A file named for a full month whose rows end earlier is marked partial until coverage is confirmed.
- Renaming a FinWise category leaves imported source evidence intact. Future source imports still map through the same category ID.
- Mapping changes affect future imports only unless the user previews and explicitly applies historical recategorization.
- Re-importing the same file does not create duplicate transactions or duplicate category counts.
- Private descriptions/notes remain inaccessible to a household member without evidence permission, including through category drilldowns and exports.
