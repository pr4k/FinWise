//! Dated account projections and immutable observed balance checks.
use crate::{
    auth::{self, Principal},
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

pub fn timestamp(value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|_| ApiError::invalid("Timestamp must be RFC 3339 with an offset."))
}
pub async fn timezone(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
) -> Result<chrono_tz::Tz> {
    let household = auth::me(db, p).await?["household"].clone();
    account["timezone"]
        .as_str()
        .unwrap_or(household["timezone"].as_str().unwrap_or("UTC"))
        .parse()
        .map_err(|_| ApiError::invalid("Invalid IANA timezone."))
}
pub fn effective_at(event: &Value, tz: chrono_tz::Tz) -> Result<DateTime<Utc>> {
    if let Some(at) = event["effective_at"].as_str() {
        return timestamp(at);
    }
    let local = domain::date(text(event, "effective_date")?)?
        .and_hms_opt(10, 0, 0)
        .unwrap();
    tz.from_local_datetime(&local)
        .single()
        .map(|v| v.with_timezone(&Utc))
        .ok_or_else(|| {
            ApiError::invalid("Ambiguous business date; provide effective_at with an offset.")
        })
}
pub fn basis(account: &Value) -> &'static str {
    match account["subtype"].as_str() {
        Some("credit_card") => "amount_owed",
        Some("cash") => "cash_count",
        Some("settle_up") => "settlement_receivable",
        _ => "asset",
    }
}
pub fn validate_opening(account: &Value) -> Result<()> {
    if let Some(opening) = account.get("opening_balance").filter(|v| !v.is_null()) {
        money(text(opening, "amount")?, text(account, "currency")?)?;
        timestamp(text(opening, "as_of")?)?;
    }
    Ok(())
}
// The caller authorizes the account first. Read all its movements, including a
// transfer whose other account is private, without revealing that other leg.
async fn events(db: &mut SqliteConnection, p: &Principal, account: &Value) -> Result<Vec<Value>> {
    let rows:Vec<String>=sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND EXISTS(SELECT 1 FROM json_each(document,'$.movements') WHERE json_extract(value,'$.account_id')=?) ORDER BY id")
        .bind(&p.household_id).bind(text(account,"id")?).fetch_all(db).await?;
    rows.into_iter()
        .map(|s| {
            serde_json::from_str(&s).map_err(|_| ApiError::invalid("Invalid stored transaction."))
        })
        .collect()
}
pub async fn project(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    cutoff: DateTime<Utc>,
) -> Result<Value> {
    let tz = timezone(db, p, account).await?;
    let currency = text(account, "currency")?;
    let opening = account.get("opening_balance").filter(|v| !v.is_null());
    let opening_at = opening.map(|v| timestamp(text(v, "as_of")?)).transpose()?;
    let mut projected = opening
        .map(|v| money(text(v, "amount")?, currency))
        .transpose()?;
    // Ledger movements use asset signs; card values are displayed as positive debt.
    if account["subtype"] == "credit_card" {
        projected = projected
            .map(|v| {
                v.checked_neg()
                    .ok_or_else(|| ApiError::invalid("Card balance out of range."))
            })
            .transpose()?;
    }
    let mut snapshot = vec![];
    let mut net = 0;
    for event in events(db, p, account).await? {
        let at = effective_at(&event, tz)?;
        let direction = match opening_at {
            Some(anchor) if cutoff < anchor && cutoff < at && at <= anchor => -1,
            Some(anchor) if anchor < at && at <= cutoff => 1,
            None if at <= cutoff => 1,
            _ => 0,
        };
        if direction == 0 {
            continue;
        }
        snapshot.push(json!({"id":event["id"],"revision":event["revision"]}));
        if event["voided"] == true {
            continue;
        }
        for movement in event["movements"].as_array().unwrap() {
            if movement["account_id"] == account["id"] {
                let delta = money(text(movement, "amount")?, currency)?;
                net = add(
                    net,
                    delta
                        .checked_mul(direction)
                        .ok_or_else(|| ApiError::invalid("Balance out of range."))?,
                )?;
            }
        }
    }
    if let Some(value) = projected {
        projected = Some(add(value, net)?);
    }
    if account["subtype"] == "credit_card" {
        projected = projected
            .map(|v| {
                v.checked_neg()
                    .ok_or_else(|| ApiError::invalid("Card balance out of range."))
            })
            .transpose()?;
    }
    let snapshot = auth::hash(
        &json!({"opening":opening,"events":snapshot,"timezone":tz.to_string()}).to_string(),
    );
    Ok(
        json!({"amount":projected.map(|v|format_money(v,currency)).transpose()?,"currency":currency,"basis":basis(account),"as_of":cutoff.to_rfc3339(),"complete":projected.is_some(),"coverage":"unknown","ledger_snapshot":snapshot,"signed_movements":format_money(net,currency)?}),
    )
}
pub async fn decorate(db: &mut SqliteConnection, p: &Principal, account: &mut Value) -> Result<()> {
    account["balance"] = derived(db, p, account, Utc::now()).await?;
    Ok(())
}

