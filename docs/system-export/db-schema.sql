-- FinWise schema-only export. Generated from backend/migrations/0001_core.sql through 0014_subscription_links.sql.
-- Empty SQLite database; no user data. Do not apply this file on an existing database.
-- Runtime migrations remain authoritative. JSON resource shapes are defined in API/domain code.

PRAGMA foreign_keys=ON;

CREATE TABLE account_access (
 account_id TEXT NOT NULL REFERENCES resources(id), member_id TEXT NOT NULL REFERENCES memberships(id),
 PRIMARY KEY(account_id,member_id)
);

CREATE TABLE account_aliases (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES source_profiles(id),
 source_label TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES resources(id),
 revision INTEGER NOT NULL DEFAULT 1, UNIQUE(profile_id,source_label)
);

CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, household_id TEXT NOT NULL REFERENCES households(id),
 actor_id TEXT NOT NULL REFERENCES users(id), resource_id TEXT NOT NULL, action TEXT NOT NULL,
 before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
);

CREATE TABLE bank_observations (
 id TEXT PRIMARY KEY REFERENCES import_occurrences(id),
 household_id TEXT NOT NULL REFERENCES households(id),
 account_id TEXT NOT NULL REFERENCES resources(id),
 effective_date TEXT NOT NULL, currency TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
 document TEXT NOT NULL CHECK(json_valid(document))
);

CREATE TABLE category_mappings (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES source_profiles(id),
 source_label TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '',
 event_kind TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES resources(id),
 revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(profile_id,source_label,subcategory,event_kind)
);

CREATE TABLE households (
 id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))
);

CREATE TABLE idempotency (
 principal TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(principal,key)
);

CREATE TABLE import_batches (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE import_jobs (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), batch_id TEXT NOT NULL REFERENCES import_batches(id),
 file_id TEXT NOT NULL REFERENCES source_files(id), state TEXT NOT NULL,
 error_code TEXT, progress INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);

CREATE TABLE import_occurrences (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 account_id TEXT NOT NULL, fingerprint TEXT NOT NULL, occurrence INTEGER NOT NULL,
 transaction_id TEXT, source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
 UNIQUE(household_id,account_id,fingerprint,occurrence)
);

CREATE TABLE import_rows (
 file_id TEXT NOT NULL REFERENCES source_files(id), row_number INTEGER NOT NULL,
 raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
 fingerprint TEXT, occurrence INTEGER,
 PRIMARY KEY(file_id,row_number)
);

CREATE TABLE invites (
 token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, household_id TEXT NOT NULL REFERENCES households(id),
 email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('admin','member')),
 expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE login_attempts (
 identity TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
);

CREATE TABLE memberships (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
 active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(household_id,user_id)
);

