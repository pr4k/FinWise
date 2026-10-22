# FinWise Household Budgeting and Planning

Feature specification • Version 1.0 • 22 October 2026  
Prepared for Prakhar Kaushik • Product and engineering review

## 1 Purpose and recommendation

Build a budgeting workspace that answers three questions quickly: how much room does the household have left, who is using that budget, and what is likely to happen by the end of the month?

The recommended design starts with a compact Top View, then lets users expand by person, category, account, and transaction without losing context. Combine broad spending buckets with optional detailed limits. Keep budget consumption, payment responsibility, funding contributions, and cash availability separate so the same expense is never counted twice.

This is a proposed FinWise product specification, not an audit of the current implementation. It builds on the supplied FinWise model: self-hosted personal and household finance, private and shared accounts, personal/family/combined reporting, recurring transactions, budgets, settlement, statement imports, and reconciliation. Existing behavior must be checked during implementation. All monetary examples below are illustrative rather than statements about current finances.

## 2 Review of budgeting and planning tools

Research method: review of official product documentation and feature pages accessed on 22 October 2026. This is a workflow comparison, not hands-on testing or an exhaustive assessment. Pricing, bank coverage, security claims, and subscription value are outside scope. A feature not discussed here should not be assumed absent from a product.

| Tool | Relevant documented approach | What FinWise should adopt | Design judgment for FinWise |
| --- | --- | --- | --- |
| Monarch Money | Flex budgeting groups expenses into Fixed, Non-monthly, and Flex; category budgeting is also available. Historical spending can prefill the plan. [1] | A small number of useful totals before category detail; editable starting suggestions. | Broad buckets should remain expandable. Household members need an equally clear alternative breakdown. |
| YNAB | Allocation-based planning and targets; its couples guide describes shared plans, personal categories, and separate/shared-account arrangements. [2] | Explicit allocation decisions, personal spending autonomy, deliberate treatment of shared finances. | FinWise should let one expense support personal and household reporting without requiring users to maintain duplicate records. |
| Actual Budget | Envelope budgeting allocates money already held; categories and rollovers preserve earmarked amounts. [3] | Clear remaining balances, rollover policies, reallocation history, self-hosting alignment. | Future-income planning must be labeled separately from money available now. |
| PocketSmith | Calendar budgets, daily balance forecasts, flexible periods, and account-based what-if scenarios. [4] | Forecast explanations, upcoming obligations, scenario comparison, cash timing. | Start with a focused month-end estimate; expose longer-range forecasting as a separate view. |
| Goodbudget | Shared envelope budgeting across phones and web, with money set aside for planned expenses. [5] | Simple shared limits, repeatable monthly setup, consistent cross-device totals. | Household cooperation should require little maintenance and avoid an excessively detailed default setup. |
| Splitwise | Tracks shared bills, unequal splits, payer balances, and settlement; debt simplification preserves total balances. [6] | Separate payer from expense allocation and show settlement independently. | Settlement complements a budget; it must not create additional consumption when money is reimbursed. |

**Product conclusion.** Combine a simple spending overview, allocation discipline, and forward estimates with a first-class household attribution model. The proposed differentiation is one reconciled budget that can be viewed by category or person, with clear explanations of what changed and why. This is a recommendation derived from the review, not a claim that no other product offers these capabilities.

## 3 User jobs and product boundaries

The household planner needs to set a realistic plan, reserve upcoming obligations, and see shortfalls early. Each member needs to see their own remaining budget and the shared categories they participate in. A reviewing partner needs to understand household usage without automatically gaining access to another member’s private merchants or accounts.

Primary jobs:

- In a quick check, identify budget remaining, forecast risk, and the most useful next action.
- Expand household spending into person and category detail, then inspect the underlying transactions.
- Tell whether someone paid for a purchase, initiated it, benefited from it, or contributed money to the household.
- Estimate next month from actual history and known commitments, with visible assumptions.
- Adjust a plan, record the reason, and understand the effect before saving.

Initial scope covers monthly expense budgets, member allocations, shared spending, commitments, simple forecasting, rollover, and plan history. Investment returns, tax advice, automatic bank connectivity, automatic movement of money, and autonomous changes to household limits are outside the first release. Savings and investment allocations appear in funding plans separately from expense consumption.

## 4 Budget model and terminology

