-- Economic classification extends resource documents; imported ledger data is untouched.
-- Preserve explicit manual entries; uncertain historical imports remain pending review.
UPDATE resources SET document=json_set(document,'$.classification',json_object(
 'transaction_type',CASE json_extract(document,'$.event_type')
   WHEN 'investment_withdrawal' THEN 'investment' ELSE json_extract(document,'$.event_type') END,
 'status',CASE WHEN json_array_length(document,'$.source_refs')=0 AND json_type(document,'$.entered_by')='text' THEN 'confirmed' ELSE 'needs_review' END,
 'confidence_score',CASE WHEN json_array_length(document,'$.source_refs')=0 AND json_type(document,'$.entered_by')='text' THEN 100 ELSE 60 END,
 'classification_source',CASE WHEN json_array_length(document,'$.source_refs')=0 AND json_type(document,'$.entered_by')='text' THEN 'manual' ELSE 'system' END,
 'reason','Historical classification retained; imported uncertainty requires confirmation'))
WHERE kind='transactions' AND json_type(document,'$.classification') IS NULL;
CREATE INDEX classification_review ON resources(household_id,kind,json_extract(document,'$.classification.status'));