// A dated observation is an anchor: movements after it roll forward and
// movements through it roll backward. This preserves the observed amount
// without rewriting any transaction or inventing an opening balance.
pub async fn derived(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    cutoff: DateTime<Utc>,
) -> Result<Value> {
    let currency = text(account, "currency")?;
    let opening_at = account["opening_balance"]["as_of"]
        .as_str()
        .map(timestamp)
        .transpose()?;
    let tz = timezone(db, p, account).await?;
    let checks = storage::list(db, p, "balance_checks").await?;
    let mut anchors = checks
        .into_iter()
        .filter(|v| v["account_id"] == account["id"] && v["voided"] != true)
        .map(|v| Ok((timestamp(text(&v, "as_of")?)?, v)))
        .collect::<Result<Vec<_>>>()?;
    anchors.sort_by_key(|(at, _)| *at);
    let selected = anchors
        .iter()
        .rev()
        .find(|(at, _)| *at <= cutoff && opening_at.is_none_or(|opening| *at >= opening))
        .or_else(|| {
            if opening_at.is_some_and(|opening| opening <= cutoff) {
                None
            } else {
                anchors
                    .iter()
                    .find(|(at, _)| *at > cutoff && opening_at.is_none_or(|opening| *at < opening))
            }
        });
    if let Some((anchor_at, check)) = selected {
        let mut value = money(text(check, "amount")?, currency)?;
        if account["subtype"] == "credit_card" {
            value = value
                .checked_neg()
                .ok_or_else(|| ApiError::invalid("Card balance out of range."))?;
        }
        for event in events(db, p, account).await? {
            if event["voided"] == true {
                continue;
            }
            let at = effective_at(&event, tz)?;
            let direction = if *anchor_at < at && at <= cutoff {
                1
            } else if cutoff < at && at <= *anchor_at {
                -1
            } else {
                0
            };
            if direction == 0 {
                continue;
            }
            for movement in event["movements"].as_array().unwrap() {
                if movement["account_id"] == account["id"] {
                    let delta = money(text(movement, "amount")?, currency)?;
                    value = add(
                        value,
                        delta
                            .checked_mul(direction)
                            .ok_or_else(|| ApiError::invalid("Balance out of range."))?,
                    )?;
                }
            }
        }
        if account["subtype"] == "credit_card" {
            value = value
                .checked_neg()
                .ok_or_else(|| ApiError::invalid("Card balance out of range."))?;
        }
        return Ok(
            json!({"amount":format_money(value,currency)?,"currency":currency,"basis":basis(account),"as_of":cutoff.to_rfc3339(),"complete":true,"coverage":"unknown","source":"balance_check","anchor_at":anchor_at.to_rfc3339(),"anchor_id":check["id"]}),
        );
    }
    let mut value = project(db, p, account, cutoff).await?;
    value["source"] = json!(if value["complete"] == true {
        "opening_balance"
    } else {
        "unknown"
    });
    value["anchor_at"] = account["opening_balance"]["as_of"].clone();
    Ok(value)
}

