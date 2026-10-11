use crate::{
    AppState,
    api::{self, Query},
    auth::{self, Principal},
    domain::{format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use axum::http::{HeaderMap, StatusCode};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct QuickExpenseConfig {
    pub user_id: String,
    pub household_id: String,
    pub default_account_id: String,
    pub account_ids: Vec<String>,
}

impl QuickExpenseConfig {
    async fn enabled(db: &mut SqliteConnection) -> Result<Option<Self>> {
        let row = sqlx::query("SELECT household_id,user_id,default_account_id,account_ids FROM quick_expense_settings WHERE enabled=1")
            .fetch_optional(db).await?;
        row.map(|row| {
            let account_ids: Vec<String> =
                serde_json::from_str(row.get::<&str, _>(3)).map_err(|_| unavailable())?;
            Ok(Self {
                household_id: row.get(0),
                user_id: row.get(1),
                default_account_id: row.get(2),
                account_ids,
            })
        })
        .transpose()
    }
}

pub async fn available(pool: &sqlx::SqlitePool) -> Result<bool> {
    let enabled: i64 = sqlx::query_scalar("SELECT count(*) FROM quick_expense_settings WHERE enabled=1")
        .fetch_one(pool)
        .await?;
    Ok(enabled > 0)
}

pub async fn settings(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    query: &Query,
    headers: &HeaderMap,
    body: &Value,
) -> Result<(StatusCode, Value)> {
    // Enabling an unauthenticated write route is reserved for the household owner.
    if p.role != "owner" {
        return Err(ApiError::forbidden());
    }
    let row = sqlx::query("SELECT enabled,user_id,default_account_id,account_ids,revision FROM quick_expense_settings WHERE household_id=?")
        .bind(&p.household_id).fetch_optional(&mut *db).await?;
    let current = if let Some(row) = row {
        json!({"enabled":row.get::<bool,_>(0),"user_id":row.get::<Option<String>,_>(1),
            "default_account_id":row.get::<Option<String>,_>(2),
            "account_ids":serde_json::from_str::<Vec<String>>(row.get::<&str,_>(3)).map_err(|_| unavailable())?,
            "revision":row.get::<i64,_>(4)})
    } else {
        json!({"enabled":false,"user_id":null,"default_account_id":null,"account_ids":[],"revision":0})
    };
    if method == "PATCH" {
        api::allowed_query(query, &[])?;
        api::allowed_body(
            body,
            &["enabled", "user_id", "default_account_id", "account_ids"],
        )?;
        api::revision(headers, body, &current)?;
        let enabled = body["enabled"]
            .as_bool()
            .ok_or_else(|| ApiError::invalid("enabled must be a boolean."))?;
        if !enabled {
            if current["enabled"] == true {
                sqlx::query("UPDATE quick_expense_settings SET enabled=0,revision=revision+1 WHERE household_id=?")
                    .bind(&p.household_id).execute(&mut *db).await?;
                let mut saved = current.clone();
                saved["enabled"] = json!(false);
                saved["revision"] = json!(current["revision"].as_i64().unwrap_or(0) + 1);
                storage::audit(
                    db,
                    p,
                    &p.household_id,
                    "quick_expense_settings_updated",
                    Some(&current),
                    Some(&saved),
                )
                .await?;
                return Ok((StatusCode::OK, saved));
            }
            return Ok((StatusCode::OK, current));
        }
        let user_id = text(body, "user_id")?;
        let default_account_id = text(body, "default_account_id")?;
        let ids = body["account_ids"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("account_ids must be an array."))?;
        let account_ids: Vec<String> = ids
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| ApiError::invalid("account_ids must contain nonempty IDs."))
            })
            .collect::<Result<_>>()?;
        if account_ids.is_empty()
            || !account_ids.contains(&default_account_id.to_owned())
            || account_ids.iter().collect::<HashSet<_>>().len() != account_ids.len()
        {
            return Err(ApiError::invalid(
                "Select distinct allowed accounts including the default account.",
            ));
        }
        let chosen = member_principal(db, &p.household_id, user_id).await?;
        for id in &account_ids {
            let value = storage::get(db, &chosen, "accounts", id).await?;
            // The owner should only configure accounts they can also inspect.
            storage::get(db, p, "accounts", id).await?;
            if value["active"] == false {
                return Err(ApiError::invalid("Allowed accounts must be active."));
            }
        }
        let existing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM quick_expense_settings WHERE enabled=1 AND household_id<>?",
        )
        .bind(&p.household_id)
        .fetch_one(&mut *db)
        .await?;
        if existing > 0 {
            return Err(ApiError::conflict(
                "Another household already has quick expenses enabled.",
            ));
        }
        let revision = current["revision"].as_i64().unwrap_or(0) + 1;
        sqlx::query("INSERT INTO quick_expense_settings(household_id,enabled,user_id,default_account_id,account_ids,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(household_id) DO UPDATE SET enabled=excluded.enabled,user_id=excluded.user_id,default_account_id=excluded.default_account_id,account_ids=excluded.account_ids,revision=excluded.revision")
            .bind(&p.household_id).bind(enabled).bind(user_id).bind(default_account_id)
            .bind(serde_json::to_string(&account_ids).map_err(|_| unavailable())?).bind(revision)
            .execute(&mut *db).await?;
        let saved = json!({"enabled":enabled,"user_id":user_id,"default_account_id":default_account_id,"account_ids":account_ids,"revision":revision});
        storage::audit(
            db,
            p,
            &p.household_id,
            "quick_expense_settings_updated",
            Some(&current),
            Some(&saved),
        )
        .await?;
        return Ok((StatusCode::OK, saved));
    }
    api::allowed_query(query, &["user_id"])?;
    let users = sqlx::query("SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND m.active=1 ORDER BY u.name")
        .bind(&p.household_id).fetch_all(&mut *db).await?;
    let members: Vec<Value> = users.into_iter().map(|r| json!({"id":r.get::<&str,_>(0),"name":r.get::<&str,_>(1),"email":r.get::<&str,_>(2)})).collect();
    let selected = query
        .get("user_id")
        .map(String::as_str)
        .or_else(|| current["user_id"].as_str())
        .unwrap_or(&p.user_id);
    let selected = if query.get("user_id").is_none() && !members.iter().any(|m| m["id"] == selected)
    {
        p.user_id.as_str()
    } else {
        selected
    };
    let chosen = member_principal(db, &p.household_id, selected).await?;
    let owner_accounts = storage::list(db, p, "accounts").await?;
    let owner_ids: HashSet<&str> = owner_accounts
        .iter()
        .filter_map(|v| v["id"].as_str())
        .collect();
    let accounts = storage::list(db, &chosen, "accounts")
        .await?
        .into_iter()
        .filter(|v| {
            v["active"] != false && v["id"].as_str().is_some_and(|id| owner_ids.contains(id))
        })
        .map(|v| json!({"id":v["id"],"name":v["name"],"currency":v["currency"]}))
        .collect::<Vec<_>>();
    Ok((
        StatusCode::OK,
        json!({"enabled":current["enabled"],"user_id":current["user_id"],
        "default_account_id":current["default_account_id"],"account_ids":current["account_ids"],
        "revision":current["revision"],"members":members,"accounts":accounts}),
    ))
}

