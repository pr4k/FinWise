-- Transaction reads and source cleanup look up occurrences by ledger ID.
-- The existing fingerprint index cannot serve this lookup beyond household_id.
CREATE INDEX import_occurrences_transaction
ON import_occurrences(household_id, transaction_id);