pub async fn ledger(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
) -> Result<Vec<Value>> {
    let tz = timezone(db, p, account).await?;
    let currency = text(account, "currency")?;
    let mut rows = vec![];
    for event in events(db, p, account).await? {
        if event["voided"] == true {
            continue;
        }
        let at = effective_at(&event, tz)?;
        let mut movement = 0;
        for leg in event["movements"].as_array().unwrap() {
            if leg["account_id"] == account["id"] {
                movement = add(movement, money(text(leg, "amount")?, currency)?)?;
            }
        }
        let visible = storage::visible(db, p, "transactions", &event).await?;
        rows.push(json!({"transaction_id":if visible { event["id"].clone() } else { Value::Null },"effective_date":event["effective_date"],"effective_at":at.to_rfc3339(),"description":if visible { event["description"].clone() } else { json!("Private transfer") },"event_type":if visible { event["event_type"].clone() } else { json!("transfer") },"movement":format_money(movement,currency)?,"currency":currency}));
    }
    rows.sort_by(|a, b| {
        (a["effective_at"].as_str(), a["transaction_id"].as_str())
            .cmp(&(b["effective_at"].as_str(), b["transaction_id"].as_str()))
    });
    let mut prefixes = BTreeMap::new();
    let mut cumulative = 0;
    for row in &rows {
        cumulative = add(cumulative, money(text(row, "movement")?, currency)?)?;
        prefixes.insert(timestamp(text(row, "effective_at")?)?, cumulative);
    }
    let checks = storage::list(db, p, "balance_checks").await?;
    let mut anchors = checks
        .into_iter()
        .filter(|v| v["account_id"] == account["id"] && v["voided"] != true)
        .map(|v| Ok((timestamp(text(&v, "as_of")?)?, v)))
        .collect::<Result<Vec<_>>>()?;
    anchors.sort_by_key(|(at, _)| *at);
    let opening = account.get("opening_balance").filter(|v| !v.is_null());
    let opening_at = opening.map(|v| timestamp(text(v, "as_of")?)).transpose()?;
    let signed = |value: i64| -> Result<i64> {
        if account["subtype"] == "credit_card" {
            value
                .checked_neg()
                .ok_or_else(|| ApiError::invalid("Card balance out of range."))
        } else {
            Ok(value)
        }
    };
    // Date-only imports share the assumed 10:00 AM account-local time. Each row shows the balance after the
    // complete group at that instant, rather than claiming an intraday order.
    let mut i = 0;
    while i < rows.len() {
        let mut end = i + 1;
        while end < rows.len() && rows[end]["effective_at"] == rows[i]["effective_at"] {
            end += 1;
        }
        let at = timestamp(text(&rows[i], "effective_at")?)?;
        let prefix = *prefixes
            .range(..=at)
            .next_back()
            .map(|(_, v)| v)
            .unwrap_or(&0);
        let before_group = *prefixes
            .range(..at)
            .next_back()
            .map(|(_, v)| v)
            .unwrap_or(&0);
        let group_movement = prefix
            .checked_sub(before_group)
            .ok_or_else(|| ApiError::invalid("Balance out of range."))?;
        let computed_from_start = if let (Some(opening), Some(opening_at)) = (opening, opening_at) {
            let baseline = *prefixes
                .range(..=opening_at)
                .next_back()
                .map(|(_, v)| v)
                .unwrap_or(&0);
            let delta = prefix
                .checked_sub(baseline)
                .ok_or_else(|| ApiError::invalid("Balance out of range."))?;
            Some(signed(add(
                signed(money(text(opening, "amount")?, currency)?)?,
                delta,
            )?)?)
        } else {
            None
        };
        let check = anchors
            .iter()
            .rev()
            .find(|(anchor_at, _)| {
                *anchor_at <= at && opening_at.is_none_or(|opening| *anchor_at >= opening)
            })
            .or_else(|| {
                if opening_at.is_some_and(|opening| opening <= at) {
                    None
                } else {
                    anchors.iter().find(|(check_at, _)| {
                        *check_at > at && opening_at.is_none_or(|opening| *check_at < opening)
                    })
                }
            });
        let (value, source, anchor_at) = if let Some((check_at, check)) = check {
            let baseline = *prefixes
                .range(..=*check_at)
                .next_back()
                .map(|(_, v)| v)
                .unwrap_or(&0);
            let delta = prefix
                .checked_sub(baseline)
                .ok_or_else(|| ApiError::invalid("Balance out of range."))?;
            (
                Some(signed(add(
                    signed(money(text(check, "amount")?, currency)?)?,
                    delta,
                )?)?),
                "balance_check",
                Some(check_at.to_rfc3339()),
            )
        } else if let Some(opening_at) = opening_at {
            (
                computed_from_start,
                "opening_balance",
                Some(opening_at.to_rfc3339()),
            )
        } else {
            (None, "unknown", None)
        };
        for row in &mut rows[i..end] {
            row["computed_from_start"] = computed_from_start
                .map(|v| format_money(v, currency))
                .transpose()?
                .map_or(Value::Null, Value::String);
            row["balance_after"] = value
                .map(|v| format_money(v, currency))
                .transpose()?
                .map_or(Value::Null, Value::String);
            row["balance_source"] = json!(source);
            row["anchor_at"] = json!(anchor_at);
            row["same_time_count"] = json!(end - i);
            row["same_time_group_movement"] = json!(format_money(group_movement, currency)?);
        }
        i = end;
    }
    // Balance anchors are dated ledger events, even when no transaction shares their date.
    // They do not create a money movement.
    if let Some(opening) = opening {
        let at = timestamp(text(opening, "as_of")?)?;
        let computed = project(db, p, account, at).await?;
        let displayed = derived(db, p, account, at).await?;
        rows.push(json!({"event_type":"opening_balance","effective_date":at.with_timezone(&tz).format("%Y-%m-%d").to_string(),"effective_at":at.to_rfc3339(),"description":"Starting balance","movement":Value::Null,"currency":currency,"computed_from_start":computed["amount"],"balance_after":displayed["amount"],"balance_source":displayed["source"],"anchor_at":opening["as_of"]}));
    }
    for (at, check) in anchors {
        let computed = project(db, p, account, at).await?;
        rows.push(json!({"event_type":"balance_check","check_id":check["id"],"effective_date":at.with_timezone(&tz).format("%Y-%m-%d").to_string(),"effective_at":at.to_rfc3339(),"description":format!("Balance check · {}",check["basis"].as_str().unwrap_or("observed")),"movement":Value::Null,"currency":currency,"observed_amount":check["amount"],"computed_from_start":computed["amount"],"balance_after":check["amount"],"balance_source":"balance_check","anchor_at":check["as_of"]}));
    }
    rows.sort_by(|a, b| {
        (b["effective_at"].as_str(), b["event_type"].as_str())
            .cmp(&(a["effective_at"].as_str(), a["event_type"].as_str()))
    });
    Ok(rows)
}
pub async fn record(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    body: &Value,
) -> Result<Value> {
    let value = check_value(db, p, account, body).await?;
    let check = storage::create(db, p, "balance_checks", value).await?;
    storage::update(db, p, account, account.clone(), "balance_check_recorded").await?;
    Ok(check)
}