Use a single canonical budget tree for a period. Every expense allocation maps to one leaf only. Its ancestors aggregate that amount once. Person totals are an alternative grouping of the same allocation records, not another set of expenses.

Default tree: Fixed expenses, Flexible expenses, and Irregular expenses. Users may rename buckets and create categories beneath them. Savings goals and investment contributions sit alongside this expense tree in the funding plan, with clearly separate totals.

| Concept | Definition and behavior |
| --- | --- |
| Planned amount | Approved expense allowance for the current period before rollover and amendments. |
| Effective allowance | Planned amount plus opening carry plus net approved amendments. |
| Spent | Posted expense allocations less posted expense refunds in the selected period. |
| Committed | Unposted obligations and distinct pending purchases expected in this period. Never includes a posted match. |
| Remaining | Effective allowance minus spent. Can be negative. |
| Available after commitments | Remaining minus committed. A budget measure, not a bank balance. |
| Forecast spending | Spent plus commitments plus estimated remaining variable spending. |
| Forecast headroom | Effective allowance minus forecast spending. Negative means projected overspend. |
| Funding contribution | A member’s planned or received contribution to the household pool. Not expense consumption or new combined household income. |
| Budget usage by person | Expense shares allocated to that person, regardless of who paid. Default People view metric. |
| Paid by person | Payments funded by that person’s accounts. Shared-account payments stay in a Shared account row unless payer identity is known. |
| Initiated by person | Optional identity of the shopper or person who made the purchase. Not inferred from the account owner. |

Account ownership, expense scope, budget attribution, and transaction visibility are independent fields. Paying for groceries from a private account does not make the expense personal. Using a shared account does not prove which member made the purchase.

### Scope rules

- **Personal:** expenses allocated to the selected person’s personal scope.
- **Family:** expenses marked shared household scope, including shared purchases funded from private accounts.
- **Combined:** deduplicated union of the selected personal and family expenses visible to the viewer.
- A person filter in Family shows that person’s attributed share of shared expenses. It does not silently switch to Personal scope.
- Filters for account, merchant, or person must show a persistent “Filtered subset” label. Household allowance is not prorated arbitrarily for an account or merchant subset.
- For a person or category with an explicit allowance, show its allowance and utilization. Otherwise show usage and “No limit set,” never 0% utilization.

## 5 Navigation and view hierarchy

Use four tabs within Budgets: **Top View**, **People**, **Categories**, and **Plan Ahead**. Keep month, scope, and active filters in a shared header. Household 360 links into Top View rather than maintaining separate budgeting calculations. Transactions and Settle up remain linked destinations.

### Top View

The default entry screen should answer the main questions within ten seconds in usability testing.

Desktop layout order:

1. Header with period, scope, member filter, data freshness, and Edit plan.
2. Four summary values: Effective allowance, Spent, Available after commitments, and Forecast headroom. Remaining and commitments appear as secondary explanations under the relevant values.
3. Three compact bucket rows showing allowance, spent, committed, and forecast status. Savings funding appears in a separate summary below these rows.
4. A People summary with member, budget usage, allowance if set, remaining, and forecast status.
5. At most three prioritized actions, followed by upcoming obligations.

Example action: “Dining is projected ₹2,000 over its limit. Review purchases or move allowance.” Each action opens the relevant filtered detail. Never show generic advice without an inspectable reason.

Keep the first viewport focused on numbers and actionable exceptions. Use one optional compact actual-versus-forecast chart below the summary. Avoid a full-height chart, multiple donuts, or a merchant leaderboard by default.

On mobile, show Available after commitments and Forecast headroom first, followed by the bucket list and collapsible People summary. Preserve negative values; do not crop them into progress bars.

### People

Default metric: **Budget used**. Optional toggles: **Paid**, **Initiated**, and **Contributed**. Each mode changes both labels and calculations; contribution mode shows planned/received contributions rather than expense allowance. Never keep an expense utilization percentage visible in contribution mode.

| Person or allocation pool | Allowance | Budget used | Committed | Available after commitments | Forecast headroom |
| --- | ---: | ---: | ---: | ---: | ---: |
| Member A | ₹25,000 | ₹18,000 | ₹2,000 | ₹5,000 | ₹1,000 |
| Member B | ₹20,000 | ₹12,000 | ₹1,000 | ₹7,000 | ₹3,000 |
| Shared household pool | ₹65,000 | ₹40,000 | ₹15,000 | ₹10,000 | ₹5,000 |
| Total | ₹1,10,000 | ₹70,000 | ₹18,000 | ₹22,000 | ₹9,000 |

