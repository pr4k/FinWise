CREATE TABLE import_batches (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX import_batches_owner ON import_batches(household_id,owner_id,created_at,id);
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
CREATE INDEX source_files_batch ON source_files(batch_id,id);
CREATE INDEX source_files_account_hash ON source_files(household_id,account_id,sha256);
CREATE TABLE import_rows (
 file_id TEXT NOT NULL REFERENCES source_files(id), row_number INTEGER NOT NULL,
 raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
 fingerprint TEXT, occurrence INTEGER,
 PRIMARY KEY(file_id,row_number)
);
CREATE TABLE import_occurrences (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 account_id TEXT NOT NULL, fingerprint TEXT NOT NULL, occurrence INTEGER NOT NULL,
 transaction_id TEXT, source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
 UNIQUE(household_id,account_id,fingerprint,occurrence)
);
CREATE INDEX import_occurrences_lookup ON import_occurrences(household_id,account_id,fingerprint);
CREATE TABLE import_jobs (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), batch_id TEXT NOT NULL REFERENCES import_batches(id),
 file_id TEXT NOT NULL REFERENCES source_files(id), state TEXT NOT NULL,
 error_code TEXT, progress INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE INDEX import_jobs_recover ON import_jobs(state,created_at);
CREATE TABLE source_profiles (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), source_kind TEXT NOT NULL,
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(household_id,owner_id,source_kind)
);
CREATE TABLE category_mappings (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES source_profiles(id),
 source_label TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '',
 event_kind TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES resources(id),
 revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(profile_id,source_label,subcategory,event_kind)
);
CREATE TABLE account_aliases (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES source_profiles(id),
 source_label TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES resources(id),
 revision INTEGER NOT NULL DEFAULT 1, UNIQUE(profile_id,source_label)
);
CREATE UNIQUE INDEX import_rows_item_id ON import_rows(json_extract(normalized_json,'$.item_id'));
CREATE TABLE transfer_review_decisions (
 item_id TEXT PRIMARY KEY, decision TEXT NOT NULL, reason TEXT,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
