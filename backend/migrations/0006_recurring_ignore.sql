ALTER TABLE recurring_labels ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0,1));
