# FinWise Investment Module — Product & UX Specification
Version 1.0 · 23 October 2026 · Proposed product behavior

## 1. What the current module communicates
The supplied screen’s extracted content shows an “IndMoney-SIP” holding, current value, baseline plus net additions, value change, monthly additions/withdrawals, valuation pending, and actions to edit a movement, add/correct a month, set up a SIP, and edit/delete the holding.

This is a useful starting point for manual tracking, but the screen does not make the investment instrument, owner, source account, transaction evidence, valuation date, or completeness of return history clear. “IndMoney” identifies a platform; “SIP” identifies a contribution schedule. Neither identifies the underlying fund. A large difference between current value and recorded additions must not automatically imply profit when older contributions are missing.

This spec proposes behavior; it does not assert how the existing backend calculates values.

## 2. Product outcome
Answer five questions quickly:
1. How much do I and my household hold, and where?
2. How much new money did we contribute this month?
3. What gain or loss can we reliably calculate?
4. Which SIPs happened, are upcoming, or need attention?
5. How much of our emergency target is funded and accessible?

Support mutual funds, direct stocks, ETFs, deposits, retirement assets, investment cash, and manually valued assets. Make manual tracking fully usable without live market integrations. This is a tracking product; it does not choose securities or promise returns.

## 3. Core concepts and boundaries
| Concept | Meaning | Example |
|---|---|---|
| Instrument | Underlying security or asset | A particular mutual fund plan or listed stock |
| Holding | Position in an instrument in a specific account/folio | Prakhar’s fund units in one folio |
| Investment account | Container for holdings or investment cash | Broker account, mutual fund platform, deposit account |
| Investment event | Actual activity affecting a holding/cash | Purchase, sale, distribution, fee, transfer |
| Funding link | Evidence connecting a ledger transaction to investment activity | ICICI debit linked to fund purchase |
| SIP plan | Expected recurring contribution schedule | ₹5,000 monthly on the 5th |
| Valuation | Dated observation of asset value | ₹1,22,400 as of 31 October |
| Goal | Purpose assigned to existing assets | Emergency fund, retirement |
| Ownership | Economic share of a holding | Prakhar 60%, Arpita 40% |
| Visibility | Who may see the holding | Private or shared with household |

A SIP is not an additional asset. A goal is not an additional asset. Investment cash moved to a holding is not fresh household investment funding. The same fund in two folios remains two positions, with an optional aggregated instrument view.

## 4. Navigation and visual design
Keep one Investments navigation entry with six tabs:
**Overview · Holdings · SIPs · Activity · Goals & Emergency · Review**

Global controls: scope [Personal / Household / Combined], selected person(s), period, valuation cutoff, asset class, and account. Preserve filters when drilling down. All charts and cards must state their period and valuation coverage.

Default desktop layout:
- Header: Investments; scope selector; month selector; “Add” menu.
- First row: Current portfolio value, Net contributed this month, Gain/loss, Emergency coverage.
- Second row: Portfolio value versus net contributed chart (wide); allocation by asset class (narrow).
- Third row: Upcoming SIPs; review items such as unmatched debits and stale valuations.
- Bottom: Compact holdings table with expandable groups by person, asset class, or account.

Use a light neutral background, restrained green accents, strong numeric alignment, readable Indian currency formatting, and textual gain/loss signs. Keep data tables dense enough to scan. Red/green alone must not carry meaning. Mobile uses stacked summary cards, horizontal filter chips, and holding cards opening the same detail drawer.

Default “Add” actions: Link transaction, Add investment activity, Add holding, Update values, Create SIP, Create goal. The most prominent recurring action is **Update values**, alongside **Link transaction**.

### Scope rules
- Personal: holdings economically owned by the current person, weighted by ownership.
- Household: shared holdings plus holdings that members explicitly share with the household; group by economic owner.
- Combined: current person’s private holdings plus the household-visible holdings they can access, deduplicated by holding ID.
- Person filter means ownership, not payment source. Provide a separate “Funded by” filter.
- Show “Limited household coverage” when access is incomplete. Never reveal hidden balances or names through totals, exports, alerts, charts, APIs, or search.

