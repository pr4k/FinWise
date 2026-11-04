# FinWise — Current Application Feature Specification

**Version:** 1.1

**As of:** 2 November 2026
**Scope:** Application behavior represented by the current local working tree, including uncommitted changes. This is an implementation inventory, not a roadmap or a production certification.

## 1. Product purpose

FinWise is a self-hosted personal and household finance application. It helps household members record and import financial activity, understand spending, plan budgets, track investments and money owed, and verify account activity against statements and observed balances.

The main application is an authenticated, responsive browser interface backed by Rust/Axum and SQLite. The current frontend uses HTML, CSS, and JavaScript; Svelte and TypeScript are a future stack direction. A separate Python/Ollama statement-classification prototype is described in section 17.

## 2. Users, access, and reporting scope

| Concept | Current behavior |
| --- | --- |
| Household | Holds members, timezone, base currency, categories, accounts, and household settings. |
| Owner | Creates the household and manages owner-level settings, including public quick-entry and widget access. |
| Admin | Has household administration capabilities, including permitted invitations, household modes, and monthly reset. |
| Member | Uses financial features subject to account access, record ownership, and budget permissions. |
| Private account | Restricted to its owner and explicitly authorized access. Household ownership alone does not expose another member's private account. |
| Shared account | Accessible to household members; sharing includes account history and reconciliation evidence. |
| Personal report scope | Reports the signed-in user's eligible personal allocations. Investment views additionally use the ownership and payer rules in section 12. |
| Family report scope | Reports accessible family allocations and the family budget. |
| Combined report scope | Combines eligible personal and family allocations without counting them twice. The Budgets workspace is available only in Family view; Planner can separately publish Personal or Family budgets (section 9). |

Allocation scope, account visibility, payer identity, budget beneficiary, and investment ownership are separate concepts. Changing one does not automatically change the others. All views remain limited by server-side authorization.

## 3. Navigation and shared experience

The browser provides a unified Dashboard, Household 360, Transactions, Recurring transactions, Planner, Accounts, Budgets, Settle up, Investments, Categories, Statements, Reconcile, Imports, and Settings. Money Manager changes appears when its integration mode is enabled.

- Desktop uses a sidebar and a shared month/scope toolbar. Mobile uses Home, Activity, Add transaction, Budgets, and More.
- Hash routes open screens and supported record subviews. URL parameters retain report periods, scope, transaction filters, sorting, and supported tab selections.
- Screens provide loading, empty, and error states. Forms use dialogs or a transaction drawer, with validation, submission progress, and success feedback.
- Layouts adapt to phone, tablet, and desktop. Tables may become cards or scrollable regions; charts provide supporting numeric detail.
- Browser state is distinct from saved household data. For example, the default transaction scope is stored per user in the browser.

### Screen and workflow index

| Area | Entry point | Included scope |
| --- | --- | --- |
| Dashboard | `#overview` | Monthly totals, contributor details, account funds, commitments, investment observations, and integrated reports. |
| Dashboard reports | `#overview/reports`; legacy `#analytics` redirects here | Trends, Planning, Detailed reports, comparisons, and transaction drilldowns. |
| Household 360 | `#household`, `#household/{memberId}` | Accessible earned, spent, and invested totals with member category detail. |
| Transactions | `#transactions`, `#transactions/all` | Ledger search, filters, sorting, shared detail drawer, entry, correction, and voiding. |
| Recurring | `#recurring` | Candidate review, confirmed subscriptions, ignored patterns, and payment history. |
| Planner | `#planner` | Guided budget creation, monthly canvas, cash calendar, scenarios, sinking funds, and saved expenses. |
| Accounts | `#accounts`, `#accounts/{accountId}` | Accessible accounts, available funds, activity, card payments, opening balances, and observed checks. |
| Budgets | `#budgets` | Family budget setup, tracking, category limits, commitments, forecasts, and reviewed amendments. |
| Settle up | `#settlements` | Private obligations, purchase splits, repayments, Paid on Behalf, and reimbursement matching. |
| Investments | `#investments` | Holdings, funding, trades, valuations, SIPs, goals, emergency reserves, and review. |
| Categories | `#categories` | Income/expense hierarchy, tracking types, visibility, and archive/restore. |
| Statements | `#statements`, `#statements/{accountId}` | Monthly account activity and imported statement evidence. |
| Reconcile | `#reconcile`, `#reconcile/{sessionId}` | Statement matching, partial evidence, ledger corrections, transfer identification, and balance comparison. |
| Money Manager changes | `#changes` | External update work and completion tracking in Extension mode. |
| Imports | `#imports`, `#imports/{batchId}/{fileId}` | Multi-file upload, mapping, preview, commit, history, and reimport cleanup. |
| Settings | `#settings` | Household access, operating modes, reset, quick-entry configuration, and widget configuration. |

The sections below specify each feature's behavior and limits. An API capability does not imply that its full workflow is exposed in the browser. Planner drafts, scenarios, and local allowances also have different persistence from server-saved budgets and ledger records.

