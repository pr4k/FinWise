# FinWise frontend features and screen specifications

**Purpose:** UX redesign brief for the currently implemented browser application. This describes the working interface in `web/index.html`, `web/app.js`, `web/styles.css`, and `web/design.css` as inspected on 9 October 2026. It is a product and interaction inventory, not a proposal for new features. The browser UI is a single page app served by the Rust backend; the Svelte stack mentioned elsewhere in the repo is a direction, not the current UI.

## Product model and navigation

FinWise is a self hosted personal and household finance app. Users record or import transactions, organize accounts and categories, plan budgets and shared expenses, compare ledger entries with bank statements, and check calculated balances against observed balances. A household has a base currency and timezone. Accounts may be private or shared; the UI offers **My personal view** and **Family view** for report and budget scope. Private data and actions also depend on server permissions.

| Surface | Current behavior | Redesign requirement |
| --- | --- | --- |
| Desktop shell | Fixed left sidebar with household, primary navigation, Settings, signed in user, and sign out; top bar has breadcrumb, scope, and report month. Sidebar can collapse. | Keep the current view, household, report month, scope, and account identity visible or readily accessible. |
| Mobile shell | At 760 px and below, sidebar disappears. Bottom navigation has Home, Activity, Add transaction, Budgets, and More. More lists all views and sign out. | Make every desktop destination reachable on a phone; keep the add action prominent. |
| Routes | URL hash selects the view and some detail states. Query parameters keep month, scope, comparison month, and transaction filters through refresh. | Preserve deep links and reloadable state; do not place financial record data in the URL. |
| Feedback | Views show loading, empty, and error states; mutations use a toast. Editors use a native modal dialog. | Provide visible progress, field errors, recoverable failures, and clear results for consequential actions. |

**Navigation views:** Overview, Analytics, Transactions, Accounts, Budgets, Settle up, Investments, Categories, Statements, Reconcile, Money Manager changes, Imports, Settings. Mobile More is a navigation index. Account ledger, balance comparison, reconciliation session, and import file review are subviews.

## Global financial rules for every design

- Always show the currency with an amount. Do not combine currencies into one total. Portfolio and settle up headline totals use the household currency; other currencies can appear in detail.
- Keep **income**, **net spending** (expenses minus refunds), **recorded surplus** (income minus net spending), and **transfers** distinct. Transfers, card payments, settlement repayments, and investment records are not new spending. Investment and settlement planning records do not automatically post bank or cash movements.
- Distinguish bank or cash assets from credit card **amount owed**. A card's optional statement **payment due** and due date are separate from total debt.
- A balance needs a dated opening balance or observed balance check. Without an anchor, display **Unknown**, not zero. Show the anchor source and date. A balance check is an observation, not a transaction. Same time transaction groups can share one after group balance.
- Statement rows are evidence for reconciliation. Importing a bank statement does not create ledger spending. Attaching evidence alone does not change balances; amending or creating a transaction does.
- Reports use recorded data. Source coverage is unconfirmed unless the backend says otherwise. A flat chart or an empty period must not imply that all activity was imported.
- Use labels as well as color for positive, negative, debt, unknown, matched, and unresolved states. Align monetary values and use tabular numerals. See [financial number design policy](frontend-design-policy.md).

## Entry and household access

| Screen / state | Information and fields | Actions and behavior |
| --- | --- | --- |
| Startup | Connection status, API error, 15 second timeout, or HTTPS requirement. | Retry connection when unavailable; sign in is blocked on insecure nonlocal HTTP when the server requires HTTPS. |
| First household setup | Owner name, email, password (minimum 12 characters), household name, timezone, three letter base currency (default INR). | Create the household and owner; then enter the app. |
| Sign in | Email and password. | Sign in; expired sessions return to the sign in screen. Sign out appears in the sidebar, Settings, and mobile More. |
| Invitation | One day token link; signed in acceptance or new account registration; existing account sign in option. | Accept the invitation for the invited email, or switch accounts. Invalid links have a dedicated state. |

## Screen specifications

### 1. Overview (`#overview`)

**Goal:** Answer “What happened this month, where did money go, and what needs attention?”

- Header: selected month and Personal/Family scope; **Import statements** and **Add transaction** actions.
- Lead figures: recorded surplus or shortfall, income, net spending, and transfer volume. A cumulative income/spending chart accompanies the lead figure. Each figure has a basis label.
- Recent activity: up to 10 transactions with date, description, account path, event type, and signed amount; row opens transaction details.
- Spending snapshot: top four root categories, amounts, bars, refund explanation, and Analytics/Budgets links.
- Account snapshot: up to four active accounts with type, balance or amount owed, anchor source, and Accounts/Reconcile links. Unknown balances remain visible as unknown.
- Empty state guides a new user to Imports; coverage note remains visible.

