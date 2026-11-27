CREATE TABLE emi_terms (
 household_id TEXT NOT NULL REFERENCES households(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 category_id TEXT NOT NULL REFERENCES resources(id),
 document TEXT NOT NULL,
 PRIMARY KEY (household_id, user_id, category_id)
);
