//! Account-scoped evidence matching. All writes run in the API's SQL transaction.
use crate::{
    api::{self, Query},
    auth::Principal,
    balances,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{HashMap, HashSet};

type Reply = (StatusCode, Value);

pub async fn store_observation(
    db: &mut SqliteConnection,
    p: &Principal,
    row: &Value,
) -> Result<()> {
    let id: String = sqlx::query_scalar("SELECT id FROM import_occurrences WHERE household_id=? AND account_id=? AND fingerprint=? AND occurrence=?")
        .bind(&p.household_id).bind(text(row,"account_id")?).bind(text(row,"fingerprint")?)
        .bind(row["occurrence"].as_i64()).fetch_one(&mut *db).await?;
    let amount = money(text(row, "signed_movement")?, text(row, "currency")?)?;
    if amount == 0 {
        return Err(ApiError::invalid("Statement movement must be nonzero."));
    }
    let value = json!({"id":id,"account_id":row["account_id"],"effective_date":row["effective_date"],"currency":row["currency"],"amount":row["signed_movement"],"description":row["description"],"reference":row["reference"],"statement_balance":row["statement_balance"],"raw_row_ref":{"file_id":row["raw_row_ref"]["file_id"],"row_number":row["raw_row_ref"]["row_number"]}});
    sqlx::query("INSERT OR IGNORE INTO bank_observations(id,household_id,account_id,effective_date,currency,amount_minor,document) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(&p.household_id).bind(text(row,"account_id")?).bind(text(row,"effective_date")?)
        .bind(text(row,"currency")?).bind(amount).bind(value.to_string()).execute(db).await?;
    Ok(())
}

pub async fn session(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Value> {
    let value = storage::raw(db, p, "reconciliation_sessions", id).await?;
    storage::get(db, p, "accounts", text(&value, "account_id")?).await?;
    Ok(value)
}

pub async fn authorize_replay(
    db: &mut SqliteConnection,
    p: &Principal,
    value: &Value,
) -> Result<()> {
    let account = value["account_id"]
        .as_str()
        .or_else(|| value["session"]["account_id"].as_str())
        .ok_or_else(ApiError::missing)?;
    storage::get(db, p, "accounts", account).await?;
    for transaction in [
        value.get("transaction"),
        value.get("survivor"),
        value.get("discarded"),
    ]
    .into_iter()
    .flatten()
    {
        storage::get(db, p, "transactions", text(transaction, "id")?).await?;
        if !storage::visible(db, p, "transactions", transaction).await? {
            return Err(ApiError::missing());
        }
    }
    if let Some(movements) = value["impact"]["account_movement_deltas"].as_array() {
        for movement in movements {
            storage::get(db, p, "accounts", text(movement, "account_id")?).await?;
        }
    }
    if let Some(links) = value["allocations"].as_array() {
        for link in links {
            storage::get(db, p, "transactions", text(link, "ledger_id")?).await?;
        }
    }
    Ok(())
}

pub(crate) async fn used(
    db: &mut SqliteConnection,
    id: &str,
    account: Option<&str>,
) -> Result<i64> {
    let amounts: Vec<i64> = if let Some(account) = account {
        sqlx::query_scalar("SELECT amount_minor FROM reconciliation_links WHERE transaction_id=? AND account_id=? AND active=1")
            .bind(id).bind(account).fetch_all(db).await?
    } else {
        sqlx::query_scalar(
            "SELECT amount_minor FROM reconciliation_links WHERE observation_id=? AND active=1",
        )
        .bind(id)
        .fetch_all(db)
        .await?
    };
    amounts.into_iter().try_fold(0, add)
}

fn remaining(amount: i64, allocated: i64) -> Result<i64> {
    amount
        .checked_sub(allocated)
        .ok_or_else(|| ApiError::invalid("Remaining amount is out of range."))
}
fn state(amount: i64, allocated: i64) -> &'static str {
    if allocated == 0 {
        "unmatched"
    } else if allocated == amount {
        "matched"
    } else {
        "partial"
    }
}

/// Projection only: accepting evidence never adds a ledger revision or changes balances.
pub async fn decorate_transaction(db: &mut SqliteConnection, value: &mut Value) -> Result<()> {
    let currency = text(value, "currency")?.to_owned();
    let id = text(value, "id")?.to_owned();
    let mut all = true;
    let mut any = false;
    for movement in value["movements"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("Invalid movements."))?
    {
        let amount = money(text(movement, "amount")?, &currency)?;
        let allocated = used(db, &id, Some(text(movement, "account_id")?)).await?;
        all &= amount == allocated;
        any |= allocated != 0;
    }
    value["reconciliation_state"] = json!(if all {
        "matched"
    } else if any {
        "partial"
    } else {
        "unmatched"
    });
    let rows=sqlx::query("SELECT l.account_id,l.observation_id,l.amount_minor,b.document FROM reconciliation_links l JOIN bank_observations b ON b.id=l.observation_id WHERE l.transaction_id=? AND l.active=1 ORDER BY l.observation_id")
        .bind(&id).fetch_all(&mut *db).await?;
    let mut evidence = Vec::new();
    for row in rows {
        let observation: Value = serde_json::from_str(row.get::<&str, _>(3))
            .map_err(|_| ApiError::invalid("Invalid stored observation."))?;
        evidence.push(json!({"account_id":row.get::<&str,_>(0),"observation_id":row.get::<&str,_>(1),"matched_amount":format_money(row.get::<i64,_>(2),&currency)?,"statement_date":observation["effective_date"],"statement_description":observation["description"],"statement_reference":observation["reference"]}));
    }
    value["reconciliation_evidence"] = json!(evidence);
    Ok(())
}

async fn items(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    side: &str,
) -> Result<Vec<Value>> {
    let account = text(s, "account_id")?;
    let from = text(s, "from")?;
    let to = text(s, "to")?;
    let currency = text(s, "currency")?;
    let mut result = Vec::new();
    if side == "ledger" {
        let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND json_extract(document,'$.effective_date')>=? AND json_extract(document,'$.effective_date')<? AND json_extract(document,'$.voided') IS NOT 1 AND EXISTS (SELECT 1 FROM json_each(resources.document,'$.movements') AS movement WHERE json_extract(movement.value,'$.account_id')=?) ORDER BY json_extract(document,'$.effective_date'),id")
            .bind(&p.household_id).bind(from).bind(to).bind(account).fetch_all(&mut *db).await?;
        let mut allocated_by_transaction: HashMap<String, i64> = HashMap::new();
        let links = sqlx::query("SELECT transaction_id,amount_minor FROM reconciliation_links WHERE account_id=? AND active=1")
            .bind(account).fetch_all(&mut *db).await?;
        for link in links {
            let id: String = link.get(0);
            let amount: i64 = link.get(1);
            let total = add(*allocated_by_transaction.get(&id).unwrap_or(&0), amount)?;
            allocated_by_transaction.insert(id, total);
        }
        for row in rows {
            let t: Value = serde_json::from_str(&row)
                .map_err(|_| ApiError::invalid("Invalid stored transaction."))?;
            if !storage::visible(db, p, "transactions", &t).await? {
                continue;
            }
            let date = text(&t, "effective_date")?;
            for movement in t["movements"].as_array().unwrap() {
                if movement["account_id"] != account {
                    continue;
                }
                let amount = money(text(movement, "amount")?, currency)?;
                let allocated = *allocated_by_transaction.get(text(&t, "id")?).unwrap_or(&0);
                result.push(json!({"id":t["id"],"ledger_id":t["id"],"account_id":account,"revision":t["revision"],"effective_date":date,"currency":currency,"amount":format_money(amount,currency)?,"remaining":format_money(remaining(amount,allocated)?,currency)?,"state":state(amount,allocated),"description":t["description"],"event_type":t["event_type"]}));
            }
        }
    } else if side == "statement" {
        let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM bank_observations WHERE household_id=? AND account_id=? AND effective_date>=? AND effective_date<? ORDER BY effective_date,id")
            .bind(&p.household_id).bind(account).bind(from).bind(to).fetch_all(&mut *db).await?;
        let mut allocated_by_observation: HashMap<String, i64> = HashMap::new();
        let links = sqlx::query("SELECT l.observation_id,l.amount_minor FROM reconciliation_links l JOIN bank_observations b ON b.id=l.observation_id WHERE b.household_id=? AND b.account_id=? AND l.active=1")
            .bind(&p.household_id).bind(account).fetch_all(&mut *db).await?;
        for link in links {
            let id: String = link.get(0);
            let amount: i64 = link.get(1);
            let total = add(*allocated_by_observation.get(&id).unwrap_or(&0), amount)?;
            allocated_by_observation.insert(id, total);
        }
        for row in rows {
            let mut v: Value = serde_json::from_str(&row)
                .map_err(|_| ApiError::invalid("Invalid observation."))?;
            let amount = money(text(&v, "amount")?, currency)?;
            let allocated = *allocated_by_observation.get(text(&v, "id")?).unwrap_or(&0);
            v["remaining"] = json!(format_money(remaining(amount, allocated)?, currency)?);
            v["state"] = json!(state(amount, allocated));
            result.push(v);
        }
    } else {
        return Err(ApiError::invalid("side must be ledger or statement."));
    }
    result.sort_by(|a, b| {
        (a["effective_date"].as_str(), a["id"].as_str())
            .cmp(&(b["effective_date"].as_str(), b["id"].as_str()))
    });
    for ignored in storage::list(db, p, "reconciliation_ignores").await? {
        if ignored["session_id"] == s["id"]
            && ignored["side"] == side
            && ignored["status"] == "active"
        {
            if let Some(row) = result
                .iter_mut()
                .find(|row| row["id"] == ignored["item_id"])
            {
                row["state"] = json!("ignored");
                row["ignore_id"] = ignored["id"].clone();
                row["ignore_revision"] = ignored["revision"].clone();
                row["ignore_reason"] = ignored["reason"].clone();
            }
        }
    }
    Ok(result)
}

async fn snapshot(db: &mut SqliteConnection, p: &Principal, s: &Value) -> Result<Value> {
    let ledger = items(db, p, s, "ledger").await?;
    let observations = items(db, p, s, "statement").await?;
    let currency = text(s, "currency")?;
    let sum = |values: &[Value]| -> Result<i64> {
        values.iter().try_fold(0, |total, v| {
            add(total, money(text(v, "amount")?, currency)?)
        })
    };
    let variance = remaining(sum(&observations)?, sum(&ledger)?)?;
    let ledger_unmatched = ledger
        .iter()
        .filter(|v| v["state"] != "matched" && v["state"] != "ignored")
        .count();
    let observation_unmatched = observations
        .iter()
        .filter(|v| v["state"] != "matched" && v["state"] != "ignored")
        .count();
    let account = storage::get(db, p, "accounts", text(s, "account_id")?).await?;
    let tz = balances::timezone(db, p, &account).await?;
    let checks = balances::history(db, p, &account)
        .await?
        .into_iter()
        .filter(|check| {
            let local = balances::timestamp(check["as_of"].as_str().unwrap_or_default())
                .expect("validated stored timestamp")
                .with_timezone(&tz)
                .date_naive()
                .to_string();
            check["voided"] != true
                && local.as_str() >= s["from"].as_str().unwrap_or_default()
                && local.as_str() < s["to"].as_str().unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let check_unresolved = checks
        .iter()
        .filter(|v| {
            v["current_variance"]
                .as_str()
                .and_then(|amount| money(amount, currency).ok())
                .is_none_or(|difference| difference != 0)
        })
        .count();
    Ok(
        json!({"ledger_snapshot":crate::auth::hash(&json!([ledger,observations,checks]).to_string()),"ledger_unmatched_count":ledger_unmatched,"observation_unmatched_count":observation_unmatched,"balance_check_unresolved_count":check_unresolved,"unresolved_count":ledger_unmatched+observation_unmatched+check_unresolved,"movement_variance":format_money(variance,currency)?,"coverage":"unknown","visibility":"authorized_accounts_only"}),
    )
}

async fn bump(db: &mut SqliteConnection, p: &Principal, s: &Value, action: &str) -> Result<Value> {
    storage::update(db, p, s, s.clone(), action).await
}
fn require_open(s: &Value) -> Result<()> {
    if s["state"] != "open" {
        return Err(ApiError::conflict(
            "Reopen the closed reconciliation session first.",
        ));
    }
    Ok(())
}

async fn accept(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    let ledger = items(db, p, s, "ledger").await?;
    let observations = items(db, p, s, "statement").await?;
    accept_with_items(db, p, s, body, &ledger, &observations).await
}

async fn accept_with_items(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
    ledger: &[Value],
    observations: &[Value],
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(body, &["decision", "allocations", "note"])?;
    domain::choice(body, "decision", &["accept"])?;
    if body
        .get("note")
        .is_some_and(|v| !v.is_string() && !v.is_null())
    {
        return Err(ApiError::invalid("note must be a string."));
    }
    let links = body["allocations"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 200)
        .ok_or_else(|| ApiError::invalid("allocations must contain 1 to 200 links."))?;
    let currency = text(s, "currency")?;
    let mut ledger_used: HashMap<String, i64> = HashMap::new();
    let mut observation_used: HashMap<String, i64> = HashMap::new();
    let mut unique = HashSet::new();
    let mut allocations = Vec::new();
    for link in links {
        api::allowed_body(
            link,
            &["ledger_id", "observation_id", "amount", "ledger_revision"],
        )?;
        let lid = text(link, "ledger_id")?;
        let oid = text(link, "observation_id")?;
        if !unique.insert((lid, oid)) {
            return Err(ApiError::invalid("Duplicate allocation pair."));
        }
        let l = ledger
            .iter()
            .find(|v| v["id"] == lid)
            .ok_or_else(ApiError::missing)?;
        let o = observations
            .iter()
            .find(|v| v["id"] == oid)
            .ok_or_else(ApiError::missing)?;
        if l["state"] == "ignored" || o["state"] == "ignored" {
            return Err(ApiError::conflict(
                "Restore ignored rows before matching them.",
            ));
        }
        if link["ledger_revision"] != l["revision"] {
            return Err(ApiError::revision(l["revision"].as_i64().unwrap()));
        }
        let amount = money(text(link, "amount")?, currency)?;
        if amount == 0 {
            return Err(ApiError::invalid("Allocation must be nonzero."));
        }
        for (map, id, item) in [(&mut ledger_used, lid, l), (&mut observation_used, oid, o)] {
            let total = add(*map.get(id).unwrap_or(&0), amount)?;
            let available = money(text(item, "remaining")?, currency)?;
            if amount.signum() != available.signum()
                || total.unsigned_abs() > available.unsigned_abs()
            {
                return Err(ApiError::conflict(
                    "Allocation exceeds remaining value or has the wrong sign.",
                ));
            }
            map.insert(id.to_owned(), total);
        }
        allocations.push(json!({"ledger_id":lid,"observation_id":oid,"amount":format_money(amount,currency)?,"ledger_revision":l["revision"]}));
    }
    let value = storage::create(db,p,"reconciliation_matches",json!({"session_id":s["id"],"account_id":s["account_id"],"state":"accepted","allocations":allocations,"note":body["note"]})).await?;
    for link in allocations {
        sqlx::query("INSERT INTO reconciliation_links(match_id,session_id,transaction_id,account_id,observation_id,amount_minor) VALUES(?,?,?,?,?,?)")
            .bind(text(&value,"id")?).bind(text(s,"id")?).bind(text(&link,"ledger_id")?).bind(text(s,"account_id")?)
            .bind(text(&link,"observation_id")?).bind(money(text(&link,"amount")?,currency)?).execute(&mut *db).await?;
    }
    Ok(value)
}

/// Retain original decisions and evidence when any linked ledger transaction changes.
pub async fn invalidate(db: &mut SqliteConnection, p: &Principal, transaction: &str) -> Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT match_id FROM reconciliation_links WHERE transaction_id=? AND active=1",
    )
    .bind(transaction)
    .fetch_all(&mut *db)
    .await?;
    let mut sessions = HashSet::new();
    for id in ids {
        let before = storage::raw(db, p, "reconciliation_matches", &id).await?;
        let mut after = before.clone();
        after["state"] = json!("needs_review");
        after["reason"] = json!("ledger_changed");
        storage::update(db, p, &before, after, "ledger_invalidated").await?;
        sqlx::query("UPDATE reconciliation_links SET active=0 WHERE match_id=?")
            .bind(&id)
            .execute(&mut *db)
            .await?;
        sessions.insert(text(&before, "session_id")?.to_owned());
    }
    for id in sessions {
        let before = storage::raw(db, p, "reconciliation_sessions", &id).await?;
        let mut after = before.clone();
        after["needs_review"] = json!(true);
        storage::update(db, p, &before, after, "ledger_invalidated").await?;
    }
    Ok(())
}

async fn apply_amendment(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    let s = s.clone();
    require_open(&s)?;
    api::allowed_body(
        body,
        &[
            "ledger_id",
            "ledger_revision",
            "observation_id",
            "proposed_amount",
            "proposed_date",
            "reason",
        ],
    )?;
    let ledger_id = text(body, "ledger_id")?;
    let observation_id = text(body, "observation_id")?;
    let ledger = items(db, p, &s, "ledger").await?;
    let observations = items(db, p, &s, "statement").await?;
    let l = ledger
        .iter()
        .find(|v| v["id"] == ledger_id)
        .ok_or_else(ApiError::missing)?;
    let o = observations
        .iter()
        .find(|v| v["id"] == observation_id)
        .ok_or_else(ApiError::missing)?;
    if l["revision"] != body["ledger_revision"] {
        return Err(ApiError::revision(l["revision"].as_i64().unwrap()));
    }
    let currency = text(&s, "currency")?;
    let original = money(text(l, "amount")?, currency)?;
    let proposed = money(text(body, "proposed_amount")?, currency)?;
    let observed = money(text(o, "amount")?, currency)?;
    if proposed == 0
        || proposed.signum() != original.signum()
        || observed.signum() != original.signum()
    {
        return Err(ApiError::invalid(
            "Proposed amount must have the same direction as the transaction and statement row.",
        ));
    }
    let proposed_date = body["proposed_date"]
        .as_str()
        .unwrap_or_else(|| o["effective_date"].as_str().unwrap_or_default());
    if proposed_date.len() != 10
        || !proposed_date
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        || &proposed_date[4..5] != "-"
        || &proposed_date[7..8] != "-"
        || proposed_date < text(&s, "from")?
        || proposed_date >= text(&s, "to")?
    {
        return Err(ApiError::invalid(
            "Proposed date must be in the review month.",
        ));
    }
    let reason = text(body, "reason")?;
    if reason.len() > 500 {
        return Err(ApiError::invalid(
            "Amendment reason must be 500 characters or fewer.",
        ));
    }
    let transaction = storage::get(db, p, "transactions", ledger_id).await?;
    if proposed == original && transaction["effective_date"] == proposed_date {
        return Err(ApiError::invalid(
            "Statement amount and date already match the transaction.",
        ));
    }
    for existing in storage::list(db, p, "reconciliation_amendments").await? {
        if existing["session_id"] == s["id"]
            && existing["ledger_id"] == ledger_id
            && existing["observation_id"] == observation_id
            && existing["status"] == "pending_money_manager_update"
        {
            return Err(ApiError::conflict(
                "An amendment for this transaction and statement row is already saved.",
            ));
        }
    }
    let difference = proposed
        .checked_sub(original)
        .ok_or_else(|| ApiError::invalid("Difference is out of range."))?;
    let proposed_abs = proposed
        .checked_abs()
        .ok_or_else(|| ApiError::invalid("Proposed amount is out of range."))?;
    let original_abs = money(text(&transaction, "amount")?, currency)?;
    let mut amended = transaction.clone();
    amended["amount"] = json!(format_money(proposed_abs, currency)?);
    amended["effective_date"] = json!(proposed_date);
    if amended["effective_date"] != transaction["effective_date"] {
        amended.as_object_mut().unwrap().remove("effective_at");
    }
    for movement in amended["movements"].as_array_mut().unwrap() {
        let value = if movement["account_id"] == s["account_id"] {
            proposed
        } else {
            -proposed
        };
        movement["amount"] = json!(format_money(value, currency)?);
    }
    if amended["event_type"] != "transfer" {
        let allocations = amended["allocations"].as_array_mut().unwrap();
        let mut left = proposed_abs;
        let count = allocations.len();
        for (index, allocation) in allocations.iter_mut().enumerate() {
            let value = if index + 1 == count {
                left
            } else {
                let prior = money(text(allocation, "amount")?, currency)?;
                i64::try_from((prior as i128 * proposed_abs as i128) / original_abs as i128)
                    .map_err(|_| ApiError::invalid("Amended allocation is out of range."))?
            };
            if value <= 0 || value > left {
                return Err(ApiError::invalid(
                    "Amended amount is too small for the existing category split. Edit allocations explicitly.",
                ));
            }
            allocation["amount"] = json!(format_money(value, currency)?);
            left -= value;
        }
    }
    api::validate_ledger(db, p, &amended).await?;
    let amendment = storage::create(
        db,
        p,
        "reconciliation_amendments",
        json!({
            "account_id":s["account_id"],"session_id":s["id"],"ledger_id":ledger_id,
            "ledger_revision":l["revision"],"observation_id":observation_id,
            "applied_transaction_revision":transaction["revision"].as_i64().unwrap_or(1)+1,
            "currency":currency,"original_transaction_amount":transaction["amount"],
            "original_movement":l["amount"],"proposed_movement":format_money(proposed,currency)?,
            "proposed_transaction_amount":format_money(proposed_abs,currency)?,
            "difference":format_money(difference,currency)?,
            "original_date":transaction["effective_date"],"proposed_date":proposed_date,
            "description":transaction["description"],"statement_description":o["description"],
            "statement_reference":o["reference"],"source_refs":transaction["source_refs"],
            "reason":reason,"status":"pending_money_manager_update"
        }),
    )
    .await?;
    amended["amendment"] = json!({"id":amendment["id"],"original_amount":transaction["amount"],"original_date":transaction["effective_date"],"reason":reason,"status":"pending_money_manager_update"});
    amended["reconciliation_state"] = json!("unmatched");
    invalidate(db, p, ledger_id).await?;
    storage::update(
        db,
        p,
        &transaction,
        amended,
        "reconciliation_amendment_applied",
    )
    .await?;
    let current = session(db, p, text(&s, "id")?).await?;
    bump(db, p, &current, "amendment_applied").await?;
    Ok(amendment)
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
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() == 2 {
        match method {
            "GET" => {
                api::allowed_query(q, &["account_id", "month", "cursor", "limit"])?;
                if let Some(account) = q.get("account_id") {
                    storage::get(db, p, "accounts", account).await?;
                }
                if let Some(month) = q.get("month") {
                    api::month_bounds(month)?;
                }
                let mut values = storage::list(db, p, "reconciliation_sessions").await?;
                values.retain(|v| {
                    q.get("account_id")
                        .is_none_or(|a| v["account_id"] == a.as_str())
                        && q.get("month").is_none_or(|m| v["month"] == m.as_str())
                });
                for value in &mut values {
                    decorate_session(db, p, value).await?;
                }
                return Ok((StatusCode::OK, api::paginate(values, q)?));
            }
            "POST" => {
                api::allowed_body(body, &["account_id", "month", "reason"])?;
                let account = storage::get(db, p, "accounts", text(body, "account_id")?).await?;
                if !["bank", "credit_card"].contains(&text(&account, "subtype")?) {
                    return Err(ApiError::invalid(
                        "Statement reconciliation requires a bank or credit-card account.",
                    ));
                }
                let (from, to) = api::month_bounds(text(body, "month")?)?;
                let existing: Option<String> = sqlx::query_scalar("SELECT id FROM resources WHERE household_id=? AND kind='reconciliation_sessions' AND json_extract(document,'$.account_id')=? AND json_extract(document,'$.month')=?")
                    .bind(&p.household_id).bind(text(&account,"id")?).bind(text(body,"month")?).fetch_optional(&mut *db).await?;
                if let Some(id) = existing {
                    let before = session(db, p, &id).await?;
                    api::revision(headers, body, &before)?;
                    return Ok((StatusCode::OK, reopen(db, p, &before, body).await?));
                }
                let value=storage::create(db,p,"reconciliation_sessions",json!({"account_id":account["id"],"month":body["month"],"from":from,"to":to,"currency":account["currency"],"state":"open","needs_review":false,"coverage":"unknown"})).await?;
                return Ok((StatusCode::CREATED, value));
            }
            _ => return Err(ApiError::missing()),
        }
    }
    if parts.len() < 3 {
        return Err(ApiError::missing());
    }
    let s = session(db, p, parts[2]).await?;
    if method == "POST" {
        api::revision(headers, body, &s)?;
    }
    let value = match (method, &parts[3..]) {
        ("GET", []) => {
            let mut s = s;
            decorate_session(db, p, &mut s).await?;
            s
        }
        ("GET", ["items"]) => {
            api::allowed_query(q, &["side", "state", "cursor", "limit"])?;
            let side = q
                .get("side")
                .ok_or_else(|| ApiError::invalid("side is required."))?;
            let mut values = items(db, p, &s, side).await?;
            if let Some(state) = q.get("state") {
                if !["unmatched", "partial", "matched", "ignored"].contains(&state.as_str()) {
                    return Err(ApiError::invalid("Invalid item state."));
                }
                values.retain(|v| v["state"] == state.as_str());
            }
            api::paginate(values, q)?
        }
        ("GET", ["candidates"]) => candidates(db, p, &s, q).await?,
        ("GET", ["internal-transfer-candidates"]) => transfer_candidates(db, p, &s, q).await?,
        ("POST", ["internal-transfer"]) => internal_transfer(db, p, &s, body).await?,
        ("POST", ["ignored"]) => ignore_rows(db, p, &s, body).await?,
        ("POST", ["ignored", ignore_id, "restore"]) => {
            restore_ignored(db, p, &s, ignore_id, body).await?
        }
        ("GET", ["created-ledger-entries"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            let entries = storage::list(db, p, "transactions")
                .await?
                .into_iter()
                .filter(|t| t["reconciliation_created"]["session_id"] == s["id"])
                .collect();
            api::paginate(entries, q)?
        }
        ("POST", ["created-ledger-entries"]) => create_from_observations(db, p, &s, body).await?,
        ("POST", ["matches"]) => {
            let mut matched = accept(db, p, &s, body).await?;
            matched["session_revision"] =
                bump(db, p, &s, "match_accepted").await?["revision"].clone();
            matched
        }
        ("POST", ["auto-match"]) => {
            require_open(&s)?;
            api::allowed_body(body, &[])?;
            let ledger = items(db, p, &s, "ledger").await?;
            let observations = items(db, p, &s, "statement").await?;
            let available = |v: &&Value| v["state"] == "unmatched" && v["remaining"] == v["amount"];
            let key = |v: &Value| {
                (
                    v["effective_date"].as_str().unwrap_or_default().to_owned(),
                    v["amount"].as_str().unwrap_or_default().to_owned(),
                    v["currency"].as_str().unwrap_or_default().to_owned(),
                )
            };
            let mut ledger_groups: HashMap<_, Vec<&Value>> = HashMap::new();
            let mut observation_groups: HashMap<_, Vec<&Value>> = HashMap::new();
            for row in ledger.iter().filter(available) {
                ledger_groups.entry(key(row)).or_default().push(row);
            }
            for row in observations.iter().filter(available) {
                observation_groups.entry(key(row)).or_default().push(row);
            }
            let mut matched = Vec::new();
            for l in ledger.iter().filter(available) {
                let row_key = key(l);
                if ledger_groups
                    .get(&row_key)
                    .is_none_or(|rows| rows.len() != 1)
                {
                    continue;
                }
                let Some(observation_rows) = observation_groups.get(&row_key) else {
                    continue;
                };
                if observation_rows.len() != 1 {
                    continue;
                }
                let o = observation_rows[0];
                matched.push(accept_with_items(db, p, &s, &json!({"decision":"accept","allocations":[{"ledger_id":l["id"],"ledger_revision":l["revision"],"observation_id":o["id"],"amount":l["amount"]}],"note":"Automatic exact date and amount match"}), &ledger, &observations).await?);
            }
            let revision = if matched.is_empty() {
                s["revision"].clone()
            } else {
                bump(db, p, &s, "automatic_matches_accepted").await?["revision"].clone()
            };
            json!({"matched_count":matched.len(),"session_revision":revision})
        }
        ("POST", ["matches", id, "reject"]) => {
            require_open(&s)?;
            api::allowed_body(body, &["reason", "match_revision"])?;
            let before = storage::raw(db, p, "reconciliation_matches", id).await?;
            if before["session_id"] != s["id"] {
                return Err(ApiError::missing());
            }
            authorize_replay(db, p, &before).await?;
            if body["match_revision"] != before["revision"] {
                return Err(ApiError::revision(before["revision"].as_i64().unwrap()));
            }
            if before["state"] == "rejected" {
                return Err(ApiError::conflict("Match is already rejected."));
            }
            let mut after = before.clone();
            after["state"] = json!("rejected");
            after["reason"] = json!(text(body, "reason")?);
            sqlx::query("UPDATE reconciliation_links SET active=0 WHERE match_id=?")
                .bind(id)
                .execute(&mut *db)
                .await?;
            let mut result = storage::update(db, p, &before, after, "match_rejected").await?;
            result["session_revision"] =
                bump(db, p, &s, "match_rejected").await?["revision"].clone();
            result
        }
        ("POST", ["missing-ledger-entry"]) => missing_entry(db, p, &s, body).await?,
        ("POST", ["corrections"]) => correction(db, p, &s, body).await?,
        ("GET", ["duplicates"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            api::paginate(duplicates(db, p, &s).await?, q)?
        }
        ("POST", ["duplicates", candidate, action])
            if ["merge-preview", "merge"].contains(action) =>
        {
            merge_duplicate(db, p, &s, candidate, action, body).await?
        }
        ("GET", ["matches"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            let mut matches = Vec::new();
            for matched in storage::list(db, p, "reconciliation_matches").await? {
                if matched["session_id"] == s["id"]
                    && authorize_replay(db, p, &matched).await.is_ok()
                {
                    matches.push(matched);
                }
            }
            api::paginate(matches, q)?
        }
        ("GET", ["amendments"]) => {
            api::allowed_query(q, &["cursor", "limit"])?;
            let mut amendments = Vec::new();
            for mut amendment in storage::list(db, p, "reconciliation_amendments").await? {
                if amendment["session_id"] != s["id"] {
                    continue;
                }
                if let Ok(transaction) =
                    storage::get(db, p, "transactions", text(&amendment, "ledger_id")?).await
                {
                    let revision = amendment
                        .get("applied_transaction_revision")
                        .unwrap_or(&amendment["ledger_revision"]);
                    amendment["stale"] = json!(transaction["revision"] != *revision);
                    if amendment["status"] == "pending_money_manager_update"
                        && transaction["money_manager_synced_at"].is_string()
                    {
                        amendment["status"] = json!("money_manager_updated");
                    }
                    amendments.push(amendment);
                }
            }
            amendments.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
            api::paginate(amendments, q)?
        }
        ("POST", ["amendments"]) => apply_amendment(db, p, &s, body).await?,
        ("POST", ["amendments", "batch"]) => {
            require_open(&s)?;
            api::allowed_body(body, &["amendments"])?;
            let entries = body["amendments"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("amendments must be an array."))?;
            if entries.is_empty() || entries.len() > 200 {
                return Err(ApiError::invalid("Select between 1 and 200 amendments."));
            }
            let mut ids = HashSet::new();
            for entry in entries {
                if !ids.insert(text(entry, "ledger_id")?) {
                    return Err(ApiError::invalid(
                        "A ledger transaction may appear only once in a group amendment.",
                    ));
                }
            }
            let mut saved = Vec::new();
            for entry in entries {
                saved.push(apply_amendment(db, p, &s, entry).await?);
            }
            json!({"amendments":saved})
        }
        ("POST", ["amendments", id, "cancel"]) => {
            require_open(&s)?;
            api::allowed_body(body, &["amendment_revision", "reason"])?;
            let before = storage::get(db, p, "reconciliation_amendments", id).await?;
            if before["session_id"] != s["id"] {
                return Err(ApiError::missing());
            }
            if body["amendment_revision"] != before["revision"] {
                return Err(ApiError::revision(before["revision"].as_i64().unwrap()));
            }
            if before["status"] != "pending_money_manager_update" {
                return Err(ApiError::conflict("Amendment is already cancelled."));
            }
            if before.get("applied_transaction_revision").is_some() {
                return Err(ApiError::conflict(
                    "This amendment changed the ledger. Correct the transaction to revise it.",
                ));
            }
            let mut after = before.clone();
            after["status"] = json!("cancelled");
            after["cancel_reason"] = json!(text(body, "reason")?);
            storage::update(db, p, &before, after, "amendment_cancelled").await?
        }
        ("POST", ["close"]) => {
            require_open(&s)?;
            api::allowed_body(body, &["reason", "closing_evidence"])?;
            let evidence = body["closing_evidence"]
                .as_object()
                .ok_or_else(|| ApiError::invalid("closing_evidence is required."))?;
            if evidence.is_empty() {
                return Err(ApiError::invalid("closing_evidence cannot be empty."));
            }
            let current = snapshot(db, p, &s).await?;
            // Unknown coverage always needs acknowledgement, even if all recorded rows match.
            text(body, "reason")?;
            let mut after = s.clone();
            after["state"] = json!("closed");
            after["needs_review"] = json!(false);
            after["closure"] = json!({"snapshot":current,"closing_evidence":evidence,"reason":body["reason"],"actor_id":p.user_id,"closed_at":storage::now()});
            storage::update(db, p, &s, after, "session_closed").await?
        }
        ("POST", ["reopen"]) => {
            api::allowed_body(body, &["reason"])?;
            reopen(db, p, &s, body).await?
        }
        _ => return Err(ApiError::missing()),
    };
    Ok((StatusCode::OK, value))
}

async fn decorate_session(db: &mut SqliteConnection, p: &Principal, s: &mut Value) -> Result<()> {
    let current = snapshot(db, p, s).await?;
    s["stale"] = json!(
        s["state"] == "closed"
            && s["closure"]["snapshot"]["ledger_snapshot"] != current["ledger_snapshot"]
    );
    s["current"] = current;
    Ok(())
}
async fn reopen(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    if s["state"] != "closed" {
        return Err(ApiError::conflict("Session is already open."));
    }
    let mut after = s.clone();
    after["state"] = json!("open");
    after["reopen_reason"] = json!(text(body, "reason")?);
    storage::update(db, p, s, after, "session_reopened").await
}
async fn candidates(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    q: &Query,
) -> Result<Value> {
    api::allowed_query(q, &["ledger_id", "observation_id", "cursor", "limit"])?;
    if q.contains_key("ledger_id") == q.contains_key("observation_id") {
        return Err(ApiError::invalid(
            "Select exactly one ledger_id or observation_id.",
        ));
    }
    let ledger = items(db, p, s, "ledger").await?;
    let observations = items(db, p, s, "statement").await?;
    let (selected, others, ledger_selected) = if let Some(id) = q.get("ledger_id") {
        (
            ledger
                .iter()
                .find(|v| v["id"] == id.as_str())
                .ok_or_else(ApiError::missing)?,
            &observations,
            true,
        )
    } else {
        (
            observations
                .iter()
                .find(|v| v["id"] == q["observation_id"])
                .ok_or_else(ApiError::missing)?,
            &ledger,
            false,
        )
    };
    let currency = text(s, "currency")?;
    if selected["state"] == "ignored" {
        return Err(ApiError::conflict(
            "Restore the ignored row before finding matches.",
        ));
    }
    let amount = money(text(selected, "remaining")?, currency)?;
    let date = domain::date(text(selected, "effective_date")?)?;
    let mut values = Vec::new();
    for other in others {
        let other_amount = money(text(other, "remaining")?, currency)?;
        let days = (domain::date(text(other, "effective_date")?)? - date).num_days();
        if other["state"] == "ignored"
            || amount == 0
            || other_amount == 0
            || amount.signum() != other_amount.signum()
            || days.abs() > 7
        {
            continue;
        }
        values.push(json!({"id":other["id"],"ledger_id":if ledger_selected { &selected["id"] } else { &other["id"] },"observation_id":if ledger_selected { &other["id"] } else { &selected["id"] },"amount_delta":format_money(remaining(other_amount,amount)?,currency)?,"date_delta_days":days,"exact_amount":amount==other_amount,"explanation":"Same account and currency; matching direction within seven days. Explicit acceptance required."}));
    }
    values.sort_by_key(|v| {
        (
            !v["exact_amount"].as_bool().unwrap(),
            v["date_delta_days"].as_i64().unwrap().abs(),
            v["id"].as_str().unwrap().to_owned(),
        )
    });
    api::paginate(values, q)
}
async fn transfer_candidates(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    q: &Query,
) -> Result<Value> {
    api::allowed_query(q, &["ledger_id", "observation_id", "cursor", "limit"])?;
    if q.contains_key("ledger_id") == q.contains_key("observation_id") {
        return Err(ApiError::invalid("Select one ledger or statement row."));
    }
    let (side, key) = if let Some(key) = q.get("ledger_id") {
        ("ledger", key)
    } else {
        ("statement", q.get("observation_id").unwrap())
    };
    let source = items(db, p, s, side)
        .await?
        .into_iter()
        .find(|v| v["id"] == key.as_str())
        .ok_or_else(ApiError::missing)?;
    if source["state"] != "unmatched"
        && !(side == "ledger" && source["state"] == "matched" && source["event_type"] != "transfer")
    {
        return Err(ApiError::conflict(
            "Choose an unmatched row or a matched ledger transaction for an internal transfer.",
        ));
    }
    let currency = text(s, "currency")?;
    let amount = money(
        text(
            &source,
            if source["state"] == "matched" {
                "amount"
            } else {
                "remaining"
            },
        )?,
        currency,
    )?;
    let opposite = amount
        .checked_neg()
        .ok_or_else(|| ApiError::invalid("Amount is out of range."))?;
    let date = domain::date(text(&source, "effective_date")?)?;
    let rows=sqlx::query("SELECT account_id,document FROM bank_observations WHERE household_id=? AND currency=? AND amount_minor=? AND effective_date>=? AND effective_date<?")
        .bind(&p.household_id).bind(currency).bind(opposite).bind(text(s,"from")?).bind(text(s,"to")?).fetch_all(&mut *db).await?;
    let ignored: HashSet<String> = storage::list(db, p, "reconciliation_ignores")
        .await?
        .into_iter()
        .filter(|v| v["status"] == "active" && v["side"] == "statement")
        .filter_map(|v| v["item_id"].as_str().map(str::to_owned))
        .collect();
    let mut candidates = Vec::new();
    for row in rows {
        let account_id = row.get::<&str, _>(0);
        if account_id == text(s, "account_id")? {
            continue;
        }
        let account = match storage::get(db, p, "accounts", account_id).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        if account["active"] == false {
            continue;
        }
        let observation: Value = serde_json::from_str(row.get::<&str, _>(1))
            .map_err(|_| ApiError::invalid("Invalid observation."))?;
        let observation_id = text(&observation, "id")?;
        if ignored.contains(observation_id) || used(db, observation_id, None).await? != 0 {
            continue;
        }
        let days = (domain::date(text(&observation, "effective_date")?)? - date)
            .num_days()
            .abs();
        if days > 7 {
            continue;
        }
        candidates.push(json!({"account_id":account_id,"account_name":account["name"],"observation_id":observation_id,"effective_date":observation["effective_date"],"amount":observation["amount"],"description":observation["description"],"date_delta_days":days}));
    }
    candidates.sort_by(|a, b| {
        (
            a["date_delta_days"].as_i64(),
            a["account_name"].as_str(),
            a["observation_id"].as_str(),
        )
            .cmp(&(
                b["date_delta_days"].as_i64(),
                b["account_name"].as_str(),
                b["observation_id"].as_str(),
            ))
    });
    api::paginate(candidates, q)
}
async fn transfer_session(
    db: &mut SqliteConnection,
    p: &Principal,
    source: &Value,
    account: &Value,
) -> Result<Option<Value>> {
    if !["bank", "credit_card"].contains(&text(account, "subtype")?) {
        return Ok(None);
    }
    let existing = storage::list(db, p, "reconciliation_sessions")
        .await?
        .into_iter()
        .find(|v| v["account_id"] == account["id"] && v["month"] == source["month"]);
    if let Some(session) = existing {
        require_open(&session)?;
        return Ok(Some(session));
    }
    Ok(Some(storage::create(db,p,"reconciliation_sessions",json!({"account_id":account["id"],"month":source["month"],"from":source["from"],"to":source["to"],"currency":account["currency"],"state":"open","needs_review":false,"coverage":"unknown"})).await?))
}
async fn internal_transfer(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(
        body,
        &[
            "ledger_id",
            "observation_id",
            "counterpart_account_id",
            "counterpart_observation_id",
            "description",
            "reason",
        ],
    )?;
    let ledger_id = body["ledger_id"].as_str();
    let observation_id = body["observation_id"].as_str();
    if ledger_id.is_none() && observation_id.is_none() {
        return Err(ApiError::invalid(
            "Select a ledger transaction or statement row.",
        ));
    }
    let reason = text(body, "reason")?;
    if reason.trim().is_empty() || reason.len() > 500 {
        return Err(ApiError::invalid("Give a reason of 1 to 500 characters."));
    }
    let target = storage::get(db, p, "accounts", text(body, "counterpart_account_id")?).await?;
    if target["id"] == s["account_id"]
        || target["active"] == false
        || target["currency"] != s["currency"]
    {
        return Err(ApiError::invalid(
            "Choose another active account in the same currency.",
        ));
    }
    let ledger = if let Some(key) = ledger_id {
        Some(
            items(db, p, s, "ledger")
                .await?
                .into_iter()
                .find(|v| v["id"] == key)
                .ok_or_else(ApiError::missing)?,
        )
    } else {
        None
    };
    let linked_source_observation = if let Some(ref row) = ledger {
        if row["state"] == "matched" {
            let ids: Vec<String> = sqlx::query_scalar("SELECT observation_id FROM reconciliation_links WHERE transaction_id=? AND account_id=? AND active=1")
                .bind(text(row, "id")?).bind(text(s, "account_id")?).fetch_all(&mut *db).await?;
            if ids.len() != 1 || row["event_type"] == "transfer" {
                return Err(ApiError::conflict(
                    "Only a transaction matched to one statement row can be converted here.",
                ));
            }
            Some(ids[0].clone())
        } else {
            None
        }
    } else {
        None
    };
    if let (Some(requested), Some(linked)) = (observation_id, linked_source_observation.as_deref())
    {
        if requested != linked {
            return Err(ApiError::conflict(
                "The selected statement row is not attached to this transaction.",
            ));
        }
    }
    let observation_id = observation_id.or(linked_source_observation.as_deref());
    let observation = if let Some(key) = observation_id {
        Some(
            items(db, p, s, "statement")
                .await?
                .into_iter()
                .find(|v| v["id"] == key)
                .ok_or_else(ApiError::missing)?,
        )
    } else {
        None
    };
    let linked_match = linked_source_observation.is_some();
    if ledger
        .as_ref()
        .is_some_and(|v| v["state"] != "unmatched" && !linked_match)
        || observation.as_ref().is_some_and(|v| {
            v["state"] != "unmatched" && !(linked_match && v["state"] == "matched")
        })
    {
        return Err(ApiError::conflict(
            "Internal transfer rows must be fully unmatched.",
        ));
    }
    let currency = text(s, "currency")?;
    let source_amount = money(
        text(ledger.as_ref().or(observation.as_ref()).unwrap(), "amount")?,
        currency,
    )?;
    if let Some(ref o) = observation {
        if money(text(o, "amount")?, currency)? != source_amount {
            return Err(ApiError::invalid(
                "The selected ledger and statement amounts differ. Amend them before connecting a transfer.",
            ));
        }
    }
    let magnitude = source_amount
        .checked_abs()
        .ok_or_else(|| ApiError::invalid("Amount is out of range."))?;
    let target_amount = source_amount
        .checked_neg()
        .ok_or_else(|| ApiError::invalid("Amount is out of range."))?;
    let date = ledger.as_ref().or(observation.as_ref()).unwrap()["effective_date"]
        .as_str()
        .unwrap();
    let target_session = transfer_session(db, p, s, &target).await?;
    let counterpart = if let Some(key) = body["counterpart_observation_id"].as_str() {
        let target_session = target_session
            .as_ref()
            .ok_or_else(|| ApiError::invalid("The destination account has no statement review."))?;
        let row = items(db, p, target_session, "statement")
            .await?
            .into_iter()
            .find(|v| v["id"] == key)
            .ok_or_else(ApiError::missing)?;
        if row["state"] != "unmatched" || money(text(&row, "amount")?, currency)? != target_amount {
            return Err(ApiError::conflict(
                "The destination statement row is unavailable or has a different amount.",
            ));
        }
        if (domain::date(text(&row, "effective_date")?)? - domain::date(date)?)
            .num_days()
            .abs()
            > 7
        {
            return Err(ApiError::invalid(
                "Statement legs must be within seven days.",
            ));
        }
        Some(row)
    } else {
        None
    };
    let transaction = if let Some(ref row) = ledger {
        let original = storage::get(db, p, "transactions", text(row, "id")?).await?;
        if original["voided"] == true {
            return Err(ApiError::conflict(
                "Voided transactions cannot become transfers.",
            ));
        }
        if original["event_type"] == "transfer" {
            let expected_target = format_money(target_amount, currency)?;
            if !original["movements"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["account_id"] == target["id"] && v["amount"] == expected_target)
            {
                return Err(ApiError::conflict(
                    "This transfer already points to a different account.",
                ));
            }
            original
        } else {
            if original["movements"].as_array().unwrap().len() != 1 {
                return Err(ApiError::invalid(
                    "Only single-account transactions can be converted to transfers.",
                ));
            }
            let mut changed = original.clone();
            let mut evidence_ids = original["reconciliation_created"]["observation_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut evidence_refs = original["reconciliation_created"]["statement_source_refs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for row in observation.iter().chain(counterpart.iter()) {
                if !evidence_ids.contains(&row["id"]) {
                    evidence_ids.push(row["id"].clone());
                }
                if !evidence_refs.contains(&row["raw_row_ref"]) {
                    evidence_refs.push(row["raw_row_ref"].clone());
                }
            }
            let action = if original["reconciliation_created"]["action"]
                .as_str()
                .is_some_and(|v| v.starts_with("add_"))
            {
                "add_transfer"
            } else {
                "update_transfer"
            };
            changed["event_type"] = json!("transfer");
            changed["movements"] = json!([{"account_id":s["account_id"],"amount":format_money(source_amount,currency)?},{"account_id":target["id"],"amount":format_money(target_amount,currency)?}]);
            changed["allocations"] = json!([]);
            changed["reconciliation_created"] = json!({"session_id":s["id"],"account_id":s["account_id"],"observation_ids":evidence_ids,"statement_source_refs":evidence_refs,"reason":reason,"status":"pending_money_manager_update","action":action,"original_event_type":original["reconciliation_created"]["original_event_type"].as_str().unwrap_or_else(||original["event_type"].as_str().unwrap_or("expense")),"original_allocations":original["reconciliation_created"]["original_allocations"].as_array().unwrap_or_else(||original["allocations"].as_array().unwrap())});
            api::validate_ledger(db, p, &changed).await?;
            invalidate(db, p, text(row, "id")?).await?;
            storage::update(db, p, &original, changed, "converted_to_internal_transfer").await?
        }
    } else {
        let description = body["description"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| {
                observation.as_ref().unwrap()["description"]
                    .as_str()
                    .unwrap_or("Internal transfer")
            });
        let refs: Vec<_> = observation
            .iter()
            .chain(counterpart.iter())
            .map(|v| v["raw_row_ref"].clone())
            .collect();
        let evidence_ids: Vec<_> = observation
            .iter()
            .chain(counterpart.iter())
            .map(|v| v["id"].clone())
            .collect();
        let value = json!({"event_type":"transfer","amount":format_money(magnitude,currency)?,"currency":currency,"effective_date":date,"description":description,"movements":[{"account_id":s["account_id"],"amount":format_money(source_amount,currency)?},{"account_id":target["id"],"amount":format_money(target_amount,currency)?}],"allocations":[],"entered_by":p.user_id,"voided":false,"source_refs":refs,"reconciliation_state":"unmatched","reconciliation_created":{"session_id":s["id"],"account_id":s["account_id"],"observation_ids":evidence_ids,"statement_source_refs":refs,"reason":reason,"status":"pending_money_manager_update","action":"add_transfer"}});
        api::validate_ledger(db, p, &value).await?;
        storage::create(db, p, "transactions", value).await?
    };
    let transaction_id = text(&transaction, "id")?;
    let revision = transaction["revision"].clone();
    let source_match = if let Some(ref row) = observation {
        Some(accept(db,p,s,&json!({"decision":"accept","note":reason,"allocations":[{"ledger_id":transaction_id,"ledger_revision":revision,"observation_id":row["id"],"amount":row["amount"]}]})).await?)
    } else {
        None
    };
    let target_match = if let (Some(target_session), Some(row)) =
        (target_session.as_ref(), counterpart.as_ref())
    {
        Some(accept(db,p,target_session,&json!({"decision":"accept","note":reason,"allocations":[{"ledger_id":transaction_id,"ledger_revision":revision,"observation_id":row["id"],"amount":row["amount"]}]})).await?)
    } else {
        None
    };
    let current = session(db, p, text(s, "id")?).await?;
    bump(db, p, &current, "internal_transfer_connected").await?;
    if target_match.is_some() {
        let target_session = target_session.as_ref().unwrap();
        let current = session(db, p, text(target_session, "id")?).await?;
        bump(db, p, &current, "internal_transfer_matched").await?;
    }
    Ok(
        json!({"transaction":transaction,"source_match":source_match,"counterpart_match":target_match,"counterpart_session_id":target_session.as_ref().map(|v|v["id"].clone())}),
    )
}
async fn ignore_rows(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(body, &["ledger_ids", "observation_ids", "reason"])?;
    let reason = text(body, "reason")?;
    if reason.trim().is_empty() || reason.len() > 500 {
        return Err(ApiError::invalid("Give a reason of 1 to 500 characters."));
    }
    let ledger_ids = body["ledger_ids"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("ledger_ids must be an array."))?;
    let observation_ids = body["observation_ids"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("observation_ids must be an array."))?;
    if ledger_ids.len() + observation_ids.len() == 0
        || ledger_ids.len() + observation_ids.len() > 200
    {
        return Err(ApiError::invalid(
            "Select between 1 and 200 rows to ignore.",
        ));
    }
    let ledger = items(db, p, s, "ledger").await?;
    let observations = items(db, p, s, "statement").await?;
    let mut unique = HashSet::new();
    let mut saved = Vec::new();
    for (side, ids, rows) in [
        ("ledger", ledger_ids, &ledger),
        ("statement", observation_ids, &observations),
    ] {
        for value in ids {
            let item_id = value
                .as_str()
                .ok_or_else(|| ApiError::invalid("Row ids must be strings."))?;
            if !unique.insert((side, item_id)) {
                return Err(ApiError::invalid("A row was selected twice."));
            }
            let row = rows
                .iter()
                .find(|v| v["id"] == item_id)
                .ok_or_else(ApiError::missing)?;
            if row["state"] != "unmatched" {
                return Err(ApiError::conflict(
                    "Only fully unmatched rows can be ignored.",
                ));
            }
            saved.push(storage::create(db,p,"reconciliation_ignores",json!({"account_id":s["account_id"],"session_id":s["id"],"side":side,"item_id":item_id,"amount":row["amount"],"effective_date":row["effective_date"],"description":row["description"],"reason":reason,"status":"active"})).await?);
        }
    }
    let current = session(db, p, text(s, "id")?).await?;
    bump(db, p, &current, "rows_ignored").await?;
    Ok(json!({"ignored":saved}))
}
async fn restore_ignored(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    ignore_id: &str,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(body, &["ignore_revision"])?;
    let before = storage::get(db, p, "reconciliation_ignores", ignore_id).await?;
    if before["session_id"] != s["id"] {
        return Err(ApiError::missing());
    }
    if before["revision"] != body["ignore_revision"] {
        return Err(ApiError::revision(before["revision"].as_i64().unwrap()));
    }
    if before["status"] != "active" {
        return Err(ApiError::conflict("Row is already restored."));
    }
    let mut after = before.clone();
    after["status"] = json!("restored");
    let restored = storage::update(db, p, &before, after, "row_restored").await?;
    let current = session(db, p, text(s, "id")?).await?;
    bump(db, p, &current, "row_restored").await?;
    Ok(restored)
}
async fn create_from_observations(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(
        body,
        &[
            "observation_ids",
            "description",
            "effective_date",
            "category_id",
            "scope",
            "reason",
        ],
    )?;
    let ids = body["observation_ids"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 200)
        .ok_or_else(|| ApiError::invalid("Select between 1 and 200 statement rows."))?;
    let description = text(body, "description")?;
    if description.trim().is_empty() {
        return Err(ApiError::invalid("Description is required."));
    }
    let reason = text(body, "reason")?;
    if reason.trim().is_empty() || reason.len() > 500 {
        return Err(ApiError::invalid("Give a reason of 1 to 500 characters."));
    }
    domain::choice(body, "scope", &["personal", "family"])?;
    let date = text(body, "effective_date")?;
    domain::date(date)?;
    if date < text(s, "from")? || date >= text(s, "to")? {
        return Err(ApiError::invalid("Date must be in the review month."));
    }
    if body
        .get("category_id")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(ApiError::invalid("category_id must be a string or null."));
    }
    let rows = items(db, p, s, "statement").await?;
    let currency = text(s, "currency")?;
    let mut selected = Vec::new();
    let mut unique = HashSet::new();
    let mut total = 0i64;
    for value in ids {
        let row_id = value
            .as_str()
            .ok_or_else(|| ApiError::invalid("Observation ids must be strings."))?;
        if !unique.insert(row_id) {
            return Err(ApiError::invalid("A statement row was selected twice."));
        }
        let row = rows
            .iter()
            .find(|v| v["id"] == row_id)
            .ok_or_else(ApiError::missing)?;
        if row["state"] == "ignored" || row["state"] == "matched" {
            return Err(ApiError::conflict(
                "Restore or unmatch selected statement rows first.",
            ));
        }
        let value = money(text(row, "remaining")?, currency)?;
        if value == 0 || (total != 0 && total.signum() != value.signum()) {
            return Err(ApiError::invalid(
                "Selected rows must have the same direction.",
            ));
        }
        total = add(total, value)?;
        selected.push(row.clone());
    }
    let magnitude = total
        .checked_abs()
        .ok_or_else(|| ApiError::invalid("Amount is out of range."))?;
    let ids: Vec<_> = selected.iter().map(|v| v["id"].clone()).collect();
    let refs: Vec<_> = selected.iter().map(|v| v["raw_row_ref"].clone()).collect();
    let transaction = json!({"event_type":if total<0 {"expense"} else {"income"},"amount":format_money(magnitude,currency)?,"currency":currency,"effective_date":date,"description":description,"movements":[{"account_id":s["account_id"],"amount":format_money(total,currency)?}],"allocations":[{"category_id":body["category_id"],"amount":format_money(magnitude,currency)?,"scope":body["scope"]}],"entered_by":p.user_id,"voided":false,"source_refs":refs,"reconciliation_state":"unmatched","reconciliation_created":{"session_id":s["id"],"account_id":s["account_id"],"observation_ids":ids,"statement_source_refs":refs,"reason":reason,"status":"pending_money_manager_update","action":"add_transaction"}});
    api::validate_ledger(db, p, &transaction).await?;
    let created = storage::create(db, p, "transactions", transaction).await?;
    let allocations:Vec<_>=selected.iter().map(|row|json!({"ledger_id":created["id"],"ledger_revision":created["revision"],"observation_id":row["id"],"amount":row["remaining"]})).collect();
    let matched = accept(
        db,
        p,
        s,
        &json!({"decision":"accept","note":reason,"allocations":allocations}),
    )
    .await?;
    let current = session(db, p, text(s, "id")?).await?;
    let updated = bump(db, p, &current, "statement_rows_created").await?;
    Ok(json!({"transaction":created,"match":matched,"session_revision":updated["revision"]}))
}
async fn missing_entry(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(body, &["observation_id", "transaction", "reason"])?;
    text(body, "reason")?;
    let rows = items(db, p, s, "statement").await?;
    let observation = rows
        .iter()
        .find(|v| v["id"] == body["observation_id"])
        .ok_or_else(ApiError::missing)?;
    if observation["state"] != "unmatched" {
        return Err(ApiError::conflict(
            "Observation already has a match; use explicit partial matching.",
        ));
    }
    let mut t = body["transaction"].clone();
    api::allowed_body(
        &t,
        &[
            "event_type",
            "amount",
            "currency",
            "effective_date",
            "effective_at",
            "description",
            "merchant",
            "movements",
            "allocations",
        ],
    )?;
    api::validate_ledger(db, p, &t).await?;
    if t["currency"] != s["currency"]
        || text(&t, "effective_date")? < text(s, "from")?
        || text(&t, "effective_date")? >= text(s, "to")?
    {
        return Err(ApiError::invalid(
            "Transaction must be in the session currency and period.",
        ));
    }
    let movement = t["movements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["account_id"] == s["account_id"])
        .ok_or_else(|| ApiError::invalid("Transaction must include the session account."))?;
    if money(text(movement, "amount")?, text(s, "currency")?)?
        != money(text(observation, "amount")?, text(s, "currency")?)?
    {
        return Err(ApiError::invalid(
            "Transaction movement must equal the observation.",
        ));
    }
    t["entered_by"] = json!(p.user_id);
    t["voided"] = json!(false);
    t["source_refs"] = json!([observation["raw_row_ref"]]);
    t["reconciliation_state"] = json!("unmatched");
    let transaction = storage::create(db, p, "transactions", t).await?;
    let matched=accept(db,p,s,&json!({"decision":"accept","note":body["reason"],"allocations":[{"ledger_id":transaction["id"],"ledger_revision":1,"observation_id":observation["id"],"amount":observation["amount"]}]})).await?;
    let transaction = storage::get(db, p, "transactions", text(&transaction, "id")?).await?;
    let session = bump(db, p, s, "missing_entry_created").await?;
    Ok(
        json!({"account_id":s["account_id"],"transaction":transaction,"match":matched,"session":session}),
    )
}

const EDIT_FIELDS: &[&str] = &[
    "event_type",
    "amount",
    "currency",
    "effective_date",
    "effective_at",
    "description",
    "merchant",
    "movements",
    "allocations",
];

fn impact(before: &Value, after: &Value) -> Result<Value> {
    let currency = text(before, "currency")?;
    let mut accounts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut spending = 0;
    let mut income = 0;
    for (value, direction) in [(before, -1i64), (after, 1i64)] {
        if value["voided"] == true {
            continue;
        }
        for movement in value["movements"].as_array().unwrap() {
            let amount = money(text(movement, "amount")?, currency)?
                .checked_mul(direction)
                .ok_or_else(|| ApiError::invalid("Impact is out of range."))?;
            let total = accounts
                .entry(text(movement, "account_id")?.into())
                .or_default();
            *total = add(*total, amount)?;
        }
        let amount = money(text(value, "amount")?, currency)?
            .checked_mul(direction)
            .ok_or_else(|| ApiError::invalid("Impact is out of range."))?;
        match text(value, "event_type")? {
            "expense" => spending = add(spending, amount)?,
            "refund" => spending = add(spending, -amount)?,
            "income" => income = add(income, amount)?,
            _ => (),
        }
    }
    let movements = accounts
        .into_iter()
        .map(|(id, amount)| Ok(json!({"account_id":id,"amount":format_money(amount,currency)?})))
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"currency":currency,"account_movement_deltas":movements,"net_spending_delta":format_money(spending,currency)?,"income_delta":format_money(income,currency)?,"before_allocations":before["allocations"],"after_allocations":if after["voided"]==true {json!([])} else {after["allocations"].clone()},"accepted_links":"return_to_review"}),
    )
}
fn preview_token(p: &Principal, s: &Value, before: &Value, after: &Value) -> String {
    crate::auth::hash(&json!([p.user_id, s["id"], s["revision"], before, after]).to_string())
}
async fn correction(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(
        body,
        &[
            "mode",
            "ledger_id",
            "ledger_revision",
            "changes",
            "reason",
            "preview_token",
        ],
    )?;
    domain::choice(body, "mode", &["preview", "apply"])?;
    let id = text(body, "ledger_id")?;
    if !items(db, p, s, "ledger")
        .await?
        .iter()
        .any(|v| v["id"] == id)
    {
        return Err(ApiError::missing());
    }
    let before = storage::get(db, p, "transactions", id).await?;
    if body["ledger_revision"] != before["revision"] {
        return Err(ApiError::revision(before["revision"].as_i64().unwrap()));
    }
    api::allowed_body(&body["changes"], EDIT_FIELDS)?;
    let mut after = before.clone();
    for field in EDIT_FIELDS {
        if let Some(value) = body["changes"].get(*field) {
            after[*field] = value.clone();
        }
    }
    if after["currency"] != before["currency"] {
        return Err(ApiError::invalid("Corrections cannot change currency."));
    }
    api::validate_ledger(db, p, &after).await?;
    let delta = impact(&before, &after)?;
    let token = preview_token(p, s, &before, &after);
    if body["mode"] == "preview" {
        return Ok(
            json!({"account_id":s["account_id"],"session_revision":s["revision"],"preview_token":token,"impact":delta,"transaction":before}),
        );
    }
    if text(body, "preview_token")? != token {
        return Err(ApiError::conflict(
            "Preview changed; preview the correction again.",
        ));
    }
    text(body, "reason")?;
    invalidate(db, p, id).await?;
    after["correction_reason"] = body["reason"].clone();
    after["reconciliation_state"] = json!("unmatched");
    let transaction = storage::update(db, p, &before, after, "reconciliation_correction").await?;
    // Invalidation can advance the same session; never overwrite that revision.
    let current = session(db, p, text(s, "id")?).await?;
    let session = bump(db, p, &current, "correction_applied").await?;
    Ok(
        json!({"account_id":s["account_id"],"transaction":transaction,"session":session,"impact":delta}),
    )
}
fn duplicate_id(a: &Value, b: &Value) -> String {
    let mut ids = [a["id"].as_str().unwrap(), b["id"].as_str().unwrap()];
    ids.sort();
    crate::auth::hash(&json!(ids).to_string())
}
fn same_event(a: &Value, b: &Value) -> bool {
    ["event_type", "currency", "effective_date", "movements"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
async fn duplicate_events(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
) -> Result<Vec<Value>> {
    let ids: HashSet<String> = items(db, p, s, "ledger")
        .await?
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    Ok(storage::list(db, p, "transactions")
        .await?
        .into_iter()
        .filter(|v| ids.contains(v["id"].as_str().unwrap()))
        .collect())
}
async fn duplicates(db: &mut SqliteConnection, p: &Principal, s: &Value) -> Result<Vec<Value>> {
    let events = duplicate_events(db, p, s).await?;
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    for event in events {
        let key = json!([
            event["event_type"],
            event["currency"],
            event["effective_date"],
            event["movements"]
        ])
        .to_string();
        groups.entry(key).or_default().push(event);
    }
    let mut result = Vec::new();
    for group in groups.values() {
        for (i, a) in group.iter().enumerate() {
            for b in &group[i + 1..] {
                if result.len() >= 2000 {
                    return Err(ApiError::invalid(
                        "Too many duplicate candidates in this period; review transactions directly.",
                    ));
                }
                result.push(json!({"id":duplicate_id(a,b),"transaction_ids":[a["id"],b["id"]],"revisions":[a["revision"],b["revision"]],"reason":"Same date, type, currency and account movements; these may be distinct genuine purchases."}));
            }
        }
    }
    result.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(result)
}
async fn merge_duplicate(
    db: &mut SqliteConnection,
    p: &Principal,
    s: &Value,
    candidate: &str,
    action: &str,
    body: &Value,
) -> Result<Value> {
    require_open(s)?;
    api::allowed_body(
        body,
        &[
            "survivor_id",
            "discarded_id",
            "survivor_revision",
            "discarded_revision",
            "preview_token",
            "reason",
        ],
    )?;
    let survivor_id = text(body, "survivor_id")?;
    let discarded_id = text(body, "discarded_id")?;
    if survivor_id == discarded_id {
        return Err(ApiError::invalid("Choose two different transactions."));
    }
    let events = duplicate_events(db, p, s).await?;
    let survivor = events
        .iter()
        .find(|v| v["id"] == survivor_id)
        .ok_or_else(ApiError::missing)?;
    let discarded = events
        .iter()
        .find(|v| v["id"] == discarded_id)
        .ok_or_else(ApiError::missing)?;
    if !same_event(survivor, discarded) || duplicate_id(survivor, discarded) != candidate {
        return Err(ApiError::conflict("Duplicate candidate changed."));
    }
    for (v, key) in [
        (survivor, "survivor_revision"),
        (discarded, "discarded_revision"),
    ] {
        if body[key] != v["revision"] {
            return Err(ApiError::revision(v["revision"].as_i64().unwrap()));
        }
    }
    let mut voided = discarded.clone();
    voided["voided"] = json!(true);
    voided["merged_into"] = survivor["id"].clone();
    let delta = impact(discarded, &voided)?;
    let token = preview_token(p, s, survivor, discarded);
    if action == "merge-preview" {
        return Ok(
            json!({"account_id":s["account_id"],"preview_token":token,"survivor":survivor,"discarded":discarded,"impact":delta}),
        );
    }
    if text(body, "preview_token")? != token {
        return Err(ApiError::conflict(
            "Preview changed; preview the merge again.",
        ));
    }
    text(body, "reason")?;
    invalidate(db, p, survivor_id).await?;
    invalidate(db, p, discarded_id).await?;
    let mut after = survivor.clone();
    let sources = after["source_refs"].as_array_mut().unwrap();
    for source in discarded["source_refs"].as_array().unwrap() {
        if !sources.contains(source) {
            sources.push(source.clone());
        }
    }
    after["reconciliation_state"] = json!("unmatched");
    let merged = storage::update(db, p, survivor, after, "duplicate_survivor").await?;
    voided["void_reason"] = body["reason"].clone();
    voided["reconciliation_state"] = json!("unmatched");
    let removed = storage::update(db, p, discarded, voided, "duplicate_merged").await?;
    sqlx::query(
        "UPDATE import_occurrences SET transaction_id=? WHERE household_id=? AND transaction_id=?",
    )
    .bind(survivor_id)
    .bind(&p.household_id)
    .bind(discarded_id)
    .execute(&mut *db)
    .await?;
    let current = session(db, p, text(s, "id")?).await?;
    let session = bump(db, p, &current, "duplicates_merged").await?;
    Ok(
        json!({"account_id":s["account_id"],"survivor":merged,"discarded":removed,"session":session,"impact":delta}),
    )
}
