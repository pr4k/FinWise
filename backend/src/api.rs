use crate::{
    AppState,
    auth::{self, Principal},
    balances,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    imports, planning, reconciliation, recurring, storage,
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;

pub type Query = HashMap<String, String>;
type Reply = (StatusCode, Value);
const BODY_LIMIT: usize = 1024 * 1024;
fn ok(v: Value) -> Result<Reply> {
    Ok((StatusCode::OK, v))
}
fn created(v: Value) -> Result<Reply> {
    Ok((StatusCode::CREATED, v))
}
fn no_content() -> Result<Reply> {
    Ok((StatusCode::NO_CONTENT, Value::Null))
}
fn collection(data: Vec<Value>) -> Value {
    json!({"data":data,"page":{},"meta":{}})
}
fn unsupported() -> ApiError {
    ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "not_implemented",
        "This workflow is not available in this backend release.",
    )
}

pub async fn dispatch(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .map(str::to_owned)
        .unwrap_or_else(storage::id);
    let mut cookie = None;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        process(&state, request, &mut cookie),
    )
    .await
    .unwrap_or_else(|_| {
        Err(ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "request_timeout",
            "Request timed out; retry using the same idempotency key.",
        ))
    });
    let mut response = match result {
        Ok((StatusCode::NO_CONTENT, _)) => StatusCode::NO_CONTENT.into_response(),
        Ok((status, value)) => (status, Json(value)).into_response(),
        Err(error) => (error.status, Json(error.body(&request_id))).into_response(),
    };
    let headers = response.headers_mut();
    headers.insert("x-request-id", request_id.parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    if headers.contains_key(header::CONTENT_TYPE) {
        headers.insert(
            header::CONTENT_TYPE,
            "application/json; charset=utf-8".parse().unwrap(),
        );
    }
    if let Some(token) = cookie {
        let secure = if state.secure_cookies { "; Secure" } else { "" };
        let age = if token.is_empty() { 0 } else { 604800 };
        headers.insert(
            header::SET_COOKIE,
            format!(
                "finwise_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{secure}"
            )
            .parse()
            .unwrap(),
        );
    }
    response
}
async fn process(state: &AppState, request: Request, cookie: &mut Option<String>) -> Result<Reply> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().trim_end_matches('/');
    let method = parts.method.as_str();
    if method == "GET" && (path == "/health/live" || path == "/api/v1/health/live") {
        return ok(json!({"status":"ok"}));
    }
    if method == "GET" && (path == "/health/ready" || path == "/api/v1/health/ready") {
        sqlx::query("SELECT count(*) FROM households")
            .execute(&state.pool)
            .await?;
        return ok(json!({"status":"ready"}));
    }
    let path = path
        .strip_prefix("/api/v1/")
        .ok_or_else(ApiError::missing)?;
    let query: Query = axum::extract::Query::try_from_uri(&parts.uri)
        .map_err(|_| ApiError::invalid("Invalid query string."))?
        .0;
    if let Some(operation) = operation(method, path)
        && operation["x-implemented"] == false
    {
        let mut db = state.pool.acquire().await?;
        let p = auth::principal(&mut db, &parts.headers).await?;
        if method != "GET" {
            auth::csrf(&p, &parts.headers)?;
        }
        return Err(unsupported());
    }
    if method == "POST" && path == "imports" {
        return imports::upload(state, Request::from_parts(parts, body)).await;
    }
    let bytes = to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Request exceeds the 1 MiB JSON limit.",
        )
    })?;
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        if parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "Use application/json.",
            ));
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid("Malformed JSON."))?;
        if !value.is_object() {
            return Err(ApiError::invalid("JSON body must be an object."));
        }
        value
    };
    if method == "GET" && path == "auth/bootstrap-status" {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM households")
            .fetch_one(&state.pool)
            .await?;
        return ok(json!({"required":count==0,"requires_https":state.secure_cookies}));
    }
    if method == "GET" && path == "openapi.json" {
        return ok(openapi());
    }
    if method == "POST" && ["auth/bootstrap", "auth/login"].contains(&path) {
        // Persist failed attempts outside the domain transaction.
        let identity = if path == "auth/bootstrap" {
            "bootstrap"
        } else {
            body["email"].as_str().unwrap_or("unknown")
        };
        auth::throttle(&mut *state.pool.acquire().await?, &identity.to_lowercase()).await?;
        let mut tx = state.pool.begin().await?;
        let mut p;
        let status;
        if path == "auth/bootstrap" {
            let key = idempotency_key(&parts.headers)?;
            let fingerprint = auth::hash(&body.to_string());
            let existing=sqlx::query("SELECT fingerprint,response FROM idempotency WHERE principal='bootstrap' AND key=?").bind(key).fetch_optional(&mut *tx).await?;
            if let Some(row) = existing {
                if row.get::<&str, _>(0) != fingerprint {
                    return Err(reused());
                }
                p = auth::login(&mut tx, &body["owner"]).await?;
            } else {
                p = auth::bootstrap(&mut tx, &body).await?;
                sqlx::query("INSERT INTO idempotency(principal,key,fingerprint,status,response) VALUES('bootstrap',?,?,201,'{}')").bind(key).bind(fingerprint).execute(&mut *tx).await?;
            }
            status = StatusCode::CREATED;
        } else {
            p = auth::login(&mut tx, &body).await?;
            status = StatusCode::OK;
        }
        let token = auth::start_session(&mut tx, &mut p, &parts.headers).await?;
        storage::audit(&mut tx, &p, &p.user_id, "session_started", None, None).await?;
        let mut value = auth::me(&mut tx, &p).await?;
        value["csrf_token"] = json!(p.csrf);
        tx.commit().await?;
        *cookie = Some(token);
        return Ok((status, value));
    }
    if !known_route(method, path) {
        return Err(ApiError::missing());
    }
    if method == "POST"
        && path.starts_with("invites/")
        && path.ends_with("/accept")
        && auth::cookie_token(&parts.headers).is_none()
    {
        auth::throttle(&mut *state.pool.acquire().await?, "invite-registration").await?;
        let mut tx = state.pool.begin().await?;
        let token = path.split('/').nth(1).unwrap_or_default();
        let key = idempotency_key(&parts.headers)?;
        let fingerprint = auth::hash(&body.to_string());
        let principal_key = format!("invite:{}", auth::hash(token));
        let cached =
            sqlx::query("SELECT fingerprint,response FROM idempotency WHERE principal=? AND key=?")
                .bind(&principal_key)
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?;
        let mut p;
        let response;
        if let Some(row) = cached {
            if row.get::<&str, _>(0) != fingerprint {
                return Err(reused());
            }
            p = auth::login(&mut tx, &body).await?;
            response = serde_json::from_str::<Value>(row.get(1))
                .map_err(|_| ApiError::invalid("Invalid replay data."))?;
        } else {
            let invite=sqlx::query("SELECT household_id,email,role FROM invites WHERE token_hash=? AND used=0 AND expires_at>?").bind(auth::hash(token)).bind(Utc::now().timestamp()).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
            let email = text(&body, "email")?.trim().to_lowercase();
            if email != invite.get::<String, _>(1).to_lowercase() {
                return Err(ApiError::missing());
            }
            let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email=?")
                .bind(&email)
                .fetch_one(&mut *tx)
                .await?;
            if exists > 0 {
                return Err(ApiError::conflict("Sign in to accept this invite."));
            }
            let password = text(&body, "password")?;
            auth::password_valid(password)?;
            let encoded = auth::password_hash(password.into()).await?;
            p = Principal {
                user_id: storage::id(),
                household_id: invite.get(0),
                member_id: storage::id(),
                role: invite.get(2),
                csrf: String::new(),
            };
            sqlx::query("INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)")
                .bind(&p.user_id)
                .bind(email)
                .bind(text(&body, "name")?)
                .bind(encoded)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO memberships(id,household_id,user_id,role) VALUES(?,?,?,?)")
                .bind(&p.member_id)
                .bind(&p.household_id)
                .bind(&p.user_id)
                .bind(&p.role)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE invites SET used=1 WHERE token_hash=?")
                .bind(auth::hash(token))
                .execute(&mut *tx)
                .await?;
            response =
                json!({"id":p.member_id,"household_id":p.household_id,"role":p.role,"revision":1});
            storage::audit(
                &mut tx,
                &p,
                &p.member_id,
                "invite_accepted",
                None,
                Some(&response),
            )
            .await?;
            sqlx::query("INSERT INTO idempotency(principal,key,fingerprint,status,response) VALUES(?,?,?,200,?)").bind(&principal_key).bind(key).bind(fingerprint).bind(response.to_string()).execute(&mut *tx).await?;
        }
        let session = auth::start_session(&mut tx, &mut p, &parts.headers).await?;
        tx.commit().await?;
        *cookie = Some(session);
        return ok(response);
    }
    let mut tx = state.pool.begin().await?;
    let p = auth::principal(&mut tx, &parts.headers).await?;
    if path.starts_with("data/reset") {
        auth::admin(&p)?;
    }
    let mutation = !matches!(method, "GET" | "HEAD" | "OPTIONS");
    if mutation {
        auth::csrf(&p, &parts.headers)?;
    }
    if method == "POST" && path == "auth/logout" {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(auth::hash(
                auth::cookie_token(&parts.headers).unwrap_or_default(),
            ))
            .execute(&mut *tx)
            .await?;
        storage::audit(&mut tx, &p, &p.user_id, "logout", None, None).await?;
        tx.commit().await?;
        *cookie = Some(String::new());
        return no_content();
    }
    let fingerprint = auth::hash(&format!(
        "{method}:{path}:{}:{}",
        body,
        parts
            .headers
            .get(header::IF_MATCH)
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default()
    ));
    let key = if mutation && method == "POST" {
        Some(idempotency_key(&parts.headers)?)
    } else {
        None
    };
    if let Some(key) = key {
        let cached = sqlx::query(
            "SELECT fingerprint,status,response FROM idempotency WHERE principal=? AND key=?",
        )
        .bind(&p.user_id)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = cached {
            if row.get::<&str, _>(0) != fingerprint {
                return Err(reused());
            }
            let value: Value = serde_json::from_str(row.get(2))
                .map_err(|_| ApiError::invalid("Invalid replay data."))?;
            if path.starts_with("reconciliation/") {
                reconciliation::authorize_replay(&mut tx, &p, &value).await?;
            }
            if path.starts_with("settle-ups") || path.starts_with("investments") {
                let kind = if path.starts_with("settle-ups") {
                    "settlement_obligations"
                } else {
                    "investments"
                };
                if let Some(id) = value["id"].as_str() {
                    storage::get(&mut tx, &p, kind, id).await?;
                }
                if let Some(items) = value["obligations"].as_array() {
                    for item in items {
                        storage::get(&mut tx, &p, kind, text(item, "id")?).await?;
                    }
                }
            }
            // Recheck referenced account access before replaying financial data.
            if path.starts_with("transfers/review-queue/")
                && path.ends_with("/pair")
                && let Some(id) = value["id"].as_str()
            {
                storage::get(&mut tx, &p, "transactions", id).await?;
            }
            if let Some(kind) = path
                .split('/')
                .next()
                .filter(|k| ["accounts", "transactions", "budgets"].contains(k))
                && let Some(id) = if kind == "accounts" && path.ends_with("/balance-checks") {
                    value["account_id"].as_str()
                } else {
                    value["id"].as_str()
                }
            {
                storage::get(&mut tx, &p, kind, id).await?;
                let visible = if kind == "accounts" && path.ends_with("/balance-checks") {
                    true
                } else {
                    storage::visible(&mut tx, &p, kind, &value).await?
                };
                if !visible {
                    return Err(ApiError::missing());
                }
            }
            return Ok((
                StatusCode::from_u16(row.get::<i64, _>(1) as u16).unwrap_or(StatusCode::OK),
                value,
            ));
        }
    }
    let reply = route(&mut tx, &p, method, path, &query, &parts.headers, &body).await?;
    if method == "POST" && path.starts_with("invites/") && path.ends_with("/accept") {
        sqlx::query("UPDATE sessions SET household_id=? WHERE token_hash=?")
            .bind(text(&reply.1, "household_id")?)
            .bind(auth::hash(
                auth::cookie_token(&parts.headers).unwrap_or_default(),
            ))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(key) = key {
        sqlx::query(
            "INSERT INTO idempotency(principal,key,fingerprint,status,response) VALUES(?,?,?,?,?)",
        )
        .bind(&p.user_id)
        .bind(key)
        .bind(fingerprint)
        .bind(i64::from(reply.0.as_u16()))
        .bind(reply.1.to_string())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if method == "POST"
        && path.ends_with("/retry")
        && let Some(id) = reply.1["file_id"].as_str()
    {
        imports::retry_after_commit(state.pool.clone(), id.to_owned());
    }
    Ok(reply)
}
fn reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "idempotency_key_reused",
        "Idempotency key was already used for another request.",
    )
}
fn idempotency_key(headers: &HeaderMap) -> Result<&str> {
    headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| ApiError::invalid("Idempotency-Key is required (maximum 128 characters)."))
}
pub(crate) fn revision(headers: &HeaderMap, body: &Value, current: &Value) -> Result<()> {
    let from_header = headers
        .get(header::IF_MATCH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.trim_matches('"').parse::<i64>().ok());
    let expected = from_header
        .or_else(|| body["expected_revision"].as_i64())
        .ok_or_else(|| ApiError::invalid("If-Match or expected_revision is required."))?;
    let actual = current["revision"].as_i64().unwrap_or(1);
    if expected != actual {
        return Err(ApiError::revision(actual));
    }
    Ok(())
}
fn project(body: &Value, keys: &[&str]) -> Value {
    let mut v = json!({});
    for key in keys {
        if let Some(value) = body.get(key) {
            v[*key] = value.clone();
        }
    }
    v
}
fn patch(before: &Value, body: &Value, keys: &[&str]) -> Value {
    let mut result = before.clone();
    for key in keys {
        if let Some(value) = body.get(key) {
            result[*key] = value.clone();
        }
    }
    result
}
const ACCOUNT_FIELDS: &[&str] = &[
    "name",
    "subtype",
    "currency",
    "timezone",
    "aliases",
    "visibility",
    "active",
    "opening_balance",
    "card_due",
];
const CATEGORY_FIELDS: &[&str] = &["name", "kind", "parent_id"];
const TRANSACTION_FIELDS: &[&str] = &[
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
const BUDGET_FIELDS: &[&str] = &[
    "name",
    "month",
    "scope",
    "currency",
    "expected_income",
    "savings_goal",
    "lines",
    "targets",
];

async fn route(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    path: &str,
    q: &Query,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    if method == "POST" && ["data/reset-preview", "data/reset"].contains(&path) {
        return ok(crate::reset::run(db, p, body, path == "data/reset").await?);
    }
    if let Some(result) = imports::route(db, p, method, path, q, headers, body).await {
        return result;
    }
    if path.starts_with("reconciliation/sessions") {
        return reconciliation::route(db, p, method, path, q, headers, body).await;
    }
    if path.starts_with("settle-ups") || path.starts_with("investments") {
        return planning::route(db, p, method, path, q, headers, body).await;
    }
    let segments: Vec<&str> = path.split('/').collect();
    match (method, segments.as_slice()) {
        ("GET", ["recurring-transactions"]) => {
            allowed_query(q, &[])?;
            ok(recurring::list(db, p).await?)
        }
        ("PUT", ["recurring-transactions", key]) => ok(recurring::tag(db, p, key, body).await?),
        ("POST", ["transactions", "bulk-scope"]) => {
            allowed_body(body, &["ids", "scope"])?;
            let scope = text(body, "scope")?;
            if !["personal", "family"].contains(&scope) {
                return Err(ApiError::invalid("Invalid allocation scope."));
            }
            let ids = body["ids"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Select transactions."))?;
            if ids.is_empty() || ids.len() > 5000 {
                return Err(ApiError::invalid("Select between 1 and 5000 transactions."));
            }
            let mut seen = std::collections::HashSet::new();
            let mut changes = Vec::new();
            for value in ids {
                let id = value
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("Invalid transaction ID."))?;
                if !seen.insert(id) {
                    return Err(ApiError::invalid("Duplicate transaction ID."));
                }
                storage::get(db, p, "transactions", id).await?;
                let before = storage::raw(db, p, "transactions", id).await?;
                if before["voided"] == true {
                    return Err(ApiError::conflict(
                        "Voided transactions cannot change scope.",
                    ));
                }
                let mut after = before.clone();
                let allocations = after["allocations"]
                    .as_array_mut()
                    .ok_or_else(|| ApiError::invalid("Invalid transaction allocations."))?;
                if allocations.is_empty() {
                    return Err(ApiError::invalid("Transfers have no allocation scope."));
                }
                for allocation in allocations {
                    allocation["scope"] = json!(scope);
                    if scope == "family" {
                        allocation.as_object_mut().unwrap().remove("beneficiary_id");
                    }
                }
                domain::validate_transaction(&after)?;
                if before["allocations"] != after["allocations"] {
                    changes.push((before, after));
                }
            }
            let count = changes.len();
            for (before, after) in changes {
                storage::update(db, p, &before, after, "bulk_scope_update").await?;
            }
            ok(json!({"updated":count,"scope":scope}))
        }
        ("GET", ["money-manager", "changes"]) => {
            allowed_query(q, &["include_done", "limit", "cursor"])?;
            let include_done = q.get("include_done").is_some_and(|v| v == "true");
            let mut values = storage::list(db, p, "transactions").await?;
            values.retain(|v| {
                let manual = v["entered_by"].is_string()
                    && v["source_refs"].as_array().is_some_and(Vec::is_empty);
                let changed = v["amendment"].is_object()
                    || v["reconciliation_created"].is_object()
                    || v["money_manager_manual_edit"].is_object()
                    || manual;
                changed
                    && v["voided"] != true
                    && (include_done || v["money_manager_synced_at"].is_null())
            });
            values.sort_by(|a, b| {
                (b["effective_date"].as_str(), b["created_at"].as_str())
                    .cmp(&(a["effective_date"].as_str(), a["created_at"].as_str()))
            });
            for value in &mut values {
                // An imported row has an original Money Manager value. A manual or
                // statement-created row is new to Money Manager and has no initial value.
                let imported = value["source_refs"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
                    && value["reconciliation_created"].is_null();
                if imported
                    && (value["amendment"].is_object()
                        || value["money_manager_manual_edit"].is_object())
                {
                    let original: Option<String> = sqlx::query_scalar("SELECT before_json FROM audit_events WHERE household_id=? AND resource_id=? AND action IN ('update','reconciliation_amendment_applied') AND before_json IS NOT NULL ORDER BY id LIMIT 1")
                        .bind(&p.household_id).bind(text(value,"id")?).fetch_optional(&mut *db).await?;
                    if let Some(original) = original {
                        let original: Value = serde_json::from_str(&original)
                            .map_err(|_| ApiError::invalid("Invalid transaction history."))?;
                        if storage::visible(db, p, "transactions", &original).await? {
                            value["money_manager_initial"] = original;
                        }
                    }
                }
            }
            ok(paginate(values, q)?)
        }
        ("POST", ["money-manager", "changes", id, "sync"]) => {
            allowed_body(body, &["synced"])?;
            let synced = body["synced"]
                .as_bool()
                .ok_or_else(|| ApiError::invalid("synced must be a boolean."))?;
            let before = storage::get(db, p, "transactions", id).await?;
            revision(headers, body, &before)?;
            if before["amendment"].is_null()
                && before["reconciliation_created"].is_null()
                && before["money_manager_manual_edit"].is_null()
                && !(before["entered_by"].is_string()
                    && before["source_refs"].as_array().is_some_and(Vec::is_empty))
            {
                return Err(ApiError::invalid(
                    "This transaction is not a Money Manager change.",
                ));
            }
            let mut after = before.clone();
            after["money_manager_synced_at"] = if synced {
                json!(storage::now())
            } else {
                Value::Null
            };
            // Bookkeeping does not change the ledger revision or stale reconciliation evidence.
            sqlx::query("UPDATE resources SET document=? WHERE id=? AND household_id=? AND kind='transactions'")
                .bind(after.to_string()).bind(id).bind(&p.household_id).execute(&mut *db).await?;
            storage::audit(
                db,
                p,
                id,
                if synced {
                    "money_manager_synced"
                } else {
                    "money_manager_reopened"
                },
                Some(&before),
                Some(&after),
            )
            .await?;
            ok(after)
        }
        ("GET", ["me"]) => ok(auth::me(db, p).await?),
        ("GET", ["auth", "csrf"]) => ok(json!({"csrf_token":p.csrf})),
        ("GET", ["settings", "household"]) => ok(auth::me(db, p).await?["household"].clone()),
        ("PATCH", ["settings", "household"]) => {
            auth::admin(p)?;
            let before = auth::me(db, p).await?["household"].clone();
            revision(headers, body, &before)?;
            allowed_body(body, &["name", "timezone", "base_currency", "locale"])?;
            let mut after = patch(
                &before,
                body,
                &["name", "timezone", "base_currency", "locale"],
            );
            text(&after, "name")?;
            domain::exponent(text(&after, "base_currency")?)?;
            text(&after, "timezone")?
                .parse::<chrono_tz::Tz>()
                .map_err(|_| ApiError::invalid("Invalid IANA timezone."))?;
            if before["base_currency"] != after["base_currency"] {
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM resources WHERE household_id=? AND kind='transactions'",
                )
                .bind(&p.household_id)
                .fetch_one(&mut *db)
                .await?;
                if count > 0 {
                    return Err(ApiError::conflict(
                        "Currency changes with ledger activity require migration.",
                    ));
                }
            }
            after["revision"] = json!(before["revision"].as_i64().unwrap_or(1) + 1);
            sqlx::query("UPDATE households SET document=? WHERE id=?")
                .bind(after.to_string())
                .bind(&p.household_id)
                .execute(&mut *db)
                .await?;
            storage::audit(
                db,
                p,
                &p.household_id,
                "update",
                Some(&before),
                Some(&after),
            )
            .await?;
            ok(after)
        }
        ("GET", [kind])
            if [
                "accounts",
                "categories",
                "transactions",
                "transfers",
                "budgets",
            ]
            .contains(kind) =>
        {
            let source = if *kind == "transfers" {
                "transactions"
            } else {
                kind
            };
            let mut values = storage::list(db, p, source).await?;
            if source == "transactions" {
                validate_transaction_query(q)?;
                values = filter_transactions(values, q, p)?;
                if let Some(scope) = q.get("scope") {
                    validate_report_scope(scope)?;
                    retain_scope(&mut values, scope, p, q.get("category_id"));
                }
                if let Some(account_type) = q.get("account_type") {
                    let matching: std::collections::HashSet<String> =
                        storage::list(db, p, "accounts")
                            .await?
                            .into_iter()
                            .filter(|a| a["subtype"] == account_type.as_str())
                            .filter_map(|a| a["id"].as_str().map(str::to_owned))
                            .collect();
                    values.retain(|v| {
                        v["movements"].as_array().is_some_and(|legs| {
                            legs.iter().any(|m| {
                                m["account_id"]
                                    .as_str()
                                    .is_some_and(|id| matching.contains(id))
                            })
                        })
                    });
                }
                if *kind == "transfers" {
                    values.retain(|v| v["event_type"] == "transfer");
                }
                values.sort_by(|a, b| {
                    (b["effective_date"].as_str(), b["id"].as_str())
                        .cmp(&(a["effective_date"].as_str(), a["id"].as_str()))
                });
                if q.get("sort").is_some_and(|v| v == "effective_date") {
                    values.reverse();
                }
            } else {
                let allowed: &[&str] = match source {
                    "accounts" => &["include_archived", "cursor", "limit"],
                    "categories" => &["include_archived", "kind", "cursor", "limit"],
                    _ => &["month", "scope", "cursor", "limit"],
                };
                allowed_query(q, allowed)?;
                if q.get("include_archived").is_none_or(|v| v != "true") {
                    values.retain(|v| v["archived"] != true && v["active"] != false);
                }
                for key in ["kind", "month", "scope"] {
                    if let Some(filter) = q.get(key).filter(|v| v.as_str() != "all") {
                        values.retain(|v| v[key] == filter.as_str());
                    }
                }
            }
            let mut response = paginate(values, q)?;
            if source == "accounts" {
                for value in response["data"].as_array_mut().unwrap() {
                    balances::decorate(db, p, value).await?;
                }
            }
            ok(response)
        }
        ("POST", [kind])
            if ["accounts", "categories", "transactions", "budgets"].contains(kind) =>
        {
            let fields = match *kind {
                "accounts" => ACCOUNT_FIELDS,
                "categories" => CATEGORY_FIELDS,
                "transactions" => TRANSACTION_FIELDS,
                _ => BUDGET_FIELDS,
            };
            allowed_body(body, fields)?;
            let mut value = project(body, fields);
            match *kind {
                "accounts" => {
                    value["active"] = json!(true);
                    if value.get("visibility").is_none() {
                        value["visibility"] = json!("private");
                    }
                    validate_account(&value)?;
                }
                "categories" => {
                    auth::admin(p)?;
                    value["archived"] = json!(false);
                    validate_category(db, p, &value, None).await?;
                }
                "transactions" => {
                    value["voided"] = json!(false);
                    value["entered_by"] = json!(p.user_id);
                    value["source_refs"] = json!([]);
                    value["reconciliation_state"] = json!("unmatched");
                    validate_ledger(db, p, &value).await?;
                }
                "budgets" => {
                    value["state"] = json!("draft");
                    validate_budget(db, p, &value, None).await?;
                }
                _ => unreachable!(),
            }
            let mut result = storage::create(db, p, kind, value).await?;
            if *kind == "accounts" {
                balances::decorate(db, p, &mut result).await?;
            }
            created(result)
        }
        ("GET", [kind, id])
            if ["accounts", "categories", "transactions", "budgets"].contains(kind) =>
        {
            let mut value = storage::get(db, p, kind, id).await?;
            if *kind == "accounts" {
                balances::decorate(db, p, &mut value).await?;
            }
            ok(value)
        }
        ("PATCH", [kind, id])
            if ["accounts", "categories", "transactions", "budgets"].contains(kind) =>
        {
            let before = storage::get(db, p, kind, id).await?;
            revision(headers, body, &before)?;
            let fields = match *kind {
                "accounts" => ACCOUNT_FIELDS,
                "categories" => CATEGORY_FIELDS,
                "transactions" => TRANSACTION_FIELDS,
                _ => BUDGET_FIELDS,
            };
            allowed_body(body, fields)?;
            let mut after = patch(&before, body, fields);
            match *kind {
                "accounts" => {
                    if before["owner_id"] != p.user_id {
                        return Err(ApiError::forbidden());
                    }
                    if after["subtype"] != "credit_card" {
                        after.as_object_mut().unwrap().remove("card_due");
                    }
                    validate_account(&after)?;
                    if before["currency"] != after["currency"]
                        || before["timezone"] != after["timezone"]
                    {
                        // Inspect all household activity, not only what this caller can see.
                        let count:i64=sqlx::query_scalar("SELECT count(*) FROM resources r,json_each(r.document,'$.movements') m WHERE r.household_id=? AND r.kind='transactions' AND json_extract(m.value,'$.account_id')=?").bind(&p.household_id).bind(id).fetch_one(&mut *db).await?;
                        if count > 0 {
                            return Err(ApiError::conflict(
                                "Account currency or timezone changes with activity require migration.",
                            ));
                        }
                    }
                }
                "categories" => {
                    auth::admin(p)?;
                    validate_category(db, p, &after, Some(id)).await?;
                }
                "transactions" => {
                    if before["voided"] == true {
                        return Err(ApiError::conflict("Voided transactions cannot be edited."));
                    }
                    if after["effective_at"].is_null() {
                        after.as_object_mut().unwrap().remove("effective_at");
                    }
                    validate_ledger(db, p, &after).await?;
                }
                "budgets" => {
                    budget_write(p, &before)?;
                    if before["state"] == "archived" {
                        return Err(ApiError::conflict("Archived budgets cannot be edited."));
                    }
                    validate_budget(db, p, &after, Some(id)).await?;
                }
                _ => unreachable!(),
            }
            if *kind == "transactions" {
                reconciliation::invalidate(db, p, id).await?;
                after["reconciliation_state"] = json!("unmatched");
                after["money_manager_synced_at"] = Value::Null;
                if !before["source_refs"].as_array().is_some_and(Vec::is_empty)
                    && before["amendment"].is_null()
                    && before["reconciliation_created"].is_null()
                {
                    after["money_manager_manual_edit"] = json!({"updated_at":storage::now()});
                }
            }
            let mut result = storage::update(db, p, &before, after, "update").await?;
            if *kind == "accounts" {
                balances::decorate(db, p, &mut result).await?;
            } else if *kind == "transactions" {
                reconciliation::decorate_transaction(db, &mut result).await?;
            }
            ok(result)
        }
        ("GET", [kind, id, "revisions"]) if ["transactions", "budgets"].contains(kind) => {
            ok(storage::history(db, p, kind, id).await?)
        }
        ("POST", ["transactions", id, "void"]) | ("DELETE", ["transactions", id]) => {
            allowed_body(body, &["reason"])?;
            let before = storage::get(db, p, "transactions", id).await?;
            revision(headers, body, &before)?;
            if before["voided"] == true {
                return Err(ApiError::conflict("Transaction is already voided."));
            }
            let mut after = before.clone();
            after["voided"] = json!(true);
            after["void_reason"] = json!(text(body, "reason")?);
            reconciliation::invalidate(db, p, id).await?;
            after["reconciliation_state"] = json!("unmatched");
            let result = storage::update(db, p, &before, after, "void").await?;
            sqlx::query("DELETE FROM import_occurrences WHERE household_id=? AND transaction_id=?")
                .bind(&p.household_id)
                .bind(id)
                .execute(&mut *db)
                .await?;
            if method == "DELETE" {
                no_content()
            } else {
                ok(result)
            }
        }
        ("POST", ["categories", id, action]) if ["archive", "restore"].contains(action) => {
            auth::admin(p)?;
            let before = storage::get(db, p, "categories", id).await?;
            revision(headers, body, &before)?;
            let mut after = before.clone();
            after["archived"] = json!(*action == "archive");
            ok(storage::update(db, p, &before, after, action).await?)
        }
        ("PUT", ["accounts", id, "access", member_id]) => {
            let before = storage::get(db, p, "accounts", id).await?;
            if before["owner_id"] != p.user_id {
                return Err(ApiError::forbidden());
            }
            revision(headers, body, &before)?;
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM memberships WHERE id=? AND household_id=? AND active=1",
            )
            .bind(member_id)
            .bind(&p.household_id)
            .fetch_one(&mut *db)
            .await?;
            if count == 0 {
                return Err(ApiError::missing());
            }
            let grant = body["granted"]
                .as_bool()
                .ok_or_else(|| ApiError::invalid("granted must be boolean."))?;
            if grant {
                sqlx::query(
                    "INSERT OR IGNORE INTO account_access(account_id,member_id) VALUES(?,?)",
                )
                .bind(id)
                .bind(member_id)
                .execute(&mut *db)
                .await?;
            } else {
                sqlx::query("DELETE FROM account_access WHERE account_id=? AND member_id=?")
                    .bind(id)
                    .bind(member_id)
                    .execute(&mut *db)
                    .await?;
            }
            let after = storage::update(db, p, &before, before.clone(), "access_changed").await?;
            storage::audit(
                db,
                p,
                id,
                "access_grant",
                None,
                Some(&json!({"member_id":member_id,"granted":grant})),
            )
            .await?;
            ok(after)
        }
        ("GET", ["accounts", id, "statements"]) => {
            allowed_query(q, &["month"])?;
            let account = storage::get(db, p, "accounts", id).await?;
            let (from, to) = month_bounds(
                q.get("month")
                    .ok_or_else(|| ApiError::invalid("month is required."))?,
            )?;
            ok(balances::statement(db, p, &account, &from, &to).await?)
        }
        ("GET", ["accounts", id, "statement-months"]) => {
            allowed_query(q, &[])?;
            let account = storage::get(db, p, "accounts", id).await?;
            ok(balances::statement_months(db, p, &account).await?)
        }
        ("GET", ["accounts", id, "balance-at"]) => {
            allowed_query(q, &["as_of"])?;
            let account = storage::get(db, p, "accounts", id).await?;
            let at = q
                .get("as_of")
                .ok_or_else(|| ApiError::invalid("as_of is required."))?;
            ok(balances::derived(db, p, &account, balances::timestamp(at)?).await?)
        }
        ("GET", ["accounts", id, "ledger"]) => {
            allowed_query(q, &["from", "to", "cursor", "limit"])?;
            let account = storage::get(db, p, "accounts", id).await?;
            for key in ["from", "to"] {
                if let Some(date) = q.get(key) {
                    domain::date(date)?;
                }
            }
            let mut rows = balances::ledger(db, p, &account).await?;
            rows.retain(|v| {
                let date = v["effective_date"].as_str().unwrap_or_default();
                q.get("from").is_none_or(|from| date >= from.as_str())
                    && q.get("to").is_none_or(|to| date < to.as_str())
            });
            ok(paginate(rows, q)?)
        }
        ("POST", ["accounts", id, "balance-checks"]) => {
            let account = storage::get(db, p, "accounts", id).await?;
            revision(headers, body, &account)?;
            created(balances::record(db, p, &account, body).await?)
        }
        ("GET", ["accounts", id, "balance-checks"]) => {
            allowed_query(q, &["from", "to", "cursor", "limit"])?;
            let account = storage::get(db, p, "accounts", id).await?;
            let mut checks = balances::history(db, p, &account).await?;
            for key in ["from", "to"] {
                if let Some(date) = q.get(key) {
                    domain::date(date)?;
                }
            }
            let tz = balances::timezone(db, p, &account).await?;
            checks.retain(|v| {
                let local = balances::timestamp(v["as_of"].as_str().unwrap_or_default())
                    .expect("validated stored timestamp")
                    .with_timezone(&tz)
                    .date_naive()
                    .to_string();
                let date = local.as_str();
                q.get("from").is_none_or(|from| date >= from.as_str())
                    && q.get("to").is_none_or(|to| date < to.as_str())
            });
            ok(paginate(checks, q)?)
        }
        ("PATCH", ["accounts", id, "balance-checks", check_id]) => {
            allowed_body(body, &["amount", "basis", "as_of", "timezone", "reason"])?;
            let account = storage::get(db, p, "accounts", id).await?;
            let before = storage::get(db, p, "balance_checks", check_id).await?;
            if before["account_id"] != account["id"] {
                return Err(ApiError::missing());
            }
            if before["owner_id"] != p.user_id && account["owner_id"] != p.user_id {
                return Err(ApiError::forbidden());
            }
            revision(headers, body, &before)?;
            ok(balances::revise(db, p, &account, &before, body).await?)
        }
        ("DELETE", ["accounts", id, "balance-checks", check_id]) => {
            allowed_body(body, &[])?;
            let account = storage::get(db, p, "accounts", id).await?;
            let before = storage::get(db, p, "balance_checks", check_id).await?;
            if before["account_id"] != account["id"] {
                return Err(ApiError::missing());
            }
            if before["owner_id"] != p.user_id && account["owner_id"] != p.user_id {
                return Err(ApiError::forbidden());
            }
            revision(headers, body, &before)?;
            balances::remove(db, p, &account, &before).await?;
            no_content()
        }
        ("GET", ["analytics", "household"]) => household_report(db, p, q).await,
        ("GET", ["analytics", "dashboard"]) => analytics_dashboard(db, p, q).await,
        ("GET", ["analytics", report])
            if [
                "summary",
                "series",
                "categories",
                "income-categories",
                "merchants",
                "types",
                "accounts",
                "transfers",
                "coverage",
                "transactions",
            ]
            .contains(report) =>
        {
            analytics(db, p, report, q).await
        }
        ("POST", ["budgets", id, action]) if ["activate", "archive", "copy"].contains(action) => {
            let before = storage::get(db, p, "budgets", id).await?;
            budget_write(p, &before)?;
            revision(headers, body, &before)?;
            let mut after = before.clone();
            if *action == "copy" {
                after["month"] = json!(text(body, "month")?);
                after["state"] = json!("draft");
                validate_budget(db, p, &after, None).await?;
                return created(
                    storage::create(
                        db,
                        p,
                        "budgets",
                        project(
                            &after,
                            &[
                                "name",
                                "month",
                                "scope",
                                "currency",
                                "expected_income",
                                "lines",
                                "targets",
                                "state",
                            ],
                        ),
                    )
                    .await?,
                );
            }
            let target = if *action == "activate" {
                "active"
            } else {
                "archived"
            };
            if (*action == "activate" && before["state"] != "draft")
                || before["state"] == "archived"
            {
                return Err(ApiError::conflict("Invalid budget lifecycle transition."));
            }
            after["state"] = json!(target);
            ok(storage::update(db, p, &before, after, action).await?)
        }
        ("GET", ["budgets", id, "tracking"]) => budget_tracking(db, p, id, q).await,
        ("GET", ["households", household, "members"]) if *household == p.household_id => {
            let rows=sqlx::query("SELECT m.id,m.role,m.revision,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND m.active=1 ORDER BY m.id").bind(&p.household_id).fetch_all(db).await?;
            ok(collection(rows.into_iter().map(|r|json!({"id":r.get::<&str,_>(0),"role":r.get::<&str,_>(1),"revision":r.get::<i64,_>(2),"name":r.get::<&str,_>(3),"email":r.get::<&str,_>(4)})).collect()))
        }
        ("POST", ["households", household, "invites"]) if *household == p.household_id => {
            create_invite(db, p, body).await
        }
        ("POST", ["invites", token, "accept"]) => accept_invite(db, p, token).await,
        ("PATCH" | "DELETE", ["households", household, "members", member])
            if *household == p.household_id =>
        {
            edit_member(db, p, method, member, headers, body).await
        }
        (
            _,
            ["imports", ..]
            | ["source-files", ..]
            | ["jobs", ..]
            | ["reconciliation", ..]
            | ["source-profiles", ..]
            | ["operations", ..]
            | ["budget-alerts", ..]
            | ["settings", "ai", ..],
        ) => Err(unsupported()),
        (_, ["transfers", "review-queue", ..])
        | (_, ["analytics", "exports"])
        | (_, ["categories", _, "merge" | "merge-preview"])
        | (
            _,
            [
                "budgets",
                _,
                "contribution-targets" | "contribution-links",
                ..,
            ],
        ) => Err(unsupported()),
        _ => Err(ApiError::missing()),
    }
}

