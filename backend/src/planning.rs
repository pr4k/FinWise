use crate::{
    api::{self, Query},
    auth::Principal,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::HashSet;

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
fn owner(p: &Principal, v: &Value) -> Result<()> {
    if v["owner_id"] == p.user_id {
        Ok(())
    } else {
        Err(ApiError::missing())
    }
}
fn active(v: &Value) -> Result<()> {
    if v["deleted"] == true {
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
    let mut invested = 0_i64;
    let mut last_value = None;
    let mut records = v["records"].as_array().cloned().unwrap_or_default();
    records.sort_by(|a, b| a["month"].as_str().cmp(&b["month"].as_str()));
    for record in &mut records {
        let contribution = nonnegative(record, "contribution", &currency)?;
        let withdrawal = nonnegative(record, "withdrawal", &currency)?;
        invested = add(invested, contribution)?
            .checked_sub(withdrawal)
            .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        if invested < 0 {
            return Err(ApiError::invalid("Withdrawals exceed contributions."));
        }
        let value = nonnegative(record, "value", &currency)?;
        record["net_contributions"] = json!(format_money(invested, &currency)?);
        record["gain_loss"] = json!(format_money(
            value
                .checked_sub(invested)
                .ok_or_else(|| ApiError::invalid("Money total is out of range."))?,
            &currency
        )?);
        last_value = Some(value);
    }
    v["records"] = json!(records);
    v["net_contributions"] = json!(format_money(invested, &currency)?);
    v["current_value"] = last_value
        .map(|n| format_money(n, &currency))
        .transpose()?
        .map_or(Value::Null, |s| json!(s));
    v["gain_loss"] = last_value
        .map(|n| {
            n.checked_sub(invested)
                .ok_or_else(|| ApiError::invalid("Money total is out of range."))
        })
        .transpose()?
        .map(|n| format_money(n, &currency))
        .transpose()?
        .map_or(Value::Null, |s| json!(s));
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
        ("GET", ["investments"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            let mut items = storage::list(db, p, "investments").await?;
            items.retain(|v| v["deleted"] != true);
            for item in &mut items {
                decorate_investment(item)?;
            }
            ok(api::paginate(items, q)?)
        }
        ("POST", ["investments"]) => {
            api::allowed_body(
                body,
                &[
                    "name",
                    "type",
                    "currency",
                    "target",
                    "monthly_goal",
                    "notes",
                    "visibility",
                ],
            )?;
            domain::choice(body, "type", &["investment", "emergency_fund"])?;
            if body.get("visibility").is_some() {
                domain::choice(body, "visibility", &["private", "shared"])?;
            }
            let name = text(body, "name")?;
            if name.len() > 100 {
                return Err(ApiError::invalid("Name is too long."));
            }
            let currency = text(body, "currency")?;
            domain::exponent(currency)?;
            if body.get("target").is_some() {
                nonnegative(body, "target", currency)?;
            }
            if body.get("monthly_goal").is_some() {
                nonnegative(body, "monthly_goal", currency)?;
            }
            let mut v = body.clone();
            if v.get("visibility").is_none() {
                v["visibility"] = json!("private");
            }
            v["records"] = json!([]);
            let mut v = storage::create(db, p, "investments", v).await?;
            decorate_investment(&mut v)?;
            Ok((StatusCode::CREATED, v))
        }
        ("GET", ["investments", id]) => {
            api::allowed_query(q, &[])?;
            let mut v = storage::get(db, p, "investments", id).await?;
            active(&v)?;
            decorate_investment(&mut v)?;
            ok(v)
        }
        ("DELETE", ["investments", id]) => {
            api::allowed_body(body, &[])?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            after["deleted"] = json!(true);
            after["deleted_at"] = json!(storage::now());
            storage::update(db, p, &before, after, "delete").await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        ("PATCH", ["investments", id]) => {
            api::allowed_body(
                body,
                &["name", "target", "monthly_goal", "notes", "visibility"],
            )?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            if after.get("visibility").is_none() {
                after["visibility"] = json!("private");
            }
            for key in ["name", "target", "monthly_goal", "notes", "visibility"] {
                if let Some(v) = body.get(key) {
                    after[key] = v.clone();
                }
            }
            domain::choice(&after, "visibility", &["private", "shared"])?;
            if text(&after, "name")?.len() > 100 {
                return Err(ApiError::invalid("Name is too long."));
            }
            if after.get("target").is_some() {
                nonnegative(&after, "target", text(&after, "currency")?)?;
            }
            if after.get("monthly_goal").is_some() {
                nonnegative(&after, "monthly_goal", text(&after, "currency")?)?;
            }
            let mut saved = storage::update(db, p, &before, after, "update").await?;
            decorate_investment(&mut saved)?;
            ok(saved)
        }
        ("PUT", ["investments", id, "months", record_month]) => {
            api::allowed_body(body, &["contribution", "withdrawal", "value"])?;
            month(record_month)?;
            let before = storage::get(db, p, "investments", id).await?;
            owner(p, &before)?;
            active(&before)?;
            api::revision(headers, body, &before)?;
            let currency = text(&before, "currency")?;
            nonnegative(body, "contribution", currency)?;
            nonnegative(body, "withdrawal", currency)?;
            nonnegative(body, "value", currency)?;
            let mut after = before.clone();
            let records = after["records"]
                .as_array_mut()
                .ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let record = json!({"month":record_month,"contribution":body["contribution"],"withdrawal":body["withdrawal"],"value":body["value"]});
            if let Some(existing) = records.iter_mut().find(|v| v["month"] == *record_month) {
                *existing = record;
            } else {
                records.push(record);
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
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
            api::revision(headers, body, &before)?;
            let mut after = before.clone();
            let records = after["records"]
                .as_array_mut()
                .ok_or_else(|| ApiError::invalid("Invalid investment records."))?;
            let original = records.len();
            records.retain(|v| v["month"] != *record_month);
            if records.len() == original {
                return Err(ApiError::missing());
            }
            let mut check = after.clone();
            decorate_investment(&mut check)?;
            storage::update(db, p, &before, after, "monthly_valuation_removed").await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }
        _ => Err(ApiError::missing()),
    }
}
