# Frontend reference integration

The supplied `FinWise/` prototype is the layout source. The live app continues to
use its existing logo, sessions, API, permissions, ledger and planning engine.
The prototype's fictional records, local demo store and event handlers are not
loaded into the application.

`web/reference-ui.js` builds the reference page hierarchy around live view data.
The shared heading and context bar precede the page content. Native controls
are moved between routes so month and scope events remain connected. Accounts
open in a side drawer, with deep account URLs still supported. The mobile More
button opens a focus-managed navigation drawer without replacing the active page.

| Page | Reference structure |
| --- | --- |
| Overview | Monthly equation; next-month card dues; bank cash-flow hero; four purchase-period KPIs; cash payment and receipt panels; snapshot; paired charts; holdings and subscriptions; three closing panels |
| Transactions | Meaning/evidence legend; primary filters and sorting; advanced filters; currency-separated totals; expandable record cards with movements, allocations and editing |
| Accounts | Single card grid with bank balances, reservations, available funds and separate card liabilities; account detail drawer |
| Investments | Intro; full-width growth and valuation panel; holding cards; activity; additional SIP, goal, history and review tools |
| Subscriptions | Separate navigation entry; observed charges, linked payment count and service count; service cards and payment history; category-routed payments |
| Planner | Reference builder heading and tabs; seven numbered steps; sticky running summary; category allocation table; existing calendar, scenarios, funds and actuals |
| Budgets | Intro; active/empty state; saved budgets; existing forecasts, commitments and reporting details |
| Household | Personal-scope switch prompt; shared household member view |
| Settle up | Paid-on-behalf and reimbursement panel; existing loan, debt and purchase-split tools |
| Categories | Routing rows and save action; existing category hierarchy tools |
| Statements | Import empty state or recorded statements; account activity remains available |
| Reconcile | Reference empty state; existing evidence inbox, sessions and balance reviews remain available |

The current server's budgeting and access rules remain authoritative. Household
budgets stay in Family scope. Combined reporting remains available under Manage
records. Missing balances and valuations remain unknown.

`web/reference-components.css` is generated from the supplied reference CSS and
scoped to the reference page (and Planner module). Regenerate it with:

```sh
node scripts/build-reference-ui.cjs
```

`web/reference-layout.css` connects those components to the live shell and its
existing controls. Fonts are self-hosted in `web/fonts/`, with both OFL licenses.
No third-party font request is required.

Planner source changes belong in `web/planner-source/`. Regenerate its bundle:

```sh
node scripts/build-planner.cjs
```

Verification uses isolated SQLite databases and synthetic records:

```sh
node --test web/tests/*.test.cjs
node scripts/test-reference-layout.cjs
node scripts/test-dashboard-regressions.cjs
node scripts/test-navigation.cjs
node scripts/test-investment-recording.cjs
node scripts/test-planner.cjs
```

The reference-layout check covers 14 screens at 320, 390, 768, 1100 and 1500 pixels,
checks page overflow and browser errors, and exercises cash-flow drill-downs,
period controls, account drawers, transaction expansion/edit/search, category
persistence and mobile navigation. It writes desktop and mobile review images
to the operating system's temporary directory.

Dashboard regressions additionally cover Family-only spacing, cards without future
statement metadata, selected-month repayments, dated statement dues and lazy report
loading. Card repayments, amount owed and statement dues are displayed separately.
