# Database schema export

Schema-only snapshot from all 14 committed migrations. The runnable DDL is in [db-schema.sql](db-schema.sql). This export has no personal records, credentials, or upload contents.

**Physical objects:** 27 tables and 21 explicit indexes (SQLite also creates indexes for some primary keys and unique constraints).

## Tables and columns

### `account_access`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `account_id` | `TEXT` | Yes | PK |
| `member_id` | `TEXT` | Yes | PK 2 |

Foreign keys: `member_id` → `memberships.id`; `account_id` → `resources.id`.

### `account_aliases`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `profile_id` | `TEXT` | Yes |  |
| `source_label` | `TEXT` | Yes |  |
| `account_id` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |

Foreign keys: `account_id` → `resources.id`; `profile_id` → `source_profiles.id`.

### `audit_events`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `INTEGER` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `actor_id` | `TEXT` | Yes |  |
| `resource_id` | `TEXT` | Yes |  |
| `action` | `TEXT` | Yes |  |
| `before_json` | `TEXT` | No |  |
| `after_json` | `TEXT` | No |  |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `actor_id` → `users.id`; `household_id` → `households.id`.

### `bank_observations`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `account_id` | `TEXT` | Yes |  |
| `effective_date` | `TEXT` | Yes |  |
| `currency` | `TEXT` | Yes |  |
| `amount_minor` | `INTEGER` | Yes |  |
| `document` | `TEXT` | Yes |  |

Foreign keys: `account_id` → `resources.id`; `household_id` → `households.id`; `id` → `import_occurrences.id`.

### `category_mappings`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `profile_id` | `TEXT` | Yes |  |
| `source_label` | `TEXT` | Yes |  |
| `subcategory` | `TEXT` | Yes | default `''` |
| `event_kind` | `TEXT` | Yes |  |
| `category_id` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |

Foreign keys: `category_id` → `resources.id`; `profile_id` → `source_profiles.id`.

### `households`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `document` | `TEXT` | Yes |  |

### `idempotency`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `principal` | `TEXT` | Yes | PK |
| `key` | `TEXT` | Yes | PK 2 |
| `fingerprint` | `TEXT` | Yes |  |
| `status` | `INTEGER` | Yes |  |
| `response` | `TEXT` | Yes |  |

### `import_batches`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `owner_id` | `TEXT` | Yes |  |
| `state` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `owner_id` → `users.id`; `household_id` → `households.id`.

### `import_jobs`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `owner_id` | `TEXT` | Yes |  |
| `batch_id` | `TEXT` | Yes |  |
| `file_id` | `TEXT` | Yes |  |
| `state` | `TEXT` | Yes |  |
| `error_code` | `TEXT` | No |  |
| `progress` | `INTEGER` | Yes | default `0` |
| `revision` | `INTEGER` | Yes | default `1` |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `file_id` → `source_files.id`; `batch_id` → `import_batches.id`; `owner_id` → `users.id`; `household_id` → `households.id`.

### `import_occurrences`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `account_id` | `TEXT` | Yes |  |
| `fingerprint` | `TEXT` | Yes |  |
| `occurrence` | `INTEGER` | Yes |  |
| `transaction_id` | `TEXT` | No |  |
| `source_refs_json` | `TEXT` | Yes |  |

Foreign keys: `household_id` → `households.id`.

### `import_rows`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `file_id` | `TEXT` | Yes | PK |
| `row_number` | `INTEGER` | Yes | PK 2 |
| `raw_json` | `TEXT` | Yes |  |
| `normalized_json` | `TEXT` | Yes |  |
| `fingerprint` | `TEXT` | No |  |
| `occurrence` | `INTEGER` | No |  |

Foreign keys: `file_id` → `source_files.id`.

### `invites`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `token_hash` | `TEXT` | Yes | PK |
| `id` | `TEXT` | Yes |  |
| `household_id` | `TEXT` | Yes |  |
| `email` | `TEXT` | Yes |  |
| `role` | `TEXT` | Yes |  |
| `expires_at` | `INTEGER` | Yes |  |
| `used` | `INTEGER` | Yes | default `0` |

Foreign keys: `household_id` → `households.id`.