fn validate_account(v: &Value) -> Result<()> {
    text(v, "name")?;
    balances::validate_opening(v)?;
    if !v["card_due"].is_null() {
        if v["subtype"] != "credit_card" {
            return Err(ApiError::invalid(
                "Only credit cards can have a due amount.",
            ));
        }
        domain::date(text(&v["card_due"], "due_date")?)?;
        if let Some(amount) = v["card_due"].get("amount") {
            if domain::money(
                amount
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("Card due amount must be a money string."))?,
                text(v, "currency")?,
            )? < 0
            {
                return Err(ApiError::invalid("Card due amount cannot be negative."));
            }
        }
    }
    domain::choice(v, "subtype", &["bank", "credit_card", "cash", "settle_up"])?;
    domain::exponent(text(v, "currency")?)?;
    domain::choice(v, "visibility", &["private", "shared"])?;
    if v.get("active").is_some_and(|a| !a.is_boolean()) {
        return Err(ApiError::invalid("active must be boolean."));
    }
    if let Some(timezone) = v.get("timezone") {
        timezone
            .as_str()
            .ok_or_else(|| ApiError::invalid("timezone must be a string."))?
            .parse::<chrono_tz::Tz>()
            .map_err(|_| ApiError::invalid("Invalid IANA timezone."))?;
    }
    if let Some(aliases) = v.get("aliases")
        && !aliases
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    {
        return Err(ApiError::invalid("aliases must be strings."));
    }
    Ok(())
}
async fn validate_category(
    db: &mut SqliteConnection,
    p: &Principal,
    v: &Value,
    current: Option<&str>,
) -> Result<()> {
    text(v, "name")?;
    domain::choice(v, "kind", &["expense", "income"])?;
    if v.get("parent_id")
        .is_some_and(|value| !value.is_string() && !value.is_null())
    {
        return Err(ApiError::invalid("parent_id must be a string or null."));
    }
    let mut parent = v["parent_id"].as_str().map(str::to_owned);
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = parent {
        if Some(id.as_str()) == current || !seen.insert(id.clone()) {
            return Err(ApiError::invalid(
                "Category hierarchy cannot contain cycles.",
            ));
        }
        let category = storage::get(db, p, "categories", &id).await?;
        if category["kind"] != v["kind"] || category["archived"] == true {
            return Err(ApiError::invalid(
                "Parent must be an active category of the same kind.",
            ));
        }
        parent = category["parent_id"].as_str().map(str::to_owned);
    }
    if let Some(id) = current {
        let old = storage::get(db, p, "categories", id).await?;
        if old["kind"] != v["kind"] {
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM resources r,json_each(r.document,'$.allocations') a WHERE r.household_id=? AND r.kind='transactions' AND json_extract(a.value,'$.category_id')=?").bind(&p.household_id).bind(id).fetch_one(&mut *db).await?;
            let children:i64=sqlx::query_scalar("SELECT count(*) FROM resources WHERE household_id=? AND kind='categories' AND json_extract(document,'$.parent_id')=?").bind(&p.household_id).bind(id).fetch_one(db).await?;
            if count + children > 0 {
                return Err(ApiError::conflict(
                    "Referenced category kinds cannot change.",
                ));
            }
        }
    }
    Ok(())
}
pub(crate) async fn validate_ledger(
    db: &mut SqliteConnection,
    p: &Principal,
    v: &Value,
) -> Result<()> {
    domain::validate_transaction(v)?;
    if let Some(at) = v["effective_at"].as_str() {
        let household = auth::me(db, p).await?["household"].clone();
        let tz = text(&household, "timezone")?
            .parse::<chrono_tz::Tz>()
            .map_err(|_| ApiError::invalid("Invalid household timezone."))?;
        if balances::timestamp(at)?
            .with_timezone(&tz)
            .date_naive()
            .to_string()
            != text(v, "effective_date")?
        {
            return Err(ApiError::invalid(
                "effective_date must match effective_at in the household timezone.",
            ));
        }
    }
    for movement in v["movements"].as_array().unwrap() {
        let a = storage::get(db, p, "accounts", text(movement, "account_id")?).await?;
        if a["active"] == false || a["currency"] != v["currency"] {
            return Err(ApiError::invalid(
                "Movements require active accounts in the transaction currency.",
            ));
        }
        if movement
            .get("currency")
            .is_some_and(|c| c != &v["currency"])
        {
            return Err(ApiError::invalid(
                "Movement currency differs from the event.",
            ));
        }
    }
    for allocation in v["allocations"].as_array().unwrap() {
        if let Some(category) = allocation["category_id"].as_str() {
            let c = storage::get(db, p, "categories", category).await?;
            let expected = if v["event_type"] == "income" {
                "income"
            } else {
                "expense"
            };
            if c["archived"] == true || c["kind"] != expected {
                return Err(ApiError::invalid(
                    "Allocation category must be active and match the event kind.",
                ));
            }
        }
        if allocation
            .get("beneficiary_id")
            .is_some_and(|b| b != &json!(p.user_id))
        {
            return Err(ApiError::invalid(
                "Personal beneficiary must be the current user; use family scope for shared allocations.",
            ));
        }
    }
    Ok(())
}
pub(crate) fn allowed_query(q: &Query, allowed: &[&str]) -> Result<()> {
    if let Some(key) = q.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(ApiError::invalid(format!(
            "Unsupported query parameter: {key}."
        )));
    }
    Ok(())
}
fn validate_transaction_query(q: &Query) -> Result<()> {
    allowed_query(
        q,
        &[
            "account_id",
            "account_type",
            "member_id",
            "category_id",
            "event_type",
            "reconciliation_state",
            "from",
            "to",
            "q",
            "cursor",
            "limit",
            "sort",
            "scope",
        ],
    )?;
    if let Some(sort) = q.get("sort")
        && !["effective_date", "-effective_date"].contains(&sort.as_str())
    {
        return Err(ApiError::invalid(
            "sort must be effective_date or -effective_date.",
        ));
    }
    if let Some(account_type) = q.get("account_type")
        && !["bank", "credit_card", "cash", "settle_up"].contains(&account_type.as_str())
    {
        return Err(ApiError::invalid("Invalid account_type."));
    }
    if let Some(event_type) = q.get("event_type")
        && !["expense", "income", "refund", "transfer"].contains(&event_type.as_str())
    {
        return Err(ApiError::invalid("Invalid event_type."));
    }
    for key in ["from", "to"] {
        if let Some(value) = q.get(key) {
            domain::date(value)?;
        }
    }
    if let (Some(from), Some(to)) = (q.get("from"), q.get("to"))
        && from >= to
    {
        return Err(ApiError::invalid("from must precede to."));
    }
    Ok(())
}
fn filter_transactions(mut values: Vec<Value>, q: &Query, p: &Principal) -> Result<Vec<Value>> {
    if let Some(member) = q.get("member_id")
        && member != &p.user_id
    {
        return Err(ApiError::forbidden());
    }
    values.retain(|v| {
        if v["voided"] == true {
            return false;
        }
        for key in ["event_type", "reconciliation_state"] {
            if q.get(key).is_some_and(|f| v[key] != f.as_str()) {
                return false;
            }
        }
        if q.get("member_id")
            .is_some_and(|f| v["entered_by"] != f.as_str())
        {
            return false;
        }
        if q.get("account_id").is_some_and(|f| {
            !v["movements"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["account_id"] == f.as_str()))
        }) {
            return false;
        }
        if q.get("category_id").is_some_and(|f| {
            !v["allocations"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["category_id"] == f.as_str()))
        }) {
            return false;
        }
        let date = v["effective_date"].as_str().unwrap_or_default();
        if q.get("from").is_some_and(|s| date < s.as_str())
            || q.get("to").is_some_and(|s| date >= s.as_str())
        {
            return false;
        }
        if q.get("q").is_some_and(|s| {
            !format!(
                "{} {}",
                v["description"].as_str().unwrap_or_default(),
                v["merchant"].as_str().unwrap_or_default()
            )
            .to_lowercase()
            .contains(&s.to_lowercase())
        }) {
            return false;
        }
        true
    });
    Ok(values)
}
fn validate_report_scope(scope: &str) -> Result<()> {
    if ["personal", "family", "combined"].contains(&scope) {
        Ok(())
    } else {
        Err(ApiError::invalid("Invalid report scope."))
    }
}
fn retain_scope(values: &mut Vec<Value>, scope: &str, p: &Principal, category: Option<&String>) {
    for v in values.iter_mut() {
        let entered_by = v["entered_by"].as_str().unwrap_or_default().to_owned();
        if let Some(allocations) = v["allocations"].as_array_mut() {
            allocations.retain(|a| {
                let personal = a["scope"] == "personal" && entered_by == p.user_id;
                let family = a["scope"] == "family";
                (match scope {
                    "personal" => personal,
                    "family" => family,
                    "combined" => personal || family,
                    _ => false,
                }) && category.is_none_or(|c| a["category_id"] == c.as_str())
            });
        }
    }
    values.retain(|v| {
        v["allocations"].as_array().is_some_and(|a| !a.is_empty())
            || (v["event_type"] == "transfer"
                && category.is_none()
                && (scope != "personal" || v["entered_by"] == p.user_id))
    });
}
pub(crate) fn paginate(values: Vec<Value>, q: &Query) -> Result<Value> {
    let limit = q
        .get("limit")
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| ApiError::invalid("Invalid limit."))?
        .unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(ApiError::invalid("limit must be between 1 and 200."));
    }
    let mut filters: std::collections::BTreeMap<&String, &String> = q
        .iter()
        .filter(|(k, _)| k.as_str() != "cursor" && k.as_str() != "limit")
        .collect();
    filters.remove(&"cursor".to_owned());
    let snapshot = auth::hash(&format!(
        "{}:{}",
        serde_json::to_string(&values).unwrap(),
        serde_json::to_string(&filters).unwrap()
    ));
    let start = if let Some(cursor) = q.get("cursor") {
        let (hash, id) = cursor
            .split_once('.')
            .ok_or_else(|| ApiError::invalid("Invalid cursor."))?;
        if hash != snapshot {
            return Err(ApiError::conflict(
                "Collection or filters changed; restart pagination.",
            ));
        }
        values
            .iter()
            .position(|v| v["id"] == id)
            .map(|i| i + 1)
            .ok_or_else(|| ApiError::invalid("Invalid cursor for this query."))?
    } else {
        0
    };
    let has_more = values.len() > start + limit;
    let data: Vec<Value> = values.into_iter().skip(start).take(limit).collect();
    let page = if has_more {
        json!({"next_cursor":format!("{snapshot}.{}",data.last().unwrap()["id"].as_str().unwrap())})
    } else {
        json!({})
    };
    Ok(json!({"data":data,"page":page,"meta":{}}))
}

