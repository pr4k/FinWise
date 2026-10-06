-- Reconciliation reads transactions for one month before checking account movements.
CREATE INDEX resources_transactions_date
ON resources(household_id, json_extract(document,'$.effective_date'), id)
WHERE kind='transactions';

CREATE INDEX reconciliation_account_active
ON reconciliation_links(account_id, active, transaction_id);
