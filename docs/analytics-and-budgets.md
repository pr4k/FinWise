# Analytics and budget tracking modules

Status: proposed implementation specification. SQLite is the confirmed v1 database. These modules share ledger calculation rules with [the architecture](architecture.md) and are delivered through [milestones 3, 4, and 4A](implementation-plan.md).

## 1. Scope and ownership

Analytics answers where money went, how spending changed, and how complete the underlying records are. Budget tracking compares those actuals with an explicit monthly plan. Both work without AI and read committed canonical ledger events, never raw import rows or unaccepted bank observations.

Services within the modular monolith:

- `analytics`: authorized allocation queries, time-series aggregates, comparison periods, drilldowns, and report exports.
- `budgets`: plan lifecycle, category limits, actuals, revisions, member contribution targets, and threshold alerts.
- Shared `reporting_policy`: date boundaries, currency, inclusion rules, visibility, refunds, and ledger revision selection. This prevents dashboards and budget screens from calculating different actuals.

V1 includes monthly budgets, personal/family views, category and merchant analysis, historical comparisons, budget progress, and a monthly savings goal. Rollover, recurring-bill commitments, predictive models, and envelope budgeting remain later extensions.

The Analytics and Transactions screens have Personal, Family, and Combined view tabs. Personal shows the signed-in member's personal allocations and budget, plus private investment valuations, emergency fund targets, and settle-up obligations. Family shows shared allocations and the family budget. Combined sums the signed-in member's personal allocations with shared family allocations, counts each transaction or transfer once, and shows the personal and family budgets separately. Other members' personal allocations are excluded. Account balances are explicitly labeled as authorized account snapshots independent of allocation scope. Investment totals use the latest recorded value on or before the selected month and only combine holdings in the household currency. Settle-up balances use obligations and repayments dated through the selected month; other currencies appear separately. These planning amounts remain distinct from ledger income, spending, transfers, and account balances. Actual budget spending uses the existing allocation-based tracking API.
Budget category rows open the contributing allocations and transactions. Investment rows open month-by-month contributions, withdrawals, values, and changes since the previous record. Settle-up person rows open obligations and dated payment history. Deleted planning records leave active analytics while their audit snapshots remain available to the backend.

## 2. Analytics screens

| Screen | Contents and interaction |
|---|---|
| Overview | Recorded income, net spending, recorded surplus, budget remaining, account snapshot availability, transfer volume, and unresolved items. Every metric links to the rows behind its value. Never combine recorded surplus with account balance. |
| Spending | Ranked category and merchant totals, amount/share/change table, and account/payer comparisons. Include Uncategorized; refunds remain visible. |
| Income | Income totals and sources by category, member, and account, with income coverage shown separately from expense coverage. Transfers are excluded. |
| Trends | Monthly income/spending/net cash flow over 3, 6, or 12 months; daily cumulative spending for the selected month. Account-balance snapshots are a separate series. Missing coverage is distinct from zero spending. |
| Accounts | Per-account opening/closing or latest checked balance, balance direction/type, income-in, expenses-out, transfer movements, transaction counts, reconciliation state, and last check variance. Bank/cash assets and card liabilities have distinct labels. |
| Transfers | Unique internal transfer events by source/destination account, status, amount, and month; show corresponding per-account movements without counting the same transfer twice in household totals. |
| Family | Shared category totals, who paid, responsibility shares, and settlement position. Payer and beneficiary are separate dimensions; never add their totals together. |
| Budget performance | Planned versus actual by category, remaining amount, utilization, overspent/unbudgeted lines, and prior-month results. |
| Data quality | Coverage per account/member/period and income/expense dimension, transaction-match state, last end-of-day account balance check and variance, uncategorized entries, pending transfers, and unresolved items. |

Filters: personal/family scope, month or custom date range, category, merchant, event type, and authorized account. Account selection filters account-flow and balance insights; category spending is filtered by the account that funded the allocation only where that association is explicit. Member breakdowns are available only for shared information or explicitly granted access. An account filter cannot expose a private account through a chart label or count. Shared allocations from private accounts use a permitted payer label while withholding bank details.