## 4. Financial rules

These rules apply across features and are part of their expected behavior.

| Rule | Specification |
| --- | --- |
| Money and currency | Amounts use checked integer minor units internally and decimal strings at the API boundary. Respect supported currency precision; keep currencies separate and assume no exchange rate. |
| Spending | Ordinary expense allocations count toward consumption spending, less eligible refunds. Investment allocations and existing card-settlement categories are excluded. Retained explicit reporting corrections can affect older records. |
| Income | Ordinary eligible income counts as earned income. Linked reimbursement credits do not. |
| Surplus | Recorded income minus net spending. It is a period result, not an account balance. |
| Investment cash flow | Net investment contributions equal contributions less withdrawals. After-investment cash flow subtracts net contributions from recorded surplus. Holdings and valuations have their own coverage rules. |
| Transfers | Internal movement between two accessible, different, same-currency accounts. Equal opposite movements, no budget allocations, and no new income or spending. Card payments are transfers. |
| Account balance | Derived from signed movements and a dated opening balance or observed check. Missing anchors remain Unknown. Credit cards display amount owed. |
| Observed checks | Observations of actual balances; recording a check does not create a balancing transaction. |
| Statement evidence | Importing a bank statement or attaching a match does not post ledger spending. Creating or amending a ledger entry changes financial results. |
| Coverage | Recorded activity does not prove that an entire month or account is complete. Unknown source coverage must remain explicit. |
| Corrections | Revision checks prevent silent concurrent overwrites. Voids, reversals, amendments, and relevant deletions retain audit history. |

## 5. Setup, authentication, and household membership

**Purpose:** Establish a household and control access to its data.

- First launch creates an owner with name, email, and password, plus household name, timezone, and three-letter base currency. The browser requires a password of at least 12 characters.
- Users sign in and out through server-managed sessions. Expired sessions return the browser to authentication.
- The backend uses password hashing, rotating session credentials, CSRF protection, and persistent failed-login throttling.
- Owners/admins can create authorized member invitations. Links expire after one day and are copied manually; FinWise does not send invitation email.
- Invitees can register or accept using the matching existing account. Membership does not automatically share private accounts.
- Backend member-management capabilities include role changes and revocation. The browser Settings screen primarily exposes member listing and invitations.

## 6. Accounts, balances, and available funds

**Purpose:** Show where money sits, what is owed, and what remains available after earmarking.

**Account model:** Bank, credit card, cash, investment cash, and settle-up account types are supported by the backend. The standard account-creation UI exposes bank/card/cash/settle-up choices; investment cash also participates in portfolio reporting and goal reservations.

The Accounts workspace lists all accounts accessible to the signed-in user regardless of the Personal/Family/Combined report selector. Accounts are grouped by owner, including another member's shared accounts; inaccessible private accounts remain excluded. Archived accounts are omitted from active selection while historical references remain available. Planner uses its own narrower account pools (section 9).

**Account setup and maintenance**

- Record name, currency, type, visibility, and an optional known starting balance with date/time.
- Credit cards may have a statement payment amount and due date, separate from total debt.
- Owners can edit permitted account details and correct opening balances. Structural changes are restricted once ledger activity exists; account migration is not implemented.
- Authorized private accounts and personal categories can be explicitly promoted to household access from Settings. Referenced categories must be shared before the account can be promoted.

**Account detail**

- Shows month or all-date activity, signed movements, transaction details, largest expense movements, subscription activity, balance anchors, and observed checks.
- Bank/cash account cards and detail headers lead with available funds when reservation data exists. The detail breakdown retains the full recorded balance.
- Credit-card pages show amount owed and allow partial or full payment from an eligible bank/cash account. Payment creates a transfer.
- Activity stays newest first in both month and all-date views. Starting balances and observed checks appear alongside ledger activity according to their effective instant.
- Entries sharing a timestamp can show a balance after the whole group rather than imply a reliable order within that group.

**Balance verification**

- Bank, card, and cash accounts accept dated observed checks; settle-up accounts do not.
- Checks support an appropriate basis such as posted, current, statement closing, or cash count.
- Users can preview the calculated balance at the selected instant, compare observed minus calculated, and inspect preceding activity.
- Checks can anchor calculations before and after their timestamp, including accounts without an opening balance. Later ledger changes can make a saved comparison stale without rewriting its original snapshot.

**Available funds and reservations**

- Goal reservations earmark existing bank/cash/investment-cash assets. They do not debit accounts or create expenses.
- Account detail separates recorded balance, emergency reserves, other earmarked money, and available funds, and identifies reserve shortfalls.
- Overview groups available account funds and reserves by currency. Separate emergency-fund holdings remain separate from account reserves and card liabilities.
- Private goal names remain protected even when their reserved amount affects a shared account's availability.

## 7. Transactions and categories

**Purpose:** Maintain the ledger and determine how each allocation contributes to reports.

**Transaction entry and correction**

