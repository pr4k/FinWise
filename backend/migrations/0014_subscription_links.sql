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