### 2. Analytics (`#analytics`)

The **Household** view (`#household`) shows one card per active member for the selected month, with recorded income, net spending, and net investment additions in the household base currency. Selecting a member opens their expense category totals. Transactions are attributed to the person who entered them. A member sees their own personal allocations plus family allocations on accounts they can access; other members' private accounts remain excluded. Investment additions from other members appear only for holdings whose owner chose **Share monthly invested totals**. The view labels these visibility limits and does not count transfers as spending or investments.

**Goal:** Explain recorded money flow, trends, account position, and planning status for the selected month and scope.

- First row: narrative income versus spending result, category drivers, and current account balances. Unknown balance anchors are disclosed separately. Card debt is labeled as amount owed.
- Planning sections: budget performance and over limit categories; private investments and emergency funds as of month end; private settle up position as of month end. These are separate from ledger cash flow.
- Charts and visual detail: cumulative daily income/spending/surplus; six month income/spending; six month expense categories (top four plus other); daily spending against a comparison month; income and spending flows; category/subcategory bars. Exact values and accessible labels accompany charts.
- Tables: selected versus comparison month measures and expense categories; six month totals; daily totals; transaction mix; merchants; account activity; transfer count. Comparison month is selectable and stored in the URL. If it equals the report month, the UI moves it to the preceding month.
- Empty month: an explicit no activity panel may offer a jump to the latest recorded month. Coverage warning applies to all comparisons.

### 3. Transactions (`#transactions`, `#transactions/all`)

**Goal:** Browse, add, inspect, correct, and remove ledger activity.

- Default shows the selected month; **Show all dates** switches to complete history. Filters: account, account type (bank, credit card, cash, settle up), and event type (expense, income, refund, transfer), with clear filters. Filters are retained in the URL.
- Activity list is latest first, with date, description/type, account, signed amount, and actions. Dated opening balances and balance checks appear as distinct markers. Bank/card rows show reconciliation status; amended and statement created rows show Money Manager update status. Balance after and anchor context are shown where available.
- **Add transaction** dialog: description, type, positive amount, date, source account, and either destination account for a transfer or category plus Personal/Family allocation scope. Category choices change with income versus expense.
- **Transaction details** dialog: date/type/amount, movements and balances after, allocations, reconciliation evidence, source reference count, author and revision, plus amendment or statement creation history. Edit and delete actions are here.
- **Edit transaction** dialog: description, date, amount, source/destination accounts, and existing allocation category/amount/scope. Prior revisions and source references persist; balances and reconciliation may recalculate.
- **Add balance check** starts with account choice when needed, then opens the balance check editor. Money Manager changes is linked from this screen.

### 4. Accounts (`#accounts`, `#accounts/{accountId}`)

**Goal:** Manage account identity, liability context, anchors, and per account balance history.

- Account groups: Bank and cash; Credit cards; optional Settlements. Each card shows name, type, currency, visibility, balance or amount owed, anchor source, optional card payment due/date, and actions.
- **Add account**: name, bank/card/cash/settle up type, currency, private/shared visibility, optional known balance and its date/time; card adds optional statement payment amount and due date. New account balances may remain unknown.
- Owner actions: edit name/type/card due; set or edit known opening balance. A bank/card/cash account can record an observed balance check; settle up accounts cannot.
- Selected account subview: known balance, selected month's chronological ledger with signed movement, computed balance from start, displayed balance and anchor basis; manual balance checks with observed amount, computed amount, variance, stale/current/removed status. Checks can be corrected or removed while audit history remains.
- **Balance check** editor: actual amount, basis (cash count for cash; posted/current/statement closing for others), precise browser local date/time. Changing time previews the calculated balance at that instant. The check does not create a transaction.

### 5. Budgets (`#budgets`)

**Goal:** Plan category limits and compare recorded results for the selected month and scope.

- Empty state offers **Create budget**. Each plan displays name/state; planned limits, recorded spending, remaining or over plan, expected and recorded income, planned savings, and income left after plan/goals.
- Daily chart compares cumulative recorded spending, an even paced budget guide, and prior month spending. Daily values can expand. Category progress shows spent/limit and remaining/over by; variance and unbudgeted categories appear in tables.
- **Create/edit budget**: name, expected income, monthly savings goal, optional limit per active expense category. Three prior months' average spending can fill an individual limit or all empty limits. Scope, month, and currency are fixed from context. New plans are drafts.
- Managers can edit, activate a draft, or copy a plan to the next month as a draft. Archived plans cannot be edited. The UI explains that averages and flat lines have unconfirmed coverage.

