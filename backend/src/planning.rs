use crate::{
    api::{self, Query},
    auth::Principal,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage, balances,
    reconciliation,
};
use axum::http::{HeaderMap, StatusCode};
use chrono::{Datelike, TimeZone, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::collections::{HashMap, HashSet};

type Reply = (StatusCode, Value);
fn ok(v: Value) -> Result<Reply> {
    Ok((StatusCode::OK, v))
}
fn positive(v: &Value, key: &str, currency: &str) -> Result<i64> {
    let n = money(text(v, key)?, currency)?;
    if n <= 0 {
        return Err(ApiError::invalid(format!("{key} must be positive.")));
    }
    Ok(n)
}
fn nonnegative(v: &Value, key: &str, currency: &str) -> Result<i64> {
    let n = money(text(v, key)?, currency)?;
    if n < 0 {
        return Err(ApiError::invalid(format!("{key} cannot be negative.")));
    }
    Ok(n)
}
fn quantity(v: &Value, key: &str) -> Result<i128> {
    let raw = text(v,key)?;
    let (whole, fractional) = raw.split_once('.').unwrap_or((raw,""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) || fractional.len() > 8 || !fractional.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::invalid(format!("{key} must have up to eight decimal places.")));
    }
    let major: i128 = whole.parse().map_err(|_| ApiError::invalid("Quantity is out of range."))?;
    let minor: i128 = format!("{fractional:0<8}").parse().map_err(|_| ApiError::invalid("Quantity is out of range."))?;
    let total = major.checked_mul(100_000_000).and_then(|n| n.checked_add(minor)).ok_or_else(|| ApiError::invalid("Quantity is out of range."))?;
    if total == 0 { return Err(ApiError::invalid("Units must be positive.")); }
    Ok(total)
}
fn unit_price_value(holding: &Value, as_of: &str, price: &str, currency: &str) -> Result<i64> {
    if holding["tracking_mode"] != "full_history" { return Err(ApiError::invalid("Unit price requires a full-history holding.")); }
    let (whole,fraction) = price.split_once('.').unwrap_or((price,""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) || fraction.len()>8 || !fraction.bytes().all(|b| b.is_ascii_digit()) { return Err(ApiError::invalid("Unit price must have up to eight decimal places.")); }
    let whole: i128 = whole.parse().map_err(|_| ApiError::invalid("Unit price is out of range."))?;
    let fraction: i128 = format!("{fraction:0<8}").parse().map_err(|_| ApiError::invalid("Unit price is out of range."))?;
    let scaled_price = whole.checked_mul(100_000_000).and_then(|n| n.checked_add(fraction)).ok_or_else(|| ApiError::invalid("Unit price is out of range."))?;
    let mut units = 0i128;
    for event in holding["events"].as_array().into_iter().flatten().filter(|event| event["reversed"] != true && event["trade_date"].as_str().is_some_and(|date| date <= as_of)) {
        match text(event,"type")? {
            "purchase" => units = units.checked_add(quantity(event,"units")?).ok_or_else(|| ApiError::invalid("Units are out of range."))?,
            "sale" => units = units.checked_sub(quantity(event,"units")?).ok_or_else(|| ApiError::invalid("Units are out of range."))?,
            _ => {}
        }
    }
    if units <= 0 { return Err(ApiError::invalid("No confirmed units were held on the price date.")); }
    let exponent = domain::exponent(currency)?;
    let factor = 10_i128.pow(exponent);
    let scaled_value = units.checked_mul(scaled_price).and_then(|n| n.checked_mul(factor)).and_then(|n| n.checked_add(5_000_000_000_000_000)).ok_or_else(|| ApiError::invalid("Valuation is out of range."))?;
    i64::try_from(scaled_value / 10_000_000_000_000_000).map_err(|_| ApiError::invalid("Valuation is out of range."))
}
fn fingerprint(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts { hash.update((part.len() as u64).to_be_bytes()); hash.update(part.as_bytes()); }
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}
fn economic_signature(event: &Value, currency: &str) -> Result<String> {
    let kind = text(event,"type")?;
    let amount = format_money(positive(event,"amount",currency)?,currency)?;
    let units = if ["purchase","sale"].contains(&kind) { format_units(quantity(event,"units")?) } else { String::new() };
    let charges = if ["purchase","sale"].contains(&kind) { format_money(event.get("charges").map(|_| nonnegative(event,"charges",currency)).transpose()?.unwrap_or(0),currency)? } else { String::new() };
    Ok(fingerprint(&[kind,text(event,"trade_date")?,&amount,&units,&charges]))
}
fn investment_import_rows(body: &Value, currency: &str) -> Result<Vec<Value>> {
    api::allowed_body(body, &["csv", "mapping", "source", "preview_hash", "revision", "selected_rows", "confirmed_duplicate_rows"])?;
    let source = text(body,"source")?.trim();
    if source.is_empty() || source.len() > 120 { return Err(ApiError::invalid("Source name must have 1 to 120 characters.")); }
    let csv_text = text(body,"csv")?;
    if csv_text.is_empty() || csv_text.len() > 1_000_000 { return Err(ApiError::invalid("CSV must have 1 to 1,000,000 bytes.")); }
    let mapping = body.get("mapping").unwrap_or(&Value::Null);
    if !mapping.is_null() { api::allowed_body(mapping,&["type","trade_date","amount","units","charges","source_id","note"])?; }
    let mut reader = csv::ReaderBuilder::new().trim(csv::Trim::All).from_reader(csv_text.as_bytes());
    let headers = reader.headers().map_err(|_| ApiError::invalid("CSV headers are invalid."))?.clone();
    let mut columns = HashMap::new();
    let mut used = HashSet::new();
    for key in ["type","trade_date","amount","units","charges","source_id","note"] {
        let label = mapping.get(key).and_then(Value::as_str).unwrap_or(key);
        if label.is_empty() { continue; }
        if !used.insert(label) { return Err(ApiError::invalid("Each CSV column may be mapped only once.")); }
        if let Some(position) = headers.iter().position(|header| header == label) { columns.insert(key,position); }
        else if ["type","trade_date","amount"].contains(&key) || mapping.get(key).is_some() { return Err(ApiError::invalid(format!("CSV column '{label}' is missing."))); }
    }
    let mut rows = Vec::new();
    for (index,result) in reader.records().enumerate() {
        if index >= 500 { return Err(ApiError::invalid("Import at most 500 investment events at once.")); }
        let record = result.map_err(|_| ApiError::invalid(format!("CSV row {} is malformed.",index+2)))?;
        let field = |key: &str| columns.get(key).and_then(|position| record.get(*position)).unwrap_or("").trim();
        let mut event = json!({"type":field("type"),"trade_date":field("trade_date"),"amount":field("amount")});
        for key in ["units","charges","source_id","note"] { if !field(key).is_empty() { event[key] = json!(field(key)); } }
        let kind = text(&event,"type")?;
        if !["purchase","sale","distribution","fee"].contains(&kind) { return Err(ApiError::invalid(format!("CSV row {} has an invalid event type.",index+2))); }
        let date = domain::date(text(&event,"trade_date")?)?;
        if date > Utc::now().date_naive() { return Err(ApiError::invalid(format!("CSV row {} has a future trade date.",index+2))); }
        positive(&event,"amount",currency)?;
        if ["purchase","sale"].contains(&kind) { quantity(&event,"units")?; if event.get("charges").is_some() { nonnegative(&event,"charges",currency)?; } }
        else if event.get("units").is_some() || event.get("charges").is_some() { return Err(ApiError::invalid(format!("CSV row {} cannot have units or charges.",index+2))); }
        if event["note"].as_str().is_some_and(|note| note.len()>200) || event["source_id"].as_str().is_some_and(|id| id.len()>120) { return Err(ApiError::invalid(format!("CSV row {} has an overlong note or reference.",index+2))); }
        let signature = economic_signature(&event,currency)?;
        let external_ref = event["source_id"].as_str().unwrap_or("").to_owned();
        let source_key = if external_ref.is_empty() { fingerprint(&[source,&signature]) } else { fingerprint(&[source,&external_ref]) };
        event["source_id"] = json!(format!("csv:{source_key}"));
        event["import_source"] = json!(source);
        event["import_reference"] = if external_ref.is_empty() { Value::Null } else { json!(external_ref) };
        event["import_signature"] = json!(signature);
        event["row_number"] = json!(index+2);
        rows.push(event);
    }
    if rows.is_empty() { return Err(ApiError::invalid("CSV has no investment events.")); }
    Ok(rows)
}
fn investment_import_preview(body: &Value, holding: &Value) -> Result<Value> {
    let currency = text(holding,"currency")?;
    let rows = investment_import_rows(body,currency)?;
    let mut key_counts: HashMap<String,usize> = HashMap::new();
    for row in &rows { *key_counts.entry(text(row,"source_id")?.to_owned()).or_default() += 1; }
    let mut signatures = HashSet::new();
    let mut preview = Vec::with_capacity(rows.len());
    let existing = holding["events"].as_array().ok_or_else(|| ApiError::invalid("Invalid investment events."))?;
    for (index,event) in rows.iter().enumerate() {
        let source_id = text(event,"source_id")?;
        let signature = text(event,"import_signature")?;
        let previous = existing.iter().find(|old| old["source_id"] == source_id && old["reversed"] != true);
        let resembles_existing = existing.iter().any(|old| old["reversed"] != true && old["source_id"] != source_id
            && economic_signature(old,currency).ok().as_deref() == Some(signature));
        let status = if key_counts.get(source_id).copied().unwrap_or(0)>1 { "needs_reference" }
            else if let Some(old) = previous { if old["import_signature"] == event["import_signature"] { "existing" } else { "changed_source" } }
            else if !signatures.insert(signature.to_owned()) || resembles_existing { "possible_duplicate" }
            else { "ready" };
        preview.push(json!({"index":index,"row_number":event["row_number"],"type":event["type"],"trade_date":event["trade_date"],"amount":event["amount"],"units":event.get("units"),"charges":event.get("charges"),"reference":event["import_reference"],"status":status}));
    }
    let mapping_text = body.get("mapping").map(Value::to_string).unwrap_or_default();
    let hash = fingerprint(&[text(body,"source")?,text(body,"csv")?,&mapping_text,&holding["revision"].to_string()]);
    Ok(json!({"id":holding["id"],"revision":holding["revision"],"preview_hash":hash,"rows":preview,"ready":preview.iter().filter(|row| row["status"]=="ready").count(),"requires_review":preview.iter().filter(|row| row["status"]=="needs_reference" || row["status"]=="changed_source" || row["status"]=="possible_duplicate").count()}))
}
fn month(s: &str) -> Result<()> {
    if s.len() != 7
        || !s.is_ascii()
        || !s.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        || s.as_bytes()[4] != b'-'
    {
        return Err(ApiError::invalid("Month must be YYYY-MM."));
    }
    api::month_bounds(s)?;
    Ok(())
}
fn valuation_date(value: &Value, record_month: &str, today: chrono::NaiveDate) -> Result<()> {
    if let Some(as_of) = value.get("valuation_date") {
        let date = domain::date(as_of.as_str().ok_or_else(|| ApiError::invalid("Valuation date must be YYYY-MM-DD."))?)?;
        if !as_of.as_str().unwrap().starts_with(record_month) {
            return Err(ApiError::invalid("Valuation date must be in its record month."));
        }
        if date > today {
            return Err(ApiError::invalid("Valuation date cannot be in the future."));
        }
    } else if record_month > today.format("%Y-%m").to_string().as_str() {
        return Err(ApiError::invalid("Valuation month cannot be in the future."));
    }
    Ok(())
}
fn set_valuation(record: &mut Value, value: &Value, currency: &str, record_month: &str, today: chrono::NaiveDate) -> Result<()> {
    nonnegative(value, "value", currency)?;
    valuation_date(value, record_month, today)?;
    if value.get("source").is_some() { domain::choice(value, "source", &["manual", "statement", "broker", "market"])?; }
    if value["note"].as_str().is_some_and(|note| note.len() > 200) { return Err(ApiError::invalid("Valuation note is too long.")); }
    if money(text(value, "value")?, currency)? == 0 && value["confirm_zero"] != true {
        return Err(ApiError::invalid("Confirm a zero valuation explicitly."));
    }
    record["value"] = value["value"].clone();
    record["valuation_pending"] = json!(false);
    record["valuation_date"] = value.get("valuation_date").cloned().unwrap_or_else(|| json!(format!("{record_month}-01")));
    record["valuation_source"] = value.get("source").cloned().unwrap_or_else(|| json!("manual"));
    record["valuation_note"] = value.get("note").cloned().unwrap_or(Value::Null);
    record["valuation_mode"] = json!(if value.get("unit_price").is_some() { "unit_price" } else { "total_value" });
    record["unit_price"] = value.get("unit_price").cloned().unwrap_or(Value::Null);
    Ok(())
}
fn validate_sip(sip: &Value, currency: &str) -> Result<()> {
    let fields = sip.as_object().ok_or_else(|| ApiError::invalid("SIP must be an object."))?;
    if fields.keys().any(|key| !["amount", "day", "start_month", "end_month", "status"].contains(&key.as_str())) {
        return Err(ApiError::invalid("Unknown SIP field."));
    }
    positive(sip, "amount", currency)?;
    let day = sip["day"].as_u64().ok_or_else(|| ApiError::invalid("SIP day must be an integer from 1 to 31."))?;
    if !(1..=31).contains(&day) {
        return Err(ApiError::invalid("SIP day must be an integer from 1 to 31."));
    }
    let start = text(sip, "start_month")?;
    month(start)?;
    if let Some(end) = sip.get("end_month") {
        let end = end.as_str().ok_or_else(|| ApiError::invalid("SIP end month must be YYYY-MM."))?;
        month(end)?;
        if end < start {
            return Err(ApiError::invalid("SIP end month cannot precede its start month."));
        }
    }
    domain::choice(sip, "status", &["active", "paused"])?;
    Ok(())
}
fn sip_for_month<'a>(holding: &'a Value, selected_month: &str) -> &'a Value {
    static EMPTY: Value = Value::Null;
    if let Some(history) = holding["sip_history"].as_array() {
        return history.iter().filter(|row| row["effective_month"].as_str().is_some_and(|month| month <= selected_month)).last()
            .map(|row| &row["sip"]).unwrap_or(&EMPTY);
    }
    &holding["sip"]
}
async fn validate_ownership(db: &mut SqliteConnection, p: &Principal, shares: &Value, visibility: &str) -> Result<()> {
    let rows = shares.as_array().ok_or_else(|| ApiError::invalid("Ownership shares must be an array."))?;
    if rows.is_empty() || rows.len() > 20 { return Err(ApiError::invalid("Choose 1 to 20 economic owners.")); }
    if rows.len() > 1 && visibility != "shared" { return Err(ApiError::invalid("Joint holdings must be shared with the household.")); }
    let mut seen = HashSet::new();
    let mut total = 0;
    for row in rows {
        api::allowed_body(row, &["user_id", "percent"])?;
        let user_id = text(row, "user_id")?;
        if !seen.insert(user_id) { return Err(ApiError::invalid("An economic owner appears twice.")); }
        let member_count: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=? AND active=1")
            .bind(&p.household_id).bind(user_id).fetch_one(&mut *db).await?;
        if member_count == 0 { return Err(ApiError::invalid("Economic owners must be active household members.")); }
        let share = money(text(row, "percent")?, "INR")?;
        if share <= 0 || share > 10000 { return Err(ApiError::invalid("Ownership percentages must be between 0 and 100.")); }
        total = add(total, share)?;
    }
    if total != 10000 { return Err(ApiError::invalid("Economic ownership must sum to 100%.")); }
    Ok(())
}
fn owner(p: &Principal, v: &Value) -> Result<()> {
    if v["owner_id"] == p.user_id {
        Ok(())
    } else {
        Err(ApiError::missing())
    }
}
fn active(v: &Value) -> Result<()> {
    if v["deleted"] == true || v["archived"] == true {
        Err(ApiError::missing())
    } else {
        Ok(())
    }
}
fn decorate_obligation(v: &mut Value) -> Result<()> {
    let currency = text(v, "currency")?.to_owned();
    let mut remaining = positive(v, "amount", &currency)?;
    for payment in v["repayments"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("Invalid repayments."))?
    {
        let amount = positive(payment, "amount", &currency)?;
        if amount > remaining {
            return Err(ApiError::invalid("Repayments exceed the obligation."));
        }
        remaining -= amount;
    }
    v["remaining"] = json!(format_money(remaining, &currency)?);
    v["status"] = json!(if remaining == 0 { "settled" } else { "open" });
    Ok(())
}
fn decorate_investment(v: &mut Value) -> Result<()> {
    let currency = text(v, "currency")?.to_owned();
    let opening = if v.get("opening_value").is_some() {
        month(text(v, "opening_month")?)?;
        Some(nonnegative(v, "opening_value", &currency)?)
    } else { None };
    let mut invested = opening.unwrap_or(0);
    let mut basis_known = opening.is_some();
    let mut saw_value = false;
    let mut last_value = opening;
    let mut valuation_month = v["opening_month"].clone();
    let mut pending_valuation = false;
    let mut previous_observation = opening.map(|value| (format!("{}-01", v["opening_month"].as_str().unwrap()), value));
    let mut records = v["records"].as_array().cloned().unwrap_or_default();
    records.sort_by(|a, b| a["month"].as_str().cmp(&b["month"].as_str()));
    for record in &mut records {
        if v["opening_month"].as_str().is_some_and(|start| record["month"].as_str().is_some_and(|record_month| record_month < start)) {
            return Err(ApiError::invalid("Investment months cannot precede the opening value."));
        }
        let contribution = nonnegative(record, "contribution", &currency)?;
        let withdrawal = nonnegative(record, "withdrawal", &currency)?;
        if !basis_known && !saw_value && contribution > 0 { basis_known = true; }
        invested = add(invested, contribution)?
            .checked_sub(withdrawal)
            .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        if invested < 0 {
            return Err(ApiError::invalid("Withdrawals exceed contributions."));
        }
        record["net_contributions"] = json!(format_money(invested, &currency)?);
        record["period_performance"] = Value::Null;
        if record["value"].is_null() {
            record["gain_loss"] = Value::Null;
            if contribution != 0 || withdrawal != 0 { pending_valuation = true; }
        } else {
            let value = nonnegative(record, "value", &currency)?;
            let prior_observation = record["valuation_pending"] == true || record["valuation_date"].as_str().is_some_and(|date| record["transaction_date"].as_str().is_some_and(|movement| movement > date));
            let (start, next) = api::month_bounds(text(record, "month")?)?;
            let month_end = domain::date(&next)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid month."))?.to_string();
            let valuation_day = record["valuation_date"].as_str().map(str::to_owned);
            if !prior_observation && valuation_day.as_deref() == Some(month_end.as_str()) {
                if let Some((previous_date, previous_value)) = &previous_observation {
                    let previous_month_end = domain::date(&start)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid month."))?.to_string();
                    if previous_date == &start || previous_date == &previous_month_end {
                        let performance = value.checked_sub(*previous_value)
                            .and_then(|n| n.checked_sub(contribution))
                            .and_then(|n| n.checked_add(withdrawal))
                            .ok_or_else(|| ApiError::invalid("Performance is out of range."))?;
                        record["period_performance"] = json!(format_money(performance, &currency)?);
                    }
                }
            }
            record["gain_loss"] = if prior_observation || !basis_known { Value::Null } else { json!(format_money(
                value.checked_sub(invested).ok_or_else(|| ApiError::invalid("Money total is out of range."))?, &currency
            )?) };
            last_value = Some(value);
            saw_value = true;
            valuation_month = record["month"].clone();
            pending_valuation = prior_observation;
            if let Some(date) = valuation_day { previous_observation = Some((date, value)); }
        }
    }
    v["records"] = json!(records);
    v["net_contributions"] = json!(format_money(invested, &currency)?);
    v["valuation_month"] = valuation_month;
    v["current_value"] = last_value
        .map(|n| format_money(n, &currency))
        .transpose()?
        .map_or(Value::Null, |s| json!(s));
    v["performance_coverage"] = json!(if basis_known { "since_tracking_start" } else { "unknown_starting_basis" });
    v["gain_loss"] = if pending_valuation || !basis_known { None } else { last_value }
        .map(|n| {
            n.checked_sub(invested)
                .ok_or_else(|| ApiError::invalid("Money total is out of range."))
        })
        .transpose()?
        .map(|n| format_money(n, &currency))
        .transpose()?
        .map_or(Value::Null, |s| json!(s));
    if v["tracking_mode"] == "full_history" { decorate_full_history(v, &currency)?; }
    Ok(())
}
fn decorate_investment_as_of(v: &mut Value, selected_month: &str) -> Result<()> {
    month(selected_month)?;
    if let Some(records) = v["records"].as_array_mut() { records.retain(|record| record["month"].as_str().is_some_and(|record_month| record_month <= selected_month)); }
    if let Some(events) = v["events"].as_array_mut() { events.retain(|event| event["trade_date"].as_str().is_some_and(|date| date.get(..7).is_some_and(|event_month| event_month <= selected_month))); }
    if v["opening_month"].as_str().is_some_and(|opening| opening > selected_month) {
        v.as_object_mut().unwrap().remove("opening_value");
        v.as_object_mut().unwrap().remove("opening_month");
    }
    if let Some(occurrences) = v["sip_occurrences"].as_array_mut() { occurrences.retain(|row| row["month"].as_str().is_some_and(|month| month <= selected_month)); }
    v["as_of_month"] = json!(selected_month);
    decorate_investment(v)
}
fn format_units(units: i128) -> String {
    format!("{}.{:08}",units / 100_000_000,units % 100_000_000)
}
fn annualized_money_weighted_return(flows: &[(chrono::NaiveDate, i64)]) -> Option<f64> {
    if flows.len() < 2 || !flows.iter().any(|(_,amount)| *amount < 0) || !flows.iter().any(|(_,amount)| *amount > 0) { return None; }
    let first = flows.iter().map(|(date,_)| *date).min()?;
    if flows.iter().all(|(date,_)| *date == first) { return None; }
    let npv = |rate: f64| -> f64 {
        flows.iter().map(|(date,amount)| (*amount as f64) / (1.0+rate).powf(date.signed_duration_since(first).num_days() as f64 / 365.0)).sum()
    };
    let rates = [-0.9999,-0.999,-0.99,-0.9,-0.75,-0.5,-0.25,-0.1,0.0,0.05,0.1,0.2,0.5,1.0,2.0,5.0,10.0,50.0,100.0,1000.0];
    let mut brackets = Vec::new();
    for pair in rates.windows(2) {
        let (left,right) = (npv(pair[0]),npv(pair[1]));
        if !left.is_finite() || !right.is_finite() { return None; }
        if left == 0.0 { brackets.push((pair[0],pair[0])); }
        else if left.signum() != right.signum() { brackets.push((pair[0],pair[1])); }
    }
    if npv(*rates.last()?) == 0.0 { brackets.push((*rates.last()?,*rates.last()?)); }
    if brackets.len() != 1 { return None; }
    let (mut low,mut high) = brackets[0];
    if low == high { return Some(low); }
    let low_sign = npv(low).signum();
    for _ in 0..100 {
        let mid = (low+high)/2.0;
        if npv(mid).signum() == low_sign { low=mid; } else { high=mid; }
    }
    let result = (low+high)/2.0;
    result.is_finite().then_some(result)
}
fn decorate_full_history(v: &mut Value, currency: &str) -> Result<()> {
    let mut events: Vec<Value> = v["events"].as_array().into_iter().flatten().filter(|event| event["reversed"] != true).cloned().collect();
    events.sort_by(|a,b| a["trade_date"].as_str().cmp(&b["trade_date"].as_str())
        .then(a["sequence"].as_u64().cmp(&b["sequence"].as_u64()))
        .then(a["created_at"].as_str().cmp(&b["created_at"].as_str()))
        .then(a["id"].as_str().cmp(&b["id"].as_str())));
    let mut lots: Vec<(i128,i64)> = vec![];
    let mut net = 0i64;
    let mut realized = 0i64;
    let mut distributions = 0i64;
    let mut fees = 0i64;
    let mut monthly: HashMap<String,(i64,i64,i64,i64,i64)> = HashMap::new();
    for event in &events {
        let date = text(event,"trade_date")?;
        domain::date(date)?;
        let kind = text(event,"type")?;
        let amount = positive(event,"amount",currency)?;
        let month_key = date[..7].to_owned();
        let totals = monthly.entry(month_key).or_insert((0,0,0,0,0));
        match kind {
            "purchase" => {
                let units = quantity(event,"units")?;
                let charges = if event.get("charges").is_some() { nonnegative(event,"charges",currency)? } else { 0 };
                let cost = add(amount,charges)?;
                lots.push((units,cost));
                net = add(net,cost)?;
                totals.0 = add(totals.0,cost)?;
                totals.4 = add(totals.4,cost)?;
            }
            "sale" => {
                let mut units = quantity(event,"units")?;
                let charges = if event.get("charges").is_some() { nonnegative(event,"charges",currency)? } else { 0 };
                let proceeds = amount.checked_sub(charges).ok_or_else(|| ApiError::invalid("Sale charges exceed proceeds."))?;
                let mut assigned = 0i64;
                for lot in &mut lots {
                    if units == 0 { break; }
                    let taken = units.min(lot.0);
                    if taken == 0 { continue; }
                    let cost = if taken == lot.0 { lot.1 } else {
                        let numerator = (lot.1 as i128).checked_mul(taken).and_then(|n| n.checked_add(lot.0 / 2)).ok_or_else(|| ApiError::invalid("Lot cost is out of range."))?;
                        i64::try_from(numerator / lot.0).map_err(|_| ApiError::invalid("Lot cost is out of range."))?
                    };
                    lot.0 -= taken;
                    lot.1 -= cost;
                    units -= taken;
                    assigned = add(assigned,cost)?;
                }
                if units != 0 { return Err(ApiError::invalid("Sale units exceed held units.")); }
                realized = add(realized,proceeds.checked_sub(assigned).ok_or_else(|| ApiError::invalid("Realized result is out of range."))?)?;
                net = net.checked_sub(proceeds).ok_or_else(|| ApiError::invalid("Event total is out of range."))?;
                totals.1 = add(totals.1,proceeds)?;
                totals.4 = totals.4.checked_sub(proceeds).ok_or_else(|| ApiError::invalid("Event total is out of range."))?;
            }
            "distribution" => {
                distributions = add(distributions,amount)?;
                net = net.checked_sub(amount).ok_or_else(|| ApiError::invalid("Event total is out of range."))?;
                totals.2 = add(totals.2,amount)?;
                totals.4 = totals.4.checked_sub(amount).ok_or_else(|| ApiError::invalid("Event total is out of range."))?;
            }
            "fee" => {
                fees = add(fees,amount)?;
                net = add(net,amount)?;
                totals.3 = add(totals.3,amount)?;
                totals.4 = add(totals.4,amount)?;
            }
            _ => return Err(ApiError::invalid("Invalid investment event type.")),
        }
    }
    lots.retain(|lot| lot.0 != 0);
    let basis = lots.iter().try_fold(0i64,|sum,lot| add(sum,lot.1))?;
    let units = lots.iter().try_fold(0i128,|sum,lot| sum.checked_add(lot.0).ok_or_else(|| ApiError::invalid("Units are out of range.")))?;
    let mut previous_value: Option<(String,i64)> = None;
    if let Some(records) = v["records"].as_array_mut() {
        for record in records {
            let record_month = text(record,"month")?.to_owned();
            let event_net = monthly.iter().filter(|(month,_)| *month <= &record_month).try_fold(0i64,|sum,(_,totals)| add(sum,totals.4))?;
            let totals = monthly.get(&record_month).copied().unwrap_or_default();
            record["event_purchases"] = json!(format_money(totals.0,currency)?);
            record["event_sale_proceeds"] = json!(format_money(totals.1,currency)?);
            record["event_distributions"] = json!(format_money(totals.2,currency)?);
            record["event_fees"] = json!(format_money(totals.3,currency)?);
            record["net_contributions"] = json!(format_money(event_net,currency)?);
            record["period_performance"] = Value::Null;
            let latest_event_after_value = record["valuation_date"].as_str().is_some_and(|as_of| events.iter().any(|event| event["trade_date"].as_str().is_some_and(|date| date.starts_with(&record_month) && date > as_of)));
            if let Some(value) = record["value"].as_str() {
                let value = money(value,currency)?;
                if let (Some((previous_date,opening)),Some(current_date)) = (&previous_value,record["valuation_date"].as_str()) {
                    let (start,next) = api::month_bounds(&record_month)?;
                    let prior_end = domain::date(&start)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid month."))?.to_string();
                    let month_end = domain::date(&next)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid month."))?.to_string();
                    if previous_date == &prior_end && current_date == month_end && !latest_event_after_value {
                        let result = value.checked_sub(*opening).and_then(|n| n.checked_sub(totals.4)).ok_or_else(|| ApiError::invalid("Period result is out of range."))?;
                        record["period_performance"] = json!(format_money(result,currency)?);
                    }
                }
                record["gain_loss"] = if record["valuation_date"].is_null() || latest_event_after_value || record["valuation_pending"] == true || events.is_empty() { Value::Null }
                    else { json!(format_money(value.checked_sub(event_net).ok_or_else(|| ApiError::invalid("Result is out of range."))?,currency)?) };
                if let Some(date) = record["valuation_date"].as_str() { previous_value = Some((date.to_owned(),value)); }
            }
        }
    }
    v["remaining_units"] = json!(format_units(units));
    v["remaining_cost_basis"] = json!(format_money(basis,currency)?);
    v["realized_gain_loss"] = json!(format_money(realized,currency)?);
    v["distributions"] = json!(format_money(distributions,currency)?);
    v["fees"] = json!(format_money(fees,currency)?);
    v["net_contributions"] = json!(format_money(net,currency)?);
    v["performance_coverage"] = json!(if events.is_empty() { "missing_events" } else { "full_history" });
    let last = v["records"].as_array().into_iter().flatten().filter(|record| record["value"].is_string()).last().cloned();
    let pending = last.as_ref().is_some_and(|record| record["gain_loss"].is_null() || events.iter().any(|event| event["trade_date"].as_str().is_some_and(|date| record["valuation_date"].as_str().is_some_and(|as_of| date > as_of))));
    if let Some(value) = v["current_value"].as_str().filter(|_| !events.is_empty() && !pending) {
        let value = money(value,currency)?;
        v["unrealized_gain_loss"] = json!(format_money(value.checked_sub(basis).ok_or_else(|| ApiError::invalid("Unrealized result is out of range."))?,currency)?);
        v["gain_loss"] = json!(format_money(value.checked_sub(net).ok_or_else(|| ApiError::invalid("Result is out of range."))?,currency)?);
    } else { v["unrealized_gain_loss"] = Value::Null; v["gain_loss"] = Value::Null; }
    v["xirr_percent"] = Value::Null;
    v["xirr_as_of"] = Value::Null;
    v["xirr_reason"] = json!(if pending { "valuation_predates_activity" } else { "insufficient_dated_flows_or_value" });
    if !pending {
        if let Some((as_of,value)) = last.as_ref().and_then(|record| Some((record["valuation_date"].as_str()?,record["value"].as_str()?))) {
            let terminal = domain::date(as_of)?;
            let mut flows = Vec::with_capacity(events.len()+1);
            for event in &events {
                let date = domain::date(text(event,"trade_date")?)?;
                if date > terminal { continue; }
                let amount = positive(event,"amount",currency)?;
                let charges = event.get("charges").map(|_| nonnegative(event,"charges",currency)).transpose()?.unwrap_or(0);
                let signed = match text(event,"type")? {
                    "purchase" => -add(amount,charges)?,
                    "sale" => amount.checked_sub(charges).ok_or_else(|| ApiError::invalid("Sale charges exceed proceeds."))?,
                    "distribution" => amount,
                    "fee" => -amount,
                    _ => return Err(ApiError::invalid("Invalid investment event type.")),
                };
                flows.push((date,signed));
            }
            flows.push((terminal,money(value,currency)?));
            if let Some(rate) = annualized_money_weighted_return(&flows) {
                v["xirr_percent"] = json!(format!("{:.2}",rate*100.0));
                v["xirr_as_of"] = json!(as_of);
                v["xirr_reason"] = Value::Null;
            }
        }
    }
    Ok(())
}
pub async fn transaction_linked(db: &mut SqliteConnection, p: &Principal, transaction_id: &str) -> Result<bool> {
    let documents: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='investments'")
        .bind(&p.household_id).fetch_all(db).await?;
    for document in documents {
        let holding: Value = serde_json::from_str(&document).map_err(|_| ApiError::invalid("Invalid stored investment."))?;
        if holding["deleted"] == true { continue; }
        if holding["sip_occurrences"].as_array().into_iter().flatten().any(|occurrence| occurrence["transaction_id"] == transaction_id) { return Ok(true); }
        if holding["events"].as_array().into_iter().flatten().any(|event| event["reversed"] != true && event["funding_allocations"].as_array().into_iter().flatten().any(|link| link["transaction_id"] == transaction_id)) { return Ok(true); }
        if holding["records"].as_array().into_iter().flatten().any(|record| {
            record["linked_transaction_ids"].as_array().into_iter().flatten().any(|id| id.as_str() == Some(transaction_id))
        }) { return Ok(true); }
    }
    Ok(false)
}
async fn linked_amount(db: &mut SqliteConnection, p: &Principal, transaction_id: &str, currency: &str, full_amount: i64) -> Result<i64> {
    let documents: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='investments'")
        .bind(&p.household_id).fetch_all(db).await?;
    let mut allocated = 0;
    for document in documents {
        let holding: Value = serde_json::from_str(&document).map_err(|_| ApiError::invalid("Invalid stored investment."))?;
        if holding["deleted"] == true { continue; }
        for record in holding["records"].as_array().into_iter().flatten() {
            if record["linked_transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(transaction_id))) {
                let amount = record["linked_allocations"].as_array().and_then(|allocations| allocations.iter().find(|item| item["transaction_id"] == transaction_id))
                    .map(|item| positive(item, "amount", currency)).transpose()?.unwrap_or(full_amount);
                allocated = add(allocated, amount)?;
            }
        }
        for event in holding["events"].as_array().into_iter().flatten().filter(|event| event["reversed"] != true) {
            for link in event["funding_allocations"].as_array().into_iter().flatten().filter(|link| link["transaction_id"] == transaction_id) {
                allocated = add(allocated,positive(link,"amount",currency)?)?;
            }
        }
    }
    Ok(allocated)
}
fn visible_linked_amount(holdings: &[Value], transaction_id: &str, currency: &str, full_amount: i64) -> Result<i64> {
    let mut allocated = 0;
    for holding in holdings {
        for record in holding["records"].as_array().into_iter().flatten() {
            if record["linked_transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(transaction_id))) {
                let amount = record["linked_allocations"].as_array().and_then(|allocations| allocations.iter().find(|item| item["transaction_id"] == transaction_id))
                    .map(|item| positive(item, "amount", currency)).transpose()?.unwrap_or(full_amount);
                allocated = add(allocated, amount)?;
            }
        }
        for event in holding["events"].as_array().into_iter().flatten().filter(|event| event["reversed"] != true) {
            for link in event["funding_allocations"].as_array().into_iter().flatten().filter(|link| link["transaction_id"] == transaction_id) {
                allocated = add(allocated,positive(link,"amount",currency)?)?;
            }
        }
    }
    Ok(allocated)
}
fn ownership_basis(holding: &Value, date: &str, user_id: &str) -> Result<i64> {
    let shares = holding["ownership_history"].as_array().and_then(|history| history.iter().filter(|entry| entry["effective_date"].as_str().is_some_and(|start| start <= date)).last()).and_then(|entry| entry["shares"].as_array());
    if let Some(shares) = shares {
        return shares.iter().find(|share| share["user_id"] == user_id).map(|share| money(text(share, "percent")?, "INR")).transpose().map(|value| value.unwrap_or(0));
    }
    Ok(if holding["owner_id"] == user_id { 10000 } else { 0 })
}
fn prorate(amount: i64, basis: i64) -> Result<i64> {
    let product = (amount as i128) * (basis as i128);
    let rounded = if product < 0 { (product - 5000) / 10000 } else { (product + 5000) / 10000 };
    i64::try_from(rounded).map_err(|_| ApiError::invalid("Attributed amount is out of range."))
}
async fn goal_asset_value(db: &mut SqliteConnection, p: &Principal, kind: &str, asset_id: &str, currency: &str, cutoff: chrono::DateTime<Utc>) -> Result<Option<(i64, String)>> {
    match kind {
        "account" => {
            let account = storage::get(db, p, "accounts", asset_id).await?;
            if account["currency"] != currency || !["bank", "cash", "investment_cash"].contains(&account["subtype"].as_str().unwrap_or("")) { return Err(ApiError::invalid("Choose an eligible account in the goal currency.")); }
            let balance = balances::derived(db, p, &account, cutoff).await?;
            if let Some(value) = balance["amount"].as_str() { Ok(Some((money(value,currency)?,cutoff.date_naive().to_string()))) }
            else { Ok(None) }
        }
        "holding" => {
            let mut holding = storage::get(db, p, "investments", asset_id).await?;
            if holding["deleted"] == true || holding["currency"] != currency { return Err(ApiError::invalid("Choose an active holding in the goal currency.")); }
            decorate_investment(&mut holding)?;
            let as_of = cutoff.date_naive().to_string();
            let mut values = vec![];
            if let (Some(opening), Some(month)) = (holding["opening_value"].as_str(),holding["opening_month"].as_str()) {
                let date = format!("{month}-01");
                if date <= as_of { values.push((date,money(opening,currency)?)); }
            }
            for record in holding["records"].as_array().into_iter().flatten() {
                if let (Some(value), Some(month)) = (record["value"].as_str(),record["month"].as_str()) {
                    let date = record["valuation_date"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{month}-01"));
                    if date <= as_of { values.push((date,money(value,currency)?)); }
                }
            }
            values.sort_by(|a,b| a.0.cmp(&b.0));
            Ok(values.pop().map(|(date,value)| (value,date)))
        }
        _ => Err(ApiError::invalid("Asset kind must be account or holding.")),
    }
}
fn goal_allocation_amount(allocation: &Value, asset_value: i64, currency: &str) -> Result<i64> {
    match text(allocation, "mode")? {
        "fixed" => nonnegative(allocation, "amount", currency),
        "percent" => {
            let basis = money(text(allocation, "percent")?, "INR")?;
            if !(1..=10000).contains(&basis) { return Err(ApiError::invalid("Goal percentage must be above zero and at most 100%.")); }
            prorate(asset_value.max(0),basis)
        }
        _ => Err(ApiError::invalid("Allocation mode must be fixed or percent.")),
    }
}
async fn validate_goal(db: &mut SqliteConnection, p: &Principal, goal: &Value, excluding: Option<&str>) -> Result<()> {
    let name = text(goal, "name")?;
    if name.len() > 100 { return Err(ApiError::invalid("Goal name is too long.")); }
    domain::choice(goal, "kind", &["emergency", "general"])?;
    domain::choice(goal, "visibility", &["private", "shared"])?;
    let currency = text(goal, "currency")?;
    domain::exponent(currency)?;
    positive(goal, "target_amount", currency)?;
    if goal["kind"] == "emergency" {
        positive(goal, "essential_monthly", currency)?;
        let months = goal["target_months"].as_u64().ok_or_else(|| ApiError::invalid("Target months must be an integer."))?;
        if !(1..=36).contains(&months) { return Err(ApiError::invalid("Target months must be 1–36.")); }
    }
    let allocations = goal["allocations"].as_array().ok_or_else(|| ApiError::invalid("Goal allocations must be an array."))?;
    if allocations.len() > 50 { return Err(ApiError::invalid("Too many goal allocations.")); }
    let mut seen = HashSet::new();
    let mut reservations: HashMap<String, i64> = HashMap::new();
    let now = Utc::now();
    for allocation in allocations {
        api::allowed_body(allocation, &["asset_kind", "asset_id", "mode", "amount", "percent", "readily_accessible"])?;
        let kind = text(allocation, "asset_kind")?;
        let asset_id = text(allocation, "asset_id")?;
        let key = format!("{kind}:{asset_id}");
        if !seen.insert(key.clone()) { return Err(ApiError::invalid("An asset can appear only once in a goal.")); }
        if allocation["readily_accessible"].is_boolean() == false { return Err(ApiError::invalid("Set whether the allocation is readily accessible.")); }
        let asset = storage::get(db, p, if kind == "account" { "accounts" } else { "investments" }, asset_id).await?;
        if goal["visibility"] == "shared" && asset["visibility"] != "shared" { return Err(ApiError::invalid("A shared goal can use only shared assets.")); }
        let (value, _) = goal_asset_value(db, p, kind, asset_id, currency, now).await?.ok_or_else(|| ApiError::invalid("Value the asset before allocating it to a goal."))?;
        let amount = goal_allocation_amount(allocation, value, currency)?;
        reservations.insert(key, amount);
    }
    let documents: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='investment_goals'")
        .bind(&p.household_id).fetch_all(&mut *db).await?;
    for document in documents {
        let existing: Value = serde_json::from_str(&document).map_err(|_| ApiError::invalid("Invalid stored goal."))?;
        if existing["archived"] == true || existing["id"].as_str() == excluding { continue; }
        for allocation in existing["allocations"].as_array().into_iter().flatten() {
            let Some(asset_id) = allocation["asset_id"].as_str() else { continue; };
            let Some(kind) = allocation["asset_kind"].as_str() else { continue; };
            let key = format!("{kind}:{asset_id}");
            if let Some(total) = reservations.get_mut(&key) {
                let Some((value,_)) = goal_asset_value(db, p, kind, asset_id, currency, now).await? else { continue; };
                *total = add(*total, goal_allocation_amount(allocation, value, currency)?)?;
            }
        }
    }
    for (key,total) in reservations {
        let (kind,asset_id) = key.split_once(':').unwrap();
        let (value,_) = goal_asset_value(db, p, kind, asset_id, currency, now).await?.unwrap();
        if total > value.max(0) { return Err(ApiError::conflict("Goal allocations exceed the asset's available value.")); }
    }
    Ok(())
}
async fn goal_cutoff(db: &mut SqliteConnection, p: &Principal, selected_month: Option<&str>) -> Result<chrono::DateTime<Utc>> {
    let Some(selected_month) = selected_month else { return Ok(Utc::now()); };
    let (_, next_month) = api::month_bounds(selected_month)?;
    let household_document: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
        .bind(&p.household_id).fetch_one(&mut *db).await?;
    let household: Value = serde_json::from_str(&household_document).map_err(|_| ApiError::invalid("Invalid household settings."))?;
    let tz: chrono_tz::Tz = household["timezone"].as_str().unwrap_or("UTC").parse().map_err(|_| ApiError::invalid("Invalid household timezone."))?;
    let next = domain::date(&next_month)?;
    let local_end = tz.from_local_datetime(&next.and_hms_opt(0,0,0).unwrap()).earliest().ok_or_else(|| ApiError::invalid("Invalid goal cutoff."))?;
    Ok(std::cmp::min(local_end.with_timezone(&Utc)-chrono::Duration::nanoseconds(1),Utc::now()))
}
async fn decorate_goal(db: &mut SqliteConnection, p: &Principal, goal: &mut Value, cutoff: chrono::DateTime<Utc>) -> Result<()> {
    let currency = text(goal,"currency")?.to_owned();
    let mut allocated = 0;
    let mut accessible = 0;
    let mut missing = 0;
    let mut stale = 0;
    let mut rows = vec![];
    for allocation in goal["allocations"].as_array().into_iter().flatten() {
        let kind = text(allocation,"asset_kind")?;
        let asset_id = text(allocation,"asset_id")?;
        let asset = storage::get(db,p,if kind == "account" {"accounts"} else {"investments"},asset_id).await?;
        let observed = goal_asset_value(db,p,kind,asset_id,&currency,cutoff).await?;
        if let Some((value,date)) = observed {
            let reserve = goal_allocation_amount(allocation,value,&currency)?;
            let usable = reserve.min(value.max(0));
            allocated = add(allocated,usable)?;
            if allocation["readily_accessible"] == true { accessible = add(accessible,usable)?; }
            let stale_value = domain::date(&date).is_ok_and(|d| cutoff.date_naive().signed_duration_since(d).num_days() > 90);
            if stale_value { stale += 1; }
            rows.push(json!({"asset_kind":kind,"asset_id":asset_id,"asset_name":asset["name"],"observed_value":format_money(value,&currency)?,"value_date":date,"reserved":format_money(usable,&currency)?,"requested":format_money(reserve,&currency)?,"shortfall":format_money((reserve-usable).max(0),&currency)?,"readily_accessible":allocation["readily_accessible"],"market_exposed":kind == "holding" && !["deposit","investment_cash"].contains(&asset["asset_class"].as_str().unwrap_or("")),"stale":stale_value}));
        } else {
            missing += 1;
            rows.push(json!({"asset_kind":kind,"asset_id":asset_id,"asset_name":asset["name"],"observed_value":Value::Null,"value_date":Value::Null,"reserved":Value::Null,"readily_accessible":allocation["readily_accessible"],"stale":true}));
        }
    }
    let target = positive(goal,"target_amount",&currency)?;
    goal["allocated_value"] = json!(format_money(allocated,&currency)?);
    goal["readily_accessible_value"] = json!(format_money(accessible,&currency)?);
    goal["shortfall"] = json!(format_money((target-allocated).max(0),&currency)?);
    goal["valuation_missing"] = json!(missing);
    goal["valuation_stale"] = json!(stale);
    goal["allocation_details"] = json!(rows);
    if goal["kind"] == "emergency" {
        let essential = positive(goal,"essential_monthly",&currency)?;
        let hundredths = (allocated as i128 * 100) / (essential as i128);
        goal["months_covered"] = json!(format!("{}.{:02}",hundredths/100,hundredths%100));
    }
    Ok(())
}
async fn retire_investment_movements(db: &mut SqliteConnection, p: &Principal, record: &Value) -> Result<()> {
    for id in record["transaction_ids"].as_array().into_iter().flatten() {
        let transaction = storage::get(db, p, "transactions", id.as_str().ok_or_else(|| ApiError::invalid("Invalid investment transaction."))?).await?;
        if transaction["voided"] != true {
            reconciliation::invalidate(db, p, text(&transaction, "id")?).await?;
            let mut voided = transaction.clone();
            voided["voided"] = json!(true);
            voided["void_reason"] = json!("Investment month corrected or removed");
            voided["reconciliation_state"] = json!("unmatched");
            storage::update(db, p, &transaction, voided, "investment_movement_removed").await?;
        }
    }
    Ok(())
}
async fn post_investment_movements(db: &mut SqliteConnection, p: &Principal, holding: &Value, record: &mut Value) -> Result<()> {
    let Some(account_id) = record["account_id"].as_str() else { return Ok(()); };
    let account = storage::get(db, p, "accounts", account_id).await?;
    let currency = text(holding, "currency")?;
    if account["active"] == false || account["currency"] != currency || account["subtype"] == "settle_up" {
        return Err(ApiError::invalid("Choose an active account in the investment currency."));
    }
    let date = text(record, "transaction_date")?;
    domain::date(date)?;
    if !date.starts_with(text(record, "month")?) {
        return Err(ApiError::invalid("Transaction date must be in the valuation month."));
    }
    let mut ids = vec![];
    for (field, kind, negative) in [("contribution", "investment", true), ("withdrawal", "investment_withdrawal", false)] {
        let amount = nonnegative(record, field, currency)?;
        if amount == 0 { continue; }
        let signed = format_money(if negative { -amount } else { amount }, currency)?;
        let transaction = json!({"event_type":kind,"investment_id":holding["id"],"investment_month":record["month"],"amount":record[field],"currency":currency,"effective_date":date,"description":format!("{} · {}", if negative { "Invested in" } else { "Withdrawn from" },text(holding,"name")?),"movements":[{"account_id":account_id,"amount":signed}],"allocations":[],"entered_by":p.user_id,"voided":false,"source_refs":[],"reconciliation_state":"unmatched"});
        api::validate_ledger(db, p, &transaction).await?;
        let created = storage::create(db, p, "transactions", transaction).await?;
        ids.push(created["id"].clone());
    }
    record["transaction_ids"] = json!(ids);
    Ok(())
}
pub async fn route(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    path: &str,
    q: &Query,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    let parts: Vec<&str> = path.split('/').collect();
    match (method, parts.as_slice()) {
        ("GET", ["settle-ups"]) => {
            api::allowed_query(q, &["status", "cursor", "limit"])?;
            let mut items = storage::list(db, p, "settlement_obligations").await?;
            items.retain(|v| v["deleted"] != true);
            for item in &mut items {
                decorate_obligation(item)?;
            }
            if let Some(status) = q.get("status") {
                items.retain(|v| v["status"] == status.as_str());
            }
            items.sort_by(|a, b| b["date"].as_str().cmp(&a["date"].as_str()));
            ok(api::paginate(items, q)?)
        }
        ("POST", ["settle-ups"]) => {
            api::allowed_body(
                body,
                &[
                    "person",
                    "direction",
                    "amount",
                    "currency",
                    "date",
                    "description",
                    "kind",
                ],
            )?;
            domain::choice(body, "direction", &["owed_to_me", "i_owe"])?;
            domain::choice(body, "kind", &["loan", "split", "other"])?;
            domain::date(text(body, "date")?)?;
            let currency = text(body, "currency")?;
            positive(body, "amount", currency)?;
            let person = text(body, "person")?.trim();
            if person.is_empty() || person.len() > 100 || text(body, "description")?.len() > 500 {
                return Err(ApiError::invalid("Name or description is too long."));
            }
            let mut v = body.clone();
            v["person"] = json!(person);
            v["repayments"] = json!([]);
            let mut v = storage::create(db, p, "settlement_obligations", v).await?;
            decorate_obligation(&mut v)?;
            Ok((StatusCode::CREATED, v))
        }
        ("POST", ["settle-ups", "splits"]) => {
            api::allowed_body(
                body,
                &[
                    "description",
                    "date",
                    "currency",
                    "total",
                    "my_share",
                    "shares",
                    "transaction_id",
                    "paid_by",
                ],
            )?;
            domain::date(text(body, "date")?)?;
            if text(body, "description")?.len() > 500 {
                return Err(ApiError::invalid("Description is too long."));
            }
            let currency = text(body, "currency")?;
            let total = positive(body, "total", currency)?;
            let paid_by = body["paid_by"].as_str().unwrap_or("me").trim();
            if paid_by.is_empty() || paid_by.len() > 100 {
                return Err(ApiError::invalid("Invalid payer name."));
            }
            if paid_by != "me" && body.get("transaction_id").is_some() {
                return Err(ApiError::invalid(
                    "Only purchases you paid can link your recorded expense.",
                ));
            }
            if let Some(transaction_id) = body["transaction_id"].as_str().filter(|s| !s.is_empty())
            {
                let transaction = storage::get(db, p, "transactions", transaction_id).await?;
                if transaction["event_type"] != "expense"
                    || transaction["voided"] == true
                    || transaction["currency"] != currency
                    || money(text(&transaction, "amount")?, currency)? != total
                {
                    return Err(ApiError::invalid(
                        "Linked expense must be active and match the split total and currency.",
                    ));
                }
                if storage::list(db, p, "settlement_obligations")
                    .await?
                    .iter()
                    .any(|v| v["deleted"] != true && v["transaction_id"] == transaction_id)
                {
                    return Err(ApiError::conflict("This expense already has a split."));
                }
            }
            let mine = nonnegative(body, "my_share", currency)?;
            if mine > total {
                return Err(ApiError::invalid("Your share exceeds the purchase total."));
            }
            let shares = body["shares"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("shares must be an array."))?;
            if shares.is_empty() || shares.len() > 50 {
                return Err(ApiError::invalid("Add 1 to 50 other people's shares."));
            }
            let mut sum = mine;
            let mut seen = HashSet::new();
            for share in shares {
                let person = text(share, "person")?.trim();
                if person.is_empty() || person.len() > 100 || !seen.insert(person.to_lowercase()) {
                    return Err(ApiError::invalid(
                        "Each person must have a unique name of at most 100 characters.",
                    ));
                }
                sum = add(sum, positive(share, "amount", currency)?)?;
            }
            if sum != total {
                return Err(ApiError::invalid(
                    "Your share and other shares must equal the purchase total.",
                ));
            }
            if paid_by != "me" && (!seen.contains(&paid_by.to_lowercase()) || mine == 0) {
                return Err(ApiError::invalid(
                    "The payer must have a share, and your share must be positive.",
                ));
            }
            let split_id = storage::id();
            let mut result = vec![];
            let obligations: Vec<Value> = if paid_by == "me" {
                shares.to_vec()
            } else {
                vec![json!({"person":paid_by,"amount":body["my_share"]})]
            };
            for share in &obligations {
                let v = json!({"person":text(share,"person")?.trim(),"direction":if paid_by=="me"{"owed_to_me"}else{"i_owe"},"amount":share["amount"],"currency":currency,"date":body["date"],"description":body["description"],"kind":"split","split_id":split_id,"split_total":body["total"],"my_share":body["my_share"],"paid_by":paid_by,"shares":shares,"transaction_id":body.get("transaction_id").cloned().unwrap_or(Value::Null),"repayments":[]});
                let mut saved = storage::create(db, p, "settlement_obligations", v).await?;
                decorate_obligation(&mut saved)?;
                result.push(saved);
            }
            Ok((
                StatusCode::CREATED,
                json!({"split_id":split_id,"obligations":result}),
            ))
        }
        ("GET", ["settle-ups", id]) => {
            api::allowed_query(q, &[])?;
            let mut v = storage::get(db, p, "settlement_obligations", id).await?;
            active(&v)?;
            decorate_obligation(&mut v)?;
            ok(v)
        }
        ("DELETE", ["settle-ups", id]) => {
            api::allowed_body(body, &[])?;
            let anchor = storage::get(db, p, "settlement_obligations", id).await?;
            owner(p, &anchor)?;
            active(&anchor)?;
            api::revision(headers, body, &anchor)?;
            let group = anchor["split_id"].as_str();
            let candidates = if group.is_some() {
                storage::list(db, p, "settlement_obligations").await?
            } else {
                vec![anchor.clone()]
            };
            for before in candidates {
                if before["deleted"] == true || group.is_some_and(|key| before["split_id"] != key) {
                    continue;
                }
                let mut after = before.clone();
                after["deleted"] = json!(true);
                after["deleted_at"] = json!(storage::now());
                storage::update(db, p, &before, after, "delete").await?;
            }
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        ("PATCH", ["settle-ups", id]) => {
            api::allowed_body(body, &["person", "amount", "date", "description"])?;
            let before = storage::get(db, p, "settlement_obligations", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            for key in ["person", "amount", "date", "description"] {
                if let Some(v) = body.get(key) {
                    after[key] = v.clone();
                }
            }
            let person = text(&after, "person")?.trim();
            if person.is_empty() || person.len() > 100 || text(&after, "description")?.len() > 500 {
                return Err(ApiError::invalid("Name or description is too long."));
            }
            after["person"] = json!(person);
            let date = domain::date(text(&after, "date")?)?;
            for payment in after["repayments"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Invalid repayments."))?
            {
                if domain::date(text(payment, "date")?)? < date {
                    return Err(ApiError::invalid("Obligation date follows a repayment."));
                }
            }
            if before["kind"] == "split" && after["amount"] != before["amount"] {
                return Err(ApiError::invalid(
                    "Split shares cannot be changed individually.",
                ));
            }
            decorate_obligation(&mut after)?;
            let mut saved = storage::update(db, p, &before, after, "update").await?;
            decorate_obligation(&mut saved)?;
            ok(saved)
        }
        ("POST", ["settle-ups", id, "repayments"]) => {
            api::allowed_body(body, &["amount", "date", "note"])?;
            let before = storage::get(db, p, "settlement_obligations", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let payment_date = domain::date(text(body, "date")?)?;
            if payment_date < domain::date(text(&before, "date")?)? {
                return Err(ApiError::invalid("Repayment date precedes the obligation."));
            }
            if body["note"].as_str().is_some_and(|s| s.len() > 500) {
                return Err(ApiError::invalid("Note is too long."));
            }
            let currency = text(&before, "currency")?;
            let amount = positive(body, "amount", currency)?;
            let mut after = before.clone();
            decorate_obligation(&mut after)?;
            if amount > money(text(&after, "remaining")?, currency)? {
                return Err(ApiError::invalid("Repayment exceeds the remaining amount."));
            }
            after["repayments"].as_array_mut().unwrap().push(json!({"id":storage::id(),"amount":body["amount"],"date":body["date"],"note":body.get("note").cloned().unwrap_or(Value::Null)}));
            let mut saved = storage::update(db, p, &before, after, "repayment").await?;
            decorate_obligation(&mut saved)?;
            ok(saved)
        }
        ("DELETE", ["settle-ups", id, "repayments", payment_id]) => {
            api::allowed_body(body, &[])?;
            let before = storage::get(db, p, "settlement_obligations", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            let repayments = after["repayments"]
                .as_array_mut()
                .ok_or_else(|| ApiError::invalid("Invalid repayments."))?;
            let original = repayments.len();
            repayments.retain(|v| v["id"] != *payment_id);
            if repayments.len() == original {
                return Err(ApiError::missing());
            }
            storage::update(db, p, &before, after, "repayment_removed").await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        ("GET", ["investments", "goals"]) => {
            api::allowed_query(q, &["month"])?;
            let cutoff = goal_cutoff(db,p,q.get("month").map(String::as_str)).await?;
            let mut goals = storage::list(db,p,"investment_goals").await?;
            goals.retain(|goal| goal["archived"] != true || goal["archived_at"].as_str().is_some_and(|date| q.get("month").is_some_and(|month| date.get(..7).is_some_and(|archived| month.as_str() < archived))));
            for goal in &mut goals { decorate_goal(db,p,goal,cutoff).await?; }
            goals.sort_by(|a,b| a["name"].as_str().cmp(&b["name"].as_str()));
            ok(json!({"data":goals,"page":{},"meta":{}}))
        }
        ("POST", ["investments", "goals"]) => {
            api::allowed_body(body, &["name","kind","currency","target_amount","target_months","essential_monthly","beneficiary","visibility","allocations","notes"])?;
            let mut goal = body.clone();
            if goal.get("visibility").is_none() { goal["visibility"] = json!("private"); }
            if goal.get("allocations").is_none() { goal["allocations"] = json!([]); }
            validate_goal(db,p,&goal,None).await?;
            let mut saved = storage::create(db,p,"investment_goals",goal).await?;
            decorate_goal(db,p,&mut saved,Utc::now()).await?;
            Ok((StatusCode::CREATED,saved))
        }
        ("GET", ["investments", "goals", id]) => {
            api::allowed_query(q,&["month"])?;
            let mut goal = storage::get(db,p,"investment_goals",id).await?;
            let cutoff = goal_cutoff(db,p,q.get("month").map(String::as_str)).await?;
            decorate_goal(db,p,&mut goal,cutoff).await?;
            ok(goal)
        }
        ("PATCH", ["investments", "goals", id]) => {
            api::allowed_body(body, &["name","target_amount","target_months","essential_monthly","beneficiary","visibility","allocations","notes"])?;
            let before = storage::get(db,p,"investment_goals",id).await?;
            owner(p,&before)?;
            if before["archived"] == true { return Err(ApiError::missing()); }
            api::revision(headers,body,&before)?;
            let mut after = before.clone();
            for key in ["name","target_amount","target_months","essential_monthly","beneficiary","visibility","allocations","notes"] {
                if let Some(value) = body.get(key) { after[key] = value.clone(); }
            }
            validate_goal(db,p,&after,Some(id)).await?;
            let mut saved = storage::update(db,p,&before,after,"investment_goal_updated").await?;
            decorate_goal(db,p,&mut saved,Utc::now()).await?;
            ok(saved)
        }
        ("POST", ["investments", "goals", id, "archive"]) => {
            api::allowed_body(body,&[])?;
            let before = storage::get(db,p,"investment_goals",id).await?;
            owner(p,&before)?;
            if before["archived"] == true { return Err(ApiError::missing()); }
            api::revision(headers,body,&before)?;
            let mut after = before.clone();
            after["archived"] = json!(true);
            after["archived_at"] = json!(storage::now());
            let mut saved = storage::update(db,p,&before,after,"investment_goal_archived").await?;
            decorate_goal(db,p,&mut saved,Utc::now()).await?;
            ok(saved)
        }
        ("POST", ["investments", "valuations", "bulk"]) => {
            api::allowed_body(body, &["items"])?;
            let items = body["items"].as_array().ok_or_else(|| ApiError::invalid("Valuations must be an array."))?;
            if items.is_empty() || items.len() > 100 { return Err(ApiError::invalid("Choose 1 to 100 valuations.")); }
            let household_document: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
                .bind(&p.household_id).fetch_one(&mut *db).await?;
            let household: Value = serde_json::from_str(&household_document).map_err(|_| ApiError::invalid("Invalid household settings."))?;
            let tz: chrono_tz::Tz = household["timezone"].as_str().unwrap_or("UTC").parse().map_err(|_| ApiError::invalid("Invalid household timezone."))?;
            let today = Utc::now().with_timezone(&tz).date_naive();
            let mut seen = HashSet::new();
            let mut saved = Vec::with_capacity(items.len());
            for item in items {
                api::allowed_body(item, &["holding_id", "revision", "value", "price", "valuation_date", "source", "note", "confirm_zero"])?;
                let id = text(item, "holding_id")?;
                if !seen.insert(id.to_owned()) { return Err(ApiError::invalid("A holding can be valued only once per batch.")); }
                let before = storage::get(db, p, "investments", id).await?;
                owner(p, &before)?;
                active(&before)?;
                if item["revision"].as_i64() != before["revision"].as_i64() { return Err(ApiError::conflict("A holding changed. Reload values and try again.")); }
                let as_of = text(item, "valuation_date")?;
                let record_month = &as_of[..7.min(as_of.len())];
                month(record_month)?;
                let currency = text(&before, "currency")?;
                let mut after = before.clone();
                let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
                let record = if let Some(record) = records.iter_mut().find(|r| r["month"] == record_month) { record } else {
                    records.push(json!({"month":record_month,"contribution":"0","withdrawal":"0","value":Value::Null}));
                    records.last_mut().unwrap()
                };
                if item.get("value").is_some() == item.get("price").is_some() { return Err(ApiError::invalid("Enter either total value or unit price.")); }
                let mut valuation = item.clone();
                if let Some(price) = item.get("price") {
                    let calculated = unit_price_value(&before,as_of,price.as_str().ok_or_else(|| ApiError::invalid("Unit price must be a decimal string."))?,currency)?;
                    valuation["value"] = json!(format_money(calculated,currency)?);
                    valuation["unit_price"] = price.clone();
                }
                set_valuation(record, &valuation, currency, record_month, today)?;
                let mut check = after.clone();
                decorate_investment(&mut check)?;
                let mut updated = storage::update(db, p, &before, after, "investment_valuation_updated").await?;
                decorate_investment(&mut updated)?;
                saved.push(updated);
            }
            ok(json!({"data":saved}))
        }
        ("GET", ["investments", "report"]) => {
            api::allowed_query(q, &["month", "currency", "scope"])?;
            let selected_month = q.get("month").ok_or_else(|| ApiError::invalid("month is required."))?;
            let (from, to) = api::month_bounds(selected_month)?;
            let currency = q.get("currency").ok_or_else(|| ApiError::invalid("currency is required."))?;
            domain::exponent(currency)?;
            let scope = q.get("scope").map(String::as_str).unwrap_or("combined");
            if !["personal", "family", "combined"].contains(&scope) { return Err(ApiError::invalid("Invalid investment scope.")); }
            let household_document: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
                .bind(&p.household_id).fetch_one(&mut *db).await?;
            let household: Value = serde_json::from_str(&household_document).map_err(|_| ApiError::invalid("Invalid household settings."))?;
            let tz: chrono_tz::Tz = household["timezone"].as_str().unwrap_or("UTC").parse().map_err(|_| ApiError::invalid("Invalid household timezone."))?;
            let next = domain::date(&to)?;
            let local_end = tz.from_local_datetime(&next.and_hms_opt(0, 0, 0).unwrap()).earliest().ok_or_else(|| ApiError::invalid("Invalid report cutoff."))?;
            let cutoff = std::cmp::min(local_end.with_timezone(&Utc) - chrono::Duration::nanoseconds(1), Utc::now());
            let accounts = storage::list(db, p, "accounts").await?;
            let account_types: HashMap<String, String> = accounts.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(),a["subtype"].as_str()?.to_owned()))).collect();
            let account_owners: HashMap<String, String> = accounts.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(),a["owner_id"].as_str()?.to_owned()))).collect();
            let scoped_cash_ids: HashSet<String> = accounts.iter().filter(|a| a["subtype"] == "investment_cash" && match scope { "personal" => a["owner_id"] == p.user_id, "family" => a["visibility"] == "shared", _ => a["owner_id"] == p.user_id || a["visibility"] == "shared" }).filter_map(|a| a["id"].as_str().map(str::to_owned)).collect();
            let holdings = storage::list(db, p, "investments").await?;
            let holdings: Vec<_> = holdings.into_iter().filter(|h| h["deleted"] != true && (h["archived"] != true || h["archived_at"].as_str().is_some_and(|date| date.get(..7).is_some_and(|m| m > selected_month.as_str())))).filter(|h| match scope { "family" => h["visibility"] == "shared", "combined" => h["owner_id"] == p.user_id || h["visibility"] == "shared", _ => true }).collect();
            let visible_ids: HashSet<_> = holdings.iter().filter_map(|h| h["id"].as_str()).collect();
            // Index evidence once. Ordinary expenses should not rescan every
            // month and trade in every holding merely to discover no link.
            let mut linked_holdings: HashMap<&str, Vec<usize>> = HashMap::new();
            for (index, holding) in holdings.iter().enumerate() {
                let mut ids = HashSet::new();
                for record in holding["records"].as_array().into_iter().flatten() {
                    ids.extend(record["linked_transaction_ids"].as_array().into_iter().flatten().filter_map(Value::as_str));
                }
                for event in holding["events"].as_array().into_iter().flatten().filter(|event| event["reversed"] != true) {
                    ids.extend(event["funding_allocations"].as_array().into_iter().flatten().filter_map(|link| link["transaction_id"].as_str()));
                }
                for id in ids { linked_holdings.entry(id).or_default().push(index); }
            }
            let categories = storage::list(db, p, "categories").await?;
            let investment_categories: HashSet<_> = categories.iter().filter(|c| c["tracking_type"] == "investment").filter_map(|c| c["id"].as_str()).collect();
            let mut contributed = 0;
            let mut withdrawn = 0;
            let mut attributed_contributed = 0;
            let mut attributed_withdrawn = 0;
            let mut pending = 0;
            for transaction in storage::transactions_in_period(db, p, &from, &to, false).await? {
                if transaction["voided"] == true || transaction["currency"] != *currency || domain::date(text(&transaction, "effective_date")?)? > cutoff.with_timezone(&tz).date_naive() { continue; }
                let transaction_amount = positive(&transaction, "amount", currency)?;
                let movement_account = transaction["movements"][0]["account_id"].as_str().and_then(|id| account_types.get(id)).map(String::as_str);
                let payer = transaction["paid_by_user_id"].as_str().or_else(|| transaction["movements"][0]["account_id"].as_str().and_then(|id| account_owners.get(id).map(String::as_str)));
                match transaction["event_type"].as_str().unwrap_or("") {
                    "investment" | "investment_withdrawal" if transaction["investment_id"].as_str().is_some_and(|id| visible_ids.contains(id)) && movement_account != Some("investment_cash") => {
                        let holding = holdings.iter().find(|h| h["id"] == transaction["investment_id"]).unwrap();
                        let share = if scope == "personal" { ownership_basis(holding, text(&transaction, "effective_date")?, &p.user_id)? } else { 10000 };
                        let attributed = prorate(transaction_amount, share)?;
                        let paid = if scope != "personal" || payer == Some(p.user_id.as_str()) { transaction_amount } else { 0 };
                        if transaction["event_type"] == "investment" { contributed = add(contributed, paid)?; attributed_contributed = add(attributed_contributed, attributed)?; }
                        else { withdrawn = add(withdrawn, paid)?; attributed_withdrawn = add(attributed_withdrawn, attributed)?; }
                    }
                    "transfer" => {
                        let movements = transaction["movements"].as_array().ok_or_else(|| ApiError::invalid("Invalid transfer."))?;
                        let cash = movements.iter().find(|m| m["account_id"].as_str().is_some_and(|id| scoped_cash_ids.contains(id)));
                        let outside = movements.iter().find(|m| m["account_id"].as_str().and_then(|id| account_types.get(id)).is_some_and(|kind| kind != "investment_cash"));
                        if let (Some(cash), Some(outside)) = (cash, outside) {
                            let outside_owner = outside["account_id"].as_str().and_then(|id| account_owners.get(id).map(String::as_str));
                            let paid = if scope != "personal" || outside_owner == Some(p.user_id.as_str()) { transaction_amount } else { 0 };
                            if text(cash, "amount")?.starts_with('-') { withdrawn = add(withdrawn, paid)?; attributed_withdrawn = add(attributed_withdrawn, paid)?; }
                            else { contributed = add(contributed, paid)?; attributed_contributed = add(attributed_contributed, paid)?; }
                        }
                    }
                    "expense" | "refund" => {
                        let transaction_id = text(&transaction, "id")?;
                        let mut allocated = 0;
                        let mut linked_full = 0;
                        for index in linked_holdings.get(transaction_id).into_iter().flatten() {
                            let holding = &holdings[*index];
                            let full = visible_linked_amount(std::slice::from_ref(holding), transaction_id, currency, transaction_amount)?;
                            linked_full = add(linked_full, full)?;
                            let share = if scope == "personal" { ownership_basis(holding, text(&transaction, "effective_date")?, &p.user_id)? } else { 10000 };
                            allocated = add(allocated, prorate(full, share)?)?;
                        }
                        if linked_full > transaction_amount { return Err(ApiError::invalid("Investment allocations exceed a transaction.")); }
                        let paid = if scope != "personal" || payer == Some(p.user_id.as_str()) { linked_full } else { 0 };
                        if transaction["event_type"] == "expense" { contributed = add(contributed, paid)?; attributed_contributed = add(attributed_contributed, allocated)?; }
                        else { withdrawn = add(withdrawn, paid)?; attributed_withdrawn = add(attributed_withdrawn, allocated)?; }
                        if transaction["allocations"].as_array().is_some_and(|lines| !lines.is_empty() && lines.iter().all(|line| line["category_id"].as_str().is_some_and(|id| investment_categories.contains(id)))) {
                            if scope != "personal" || payer == Some(p.user_id.as_str()) { pending = add(pending, transaction_amount - linked_full)?; }
                        }
                    }
                    _ => {}
                }
            }
            let mut cash_accounts = vec![];
            let mut cash_total = 0;
            let mut cash_known = 0;
            for account in accounts.into_iter().filter(|a| a["subtype"] == "investment_cash" && a["currency"] == *currency && a["active"] != false && a["id"].as_str().is_some_and(|id| scoped_cash_ids.contains(id))) {
                let balance = balances::derived(db, p, &account, cutoff).await?;
                if let Some(value) = balance["amount"].as_str() { cash_total = add(cash_total, money(value, currency)?)?; cash_known += 1; }
                cash_accounts.push(json!({"id":account["id"],"name":account["name"],"balance":balance["amount"],"as_of":balance["as_of"]}));
            }
            ok(json!({"month":selected_month,"currency":currency,"scope":scope,"cutoff":cutoff.to_rfc3339(),"contributed":format_money(contributed,currency)?,"withdrawn":format_money(withdrawn,currency)?,"net":format_money(contributed.checked_sub(withdrawn).ok_or_else(|| ApiError::invalid("Net contribution is out of range."))?,currency)?,"attributed_contributed":format_money(attributed_contributed,currency)?,"attributed_withdrawn":format_money(attributed_withdrawn,currency)?,"pending_funding":format_money(pending,currency)?,"cash_accounts":cash_accounts,"cash_total":format_money(cash_total,currency)?,"cash_coverage":cash_known,"limited_household_coverage":scope != "personal"}))
        }
        ("GET", ["investments"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            let mut items = storage::list(db, p, "investments").await?;
            items.retain(|v| v["deleted"] != true);
            // Cursor validation uses canonical documents; compute FIFO/returns
            // only for the requested page rather than every holding per page.
            let mut response = api::paginate(items, q)?;
            for item in response["data"].as_array_mut().unwrap() {
                decorate_investment(item)?;
            }
            ok(response)
        }
        ("POST", ["investments"]) => {
            api::allowed_body(
                body,
                &[
                    "name",
                    "type",
                    "asset_class",
                    "instrument",
                    "identifier",
                    "platform",
                    "folio",
                    "ownership",
                    "currency",
                    "target",
                    "monthly_goal",
                    "notes",
                    "visibility",
                    "sip",
                    "tracking_mode",
                    "initial_record",
                    "opening_value",
                    "opening_month",
                ],
            )?;
            domain::choice(body, "type", &["investment", "emergency_fund"])?;
            if body.get("tracking_mode").is_some() { domain::choice(body,"tracking_mode", &["baseline","full_history"])?; }
            if body["tracking_mode"] == "full_history" && body["type"] != "investment" { return Err(ApiError::invalid("Full-history mode is available for investment holdings only.")); }
            if body["tracking_mode"] == "full_history" && (body.get("opening_value").is_some() || body.get("initial_record").is_some()) {
                return Err(ApiError::invalid("Full-history holdings start from dated events, not an opening baseline or initial record."));
            }
            if body.get("asset_class").is_some() {
                domain::choice(body, "asset_class", &["mutual_fund", "stock_market", "etf", "deposit", "retirement", "investment_cash", "manual_asset"])?;
                if body["type"] != "investment" { return Err(ApiError::invalid("Asset class is available for investments only.")); }
            }
            if body.get("visibility").is_some() {
                domain::choice(body, "visibility", &["private", "shared"])?;
            }
            if let Some(shares) = body.get("ownership") {
                validate_ownership(db, p, shares, body["visibility"].as_str().unwrap_or("private")).await?;
            }
            let name = text(body, "name")?;
            if name.len() > 100 {
                return Err(ApiError::invalid("Name is too long."));
            }
            for key in ["instrument", "identifier", "platform", "folio"] {
                if body.get(key).is_some() && (body[key].as_str().is_none() || body[key].as_str().is_some_and(|s| s.len() > 120)) {
                    return Err(ApiError::invalid(format!("Invalid {key}.")));
                }
            }
            let currency = text(body, "currency")?;
            domain::exponent(currency)?;
            if body.get("target").is_some() {
                nonnegative(body, "target", currency)?;
            }
            if body.get("monthly_goal").is_some() {
                nonnegative(body, "monthly_goal", currency)?;
            }
            if let Some(sip) = body.get("sip") {
                if body["type"] != "investment" {
                    return Err(ApiError::invalid("SIPs are available for investments only."));
                }
                if body["tracking_mode"] == "full_history" { return Err(ApiError::invalid("Link full-history purchases to SIPs after recording the trades.")); }
                validate_sip(sip, currency)?;
            }
            if body.get("opening_value").is_some() != body.get("opening_month").is_some() {
                return Err(ApiError::invalid("Opening value and month must be supplied together."));
            }
            if body.get("opening_value").is_some() {
                nonnegative(body, "opening_value", currency)?;
                month(text(body, "opening_month")?)?;
            }
            let initial_record = if let Some(record) = body.get("initial_record") {
                let fields = record.as_object().ok_or_else(|| ApiError::invalid("Initial valuation must be an object."))?;
                if fields.keys().any(|key| !["month", "principal", "current_value", "account_id", "transaction_date"].contains(&key.as_str())) {
                    return Err(ApiError::invalid("Unknown initial valuation field."));
                }
                let record_month = text(record, "month")?;
                month(record_month)?;
                positive(record, "principal", currency)?;
                if !record["current_value"].is_null() { nonnegative(record, "current_value", currency)?; }
                if record.get("account_id").is_some() { text(record, "account_id")?; }
                let mut first = json!({"month":record_month,"contribution":record["principal"],"withdrawal":"0","value":record.get("current_value").cloned().unwrap_or(Value::Null)});
                if let Some(account) = record.get("account_id") {
                    first["account_id"] = account.clone();
                    first["transaction_date"] = json!(text(record, "transaction_date")?);
                }
                Some(first)
            } else {
                None
            };
            let mut v = body.clone();
            v.as_object_mut().ok_or_else(|| ApiError::invalid("Investment must be an object."))?.remove("initial_record");
            if v.get("visibility").is_none() {
                v["visibility"] = json!("private");
            }
            let initial_shares = body.get("ownership").cloned().unwrap_or_else(|| json!([{"user_id":p.user_id,"percent":"100.00"}]));
            v.as_object_mut().unwrap().remove("ownership");
            v["ownership_history"] = json!([{"effective_date":"1900-01-01","shares":initial_shares}]);
            if !v["sip"].is_null() { v["sip_history"] = json!([{"effective_month":v["sip"]["start_month"],"sip":v["sip"]}]); }
            if v["type"] == "investment" && v.get("asset_class").is_none() { v["asset_class"] = json!("mutual_fund"); }
            if v.get("tracking_mode").is_none() { v["tracking_mode"] = json!("baseline"); }
            if v["tracking_mode"] == "full_history" { v["events"] = json!([]); }
            v["records"] = json!(initial_record.into_iter().collect::<Vec<_>>());
            let mut check = v.clone();
            decorate_investment(&mut check)?;
            let mut v = storage::create(db, p, "investments", v).await?;
            if v["records"][0]["account_id"].is_string() {
                let before = v.clone();
                let mut record = v["records"][0].clone();
                post_investment_movements(db, p, &v, &mut record).await?;
                v["records"][0] = record;
                v = storage::update(db, p, &before, v, "initial_investment_movement").await?;
            }
            decorate_investment(&mut v)?;
            Ok((StatusCode::CREATED, v))
        }
        ("GET", ["investments", id]) => {
            api::allowed_query(q, &["month"])?;
            let mut v = storage::get(db, p, "investments", id).await?;
            if v["deleted"] == true { return Err(ApiError::missing()); }
            if let Some(selected_month) = q.get("month") { decorate_investment_as_of(&mut v,selected_month)?; }
            else { decorate_investment(&mut v)?; }
            ok(v)
        }
        ("POST", ["investments", id, "events", "import-preview"]) => {
            let holding = storage::get(db,p,"investments",id).await?;
            owner(p,&holding)?;
            active(&holding)?;
            if holding["tracking_mode"] != "full_history" { return Err(ApiError::invalid("CSV activity import requires a full-history holding.")); }
            ok(investment_import_preview(body,&holding)?)
        }
        ("POST", ["investments", id, "events", "import-commit"]) => {
            let before = storage::get(db,p,"investments",id).await?;
            owner(p,&before)?;
            active(&before)?;
            if before["tracking_mode"] != "full_history" { return Err(ApiError::invalid("CSV activity import requires a full-history holding.")); }
            api::revision(headers,body,&before)?;
            let preview = investment_import_preview(body,&before)?;
            if body["preview_hash"] != preview["preview_hash"] { return Err(ApiError::conflict("Import preview changed. Preview the CSV again.")); }
            let selected = body["selected_rows"].as_array().ok_or_else(|| ApiError::invalid("Select the CSV rows to import."))?;
            if selected.is_empty() { return Err(ApiError::invalid("Select at least one CSV row.")); }
            let confirmed: HashSet<usize> = body["confirmed_duplicate_rows"].as_array().into_iter().flatten().map(|item| item.as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| ApiError::invalid("Confirmed duplicate row indices must be integers."))).collect::<Result<_>>()?;
            let mut indexes = HashSet::new();
            for item in selected {
                let index = item.as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| ApiError::invalid("Selected row indices must be integers."))?;
                if !indexes.insert(index) { return Err(ApiError::invalid("A CSV row was selected twice.")); }
                if preview["rows"][index]["status"] != "ready" && !(preview["rows"][index]["status"] == "possible_duplicate" && confirmed.contains(&index)) { return Err(ApiError::conflict("A selected CSV row needs review or already exists.")); }
            }
            if !confirmed.is_subset(&indexes) { return Err(ApiError::invalid("Confirm only selected possible duplicate rows.")); }
            let rows = investment_import_rows(body,text(&before,"currency")?)?;
            let mut after = before.clone();
            let mut selected_indexes: Vec<_> = indexes.iter().copied().collect();
            selected_indexes.sort_unstable();
            for index in selected_indexes {
                let mut event = rows.get(index).ok_or_else(|| ApiError::invalid("Selected CSV row is out of range."))?.clone();
                event.as_object_mut().unwrap().remove("row_number");
                event["sequence"] = json!(after["events"].as_array().ok_or_else(|| ApiError::invalid("Invalid investment events."))?.len());
                event["id"] = json!(storage::id());
                event["created_at"] = json!(storage::now());
                event["created_by"] = json!(p.user_id);
                event["imported_at"] = json!(storage::now());
                let event_month = &text(&event,"trade_date")?[..7];
                if !after["records"].as_array().ok_or_else(|| ApiError::invalid("Invalid investment records."))?.iter().any(|record| record["month"] == event_month) {
                    after["records"].as_array_mut().unwrap().push(json!({"month":event_month,"contribution":"0","withdrawal":"0","value":Value::Null}));
                }
                after["events"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment events."))?.push(event);
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db,p,&before,after,"investment_events_imported").await?;
            decorate_investment(&mut saved)?;
            ok(json!({"id":id,"imported":indexes.len(),"holding":saved}))
        }
        ("POST", ["investments", id, "events"]) => {
            api::allowed_body(body,&["type","trade_date","amount","units","charges","note","source_id","account_id"])?;
            let before = storage::get(db,p,"investments",id).await?;
            owner(p,&before)?;
            active(&before)?;
            api::revision(headers,body,&before)?;
            if before["tracking_mode"] != "full_history" { return Err(ApiError::invalid("Add full-history events only to a full-history holding.")); }
            domain::choice(body,"type", &["purchase","sale","distribution","fee"])?;
            let date = text(body,"trade_date")?;
            let trade_date = domain::date(date)?;
            if trade_date > Utc::now().date_naive() { return Err(ApiError::invalid("Event date cannot be in the future.")); }
            let currency = text(&before,"currency")?;
            positive(body,"amount",currency)?;
            if ["purchase","sale"].contains(&text(body,"type")?) {
                quantity(body,"units")?;
                if body.get("charges").is_some() { nonnegative(body,"charges",currency)?; }
            } else if body.get("units").is_some() || body.get("charges").is_some() {
                return Err(ApiError::invalid("Units and charges apply only to purchases and sales."));
            }
            if body.get("account_id").is_some() && !["purchase","sale"].contains(&text(body,"type")?) { return Err(ApiError::invalid("Choose an account only for a purchase or sale.")); }
            if body["note"].as_str().is_some_and(|note| note.len() > 200) { return Err(ApiError::invalid("Event note is too long.")); }
            if body["source_id"].as_str().is_some_and(|source| source.len() > 120) { return Err(ApiError::invalid("Source ID is too long.")); }
            if let Some(source) = body["source_id"].as_str() {
                if before["events"].as_array().into_iter().flatten().any(|event| event["source_id"] == source && event["reversed"] != true) { return Err(ApiError::conflict("An event with this source ID already exists.")); }
            }
            let mut after = before.clone();
            let mut event = body.clone();
            event["sequence"] = json!(after["events"].as_array().ok_or_else(|| ApiError::invalid("Invalid investment events."))?.len());
            event["id"] = json!(storage::id());
            event["created_at"] = json!(storage::now());
            event["created_by"] = json!(p.user_id);
            if let Some(account_id) = body["account_id"].as_str() {
                let account = storage::get(db,p,"accounts",account_id).await?;
                if account["active"] == false || account["currency"] != before["currency"] || account["subtype"] == "settle_up" { return Err(ApiError::invalid("Choose an active funding account in the holding currency.")); }
                let kind = text(body,"type")?;
                let amount = positive(body,"amount",currency)?;
                let charges = body.get("charges").map(|_| nonnegative(body,"charges",currency)).transpose()?.unwrap_or(0);
                let cash = if kind == "purchase" { add(amount,charges)? } else { amount.checked_sub(charges).ok_or_else(|| ApiError::invalid("Sale charges exceed proceeds."))? };
                if cash <= 0 { return Err(ApiError::invalid("Net sale proceeds must be positive.")); }
                let signed = format_money(if kind == "purchase" {-cash} else {cash},currency)?;
                let transaction = json!({"event_type":if kind == "purchase" {"investment"} else {"investment_withdrawal"},"investment_id":before["id"],"investment_event_id":event["id"],"amount":format_money(cash,currency)?,"currency":currency,"effective_date":date,"description":format!("{} {}",if kind == "purchase" {"Bought"} else {"Sold"},text(&before,"name")?),"movements":[{"account_id":account_id,"amount":signed}],"allocations":[],"entered_by":p.user_id,"voided":false,"source_refs":[],"reconciliation_state":"unmatched"});
                api::validate_ledger(db,p,&transaction).await?;
                let posted = storage::create(db,p,"transactions",transaction).await?;
                event["transaction_id"] = posted["id"].clone();
            }
            after["events"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment events."))?.push(event);
            let event_month = &date[..7];
            let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            if !records.iter().any(|record| record["month"] == event_month) {
                records.push(json!({"month":event_month,"contribution":"0","withdrawal":"0","value":Value::Null}));
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db,p,&before,after,"investment_event_added").await?;
            decorate_investment(&mut saved)?;
            Ok((StatusCode::CREATED,saved))
        }
        ("POST", ["investments", id, "events", event_id, "reverse"]) => {
            api::allowed_body(body,&["reason"])?;
            let reason = text(body,"reason")?;
            if reason.trim().is_empty() || reason.len() > 200 { return Err(ApiError::invalid("Give a reason for reversing the event.")); }
            let before = storage::get(db,p,"investments",id).await?;
            owner(p,&before)?;
            active(&before)?;
            api::revision(headers,body,&before)?;
            let mut after = before.clone();
            let event = after["events"].as_array_mut().into_iter().flatten().find(|event| event["id"] == *event_id).ok_or_else(ApiError::missing)?;
            if event["reversed"] == true { return Err(ApiError::conflict("This investment event is already reversed.")); }
            if event["funding_allocations"].as_array().is_some_and(|links| !links.is_empty()) { return Err(ApiError::conflict("Unlink the event's funding evidence before reversing it.")); }
            if let Some(transaction_id) = event["transaction_id"].as_str() { retire_investment_movements(db,p,&json!({"transaction_ids":[transaction_id]})).await?; }
            event["reversed"] = json!(true);
            event["reversal_reason"] = json!(reason);
            event["reversed_at"] = json!(storage::now());
            event["reversed_by"] = json!(p.user_id);
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db,p,&before,after,"investment_event_reversed").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "events", event_id, "evidence"]) => {
            api::allowed_body(body,&["transaction_id","amount"])?;
            let before = storage::get(db,p,"investments",id).await?;
            owner(p,&before)?;
            active(&before)?;
            api::revision(headers,body,&before)?;
            if before["tracking_mode"] != "full_history" { return Err(ApiError::invalid("Evidence links require a full-history holding.")); }
            let original = before["events"].as_array().into_iter().flatten().find(|event| event["id"] == *event_id && event["reversed"] != true).ok_or_else(ApiError::missing)?;
            let kind = text(original,"type")?;
            if !["purchase","sale"].contains(&kind) { return Err(ApiError::invalid("Link funding evidence to a purchase or sale.")); }
            if original["transaction_id"].is_string() { return Err(ApiError::conflict("This event already posted an account movement. Reverse it before linking other funding evidence.")); }
            let transaction_id = text(body,"transaction_id")?;
            let transaction = storage::get(db,p,"transactions",transaction_id).await?;
            let expected = if kind == "purchase" { "expense" } else { "refund" };
            if transaction["voided"] == true || transaction["event_type"] != expected || transaction["currency"] != before["currency"] { return Err(ApiError::invalid("Choose an active investment-category debit or refund in the holding currency.")); }
            let allocations = transaction["allocations"].as_array().ok_or_else(|| ApiError::invalid("Invalid transaction allocations."))?;
            if allocations.is_empty() { return Err(ApiError::invalid("Categorize the ledger entry as an investment first.")); }
            for allocation in allocations {
                let category = storage::get(db,p,"categories",text(allocation,"category_id")?).await?;
                if category["tracking_type"] != "investment" { return Err(ApiError::invalid("Categorize the whole ledger entry as an investment first.")); }
            }
            let currency = text(&before,"currency")?;
            let full = positive(&transaction,"amount",currency)?;
            let amount = if body.get("amount").is_some() { positive(body,"amount",currency)? } else { full };
            let already = linked_amount(db,p,transaction_id,currency,full).await?;
            if amount > full.checked_sub(already).ok_or_else(|| ApiError::invalid("Funding allocations exceed the ledger entry."))? { return Err(ApiError::conflict("Funding allocations exceed the ledger entry.")); }
            let event_limit = positive(original,"amount",currency)?;
            let event_limit = if kind == "purchase" { add(event_limit,original.get("charges").map(|_| nonnegative(original,"charges",currency)).transpose()?.unwrap_or(0))? }
                else { event_limit.checked_sub(original.get("charges").map(|_| nonnegative(original,"charges",currency)).transpose()?.unwrap_or(0)).ok_or_else(|| ApiError::invalid("Sale charges exceed proceeds."))? };
            let used = original["funding_allocations"].as_array().into_iter().flatten().try_fold(0i64,|sum,link| add(sum,positive(link,"amount",currency)?))?;
            if amount > event_limit.checked_sub(used).ok_or_else(|| ApiError::invalid("Event funding exceeds its amount."))? { return Err(ApiError::conflict("Funding allocations exceed the economic event.")); }
            let mut after = before.clone();
            let event = after["events"].as_array_mut().into_iter().flatten().find(|event| event["id"] == *event_id).unwrap();
            if !event["funding_allocations"].is_array() { event["funding_allocations"] = json!([]); }
            if event["funding_allocations"].as_array().unwrap().iter().any(|link| link["transaction_id"] == transaction_id) { return Err(ApiError::conflict("This ledger entry is already linked to the event.")); }
            event["funding_allocations"].as_array_mut().unwrap().push(json!({"transaction_id":transaction_id,"amount":format_money(amount,currency)?,"linked_at":storage::now(),"linked_by":p.user_id}));
            let mut saved = storage::update(db,p,&before,after,"investment_event_evidence_linked").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("DELETE", ["investments", id, "events", event_id, "evidence", transaction_id]) => {
            api::allowed_body(body,&[])?;
            let before = storage::get(db,p,"investments",id).await?;
            owner(p,&before)?;
            active(&before)?;
            api::revision(headers,body,&before)?;
            let mut after = before.clone();
            let event = after["events"].as_array_mut().into_iter().flatten().find(|event| event["id"] == *event_id && event["reversed"] != true).ok_or_else(ApiError::missing)?;
            let links = event["funding_allocations"].as_array_mut().ok_or_else(ApiError::missing)?;
            let prior = links.len();
            links.retain(|link| link["transaction_id"] != *transaction_id);
            if links.len() == prior { return Err(ApiError::missing()); }
            let mut saved = storage::update(db,p,&before,after,"investment_event_evidence_unlinked").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "ownership-changes"]) => {
            api::allowed_body(body, &["effective_date", "shares"])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let date = text(body, "effective_date")?;
            domain::date(date)?;
            validate_ownership(db, p, &body["shares"], before["visibility"].as_str().unwrap_or("private")).await?;
            let mut after = before.clone();
            let history = after["ownership_history"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid ownership history."))?;
            if history.iter().any(|row| row["effective_date"] == date) { return Err(ApiError::conflict("An ownership change already exists on this date.")); }
            history.push(json!({"effective_date":date,"shares":body["shares"]}));
            history.sort_by(|a,b| a["effective_date"].as_str().cmp(&b["effective_date"].as_str()));
            let mut saved = storage::update(db, p, &before, after, "investment_ownership_changed").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "archive"]) => {
            api::allowed_body(body, &[])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            after["archived"] = json!(true);
            after["archived_at"] = json!(storage::now());
            let mut saved = storage::update(db, p, &before, after, "investment_archived").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("DELETE", ["investments", id]) => {
            api::allowed_body(body, &[])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            if before["opening_value"].is_string() || before["records"].as_array().is_some_and(|records| !records.is_empty()) {
                return Err(ApiError::conflict("Archive a holding with a baseline or activity so its history and links remain intact."));
            }
            let goals: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='investment_goals'")
                .bind(&p.household_id).fetch_all(&mut *db).await?;
            for document in goals {
                let goal: Value = serde_json::from_str(&document).map_err(|_| ApiError::invalid("Invalid stored goal."))?;
                if goal["archived"] != true && goal["allocations"].as_array().into_iter().flatten().any(|allocation| allocation["asset_kind"] == "holding" && allocation["asset_id"] == *id) {
                    return Err(ApiError::conflict("Remove this holding from active goals before deleting it, or archive the holding."));
                }
            }
            let mut after = before.clone();
            after["deleted"] = json!(true);
            after["deleted_at"] = json!(storage::now());
            storage::update(db, p, &before, after, "delete").await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        ("PATCH", ["investments", id]) => {
            api::allowed_body(
                body,
                &["name", "asset_class", "instrument", "identifier", "platform", "folio", "target", "monthly_goal", "notes", "visibility", "sip", "sip_effective_month", "opening_value", "opening_month"],
            )?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            if after.get("visibility").is_none() {
                after["visibility"] = json!("private");
            }
            for key in ["name", "asset_class", "instrument", "identifier", "platform", "folio", "target", "monthly_goal", "notes", "visibility", "sip", "opening_value", "opening_month"] {
                if let Some(v) = body.get(key) {
                    after[key] = v.clone();
                }
            }
            domain::choice(&after, "visibility", &["private", "shared"])?;
            if after["visibility"] == "private" && after["ownership_history"].as_array().and_then(|history| history.last()).and_then(|entry| entry["shares"].as_array()).is_some_and(|shares| shares.len() > 1) {
                return Err(ApiError::invalid("Joint holdings must remain shared with the household."));
            }
            if after.get("asset_class").is_some() {
                domain::choice(&after, "asset_class", &["mutual_fund", "stock_market", "etf", "deposit", "retirement", "investment_cash", "manual_asset"])?;
                if after["type"] != "investment" { return Err(ApiError::invalid("Asset class is available for investments only.")); }
            }
            if text(&after, "name")?.len() > 100 {
                return Err(ApiError::invalid("Name is too long."));
            }
            for key in ["instrument", "identifier", "platform", "folio"] {
                if after.get(key).is_some() && (after[key].as_str().is_none() || after[key].as_str().is_some_and(|s| s.len() > 120)) {
                    return Err(ApiError::invalid(format!("Invalid {key}.")));
                }
            }
            if after.get("target").is_some() {
                nonnegative(&after, "target", text(&after, "currency")?)?;
            }
            if after.get("monthly_goal").is_some() {
                nonnegative(&after, "monthly_goal", text(&after, "currency")?)?;
            }
            if !after["sip"].is_null() {
                if after["type"] != "investment" {
                    return Err(ApiError::invalid("SIPs are available for investments only."));
                }
                if after["tracking_mode"] == "full_history" { return Err(ApiError::invalid("A full-history holding cannot use the legacy SIP posting flow.")); }
                validate_sip(&after["sip"], text(&after, "currency")?)?;
            }
            if body.get("sip_effective_month").is_some() && body.get("sip").is_none() { return Err(ApiError::invalid("A SIP effective month requires a schedule change.")); }
            if body.get("sip").is_some() && after["sip"] != before["sip"] {
                let effective = body["sip_effective_month"].as_str().map(str::to_owned).unwrap_or_else(|| Utc::now().format("%Y-%m").to_string());
                month(&effective)?;
                if !after["sip"].is_null() && after["sip"]["start_month"].as_str().is_some_and(|start| effective.as_str() < start) {
                    return Err(ApiError::invalid("SIP change cannot take effect before its start month."));
                }
                if !after["sip_history"].is_array() {
                    after["sip_history"] = if before["sip"].is_null() { json!([]) } else { json!([{"effective_month":before["sip"]["start_month"],"sip":before["sip"]}]) };
                }
                let schedule = after["sip"].clone();
                let history = after["sip_history"].as_array_mut().unwrap();
                if history.last().and_then(|row| row["effective_month"].as_str()).is_some_and(|latest| effective.as_str() < latest) {
                    return Err(ApiError::conflict("SIP changes must have an effective month after prior changes."));
                }
                history.retain(|row| row["effective_month"] != effective);
                history.push(json!({"effective_month":effective,"sip":schedule}));
            }
            if after.get("opening_value").is_some() != after.get("opening_month").is_some() {
                return Err(ApiError::invalid("Opening value and month must be supplied together."));
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db, p, &before, after, "update").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "contributions"]) => {
            api::allowed_body(body, &["amount", "account_id", "transaction_date", "value"])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            if before["tracking_mode"] == "full_history" { return Err(ApiError::invalid("Record a dated purchase event for a full-history holding.")); }
            api::revision(headers, body, &before)?;
            let currency = text(&before, "currency")?;
            let addition = positive(body, "amount", currency)?;
            let account_id = text(body, "account_id")?;
            let account = storage::get(db, p, "accounts", account_id).await?;
            if account["active"] == false || account["currency"] != currency || account["subtype"] == "settle_up" {
                return Err(ApiError::invalid("Choose an active funding account in the investment currency."));
            }
            let date = text(body, "transaction_date")?;
            domain::date(date)?;
            if !body["value"].is_null() { nonnegative(body, "value", currency)?; }
            let record_month = &date[..7];
            let mut after = before.clone();
            let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let position = records.iter().position(|record| record["month"] == record_month);
            let old = position.map(|index| records[index].clone());
            let old_amount = old.as_ref().map(|record| nonnegative(record, "contribution", currency)).transpose()?.unwrap_or(0);
            let total = add(old_amount, addition)?;
            let signed = format_money(-addition, currency)?;
            let transaction = json!({"event_type":"investment","investment_id":before["id"],"investment_month":record_month,"amount":body["amount"],"currency":currency,"effective_date":date,"description":format!("Invested in {}",text(&before,"name")?),"movements":[{"account_id":account_id,"amount":signed}],"allocations":[],"entered_by":p.user_id,"voided":false,"source_refs":[],"reconciliation_state":"unmatched"});
            api::validate_ledger(db, p, &transaction).await?;
            let posted = storage::create(db, p, "transactions", transaction).await?;
            let mut record = old.unwrap_or_else(||json!({"month":record_month,"contribution":"0","withdrawal":"0","value":Value::Null}));
            record["contribution"] = json!(format_money(total,currency)?);
            if !body["value"].is_null() { record["value"] = body["value"].clone(); record["valuation_pending"] = json!(false); }
            else if record["value"].is_string() { record["valuation_pending"] = json!(true); }
            if record["account_id"].is_null() { record["account_id"] = json!(account_id); record["transaction_date"] = json!(date); }
            if !record["transaction_ids"].is_array() { record["transaction_ids"] = json!([]); }
            record["transaction_ids"].as_array_mut().unwrap().push(posted["id"].clone());
            if let Some(index) = position { records[index] = record; } else { records.push(record); }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db, p, &before, after, "investment_contribution").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "linked-transactions"]) => {
            api::allowed_body(body, &["transaction_id", "amount", "replace_movement_id", "value"])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            if before["tracking_mode"] == "full_history" { return Err(ApiError::invalid("Full-history funding must link to its economic event.")); }
            api::revision(headers, body, &before)?;
            let transaction_id = text(body, "transaction_id")?;
            let transaction = storage::get(db, p, "transactions", transaction_id).await?;
            if transaction["voided"] == true || !["expense", "refund"].contains(&text(&transaction, "event_type")?) || transaction["currency"] != before["currency"] {
                return Err(ApiError::invalid("Choose an active expense or refund in the holding currency."));
            }
            let allocations = transaction["allocations"].as_array().ok_or_else(|| ApiError::invalid("Invalid transaction allocations."))?;
            if allocations.is_empty() || allocations.iter().any(|allocation| allocation["category_id"].is_null()) {
                return Err(ApiError::invalid("Assign the whole transaction to investment categories first."));
            }
            for allocation in allocations {
                let category = storage::get(db, p, "categories", text(allocation, "category_id")?).await?;
                if category["tracking_type"] != "investment" {
                    return Err(ApiError::invalid("All allocations must use investment categories."));
                }
            }
            let currency = text(&before, "currency")?;
            let transaction_amount = positive(&transaction, "amount", currency)?;
            let amount = if body.get("amount").is_some() { positive(body, "amount", currency)? } else { transaction_amount };
            let allocated = linked_amount(db, p, transaction_id, currency, transaction_amount).await?;
            if amount > transaction_amount.checked_sub(allocated).ok_or_else(|| ApiError::invalid("Existing investment allocations exceed the transaction."))? {
                return Err(ApiError::conflict("Investment allocations exceed the transaction amount."));
            }
            let record_month = &text(&transaction, "effective_date")?[..7];
            if before["opening_month"].as_str().is_some_and(|opening| record_month < opening) {
                return Err(ApiError::invalid("Transaction predates the holding's starting value."));
            }
            let mut after = before.clone();
            let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let position = records.iter().position(|record| record["month"] == record_month);
            let mut record = position.map(|index| records[index].clone()).unwrap_or_else(|| json!({"month":record_month,"contribution":"0","withdrawal":"0","value":Value::Null}));
            if record["linked_transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(transaction_id))) {
                return Err(ApiError::conflict("This transaction is already linked to this holding."));
            }
            let field = if transaction["event_type"] == "expense" { "contribution" } else { "withdrawal" };
            let mut previous = 0;
            let mut replaced = None;
            if let Some(movement_id) = body["replace_movement_id"].as_str() {
                if !record["transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(movement_id))) {
                    return Err(ApiError::invalid("Choose a generated movement from this holding and month."));
                }
                let movement = storage::get(db, p, "transactions", movement_id).await?;
                let expected_kind = if field == "contribution" { "investment" } else { "investment_withdrawal" };
                if movement["voided"] == true || movement["investment_id"] != before["id"] || movement["event_type"] != expected_kind
                    || movement["currency"] != transaction["currency"] || movement["movements"][0]["account_id"] != transaction["movements"][0]["account_id"]
                    || positive(&movement, "amount", currency)? != amount {
                    return Err(ApiError::invalid("Replacement must have the same account, amount, direction, and month."));
                }
                previous = amount;
                record["transaction_ids"].as_array_mut().unwrap().retain(|value| value.as_str() != Some(movement_id));
                if record["transaction_ids"].as_array().is_some_and(Vec::is_empty) {
                    record.as_object_mut().unwrap().remove("account_id");
                    record.as_object_mut().unwrap().remove("transaction_date");
                }
                replaced = Some(movement);
            }
            let total = nonnegative(&record, field, currency)?.checked_sub(previous).and_then(|v| v.checked_add(amount)).ok_or_else(|| ApiError::invalid("Investment amount is out of range."))?;
            record[field] = json!(format_money(total, currency)?);
            if !record["linked_transaction_ids"].is_array() { record["linked_transaction_ids"] = json!([]); }
            record["linked_transaction_ids"].as_array_mut().unwrap().push(json!(transaction_id));
            if !record["linked_allocations"].is_array() { record["linked_allocations"] = json!([]); }
            record["linked_allocations"].as_array_mut().unwrap().push(json!({"transaction_id":transaction_id,"amount":format_money(amount,currency)?}));
            if !body["value"].is_null() { nonnegative(body, "value", currency)?; record["value"] = body["value"].clone(); record["valuation_pending"] = json!(false); }
            else if previous == 0 && record["value"].is_string() { record["valuation_pending"] = json!(true); }
            if let Some(index) = position { records[index] = record; } else { records.push(record); }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            if let Some(movement) = replaced {
                reconciliation::invalidate(db, p, text(&movement, "id")?).await?;
                let mut voided = movement.clone();
                voided["voided"] = json!(true);
                voided["void_reason"] = json!("Replaced by linked investment transaction");
                voided["reconciliation_state"] = json!("unmatched");
                storage::update(db, p, &movement, voided, "investment_movement_replaced").await?;
            }
            let mut saved = storage::update(db, p, &before, after, "investment_transaction_linked").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("DELETE", ["investments", id, "linked-transactions", transaction_id]) => {
            api::allowed_body(body, &["value"])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let transaction = storage::get(db, p, "transactions", transaction_id).await?;
            let currency = text(&before, "currency")?;
            let field = if transaction["event_type"] == "expense" { "contribution" } else { "withdrawal" };
            let amount = positive(&transaction, "amount", currency)?;
            let mut after = before.clone();
            let record = after["records"].as_array_mut().into_iter().flatten().find(|record| record["linked_transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(transaction_id)))).ok_or_else(ApiError::missing)?;
            let linked = record["linked_allocations"].as_array().and_then(|allocations| allocations.iter().find(|item| item["transaction_id"] == *transaction_id))
                .map(|item| positive(item, "amount", currency)).transpose()?.unwrap_or(amount);
            let total = nonnegative(record, field, currency)?.checked_sub(linked).ok_or_else(|| ApiError::invalid("Investment amount is out of range."))?;
            record[field] = json!(format_money(total, currency)?);
            record["linked_transaction_ids"].as_array_mut().unwrap().retain(|value| value.as_str() != Some(transaction_id));
            if let Some(allocations) = record["linked_allocations"].as_array_mut() { allocations.retain(|item| item["transaction_id"] != *transaction_id); }
            if !body["value"].is_null() { nonnegative(body, "value", currency)?; record["value"] = body["value"].clone(); }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db, p, &before, after, "investment_transaction_unlinked").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "sip", record_month, "status"]) => {
            api::allowed_body(body, &["status", "transaction_id"])?;
            month(record_month)?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let sip = sip_for_month(&before, record_month);
            if sip.is_null() { return Err(ApiError::invalid("This holding has no SIP schedule.")); }
            validate_sip(sip, text(&before,"currency")?)?;
            if *record_month < text(sip,"start_month")? || sip["end_month"].as_str().is_some_and(|end| *record_month > end) {
                return Err(ApiError::invalid("Month is outside the SIP schedule."));
            }
            domain::choice(body, "status", &["payment_found", "skipped", "failed", "cancelled"])?;
            let transaction_id = if body["status"] == "payment_found" {
                let transaction_id = text(body,"transaction_id")?;
                let transaction = storage::get(db,p,"transactions",transaction_id).await?;
                if transaction["voided"] == true || transaction["event_type"] != "expense" || transaction["currency"] != before["currency"] {
                    return Err(ApiError::invalid("Choose an active debit in the holding currency."));
                }
                let allocations = transaction["allocations"].as_array().ok_or_else(|| ApiError::invalid("Invalid transaction allocations."))?;
                if allocations.is_empty() { return Err(ApiError::invalid("Categorize the debit as an investment first.")); }
                for allocation in allocations {
                    let category = storage::get(db,p,"categories",text(allocation,"category_id")?).await?;
                    if category["tracking_type"] != "investment" { return Err(ApiError::invalid("Categorize the whole debit as an investment first.")); }
                }
                let (_, next) = api::month_bounds(record_month)?;
                let last = domain::date(&next)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid SIP month."))?;
                let due = chrono::NaiveDate::from_ymd_opt(last.year(),last.month(),(sip["day"].as_u64().unwrap() as u32).min(last.day())).unwrap();
                let paid = domain::date(text(&transaction,"effective_date")?)?;
                if paid.signed_duration_since(due).num_days().abs() > 10 {
                    return Err(ApiError::invalid("Payment date must be within ten days of the SIP due date."));
                }
                let amount = positive(&transaction,"amount",text(&before,"currency")?)?;
                if linked_amount(db,p,transaction_id,text(&before,"currency")?,amount).await? != 0 {
                    return Err(ApiError::conflict("This debit is already linked to an investment holding."));
                }
                let holdings: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='investments'")
                    .bind(&p.household_id).fetch_all(&mut *db).await?;
                for document in holdings {
                    let holding: Value = serde_json::from_str(&document).map_err(|_| ApiError::invalid("Invalid stored investment."))?;
                    if holding["id"] == before["id"] || holding["deleted"] == true { continue; }
                    if holding["sip_occurrences"].as_array().into_iter().flatten().any(|occurrence| occurrence["transaction_id"] == transaction_id) {
                        return Err(ApiError::conflict("This debit is already matched to another SIP."));
                    }
                }
                Some(transaction_id)
            } else {
                if body.get("transaction_id").is_some() { return Err(ApiError::invalid("Only a found payment can reference a ledger entry.")); }
                None
            };
            if before["records"].as_array().into_iter().flatten().any(|record| record["month"] == *record_month && record["sip_processed"] == true) {
                return Err(ApiError::conflict("This SIP occurrence is already invested."));
            }
            let mut after = before.clone();
            if !after["sip_occurrences"].is_array() { after["sip_occurrences"] = json!([]); }
            let occurrences = after["sip_occurrences"].as_array_mut().unwrap();
            occurrences.retain(|occurrence| occurrence["month"] != *record_month);
            occurrences.push(json!({"month":record_month,"status":body["status"],"transaction_id":transaction_id,"updated_at":storage::now(),"updated_by":p.user_id}));
            let mut saved = storage::update(db,p,&before,after,"sip_occurrence_status").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("POST", ["investments", id, "sip", record_month, "process"]) => {
            api::allowed_body(body, &["account_id", "transaction_date", "value"])?;
            month(record_month)?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            if before["type"] != "investment" || sip_for_month(&before, record_month).is_null() {
                return Err(ApiError::invalid("This holding has no SIP schedule."));
            }
            let sip = sip_for_month(&before, record_month);
            validate_sip(sip, text(&before, "currency")?)?;
            if sip["status"] != "active" || *record_month < text(sip, "start_month")?
                || sip["end_month"].as_str().is_some_and(|end| *record_month > end) {
                return Err(ApiError::invalid("The SIP is not active for this month."));
            }
            if before["sip_occurrences"].as_array().into_iter().flatten().any(|occurrence| occurrence["month"] == *record_month && ["skipped","failed","cancelled"].iter().any(|status| occurrence["status"] == *status)) {
                return Err(ApiError::conflict("Change the SIP occurrence status before recording an investment."));
            }
            let account_id = text(body, "account_id")?;
            if !body["value"].is_null() { nonnegative(body, "value", text(&before, "currency")?)?; }
            let (_, next_month) = api::month_bounds(record_month)?;
            let last = domain::date(&next_month)?.pred_opt().ok_or_else(|| ApiError::invalid("Invalid SIP month."))?;
            let due_day = (sip["day"].as_u64().unwrap() as u32).min(last.day());
            let due_date = format!("{record_month}-{due_day:02}");
            let transaction_date = body["transaction_date"].as_str().unwrap_or(&due_date);
            domain::date(transaction_date)?;
            if !transaction_date.starts_with(record_month) {
                return Err(ApiError::invalid("SIP transaction date must be in the selected month."));
            }
            let mut after = before.clone();
            let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            if let Some(existing) = records.iter().find(|v| v["month"] == *record_month) {
                if existing["sip_processed"] == true {
                    return Err(ApiError::conflict("This SIP month has already been processed."));
                }
                if nonnegative(existing, "contribution", text(&before, "currency")?)? != 0
                    || nonnegative(existing, "withdrawal", text(&before, "currency")?)? != 0 {
                    return Err(ApiError::conflict("This month already has investment activity. Use Add or correct month to review it."));
                }
                if existing["value"].is_string() && body["value"].is_null() {
                    return Err(ApiError::invalid("Enter the updated portfolio value after this SIP."));
                }
            }
            let matched = before["sip_occurrences"].as_array().into_iter().flatten()
                .find(|occurrence| occurrence["month"] == *record_month && occurrence["status"] == "payment_found")
                .and_then(|occurrence| occurrence["transaction_id"].as_str());
            let mut record = json!({"month":record_month,"contribution":sip["amount"],"withdrawal":"0","value":body["value"],"account_id":account_id,"transaction_date":transaction_date,"sip_processed":true});
            if let Some(transaction_id) = matched {
                let payment = storage::get(db,p,"transactions",transaction_id).await?;
                if payment["voided"] == true || payment["event_type"] != "expense" || payment["currency"] != before["currency"] || payment["movements"][0]["account_id"] != account_id {
                    return Err(ApiError::invalid("Matched SIP payment must be an active debit from the selected account."));
                }
                let currency = text(&before,"currency")?;
                let amount = positive(&payment,"amount",currency)?;
                let allocated = linked_amount(db,p,transaction_id,currency,amount).await?;
                if allocated != 0 { return Err(ApiError::conflict("This SIP payment is already allocated to a holding.")); }
                record["contribution"] = payment["amount"].clone();
                record["linked_transaction_ids"] = json!([transaction_id]);
                record["linked_allocations"] = json!([{"transaction_id":transaction_id,"amount":payment["amount"]}]);
            } else {
                post_investment_movements(db, p, &before, &mut record).await?;
            }
            if let Some(existing) = records.iter_mut().find(|v| v["month"] == *record_month) { *existing = record; }
            else { records.push(record); }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut saved = storage::update(db, p, &before, after, "sip_processed").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("PATCH", ["investments", id, "movements", movement_id])
        | ("DELETE", ["investments", id, "movements", movement_id]) => {
            if method == "PATCH" { api::allowed_body(body, &["amount", "account_id", "transaction_date"])?; }
            else { api::allowed_body(body, &[])?; }
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let currency = text(&before, "currency")?;
            let mut after = before.clone();
            let records = after["records"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let record = records.iter_mut().find(|record| record["transaction_ids"].as_array().is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(*movement_id)))).ok_or_else(ApiError::missing)?;
            let transaction = storage::get(db, p, "transactions", movement_id).await?;
            if transaction["voided"] == true || transaction["investment_id"] != before["id"] {
                return Err(ApiError::conflict("Investment movement is no longer active."));
            }
            let kind = text(&transaction, "event_type")?;
            if !["investment", "investment_withdrawal"].contains(&kind) {
                return Err(ApiError::invalid("Invalid investment movement type."));
            }
            let field = if kind == "investment" { "contribution" } else { "withdrawal" };
            let prior_amount = positive(&transaction, "amount", currency)?;
            let changed_amount = if method == "PATCH" { positive(body, "amount", currency)? } else { 0 };
            let total = nonnegative(record, field, currency)?
                .checked_sub(prior_amount)
                .and_then(|n| n.checked_add(changed_amount))
                .ok_or_else(|| ApiError::invalid("Investment month amount is out of range."))?;
            record[field] = json!(format_money(total, currency)?);
            let ids = record["transaction_ids"].as_array_mut().ok_or_else(|| ApiError::invalid("Invalid investment movements."))?;
            let first = ids.first() == Some(&json!(movement_id));
            if method == "DELETE" { ids.retain(|value| value.as_str() != Some(*movement_id)); }
            let no_movements = ids.is_empty();
            if first {
                if let Some(next_id) = ids.first().and_then(Value::as_str).filter(|_| method == "DELETE") {
                    let next = storage::get(db, p, "transactions", next_id).await?;
                    record["account_id"] = next["movements"][0]["account_id"].clone();
                    record["transaction_date"] = next["effective_date"].clone();
                } else if method == "DELETE" {
                    record.as_object_mut().unwrap().remove("account_id");
                    record.as_object_mut().unwrap().remove("transaction_date");
                } else {
                    record["account_id"] = body["account_id"].clone();
                    record["transaction_date"] = body["transaction_date"].clone();
                }
            }
            if method == "DELETE" && no_movements { record["sip_processed"] = json!(false); }
            let record_month = text(record, "month")?.to_owned();
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            if method == "PATCH" {
                let date = text(body, "transaction_date")?;
                domain::date(date)?;
                if !date.starts_with(&record_month) { return Err(ApiError::invalid("Movement date must be in its investment month.")); }
                let account_id = text(body, "account_id")?;
                let account = storage::get(db, p, "accounts", account_id).await?;
                if account["subtype"] == "settle_up" { return Err(ApiError::invalid("Choose a bank, card, or cash funding account.")); }
                let signed = format_money(if kind == "investment" { -changed_amount } else { changed_amount }, currency)?;
                let mut changed = transaction.clone();
                changed["amount"] = body["amount"].clone();
                changed["effective_date"] = json!(date);
                changed["movements"] = json!([{"account_id":account_id,"amount":signed}]);
                api::validate_ledger_with_history(db, p, &changed, Some(&transaction)).await?;
                reconciliation::invalidate(db, p, movement_id).await?;
                storage::update(db, p, &transaction, changed, "investment_movement_corrected").await?;
            } else {
                retire_investment_movements(db, p, &json!({"transaction_ids":[movement_id]})).await?;
            }
            let mut saved = storage::update(db, p, &before, after, if method == "PATCH" { "investment_movement_corrected" } else { "investment_movement_removed" }).await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("PUT", ["investments", id, "months", record_month]) => {
            api::allowed_body(body, &["contribution", "withdrawal", "value", "account_id", "transaction_date"])?;
            month(record_month)?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            if before["tracking_mode"] == "full_history" { return Err(ApiError::invalid("Use dated events and bulk valuations for full-history holdings.")); }
            api::revision(headers, body, &before)?;
            let currency = text(&before, "currency")?;
            nonnegative(body, "contribution", currency)?;
            nonnegative(body, "withdrawal", currency)?;
            if !body["value"].is_null() { nonnegative(body, "value", currency)?; }
            if body.get("account_id").is_some() { text(body, "account_id")?; }
            if body.get("transaction_date").is_some() && body.get("account_id").is_none() {
                return Err(ApiError::invalid("Choose an account for the investment movement date."));
            }
            let mut after = before.clone();
            let records = after["records"]
                .as_array_mut()
                .ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let old_record = records.iter().find(|v| v["month"] == *record_month).cloned();
            if let Some(old) = old_record.as_ref().filter(|old| old["linked_transaction_ids"].as_array().is_some_and(|ids| !ids.is_empty())) {
                if nonnegative(body, "contribution", currency)? != nonnegative(old, "contribution", currency)?
                    || nonnegative(body, "withdrawal", currency)? != nonnegative(old, "withdrawal", currency)?
                    || body.get("account_id").is_some_and(|account| *account != old["account_id"])
                    || body.get("transaction_date").is_some_and(|date| *date != old["transaction_date"]) {
                    return Err(ApiError::conflict("Unlink source transactions or edit generated movements before changing this month's contribution, withdrawal, account, or date."));
                }
                let record = records.iter_mut().find(|record| record["month"] == *record_month).unwrap();
                record["value"] = body["value"].clone();
                let mut check = after.clone();
                decorate_investment(&mut check)?;
                let mut saved = storage::update(db, p, &before, after, "monthly_valuation").await?;
                decorate_investment(&mut saved)?;
                return ok(saved);
            }
            let mut record = json!({"month":record_month,"contribution":body["contribution"],"withdrawal":body["withdrawal"],"value":body["value"]});
            if let Some(old) = &old_record {
                if old["sip_processed"] == true { record["sip_processed"] = json!(true); }
            }
            if let Some(account) = body.get("account_id") {
                record["account_id"] = account.clone();
                record["transaction_date"] = json!(text(body, "transaction_date")?);
            } else if let Some(old) = &old_record {
                if old["account_id"].is_string() {
                    return Err(ApiError::invalid("Choose an account for this recorded investment month."));
                }
            }
            if let Some(existing) = records.iter_mut().find(|v| v["month"] == *record_month) {
                *existing = record;
            } else {
                records.push(record);
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            let mut record = after["records"].as_array().unwrap().iter().find(|v| v["month"] == *record_month).unwrap().clone();
            let same_movement = old_record.as_ref().is_some_and(|old| {
                old["contribution"] == record["contribution"]
                    && old["withdrawal"] == record["withdrawal"]
                    && old["account_id"] == record["account_id"]
                    && old["transaction_date"] == record["transaction_date"]
            });
            if same_movement {
                record["transaction_ids"] = old_record.as_ref().unwrap()["transaction_ids"].clone();
            } else {
                if old_record.as_ref().is_some_and(|old| old["transaction_ids"].as_array().is_some_and(|ids| ids.len() > 1)) {
                    return Err(ApiError::conflict("This month has separate investment movements. Correct them individually."));
                }
                if let Some(old) = &old_record { retire_investment_movements(db, p, old).await?; }
                post_investment_movements(db, p, &before, &mut record).await?;
            }
            *after["records"].as_array_mut().unwrap().iter_mut().find(|v| v["month"] == *record_month).unwrap() = record;
            let mut saved = storage::update(db, p, &before, after, "monthly_valuation").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("DELETE", ["investments", id, "months", record_month]) => {
            api::allowed_body(body, &[])?;
            month(record_month)?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            if before["tracking_mode"] == "full_history" { return Err(ApiError::invalid("Reverse events or correct valuations instead of deleting a full-history month.")); }
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            let records = after["records"]
                .as_array_mut()
                .ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let original = records.len();
            let old_record = records.iter().find(|v| v["month"] == *record_month).cloned();
            if old_record.as_ref().is_some_and(|old| old["linked_transaction_ids"].as_array().is_some_and(|ids| !ids.is_empty())) {
                return Err(ApiError::conflict("Unlink this month's source transactions before deleting the monthly record."));
            }
            records.retain(|v| v["month"] != *record_month);
            if records.len() == original {
                return Err(ApiError::missing());
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            if let Some(old) = &old_record { retire_investment_movements(db, p, old).await?; }
            storage::update(db, p, &before, after, "monthly_valuation_removed").await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        _ => Err(ApiError::missing()),
    }
}
