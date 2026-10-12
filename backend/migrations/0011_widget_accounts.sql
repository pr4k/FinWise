ALTER TABLE widget_settings ADD COLUMN accounts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accounts_enabled IN (0,1));