pub(crate) fn month_bounds(month: &str) -> Result<(String, String)> {
    use chrono::Datelike;
    let from = domain::date(&format!("{month}-01"))?;
    let (year, month) = if from.month() == 12 {
        (from.year() + 1, 1)
    } else {
        (from.year(), from.month() + 1)
    };
    let to = chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| ApiError::invalid("Invalid month."))?;
    Ok((from.to_string(), to.to_string()))
}
fn budget_write(p: &Principal, v: &Value) -> Result<()> {
    if v["owner_id"] == p.user_id
        || (v["scope"] == "family" && ["owner", "admin"].contains(&p.role.as_str()))
    {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}
async fn validate_budget(
    db: &mut SqliteConnection,
    p: &Principal,
    v: &Value,
    current: Option<&str>,
) -> Result<()> {
    month_bounds(text(v, "month")?)?;
    domain::choice(v, "scope", &["personal", "family"])?;
    if v["scope"] == "family" {
        auth::admin(p)?;
    }
    let currency = text(v, "currency")?;
    domain::exponent(currency)?;
    if money(text(v, "expected_income")?, currency)? < 0 {
        return Err(ApiError::invalid("Expected income cannot be negative."));
    }
    if v.get("savings_goal").is_some() && money(text(v, "savings_goal")?, currency)? < 0 {
        return Err(ApiError::invalid("Savings goal cannot be negative."));
    }
    let lines = v["lines"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("lines must be an array."))?;
    let mut seen = std::collections::HashSet::new();
    let mut sum = 0;
    for line in lines {
        let category = text(line, "category_id")?;
        if !seen.insert(category) {
            return Err(ApiError::invalid("Budget categories must be unique."));
        }
        let c = storage::get(db, p, "categories", category).await?;
        if c["kind"] != "expense" || c["archived"] == true {
            return Err(ApiError::invalid(
                "Budget lines require active expense categories.",
            ));
        }
        let limit = money(text(line, "amount")?, currency)?;
        if limit < 0 {
            return Err(ApiError::invalid("Budget limits cannot be negative."));
        }
        sum = add(sum, limit)?;
    }
    for plan in storage::list(db, p, "budgets").await? {
        if plan["id"].as_str() != current
            && plan["month"] == v["month"]
            && plan["scope"] == v["scope"]
            && plan["currency"] == v["currency"]
            && (v["scope"] == "family" || plan["owner_id"] == p.user_id)
        {
            return Err(ApiError::conflict(
                "A budget already exists for this owner/scope, currency and month.",
            ));
        }
    }
    Ok(())
}

async fn report_inputs(
    db: &mut SqliteConnection,
    p: &Principal,
    q: &Query,
    decorate: bool,
) -> Result<(Vec<Value>, String, Value)> {
    allowed_query(
        q,
        &[
            "scope",
            "from",
            "to",
            "currency",
            "account_id",
            "category_id",
            "member_id",
            "cursor",
            "limit",
            "grain",
            "months",
        ],
    )?;
    let from = q
        .get("from")
        .ok_or_else(|| ApiError::invalid("Reports require from and to."))?;
    let to = q
        .get("to")
        .ok_or_else(|| ApiError::invalid("Reports require from and to."))?;
    let start = domain::date(from)?;
    let end = domain::date(to)?;
    if end <= start || (end - start).num_days() > 3660 {
        return Err(ApiError::invalid(
            "Report period must be positive and at most 3660 days.",
        ));
    }
    let scope = q.get("scope").map(String::as_str).unwrap_or("personal");
    validate_report_scope(scope)?;
    let household = auth::me(db, p).await?["household"].clone();
    let currency = q.get("currency").cloned().unwrap_or_else(|| {
        household["base_currency"]
            .as_str()
            .unwrap_or("INR")
            .to_owned()
    });
    domain::exponent(&currency)?;
    if let Some(account) = q.get("account_id") {
        storage::get(db, p, "accounts", account).await?;
    }
    if let Some(category) = q.get("category_id") {
        storage::get(db, p, "categories", category).await?;
    }
    let mut values = filter_transactions(
        storage::transactions_in_period(db, p, from, to, decorate).await?,
        q,
        p,
    )?;
    values.retain(|v| v["currency"] == currency);
    retain_scope(&mut values, scope, p, q.get("category_id"));
    let ledger_revision: i64 =
        sqlx::query_scalar("SELECT coalesce(max(id),0) FROM audit_events WHERE household_id=?")
            .bind(&p.household_id)
            .fetch_one(db)
            .await?;
    let meta = json!({"from":from,"to":to,"scope":scope,"currency":currency,"timezone":household["timezone"],"filters":q,"policy_version":"1","ledger_revision":ledger_revision,"coverage":"unknown","complete":false,"visibility":"authorized_accounts_only"});
    Ok((values, currency, meta))
}
fn totals(values: &[Value], currency: &str) -> Result<Value> {
    let (mut income, mut spending, mut transfers) = (0_i64, 0_i64, 0_i64);
    for v in values {
        if v["event_type"] == "transfer" {
            transfers = add(transfers, money(text(v, "amount")?, currency)?)?;
            continue;
        }
        for a in v["allocations"].as_array().unwrap() {
            let amount = money(text(a, "amount")?, currency)?;
            if v["event_type"] == "income" {
                income = add(income, amount)?;
            } else {
                spending = add(
                    spending,
                    if v["event_type"] == "refund" {
                        -amount
                    } else {
                        amount
                    },
                )?;
            }
        }
    }
    let surplus = income
        .checked_sub(spending)
        .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
    Ok(
        json!({"income":format_money(income,currency)?,"net_spending":format_money(spending,currency)?,"recorded_surplus":format_money(surplus,currency)?,"transfer_volume":format_money(transfers,currency)?}),
    )
}

async fn household_report(db: &mut SqliteConnection, p: &Principal, q: &Query) -> Result<Reply> {
    allowed_query(q, &["from", "to", "currency"])?;
    let from = q
        .get("from")
        .ok_or_else(|| ApiError::invalid("Reports require from and to."))?;
    let to = q
        .get("to")
        .ok_or_else(|| ApiError::invalid("Reports require from and to."))?;
    let start = domain::date(from)?;
    let end = domain::date(to)?;
    if end <= start || (end - start).num_days() > 3660 {
        return Err(ApiError::invalid(
            "Report period must be positive and at most 3660 days.",
        ));
    }
    let household = auth::me(db, p).await?["household"].clone();
    let currency = q
        .get("currency")
        .map(String::as_str)
        .unwrap_or_else(|| household["base_currency"].as_str().unwrap_or("INR"));
    domain::exponent(currency)?;
    struct MemberReport {
        id: String,
        name: String,
        income: i64,
        spending: i64,
        invested: i64,
        categories: std::collections::BTreeMap<String, i64>,
    }
    let rows = sqlx::query("SELECT m.user_id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND m.active=1 ORDER BY u.name,m.id")
        .bind(&p.household_id).fetch_all(&mut *db).await?;
    let mut members: Vec<MemberReport> = rows
        .into_iter()
        .map(|r| MemberReport {
            id: r.get::<String, _>(0),
            name: r.get::<String, _>(1),
            income: 0,
            spending: 0,
            invested: 0,
            categories: std::collections::BTreeMap::new(),
        })
        .collect();
    let transactions = storage::transactions_in_period(db, p, from, to, false).await?;
    for transaction in transactions {
        if transaction["voided"] == true
            || transaction["currency"] != currency
            || transaction["event_type"] == "transfer"
        {
            continue;
        }
        let Some(member) = members
            .iter_mut()
            .find(|m| transaction["entered_by"] == m.id)
        else {
            continue;
        };
        for allocation in transaction["allocations"].as_array().into_iter().flatten() {
            // A member's personal allocations are visible only to that member.
            if allocation["scope"] != "family"
                && !(member.id == p.user_id && allocation["scope"] == "personal")
            {
                continue;
            }
            let value = money(text(allocation, "amount")?, currency)?;
            if transaction["event_type"] == "income" {
                member.income = add(member.income, value)?;
            } else {
                let signed = if transaction["event_type"] == "refund" {
                    -value
                } else {
                    value
                };
                member.spending = add(member.spending, signed)?;
                let category = allocation["category_id"]
                    .as_str()
                    .unwrap_or("uncategorized")
                    .to_owned();
                let current = *member.categories.get(&category).unwrap_or(&0);
                member.categories.insert(category, add(current, signed)?);
            }
        }
    }
    let investments =
        sqlx::query("SELECT document FROM resources WHERE household_id=? AND kind='investments'")
            .bind(&p.household_id)
            .fetch_all(&mut *db)
            .await?;
    for row in investments {
        let value: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid stored investment."))?;
        if value["deleted"] == true || value["currency"] != currency {
            continue;
        }
        let Some(member) = members.iter_mut().find(|m| value["owner_id"] == m.id) else {
            continue;
        };
        if member.id != p.user_id && value["visibility"] != "shared" {
            continue;
        }
        for record in value["records"].as_array().into_iter().flatten() {
            if record["month"].as_str() != Some(&from[..7]) {
                continue;
            }
            let contribution = money(text(record, "contribution")?, currency)?;
            let withdrawal = money(text(record, "withdrawal")?, currency)?;
            member.invested = add(
                member.invested,
                contribution
                    .checked_sub(withdrawal)
                    .ok_or_else(|| ApiError::invalid("Money total is out of range."))?,
            )?;
        }
    }
    let data = members.into_iter().map(|m| -> Result<Value> {
        let categories = m.categories.into_iter().map(|(category_id,value)| Ok(json!({"category_id":category_id,"amount":format_money(value,currency)?}))).collect::<Result<Vec<_>>>()?;
        Ok(json!({"id":m.id,"name":m.name,"income":format_money(m.income,currency)?,"net_spending":format_money(m.spending,currency)?,"net_invested":format_money(m.invested,currency)?,"categories":categories,"investment_visibility":if m.id == p.user_id {"own"} else {"shared_only"}}))
    }).collect::<Result<Vec<_>>>()?;
    ok(
        json!({"data":data,"currency":currency,"from":from,"to":to,"coverage":"visible_records_only"}),
    )
}
async fn analytics(
    db: &mut SqliteConnection,
    p: &Principal,
    report: &str,
    q: &Query,
) -> Result<Reply> {
    let (values, currency, meta) =
        report_inputs(db, p, q, ["transactions", "transfers"].contains(&report)).await?;
    analytics_result(db, p, report, q, values, &currency, meta).await
}

async fn analytics_dashboard(db: &mut SqliteConnection, p: &Principal, q: &Query) -> Result<Reply> {
    let (values, currency, meta) = report_inputs(db, p, q, false).await?;
    let mut reports = serde_json::Map::new();
    for report in [
        "summary",
        "categories",
        "income-categories",
        "merchants",
        "series",
        "types",
        "accounts",
    ] {
        let input = values.clone();
        let mut report_query = q.clone();
        if report == "series" {
            report_query.insert("grain".to_owned(), "day".to_owned());
        }
        let mut report_meta = meta.clone();
        report_meta["filters"] = json!(report_query);
        let (_, value) =
            analytics_result(db, p, report, &report_query, input, &currency, report_meta).await?;
        reports.insert(report.to_owned(), value);
    }
    ok(Value::Object(reports))
}

async fn analytics_result(
    db: &mut SqliteConnection,
    p: &Principal,
    report: &str,
    q: &Query,
    mut values: Vec<Value>,
    currency: &str,
    meta: Value,
) -> Result<Reply> {
    match report {
        "summary" => {
            let mut v = totals(&values, currency)?;
            v["meta"] = meta;
            v["balance_available"] = json!(false);
            v["budget_status"] = Value::Null;
            v["unresolved_count"] = json!(values.len());
            ok(v)
        }
        "transactions" | "transfers" => {
            if report == "transfers" {
                values.retain(|v| v["event_type"] == "transfer");
            }
            values.sort_by(|a, b| {
                (b["effective_date"].as_str(), b["id"].as_str())
                    .cmp(&(a["effective_date"].as_str(), a["id"].as_str()))
            });
            let mut response = paginate(values, q)?;
            response["meta"] = meta;
            ok(response)
        }
        "categories" | "income-categories" | "merchants" => {
            let mut groups: std::collections::BTreeMap<
                String,
                (i64, std::collections::HashSet<String>),
            > = std::collections::BTreeMap::new();
            for v in &values {
                if (report == "income-categories" && v["event_type"] != "income")
                    || (report != "income-categories"
                        && (v["event_type"] == "income" || v["event_type"] == "transfer"))
                {
                    continue;
                }
                for a in v["allocations"].as_array().unwrap() {
                    let key = if report != "merchants" {
                        a["category_id"].as_str().unwrap_or("uncategorized")
                    } else {
                        v["merchant"].as_str().unwrap_or("unknown")
                    }
                    .to_owned();
                    let entry = groups.entry(key).or_default();
                    let n = money(text(a, "amount")?, &currency)?;
                    entry.0 = add(entry.0, if v["event_type"] == "refund" { -n } else { n })?;
                    entry.1.insert(text(v, "id")?.into());
                }
            }
            let data=groups.into_iter().map(|(id,(amount,ids))|Ok(json!({"id":id,"amount":format_money(amount,&currency)?,"currency":currency,"count":ids.len(),"change":null,"change_unavailable_reason":"comparison_not_requested"}))).collect::<Result<Vec<_>>>()?;
            ok(json!({"data":data,"page":{},"meta":meta}))
        }
        "types" => {
            let mut groups: std::collections::BTreeMap<String, (i64, usize)> =
                std::collections::BTreeMap::new();
            for v in &values {
                let entry = groups.entry(text(v, "event_type")?.to_owned()).or_default();
                let scoped_amount = if v["event_type"] == "transfer" {
                    money(text(v, "amount")?, &currency)?
                } else {
                    v["allocations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .try_fold(0_i64, |sum, a| {
                            add(sum, money(text(a, "amount")?, &currency)?)
                        })?
                };
                entry.0 = add(entry.0, scoped_amount)?;
                entry.1 += 1;
            }
            let data = groups.into_iter().map(|(event_type,(total,count))| Ok(json!({"event_type":event_type,"amount":format_money(total,&currency)?,"currency":currency,"count":count}))).collect::<Result<Vec<_>>>()?;
            ok(json!({"data":data,"page":{},"meta":meta}))
        }
        "series" => {
            let grain = q.get("grain").map(String::as_str).unwrap_or("month");
            if !["month", "day"].contains(&grain) {
                return Err(ApiError::invalid("grain must be month or day."));
            }
            if q.contains_key("months") {
                return Err(ApiError::invalid(
                    "Use explicit from/to periods; months shortcuts are not implemented.",
                ));
            }
            let mut buckets: std::collections::BTreeMap<String, Vec<Value>> =
                std::collections::BTreeMap::new();
            let mut day = domain::date(meta["from"].as_str().unwrap())?;
            let end = domain::date(meta["to"].as_str().unwrap())?;
            while day < end {
                let date = day.to_string();
                let key = if grain == "month" {
                    date[..7].to_owned()
                } else {
                    date
                };
                buckets.entry(key).or_default();
                day = day
                    .succ_opt()
                    .ok_or_else(|| ApiError::invalid("Date out of range."))?;
            }
            for v in values {
                let date = text(&v, "effective_date")?;
                let key = if grain == "month" {
                    date[..7].to_owned()
                } else {
                    date.to_owned()
                };
                buckets.entry(key).or_default().push(v);
            }
            let data = buckets
                .into_iter()
                .map(|(period, values)| {
                    let mut row = totals(&values, &currency)?;
                    row["period"] = json!(period);
                    row["coverage"] = json!("unknown");
                    row["complete"] = json!(false);
                    Ok(row)
                })
                .collect::<Result<Vec<_>>>()?;
            ok(json!({"data":data,"balance_snapshots":[],"page":{},"meta":meta}))
        }
        "accounts" | "coverage" => {
            let accounts = storage::list(db, p, "accounts").await?;
            let mut data = vec![];
            for mut a in accounts {
                if a["currency"] != currency
                    || q.get("account_id").is_some_and(|id| a["id"] != id.as_str())
                {
                    continue;
                }
                balances::decorate(db, p, &mut a).await?;
                let mut sum = 0;
                for v in &values {
                    for movement in v["movements"].as_array().unwrap() {
                        if movement["account_id"] == a["id"] {
                            sum = add(sum, money(text(movement, "amount")?, &currency)?)?;
                        }
                    }
                }
                a["signed_movements"] = json!(format_money(sum, &currency)?);
                a["coverage"] = json!("unknown");
                data.push(a);
            }
            ok(json!({"data":data,"page":{},"meta":meta}))
        }
        _ => Err(ApiError::missing()),
    }
}
async fn budget_tracking(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    q: &Query,
) -> Result<Reply> {
    allowed_query(q, &["from", "to"])?;
    let budget = storage::get(db, p, "budgets", id).await?;
    let (start, end) = month_bounds(text(&budget, "month")?)?;
    let from = q.get("from").unwrap_or(&start);
    let to = q.get("to").unwrap_or(&end);
    if from < &start || to > &end {
        return Err(ApiError::invalid(
            "Tracking period must fall within the budget month.",
        ));
    }
    let query = Query::from([
        ("from".into(), from.clone()),
        ("to".into(), to.clone()),
        ("scope".into(), text(&budget, "scope")?.into()),
        ("currency".into(), text(&budget, "currency")?.into()),
    ]);
    let (values, currency, mut meta) = report_inputs(db, p, &query, false).await?;
    let mut actuals: HashMap<String, i64> = HashMap::new();
    for v in &values {
        if !["expense", "refund"].contains(&v["event_type"].as_str().unwrap_or_default()) {
            continue;
        }
        for a in v["allocations"].as_array().unwrap() {
            let key = a["category_id"]
                .as_str()
                .unwrap_or("uncategorized")
                .to_owned();
            let n = money(text(a, "amount")?, &currency)?;
            let old = *actuals.get(&key).unwrap_or(&0);
            actuals.insert(
                key,
                add(old, if v["event_type"] == "refund" { -n } else { n })?,
            );
        }
    }
    let mut lines = vec![];
    for line in budget["lines"].as_array().unwrap() {
        let category = text(line, "category_id")?;
        let planned = money(text(line, "amount")?, &currency)?;
        let actual = actuals.remove(category).unwrap_or(0);
        let remaining = planned
            .checked_sub(actual)
            .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        lines.push(json!({"category_id":category,"planned":format_money(planned,&currency)?,"actual":format_money(actual,&currency)?,"remaining":format_money(remaining,&currency)?,"utilization":if planned==0{None}else{Some(actual as f64/planned as f64)},"coverage":"unknown","transactions_url":format!("/api/v1/analytics/transactions?scope={}&from={from}&to={to}&currency={currency}&category_id={category}",text(&budget,"scope")?)}));
    }
    let unbudgeted = actuals.values().try_fold(0, |a, b| add(a, *b))?;
    let mut unbudgeted_lines = vec![];
    for (category_id, amount) in actuals {
        unbudgeted_lines
            .push(json!({"category_id":category_id,"actual":format_money(amount,&currency)?}));
    }
    unbudgeted_lines.sort_by(|a, b| a["category_id"].as_str().cmp(&b["category_id"].as_str()));
    meta["plan_revision"] = budget["revision"].clone();
    meta["full_plan_period"] = json!(from == &start && to == &end);
    ok(
        json!({"data":lines,"unbudgeted":format_money(unbudgeted,&currency)?,"unbudgeted_lines":unbudgeted_lines,"meta":meta}),
    )
}

