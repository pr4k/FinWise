# Account statements for reconciliation

FinWise accepts the supplied August 2026 bank XLSX layout as a **bank statement** source. It finds the table headed `Date | Value Date | Particulars | Tran Type | Cheque Details | Withdrawals | Deposits | Balance | Dr/Cr`, skips the cover, opening balance, totals and footer rows, and reads the 27 dated movements. Withdrawals become negative account movements; deposits become positive. It verifies each adjacent running balance and flags a discontinuity for review. The opening-balance row is not imported as a transaction. Source bytes remain attached to the import, while committed rows become bank observations for reconciliation, never new ledger transactions.

To upload, open **Imports**, choose **Bank statement CSV / XLSX**, and select the file. In the mapping step choose the FinWise account and date format (day/month/year for the supplied statement). Review the signed movements and statement balances, then commit. Open **Reconcile**, select the same account and month, and compare the statement evidence with Money Manager or manually recorded ledger entries. Accept matches only after checking the rows.

For a simple CSV you can prepare yourself, use **Imports → Download sample bank statement CSV** in the frontend, or use UTF-8 with a header like:

```csv
Date,Description,Debit,Credit,Currency,Reference,Balance
2026-08-01,Example payment,25.00,,INR,REF-1,975.00
2026-08-02,Example deposit,,100.00,INR,REF-2,1075.00
```

Use one row per statement movement and one account per file. `Date` accepts ISO `YYYY-MM-DD`, or choose the file's day/month/year or month/day/year format in mapping. Fill **exactly one** of `Debit` and `Credit` per row. `Reference` and `Balance` are optional for CSV; `Currency` may be omitted if the selected account supplies it during mapping. FinWise keeps the original file and reports source coverage as unknown unless explicitly confirmed.

Analytics compares the selected month with another chosen month using the same scope and currency. Income and spending flow charts use recorded category allocations. They show proportions but do not imply that a particular income source funded a particular expense.

To add a household member, open **Settings → Add a member**, enter the intended email, choose Member or Admin, and create an invitation link. Share the one-day link directly with that person; FinWise does not send email. They can create an account or sign in with an existing one and accept the invite. Private account access remains separate from household membership.

To correct a manually entered balance, open **Accounts**, choose **Ledger** for the account, and use **Edit** or **Remove** in **Manual balance checks**. A removed check remains visible in history but stops affecting balance projections. Account owners can use **Set start** or **Edit start** to record a known balance on any date. Transactions before that date remain visible, and an earlier balance check can anchor their displayed balances. Starting balances and checks appear by date among transactions and in the account ledger. Checks after the starting balance become the latest observed anchor; their variance is still calculated from the starting balance and transactions. **Reconcile → Balance differences** shows the entered amount, current computed amount, and signed difference for checks in the selected month. A nonzero difference or unknown computed balance needs review; changing a check does not create or alter a transaction.

Credit cards are listed separately from bank and cash accounts. Their balance is the total amount owed, calculated from a known starting balance and transactions. Converting an account to a card does not require a payment due amount. A statement payment due date and, optionally, its billed amount can be saved later in **Edit account**. Card payments are transfers from a bank account to the card, so they do not count as spending twice. Account owners can change an existing account type in **Edit account**. **Money Manager changes** gathers manual entries, statement-created entries and amendments. Mark an item updated after recording it in Money Manager; it leaves the pending list and remains in completed history.

Date-only transactions are placed at 10:00 AM in the account timezone. An explicit transaction timestamp overrides that assumption. On **Transactions**, use **Add balance check** to select an account and time, or **Check after** beside a transaction account to prefill one minute after its effective time.