## 5. Overview and holding list
| Display | Required behavior |
|---|---|
| Current value | Sum latest eligible values on/before cutoff; show mixed-date status and coverage |
| Monthly contributions | Gross external contributions, withdrawals, and net shown separately |
| Gain/loss | Clearly identify lifetime or since tracking start; hide unsupported percentages |
| Emergency coverage | Allocated eligible value ÷ essential monthly expense basis |
| Chart | Separate contributions from performance; mark valuations and missing history |
| Allocation | Asset class by value; separate currency and account breakdowns optional |
| Attention queue | Missing values, unmatched activity, duplicate candidates, pending SIPs |

Holding table columns: Name/instrument, owner(s), account/folio, asset class, remaining cost basis or tracking baseline, current value, gain/loss, valuation date, monthly contribution, status. Allow hide/reorder columns. Show account cash separately.

Avoid presenting a live-looking total from old observations. Example label: “₹8.42L tracked value · 8 of 10 holdings valued · dates 30 Sep–23 Oct.” Unknown values are unknown, not zero. Excluded unknown holdings remain visible in coverage.

## 6. Holding setup and detail
### Two setup modes
**Full-history mode:** enter/import purchases, sales, fees, distributions, units, and prices. Calculate cost basis and returns only where supporting data exists.

**Track from a starting date:** enter opening units where known and opening market value as of a date; optionally enter verified original cost. Label this amount “Tracking baseline,” never “Total invested.” Opening balance creates no bank transaction and no current-month contribution.

Allow moving to full-history mode after backfilling and reconciling history. Never retain both the opening position and the historical purchases that created it.

Minimum holding fields: display name, asset class, instrument if known, investment account/folio, currency, economic owner(s), visibility, tracking mode, start date, and baseline or opening activity. Optional tags, notes, goal allocations and documents.

For mutual funds, capture scheme, direct/regular and growth/distribution distinctions, folio, and identifier when known. For stocks, capture exchange/ticker and security identifier when available. Platform name is an account attribute.

### Detail view
Header: name, owners, account, tracking mode, data completeness.
Cards: current value and date; remaining basis; unrealized gain/loss; realized gain where supported; distributions; monthly additions.
Tabs: Timeline, Monthly history, SIPs, Valuations, Linked transactions, Goals, Details.

Monthly history columns: opening value, external funding, purchases, sale proceeds, distributions, fees, closing value/date, performance amount, completeness. Purchases and funding must remain distinguishable. A missing month-end valuation displays “Not valued,” not a fabricated closing value.

## 7. Transaction-to-investment connection
### Entry points
From Transactions, provide **Connect to investment** on a row and in bulk actions. From Investments, **Link transaction** opens the same flow. Show a reciprocal link on both records.

### Linking flow
1. Select one or more existing ledger entries; show amount, date, source account, description, and existing links.
2. Choose activity: direct purchase, fund investment cash, withdrawal/redemption, distribution, fee, or internal transfer.
3. Choose the destination account and holding, or create a holding inline.
4. Confirm actual trade/allotment date, amount allocation, optional units/price, charges, and ownership.
5. Review accounting impact: bank cash, investment cash/holding, spending classification, contribution totals, and unmatched remainder.
6. Save atomically and show the linked evidence.

A bank debit can fund several funds: ₹15,000 debit → ₹5,000 Fund A + ₹10,000 Fund B. Several debits can fund one purchase. A ₹10,000 debit with ₹9,950 acquisition and ₹50 fee must reconcile to the full debit. Unallocated remainders stay visible in Review; block over-allocation.

### Two funding paths
**Direct debit to fund:** link the bank debit to the purchase as one external contribution.
**Broker wallet:** bank debit funds investment cash; later purchases consume that cash. Buying securities adds no second external contribution.

Example: ₹20,000 transferred to a broker, ₹12,000 invested in stock, ₹8,000 still cash. Portfolio contains ₹12,000 stock plus ₹8,000 cash; contributed amount is ₹20,000.

A redemption first moving into broker cash is internal. Its later withdrawal to the bank is the external outflow. Never count the sale and withdrawal twice.

