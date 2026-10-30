# FinWise Widgets v1: spending and accounts

`GET /api/v1/widgets/spending` is a read-only JSON endpoint for devices on your trusted LAN or private VPN. It needs **no API token, session cookie, or Authorization header**. Anyone who can reach it while enabled can read the configured member's spending. Do not expose it through a public reverse proxy, tunnel, or internet port forward.

`GET /api/v1/widgets/accounts` uses the same selected member and an additional **Expose accessible account balances and last transaction dates** switch. It is also unauthenticated and read-only. Anyone who can reach it while enabled can read the selected member's accessible account names, types, balances, and latest transaction dates. The accounts switch starts off, including on installations where the spending widget was already enabled.

`GET /api/v1/widgets/expense-calendar` uses the spending widget's enable switch and Family scope switch. It returns one numeric net expense for every household-local date in a selected month, including marked zero placeholders for future dates.

## Enable on the NAS

Deploy this version and sign in to that FinWise installation as the household owner. In **Settings → Widget analytics API**, choose the member whose visible ledger should feed the widget, check **Enable unauthenticated widget analytics**, and save. The setting is disabled by default and takes effect without a restart. To expose Family spending as well, check **Allow Family and Combined spending scopes**. To expose accounts, check **Expose accessible account balances and last transaction dates**. Each accounts request returns 404 while its switch is off. Uncheck the main enable switch and save to return 404 from the public widget endpoints. Only one household per server can enable widgets; an anonymous request cannot choose a household or user. The **Expense calendar URL** controls let you choose Personal, Family, or Combined and either all accessible accounts or one account visible to both the owner and selected member. Copy the resulting URL for your script. These URL choices do not restrict other scopes or accounts already allowed by the widget settings.

The owner-only Settings control is authenticated as usual. The widget endpoint itself is unauthenticated. If the configured member loses household access, the endpoint returns a structured 503 until the owner chooses another member.

## Request

```sh
curl -i -H 'Accept: application/json' \
  'http://YOUR_NAS_IP:3000/api/v1/widgets/spending'
```

Optional query parameters:

| Parameter | Meaning | Default |
| --- | --- | --- |
| `account_id` | Include only expenses from one account accessible to the configured member. Unknown or inaccessible IDs return 404. | All accessible accounts |
| `category_limit` | Number of categories in `items`, from 1 to 20. The rest go in `other_amount`. | `5` |
| `include_children` | `true` groups child category amounts under their top parent; `false` lists direct categories. | `true` |
| `scope` | `personal` shows the configured member's Personal allocations. `family` shows Family allocations; `combined` adds both once. Family and Combined require the owner's Family scope switch. | `personal` |

```sh
curl -i 'http://YOUR_NAS_IP:3000/api/v1/widgets/spending?scope=family&account_id=ACCOUNT_ID&category_limit=5&include_children=true'
```

Replace the NAS IP with its private VPN address when away from home. The same path works over Wi-Fi and VPN.

## Response

HTTP 200 returns this shape (amounts shown are illustrative):

```json
{
  "success": true,
  "generated_at": "2026-10-12T08:15:00+05:30",
  "currency": "INR",
  "timezone": "Asia/Kolkata",
  "scope": "family",
  "summary": {
    "today": {"date": "2026-10-12", "spent": "1850.00", "transaction_count": 4},
    "week": {"start_date": "2026-10-12", "end_date": "2026-10-18", "spent": "1850.00", "transaction_count": 4},
    "month": {"start_date": "2026-10-01", "end_date": "2026-10-31", "spent": "42850.00", "transaction_count": 72}
  },
  "daily_spending": [
    {"date": "2026-10-06", "spent": "1200.00"},
    {"date": "2026-10-07", "spent": "3400.00"},
    {"date": "2026-10-08", "spent": "800.00"},
    {"date": "2026-10-09", "spent": "2500.00"},
    {"date": "2026-10-10", "spent": "1100.00"},
    {"date": "2026-10-11", "spent": "750.00"},
    {"date": "2026-10-12", "spent": "1850.00"}
  ],
  "categories": {
    "period": "month",
    "total_spent": "42850.00",
    "items": [
      {"id": "CATEGORY_ID", "label": "🍜 Food", "amount": "12400.00", "percentage": 28.94}
    ],
    "other_amount": "30450.00"
  }
}
```