async fn member_principal(
    db: &mut SqliteConnection,
    household: &str,
    user: &str,
) -> Result<Principal> {
    let row = sqlx::query(
        "SELECT id,role FROM memberships WHERE household_id=? AND user_id=? AND active=1",
    )
    .bind(household)
    .bind(user)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::missing)?;
    Ok(Principal {
        user_id: user.into(),
        household_id: household.into(),
        member_id: row.get(0),
        role: row.get(1),
        csrf: String::new(),
    })
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "quick_entry_unavailable",
        "Quick expense configuration is no longer valid.",
    )
}

async fn principal(db: &mut SqliteConnection, config: &QuickExpenseConfig) -> Result<Principal> {
    let row = sqlx::query("SELECT m.id,m.role FROM memberships m JOIN users u ON u.id=m.user_id JOIN households h ON h.id=m.household_id WHERE m.user_id=? AND m.household_id=? AND m.active=1")
        .bind(&config.user_id).bind(&config.household_id).fetch_optional(db).await?
        .ok_or_else(unavailable)?;
    Ok(Principal {
        user_id: config.user_id.clone(),
        household_id: config.household_id.clone(),
        member_id: row.get(0),
        role: row.get(1),
        csrf: String::new(),
    })
}

async fn account(
    db: &mut SqliteConnection,
    p: &Principal,
    config: &QuickExpenseConfig,
    id: &str,
) -> Result<Value> {
    if !config.account_ids.iter().any(|allowed| allowed == id) {
        return Err(ApiError::forbidden());
    }
    let value = storage::get(db, p, "accounts", id).await?;
    if value["active"] == false {
        return Err(ApiError::invalid("Quick expense account must be active."));
    }
    Ok(value)
}

