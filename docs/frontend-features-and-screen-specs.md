# FinWise frontend features and screen specifications

**Purpose:** UX redesign brief for the currently implemented browser interfaces. This describes the main FinWise interface in `web/` and the separate local statement classifier in `ai-service/`, as inspected on 10 October 2026. It is a product and interaction inventory, not a proposal for new features. The main browser UI is a single page app served by the Rust backend; the Svelte stack mentioned elsewhere in the repo is a direction, not the current UI.

## Product model and navigation

FinWise is a self hosted personal and household finance app. Users record or import transactions, organize accounts and categories, plan budgets and shared expenses, compare ledger entries with bank statements, and check calculated balances against observed balances. A household has a base currency and timezone. Accounts may be private or shared. Report scopes are **Personal**, **Family**, and **Combined**; Combined counts the user's personal and accessible family allocations once while keeping the two budget plans separate. Private data and actions also depend on server permissions. The separate AI statement page does not share a session or live data connection with FinWise.

| Surface | Current behavior | Redesign requirement |
| --- | --- | --- |
| Desktop shell | Fixed left sidebar with household, primary navigation, Settings, signed in user, and sign out; top bar has breadcrumb, Personal/Family/Combined scope, and report month. Sidebar can collapse. | Keep the current view, household, report month, scope, and account identity visible or readily accessible. |
| Mobile shell | At 760 px and below, sidebar disappears. Bottom navigation has Home, Activity, Add transaction, Budgets, and More. More lists all views and sign out. | Make every desktop destination reachable on a phone; keep the add action prominent. |
| Routes | URL hash selects the view and some detail states. Query parameters keep month, scope, comparison month, and transaction filters through refresh. | Preserve deep links and reloadable state; do not place financial record data in the URL. |
| Feedback | Views show loading, empty, and error states; mutations use a toast. Editors use a native modal dialog. | Provide visible progress, field errors, recoverable failures, and clear results for consequential actions. |

**Navigation views:** Overview, Household 360, Analytics, Transactions, Recurring transactions, Planner, Accounts, Budgets, Settle up, Investments, Categories, Statements, Reconcile, Money Manager changes, Imports, Settings. Mobile More is a navigation index. Member category detail, account ledger, balance comparison, reconciliation session, and import file review are subviews. The AI statement page is a separate local prototype, described below.

## Global financial rules for every design

- Always show the currency with an amount. Do not combine currencies into one total. Portfolio and settle up headline totals use the household currency; other currencies can appear in detail.
- Keep **income**, **net spending** (expenses minus refunds), **recorded surplus** (income minus net spending), and **transfers** distinct. Transfers, card payments, settlement repayments, and investment records are not new spending. Investment and settlement planning records do not automatically post bank or cash movements.
- Distinguish bank or cash assets from credit card **amount owed**. A card's optional statement **payment due** and due date are separate from total debt.
- A balance needs a dated opening balance or observed balance check. Without an anchor, display **Unknown**, not zero. Show the anchor source and date. A balance check is an observation, not a transaction. Same time transaction groups can share one after group balance.
- Statement rows are evidence for reconciliation. Importing a bank statement does not create ledger spending. Attaching evidence alone does not change balances; amending or creating a transaction does.
- Reports use recorded data. Source coverage is unconfirmed unless the backend says otherwise. A flat chart or an empty period must not imply that all activity was imported.
- Allocation scope answers whose budget/report receives an income or expense. It does not change the underlying account movement. Combined reports must not double count a transaction spanning scopes. Transfers have no allocation scope. Household 360 attributes spending and refunds to the recorded payer, income to the entrant, and shows only data the viewer may access.
- **Paid by** identifies a household member separately from the transaction author and account owner. It does not change the account movement, allocation scope, or settle up obligations.
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

### 2. Household 360 (`#household`, `#household/{memberId}`)

**Goal:** See each household member's visible monthly position without exposing private account or holding details.