The Analytics header exposes independent **Month** and **Compare with** selectors. Changing either recomputes the period metrics and comparison; selecting the same month in both controls advances the other selector to the alternate available period. Compare like-for-like measures: income, net spending, surplus, and unique transfer volume at household scope. For an account selection, show that account's period income/spending/transfers and closing balance or amount owed; do not subtract balance snapshots and describe the result as spending or surplus. Show absolute and percentage change only when the comparison baseline supports it. Missing/incomplete coverage remains visible. The front-end preview currently provides April and May 2025 fixtures; production selectors query any covered month and custom range.

Account-wise flow reports distinguish `expense allocations` from `account movements`: a credit-card purchase is spending and increases the card liability; the later bank payment reduces bank cash and card liability as one internal transfer, not additional spending. An ATM withdrawal reduces the bank asset and increases tracked cash, not household expense. Report both sides in each account's activity, but count a canonical transfer once in household transfer volume and exclude it from income, spending, and budgets. Never add bank balances, card amounts owed, cash counts, and friend receivables into an unlabeled “total balance.” An optional net-worth view requires explicit asset/liability valuation and complete opening-balance coverage.

Use bars and lines with accessible table equivalents, consistent currency formatting, keyboard-accessible drilldowns, and mobile summary cards. A click on a chart segment must preserve its exact scope, dates, category, and calculation mode in the transaction list. CSV export uses the same authorization and filters as the displayed report.

Mobile responsiveness is required: stack analytics cards/charts and category budget progress cards on phones; use accessible filter sheets and full-page budget editors. Expose chart values by tap/focus as well as any desktop hover. Keep full amounts, negative signs, coverage badges, and unbudgeted totals readable at 320 px. Validate drilldowns, period selection, budget revisions, and contribution editing with touch input and the on-screen keyboard. Follow the architecture's shared responsive layout and acceptance contract.

Budget comparison uses full monthly scope. Narrowing analytics to one merchant or account must not compare that subset with the full budget and label the result “budget remaining.” Mark filtered spending as a subset and link to the complete budget instead.

## 3. Metric contract

All formulas operate on one currency and authorized allocations. Period boundaries are inclusive start and exclusive end in the household calendar. Use canonical effective dates for spending and income; posted dates belong to bank verification and account cash-flow views.

| Metric | Definition and edge cases |
|---|---|
| Gross expense | Sum of committed expense allocations before refunds. Exclude transfers, opening balances, voided records, and proposals. |
| Net spending | Gross expense less refund allocations effective in the selected period. It can be negative when refunds exceed new expenses. |
| Recorded income | Included income allocations; omit transfers, settlements, and opening balances. Shared income must be explicitly allocated to Family to appear there. |
| Recorded surplus | Recorded income minus net spending. This is not an account balance or a verified savings amount. |
| Account closing balance | Account's opening balance plus account movements through the cutoff, normalized to its subtype. Display credit-card liabilities as amount owed. If opening balance is unknown, display balance as incomplete. |
| Account activity | Signed movements on one account in the requested period, grouped into income, expense, internal transfer, refund, fee, and adjustment. Cash flow is not category spending; card settlement movements are not purchases. |
| Household transfer volume | Sum each canonical same-currency transfer once, not both of its account movements. Account-specific views show the signed movement for that account. |
| Surplus ratio | Recorded surplus / recorded income, only when income is positive. Show unavailable otherwise; flag incomplete income coverage. |
| Category share | Category gross expense / total gross expense. Show refunds/net spending separately so negative refunds do not produce misleading pie percentages. |
| Period change | Current net spending minus comparison net spending; percentage change only when the comparison is positive. Otherwise show absolute change and “percentage unavailable.” |
| Budget utilization | Net actual / effective budget when budget is positive. Preserve negative actuals in the table; a visual progress bar may clamp at zero but must show the true value beside it. |

Refunds use their own effective date and original category when linked, without rewriting a closed purchase month. Corrections to a transaction date/category change the affected historical reports and revisions. Opening balances remain excluded from every income/spending calculation.

Use half-open ranges throughout SQL and API contracts. For a full historical month, compare with the previous full month by default. For month-to-date, compare through the same calendar day in the prior month, clipped to its length, and display both exact ranges. Mark unequal-length comparisons explicitly; do not imply rate-normalized results. Custom ranges use the preceding equal-length range unless the user selects another.