- Create expenses, income, refunds, and transfers with amount, currency, effective date, optional precise time, description, and account movement(s).
- Categorized events have allocations whose magnitudes sum to the transaction amount. Allocations support category, Personal/Family scope, and eligible household budget attribution.
- Income entry and editing provide **Whose income is this?**. Each income allocation stores the selected active household user ID; Family scope allows another member, while Personal scope stays with the current user. The recorder remains separate.
- Expense/refund payer identity is separate from the entrant and account owner. Family attribution can target a member, Shared pool, or Unassigned.
- The editor supports category search/selection, amount calculation, description history, and quick creation of eligible accounts/categories.
- Edit or void transactions with revision checks. Details show movements, allocations, balance context, source evidence, reconciliation state, and relevant investment/subscription links.
- Supported shortcuts include paying a card, recording an investment contribution, and connecting an eligible transaction to a holding or subscription.
- A bulk action moves the current user's eligible personal allocations to Family across all dates; it does not change account movements.

**Browsing**

- Transactions default to all dates, with an option to use the selected month.
- Filters include transaction type, account, account type, category, person, direction, currency, amount range, merchant/description, and dates.
- Type filtering includes investment-category allocations. Primary and secondary sorting and filters persist in the URL.
- Reconciliation indicators distinguish unmatched, partly reconciled, reconciled, amended, and statement-created records.

**Category management**

- Maintain separate income and expense hierarchies with parent validation, personal/household access, and archive/restore behavior.
- Expense tracking types are Regular expense, Investment, and Subscription. Investment category ancestry participates in current reporting; mixed transactions are handled per allocation.
- Investment allocations leave consumption spending and budget actuals. Subscription allocations remain spending and appear in subscription workflows.
- Category changes can affect historical reporting. Archived categories remain meaningful for historical records and are excluded from normal new selections.

**Current reporting boundary:** The separate classification editor, Smart Review queue, confidence scores, classification filters, and automatic classification rules are absent from the current UI. Descriptions do not automatically override reporting types. Compatibility classification fields/endpoints and existing explicit corrections remain for historical records and reimbursement workflows. Investment funding must be unlinked before editing its protected source transaction.

## 8. Dashboard and Household 360

### Dashboard

Answers what happened in the selected month and where available money sits. Overview and Analytics share one Dashboard destination; existing Analytics links open the integrated reports section.

- Income, net spending, recorded surplus, net investment contributions, and after-investment cash flow, with a report-currency selector.
- Each of the four hero cards opens an accessible detail overlay with the authoritative total, formula, positive effects, signed offsets, top five contributors ordered by absolute effect, all contributors, and excluded transactions with reasons. Contributions are grouped by transaction; split allocations retain their signed effects.
- Personal, Family, and Combined scope controls are available on the dashboard and in the detail overlay and remain synchronized. Family-only households retain their existing scope restriction.
- Detail rows open transaction details. Close and Escape restore focus to the originating card, and contributor tabs support arrow-key navigation. Zero totals suppress undefined percentage shares; incomplete contribution detail is explicitly identified.
- Analytics-only dashboard with cumulative daily income/spending, optional previous-month spending, category mix, and six-month category history. The shared navigation retains transaction entry.
- Account snapshot separates recorded bank/cash balances, available funds, reserves, and card liabilities; unknown balances are excluded from known totals.
- Visible payer contribution cards, largest spending transactions with detail drill-downs, and separate transfer, reimbursement, and card-payment totals.
- Confirmed subscription charges, active budget progress, next-month planned expenses, card dues, SIPs, estimated monthly renewals, and data-backed month comparisons.
- Investments and recurring sections show accessible records independent of report scope and label that boundary. Future commitments remain separate from posted activity.
- Accessible account balances or available amounts, unknown anchors, account reserves grouped by currency, and separate emergency holdings.
- Investment insight cards with dated observed values and coverage limitations.

### Household 360

- Shows visible Earned, Spent, and Invested totals per active household member for the selected month in the household base currency.
- Member detail shows expense category totals.
- Income uses the explicitly selected allocation member, falling back to the entrant for older entries; expenses/refunds use the recorded payer with legacy/import fallbacks. Investment visibility follows the applicable sharing rules.
- Private accounts and holdings do not become visible through household totals. Transfers do not become spending or new investment contributions.

### Integrated dashboard reports

- Trends, Planning, and Detailed reports are sections within the Dashboard, using its selected month, scope, and report currency. Supports month comparison, category drivers, account position, and transaction drilldowns.
- Provides cumulative daily money-flow charts; six-month income/spending and category trends; daily comparison; category/subcategory detail; merchant, account, transaction-mix, and transfer summaries.
- Shows budget performance, investment/emergency-fund observations, and private settle-up planning through the selected month. Planning values remain distinct from ledger spending and balances.
- Tagged subscription payments have separate currency totals and statement-only counts. They are a breakdown of observed activity and are not added to spending again.
- Unknown coverage and missing balance anchors remain visible. An empty recorded month is not a claim that no real-world activity occurred.

## 9. Budgets and Planner

