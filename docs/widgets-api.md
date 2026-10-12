# FinWise Widgets v1: spending

`GET /api/v1/widgets/spending` is a read-only JSON endpoint for devices on your trusted LAN or private VPN. It needs **no API token, session cookie, or Authorization header**. Anyone who can reach it while enabled can read the configured member's spending. Do not expose it through a public reverse proxy, tunnel, or internet port forward.

## Enable on the NAS

Deploy this version and sign in to that FinWise installation as the household owner. In **Settings → Widget analytics API**, choose the member whose visible ledger should feed the widget, check **Enable unauthenticated widget analytics**, and save. The setting is disabled by default and takes effect without a restart. To expose Family spending as well, check **Allow Family and Combined spending scopes** and save. Uncheck the main enable switch and save to return 404 from the public endpoint. Only one household per server can enable widgets; an anonymous request cannot choose a household or user.

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

## Calculation rules

- Time windows use the household timezone. Today starts at local midnight, this week starts Monday at local midnight and ends Sunday, and this month starts on the first and ends on its last calendar day. Spending includes entries through the current instant only. `generated_at` uses the household offset.
- Amounts use exact decimal strings in the household base currency. FinWise has no exchange-rate conversion; transactions in other currencies are excluded, as in its existing currency-filtered analytics.
- The default Personal scope includes the configured member's Personal allocations. When the owner enables Family scopes, `scope=family` includes Family allocations and `scope=combined` includes the member's Personal plus Family allocations once. Other members' private allocations are excluded. Family and Combined requests return 403 while the Family scope switch is off. The account filter applies to today, week, month, daily spending, categories, and counts.
- `daily_spending` contains the last seven household calendar dates, including today, sorted oldest to newest. Days without eligible spending are returned as `"0.00"`. Each amount uses the same expense, refund, scope, account, currency, and time filters as the summary.
- Expense allocations add spending; eligible refunds subtract it. `transaction_count` counts expense transactions with at least one included allocation, excluding refunds. One transaction counts once even with several allocations.
- Transfers, income, voided transactions, balance checks, and card settlements recorded as transfers are excluded. Allocations under a category named `Credit card settlement` or `Card settlement` are also excluded. Date-only transactions use FinWise's existing 10:00 AM assumed time in the household timezone.
- Categories use net monthly amounts, sorted by amount descending. `other_amount` is the net remainder after the displayed categories. Percentages are rounded to two decimal places; money calculations never use floating-point arithmetic.