### 6. Settle up (`#settlements`)

**Goal:** Track private person by person obligations without double counting expenses.

- Summary: others owe me / I owe others. Per person table groups open balances by direction and currency. Obligation table shows person, direction, type, details, remaining, status, actions, and expandable repayments.
- **Add loan or debt**: person, direction, loan/other debt, amount, date, description.
- **Split a purchase**: payer (me/other), optional linked recorded expense if I paid, description, date, purchase total, my share, and one `Name: amount` line for each other share. Shares must sum to the total. A linked expense is reused rather than recreated.
- **Record repayment**: amount, date, optional note. Edit obligation details; remove a repayment after confirmation. For split obligations, the share amount is locked. Users must record a separate bank/cash transfer if they want the repayment reflected in account balances.

### 7. Investments (`#investments`)

**Goal:** Track private holdings and emergency funds as monthly planning records.

- Household currency summary: latest recorded value, net added, and value change; only holdings in that currency with recorded values contribute. Each holding shows type, currency, latest value, net additions, value change, optional emergency target progress, optional monthly addition goal, and expandable month history.
- **Add/edit holding**: name, investment or emergency fund, currency, optional target, optional monthly addition goal. Edit can change name and goals.
- **Add/correct month**: month, added, withdrawn, month end value. Existing holdings need starting cost basis in the first month's Added field for meaningful value change. Monthly records do not post ledger transactions.

### 8. Categories (`#categories`)

**Goal:** Maintain canonical income and expense category trees used by transactions, imports, budgets, and reports.

- Separate income and expense trees show hierarchy, full path, and archived status. Active rows can add a subcategory or edit.
- **Add/edit category**: name, kind for a new root, optional parent. A subcategory inherits its parent's kind. Parent choices prevent cycles. Archived categories remain visible for historical context but are excluded from new choices.

### 9. Statements (`#statements`, `#statements/{accountId}`)

**Goal:** Compare a selected account's monthly ledger summary with uploaded statement coverage.

- Account selector, selected month; recorded opening, closing or card amount owed, and movement/debt change. Status counts ledger and statement rows awaiting matches and shows coverage.
- Uploaded month cards show filename, first/last dates, row count, inferred file opening, and file closing balance. A partial file is explicitly not a complete monthly statement. Card payment due appears when set.
- This screen summarizes statements; upload happens in Imports and row matching happens in Reconcile.

### 10. Reconcile (`#reconcile`, `#reconcile/{sessionId}`, `#reconcile/balance/{accountId}/{checkId}`)

**Goal:** Compare ledger transactions with statement evidence and explain balance differences.

- Landing: start a bank/card account review for the selected month; table of balance checks with differences; session list with state, stale indicator, unresolved counts, and open action. Existing open sessions reopen directly; closed sessions require a reason to reopen.
- Session workspace: side by side selectable ledger and statement rows, each with remaining amount, date, description, and state; attachment preview explains totals and proposed links. Exact matching can attach unique same date/amount pairs. Manual selection supports partial and many to many attachments, with a 200 link limit per decision. Matched and ignored rows remain visible below selections.
- Context actions: attach selected rows; amend amount/date with statement evidence and a reason; create a ledger transaction from selected statement rows; mark or convert an internal transfer and choose a counterpart account; ignore unmatched rows with a reason or restore them. Options appear only when the selection qualifies. Matching alone does not change balances.
- Below workspace: saved amendment table with original/proposed amounts, difference and status; Money Manager changes created from reconciliation; CSV downloads for pending source updates; eligible amendment cancellation.
- Balance comparison subview: entered check, computed from starting balance, variance, preceding ledger rows, and links to inspect a transaction, add a missing one, or open the account ledger. Editing the check is handled in Accounts.

### 11. Money Manager changes (`#changes`)

**Goal:** Help users manually keep Money Manager aligned with FinWise after edits or reconciliation.

- Pending changes table compares **Initial** and **New** transaction snapshots, with change kind (new, edited, amendment, or statement entry). **Mark updated** moves a row to completed; completed rows can be reopened.
- This is a review checklist. The app does not write changes into Money Manager automatically.

### 12. Imports (`#imports`, `#imports/{batchId}/{fileId}`)

**Goal:** Stage, map, review, and commit Money Manager workbooks or bank statement CSV/XLSX files.