**Purpose:** Plan shared family spending and compare category limits with recorded activity and commitments.

**Budget setup and lifecycle**

- The Budgets workspace, dashboard budget cards, and integrated budget reports appear only in Family view. Plans created through the Budgets workspace use Family scope with currency, name, expected income, savings goal, shared category limits, and draft/active/archived lifecycle.
- Existing personal budgets remain stored. The Budgets workspace does not display or create them; Planner can create, inspect, and activate a saved Personal budget through its separate guided workflow.
- Limits apply either to one category or a pooled parent with descendants. Overlapping child limits under a pooled parent are rejected.
- There are no per-person allowances or person-level budget controls. Three prior months' Family-scope exact-category averages can populate category limits, with coverage caveats.
- Authorized managers can activate plans, copy them to the next month as drafts, and make permitted lifecycle changes.
- Existing-plan edits require a server-validated before/after preview, matching revision and preview hash, and an amendment reason. Worsening a negative funding gap requires explicit acceptance. Plan history retains revisions and reasons.

**Budget workspace**

- Overview, Categories, and Plan Ahead tabs share the selected month and Family scope. Personal/Combined budget links offer a switch to Family.
- Shows effective allowance, net actual spending, remaining amounts, over-limit and unbudgeted categories, savings/income comparison, commitments, and available after commitments.
- Category transaction drilldowns use authorized expense/refund allocations. Paid-by information remains separate from shared category limits. New family allocations and commitments use the shared family pool; legacy destination metadata is retained when editing transactions.
- Daily pacing compares actual spending, an even budget guide, and prior-month spending.
- A current-month forecast becomes available after seven elapsed days. It explains its rate calculation, excludes explicitly matched posted bills from the variable rate, and is labeled Limited history. Earlier dates and noncurrent months return Forecast unavailable.

**Planner**

- Defaults to next month in the household timezone with a separate planning-month picker remembered for the signed-in session; Dashboard reporting keeps its own month. Personal and Family plans use separate pools; Combined asks the user to choose a pool.
- Expected income identifies its earner using an active household member ID. Family plans can select another member; Personal plans stay with the current user. Pulling recorded income preserves that attribution, can replace unlinked expectations, and prevents importing the same linked receipt twice. Expected income does not enter Household 360 actuals.
- All card accounts in the selected scope/currency remain visible in Planner, including accounts missing statement metadata. Amount owed is shown separately; users can explicitly include an editable planning estimate without modifying Accounts. Older manual estimates are labeled distinctly.
- Current recorded card dues refresh from Accounts. A separate monthly **Due used for planning** override can be higher or lower, and resets to the latest recorded due without changing account dues or posting payments.
- The **Build budget** flow collects expected or imported recorded income, full/partial planned card payments, selectable subscription and active SIP schedules, other expenses/buffers, and a remaining-income category split.
- Shows income left to allocate separately from projected bank cash and available cash after earmarks. Dated bank anchors and partial coverage are visible. Imported income explicitly identifies receipts already included in starting bank funds so the forecast does not add them twice.
- **Review & create budget** saves a real Personal or Family budget draft with consumption category limits. Fixed consumption and flexible allowances count once; card repayments, investment contributions and earmarks remain outside spending budgets. The saved draft can be activated and inspected from Planner. Existing budgets are not overwritten, and server authorization applies.
- The monthly canvas provides five lanes, editable amounts and timing, account selection, item toggles, opening funds, and a protected cash floor. New guided plans do not preallocate historical category spending.
- The cash calendar offers month, agenda, and data-table views with daily drilldowns into bank cash, card reservations, other earmarks, available cash, and funding shortfalls.
- What-if scenarios adjust spending, investment or purchase amounts, and receipt delays. Users can save scenarios or explicitly apply one as a new draft revision.
- Sinking funds record targets, evidence-backed existing savings, and suggested monthly earmarks. These local assumptions do not create assets or account reservations in the Investments goal system.
- Plan vs actual uses authorized ledger allocations and explicit matching, with separate income, consumption, and investment comparisons. Local plans support revision history, review/activation, closing as a read-only snapshot, and reopening as a draft. Future months work without ledger records.
- Uses real authorized accounts and reporting allocations, with Personal/Family and currency isolation. Card charges reserve bank cash; due statement payments release matching reservations without counting consumption twice. Opening balances remain frozen planning assumptions; unknown funding and shortfalls are labeled.
- Card planning accepts full, partial, or zero payment and retains the unpaid remainder separately from already-paid evidence. Closed plans retain their snapshots; a newer recorded billing cycle supersedes the earlier account snapshot for the new planning month. Default cycle dates and inferred statement months remain unverified assumptions. Interest and fees are not estimated.
- Canvas plans, card evidence, scenarios, fund targets, and activation allowances are browser-local under `fw-planner-v1:<household-id>:<user-id>`, further separated by scope, currency, and month. They do not synchronize across browsers or members; clearing browser storage removes them. Failed storage writes display a message.
- Canvas activation opens a local allowance view. The guided budget-creation action separately publishes a server budget; neither action posts actual ledger entries or locks bank funds. Local edits after publication do not overwrite the saved budget. Owners/admins can publish Family budgets; users can publish their own Personal budgets. Existing Family budgets use the Family amendment editor; updating an existing Personal budget from the guided split is not supported. See [Planner integration](planner-module.md).
- The **Saved expenses & family budget commitments** disclosure retains the existing server-backed workflow below.

