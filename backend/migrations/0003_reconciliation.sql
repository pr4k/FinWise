-- Committed observations are immutable snapshots, independent of later import mappings.
CREATE TABLE bank_observations (
 id TEXT PRIMARY KEY REFERENCES import_occurrences(id),
 household_id TEXT NOT NULL REFERENCES households(id),
 account_id TEXT NOT NULL REFERENCES resources(id),
 effective_date TEXT NOT NULL, currency TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
 document TEXT NOT NULL CHECK(json_valid(document))
);
CREATE INDEX bank_observations_period ON bank_observations(household_id,account_id,effective_date,id);
CREATE UNIQUE INDEX reconciliation_session_period ON resources(household_id,json_extract(document,'$.account_id'),json_extract(document,'$.month')) WHERE kind='reconciliation_sessions';
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
CREATE INDEX reconciliation_ledger ON reconciliation_links(transaction_id,account_id,active);
CREATE INDEX reconciliation_observation ON reconciliation_links(observation_id,active);