`Cache-Control: private, max-age=300` permits a five-minute client cache for successful responses. A client may keep showing its cached response for up to five minutes after the setting is disabled. Errors use the normal FinWise `{"error":{"code":"...","message":"...","fields":[]},"request_id":"..."}` body with `Cache-Control: no-store`.

## Accounts response

```sh
curl -i -H 'Accept: application/json' \
  'http://192.168.1.194:3000/api/v1/widgets/accounts'
```

The response has `success`, `generated_at`, `currency`, and an `accounts` array. Each account has `id`, `name`, `type`, `balance`, and `last_transaction_date`. Only active accounts in the household base currency that the configured member can access are returned. Balances use the same opening balance, balance check, and ledger rules as the Accounts screen; credit card debt is negative in this response. An account without a known balance has `"balance": null`, and one without a past, nonvoided transaction has `"last_transaction_date": null`. Future transactions do not affect either field. Dates use the account timezone; `generated_at` uses the household timezone. Accounts are sorted by name, then ID. Query parameters are not supported.

## Expense calendar response

```sh
curl -i 'http://YOUR_NAS_IP:3000/api/v1/widgets/expense-calendar?scope=family&month=2026-10'
```

`month` is optional and defaults to the current household-local month. `scope` defaults to `personal`; `family` and `combined` require the owner's Family scope switch. `account_id` optionally limits spending to one account accessible to the selected widget member; omit it for all accessible accounts. Unknown or inaccessible account IDs return 404. Only these three query parameters are accepted. The response is:

```json
{
  "month": "2026-10",
  "currency": "INR",
  "timezone": "Asia/Kolkata",
  "generated_at": "2026-10-22T08:15:00+05:30",
  "today": "2026-10-22",
  "scope": "family",
  "complete": true,
  "days": [
    {"date": "2026-10-01", "expense": 0, "is_future": false},
    {"date": "2026-10-02", "expense": 1250.50, "is_future": false}
  ]
}
```

The example omits later rows. Every response contains exactly one row per date in the selected month, in chronological order, including zero-expense dates and future placeholders. October always includes October 23 and has 31 rows; February has 28 or 29 as appropriate. Future cells have `expense: 0` and `is_future: true`; render them as future/unelapsed cells, not evidence of zero spending. Future-dated ledger transactions are not included.

`today`, `timezone`, and `generated_at` describe the server's household-local cutoff; clients should use this cutoff rather than assume the device timezone matches. `complete` remains true for current/past months and false for entirely future months. It describes elapsed-date coverage, not ledger import completeness. A future month now returns a full placeholder grid instead of an empty `days` array. Expense values remain JSON numbers in the household base currency; eligible refunds can make elapsed-date values negative. Scope, account access, settlement, and currency rules are unchanged.

A widget which previously threw a missing-date error while building a complete month should use the full `days` grid. Deploy the updated backend before refreshing the widget; existing successful responses may remain cached for five minutes.

## Calculation rules

- Time windows use the household timezone. Today starts at local midnight, this week starts Monday at local midnight and ends Sunday, and this month starts on the first and ends on its last calendar day. Spending includes entries through the current instant only. `generated_at` uses the household offset.
- Amounts use exact decimal strings in the household base currency. FinWise has no exchange-rate conversion; transactions in other currencies are excluded, as in its existing currency-filtered analytics.
- The default Personal scope includes the configured member's Personal allocations. When the owner enables Family scopes, `scope=family` includes Family allocations and `scope=combined` includes the member's Personal plus Family allocations once. Other members' private allocations are excluded. Family and Combined requests return 403 while the Family scope switch is off. The account filter applies to today, week, month, daily spending, categories, and counts.
- `daily_spending` contains the last seven household calendar dates, including today, sorted oldest to newest. Days without eligible spending are returned as `"0.00"`. Each amount uses the same expense, refund, scope, account, currency, and time filters as the summary.
- Expense allocations add spending; eligible refunds subtract it. `transaction_count` counts expense transactions with at least one included allocation, excluding refunds. One transaction counts once even with several allocations.
- Transfers, income, voided transactions, balance checks, and card settlements recorded as transfers are excluded. Allocations under a category named `Credit card settlement` or `Card settlement` are also excluded. Date-only transactions use FinWise's existing 10:00 AM assumed time in the household timezone.
- Categories use net monthly amounts, sorted by amount descending. `other_amount` is the net remainder after the displayed categories. Percentages are rounded to two decimal places; money calculations never use floating-point arithmetic.
