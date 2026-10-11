# Quick expenses from Apple Shortcuts

FinWise can accept an expense from an iPhone shortcut without a FinWise login cookie, CSRF token, or API token. This is an **opt-in** route and is disabled by default. Anyone who can reach the enabled route can create expenses as the configured user. Keep `/api/v1/quick-transactions` and `/api/v1/quick-transactions/options` accessible **only on a trusted LAN or private VPN**. Do not expose either through a public reverse proxy, public tunnel, or internet port forward. A webhook is not needed: Shortcuts sends an HTTP request directly to FinWise.

## Configure on the NAS

Deploy this version to TrueNAS and sign in to that FinWise installation as the household **owner**. Open **Settings → Apple Shortcuts quick expense**. Choose the household member whose permissions will apply, select the allowed accounts, select one of them as the default, then check **Enable unauthenticated quick expenses** and save. The choices come from the NAS database, so you do not need to copy IDs from another installation or edit `.env`. The feature is disabled by default. Changes take effect immediately; no container restart is needed. Uncheck the enable switch and save to disable both public routes (they then return 404).

Only the owner can read or change this setting. Saving requires the usual signed-in session, CSRF protection, and current revision. The configured member must remain active, and allowed accounts must be active and accessible to both that member and the owner. A removed or inactive configured member or default account makes the quick routes return a structured error until corrected in Settings. The request cannot select a user or household: `user_id` and `household_id` in a quick expense body are rejected. Only one household per FinWise server can enable this unauthenticated entry point.

Keep the NAS port accessible only from a trusted LAN or private VPN. Do not expose these routes through a public reverse proxy, tunnel, or internet port forward. Anyone who can reach the enabled API can add expenses as the chosen member.

The account determines currency. The existing currency precision rules apply, so send money as a **JSON string**, such as `"12.34"`, never a JSON number. The expense receives Family scope for a shared account or when Family only mode is enabled; otherwise it receives Personal scope. Private categories are offered only when the selected account is the configured user's private account without member access grants. The normal transaction validation remains authoritative.

## API

These routes are under the existing `/api/v1` prefix. They need no Authorization header and no cookies. Responses use `Cache-Control: no-store`.

`GET /api/v1/quick-transactions/options` returns the configured user's eligible allowlisted accounts and active expense categories suitable for the default account. Pass `?account_id=ACCOUNT_ID` to see categories suitable for another allowlisted account. It returns no income or inaccessible categories.

```json
{
  "default_account_id": "ACCOUNT_ID",
  "selected_account_id": "ACCOUNT_ID",
  "accounts": [{"id": "ACCOUNT_ID", "name": "Cash", "currency": "INR"}],
  "categories": [{"id": "CATEGORY_ID", "name": "Groceries", "label": "Food › Groceries", "parent_id": "PARENT_ID"}]
}
```

`POST /api/v1/quick-transactions` creates one expense. `amount` and `category_id` are required. `account_id` defaults to the configured default account. `description` is optional and defaults to `Quick expense`. `occurred_at` is optional and must be an RFC 3339 timestamp with an offset, such as `2026-10-11T13:20:00+05:30`. If omitted, FinWise uses the current time. The effective date is derived in the household timezone.

```json
{
  "amount": "125.50",
  "category_id": "CATEGORY_ID",
  "account_id": "ACCOUNT_ID",
  "description": "Lunch",
  "occurred_at": "2026-10-11T13:20:00+05:30"
}
```

On creation, HTTP 201 returns:

```json
{
  "id": "TRANSACTION_ID",
  "message": "Expense recorded.",
  "amount": "125.50",
  "currency": "INR",
  "account_id": "ACCOUNT_ID",
  "category_id": "CATEGORY_ID",
  "effective_date": "2026-10-11"
}
```

The `Idempotency-Key` header is required on POST (maximum 128 characters). Generate one UUID for a submission and reuse that UUID and the **same JSON body** if a network failure makes the result uncertain. Reusing the key and payload returns the original HTTP 201 result without another expense. Reusing the key with a changed payload returns HTTP 409 and `idempotency_key_reused`. A new expense needs a new UUID. FinWise records the result and transaction in one database transaction, including concurrent retries.

Errors are JSON with an `error.code`, `error.message`, and `request_id`. Invalid fields or money return 400, a disallowed account returns 403, inaccessible records return 404, an idempotency conflict returns 409, and stale server configuration returns 503. For example:

```json
{"error":{"code":"validation_error","message":"Transaction amount must be positive.","fields":[]},"request_id":"..."}
```

From a Mac or a device on the same trusted network, replace the placeholders and test:

```sh
finwise_url='http://NAS_LAN_IP:3000'
curl --fail-with-body "$finwise_url/api/v1/quick-transactions/options"
curl --fail-with-body -X POST "$finwise_url/api/v1/quick-transactions" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  --data '{"amount":"125.50","category_id":"CATEGORY_ID","description":"Lunch"}'
```

For a phone on the same Wi-Fi, use `http://NAS_LAN_IP:3000`. Away from home, connect the phone to your private VPN first and use the NAS's private VPN address (or the LAN address through a VPN subnet route). Keep the same API path. Do not switch the shortcut to a public tunnel URL.

## Build the iPhone shortcut

1. Add **Ask for Input** for the amount. Use the numeric keyboard, then convert the answer to **Text** so the JSON `amount` value is a decimal string. Use a dot as the decimal separator expected by the API.
2. Add **URL** for `http://NAS_LAN_IP:3000/api/v1/quick-transactions/options`, then **Get Contents of URL** with `GET`. Get the `categories` array from the response. The response includes each category's `label` and stable `id`.
3. Build a Shortcuts **Dictionary** whose keys are category labels and values are their IDs (repeat over the returned categories and set each dictionary value). Pass that dictionary to **Choose from List** with Select Multiple off. The displayed label is the category choice; the chosen dictionary value is the `category_id`. For another account, first choose from `accounts`, then call options with its `account_id`.
4. Add **Ask for Input** for an optional description. Keep an empty answer or send it as text; FinWise uses `Quick expense` for an empty description.
5. Generate one UUID with a UUID-generating Shortcuts action, such as **Generate UUID** from the Actions app if that action is installed. Store it as `Submission ID`. Generate it once before the POST and reuse it for retries of this same submission.
6. Add **Get Contents of URL** for `/api/v1/quick-transactions`. Set Method to `POST`, Request Body to JSON, and fields `amount` (Text), `category_id` (Text), and `description` (Text). Add `account_id` only if the shortcut offers account choice. In Headers, set `Idempotency-Key` to `Submission ID`; set `Content-Type` to `application/json` if Shortcuts does not add it automatically. Do not add an Authorization header.
7. Get `id` and `message` from the response. Show a confirmation only when `id` is present; otherwise show the returned error and stop. If the request times out or the phone loses connectivity, retry with the same `Submission ID` and unchanged body.

Apple's [Shortcuts API guide](https://support.apple.com/en-mt/guide/shortcuts/apd58d46713f/ios) documents `Get Contents of URL` with POST and JSON, and its [dictionary guide](https://support.apple.com/en-in/guide/shortcuts/apd43b69f337/9.0/ios/26) explains choosing dictionary keys while passing their values to the next action.
