use crate::{
    auth::Principal,
    domain::text,
    error::{ApiError, Result},
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    Utc::now().to_rfc3339()
}
pub async fn raw(db: &mut SqliteConnection, p: &Principal, kind: &str, id: &str) -> Result<Value> {
    let s: Option<String> = sqlx::query_scalar(
        "SELECT document FROM resources WHERE id=? AND kind=? AND household_id=?",
    )
    .bind(id)
    .bind(kind)
    .bind(&p.household_id)
    .fetch_optional(db)
    .await?;
    s.map(|s| serde_json::from_str(&s).map_err(|_| ApiError::invalid("Invalid stored document.")))
        .transpose()?
        .ok_or_else(ApiError::missing)
}
pub async fn account_visible(db: &mut SqliteConnection, p: &Principal, v: &Value) -> Result<bool> {
    if v["owner_id"] == p.user_id || v["visibility"] == "shared" {
        return Ok(true);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_access WHERE account_id=? AND member_id=?",
    )
    .bind(text(v, "id")?)
    .bind(&p.member_id)
    .fetch_one(db)
    .await?;
    Ok(count > 0)
}
pub async fn visible(
    db: &mut SqliteConnection,
    p: &Principal,
    kind: &str,
    v: &Value,
) -> Result<bool> {
    match kind {
        "accounts" => account_visible(db, p, v).await,
        "categories" => Ok(v["owner_id"] == p.user_id || v["visibility"] != "private"),
        "transactions" => {
            if let Some(movements) = v["movements"].as_array() {
                for movement in movements {
                    let a = raw(db, p, "accounts", text(movement, "account_id")?).await?;
                    if !account_visible(db, p, &a).await? {
                        return Ok(false);
                    }
                }
            }
            Ok(true)
        }
        "reconciliation_sessions"
        | "reconciliation_matches"
        | "reconciliation_amendments"
        | "reconciliation_ignores"
        | "balance_checks" => {
            let account = raw(db, p, "accounts", text(v, "account_id")?).await?;
            account_visible(db, p, &account).await
        }
        "budgets" => Ok(v["owner_id"] == p.user_id || v["scope"] == "family"),
        "planned_items" => {
            if v["owner_id"] == p.user_id { return Ok(true); }
            if v["visibility"] != "shared" { return Ok(false); }
            if let Some(account_id) = v["account_id"].as_str() {
                let account = raw(db,p,"accounts",account_id).await?;
                if !account_visible(db,p,&account).await? { return Ok(false); }
            }
            if let Some(category_id) = v["category_id"].as_str() {
                let category = raw(db,p,"categories",category_id).await?;
                if category["visibility"] == "private" { return Ok(false); }
            }
            Ok(true)
        },
        "settlement_obligations" => Ok(v["owner_id"] == p.user_id),
        "investments" => Ok(v["owner_id"] == p.user_id || v["visibility"] == "shared"),
        "investment_goals" => {
            if v["owner_id"] != p.user_id && v["visibility"] != "shared" { return Ok(false); }
            for allocation in v["allocations"].as_array().into_iter().flatten() {
                let kind = if allocation["asset_kind"] == "holding" { "investments" } else { "accounts" };
                let asset = raw(db, p, kind, text(allocation, "asset_id")?).await?;
                if !visible_asset_for_goal(db, p, kind, &asset).await? { return Ok(false); }
            }
            Ok(true)
        },
        _ => Ok(true),
    }
}
async fn visible_asset_for_goal(db: &mut SqliteConnection, p: &Principal, kind: &str, asset: &Value) -> Result<bool> {
    match kind {
        "investments" => Ok(asset["owner_id"] == p.user_id || asset["visibility"] == "shared"),
        "accounts" => account_visible(db, p, asset).await,
        _ => Ok(false),
    }
}
/// Only authorized transactions may be passed here. JSON IDs use one bound
/// parameter, avoiding SQLite's variable limit even for large imports.
async fn decorate_transactions(
    db: &mut SqliteConnection,
    p: &Principal,
    values: &mut [Value],
) -> Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = values
        .iter()
        .map(|v| text(v, "id"))
        .collect::<Result<_>>()?;
    let rows = sqlx::query("SELECT transaction_id,source_refs_json FROM import_occurrences WHERE household_id=? AND transaction_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
        .bind(&p.household_id).bind(serde_json::to_string(&ids).unwrap()).fetch_all(&mut *db).await?;
    let mut sources: HashMap<String, Vec<Value>> = HashMap::new();
    for row in rows {
        let extras: Vec<Value> = serde_json::from_str(row.get::<&str, _>(1))
            .map_err(|_| ApiError::invalid("Invalid source references."))?;
        sources.entry(row.get(0)).or_default().extend(extras);
    }
    for value in values.iter_mut() {
        let extras = sources.remove(text(value, "id")?).unwrap_or_default();
        let refs = value["source_refs"]
            .as_array_mut()
            .ok_or_else(|| ApiError::invalid("Invalid transaction sources."))?;
        for source in extras {
            if !refs.contains(&source) {
                refs.push(source);
            }
        }
    }
    crate::reconciliation::decorate_transactions(db, values).await
}