async fn check_value(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    body: &Value,
) -> Result<Value> {
    let currency = text(account, "currency")?;
    if body.get("currency").is_some_and(|c| c != currency) {
        return Err(ApiError::invalid(
            "Balance currency must match the account.",
        ));
    }
    let actual = money(text(body, "amount")?, currency)?;
    let at = timestamp(text(body, "as_of")?)?;
    let tz = text(body, "timezone")?
        .parse::<chrono_tz::Tz>()
        .map_err(|_| ApiError::invalid("Invalid IANA timezone."))?;
    let supplied = chrono::DateTime::parse_from_rfc3339(text(body, "as_of")?)
        .map_err(|_| ApiError::invalid("Invalid as_of."))?;
    if supplied.naive_local() != at.with_timezone(&tz).naive_local() {
        return Err(ApiError::invalid("as_of offset and timezone disagree."));
    }
    if body.get("source_observation_id").is_some() {
        return Err(ApiError::invalid(
            "Source observations are not supported yet.",
        ));
    }
    let basis = text(body, "basis")?;
    let valid = match account["subtype"].as_str() {
        Some("cash") => basis == "cash_count",
        Some("credit_card") => ["posted", "current", "statement_closing"].contains(&basis),
        Some("bank") => ["posted", "current", "statement_closing"].contains(&basis),
        _ => false,
    };
    if !valid {
        return Err(ApiError::invalid(
            "Balance basis does not apply to this account subtype.",
        ));
    }
    let projected = project(db, p, account, at).await?;
    let calculated = projected["amount"]
        .as_str()
        .map(|v| money(v, currency))
        .transpose()?;
    let variance = calculated
        .map(|v| {
            actual
                .checked_sub(v)
                .ok_or_else(|| ApiError::invalid("Variance is out of range."))
        })
        .transpose()?;
    Ok(
        json!({"account_id":account["id"],"amount":format_money(actual,currency)?,"currency":currency,"basis":basis,"as_of":at.to_rfc3339(),"timezone":body["timezone"],"calculated":projected["amount"],"variance":variance.map(|v|format_money(v,currency)).transpose()?,"complete":calculated.is_some(),"ledger_snapshot":projected["ledger_snapshot"],"account_revision":account["revision"],"stale":false,"resolution":body["reason"],"voided":false}),
    )
}
pub async fn revise(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    before: &Value,
    body: &Value,
) -> Result<Value> {
    if before["voided"] == true {
        return Err(ApiError::conflict(
            "Removed balance checks cannot be edited.",
        ));
    }
    let mut source = before.clone();
    for field in ["amount", "basis", "as_of", "timezone", "reason"] {
        if let Some(value) = body.get(field) {
            source[field] = value.clone();
        }
    }
    // The stored field is named resolution; accept reason on the edit request.
    if body.get("reason").is_none() {
        source["reason"] = before["resolution"].clone();
    }
    if body.get("as_of").is_none() {
        let tz = text(&source, "timezone")?
            .parse::<chrono_tz::Tz>()
            .map_err(|_| ApiError::invalid("Invalid IANA timezone."))?;
        source["as_of"] = json!(
            timestamp(text(before, "as_of")?)?
                .with_timezone(&tz)
                .to_rfc3339()
        );
    }
    let value = check_value(db, p, account, &source).await?;
    let updated = storage::update(db, p, before, value, "balance_check_corrected").await?;
    storage::update(db, p, account, account.clone(), "balance_check_corrected").await?;
    Ok(updated)
}
pub async fn remove(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    before: &Value,
) -> Result<()> {
    if before["voided"] == true {
        return Err(ApiError::conflict("Balance check is already removed."));
    }
    let mut after = before.clone();
    after["voided"] = json!(true);
    storage::update(db, p, before, after, "balance_check_removed").await?;
    storage::update(db, p, account, account.clone(), "balance_check_removed").await?;
    Ok(())
}
pub async fn history(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
) -> Result<Vec<Value>> {
    let mut values = storage::list(db, p, "balance_checks").await?;
    values.retain(|v| v["account_id"] == account["id"]);
    for value in &mut values {
        let current = project(db, p, account, timestamp(text(value, "as_of")?)?).await?;
        value["stale"] = json!(current["ledger_snapshot"] != value["ledger_snapshot"]);
        value["current_calculated"] = current["amount"].clone();
        value["current_variance"] = current["amount"]
            .as_str()
            .map(|computed| {
                let currency = text(account, "currency")?;
                let difference = money(text(value, "amount")?, currency)?
                    .checked_sub(money(computed, currency)?)
                    .ok_or_else(|| ApiError::invalid("Variance is out of range."))?;
                format_money(difference, currency)
            })
            .transpose()?
            .map_or(Value::Null, Value::String);
    }
    values.sort_by(|a, b| {
        (b["as_of"].as_str(), b["id"].as_str()).cmp(&(a["as_of"].as_str(), a["id"].as_str()))
    });
    Ok(values)
}
pub async fn statement(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
    from: &str,
    to: &str,
) -> Result<Value> {
    let tz = timezone(db, p, account).await?;
    let at = |date: &str| -> Result<DateTime<Utc>> {
        let local = domain::date(date)?.and_hms_opt(0, 0, 0).unwrap();
        tz.from_local_datetime(&local)
            .single()
            .map(|v| v.with_timezone(&Utc))
            .ok_or_else(|| ApiError::invalid("Ambiguous month boundary."))
    };
    let start = at(from)?;
    let end = at(to)?;
    let mut opening = project(db, p, account, start - chrono::Duration::nanoseconds(1)).await?;
    if account["opening_balance"]["as_of"]
        .as_str()
        .map(timestamp)
        .transpose()?
        .is_some_and(|at| at == start)
    {
        opening["amount"] = account["opening_balance"]["amount"].clone();
        opening["complete"] = json!(true);
        opening["as_of"] = json!(start.to_rfc3339());
    }
    let closing = project(db, p, account, end - chrono::Duration::nanoseconds(1)).await?;
    let currency = text(account, "currency")?;
    let mut net = 0;
    let mut count = 0;
    let mut ledger_unmatched_count = 0;
    for event in events(db, p, account).await? {
        let date = effective_at(&event, tz)?;
        if event["voided"] == true || date < start || date >= end {
            continue;
        }
        count += 1;
        for m in event["movements"].as_array().unwrap() {
            if m["account_id"] == account["id"] {
                let amount = money(text(m, "amount")?, currency)?;
                net = add(net, amount)?;
                if crate::reconciliation::used(db, text(&event, "id")?, Some(text(account, "id")?))
                    .await?
                    != amount
                {
                    ledger_unmatched_count += 1;
                }
            }
        }
    }
    let source_rows=sqlx::query("SELECT DISTINCT f.id,f.filename,f.state,f.mapping_json FROM source_files f JOIN import_rows r ON r.file_id=f.id WHERE f.household_id=? AND f.account_id=? AND f.source_kind='bank_statement' AND json_extract(r.normalized_json,'$.effective_date')>=? AND json_extract(r.normalized_json,'$.effective_date')<? ORDER BY f.id")
        .bind(&p.household_id).bind(text(account,"id")?).bind(from).bind(to).fetch_all(&mut *db).await?;
    let mut statement_imports = vec![];
    for row in source_rows {
        let mapping: Value = serde_json::from_str(row.get::<&str, _>(3)).unwrap_or(json!({}));
        statement_imports.push(json!({"file_id":row.get::<&str,_>(0),"filename":row.get::<&str,_>(1),"state":row.get::<&str,_>(2),"coverage_claim":mapping["coverage_claim"]}));
    }
    let observations = sqlx::query("SELECT id,amount_minor FROM bank_observations WHERE household_id=? AND account_id=? AND effective_date>=? AND effective_date<?")
        .bind(&p.household_id).bind(text(account,"id")?).bind(from).bind(to).fetch_all(&mut *db).await?;
    let mut observation_unmatched_count = 0;
    for observation in observations {
        if crate::reconciliation::used(db, observation.get::<&str, _>(0), None).await?
            != observation.get::<i64, _>(1)
        {
            observation_unmatched_count += 1;
        }
    }
    let provider_statement_available = !statement_imports.is_empty()
        && matches!(account["subtype"].as_str(), Some("bank" | "credit_card"));
    let coverage = if statement_imports.iter().any(|v| {
        v["coverage_claim"]["status"] == "owner_confirmed"
            && v["coverage_claim"]["from"] == from
            && v["coverage_claim"]["to"] == to
    }) {
        "owner_confirmed"
    } else {
        "unknown"
    };
    Ok(
        json!({"account_id":account["id"],"kind":"recorded_account_activity","from":from,"to":to,"currency":currency,"opening":opening,"closing":closing,"signed_movements":format_money(net,currency)?,"transaction_count":count,"statement":null,"statement_imports":statement_imports,"coverage":coverage,"unresolved_count":ledger_unmatched_count+observation_unmatched_count,"ledger_unmatched_count":ledger_unmatched_count,"observation_unmatched_count":observation_unmatched_count,"provider_statement_available":provider_statement_available}),
    )
}