Every aggregate response includes `as_of`, ledger revision, reporting-policy version, effective filter scope, coverage status, excluded/unsupported currency indicators, and drilldown parameters. A selected report and its drilldown must use the same snapshot revision or warn that the data changed and refresh together. Paginated drilldowns reject stale revision cursors rather than mixing versions. Use short consistent read transactions; never hold one across browser requests.

## 4. Coverage and pacing for monthly imports

An upload timestamp or latest transaction date does not prove complete coverage. Store explicit coverage claims by owner/account/source/period with status such as unknown, owner-confirmed, or statement-validated. Category-only sharing may support spending coverage without disclosing private account identity. Missing required claims make the scope incomplete.

Show “recorded through …” only when supported by the selected coverage claims. Never label an empty unimported month as “no spending.” Historical totals can still be shown as recorded totals with a visible completeness badge.

Pacing is optional and descriptive: `estimated month-end spending = actual through complete cutoff / elapsed calendar days × days in month`. Show it only for a current month with complete expense coverage from day one through an explicit cutoff, at least seven elapsed days, and nonnegative net actuals. Show the cutoff and explain that irregular spending is not modeled. A completed month displays actuals, not a forecast. Stale or incomplete coverage suppresses pacing and “on track” labels; income-dependent metrics also require income coverage. No AI is needed for this calculation.

## 5. Budget lifecycle and tracking

One budget exists per household, scope owner, currency, and calendar month. Personal plans belong to their user; family plans have explicit editors. States: draft → active → archived. Archiving stops alerts but does not delete the plan or make incomplete data reconciled. Budget lifecycle and bank-period closure remain independent.

1. Create a monthly plan manually or copy another month into an independent draft. Copy lines and targets, not actuals, alerts, or audit history.
2. Set expected income and leaf-category spending limits. Show total planned spending and its difference from planned income; oversubscribed plans are allowed with a visible indicator.
3. Optionally preview a suggestion from the last three complete months. Include zero-spend covered months; exclude incomplete months and explain the input periods. Suggestions become limits only after acceptance.
4. Activate the plan. Committed imports, manual entries, refunds, and corrections update actuals using the same analytics service.
5. Show each line's limit, actual, remaining, utilization, and threshold state. Unbudgeted spending is a separate row and contributes to total spending.
6. Edit an active plan with expected-revision checks, a reason, and audit history. Show original and current planned totals so increasing a limit does not hide the original variance.
7. Review the month, then archive or copy to the next month. Late ledger corrections refresh actuals and label prior exports as snapshots; archive does not freeze actuals.

`effective budget = active planned limit` in v1, because carryover is deferred. `remaining = effective budget - net actual`. A missing budget is Unbudgeted; an explicit zero limit means no spending is planned. Positive actual against a zero limit is overspent without attempting percentage division. Overall remaining is total category limits minus all scoped net spending, including unbudgeted categories.

Category leaf lines are unique within a plan. Parents are rollups. Preserve category IDs across renames; merging or restructuring budgeted categories requires an explicit mapping and revision to prevent duplicated limits or changed historical grouping without notice. The overview uses the current authorized classification; historical exported snapshots retain their original labels and revisions.

Example: Family/Groceries has a ₹10,000 limit. Two partners record ₹3,000 and ₹2,000 of shared groceries; a ₹500 refund gives ₹4,500 actual, ₹5,500 remaining, and 45% utilization. Their ₹1,500 settlement changes neither actual nor remaining. An additional ₹800 of unbudgeted family spending makes total family actual ₹5,300 and overall remaining ₹4,700 when groceries is the only budget line.

## 6. Contributions and notifications

Contribution targets answer how much each member plans to provide to shared funds. Keep them separate from responsibility for expenses and money owed between partners. V1 records realized contributions through explicit links to eligible committed transfers to a designated shared account. Reuse of a movement is constrained by its unallocated amount. Direct payment of a family expense appears in “paid by,” and does not automatically count as funding the shared account.

In-app notifications support configurable positive-budget thresholds, initially 80% and 100%, plus overspent zero-budget and unbudgeted-spending states. Evaluate after committed ledger/plan changes and permission updates. Deduplicate by plan line, plan revision, threshold, and month; record the triggering ledger revision. Re-importing identical data emits nothing new. If a refund or correction resolves the threshold, update the existing alert; crossing again in the same plan revision reopens it rather than spamming duplicates.