Illustrative table assumes all allowance and spending are assigned. In production, add an Unassigned row whenever attribution is missing. The Shared household pool is an intentional allocation; Unassigned is incomplete data. They must remain distinct.

Expand a person to see category usage, then subcategory and transactions. Each transaction reveals paid by, account, initiated by if known, and budget shares. A household expense can remain entirely in the shared pool or be allocated across members; it cannot count in both.

Add a Category by Person matrix as an optional secondary view. Rows are categories; columns are members, Shared, and Unassigned. Toggle values between spent, allowance, and remaining. A cell opens the corresponding transactions. Show row and column totals, sticky labels, and accessible horizontal scrolling. Default to the compact person table on mobile.

### Categories

Show an expandable table: Bucket → Category → Subcategory → Transaction. Columns are effective allowance, spent, committed, available after commitments, forecast, and forecast variance. Default sort puts forecast overruns and missing attribution first; users may switch to their saved order.

For a broad flexible bucket, allow either detailed child limits or one pooled limit. In pooled mode, child categories show usage without invented limits. In detailed mode, parent allowance equals child allowances plus an explicit Unallocated allowance row. Do not allow conflicting independent parent and child totals.

Open transaction detail in a side panel on desktop and a dedicated screen on mobile. Returning restores scroll position, grouping, and filters. Breadcrumbs support direct navigation back to household or person totals.

### Plan Ahead

Show the current month forecast and a next-month plan side by side. Expand to a 12-month outlook for irregular bills and goals in a later phase. Each estimate exposes known bills, historical baseline, manual assumptions, and data-quality caveats.

Support scenarios such as a salary delay, rent increase, travel purchase, or changed household contribution. Compare expense headroom, funding gap, and projected cash low point where known balances exist. Scenarios remain drafts until explicitly applied; applying one changes future plan assumptions and creates a revision, never ledger transactions.

## 6 Creating and adjusting a budget

Setup should work without imported history:

1. Choose household period and timezone; default to the calendar month and household base currency.
2. Enter expected external income and household contributions in separate sections. Reuse contribution transfers rather than treating them as additional income.
3. Review known bills, irregular obligations, savings allocations, and spending limits.
4. Start from last month’s plan, recent complete months, or a blank template. Historical suggestions remain editable and show their source months.
5. Choose pooled or detailed limits and assign member allowances or leave an explicit shared/unallocated portion.
6. Preview total expense allowance, savings allocation, and funding gap; publish the plan.

Recommended starting suggestion for a variable category is the median of the latest three complete, comparable months after excluding transfers and matching recurring bills. Show exceptional purchases separately and let the user include or exclude them. With fewer than three complete months, label the baseline Limited history; with no usable history, require manual estimates.

Moving ₹2,000 from Shopping to Dining records a balanced budget amendment and leaves the household total unchanged. Increasing the total requires a funding source or an explicit unfunded warning. Editing person allocations must preserve category totals. Edits show before/after values and a reason, with an audit trail. Household approval is optional; explicit confirmation of a saved change is always required.

## 7 Household attribution and shared accounts

Every expense supports one or more allocation lines. Each line has an amount, category, scope, budget leaf, and attribution destination: a member, Shared household pool, or Unassigned. Split lines must sum exactly to the expense net amount. Validate money in integer minor units; use decimal-safe exchange rates for foreign currency.

Example: Member A pays ₹4,000 for a shared grocery purchase. The household chooses a 50/50 usage split. Family spending is ₹4,000; A’s budget usage is ₹2,000; B’s is ₹2,000. Paid view shows A ₹4,000. A later ₹2,000 reimbursement changes settlement balances and cash positions, with no additional budget spending.

Alternatively, the household may allocate the full ₹4,000 to Shared. In that case, neither member’s personal allowance is consumed. The People view still shows who paid when switched to Paid mode. A usage split is not automatically a debt split: who should reimburse whom is governed by a separately visible settlement rule.

Support reusable defaults by category, account, and merchant, with deterministic priority: explicit transaction allocation → matching specific rule → account/category default → Unassigned. Preview conflicting rules. Account defaults may suggest a person but must not silently assert shopper identity. Bulk assignment previews affected totals and supports undo.