// These are balances printed in uploaded files, kept separate from the ledger
// projection above. A file can cover several months or only part of a month.
pub async fn statement_months(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
) -> Result<Value> {
    let currency = text(account, "currency")?;
    let rows = sqlx::query("SELECT f.id,f.filename,r.row_number,r.raw_json,f.mapping_json FROM source_files f JOIN import_rows r ON r.file_id=f.id WHERE f.household_id=? AND f.account_id=? AND f.source_kind='bank_statement' AND f.state='committed' ORDER BY f.id,r.row_number")
        .bind(&p.household_id)
        .bind(text(account, "id")?)
        .fetch_all(&mut *db).await?;
    let mut groups: BTreeMap<(String, String), Vec<(String, String, i64, Value)>> = BTreeMap::new();
    let mut names = BTreeMap::new();
    for row in rows {
        let file_id: String = row.get(0);
        let filename: String = row.get(1);
        let raw: Value = serde_json::from_str(row.get::<&str, _>(3))
            .map_err(|_| ApiError::invalid("Invalid stored statement row."))?;
        let mapping: Value = serde_json::from_str(row.get::<&str, _>(4))
            .map_err(|_| ApiError::invalid("Invalid stored statement mapping."))?;
        let normalized = crate::imports::normalize_again(
            &raw,
            &json!({"source_kind":"bank_statement","filename":filename,"mapping":mapping}),
        )?;
        let Some(date) = normalized["effective_date"].as_str() else {
            continue;
        };
        if domain::date(date).is_err() || normalized["currency"] != currency {
            continue;
        }
        names.insert(file_id.clone(), filename);
        groups
            .entry((file_id, date[..7].to_owned()))
            .or_default()
            .push((
                date.to_owned(),
                normalized["local_time"].as_str().unwrap_or("").to_owned(),
                row.get(2),
                normalized,
            ));
    }
    let mut data = vec![];
    for ((file_id, month), mut entries) in groups {
        entries.sort_by(|a, b| (&a.0, &a.1, a.2).cmp(&(&b.0, &b.1, b.2)));
        let first_date = &entries.first().unwrap().0;
        let last_date = &entries.last().unwrap().0;
        let mut opening = None;
        let mut closing = None;
        let mut balance_rows = 0;
        for (index, (_, _, _, row)) in entries.iter().enumerate() {
            let Some(balance) = row["statement_balance"].as_str() else {
                continue;
            };
            let Ok(balance) = money(balance, currency) else {
                continue;
            };
            balance_rows += 1;
            if index == 0 {
                if let Some(movement) = row["signed_movement"]
                    .as_str()
                    .and_then(|v| money(v, currency).ok())
                {
                    opening = balance.checked_sub(movement);
                }
            }
            if index == entries.len() - 1 {
                closing = Some(balance);
            }
        }
        data.push(json!({"file_id":file_id,"filename":names[&file_id],"month":month,"currency":currency,"first_date":first_date,"last_date":last_date,"row_count":entries.len(),"balance_row_count":balance_rows,"opening_balance":opening.map(|v|format_money(v,currency)).transpose()?,"closing_balance":closing.map(|v|format_money(v,currency)).transpose()?,"basis":"uploaded_statement_rows"}));
    }
    data.sort_by(|a, b| {
        (b["month"].as_str(), a["filename"].as_str())
            .cmp(&(a["month"].as_str(), b["filename"].as_str()))
    });
    Ok(json!({"data":data,"coverage":"unconfirmed"}))
}