CREATE TABLE planned_item_matches (
 household_id TEXT NOT NULL REFERENCES households(id),
 planned_item_id TEXT NOT NULL REFERENCES resources(id),
 transaction_id TEXT NOT NULL REFERENCES resources(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL,
 matched_at TEXT NOT NULL,
 PRIMARY KEY (household_id, planned_item_id),
 UNIQUE (household_id, transaction_id)
);

CREATE TABLE quick_expense_settings (
 household_id TEXT PRIMARY KEY REFERENCES households(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 user_id TEXT REFERENCES users(id),
 default_account_id TEXT,
 account_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(account_ids)),
 revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reconciliation_links (
 match_id TEXT NOT NULL REFERENCES resources(id),
 session_id TEXT NOT NULL REFERENCES resources(id),
 transaction_id TEXT NOT NULL REFERENCES resources(id),
 account_id TEXT NOT NULL REFERENCES resources(id),
 observation_id TEXT NOT NULL REFERENCES bank_observations(id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 PRIMARY KEY(match_id,transaction_id,observation_id)
);

CREATE TABLE recurring_labels (
 household_id TEXT NOT NULL REFERENCES households(id),
 key TEXT NOT NULL,
 subscription INTEGER NOT NULL CHECK(subscription IN (0,1)),
 updated_by TEXT NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL, ignored INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0,1)),
 PRIMARY KEY(household_id,key)
);

CREATE TABLE resources (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, document TEXT NOT NULL CHECK(json_valid(document)),
 created_at TEXT NOT NULL
);

CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 household_id TEXT NOT NULL REFERENCES households(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE source_files (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
 household_id TEXT NOT NULL REFERENCES households(id), owner_id TEXT NOT NULL REFERENCES users(id),
 account_id TEXT, profile_id TEXT, source_kind TEXT NOT NULL,
 filename TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL,
 bytes BLOB NOT NULL, byte_count INTEGER NOT NULL, state TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
 warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
 error_code TEXT, created_at TEXT NOT NULL
);

CREATE TABLE source_profiles (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), source_kind TEXT NOT NULL,
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(household_id,owner_id,source_kind)
);

CREATE TABLE transfer_review_decisions (
 item_id TEXT PRIMARY KEY, decision TEXT NOT NULL, reason TEXT,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, password_hash TEXT NOT NULL
);

CREATE TABLE widget_settings (
 household_id TEXT PRIMARY KEY REFERENCES households(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 user_id TEXT REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1
, family_enabled INTEGER NOT NULL DEFAULT 0 CHECK(family_enabled IN (0,1)), accounts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accounts_enabled IN (0,1)));

CREATE INDEX audit_resource ON audit_events(household_id,resource_id,id);

CREATE INDEX bank_observations_period ON bank_observations(household_id,account_id,effective_date,id);

CREATE INDEX import_batches_owner ON import_batches(household_id,owner_id,created_at,id);

CREATE INDEX import_jobs_recover ON import_jobs(state,created_at);

CREATE INDEX import_occurrences_lookup ON import_occurrences(household_id,account_id,fingerprint);

CREATE UNIQUE INDEX import_rows_item_id ON import_rows(json_extract(normalized_json,'$.item_id'));

CREATE INDEX planned_item_matches_transaction ON planned_item_matches(household_id, transaction_id);

CREATE UNIQUE INDEX quick_expense_one_enabled ON quick_expense_settings(enabled) WHERE enabled=1;

CREATE INDEX reconciliation_account_active
ON reconciliation_links(account_id, active, transaction_id);

CREATE INDEX reconciliation_ledger ON reconciliation_links(transaction_id,account_id,active);

CREATE INDEX reconciliation_observation ON reconciliation_links(observation_id,active);

CREATE UNIQUE INDEX reconciliation_session_period ON resources(household_id,json_extract(document,'$.account_id'),json_extract(document,'$.month')) WHERE kind='reconciliation_sessions';

CREATE INDEX resources_scope ON resources(household_id,kind,id);

CREATE INDEX resources_transactions_date
ON resources(household_id, json_extract(document,'$.effective_date'), id)
WHERE kind='transactions';

CREATE INDEX resources_transactions_period
ON resources(household_id, json_extract(document,'$.effective_date'))
WHERE kind='transactions';

CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE INDEX source_files_account_hash ON source_files(household_id,account_id,sha256);

CREATE INDEX source_files_batch ON source_files(batch_id,id);

CREATE UNIQUE INDEX widgets_one_enabled ON widget_settings(enabled) WHERE enabled=1;

-- Transaction reads and source cleanup look up occurrences by ledger ID.
-- The existing fingerprint index cannot serve this lookup beyond household_id.
CREATE INDEX import_occurrences_transaction
ON import_occurrences(household_id, transaction_id);

-- Explicit subscriptions retain their identity when payment descriptions change.
CREATE TABLE recurring_subscriptions (
 household_id TEXT NOT NULL REFERENCES households(id),
 key TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES resources(id),
 currency TEXT NOT NULL,
 name TEXT NOT NULL,
 PRIMARY KEY(household_id,key)
);
CREATE TABLE recurring_payment_links (
 household_id TEXT NOT NULL,
 transaction_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 key TEXT NOT NULL,
 PRIMARY KEY(household_id,transaction_id),
 FOREIGN KEY(household_id,key) REFERENCES recurring_subscriptions(household_id,key)
);
CREATE INDEX recurring_payment_links_subscription ON recurring_payment_links(household_id,key);