pub async fn get(db: &mut SqliteConnection, p: &Principal, kind: &str, id: &str) -> Result<Value> {
    let mut value = raw(db, p, kind, id).await?;
    if !visible(db, p, kind, &value).await? {
        return Err(ApiError::missing());
    }
    if kind == "transactions" {
        decorate_transactions(db, p, std::slice::from_mut(&mut value)).await?;
    }
    Ok(value)
}
pub async fn list(db: &mut SqliteConnection, p: &Principal, kind: &str) -> Result<Vec<Value>> {
    let rows =
        sqlx::query("SELECT document FROM resources WHERE household_id=? AND kind=? ORDER BY id")
            .bind(&p.household_id)
            .bind(kind)
            .fetch_all(&mut *db)
            .await?;
    let account_visibility = if kind == "transactions" {
        Some(visible_accounts(db, p).await?)
    } else {
        None
    };
    let mut result = Vec::new();
    for row in rows {
        let value: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid stored document."))?;
        let permitted = if let Some(accounts) = &account_visibility {
            transaction_visible(&value, accounts)?
        } else {
            visible(db, p, kind, &value).await?
        };
        if permitted {
            result.push(value);
        }
    }
    if kind == "transactions" {
        decorate_transactions(db, p, &mut result).await?;
    }
    Ok(result)
}

pub async fn transactions_in_period(
    db: &mut SqliteConnection,
    p: &Principal,
    from: &str,
    to: &str,
    decorate: bool,
) -> Result<Vec<Value>> {
    transactions_in_range(db, p, Some(from), Some(to), decorate).await
}

/// Push optional date bounds into SQLite so monthly lists use the period index.
pub async fn transactions_in_range(
    db: &mut SqliteConnection,
    p: &Principal,
    from: Option<&str>,
    to: Option<&str>,
    decorate: bool,
) -> Result<Vec<Value>> {
    let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT document FROM resources WHERE kind='transactions' AND household_id=",
    );
    query.push_bind(&p.household_id);
    if let Some(from) = from {
        query
            .push(" AND json_extract(document,'$.effective_date')>=")
            .push_bind(from);
    }
    if let Some(to) = to {
        query
            .push(" AND json_extract(document,'$.effective_date')<")
            .push_bind(to);
    }
    // Preserve resource-list order for callers that do not apply date sorting.
    query.push(" ORDER BY id");
    let rows = query.build().fetch_all(&mut *db).await?;
    let accounts = visible_accounts(db, p).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let value: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid stored document."))?;
        if transaction_visible(&value, &accounts)? {
            result.push(value);
        }
    }
    if decorate {
        decorate_transactions(db, p, &mut result).await?;
    }
    Ok(result)
}

async fn visible_accounts(
    db: &mut SqliteConnection,
    p: &Principal,
) -> Result<HashMap<String, bool>> {
    let rows = sqlx::query("SELECT r.id,r.document,a.account_id FROM resources r LEFT JOIN account_access a ON a.account_id=r.id AND a.member_id=? WHERE r.household_id=? AND r.kind='accounts'")
        .bind(&p.member_id).bind(&p.household_id).fetch_all(db).await?;
    let mut accounts = HashMap::with_capacity(rows.len());
    for row in rows {
        let document: Value = serde_json::from_str(row.get::<&str, _>(1))
            .map_err(|_| ApiError::invalid("Invalid stored document."))?;
        accounts.insert(
            row.get::<String, _>(0),
            document["owner_id"] == p.user_id
                || document["visibility"] == "shared"
                || row.get::<Option<String>, _>(2).is_some(),
        );
    }
    Ok(accounts)
}