### `login_attempts`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `identity` | `TEXT` | Yes | PK |
| `attempts` | `INTEGER` | Yes |  |
| `window_start` | `INTEGER` | Yes |  |

### `memberships`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `user_id` | `TEXT` | Yes |  |
| `role` | `TEXT` | Yes |  |
| `active` | `INTEGER` | Yes | default `1` |
| `revision` | `INTEGER` | Yes | default `1` |

Foreign keys: `user_id` → `users.id`; `household_id` → `households.id`.

### `planned_item_matches`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK |
| `planned_item_id` | `TEXT` | Yes | PK 2 |
| `transaction_id` | `TEXT` | Yes |  |
| `actor_id` | `TEXT` | Yes |  |
| `reason` | `TEXT` | Yes |  |
| `matched_at` | `TEXT` | Yes |  |

Foreign keys: `actor_id` → `users.id`; `transaction_id` → `resources.id`; `planned_item_id` → `resources.id`; `household_id` → `households.id`.

### `quick_expense_settings`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK |
| `enabled` | `INTEGER` | Yes | default `0` |
| `user_id` | `TEXT` | No |  |
| `default_account_id` | `TEXT` | No |  |
| `account_ids` | `TEXT` | Yes | default `'[]'` |
| `revision` | `INTEGER` | Yes | default `1` |

Foreign keys: `user_id` → `users.id`; `household_id` → `households.id`.

### `reconciliation_links`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `match_id` | `TEXT` | Yes | PK |
| `session_id` | `TEXT` | Yes |  |
| `transaction_id` | `TEXT` | Yes | PK 2 |
| `account_id` | `TEXT` | Yes |  |
| `observation_id` | `TEXT` | Yes | PK 3 |
| `amount_minor` | `INTEGER` | Yes |  |
| `active` | `INTEGER` | Yes | default `1` |

Foreign keys: `observation_id` → `bank_observations.id`; `account_id` → `resources.id`; `transaction_id` → `resources.id`; `session_id` → `resources.id`; `match_id` → `resources.id`.

### `recurring_labels`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK |
| `key` | `TEXT` | Yes | PK 2 |
| `subscription` | `INTEGER` | Yes |  |
| `updated_by` | `TEXT` | Yes |  |
| `updated_at` | `TEXT` | Yes |  |
| `ignored` | `INTEGER` | Yes | default `0` |

Foreign keys: `updated_by` → `users.id`; `household_id` → `households.id`.

### `resources`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `owner_id` | `TEXT` | Yes |  |
| `kind` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |
| `document` | `TEXT` | Yes |  |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `owner_id` → `users.id`; `household_id` → `households.id`.

### `sessions`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `token_hash` | `TEXT` | Yes | PK |
| `user_id` | `TEXT` | Yes |  |
| `household_id` | `TEXT` | Yes |  |
| `csrf` | `TEXT` | Yes |  |
| `expires_at` | `INTEGER` | Yes |  |

Foreign keys: `household_id` → `households.id`; `user_id` → `users.id`.

### `source_files`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `batch_id` | `TEXT` | Yes |  |
| `household_id` | `TEXT` | Yes |  |
| `owner_id` | `TEXT` | Yes |  |
| `account_id` | `TEXT` | No |  |
| `profile_id` | `TEXT` | No |  |
| `source_kind` | `TEXT` | Yes |  |
| `filename` | `TEXT` | Yes |  |
| `media_type` | `TEXT` | Yes |  |
| `sha256` | `TEXT` | Yes |  |
| `bytes` | `BLOB` | Yes |  |
| `byte_count` | `INTEGER` | Yes |  |
| `state` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |
| `mapping_json` | `TEXT` | Yes |  |
| `warnings_json` | `TEXT` | Yes | default `'[]'` |
| `error_code` | `TEXT` | No |  |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `owner_id` → `users.id`; `household_id` → `households.id`; `batch_id` → `import_batches.id`.

### `source_profiles`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `household_id` | `TEXT` | Yes |  |
| `owner_id` | `TEXT` | Yes |  |
| `source_kind` | `TEXT` | Yes |  |
| `name` | `TEXT` | Yes |  |
| `revision` | `INTEGER` | Yes | default `1` |

