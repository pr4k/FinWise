ALTER TABLE widget_settings ADD COLUMN family_enabled INTEGER NOT NULL DEFAULT 0 CHECK(family_enabled IN (0,1));