For shared contributions such as ₹70,000 from A and ₹40,000 from B, show ₹1,10,000 planned funding and each member’s received amount. Do not derive member spending limits or cost shares from contribution ratios unless the household explicitly chooses that policy.

## 8 Calculations and forecasting

Use household-local transaction dates for budget periods, with a documented fallback from purchase date to posting date. Pending entries use their expected date. Changing date policy requires a preview because it can move expenses between months.

For an expense leaf in period t:

```
effective_allowance = planned + opening_carry + amendments
spent = posted_expense_allocations - posted_refund_allocations
remaining = effective_allowance - spent
available_after_commitments = remaining - unmatched_commitments
forecast_spending = spent + unmatched_commitments + remaining_variable_estimate
forecast_headroom = effective_allowance - forecast_spending
```

Do not clamp negative remaining or headroom to zero. If effective allowance is zero or negative, utilization is “No positive allowance”; display the monetary variance. Refund-heavy months may have negative net spending and must show gross purchases and refunds on expansion.

### Forecast method for the first release

Estimate each variable category from two daily rates: the median daily rate across up to three complete comparable months, and the elapsed current-period rate. Exclude recurring obligations and identified exceptional purchases from both rates. Use days elapsed and remaining in the actual calendar period, including leap years.

With adequate history, use historical rate for days 1–7, then 50% historical and 50% current rate. With incomplete history, use the current rate after seven elapsed days, marked Limited history; before that, use an explicitly entered estimate or display Forecast unavailable. Multiply the selected rate by remaining days.

Distinct pending variable purchases are counted once as commitments and included in the elapsed variable activity used for the current rate. Future scheduled bills or one-off planned purchases are commitments, excluded from variable-rate estimation. This separation prevents adding a full variable allowance on top of a forecast for the same spending.

Each recurring occurrence has a unique key and can be planned, pending, posted, skipped, or canceled. When a pending or posted transaction matches an occurrence, replace the prior representation; do not add another commitment. Uncertain matches require review and must not silently remove an obligation.

Expose the formula inputs in “How estimated.” Confidence labels are data-quality labels, not statistical probabilities. High data quality requires three complete months, no material stale data, and no unresolved duplicate/missing-attribution flags. Otherwise show the specific issue. A forecast is never presented as a guaranteed outcome.

### Cash and funding guardrails

Budget availability is not cash availability. Phase one shows budget headroom only. A later cash-aware view may show a separate Spendable cash estimate based on dated balances and account-level inflows/outflows. Suppress that estimate when relevant balance anchors are unknown or stale. Never treat an unknown balance as zero or a credit limit as cash.

A later Suggested spend room value must be the lower of flexible budget availability and accessible cash after protected reserves and obligations due before the next reliable income. Use one cashflow event per obligation: card purchases affect expense budgets at purchase time; card repayments affect bank cash at payment time. Outstanding card debt requires a reserve or dated payment forecast, including debt from earlier periods. Expected income remains separate from cash already held.

## 9 Rollover and irregular expenses

Each expense leaf chooses Reset, Carry positive only, or Carry signed balance. Default flexible categories to Reset and irregular sinking funds to Carry signed balance. Carry positive only cannot silently erase overspending: closing requires an explicit cover adjustment or recorded debt/exception before computing positive carry.

For a ₹24,000 annual insurance bill due in six months with ₹6,000 already reserved, suggest ₹3,000 monthly funding for six remaining contributions. Show the assumed contribution dates. If the due date precedes the next contribution, flag an immediate shortfall.

Sinking-fund contributions reserve money; they are not expenses. The eventual bill is the expense and consumes the reserve once. Show funding progress and bill consumption in separate columns. Never add monthly reserve contributions and the eventual bill together as total spending.

Period close snapshots the plan, attribution, actuals, carry decisions, and forecast error. Late transactions create a visible restated revision and update affected future opening carries through an explicit recalculation flow. Original closed snapshots remain accessible.

## 10 Transaction and data quality rules