### Matching and import
Suggest candidates using account, amount, payee/reference, date range, and known SIP plan. Show why a match was suggested. Initial release requires confirmation; uncertain matches never auto-post.

Bank import plus broker import must reconcile funding evidence with economic events rather than creating two purchases. Use source IDs and import fingerprints for idempotency, plus a duplicate review queue for uncertain matches.

Support “Already recorded—link evidence only.” Linking to an existing event must not change quantities or contributions. Unlinking removes evidence, not the economic event, unless the user explicitly reverses it with a preview.

Pending bank debits are “Awaiting allotment”; display them as pending funding outside confirmed units. Failed/refunded payments reverse the pending funding when matched. Never estimate units merely from the bank debit.

## 8. Monthly contributions and SIPs
Monthly contribution reports use settled external funding dates in household timezone. Trade dates drive holding activity. Display both where they differ. Include a reconciliation bridge for funding held in cash, pending allotment, and purchases financed from older cash.

Report gross contributions, external withdrawals, net contribution, planned SIP amount, confirmed SIP amount, and variance. Opening balances, appreciation, reinvested distributions, and internal switches do not count as new contributions.

SIP fields: holding, payer/source account, planned amount, frequency, due day/date, start/end, owner attribution, reminder, and active/paused/ended status. Plan changes are effective-dated.

Occurrence states: Upcoming, Due, Payment found, Awaiting allotment, Invested, Failed, Skipped, Overdue, Cancelled. Calendar and list views share the same occurrences. A schedule never creates a posted bank transaction or units. Pausing affects future occurrences only.

Permit variable amounts, extra purchases, multiple SIPs into one fund, business-day delays, retries, and split matching. Configurable grace window prevents a payment delay from being labeled failed prematurely.

## 9. Manual valuations
Provide **Update values** as a bulk table:
Holding | Previous value/date | New value | As-of date | Source | Note.
Prefill previous values only as reference, never as newly confirmed observations. User must explicitly enter or confirm each saved row.

Modes:
- Unit-priced: units × dated NAV/market price.
- Total-value: enter actual total position value.
- Cash/deposit: confirmed balance, with accrued interest distinguished where tracked.

Keep valuation history, source, timestamp, effective date, editor, and change reason. Corrections create audit history. Future as-of dates are rejected. A value of zero is permitted only with explicit confirmation.

For total-value mode, activity after the latest valuation does not silently mutate that observed value. Show latest observed value and optionally a separate “flow-adjusted estimate,” with assumptions and no implied market return. Request a new valuation for current P&L.

For unit-priced mode, updated units × latest known price may be shown as an estimate with price date; it is not a fresh market observation. Historical valuation snapshots never change because of later transactions. Backdated corrections recompute affected derived history and show the resulting changes.

Staleness threshold is configurable by asset class. Present fresh/stale/missing states. Do not add positions valued before tracking start or after the selected cutoff.

## 10. Return and P&L rules
These are product accounting conventions, not a tax calculation engine.

### Whole-portfolio economic result
For an observation period with complete cash flows and valid start/end values:
**Performance amount = end value − start value − external contributions + external withdrawals + distributions paid outside the portfolio.**

Portfolio boundaries matter. A distribution retained in investment cash is already in end value and must not be added again. Fees debited from portfolio cash are already reflected; separately paid investment expenses reduce performance once. Use consistent fee-inclusive treatment throughout.

### Holding-level results
- Remaining cost basis = acquisition cost including configured acquisition charges, less cost assigned to disposed units.
- Unrealized gain/loss = current market value − remaining cost basis.
- Realized gain/loss = net disposal proceeds − assigned cost of disposed units.
- Total economic result includes realized/unrealized result and cash distributions, with each fee counted once.
- Default lot allocation: FIFO for reporting; explicitly label methodology. Do not present these values as tax liability.
- Without units/history, show cash-flow-based performance since tracking start; do not fabricate realized/unrealized splits.
- Baseline is market value at tracking start; gains before that date are unknown unless original cost/history exists.

For simple absolute return, use unrealized gain ÷ remaining basis only when basis is known and positive, and label it “Unrealized return.” Do not label it annualized.
Money-weighted annualized return (XIRR) requires dated flows, a terminal value, appropriate positive and negative flows, and a convergent solution. If insufficient or non-convergent, display unavailable with reason. TWR requires valuations around external flows; defer until coverage supports it.