**Saved expenses and family budget commitments**

- Records title, due date, expected amount/currency, optional expense category/account, and Personal/Household visibility.
- Ordinary plans are reminders that can be marked done or planned; they do not post transactions.
- Eligible plans can opt into budget commitments and choose a family budget destination. Owners can skip or restore commitments.
- Explicitly matching a posted expense clears its commitment; one expense can match at most one plan. Unmatching requires a reason.
- Automatic bill matching, pending-purchase tracking, budget contributions/alerts, and a verified historical forecast remain outside the current implementation.

## 10. Recurring transactions and subscriptions

**Purpose:** Identify repeating payments and organize confirmed subscriptions.

- Detects candidate weekly, monthly, quarterly, and yearly patterns across accessible expense transactions and imported statement observations.
- Requires at least two regularly spaced payment dates. Irregular activity may not produce a candidate.
- Deduplicates linked ledger/statement evidence and exact same-date/same-amount repeats for pattern reporting.
- Provides To review, Subscriptions, and Ignored tabs; users can tag patterns, ignore them, and restore ignored patterns.
- Explicit subscription assignment can group payments with different descriptions. Transactions can be linked to an existing subscription or assigned a subscription identity.
- Subscription categories provide additional tagged activity. Recognized services may display bundled brand assets.
- Shows observed payment history, account context, selected-month totals by currency, and statement-only evidence. It does not automatically post future charges or add subscription totals to spending twice.

## 11. Settle up and reimbursements

**Purpose:** Track private person-by-person obligations and recover money paid for others.

**Loans, debts, and splits**

- Record person, direction, loan/debt kind, amount, currency, opening date, and description.
- Split a purchase into the user's share and named other shares; shares must reconcile to the purchase total.
- A purchase paid by the user can link to an existing expense rather than create another expense. A purchase paid by someone else records the applicable payable.
- Record repayments and view progress and payment history. These ordinary repayment records do not automatically move bank/cash money.
- Filter open obligations, owed to me, I owe, settled, or all. Summaries separate direction and currency.
- Edit eligible details, remove repayments, or delete obligations/splits with confirmation and retained audit history. Removing a split leaves its linked purchase expense intact.

**Paid on Behalf**

- Select an original purchase, person, and attributable amount. That amount becomes a receivable; the remaining purchase amount counts as the user's spending. The original account movement stays intact.
- Match one or more incoming credits across all dates to receivables. Partial allocations are supported; shared credit capacity cannot be overallocated.
- Linking a reimbursement does not post another account movement, count as earned income, or reduce spending a second time.
- Unlinking releases credit capacity and restores the outstanding receivable. Reversing a receivable restores its original purchase allocations and preserves history.
- Linked transactions have protections against edits that would invalidate reimbursement or investment evidence.

## 12. Investments, SIPs, and goals

**Purpose:** Track owned assets, investment funding, dated performance, and reserves without confusing them with spending.

**Workspace:** Overview, Holdings, SIPs, Activity, Goals & Emergency, and Review tabs. The Overview leads with four compact totals: Portfolio value, Net invested, Tracking return, and Emergency fund, including a target progress indicator. Coverage stays visible in short captions; full cash-flow calculations, payer/ownership attribution, valuation dates, and access rules expand under “How these totals work.” Holdings appear as compact cards with detail links, while the Holdings tab retains the full table. Tagged investment transactions are collapsed by default in Overview. Values use the selected period/cutoff; prices are manually observed rather than live market quotes.

Manual payments can be recorded from **Investments → SIPs → Record investment**, selecting the funding account and payment date. A matched debit uses **Record allotment** without a second bank movement. **Holdings → Add money** records additional contributions against the selected baseline holding and its folio; full-history holdings use dated trade/events. Add money is limited to eligible holdings owned by the current user, excludes archived holdings, and restricts funding accounts to the holding currency. Emergency-fund additions are investment contributions, with their values shown separately from the regular portfolio.

**Holding setup and access**

- Supports mutual funds, direct stocks, ETFs, deposits, retirement assets, manually valued assets, and emergency funds.
- Captures name, underlying instrument, optional identifier, platform, folio/reference, currency, tracking mode, goals, and visibility.
- Economic ownership uses dated member percentage shares. Personal portfolio values use the current user's applicable share; Family uses shared holdings; Combined shows accessible holdings without duplicate positions.
- Holding ownership and payment source remain separate. Personal tagged investment cash-flow activity uses the payer, including eligible family-scoped payments made by that user.
- Owners can edit, archive, and perform supported removal/correction actions. Sharing a holding is an explicit visibility choice.