- One card per active member for the selected month shows **Earned**, **Spent**, and **Invested** in the household base currency. The current user is labeled **You**; cards distinguish own records from shared records the viewer can access.
- Selecting a member opens their expense category totals with amount bars and an **All members** return action. Empty detail states say that no visible expenses were recorded.
- Income is attributed to the person who entered it; expenses and refunds use **Paid by**, falling back to the account owner for imported records and the entrant for older manual records. A member's own personal allocations and accessible family allocations are included; other members' private accounts remain excluded. Another member's investment additions appear only for holdings whose owner selected **Share monthly invested totals**. Transfers count as neither spending nor investment additions.

### 3. Analytics (`#analytics`)

**Goal:** Explain recorded money flow, trends, account position, and planning status for the selected month and scope.

- First row: narrative income versus spending result, category drivers, and current account balances. Unknown balance anchors are disclosed separately. Card debt is labeled as amount owed.
- Personal/Family/Combined scope tabs mirror the top bar. Combined shows personal and family allocations once and lists their budgets separately. Family shows the shared family budget; private investment and settle up planning panels are shown in Personal and Combined.
- Planning sections: budget performance and over limit categories; private investments and emergency funds as of month end; private settle up position as of month end. These are separate from ledger cash flow. Category rows can open the contributing expense/refund allocations and their transactions; holding rows open month by month values; person rows open obligations and payments through the selected month.
- Subscriptions section: tagged repeating payments observed in the selected month, grouped into separate currency totals with count and statement-only count. It links to Recurring transactions and is independent of the report scope. These payments are already represented by ledger or statement evidence and are not added to spending again.
- Charts and visual detail: cumulative daily income/spending/surplus; six month income/spending; six month expense categories (top four plus other); daily spending against a comparison month; income and spending flows; category/subcategory bars. Exact values and accessible labels accompany charts.
- Tables: selected versus comparison month measures and expense categories; six month totals; daily totals; transaction mix; merchants; account activity; transfer count. Comparison month is selectable and stored in the URL. If it equals the report month, the UI moves it to the preceding month.
- Empty month: an explicit no activity panel may offer a jump to the latest recorded month. Coverage warning applies to all comparisons.

### 4. Recurring transactions (`#recurring`)

**Goal:** Review detected repeating payments and maintain subscription tags.

- Summary counts and tabs: **To review**, **Subscriptions**, and **Ignored**, each with its own empty state. Each pattern card shows name, account, observed amount or range, frequency, payment count, first/latest dates, and expandable occurrence history with source.
- A pattern can be marked as a subscription, have its tag removed, be ignored, or be restored to review. The status is saved. Detection uses visible Money Manager transactions and bank statement rows; bank evidence already linked to a ledger entry counts once.
- This is observed payment history, not a future billing schedule or an automatic cancellation tool. The Analytics subscription panel uses the tagged patterns.

### 5. Transactions (`#transactions`, `#transactions/all`)

**Goal:** Browse, add, inspect, correct, and remove ledger activity.

- Default shows the selected month; **Show all dates** switches to complete history. Filters: account, account type (bank, credit card, cash, settle up), and event type (expense, income, refund, transfer), with clear filters. Filters are retained in the URL.
- Personal/Family/Combined scope tabs filter visible allocations. A transaction appears once, and its displayed amount reflects allocations in the selected scope. The activity list is latest first, with date, description/type, account, signed amount, allocation scope, and author. Dated opening balances and balance checks appear as distinct markers. Bank/card rows show reconciliation status; amended and statement created rows show Money Manager update status. Balance after and anchor context are shown where available.
- **Add transaction** dialog: description, type, positive amount, date, source account, and either destination account for a transfer or category plus Personal/Family allocation scope. Category choices change with income versus expense. The scope defaults to the setting saved for this user in this browser, not necessarily the current report scope.
- Non-transfer transactions include **Paid by**, chosen from active household members. Older manual records without it display the entrant; imported records without it display the source account owner in transaction details. Household 360 uses the same payer fallback for historical spending attribution. The payer appears in activity and details.
- **Transaction details** dialog: date/type/amount, movements and balances after, allocations, reconciliation evidence, source reference count, author and revision, plus amendment or statement creation history. Edit and delete actions are here.
- **Edit transaction** dialog: description, date, amount, source/destination accounts, and existing allocation category/amount/scope. Prior revisions and source references persist; balances and reconciliation may recalculate.
- **Add balance check** starts with account choice when needed, then opens the balance check editor. Money Manager changes is linked from this screen.
- **Move transactions to Family** opens an all dates selection of eligible personal transactions entered by the current user, with select all and confirmation. It changes their allocation scope, not account balances or source records. Transfers are ineligible.

