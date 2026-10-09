CREATE TABLE recurring_labels (
 household_id TEXT NOT NULL REFERENCES households(id),
 key TEXT NOT NULL,
 subscription INTEGER NOT NULL CHECK(subscription IN (0,1)),
 updated_by TEXT NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(household_id,key)
);
