use crate::{
    auth::Principal,
    domain::text,
    error::{ApiError, Result},
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

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
        _ => Ok(true),
    }
}
async fn attach_sources(db: &mut SqliteConnection, p: &Principal, value: &mut Value) -> Result<()> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT source_refs_json FROM import_occurrences WHERE household_id=? AND transaction_id=?",
    )
    .bind(&p.household_id)
    .bind(text(value, "id")?)
    .fetch_all(&mut *db)
    .await?;
    let refs = value["source_refs"]
        .as_array_mut()
        .ok_or_else(|| ApiError::invalid("Invalid transaction sources."))?;
    for row in rows {
        let extras: Vec<Value> = serde_json::from_str(&row)
            .map_err(|_| ApiError::invalid("Invalid source references."))?;
        for source in extras {
            if !refs.contains(&source) {
                refs.push(source);
            }
        }
    }
    Ok(())
}

pub async fn get(db: &mut SqliteConnection, p: &Principal, kind: &str, id: &str) -> Result<Value> {
    let mut value = raw(db, p, kind, id).await?;
    if !visible(db, p, kind, &value).await? {
        return Err(ApiError::missing());
    }
    if kind == "transactions" {
        attach_sources(db, p, &mut value).await?;
        crate::reconciliation::decorate_transaction(db, &mut value).await?;
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
    let mut result = Vec::new();
    for row in rows {
        let mut value: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid stored document."))?;
        if visible(db, p, kind, &value).await? {
            if kind == "transactions" {
                attach_sources(db, p, &mut value).await?;
                crate::reconciliation::decorate_transaction(db, &mut value).await?;
            }
            result.push(value);
        }
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
    let rows = sqlx::query("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND json_extract(document,'$.effective_date')>=? AND json_extract(document,'$.effective_date')<?")
        .bind(&p.household_id).bind(from).bind(to).fetch_all(&mut *db).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let mut value: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid stored document."))?;
        if visible(db, p, "transactions", &value).await? {
            if decorate {
                attach_sources(db, p, &mut value).await?;
                crate::reconciliation::decorate_transaction(db, &mut value).await?;
            }
            result.push(value);
        }
    }
    Ok(result)
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