**Tracking modes**

| Mode | Current behavior |
| --- | --- |
| Starting-value/baseline | Records an opening portfolio observation and subsequent contributions, withdrawals, and valuations. The baseline creates no bank debit or current-month contribution. Result is labeled relative to tracking history. |
| Full history | Records dated purchases, sales, paid distributions, fees, optional units, and charges. Provides remaining units, FIFO basis, realized and unrealized results, and money-weighted annualized return when supported by the stored history. FIFO reporting is not a tax-liability calculation. |

**Funding and account movements**

- New contributions/withdrawals can post their bank/cash movements when an account is selected. Valuation alone does not move money.
- Existing investment-category expenses/refunds can be linked to holdings, including amount allocations across holdings. A matching generated movement can be replaced to avoid a duplicate debit/credit.
- Full-history purchase/sale events can link existing payment evidence without posting another trade or changing units. Overallocated evidence is rejected; gaps remain reviewable.
- Investment-cash funding and later investment purchases are distinguished so internal portfolio purchases do not count as fresh external funding twice.
- Tagged investment allocations remain visible even without a valued holding; they contribute unassigned net investment activity rather than inventing portfolio values.
- Monthly corrections preserve separate linked movements, dates, and accounts. Supported month/holding removal retires generated linked movements and retains audit history.

**Valuations, history, and imports**

- Record individual monthly values or bulk dated observations. Bulk updates are atomic, reject future dates, and require explicit confirmation for zero values.
- A value older than later activity is marked pending; missing values remain Unknown. Performance is unavailable when its valuation or flow history is insufficient.
- Full-history CSV import maps event type, trade date, amount, optional units/charges, source reference, and note. Preview supports up to 500 rows before selected commit.
- Exact existing events are skipped; possible duplicates require review; changed source references require correction. CSV activity import itself creates no bank movements.

**SIPs**

- Schedule amount, day, start/end month, and active/paused status. Short months use their last day. Dated schedule changes preserve earlier expectations.
- A schedule alone creates no contribution, units, or bank transaction.
- Users can process a monthly SIP or match an existing payment. A payment-found occurrence can remain awaiting allotment without posting investment activity. Processing is protected against duplicate execution.
- Manual recording is available before a debit is matched; a matched debit switches the action to Record allotment. Processed monthly records and skipped, failed, or cancelled occurrences do not offer another manual recording action.

**Goals and emergency reserves**

- Create emergency or general goals with target, currency, visibility, and eligible asset reservations. Emergency goals include an essential-monthly-expense basis.
- Reserve existing eligible account balances or holdings and identify readily accessible assets. Reservations are capped/validated to prevent reusing the same available value across goals.
- Display allocated/accessible values, target progress, emergency coverage, valuation dates, staleness, and shortfalls. Archiving releases reservations.
- Review surfaces unassigned funding, stale/missing values, value predating activity, missing starting basis, overdue SIPs, pending allotments, and incomplete event evidence.

## 13. Imports and source provenance

**Purpose:** Bring existing activity into FinWise with explicit mapping, preview, duplicate control, and traceable source data.

- Upload one to four CSV/XLSX files per batch. Default maximum is 8 MiB per file, configurable by the server.
- Sources are Money Manager exports and supported bank statements. CSV must be UTF-8; XLSX support depends on the implemented layouts. PDF parsing is deferred.
- Parsing uses durable jobs and recoverable file/batch state. History and deep links allow a staged import to be reopened.
- Preview shows date range, totals by currency/event type, source rows, issues, prior exact occurrences, and unresolved items. The browser previews the first 200 source rows.
- Money Manager mapping connects source accounts/categories to existing canonical records or creates eligible private accounts/categories. The user confirms Personal/Family allocation scope.
- Bank-statement mapping chooses an existing account and DMY/MDY interpretation. Bank rows become immutable observations, not ledger expenses.
- Commit requires explicit review. Ready Money Manager rows create supported ledger events; unambiguous reciprocal transfers are paired.
- Exact overlapping occurrences are reused, including multiplicity for genuinely identical purchases. Changed or ambiguous rows require explicit review rather than silently overwriting the ledger.
- Original uploads, raw rows, fingerprints, source coordinates, mappings, and transaction provenance are retained. Authorized original-file download is available through the API.
- Reimport cleanup previews a month/year and voids eligible Money Manager-only imports while preserving manual entries and bank observations. Old source files and audit history remain.

## 14. Statements and reconciliation

**Statements screen:** Select an account/month to inspect recorded opening/closing movement, card debt/payment due where applicable, uploaded statement files, row counts, date coverage, inferred file balances where supported, and unmatched activity. A partial file does not prove complete monthly coverage.

**Browser reconciliation**