### 6. Planner (`#planner`)

**Goal:** Keep expected one-time bills and expenses visible without posting them to the ledger.

- A plan records title, due date, expected amount and currency, optional expense category and account, and Personal or Household visibility.
- The owner can mark a plan done or planned. Status is a manual reminder state; it never creates a transaction or changes a balance or spending report. Household plans are visible to all members and may reference only household accounts and categories.

### 7. Accounts (`#accounts`, `#accounts/{accountId}`)

**Goal:** Manage account identity, liability context, anchors, and per account balance history.

- Account groups: Bank and cash; Credit cards; optional Settlements. Each card shows name, type, currency, visibility, balance or amount owed, anchor source, optional card payment due/date, and actions.
- **Add account**: name, bank/card/cash/settle up type, currency, private/shared visibility, optional known balance and its date/time; card adds optional statement payment amount and due date. New account balances may remain unknown.
- Owner actions: edit name/type/card due; set or edit known opening balance. A bank/card/cash account can record an observed balance check; settle up accounts cannot.
- Selected account subview: known balance, selected month's chronological ledger with signed movement, computed balance from start, displayed balance and anchor basis; manual balance checks with observed amount, computed amount, variance, stale/current/removed status. Checks can be corrected or removed while audit history remains.
- **Balance check** editor: actual amount, basis (cash count for cash; posted/current/statement closing for others), precise browser local date/time. Changing time previews the calculated balance at that instant. The check does not create a transaction.

### 8. Budgets (`#budgets`)

**Goal:** Plan category limits and compare recorded results for the selected month and scope.

- Empty state offers **Create budget**; in Combined scope it offers separate **Create personal budget** and **Create family budget** actions. Combined lists both plans separately. Each plan displays name/state; planned limits, recorded spending, remaining or over plan, expected and recorded income, planned savings, and income left after plan/goals.
- Daily chart compares cumulative recorded spending, an even paced budget guide, and prior month spending. Daily values can expand. Category progress shows spent/limit and remaining/over by; variance and unbudgeted categories appear in tables.
- **Create/edit budget**: name, expected income, monthly savings goal, optional limit per active expense category. Three prior months' average spending can fill an individual limit or all empty limits. Month, Personal or Family scope, and currency are fixed from the selected plan or creation action. New plans are drafts.
- Managers can edit, activate a draft, or copy a plan to the next month as a draft. Archived plans cannot be edited. The UI explains that averages and flat lines have unconfirmed coverage.

### 9. Settle up (`#settlements`)

**Goal:** Track private person by person obligations without double counting expenses.

- Summary: to collect, to pay, and people with open balances. Person cards group by direction and currency. Tabs filter **Open**, **Owed to me**, **I owe**, **Settled**, and **All**. Obligation cards show type, person, status, original and remaining amount, opening date, repayment progress, details, actions, and expandable payment history.
- **Add loan or debt**: person, direction, loan/other debt, amount, date, description.
- **Split a purchase**: payer (me/other), optional linked recorded expense if I paid, description, date, purchase total, my share, and one `Name: amount` line for each other share. Shares must sum to the total. A linked expense is reused rather than recreated.
- **Record repayment**: amount, date, optional note. Edit obligation details; remove a payment after confirmation. Delete an obligation with its payment history, or delete an entire purchase split and its related obligations; the linked ledger expense remains. For split obligations, the share amount is locked. Users must record a separate bank/cash transfer if they want the repayment reflected in account balances.

