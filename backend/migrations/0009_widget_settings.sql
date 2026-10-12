CREATE TABLE widget_settings (
 household_id TEXT PRIMARY KEY REFERENCES households(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 user_id TEXT REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1
);
-- An anonymous request has no household selector.
CREATE UNIQUE INDEX widgets_one_enabled ON widget_settings(enabled) WHERE enabled=1;