async fn create_invite(db: &mut SqliteConnection, p: &Principal, body: &Value) -> Result<Reply> {
    auth::admin(p)?;
    domain::choice(body, "role", &["admin", "member"])?;
    if body["role"] == "admin" && p.role != "owner" {
        return Err(ApiError::forbidden());
    }
    let email = text(body, "email")?.trim().to_lowercase();
    if !email.contains('@') {
        return Err(ApiError::invalid("Invalid email."));
    }
    // Caller generates a 256-bit random token; only its hash is persisted. This also
    // keeps plaintext invite tokens out of durable idempotency response records.
    let token = text(body, "token")?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::invalid(
            "token must be 32 cryptographically random bytes encoded as 64 hex characters.",
        ));
    }
    let now = Utc::now().timestamp();
    let expiry = if let Some(s) = body["expires_at"].as_str() {
        chrono::DateTime::parse_from_rfc3339(s)
            .map_err(|_| ApiError::invalid("Invalid expires_at."))?
            .timestamp()
    } else {
        now + 86400
    };
    if expiry <= now || expiry > now + 86400 * 7 {
        return Err(ApiError::invalid(
            "Invite expiry must be within seven days.",
        ));
    }
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM invites WHERE token_hash=?")
        .bind(auth::hash(token))
        .fetch_one(&mut *db)
        .await?;
    if exists > 0 {
        return Err(ApiError::conflict("Invite token is already used."));
    }
    let id = storage::id();
    sqlx::query(
        "INSERT INTO invites(token_hash,id,household_id,email,role,expires_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(auth::hash(token))
    .bind(&id)
    .bind(&p.household_id)
    .bind(email)
    .bind(text(body, "role")?)
    .bind(expiry)
    .execute(&mut *db)
    .await?;
    let value = json!({"invite_id":id,"expires_at":chrono::DateTime::from_timestamp(expiry,0).unwrap().to_rfc3339()});
    storage::audit(db, p, &id, "invite", None, Some(&value)).await?;
    created(value)
}
async fn accept_invite(db: &mut SqliteConnection, p: &Principal, token: &str) -> Result<Reply> {
    let row=sqlx::query("SELECT household_id,email,role FROM invites WHERE token_hash=? AND used=0 AND expires_at>?").bind(auth::hash(token)).bind(Utc::now().timestamp()).fetch_optional(&mut *db).await?.ok_or_else(ApiError::missing)?;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=?")
        .bind(&p.user_id)
        .fetch_one(&mut *db)
        .await?;
    if email.to_lowercase() != row.get::<String, _>(1).to_lowercase() {
        return Err(ApiError::missing());
    }
    let household: String = row.get(0);
    let role: String = row.get(2);
    let id = storage::id();
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=?")
            .bind(&household)
            .bind(&p.user_id)
            .fetch_one(&mut *db)
            .await?;
    if exists > 0 {
        return Err(ApiError::conflict("Membership already exists."));
    }
    sqlx::query("INSERT INTO memberships(id,household_id,user_id,role) VALUES(?,?,?,?)")
        .bind(&id)
        .bind(&household)
        .bind(&p.user_id)
        .bind(&role)
        .execute(&mut *db)
        .await?;
    sqlx::query("UPDATE invites SET used=1 WHERE token_hash=?")
        .bind(auth::hash(token))
        .execute(&mut *db)
        .await?;
    let value = json!({"id":id,"household_id":household,"role":role,"revision":1});
    let actor = Principal {
        household_id: household,
        ..p.clone()
    };
    storage::audit(db, &actor, &id, "invite_accepted", None, Some(&value)).await?;
    ok(value)
}
async fn edit_member(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    auth::admin(p)?;
    let row = sqlx::query(
        "SELECT user_id,role,revision FROM memberships WHERE id=? AND household_id=? AND active=1",
    )
    .bind(id)
    .bind(&p.household_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(ApiError::missing)?;
    let user: String = row.get(0);
    let role: String = row.get(1);
    let rev: i64 = row.get(2);
    let before = json!({"id":id,"role":role,"revision":rev});
    revision(headers, body, &before)?;
    if role == "owner" || (role == "admin" && p.role != "owner") {
        return Err(ApiError::forbidden());
    }
    let after = if method == "DELETE" {
        sqlx::query("UPDATE memberships SET active=0,revision=revision+1 WHERE id=?")
            .bind(id)
            .execute(&mut *db)
            .await?;
        sqlx::query("DELETE FROM sessions WHERE user_id=? AND household_id=?")
            .bind(user)
            .bind(&p.household_id)
            .execute(&mut *db)
            .await?;
        json!({"id":id,"active":false,"revision":rev+1})
    } else {
        domain::choice(body, "role", &["admin", "member"])?;
        if body["role"] == "admin" && p.role != "owner" {
            return Err(ApiError::forbidden());
        }
        sqlx::query("UPDATE memberships SET role=?,revision=revision+1 WHERE id=?")
            .bind(text(body, "role")?)
            .bind(id)
            .execute(&mut *db)
            .await?;
        json!({"id":id,"role":body["role"],"revision":rev+1})
    };
    storage::audit(db, p, id, "membership_changed", Some(&before), Some(&after)).await?;
    if method == "DELETE" {
        no_content()
    } else {
        ok(after)
    }
}

pub fn openapi() -> Value {
    contract().clone()
}
fn contract() -> &'static Value {
    static CONTRACT: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../openapi.json"))
            .expect("checked-in OpenAPI must be valid JSON")
    })
}

fn operation(method: &str, path: &str) -> Option<&'static Value> {
    contract()["paths"]
        .as_object()
        .unwrap()
        .iter()
        .find_map(|(pattern, item)| {
            let template: Vec<_> = pattern.trim_start_matches('/').split('/').collect();
            let actual: Vec<_> = path.split('/').collect();
            if template.len() == actual.len()
                && template
                    .iter()
                    .zip(actual)
                    .all(|(a, b)| a.starts_with('{') || *a == b)
            {
                item.get(method.to_lowercase())
            } else {
                None
            }
        })
}
fn known_route(method: &str, path: &str) -> bool {
    operation(method, path).is_some()
}

pub(crate) fn allowed_body(body: &Value, fields: &[&str]) -> Result<()> {
    if let Some(key) = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("Expected a JSON object."))?
        .keys()
        .find(|k| k.as_str() != "expected_revision" && !fields.contains(&k.as_str()))
    {
        return Err(ApiError::invalid(format!("Unsupported field: {key}.")));
    }
    Ok(())
}
