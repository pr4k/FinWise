# Monthly Planner

Open **Planning & household → Planner** (or **More → Planner** on mobile). Planner defaults to next month in your household timezone. Its **Planning month** picker is independent from the Dashboard reporting month and is remembered for the signed-in session; future months work without ledger entries. Choose Personal or Family and one planning currency. Combined scope asks you to choose a separate pool rather than pooling private and shared cash.

Start in **Build budget**:

1. **Income:** enter expected income, or **Pull recorded income** for the planning month. The import can replace unlinked expected income. Already-linked records cannot be imported twice. For each receipt, confirm whether it is already in starting bank funds; such income counts toward the budget but is not added to the bank forecast again.
2. **Card bills:** review open statements for this month or earlier, then plan full, partial or zero payment. The unpaid remainder stays visible. Planned payment and already-paid evidence are separate. Planning a payment does not execute it or create a transaction.
3. **Subscriptions:** tick or untick confirmed subscriptions from Recurring for this month only. Their latest observed amount supplies an editable estimate. Quarterly and annual suggestions start excluded when they are not due.
4. **Investments:** tick or untick SIPs from date-effective active schedules, or add a manual contribution. Last-month investment transactions are not required. Skipping a SIP here does not change the schedule in Investments.
5. **Other commitments:** add expenses and buffers before assigning the rest of the income.
6. **Categories:** enter additional flexible allowances, save the split, then **Review & create budget**. Review includes fixed consumption (such as selected subscriptions) in each category once. Card repayments, investment contributions and earmarks do not enter consumption limits. This creates a server-saved draft; **Activate saved budget** makes it active. Existing budgets are never overwritten. Owners/admins can publish Family budgets; users can publish their Personal budgets. The saved budget and actuals remain accessible within Planner.

**Income left to allocate** = income and household funding − selected commitments − flexible category allowances. This envelope excludes old bank balances. **Projected bank cash** uses opening bank balances plus receipts not already included in those balances, less modeled bank payments. **Available bank cash** also removes funded card and other earmarks. Expand **Starting bank funds & recorded dates** to inspect dated balance anchors. Verify opening funds for the chosen month when imports are incomplete or balances are old. Partial coverage is labeled; the forecast is not a live bank balance.

For example, income of 50,000, a planned card payment of 1,000, subscriptions of 500 and SIPs of 5,000 leave 43,500 to allocate. A further 40,000 category split leaves 3,500 of income unallocated. Any older bank cash affects the separate bank forecast.

The Planner uses the current FinWise theme, shared navigation and account/transaction APIs. Its other views include:

- **Month canvas:** five lanes, expected receipts, editable amounts and timing, account selection, item toggles, opening funds, and a protected cash floor. The guided view initializes subscription and SIP suggestions. Existing older plans retain their editable items; historic category spending is not automatically allocated in new guided plans.
- **Cash calendar:** month, agenda and data-table views, daily drilldowns, bank balances, funded card reservations, other earmarks and available cash.
- **What-if studio:** adjustable spending, investments, purchase amounts and receipt delays; save or explicitly apply a scenario as a new draft revision.
- **Sinking funds:** targets, evidence-backed existing savings and suggested monthly earmarks. These assumptions do not create account assets or move cash.
- **Plan vs actual:** authorized, scope-specific ledger allocations, explicit matching, and separate income, consumption and investment comparisons.
- **Lifecycle:** review and activate, local linked category allowances, revision history, close as a read-only snapshot, and reopen as a draft.

Card-funded consumption reserves available cash in its funding bank. Statement payments reduce bank cash and release their matching earmark; a fully funded bill does not reduce available cash twice. Only remaining statement dues enter the payment forecast. Total card outstanding is never substituted for a bill. Recorded account due amounts can seed an estimate; verify the statement month and payment evidence. Default cycle dates are explicitly unverified assumptions until configured. Unknown balances cannot fund a reserve, and funding shortfalls remain visible. Earlier projections can carry bank balances and earmarks to the next month.

Actual comparisons follow reporting classifications, including refunds, investment withdrawals, reimbursement offsets and excluded paid-on-behalf shares. Account identifiers distinguish duplicate display names. Every currency remains separate. Planner account pools exclude private accounts from Family and shared accounts from Personal.

## Persistence and existing workflows

Monthly drafts, statement evidence, scenarios and fund targets are browser-local under `fw-planner-v1:<household-id>:<user-id>`. Plans are further separated by scope, currency and month. They are not synchronized to another browser or household member. Clearing browser storage deletes these drafts. Failed storage writes display a message. Sign-out disposes the module and its listeners; another account receives its own namespace.

The canvas’s original plan activation still supplies a **local Planner allowance view**. **Build budget → Review & create budget** is the separate action that saves a real Personal or Family budget on the server. Publishing a draft and activating that saved budget do not post actual transactions or server expense commitments. Local planning edits after publication do not overwrite the saved budget. The guided view currently creates and inspects budgets; existing Family budgets can be amended through the Family budget editor. Updating an existing Personal budget from the guided split is not yet supported. The existing **Saved expenses & family budget commitments** disclosure keeps the original API-backed expense editor, matching, skip/restore and budget destinations available. Those expenses continue to feed the Dashboard. Canvas drafts and their linked allowances remain separate from these server records.

Planning changes do not post actual transactions, edit account observations, execute payments or lock bank funds. Opening funds are frozen estimates based on the latest known balances; verify them for the selected month.

## Source and verification

`web/planner-source/` contains the module sources recovered from the deployed bundle and adapted to the live host. `workflow.js` implements the guided planning flow. `host.js` isolates its state and events; `theme.css` maps the module to current FinWise tokens. `web/planner-data.js` adapts authorized API records. The generated `web/planner.js` and `web/planner.css` are served directly, so deployment needs no frontend build tooling.

After source changes, regenerate assets:

```sh
node scripts/build-planner.cjs
node --test web/tests/*.test.cjs
```

The financial regressions cover card earmark release, partial card payments, already-received income, independent income/bank envelopes, schedule suggestions, unknown/insufficient funding, currencies, scope/month isolation, reporting classifications and next-month rollover.

Browser acceptance uses a temporary database and Chrome profile, with no extra JavaScript packages:

```sh
cargo build --locked -p finwise-api
node scripts/test-planner.cjs
```

Set `FINWISE_CHROME_EXECUTABLE` when Chrome is not at the default macOS path or `chromium` on Linux. Optional `FINWISE_SCREENSHOT_DIR` saves synthetic screenshots. Checks cover editing, tabs, calendar modes, scenario refresh, fund creation, activation, linked allowances, close/reopen, scope/currency separation, reload persistence, an unchanged actual ledger, independent planning/reporting months, guided income import, partial payments, subscription/SIP suggestions, real budget creation/activation and 320–1440px layouts.
