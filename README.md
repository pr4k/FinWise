# FinWise

An open-source, self-hosted personal and household budgeting app in development: import multiple Money Manager and bank statements, manage bank/card/cash/settle-up accounts, plan shared expenses, reconcile the ledger against statements, and compare end-of-day ledger balances with actual bank/card balances.

**Stack direction:** Rust + Axum, SQLite + SQLx, Svelte 5 + TypeScript, packaged for a NAS with Docker Compose. SQLite is confirmed for v1.

- [Architecture](docs/architecture.md): system boundaries, household model, ledger, import pipeline, reconciliation, AI, and deployment.
- [HTTP API specification](docs/api-spec.md): versioned REST routes, request/response conventions, permissions, imports, ledger, reconciliation, analytics, budgets, and AI settings.
- [Analytics and budget tracking](docs/analytics-and-budgets.md): dashboard views, metrics, coverage, monthly plans, revisions, contributions, and alerts.
- [Money Manager import and categories](docs/money-manager-import-and-categories.md): observed XLSX format, event/category mapping, and category management.
- [Implementation plan](docs/implementation-plan.md): ordered milestones, account and multi-statement workflows, side-by-side reconciliation, end-of-day balance checks, acceptance criteria, validation, and release scope.
- The responsive preview includes a **Statements** screen for browsing monthly bank, credit-card, cash, and settle-up activity by account.

Status: the browser interface now signs in and uses the Rust API for accounts, categories, transactions, reports, budgets, statements, reconciliation review, and Money Manager imports. The backend includes sessions, account permissions, manual ledger, budgets, reports, balance checks, and deterministic XLSX/CSV imports. Deterministic reconciliation now supports partial evidence matches, corrections, duplicate merges, and closure snapshots. AI, exports, and operational backup workflows remain unimplemented. Container build and Compose files are in [deploy/](deploy/README.md). The import workflow stages an upload, maps accounts and categories, previews source rows, and commits ready rows. See [backend setup and route coverage](backend/README.md) for exact capabilities and limitations.

**Settle up** tracks private person-by-person loans, debts, shared-purchase shares, and repayments. A paid purchase can link to an existing matching expense; the split never creates another expense. **Investments** tracks holdings and emergency funds with monthly additions, withdrawals, and closing values. Value change is closing value minus cumulative net additions, so record an existing holding's starting cost basis in its first month. Monthly budgets now include a savings goal, recorded income comparison, and a category variance table. Settlement repayments and investment records are planning records; add the corresponding bank/cash ledger movements separately when you want account balances to reflect them.

Analytics brings these plans together for the selected month: budget limits versus actuals, investment additions and latest available valuations, emergency fund target progress, and private per-person settle-up balances as of month-end. It keeps planning positions separate from recorded income, spending, transfers, and account balances.

Investment and Settle up pages now include card views with filters, progress, and expandable monthly or payment histories. You can delete a monthly valuation, an entire holding, a repayment, or an obligation. Deleting a split removes all its related balances but leaves the original expense. Deletions are revision checked and retained in audit history; they do not remove bank or cash transactions.

**Recurring** lists possible weekly, monthly, quarterly, and yearly payments found across the visible expense ledger and imported bank statement rows. Linked statement evidence and exact same-date, same-amount repeats count once. Review a pattern, mark it as a subscription, or ignore it; ignored patterns can be restored from their own tab. Subscription tags are saved for the household. Analytics shows the tagged subscriptions' observed payments and totals for the selected month, with currencies separate and statement-only evidence identified. These totals are a breakdown of activity, not extra spending. Patterns require at least two regularly spaced payment dates, so irregular charges may not appear until more history is imported.

Mobile-responsive phone, tablet, and desktop workflows are required for v1, including imports, analytics, budgets, reconciliation, and AI provider settings.

## Run frontend and backend together

From the repository root, with Rust/Cargo installed:

```sh
./run.sh
```

The script loads `.env` (creating it from `.env.example` if missing) and starts one Axum server at `http://127.0.0.1:3000`. Axum serves both `web/` and `/api/v1`; a second frontend development server is unnecessary. Edit `.env` to change the bind address, data directory, or file upload size. `.env` is ignored by version control. The default config enables insecure cookies only on loopback for local HTTP; an HTTPS proxy should omit that override.

Create the household on first launch or sign in. Open Imports, choose Money Manager and the XLSX file, save account/category mappings, inspect the preview, then commit ready rows. New accounts default to private with unknown opening balances; select their actual type before saving. Exact re-uploads reuse existing transactions and source references. Transactions shows all dates by default; use “Show selected month” to filter. The report month and scope are kept in the page URL so a refresh retains the selected period. The current importer uses source occurrence matching, so changed or ambiguous rows require explicit review. Month-end coverage remains unknown until confirmed.

To rerun the opt-in workbook acceptance test without saving your workbook in the repository:

```sh
FINWISE_TEST_WORKBOOK='/absolute/path/to/export.xlsx' cargo test --locked --workspace real_money_manager_workbook_import -- --ignored --nocapture
```

Node.js is only needed for frontend API tests (`node --test web/tests/*.test.cjs`) and optional Playwright browser acceptance (`node scripts/test-web.cjs` with Playwright installed).

Owners and admins can open **Settings → Reset monthly data** to select one or multiple months (up to 24), preview the affected records, and type `RESET` to confirm. This clears transactions, statement entries, reconciliation records, balance checks, budgets, and imported rows within authorized accounts and visible budgets. Other members’ private data remains protected. Account setup, opening balances, categories, original uploaded files, and audit history are retained. Reopen closed reconciliation sessions before resetting; upload files again to reimport the cleared months.

## Run the Rust backend

```sh
FINWISE_INSECURE_LOCAL_COOKIES=true cargo run -p finwise-api
```

Open `http://127.0.0.1:3000`. SQLite migrations run automatically; the backend serves the existing preview from `web/` and the API from `/api/v1`. Secure cookies are the default; the override above is for local HTTP only. See [backend/README.md](backend/README.md) for bootstrap requests, environment settings, API examples, and test commands.