Notifications report recorded spending and include coverage status. They may say “recorded spending exceeds limit” even when data is incomplete, but never “on track” based on missing records. In-app access follows budget permissions; revoked access removes alerts from view. External email/push channels are outside v1.

## 7. Storage, APIs, and query design

Additional SQLite entities:

| Entity | Fields / constraints |
|---|---|
| budget_plans | Household, scope owner, currency, month, lifecycle, expected income, current revision; unique monthly scope. |
| budget_plan_revisions, budget_line_revisions | Immutable planned values, category, actor/reason, timestamp; current revision references a complete plan snapshot. |
| contribution_targets, contribution_links | Member/month target and eligible canonical movement links with consumed-amount constraints. |
| coverage_claims | Owner/source/account or permitted shared scope, interval, expense/income dimension, status, evidence, revision. |
| budget_alerts | Plan/line revision, threshold identity, state, triggering ledger revision, acknowledgement per user. |
| report_exports | Requester, filter/scope, policy and ledger revisions, generated time, private file key and retention. |

Actuals are derived, not independently editable columns on budget lines. Use indexed SQL aggregation first. If later measurements justify cached monthly summaries, scope keys by household/user/permissions/currency/filter and ledger/category revisions. Recompute both old and new periods on date/category/scope changes, and invalidate immediately on permission changes. SQLite remains the sole database; no analytics warehouse is required.

API surface under `/api/v1`:

- `GET /analytics/summary`, `/analytics/series`, `/analytics/categories`, `/analytics/merchants`, `/analytics/coverage`.
- `GET /analytics/accounts` returns authorized account snapshots and period movements with balance basis, cutoff, coverage, and reconciliation status. `GET /analytics/transfers` returns canonical transfers once, with explicit per-account movements and drilldown filters.
- `POST /analytics/exports` for bounded authorized report exports; authorized job/status/download routes follow existing conventions.
- `GET/POST /budgets`; `GET/PATCH /budgets/{id}`; `POST /budgets/{id}/activate`, `/archive`, `/copy`.
- `GET /budgets/{id}/tracking`, `/revisions`; contribution target/link mutations; alert list/acknowledgement routes.

Allowlist filter dimensions and sort keys, parameterize queries, cap result sizes/date ranges, and return validation errors for unsupported currencies or incompatible filters. Mutations use idempotency keys and expected revisions. Reports and budget tracking must expose the same policy version and agree exactly for identical scopes.

## 8. Required acceptance fixtures

- Shared groceries/refund/settlement example above produces exact expected values across dashboard, budget screen, chart drilldown, and export.
- Account-flow fixtures reconcile `opening balance + signed movements = closing balance` independently for bank, credit card, and cash. Card payment reduces card amount owed and bank cash but creates no spending; ATM transfer changes bank and cash balances but creates no expense.
- Household transfer totals count a paired transfer once; adding its two account movements to account-specific reports does not double household transfer volume or alter budget actuals.
- Account-filtered trends, category drilldowns, and exports retain exact account/currency/date scope and show account-specific coverage; balances with unknown opening values stay incomplete.
- Zero income, zero limit, no plan, negative net spending, and zero comparison baseline display meaningful states without division errors.
- Switching current/comparison months updates household and account measures, category values, period labels, and change indicators; account balance/owed is never presented as the household surplus.
- Missing monthly exports show unknown coverage; importing a partial month does not enable pacing. Complete coverage through day 10 can enable the labeled estimate.
- Leap February, months of different lengths, effective-date corrections, and refunds in a later month follow the period contract.
- Reclassification updates source and destination category totals and alerts once. Concurrent budget edits yield one successful revision and one conflict.
- Partner-private allocations never appear through aggregate values, merchant labels, budget suggestions, alerts, exports, or coverage metadata.
- Copying a budget leaves the source plan unchanged; editing a plan preserves original targets; late ledger edits refresh archived actuals.
- Duplicate import and reconciliation acceptance alone do not increase spending or emit new spending alerts; confirmed missing-event creation does.