Foreign keys: `owner_id` → `users.id`; `household_id` → `households.id`.

### `transfer_review_decisions`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `item_id` | `TEXT` | Yes | PK |
| `decision` | `TEXT` | Yes |  |
| `reason` | `TEXT` | No |  |
| `actor_id` | `TEXT` | Yes |  |
| `created_at` | `TEXT` | Yes |  |

Foreign keys: `actor_id` → `users.id`.

### `users`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `id` | `TEXT` | Yes | PK |
| `email` | `TEXT` | Yes |  |
| `name` | `TEXT` | Yes |  |
| `password_hash` | `TEXT` | Yes |  |

### `widget_settings`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK |
| `enabled` | `INTEGER` | Yes | default `0` |
| `user_id` | `TEXT` | No |  |
| `revision` | `INTEGER` | Yes | default `1` |
| `family_enabled` | `INTEGER` | Yes | default `0` |
| `accounts_enabled` | `INTEGER` | Yes | default `0` |

Foreign keys: `user_id` → `users.id`; `household_id` → `households.id`.

## Storage conventions

- `resources` is the household-scoped JSON document store for accounts, categories, transactions, budgets, planned items, reconciliation resources, balance checks, settlement obligations, and investments. `kind` selects a document type; `revision` supports optimistic updates. Most nested properties are validated in Rust rather than by separate SQL columns.
- `households.document` stores household settings. `source_files.bytes` stores original uploaded file bytes in SQLite; import rows and normalized observations remain distinct from canonical transaction resources.
- `audit_events` records before/after JSON and actor; `idempotency` retains prior mutation responses.
- The SQL foreign keys shown above are physical constraints. Some IDs inside JSON documents, and some plain-text IDs in import tables, require application-level validation.
- Migration tracking lives in SQLx’s `_sqlx_migrations` table on an application-created database and is intentionally absent from this logical schema-only snapshot.
- For an existing installation, back up the SQLite database with the SQLite backup API or `VACUUM INTO`; do not apply this DDL to it.

## Indexes

| Index | On |
| --- | --- |
| `audit_resource` | `audit_events` |
| `bank_observations_period` | `bank_observations` |
| `import_batches_owner` | `import_batches` |
| `import_jobs_recover` | `import_jobs` |
| `import_occurrences_lookup` | `import_occurrences` |
| `import_occurrences_transaction` | `import_occurrences` |
| `import_rows_item_id` | `import_rows` |
| `planned_item_matches_transaction` | `planned_item_matches` |
| `quick_expense_one_enabled` | `quick_expense_settings` |
| `reconciliation_account_active` | `reconciliation_links` |
| `reconciliation_ledger` | `reconciliation_links` |
| `reconciliation_observation` | `reconciliation_links` |
| `reconciliation_session_period` | `resources` |
| `resources_scope` | `resources` |
| `resources_transactions_date` | `resources` |
| `resources_transactions_period` | `resources` |
| `sessions_expiry` | `sessions` |
| `source_files_account_hash` | `source_files` |
| `source_files_batch` | `source_files` |
| `widgets_one_enabled` | `widget_settings` |

## Explicit subscription linking (migration 0014)

### `recurring_subscriptions`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK; FK → households.id |
| `key` | `TEXT` | Yes | PK 2 |
| `account_id` | `TEXT` | Yes | FK → resources.id |
| `currency` | `TEXT` | Yes | |
| `name` | `TEXT` | Yes | |

Named subscriptions retain their identity when transaction descriptions change. Existing detected patterns can acquire an explicit definition under their existing key. A subscription belongs to one account and currency; its payments follow that account's visibility.

### `recurring_payment_links`

| Column | SQLite type | Required | Key/default |
| --- | --- | --- | --- |
| `household_id` | `TEXT` | Yes | PK |
| `transaction_id` | `TEXT` | Yes | PK 2; FK → resources.id, ON DELETE CASCADE |
| `key` | `TEXT` | Yes | |

Composite FK `(household_id,key)` → recurring_subscriptions. One explicit subscription per transaction. Index `recurring_payment_links_subscription` covers `(household_id,key)`. Links group existing expense payments; they never post additional ledger activity. Voided or inaccessible transactions are excluded from the recurring projection.