- Landing: source selector, one to four `.xlsx`/`.csv` files (8 MiB each by default), upload action, sample bank CSV, import history, and a Money Manager reimport cleanup tool. Uploads are staged, not immediately committed.
- File review states: parsing with progress message; failed/omitted/cancelled with status and retry where applicable; ready/committed with preview. Multi file batches have file tabs and a return to history link. State is recoverable from the URL after reload.
- Preview summary: row count, reusable exact prior rows, unresolved count, file state, date range, totals by event type/currency, and warnings. First 200 source rows show date, description, movement, statement balance or category/account fields, and row review status.
- Mapping: a bank statement selects an existing account and DMY/MDY date format. A Money Manager file maps source accounts to existing accounts or creates private accounts with chosen bank/card/cash/settle up type; maps income and expense source categories/subcategories to canonical categories or creates them. Transfer counterparts map to accounts.
- Commit: explicit review checkbox, then commit ready rows. Exact repeats reuse existing transactions; ambiguous/changed rows remain for review. Result counts appear after commit. Bank rows become evidence; Money Manager rows become ledger transactions.
- Reimport cleanup: choose month or year, preview affected imported Money Manager transactions and skipped mixed source entries, then remove those imported transactions for upload again. Manual transactions and bank observations are excluded; balances and reconciliation may change.

### 13. Settings (`#settings`)

**Goal:** Show household identity and manage invitation and data reset tasks.

- Household table: name, timezone, base currency, signed in email, role. Members table: name, email, role.
- Owner/admin invitation form: email, member role or admin when the inviter is an owner; creates a one day link for manual copying. No email is sent by the app. Private accounts do not become shared by invitation alone.
- Owner/admin reset: choose up to 24 months, preview counts by transactions, statement entries, reconciliation sessions, balance checks, budgets, and imported rows; type `RESET` to apply. Closed reconciliation sessions must be reopened first. Account setup, opening balances, categories, original upload files, and audit history remain. Other members' private records are outside the reset.
- AI providers panel currently states configuration is unavailable. Sign out action is present.

## Shared editors and interaction states

The main create/edit flows use a modal dialog with a title, labeled fields, Cancel/Close, and a primary submit action. Some forms offer quick value chips. Submit is disabled during a request. Errors are shown in the dialog or screen; successful changes usually show a toast and refresh the current view. Deleting a transaction or repayment and removing a balance check uses a confirmation step. Import commit and monthly reset have explicit preview/review steps. A redesign should give a dialog a scrollable layout on small screens and return users to the updated context after save.

**State matrix for every screen:** initial loading; no records or no match for selected period; populated data; API failure with retry or retained form input; action in progress; successful result. Specialized states include unknown balance, incomplete source coverage, stale reconciliation/amendment, archived budget/category, failed import parse, and closed review session.

## Responsive and accessibility specifications

- Current page minimum width is 320 px. At 760 px the main navigation moves to the bottom/More pattern; at 600 px generic tables become label/value cards; transaction activity switches from table to cards by 1100 px. Charts and wide data areas can scroll horizontally. Dialogs fit the viewport and scroll internally.
- All views must remain usable on phone, tablet, and desktop, especially mapping and previewing imports, editing budget limits, selecting rows in reconciliation, and comparing balance evidence.
- Preserve a semantic page heading, labeled fields, keyboard reachable controls, visible focus, status/error announcements, and explanatory text for financial colors. Charts need exact values in accessible labels, tables, or tooltips. Honor reduced motion.
- Dates and times need clear context: report month uses household data context; balance check entry uses the browser timezone and a precise instant; imported source dates can have DMY/MDY interpretation.

## Current boundaries relevant to a redesign

The current UI supports manual transactions, imports, reports, budgets, settlement and investment planning, dated balances, and deterministic reconciliation. It does **not** yet offer AI provider configuration, automatic Money Manager updates, export of all records, or a backup/restore workflow. Do not depict those as working actions. The current reconciliation screen can reopen closed sessions, but it does not expose a close session action. Keep any new capability clearly marked as a proposal until implemented.

## UX design handoff checklist

For each redesigned screen, supply desktop, tablet, and phone layouts; populated, empty, loading, error, and disabled examples; field labels and validation copy; keyboard and screen reader behavior; and a flow for saving or recovering from interruption. Show representative cases for unknown balances, card debt/payment due, multiple currencies, refunds, partially matched statement rows, stale data, import duplicates, and a budget that is over limit. Preserve the actions and accounting distinctions above even if the navigation and visual language change.