| Event | Required budget treatment |
| --- | --- |
| Bank transfer or household contribution | No combined expense consumption; update funding or cash records as appropriate. |
| Credit card purchase and later repayment | Purchase consumes its expense category once; repayment is a transfer, not new spending. |
| Refund | Link to original allocation where possible; credit the period received by default and flag prior-period refunds. Optional restatement requires an audited revision. |
| Settlement between members | No second expense; update settlement independently. |
| Pending purchase becomes posted | Replace the commitment with the posted expense using a stable identity or reviewed match. |
| Duplicate imported statement entry | Deduplicate against the ledger; statement evidence alone creates no budget consumption. |
| Cash withdrawal | Transfer to a cash account; later cash purchases consume the budget. Untracked cash remains an explicit review issue. |
| Loan payment | Separate interest expense, principal cash obligation, and fees. Principal belongs to debt funding rather than ordinary expense consumption. |
| Missing person or category | Preserve the amount under Unassigned or Uncategorized; never drop it from totals. |
| Foreign-currency purchase | Store source currency and rate; aggregate base-currency allocations using the booked rate and deterministic rounding. |

Display latest import time, ledger coverage, and unresolved transaction count. Missing attribution weakens person-level interpretation even when household spending is complete. A stale account can invalidate cash estimates without invalidating every historical expense total.

## 11 Alerts and household review

Default actionable alerts: posted overspend, negative availability after commitments, projected month-end overspend, overdue household contribution, and unresolved attribution. Threshold alerts at 80% and 100% are optional. A category that is predictably paid early, such as rent, must not trigger a linear pace warning simply because it is fully used on day one.

Deduplicate alerts by budget leaf, period, and issue. Resolve them when the underlying condition clears. Let users mute optional alerts or choose a weekly digest. No automatic member ranking or shaming language.

A five-minute weekly review shows changes since the last review, the three largest actionable variances, upcoming bills, and any proposed reallocation. Acknowledge the review without locking the ledger. Monthly review compares the original plan, final plan, actual usage, forecast error, and next month’s suggested adjustments.

## 12 Privacy and permissions

Members can view their own personal detail and authorized shared activity. Household planners can edit shared budgets and permitted allocations. Read-only members can inspect authorized totals without changing plans. Private transaction detail is never exposed solely because a person belongs to the same household.

Private accounts require explicit sharing choices: excluded entirely, aggregate contribution to combined budgeting, or full detail. Aggregate sharing can expose a member’s allowed budget/usage total without exposing merchant or account details. If amounts are hidden entirely, show “Visible subset” rather than implying a complete household total. Do not leak hidden values through totals, exports, search, matrix cells, or drill-down counts.

Apply authorization on the server for every aggregate, transaction drill-down, and export. Budget visibility never grants account visibility. Audit plan changes and sharing changes with actor, timestamp, old/new values, and reason. Deleted or departing members retain historical attribution through an archived member identity.

## 13 Data and service requirements

Reuse the current FinWise ledger and household authorization rather than maintaining a parallel transaction store. Proposed records to map to the existing schema:

| Record | Minimum fields |
| --- | --- |
| Budget period | Household, local start/end dates, currency, status, revision, close snapshot. |
| Budget node | Parent, category mapping, bucket, pooled/detailed mode, rollover policy. |
| Budget allowance | Period, leaf, attribution destination, planned amount, opening carry. |
| Expense allocation | Stable transaction/split ID, leaf, scope, destination, base amount, source rate. |
| Commitment occurrence | Stable occurrence ID, due date, amount, leaf/destination, state, matched transaction. |
| Funding plan | External income assumptions, member contribution targets/receipts, savings and debt funding. |
| Amendment | Revision, balanced source/destination or new funding, actor, reason, timestamp. |
| Forecast snapshot | As-of time, input revision, formula version, estimate, data-quality flags. |

Provide services for summary, person/category aggregations, transaction drill-down, planning preview, amendments, scenarios, and period close. All views must use the same aggregation logic and revision. Money mutations are idempotent; concurrent edits use revision checks and return a conflict preview. A view cannot combine new actuals with old commitments without a visible refresh state.

For larger households and imported histories, return pre-aggregated summaries and paginate transactions. Proposed performance target: p95 summary response within 1 second and usable initial view within 2 seconds for a household with 100,000 transactions and 10 members on a documented reference deployment. Confirm the reference hardware before treating this as a release gate.

## 14 Acceptance criteria