### Period versus lifetime
Never subtract lifetime contributions from a selected month’s value to claim monthly profit. Monthly performance requires a valid opening and closing valuation and all period flows. Aggregate performance only over covered positions; show coverage and avoid comparing partial P&L with full portfolio value.

Worked examples:
| Situation | Expected result |
|---|---|
| Start ₹1,00,000; add ₹10,000; end ₹1,14,000 | Period performance ₹4,000 |
| Start ₹1,00,000; withdraw ₹20,000; end ₹85,000 | Period performance ₹5,000 |
| Opening market baseline ₹1,00,000; add ₹10,000; end ₹1,14,000; old cost unknown | ₹4,000 since tracking start; lifetime return unavailable |
| Buy for ₹1,00,000; sell half for ₹60,000; remaining value ₹55,000; no fees | FIFO basis sold ₹50,000; realized ₹10,000; unrealized ₹5,000 |
| No opening valuation or verified basis | Current value shown; unsupported P&L unavailable |

## 11. Family ownership and funding
Capture separately: legal holder/account owner, economic owner shares, person who paid, visibility, and goal beneficiary. Ownership shares sum to 100%; do not infer ownership from the bank account.

Example: Prakhar pays ₹10,000 from ICICI for a joint holding owned 60/40. Funding report credits Prakhar ₹10,000; ownership view allocates value and attributable performance 60/40. Household total counts the holding once.

Ownership changes are effective-dated internal transfers with zero household external contribution. Do not rewrite prior month ownership. Preserve lot/basis attribution and valuations at transfer when available; flag person-level performance incomplete otherwise.

Family view includes:
- Person comparison: owned value, current-month paid contributions, attributed contributions, reliable P&L, planned SIPs.
- Shared holdings section with ownership breakdown.
- Household goals with asset allocations.
- Funding-versus-ownership report explaining differences.
- Access controls: owner, explicitly granted editor, viewer. Household membership alone does not grant edit access.

Do not create spouse reimbursement debts automatically. Offer an explicit link to Settle up only when requested.

## 12. Emergency fund and goals
Emergency fund is a goal allocation across eligible existing assets: bank savings, deposits, cash, or selected holdings. It must not create a second copy of those balances.

Setup: beneficiary/scope, essential monthly expense amount, calculation basis and period, target months, target amount, existing allocations, accessibility and liquidity assumptions. Let the user override expense basis; exclude investment transfers and one-off purchases from an automatically suggested expense average.

Display target, allocated value, readily accessible amount, shortfall, months covered, stale-value warning, and next planned addition. Label user-defined liquidity assumptions. Market-exposed funds remain visibly market-exposed; never describe them as guaranteed.

Goal allocations may be fixed amounts or percentages, but total allocations across goals cannot exceed each asset’s available value. Recompute percentage allocations with value changes; fixed allocations above current value create a shortfall warning. Prevent emergency liquidity from being simultaneously promised to another goal.

Use a canonical asset ID when referencing a bank account balance. Net worth counts that account once even if it appears in the emergency view. Unvalued or inaccessible allocations must not inflate readily accessible coverage.

## 13. Accounting integration across FinWise
- Purchases and investment funding are transfers/asset movements, excluded from household consumption spending.
- Contributions remain visible as a separate allocation of income in budget reports.
- Unrealized appreciation creates no bank income transaction.
- Distributions and interest paid into bank accounts can be investment income, linked once.
- Sale proceeds split into returned capital and realized result for investment reporting; do not classify the whole receipt as salary/income.
- Goal reservation inside the same account does not invent a ledger transfer.
- Every canonical account/asset appears once in net worth; ownership is applied after deduplication.
- Account reconciliation uses actual statement balances; valuation evidence does not overwrite bank ledger balances.

## 14. Review, correction, and reliability
Review queue types: unlinked investment-like ledger entries; unmatched investment events; allocation remainder; duplicate candidates; pending allotment; missing cost/units; stale/missing valuation; ownership conflict; incomplete history.

