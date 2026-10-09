-- Reports filter by household and effective_date inside the JSON document.
-- A partial expression index avoids scanning every resource for each report.
CREATE INDEX resources_transactions_period
ON resources(household_id, json_extract(document,'$.effective_date'))
WHERE kind='transactions';
