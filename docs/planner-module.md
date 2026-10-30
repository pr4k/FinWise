# Monthly Planner

Open **Planning & household → Planner** (or **More → Planner** on mobile). The reporting month also selects the planning month; future months work without ledger entries. Choose Personal or Family and one planning currency. Combined scope asks you to choose a separate pool rather than pooling private and shared cash.

The Planner uses the current FinWise theme, shared navigation and account/transaction APIs. It includes:

- **Month canvas:** five lanes, expected receipts, editable amounts and timing, account selection, item toggles, opening funds, and a protected cash floor. Prior-month recorded income, investment contributions, subscription charges and net category spending supply editable suggestions.
- **Cash calendar:** month, agenda and data-table views, daily drilldowns, bank balances, funded card reservations, other earmarks and available cash.
- **What-if studio:** adjustable spending, investments, purchase amounts and receipt delays; save or explicitly apply a scenario as a new draft revision.
- **Sinking funds:** targets, evidence-backed existing savings and suggested monthly earmarks. These assumptions do not create account assets or move cash.
- **Plan vs actual:** authorized, scope-specific ledger allocations, explicit matching, and separate income, consumption and investment comparisons.
- **Lifecycle:** review and activate, local linked category allowances, revision history, close as a read-only snapshot, and reopen as a draft.

Card-funded consumption reserves available cash in its funding bank. Statement payments reduce bank cash and release their matching earmark; a fully funded bill does not reduce available cash twice. Only remaining statement dues enter the payment forecast. Total card outstanding is never substituted for a bill. Recorded account due amounts can seed an estimate; verify the statement month and payment evidence. Default cycle dates are explicitly unverified assumptions until configured. Unknown balances cannot fund a reserve, and funding shortfalls remain visible. Earlier projections can carry bank balances and earmarks to the next month.

Actual comparisons follow reporting classifications, including refunds, investment withdrawals, reimbursement offsets and excluded paid-on-behalf shares. Account identifiers distinguish duplicate display names. Every currency remains separate. Planner account pools exclude private accounts from Family and shared accounts from Personal.

## Persistence and existing workflows

Monthly drafts, statement evidence, scenarios and fund targets are browser-local under `fw-planner-v1:<household-id>:<user-id>`. Plans are further separated by scope, currency and month. They are not synchronized to another browser or household member. Clearing browser storage deletes these drafts. Failed storage writes display a message. Sign-out disposes the module and its listeners; another account receives its own namespace.

Activation supplies a **local Planner allowance view**, opened from the active plan. It does not publish a server family budget or create server commitments. The existing **Saved expenses & family budget commitments** disclosure keeps the original API-backed expense editor, matching, skip/restore and budget destinations available. Those expenses continue to feed the Dashboard. Canvas drafts and their linked allowances remain separate from these server records.

Planning changes do not post actual transactions, edit account observations, execute payments or lock bank funds. Opening funds are frozen estimates based on the latest known balances; verify them for the selected month.

## Source and verification

`finwise-planner/` contains the supplied module adapted to the live host. `host.js` isolates its state and events; `theme.css` maps the module to current FinWise tokens. `web/planner-data.js` adapts authorized API records. The generated `web/planner.js` and `web/planner.css` are served directly, so deployment needs no frontend build tooling.

After source changes, regenerate assets:

```sh
node scripts/build-planner.cjs
node --test web/tests/*.test.cjs
```

The financial regressions cover card earmark release, unknown/insufficient funding, real-record seeding, currencies, scope/month isolation and reporting classifications.

Browser acceptance uses a temporary database and Chrome profile, with no extra JavaScript packages:

```sh
cargo build --locked -p finwise-api
node scripts/test-planner.cjs
```

Set `FINWISE_CHROME_EXECUTABLE` when Chrome is not at the default macOS path or `chromium` on Linux. Optional `FINWISE_SCREENSHOT_DIR` saves synthetic screenshots. Checks cover editing, tabs, calendar modes, scenario refresh, fund creation, activation, linked allowances, close/reopen, scope/currency separation, reload persistence, an unchanged actual ledger and 320–1440px layouts.
