CREATE TABLE quick_expense_settings (
 household_id TEXT PRIMARY KEY REFERENCES households(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 user_id TEXT REFERENCES users(id),
 default_account_id TEXT,
 account_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(account_ids)),
 revision INTEGER NOT NULL DEFAULT 1
);
-- An unauthenticated request cannot select a household, so only one may be active.
CREATE UNIQUE INDEX quick_expense_one_enabled ON quick_expense_settings(enabled) WHERE enabled=1;
