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
CREATE INDEX planned_item_matches_transaction ON planned_item_matches(household_id, transaction_id);