- An account/month inbox lists accessible bank/card accounts, open reviews, and balance differences. Authorized members can reconcile shared accounts.
- Side-by-side ledger and statement rows show unmatched, partial, matched, and ignored states and remaining signed amounts.
- Exact matching attaches only unique same-date/signed-amount/currency pairs. Manual selection supports partial and many-to-many matching with a preview and a maximum of 200 links per decision.
- Attaching evidence alone changes no financial amount. Selection-dependent actions can amend a ledger amount/date, create a missing ledger transaction from statement rows, or identify/convert an internal transfer.
- Ignoring requires a reason; ignored rows can be restored. Amendments retain original values, evidence, reasons, and relevant Money Manager follow-up status.
- Closed sessions can be reopened with a reason. Stale revisions and later transaction changes require refreshed review.
- Balance comparison connects an observed check to calculated activity and transaction inspection; editing the check belongs to Accounts.

**Additional implemented API capabilities:** Correction impact previews, duplicate-merge previews and application, match rejection, and session closure with immutable evidence snapshots. The current browser does not expose the full API workflow, including a close-session action. A closure's statement-movement variance is not a verified provider closing balance.

## 15. Money Manager operating modes

| Mode | Behavior |
| --- | --- |
| Extension, enabled by default | Tracks FinWise changes requiring manual updates in Money Manager. Changes screen compares original/new values; users mark updates complete or reopen them. Relevant reconciliation changes can be downloaded as CSV. |
| Independent | Keeps Money Manager import, bank imports, and reconciliation available while hiding the changes list, update prompts, and amendment exports. The changes API returns 404. |

Owners/admins switch the household mode with revision checking and audit history. Independent-mode edits are excluded from future external work; earlier pending changes are retained and become visible if extension mode is restored. FinWise does not write changes into Money Manager automatically.

## 16. Settings, automation access, and installation

**Household settings** show identity, timezone, currency, signed-in role, members, invitations, sharing promotion, and integration mode.

**Family only mode:** Owners/admins can convert personal allocations/budgets and private accounts/categories/plans to Family/household access. Conflicting converted personal budgets are archived while the existing family budget remains current. New records use family defaults and scope/access selectors are hidden. Turning the mode off restores choices but does not reverse the conversion or make shared history private again. Enabling explicitly warns about private-history exposure.

**Monthly reset:** Owners/admins select up to 24 months, preview affected authorized transactions, statement entries, reconciliation sessions, checks, budgets, and imported rows, and type `RESET`. Closed reviews must be reopened first. Setup, opening balances, categories, original uploads, and audit history remain. Other members' private records remain protected; cleared import months require upload again.

**Apple Shortcuts quick expenses:** The owner explicitly enables unauthenticated expense entry, chooses the member whose permissions apply, allowed accounts, and a default account. Settings provides endpoint URLs; disabling removes public access. This is intended for a trusted LAN/private VPN.

**Widget API:** Independently opt-in, unauthenticated, read-only summaries use a selected member's visible data. Personal spending is the default; owner switches permit Family/Combined spending and accessible account balances. Includes daily/calendar spending and account data. The expense calendar returns a full month grid, with zero placeholders explicitly marked for future dates and household-local cutoff metadata. Includes copyable calendar URLs and responses that may be cached for five minutes. URL selection does not override configured permissions.

**PWA installation:** Supports iOS Home Screen and Android installation with a manifest, icons, and standalone display. The service worker supplies an offline information page when navigation fails; offline ledger editing and synchronization are not implemented.

## 17. Separate local AI statement prototype

This is an independent tool in `ai-service/`, not the authenticated FinWise import workflow. Main-app AI provider configuration is unavailable.

- Accepts a CSV/XLSX statement up to 10 MB through a local page, with local Ollama or mock/offline classification. XLSX uses the first worksheet; `.xls` is unsupported.
- Uses a read-only category snapshot and local confirmed mappings. Classification does not call the main FinWise API or modify its ledger.
- Proposes counterparty, vendor type, transaction purpose, and category with confidence/evidence checks. Uncertain rows require review; intermediaries and bank names are not assumed to identify merchants.
- Displays results, search, review filtering, category coverage, likely self-transfers, and a redacted report. Exports classified/review CSVs.
- Confirmations are applied through a separate review-file/CLI workflow. The page has no integrated approval editor or automatic posting to FinWise.
- Uploaded/intermediate files are temporary; confirmed mappings remain local. Model downloads are separate from statement classification.

## 18. Operational and implementation boundaries

The main backend serves both `web/` and `/api/v1`; SQLite migrations run at startup. Docker/Compose deployment assets, liveness/readiness endpoints, OpenAPI, and generated browser API types exist. This inventory does not establish that a NAS deployment or container runtime has been validated.

Current limitations include integrated AI configuration/providers, automatic Money Manager updates, PDF parsing, broad bank-adapter coverage, category merging, general record export, budget contribution/alert workflows, and operational backup/restore. Specific downloads already exist for original source files, Money Manager reconciliation updates, and prototype AI results; these are not a complete application export.

Live market prices, automatic bank synchronization, automatic scheduled SIP execution, foreign-exchange consolidation, and offline ledger editing are not provided by the inspected workflows.

### Persistence and operational coverage