Each item explains the issue and offers one primary action. Support undo through auditable reversals. Block deleting a holding with activity; archive instead. Deleting or reversing linked transactions must show affected investments, reconcile changes atomically, and leave no orphan links.

Imports support preview, mapping, duplicate detection, error rows, batch rollback where safe, and original source retention. Use decimal arithmetic for money and quantities; store currency and instrument precision. Round for display only. Audit who changed what and when.

For MVP, non-base currency holdings retain original currency and appear separately unless dated FX is supplied. Never sum different currencies directly. Converted totals disclose FX date and missing coverage.

## 15. Minimal implementation model
| Entity | Key information |
|---|---|
| Instrument | Type, identifiers, name, currency, price precision |
| Investment account | Platform, legal owner, cash account reference |
| Holding | Instrument/account/folio, mode, start date, visibility |
| Ownership interval | Holding, member, effective interval, share |
| Investment event | Type, trade/settlement dates, amount, units, price, charges, status |
| Funding allocation | Ledger entry, event/cash destination, allocated amount, FX if applicable |
| Valuation | Holding/account, as-of, total or price, source, revision |
| SIP plan/occurrence | Effective schedule and actual matched event references |
| Goal/allocation | Target, beneficiary, canonical asset, reservation amount/share |
| Import/audit record | Source identity, fingerprint, changes, actor, timestamps |

Financial event creation, funding allocations, and ledger classification updates commit together. Read models are derived and rebuildable. Enforce server-side authorization and unique import identities. Keep observed values distinct from calculated estimates.

## 16. Delivery plan
**MVP:** holdings and accounts; opening baseline; direct purchase/sale and broker cash paths; transaction linking/splits; household permissions and ownership; manual dated values; contribution reports; supported P&L; SIP schedule/matching; emergency goal allocations; review queue and audit.
**Next:** unit-level CSV imports, corporate actions, bulk valuation import, richer return analytics, historical FX and advanced reconciliation.
**Later:** market-price integrations and broker/statement automation with explicit provenance.

Until corporate actions are supported, stock splits, mergers, reinvestments, and transfers require explicit adjustment events and review. They must never appear as fresh cash contributions.

## 17. Acceptance criteria
1. Link a ₹5,000 bank debit to an existing purchase: no second expense, purchase, or contribution.
2. Split one ₹15,000 debit across two funds: allocations reconcile; over-allocation rejected.
3. Fund broker cash ₹20,000 and buy ₹12,000 stock: net contribution ₹20,000; value includes ₹8,000 cash once.
4. SIP due date arrives without payment: upcoming/due state changes; ledger and units remain unchanged.
5. Mark payment found but allotment pending: confirmed units and market-valued holdings remain unchanged.
6. Enter opening baseline and later value: show performance since start; lifetime return stays unavailable without history.
7. Add ₹10,000 to a ₹1,00,000 opening portfolio and value it at ₹1,14,000: show ₹4,000 period performance.
8. Sell and later withdraw the same proceeds: external withdrawal counted once.
9. Pay from one member’s account into a joint holding: payer report and ownership report differ correctly; household totals deduplicate.
10. Reserve the same asset for emergency and another goal: allocation cap prevents double reservation; net worth unchanged.
11. Select a historical month: future activity and valuations do not leak into results.
12. Latest valuation predates a contribution: observed value retains its date; any estimate is separately labeled.
13. Import the same statement twice: no duplicate economic events or funding links.
14. Hide a personal holding: its value and identity disappear from unauthorized totals, exports, and APIs.
15. Missing valuation, unknown basis, or incomplete household access: disclose coverage and suppress unsupported results.
16. Correct a backdated event: affected derived reports update, original observations remain auditable.
17. Add a zero valuation: require confirmation; distinguish it from missing data.
18. Archive a holding: historical reports and links remain intact.

## 18. Success measures
Track time to connect a transaction, percentage of investment funding reconciled, duplicate rate, valuation coverage/freshness, SIP match completion, unresolved review items, and monthly update completion. Suggested initial usability targets: link a straightforward debit in under 30 seconds and update ten holding values in under three minutes; validate these with testing rather than treating them as established performance.