1. Top View → person → category → transaction takes no more than three deliberate selections after opening Budgets; returning preserves filters and position.
2. A ₹4,000 purchase split equally produces ₹4,000 household spending and ₹2,000 usage for each member. Paid view shows the original payer. Reimbursement adds no consumption.
3. Member usage plus Shared plus Unassigned equals household usage for the same visible scope and revision. Category totals independently reconcile to that same amount.
4. A shared-account purchase without shopper metadata never invents a member identity. Allocation can remain intentionally Shared or explicitly Unassigned.
5. A ₹5,000 card purchase and ₹5,000 card repayment result in ₹5,000 expense consumption. Cash forecasting models the repayment once.
6. A ₹2,000 scheduled bill transitioning through pending to posted always contributes ₹2,000 total to spent plus commitment, with no duplicate.
7. Moving ₹2,000 between categories changes their remaining amounts by equal and opposite values, preserves household allowance, and records a revision.
8. A parent’s detailed allowance equals children plus explicit unallocated allowance. Person allocations cannot create an additional budget total.
9. Reset, positive-only, and signed rollover pass cross-month tests, including overspend, late refunds, and restated closed periods.
10. A missing balance anchor suppresses cash-based spend room. A missing category/person retains all spending and produces a review flag.
11. Private merchant/account details remain inaccessible through aggregates, direct URLs, exports, and unauthorized API calls. Fully hidden spending yields an explicit incomplete-total label.
12. A scenario changes no ledger entries or live plan before application. Applying it shows a diff and creates a revision.
13. Rounding a three-way split preserves the original minor-unit total with a deterministic remainder rule; dates respect household timezone and month boundaries.
14. Keyboard and screen-reader users can expand tables, inspect status, and reach transaction details. Status uses text/icons as well as color; target WCAG 2.2 AA contrast and interaction requirements.
15. At least four of five representative users can identify household remaining availability, their own usage, and a projected overrun within ten seconds in a moderated prototype test.

## 15 Delivery priorities

| Phase | Scope | Exit condition |
| --- | --- | --- |
| Foundation | Canonical allocation model, transfer exclusions, recurring matching, scope rules, authorization, migration preview. | Ledger fixtures reconcile across person/category views; private data stays protected. |
| First usable release | Top View, People table, category drill-down, pooled/detailed monthly limits, manual attribution, commitments, basic explained forecast, amendment history. | Acceptance criteria for totals, navigation, duplicates, permissions, and basic forecast pass. |
| Planning expansion | Rollover close, irregular funds, category/person matrix, next-month suggestions, attribution rules, weekly review. | Close/restate flows reconcile and suggestions are inspectable and reversible. |
| Advanced planning | Cash-aware spend room, account cashflow calendar, scenarios, 12-month outlook, richer forecast calibration, widget summary. | Known balance coverage and card/debt obligations support explainable cash projections. |

Migrate existing budgets with a preview: preserve historical actuals, map budgets into canonical leaves, put uncertain mappings under review, and leave person attribution Unassigned unless explicitly supported. Never infer historical member usage from current account ownership alone.

## 16 Success measures and decisions to validate

Measure time to answer the three main questions, weekly budget-review completion, share of spending with explicit attribution, proportion of forecast overruns reviewed, and frequency of corrections caused by double counting. Track forecast absolute error by category and household; compare against a simple historical baseline before claiming an improvement. Metrics should be local or opt-in for a self-hosted product.

Validate these proposed defaults during product review: calendar-month periods, Family as the household default, usage rather than payer as the default People metric, intentional Shared as a valid allocation, refunds recognized when received, and optional household approval for plan amendments. Custom salary cycles and advanced forecast seasonality can follow after the monthly model is reliable.

The initial prototype should exercise a shared expense paid privately, a personal purchase paid from a shared account, a credit card purchase followed by repayment, an annual bill funded monthly, and private spending shared only as an aggregate. These cases test whether the overview remains simple while the underlying numbers stay correct.

## Sources

[1] Monarch Money — Using Flex Budgeting. https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting

[2] YNAB — A Better Way to Budget as a Couple. https://www.ynab.com/guide/budgeting-as-a-couple

[3] Actual Budget — How Budgeting Works. https://actualbudget.org/docs/budgeting/

[4] PocketSmith — Budgets and Planning. https://www.pocketsmith.com/features/budgets-and-planning/

[5] Goodbudget — How It Works. https://goodbudget.com/how-it-works/

[6] Splitwise — Product features and Simplify Debts. https://www.splitwise.com/ and https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts

All source descriptions are concise paraphrases. Product design choices, formulas, defaults, phases, and acceptance criteria are proposed specifically for FinWise.
