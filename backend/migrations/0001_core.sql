CREATE TABLE households (
 id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))
);
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE memberships (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
 active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(household_id,user_id)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 household_id TEXT NOT NULL REFERENCES households(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE resources (
 id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
 owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, document TEXT NOT NULL CHECK(json_valid(document)),
 created_at TEXT NOT NULL
);
CREATE INDEX resources_scope ON resources(household_id,kind,id);
CREATE TABLE account_access (
 account_id TEXT NOT NULL REFERENCES resources(id), member_id TEXT NOT NULL REFERENCES memberships(id),
 PRIMARY KEY(account_id,member_id)
);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, household_id TEXT NOT NULL REFERENCES households(id),
 actor_id TEXT NOT NULL REFERENCES users(id), resource_id TEXT NOT NULL, action TEXT NOT NULL,
 before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX audit_resource ON audit_events(household_id,resource_id,id);
CREATE TABLE idempotency (
 principal TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(principal,key)
);
CREATE TABLE login_attempts (
 identity TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
);
CREATE TABLE invites (
 token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, household_id TEXT NOT NULL REFERENCES households(id),
 email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('admin','member')),
 expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