### 10. Investments (`#investments`)

**Goal:** Track private holdings and emergency funds as monthly planning records.

- Household currency summary: latest recorded value, net added, value change, and additions in the selected month. Only valued holdings in that currency contribute to value and change totals. All/Investments/Emergency funds tabs filter cards. Each card shows type, currency, latest value and valuation month, net additions, value change, optional target progress, optional monthly addition goal, and expandable month history.
- **Add/edit holding**: name, investment or emergency fund, currency, optional target, optional monthly addition goal, and **Household view** privacy choice. **Share monthly invested totals** exposes additions to Household 360 while keeping the holding's other details private. Edit can change name, goals, and sharing choice.
- **Add/correct month**: month, added, withdrawn, month end value. Existing holdings need starting cost basis in the first month's Added field for meaningful value change. Monthly records do not post ledger transactions.
- Delete a month after confirmation, recalculating later net additions and value change. Delete a holding and its monthly history after confirmation; bank transactions remain.

### 11. Categories (`#categories`)

**Goal:** Maintain canonical income and expense category trees used by transactions, imports, budgets, and reports.

- Separate income and expense trees show hierarchy, full path, Personal or Household access, and archived status. Active rows can add a subcategory or edit.
- **Add/edit category**: name, kind for a new root, optional parent. A subcategory inherits its parent's kind. Parent choices prevent cycles. Archived categories remain visible for historical context but are excluded from new choices.

### 12. Statements (`#statements`, `#statements/{accountId}`)

**Goal:** Compare a selected account's monthly ledger summary with uploaded statement coverage.

- Account selector, selected month; recorded opening, closing or card amount owed, and movement/debt change. Status counts ledger and statement rows awaiting matches and shows coverage.
- Uploaded month cards show filename, first/last dates, row count, inferred file opening, and file closing balance. A partial file is explicitly not a complete monthly statement. Card payment due appears when set.
- This screen summarizes statements; upload happens in Imports and row matching happens in Reconcile.

### 13. Reconcile (`#reconcile`, `#reconcile/{sessionId}`, `#reconcile/balance/{accountId}/{checkId}`)

**Goal:** Compare ledger transactions with statement evidence and explain balance differences.

- Landing: shared review inbox lists every accessible bank/card account for the selected month, including accounts another member has shared. Each row shows its review state and opens or starts the session; any member with account access can reconcile it. A separate table shows balance checks with differences. Existing open sessions reopen directly; closed sessions require a reason to reopen.
- Session workspace: side by side selectable ledger and statement rows, each with remaining amount, date, description, and state; attachment preview explains totals and proposed links. Exact matching can attach unique same date/amount pairs. Manual selection supports partial and many to many attachments, with a 200 link limit per decision. Matched and ignored rows remain visible below selections.
- Context actions: attach selected rows; amend amount/date with statement evidence and a reason; create a ledger transaction from selected statement rows; mark or convert an internal transfer and choose a counterpart account; ignore unmatched rows with a reason or restore them. Options appear only when the selection qualifies. Matching alone does not change balances.
- Below workspace: saved amendment table with original/proposed amounts, difference and status; Money Manager changes created from reconciliation; CSV downloads for pending source updates; eligible amendment cancellation.
- Balance comparison subview: entered check, computed from starting balance, variance, preceding ledger rows, and links to inspect a transaction, add a missing one, or open the account ledger. Editing the check is handled in Accounts.

### 14. Money Manager changes (`#changes`)

**Goal:** Help users manually keep Money Manager aligned with FinWise after edits or reconciliation.

- Pending changes table compares **Initial** and **New** transaction snapshots, with change kind (new, edited, amendment, or statement entry). **Mark updated** moves a row to completed; completed rows can be reopened.
- This is a review checklist. The app does not write changes into Money Manager automatically.