async fn categories_for(
    db: &mut SqliteConnection,
    p: &Principal,
    account: &Value,
) -> Result<Vec<Value>> {
    let personal_account = account["visibility"] == "private" && account["owner_id"] == p.user_id;
    let grants: i64 = if personal_account {
        sqlx::query_scalar("SELECT count(*) FROM account_access WHERE account_id=?")
            .bind(text(account, "id")?)
            .fetch_one(&mut *db)
            .await?
    } else {
        0
    };
    let mut categories = storage::list(db, p, "categories").await?;
    categories.retain(|category| {
        category["kind"] == "expense"
            && category["archived"] != true
            && (category["visibility"] != "private" || (personal_account && grants == 0))
    });
    categories.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(categories)
}

pub async fn route(
    state: &AppState,
    method: &str,
    path: &str,
    query: &Query,
    headers: &HeaderMap,
    body: &Value,
) -> Result<(StatusCode, Value)> {
    let mut tx = state.pool.begin().await?;
    let config = QuickExpenseConfig::enabled(&mut tx)
        .await?
        .ok_or_else(ApiError::missing)?;
    match (method, path) {
        ("GET", "quick-transactions/options") => {
            api::allowed_query(query, &["account_id"])?;
            let p = principal(&mut tx, &config).await?;
            let mut accounts = Vec::new();
            for id in &config.account_ids {
                match account(&mut tx, &p, &config, id).await {
                    Ok(value) => accounts.push(
                        json!({"id":value["id"],"name":value["name"],"currency":value["currency"]}),
                    ),
                    Err(error)
                        if error.status == StatusCode::NOT_FOUND
                            || error.status == StatusCode::FORBIDDEN
                            || error.status == StatusCode::BAD_REQUEST => {}
                    Err(error) => return Err(error),
                }
            }
            if !accounts
                .iter()
                .any(|a| a["id"] == config.default_account_id)
            {
                return Err(unavailable());
            }
            let selected = query
                .get("account_id")
                .map(String::as_str)
                .unwrap_or(&config.default_account_id);
            let chosen = account(&mut tx, &p, &config, selected).await?;
            let rows = categories_for(&mut tx, &p, &chosen).await?;
            let by_id: HashMap<&str, &Value> = rows
                .iter()
                .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
                .collect();
            let categories = rows.iter().map(|c| {
                let mut names = Vec::new();
                let mut seen = HashSet::new();
                let mut current = Some(c);
                while let Some(item) = current {
                    let Some(id) = item["id"].as_str() else { break; };
                    if !seen.insert(id) { break; }
                    names.push(item["name"].as_str().unwrap_or("Category"));
                    current = item["parent_id"].as_str().and_then(|parent| by_id.get(parent).copied());
                }
                names.reverse();
                json!({"id":c["id"],"name":c["name"],"label":names.join(" › "),"parent_id":c["parent_id"]})
            }).collect::<Vec<_>>();
            Ok((
                StatusCode::OK,
                json!({"default_account_id":config.default_account_id,"selected_account_id":selected,"accounts":accounts,"categories":categories}),
            ))
        }
        ("POST", "quick-transactions") => {
            api::allowed_query(query, &[])?;
            let fields = [
                "amount",
                "category_id",
                "account_id",
                "description",
                "occurred_at",
            ];
            if let Some(field) = body
                .as_object()
                .and_then(|o| o.keys().find(|key| !fields.contains(&key.as_str())))
            {
                return Err(ApiError::invalid(format!("Unsupported field: {field}.")));
            }
            let key = api::idempotency_key(headers)?;
            let fingerprint = auth::hash(&format!("POST:quick-transactions:{body}"));
            let p = principal(&mut tx, &config).await?;
            let principal_key = format!("quick:{}:{}", p.household_id, p.user_id);
            let prior = sqlx::query(
                "SELECT fingerprint,status,response FROM idempotency WHERE principal=? AND key=?",
            )
            .bind(&principal_key)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(row) = prior {
                if row.get::<&str, _>(0) != fingerprint {
                    return Err(api::reused());
                }
                let value: Value = serde_json::from_str(row.get(2)).map_err(|_| unavailable())?;
                account(&mut tx, &p, &config, text(&value, "account_id")?).await?;
                storage::get(&mut tx, &p, "categories", text(&value, "category_id")?).await?;
                return Ok((
                    StatusCode::from_u16(row.get::<i64, _>(1) as u16)
                        .unwrap_or(StatusCode::CREATED),
                    value,
                ));
            }
            let account_id = match body.get("account_id") {
                None => config.default_account_id.as_str(),
                Some(Value::String(id)) if !id.is_empty() => id,
                _ => return Err(ApiError::invalid("account_id must be a nonempty string.")),
            };
            let chosen = account(&mut tx, &p, &config, account_id)
                .await
                .map_err(|error| {
                    if body.get("account_id").is_none()
                        && error.status != StatusCode::INTERNAL_SERVER_ERROR
                    {
                        unavailable()
                    } else {
                        error
                    }
                })?;
            let currency = text(&chosen, "currency")?;
            let amount = money(text(body, "amount")?, currency)?;
            if amount <= 0 {
                return Err(ApiError::invalid("Transaction amount must be positive."));
            }
            let category_id = text(body, "category_id")?;
            let category = storage::get(&mut tx, &p, "categories", category_id).await?;
            if category["kind"] != "expense" || category["archived"] == true {
                return Err(ApiError::invalid("Choose an active expense category."));
            }
            let description = match body.get("description") {
                None | Some(Value::Null) => "Quick expense",
                Some(Value::String(value)) if value.trim().is_empty() => "Quick expense",
                Some(Value::String(value)) => value.trim(),
                _ => return Err(ApiError::invalid("description must be a string.")),
            };
            if description.len() > 240 {
                return Err(ApiError::invalid("description must be 240 bytes or fewer."));
            }
            let household: String =
                sqlx::query_scalar("SELECT document FROM households WHERE id=?")
                    .bind(&p.household_id)
                    .fetch_one(&mut *tx)
                    .await?;
            let household: Value = serde_json::from_str(&household).map_err(|_| unavailable())?;
            let tz = text(&household, "timezone")?
                .parse::<chrono_tz::Tz>()
                .map_err(|_| unavailable())?;
            let at = match body.get("occurred_at") {
                None => Utc::now(),
                Some(Value::String(value)) => DateTime::parse_from_rfc3339(value)
                    .map_err(|_| {
                        ApiError::invalid(
                            "occurred_at must be an RFC3339 timestamp with an offset.",
                        )
                    })?
                    .with_timezone(&Utc),
                _ => {
                    return Err(ApiError::invalid(
                        "occurred_at must be an RFC3339 timestamp with an offset.",
                    ));
                }
            };
            let local = at.with_timezone(&tz);
            let scope = if household["family_only"] == true || chosen["visibility"] == "shared" {
                "family"
            } else {
                "personal"
            };
            let canonical_amount = format_money(amount, currency)?;
            let transaction = json!({
                "event_type":"expense", "amount":canonical_amount, "currency":currency,
                "effective_date":local.date_naive().to_string(), "effective_at":local.to_rfc3339(),
                "description":description,
                "movements":[{"account_id":account_id,"amount":format_money(-amount,currency)?}],
                "allocations":[{"category_id":category_id,"amount":canonical_amount,"scope":scope}],
            });
            let (_, saved) = api::route(
                &mut tx,
                &p,
                "POST",
                "transactions",
                &Query::new(),
                headers,
                &transaction,
            )
            .await?;
            let result = json!({"id":saved["id"],"message":"Expense recorded.","amount":canonical_amount,"currency":currency,"account_id":account_id,"category_id":category_id,"effective_date":saved["effective_date"]});
            sqlx::query("INSERT INTO idempotency(principal,key,fingerprint,status,response) VALUES(?,?,?,?,?)")
                .bind(&principal_key).bind(key).bind(fingerprint).bind(201_i64).bind(result.to_string())
                .execute(&mut *tx).await?;
            tx.commit().await?;
            Ok((StatusCode::CREATED, result))
        }
        _ => Err(ApiError::missing()),
    }
}