fn transaction_visible(value: &Value, accounts: &HashMap<String, bool>) -> Result<bool> {
    let Some(movements) = value["movements"].as_array() else {
        return Ok(true);
    };
    for movement in movements {
        let id = text(movement, "account_id")?;
        if !accounts.get(id).copied().ok_or_else(ApiError::missing)? {
            return Ok(false);
        }
    }
    Ok(true)
}
pub async fn audit(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    action: &str,
    before: Option<&Value>,
    after: Option<&Value>,
) -> Result<()> {
    sqlx::query("INSERT INTO audit_events(household_id,actor_id,resource_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&p.household_id).bind(&p.user_id).bind(id).bind(action).bind(before.map(Value::to_string)).bind(after.map(Value::to_string)).bind(now()).execute(db).await?;
    Ok(())
}
pub async fn create(
    db: &mut SqliteConnection,
    p: &Principal,
    kind: &str,
    mut value: Value,
) -> Result<Value> {
    if kind == "transactions" && value["source_refs"].as_array().is_some_and(Vec::is_empty) {
        let document: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
            .bind(&p.household_id).fetch_one(&mut *db).await?;
        let household: Value = serde_json::from_str(&document)
            .map_err(|_| ApiError::invalid("Invalid household settings."))?;
        if household["money_manager_extension"] == false {
            value["money_manager_excluded"] = json!(true);
        }
    }
    let id = id();
    value["id"] = json!(id);
    value["revision"] = json!(1);
    value["owner_id"] = json!(p.user_id);
    value["created_at"] = json!(now());
    sqlx::query("INSERT INTO resources(id,household_id,owner_id,kind,document,created_at) VALUES(?,?,?,?,?,?)")
        .bind(&id).bind(&p.household_id).bind(&p.user_id).bind(kind).bind(value.to_string()).bind(now()).execute(&mut *db).await?;
    audit(db, p, &id, "create", None, Some(&value)).await?;
    Ok(value)
}
pub async fn update(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    mut value: Value,
    action: &str,
) -> Result<Value> {
    let id = text(before, "id")?;
    let revision = before["revision"].as_i64().unwrap_or(1) + 1;
    value["id"] = before["id"].clone();
    value["owner_id"] = before["owner_id"].clone();
    value["revision"] = json!(revision);
    value["created_at"] = before["created_at"].clone();
    sqlx::query("UPDATE resources SET document=?,revision=? WHERE id=? AND household_id=?")
        .bind(value.to_string())
        .bind(revision)
        .bind(id)
        .bind(&p.household_id)
        .execute(&mut *db)
        .await?;
    audit(db, p, id, action, Some(before), Some(&value)).await?;
    Ok(value)
}
pub async fn history(
    db: &mut SqliteConnection,
    p: &Principal,
    kind: &str,
    id: &str,
) -> Result<Value> {
    get(db, p, kind, id).await?;
    let rows=sqlx::query("SELECT action,before_json,after_json,created_at FROM audit_events WHERE household_id=? AND resource_id=? ORDER BY id")
        .bind(&p.household_id).bind(id).fetch_all(&mut *db).await?;
    let mut data = vec![];
    for r in rows {
        let before: Option<Value> = r
            .get::<Option<String>, _>(1)
            .and_then(|s| serde_json::from_str(&s).ok());
        let after: Option<Value> = r
            .get::<Option<String>, _>(2)
            .and_then(|s| serde_json::from_str(&s).ok());
        // Access may have changed between revisions. Never reveal old private accounts.
        let mut allowed = true;
        for snapshot in [&before, &after].into_iter().flatten() {
            if !visible(db, p, kind, snapshot).await? {
                allowed = false;
            }
        }
        if allowed {
            data.push(json!({"action":r.get::<&str,_>(0),"before":before,"after":after,"created_at":r.get::<&str,_>(3)}));
        }
    }
    Ok(json!({"data":data,"page":{},"meta":{}}))
}