### 15. Imports (`#imports`, `#imports/{batchId}/{fileId}`)

**Goal:** Stage, map, review, and commit Money Manager workbooks or bank statement CSV/XLSX files.

- Landing: source selector, Personal/Family scope for all imported Money Manager transactions, one to four `.xlsx`/`.csv` files (8 MiB each by default), upload action, sample bank CSV, import history, and a Money Manager reimport cleanup tool. Scope defaults to the browser setting; it has no effect on bank statement evidence. Uploads are staged, not immediately committed.
- File review states: parsing with progress message; failed/omitted/cancelled with status and retry where applicable; ready/committed with preview. Multi file batches have file tabs and a return to history link. State is recoverable from the URL after reload.
- Preview summary: row count, reusable exact prior rows, unresolved count, file state, date range, totals by event type/currency, and warnings. First 200 source rows show date, description, movement, statement balance or category/account fields, and row review status.
- Mapping: a bank statement selects an existing account and DMY/MDY date format. A Money Manager file confirms the Personal/Family allocation scope, maps source accounts to existing accounts or creates private accounts with chosen bank/card/cash/settle up type, and maps income and expense source categories/subcategories to canonical categories or creates them. Transfer counterparts map to accounts.
- Commit: explicit review checkbox, then commit ready rows. Exact repeats reuse existing transactions; ambiguous/changed rows remain for review. Result counts appear after commit. Bank rows become evidence; Money Manager rows become ledger transactions.
- Reimport cleanup: choose month or year, preview affected imported Money Manager transactions and skipped mixed source entries, then remove those imported transactions for upload again. Manual transactions and bank observations are excluded; balances and reconciliation may change.

### 16. Settings (`#settings`)

**Goal:** Show household identity and manage invitation and data reset tasks.

- Household table: name, timezone, base currency, signed in email, role. **Move to household access** lists the current user’s private accounts and personal categories for explicit promotion. Promoting an account shares its full ledger and reconciliation evidence with all members; personal categories referenced by it must be promoted first. Existing categories were household visible by default. Members table: name, email, role.
- **Default transaction scope** chooses Personal or Family for new transactions, statement-created transactions, and Money Manager imports. It is saved per user in this browser and can be overridden in those flows.
- **Family only mode** is a household setting that an owner or admin can toggle. Enabling it converts existing personal transaction allocations and budgets to Family and private accounts, categories, and planned expenses to household access. If a personal and family budget collide for a month and currency, the existing family budget remains current and the converted personal budget is archived. All new transactions, imports, statement-created entries, categories, accounts, and planned expenses use Family/household access while enabled. Report scope and allocation/access selectors are hidden. Turning the mode off restores those choices but does not reverse the conversion or make shared records private again. Enabling it explicitly warns that private account history becomes visible to household members.
- Owner/admin invitation form: email, member role or admin when the inviter is an owner; creates a one day link for manual copying. No email is sent by the app. Private accounts do not become shared by invitation alone.
- Owner/admin reset: choose up to 24 months, preview counts by transactions, statement entries, reconciliation sessions, balance checks, budgets, and imported rows; type `RESET` to apply. Closed reconciliation sessions must be reopened first. Account setup, opening balances, categories, original upload files, and audit history remain. Other members' private records are outside the reset.
- AI providers panel currently states configuration is unavailable. Sign out action is present.

## Separate local AI statement page (`ai-service/`)

**Status and boundary:** This is an independent local prototype served by `ai-service/web_server.py`, outside the authenticated FinWise app. It uses a read-only snapshot of active FinWise categories and a local mapping file. It does not call the main FinWise API, change its ledger, or configure the disabled AI providers panel in Settings.