| Data or capability | Current boundary |
| --- | --- |
| Ledger, imports, statement evidence, account checks, budgets, holdings, goals, obligations, and saved expenses | Server-persisted household data with resource-specific authorization and correction rules. |
| Planner canvas, local card evidence, scenarios, sinking funds, and local allowance view | Browser-local drafts; publishing a budget is an explicit separate server action. |
| Report month, scope, filters, sorting, and supported screen tabs | Browser/URL preferences; not financial records. |
| Financial reads and retries | Collections follow cursor pagination; retried creates retain their idempotency key. Revision conflicts require refreshed data. |
| Investment workspace loading | Tab/filter changes reuse loaded data; initial funding candidates use the selected month, with older candidates fetched on demand. Short in-memory reads are invalidated after mutations and session changes. |
| Health and contract tooling | Liveness/readiness, OpenAPI, generated API types, migrations, and deployment assets exist; production readiness is not established by their presence. |

## 19. Behavioral verification examples

These examples describe the feature contract; they are not a claim that tests were run while writing this document.

| Scenario | Expected result |
| --- | --- |
| Import the same Money Manager file twice | Reuse matching source occurrences without duplicating transactions; preserve genuinely repeated purchases. |
| Import a bank statement | Create statement observations; spending changes only after explicit ledger creation/correction. |
| Pay a credit card from a bank account | Reduce bank funds and card amount owed; create no additional consumption spending. |
| View an account with no anchor | Show Unknown rather than a fabricated zero balance. |
| Reserve 20,000 from a known 100,000 account balance | Show 80,000 available and 20,000 earmarked; retain the 100,000 ledger balance. |
| Link an existing investment payment | Attach funding without duplicating the original account debit. |
| Enter a starting portfolio value | Establish a tracking baseline without creating current-month funding or a bank transaction. |
| Record a valuation before later investment activity | Retain the dated value and flag pending valuation; suppress unsupported performance. |
| Match an incoming reimbursement to Paid on Behalf | Reduce the receivable without creating another movement or earned income. |
| Match a posted expense to a commitment | Use the expense as actual spending and clear its planned commitment once. |
| Switch to Independent mode | Keep imports/reconciliation, hide external update work, and retain prior history. |
| Record Family income for another member | Attribute earned income to the selected member while retaining the recorder separately; Planner imports that attribution. |
| Open Accounts in Personal report scope | Keep all authorized shared accounts visible and grouped by owner; hide inaccessible private accounts. |
| Publish a Personal budget from Planner | Save a server budget accessible in Planner while the main Budgets workspace remains Family-only. |
| Pull an already-received income receipt into Planner | Count it toward the income envelope without adding it to starting bank funds twice; prevent duplicate linking. |
| Close a local Planner plan, then refresh Accounts dues | Keep the closed snapshot; open planning months can refresh recorded dues independently of overrides. |
| Clear browser storage | Remove local Planner drafts and scenarios; retain explicitly saved server budgets and ledger data. |
| View another member's household totals | Exclude financial data outside the viewer's access. |

## 20. Evidence and maintenance

Implementation sources take precedence over older design proposals. This inventory was refreshed on 2 November 2026 by inspecting the current working tree, tests, and feature documentation. Application and financial test suites were not run for this documentation-only update; examples above describe expected behavior rather than newly executed acceptance results.

- Browser workflows: [`web/app.js`](../web/app.js), [`web/index.html`](../web/index.html), [`web/view-state.js`](../web/view-state.js), [`web/analytics.js`](../web/analytics.js).
- Backend behavior: [`backend/src/api.rs`](../backend/src/api.rs), [`planning.rs`](../backend/src/planning.rs), [`classification.rs`](../backend/src/classification.rs), [`reimbursements.rs`](../backend/src/reimbursements.rs), [`recurring.rs`](../backend/src/recurring.rs), [`reconciliation.rs`](../backend/src/reconciliation.rs), [`balances.rs`](../backend/src/balances.rs).
- Behavioral evidence: [`backend/tests/api.rs`](../backend/tests/api.rs) and [`web/tests/`](../web/tests/), including investment, account-funds, subscription, transaction-editor, and view-state cases.
- Planner implementation: [`planner-module.md`](planner-module.md), [`web/planner-data.js`](../web/planner-data.js), and [`web/planner-source/`](../web/planner-source/).
- Workspace and loading behavior: [`frontend-features-and-screen-specs.md`](frontend-features-and-screen-specs.md) and [`performance.md`](performance.md).
- Current reporting policy: [`transaction-intelligence.md`](transaction-intelligence.md).
- Integration behavior: [`independent-app-mode.md`](independent-app-mode.md), [`quick-expense-shortcuts.md`](quick-expense-shortcuts.md), [`widgets-api.md`](widgets-api.md).
- Prototype boundary: [`ai-service/README.md`](../ai-service/README.md).

Older frontend, household-budgeting, investment, architecture, and API design documents contain both implemented and proposed behavior. Use this document as the consolidated current feature inventory; consult source and the implemented API contract for exact validation and permissions.