| Area | Screen specification |
| --- | --- |
| Upload | Choose or drop one CSV/XLSX statement up to 10 MB. Excel reads the first worksheet. Choose **Local Ollama** or **Mock · offline preview**, an installed local model, optional exact self name, and optional row limit (up to 2,000); then classify. File selection, model/category availability, progress, and errors are visible. |
| Local model and categories | Model selector lists installed Ollama models and offered Qwen download choices; a missing selected model can be downloaded from Ollama's library without sending a statement. An expandable list shows available FinWise category names and IDs from the local snapshot. Mock mode works without a model. |
| Results | Summary metrics show transaction count, share assigned a FinWise category, rows needing review, and likely self transfers. Results table shows source row, original description, counterparty, FinWise category, vendor type, transaction type, confidence, and review status. **All rows** and **Needs review** tabs plus text search narrow the visible rows. A redacted report expands below. |
| Output | Download **Classified CSV** and **Review CSV**. The page does not provide an in-browser approval editor: the reviewer edits the CSV and applies it through the separate CLI workflow. Uploaded files and intermediate results are temporary; confirmed mappings remain local. |

Unknown or low confidence proposals must stay visibly reviewable. A payment intermediary, bank name, transfer handle, or person's name alone must not be presented as a known merchant. The original statement file remains unchanged. A redesigned FinWise AI experience should explicitly distinguish this prototype from a future integrated import flow.

## Shared editors and interaction states

The main create/edit flows use a modal dialog with a title, labeled fields, Cancel/Close, and a primary submit action. Some forms offer quick value chips. Submit is disabled during a request. Errors are shown in the dialog or screen; successful changes usually show a toast and refresh the current view. Transaction, obligation, holding, and monthly holding deletion use a confirmation step; removing a payment or balance check also confirms. Import commit and monthly reset have explicit preview/review steps. A redesign should give a dialog a scrollable layout on small screens and return users to the updated context after save.

**State matrix for every screen:** initial loading; no records or no match for selected period; populated data; API failure with retry or retained form input; action in progress; successful result. Specialized states include unknown balance, incomplete source coverage, stale reconciliation/amendment, archived budget/category, failed import parse, and closed review session.

## Responsive and accessibility specifications

- Current page minimum width is 320 px. At 760 px the main navigation moves to the bottom/More pattern; at 600 px generic tables become label/value cards; transaction activity switches from table to cards by 1100 px. Charts and wide data areas can scroll horizontally. Dialogs fit the viewport and scroll internally.
- All views must remain usable on phone, tablet, and desktop, especially mapping and previewing imports, editing budget limits, selecting rows in reconciliation, and comparing balance evidence.
- Preserve a semantic page heading, labeled fields, keyboard reachable controls, visible focus, status/error announcements, and explanatory text for financial colors. Charts need exact values in accessible labels, tables, or tooltips. Honor reduced motion.
- Dates and times need clear context: report month uses household data context; balance check entry uses the browser timezone and a precise instant; imported source dates can have DMY/MDY interpretation.

## Current boundaries relevant to a redesign

The main FinWise UI supports manual transactions, imports, reports, budgets, settlement and investment planning, dated balances, deterministic reconciliation, Household 360, and recurring payment tagging. It does **not** yet offer AI provider configuration, automatic Money Manager updates, export of all records, or a backup/restore workflow. The separate local AI page classifies statements and exports review files, but does not import its decisions into the FinWise ledger. Do not depict these as one integrated workflow. The current reconciliation screen can reopen closed sessions, but it does not expose a close session action. Keep any new capability clearly marked as a proposal until implemented.

## UX design handoff checklist

For each redesigned screen, supply desktop, tablet, and phone layouts; populated, empty, loading, error, and disabled examples; field labels and validation copy; keyboard and screen reader behavior; and a flow for saving or recovering from interruption. Show representative cases for unknown balances, card debt/payment due, multiple currencies, refunds, partially matched statement rows, stale data, import duplicates, an over limit budget, mixed Personal/Family allocations, a shared investment total with private details, and a detected subscription with statement-only evidence. Preserve the actions and accounting distinctions above even if the navigation and visual language change.
