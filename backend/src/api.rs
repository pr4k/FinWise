use crate::{
    AppState, budget_forecast::{self, PeriodPhase},
    auth::{self, Principal},
    balances,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    imports, planning, quick, reconciliation, recurring, storage, widgets,
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
use std::collections::{HashMap, HashSet};

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
    let widget_request = request.method() == axum::http::Method::GET
        && ["/api/v1/widgets/spending", "/api/v1/widgets/accounts", "/api/v1/widgets/expense-calendar"]
            .contains(&request.uri().path().trim_end_matches('/'));
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
    let widget_success = widget_request && response.status().is_success();
    let headers = response.headers_mut();
    headers.insert("x-request-id", request_id.parse().unwrap());
    headers.insert(header::CACHE_CONTROL,
        if widget_success { "private, max-age=300" } else { "no-store" }.parse().unwrap());
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
    if (path == "quick-transactions" || path == "quick-transactions/options")
        && !quick::available(&state.pool).await?
    {
        return Err(ApiError::missing());
    }
    let query: Query = axum::extract::Query::try_from_uri(&parts.uri)
        .map_err(|_| ApiError::invalid("Invalid query string."))?
        .0;
    if method == "GET" && path == "widgets/spending" {
        return widgets::spending(state, &query).await;
    }
    if method == "GET" && path == "widgets/expense-calendar" {
        return widgets::expense_calendar(state, &query).await;
    }
    if method == "GET" && path == "widgets/accounts" {
        return widgets::accounts(state, &query).await;
    }
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
    if path == "quick-transactions" || path == "quick-transactions/options" {
        return quick::route(state, method, path, &query, &parts.headers, &body).await;
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
pub(crate) fn reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "idempotency_key_reused",
        "Idempotency key was already used for another request.",
    )
}
pub(crate) fn idempotency_key(headers: &HeaderMap) -> Result<&str> {
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
const CATEGORY_FIELDS: &[&str] = &["name", "kind", "parent_id", "visibility", "tracking_type"];
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
    "paid_by_user_id",
];
const BUDGET_FIELDS: &[&str] = &[
    "name",
    "month",
    "scope",
    "currency",
    "expected_income",
    "savings_goal",
    "lines",
    "people_limits",
    "targets",
];

pub(crate) async fn route(
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
        ("GET", ["planned-items"]) => {
            allowed_query(q, &["month"])?;
            let month = q.get("month").ok_or_else(|| ApiError::invalid("month is required."))?;
            let (from, to) = month_bounds(month)?;
            let mut values = storage::list(db, p, "planned_items").await?;
            values.retain(|v| v["due_date"].as_str().is_some_and(|d| d >= from.as_str() && d < to.as_str()) && v["deleted"] != true);
            values.sort_by(|a,b| a["due_date"].as_str().cmp(&b["due_date"].as_str()));
            ok(collection(values))
        }
        ("POST", ["planned-items"]) => {
            allowed_body(body, &["title","due_date","amount","currency","category_id","account_id","visibility","budget_commitment","budget_destination"])?;
            let mut value = body.clone();
            if family_only(db,p).await? { value["visibility"] = json!("shared"); }
            validate_planned_item(db,p,&value).await?;
            value["status"] = json!("planned"); value["deleted"] = json!(false);
            created(storage::create(db,p,"planned_items",value).await?)
        }
        ("PATCH", ["planned-items", id]) => {
            allowed_body(body, &["title","due_date","amount","currency","category_id","account_id","visibility","status","budget_commitment","budget_destination"])?;
            let before = storage::get(db,p,"planned_items",id).await?;
            if before["owner_id"] != p.user_id || before["deleted"] == true { return Err(ApiError::forbidden()); }
            revision(headers,body,&before)?;
            let mut after = patch(&before,body,&["title","due_date","amount","currency","category_id","account_id","visibility","status","budget_commitment","budget_destination"]);
            if family_only(db,p).await? { after["visibility"] = json!("shared"); }
            validate_planned_item(db,p,&after).await?;
            domain::choice(&after,"status",&["planned","done","skipped"])?;
            let matched: i64 = sqlx::query_scalar("SELECT count(*) FROM planned_item_matches WHERE household_id=? AND planned_item_id=?")
                .bind(&p.household_id).bind(id).fetch_one(&mut *db).await?;
            if matched > 0 && (after["status"] != "done" || after["budget_commitment"] != true || after["due_date"] != before["due_date"] || after["amount"] != before["amount"] || after["currency"] != before["currency"] || after["category_id"] != before["category_id"] || after["visibility"] != before["visibility"] || after["account_id"] != before["account_id"] || after["budget_destination"] != before["budget_destination"]) {
                return Err(ApiError::conflict("Unmatch this commitment before changing its financial details or status."));
            }
            if after["budget_commitment"] == true && after["status"] == "done" && matched == 0 {
                return Err(ApiError::conflict("Match the posted expense before marking a budget commitment done."));
            }
            ok(storage::update(db,p,&before,after,"update").await?)
        }
        ("DELETE", ["planned-items", id]) => {
            let before = storage::get(db,p,"planned_items",id).await?;
            if before["owner_id"] != p.user_id { return Err(ApiError::forbidden()); }
            revision(headers,body,&before)?;
            let matched: i64 = sqlx::query_scalar("SELECT count(*) FROM planned_item_matches WHERE household_id=? AND planned_item_id=?")
                .bind(&p.household_id).bind(id).fetch_one(&mut *db).await?;
            if matched > 0 { return Err(ApiError::conflict("Unmatch this commitment before removing it.")); }
            let mut after = before.clone(); after["deleted"] = json!(true);
            storage::update(db,p,&before,after,"delete").await?;
            no_content()
        }
        ("POST", ["planned-items", id, "match"]) => {
            allowed_body(body, &["transaction_id", "reason"])?;
            let before = storage::get(db, p, "planned_items", id).await?;
            if before["owner_id"] != p.user_id || before["deleted"] == true { return Err(ApiError::forbidden()); }
            revision(headers, body, &before)?;
            if before["budget_commitment"] != true || before["status"] != "planned" {
                return Err(ApiError::conflict("Only a planned budget commitment can be matched."));
            }
            let reason = text(body, "reason")?.trim();
            if reason.is_empty() || reason.len() > 500 { return Err(ApiError::invalid("Match reason must be 1–500 characters.")); }
            let transaction_id = text(body, "transaction_id")?;
            let transaction = storage::get(db, p, "transactions", transaction_id).await?;
            validate_commitment_transaction(db, p, &before, &transaction).await?;
            let used: i64 = sqlx::query_scalar("SELECT count(*) FROM planned_item_matches WHERE household_id=? AND transaction_id=?")
                .bind(&p.household_id).bind(transaction_id).fetch_one(&mut *db).await?;
            if used > 0 { return Err(ApiError::conflict("This expense is already matched to another commitment.")); }
            sqlx::query("INSERT INTO planned_item_matches(household_id,planned_item_id,transaction_id,actor_id,reason,matched_at) VALUES(?,?,?,?,?,?)")
                .bind(&p.household_id).bind(id).bind(transaction_id).bind(&p.user_id).bind(reason).bind(storage::now()).execute(&mut *db).await?;
            let mut after = before.clone(); after["status"] = json!("done");
            let result = storage::update(db, p, &before, after, "budget_commitment_matched").await?;
            storage::audit(db, p, id, "budget_commitment_match_reason", None, Some(&json!({"reason":reason,"transaction_id":transaction_id}))).await?;
            ok(result)
        }
        ("DELETE", ["planned-items", id, "match"]) => {
            allowed_body(body, &["reason"])?;
            let before = storage::get(db, p, "planned_items", id).await?;
            if before["owner_id"] != p.user_id || before["deleted"] == true { return Err(ApiError::forbidden()); }
            revision(headers, body, &before)?;
            let reason = text(body, "reason")?.trim();
            if reason.is_empty() || reason.len() > 500 { return Err(ApiError::invalid("Unmatch reason must be 1–500 characters.")); }
            let deleted = sqlx::query("DELETE FROM planned_item_matches WHERE household_id=? AND planned_item_id=?")
                .bind(&p.household_id).bind(id).execute(&mut *db).await?.rows_affected();
            if deleted == 0 { return Err(ApiError::conflict("This commitment is not matched.")); }
            let mut after = before.clone(); after["status"] = json!("planned");
            storage::update(db, p, &before, after, "budget_commitment_unmatched").await?;
            storage::audit(db, p, id, "budget_commitment_unmatch_reason", None, Some(&json!({"reason":reason}))).await?;
            no_content()
        }
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
            if family_only(db, p).await? && scope != "family" {
                return Err(ApiError::invalid("Family only mode requires family scope."));
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
                    if allocation["scope"] == "personal" && scope == "family" {
                        allocation.as_object_mut().unwrap().remove("budget_destination");
                    }
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
            if !money_manager_extension(db, p).await? { return Err(ApiError::missing()); }
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
                    && v["money_manager_excluded"] != true
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
            if !money_manager_extension(db, p).await? { return Err(ApiError::missing()); }
            allowed_body(body, &["synced"])?;
            let synced = body["synced"]
                .as_bool()
                .ok_or_else(|| ApiError::invalid("synced must be a boolean."))?;
            let before = storage::get(db, p, "transactions", id).await?;
            revision(headers, body, &before)?;
            if before["money_manager_excluded"] == true { return Err(ApiError::missing()); }
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
        ("GET" | "PATCH", ["settings", "widgets"]) =>
            widgets::settings(db, p, method, q, headers, body).await,
        ("GET" | "PATCH", ["settings", "quick-expense"]) =>
            quick::settings(db, p, method, q, headers, body).await,
        ("PATCH", ["settings", "household"]) => {
            auth::admin(p)?;
            let before = auth::me(db, p).await?["household"].clone();
            revision(headers, body, &before)?;
            allowed_body(body, &["name", "timezone", "base_currency", "locale", "family_only", "money_manager_extension"])?;
            let mut after = patch(
                &before,
                body,
                &["name", "timezone", "base_currency", "locale", "family_only", "money_manager_extension"],
            );
            if !after["family_only"].is_null() && !after["family_only"].is_boolean() {
                return Err(ApiError::invalid("family_only must be a boolean."));
            }
            if body.get("money_manager_extension").is_some() && !body["money_manager_extension"].is_boolean() {
                return Err(ApiError::invalid("money_manager_extension must be a boolean."));
            }
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
            if before["family_only"] != true && after["family_only"] == true {
                enable_family_only(db, p).await?;
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
            if family_only(db, p).await? { force_family(kind, &mut value); }
            match *kind {
                "accounts" => {
                    value["active"] = json!(true);
                    if value.get("visibility").is_none() {
                        value["visibility"] = json!("private");
                    }
                    validate_account(&value)?;
                }
                "categories" => {
                    if value.get("visibility").is_none() { value["visibility"] = json!("shared"); }
                    if value["visibility"] == "shared" && !family_only(db,p).await? { auth::admin(p)?; }
                    value["archived"] = json!(false);
                    validate_category(db, p, &value, None).await?;
                }
                "transactions" => {
                    value["voided"] = json!(false);
                    if !money_manager_extension(db, p).await? { value["money_manager_excluded"] = json!(true); }
                    if ["investment", "investment_withdrawal"].contains(&value["event_type"].as_str().unwrap_or("")) {
                        return Err(ApiError::invalid("Record investment movements through Investments."));
                    }
                    value["entered_by"] = json!(p.user_id);
                    if value.get("paid_by_user_id").is_none() && (value["event_type"] == "expense" || value["event_type"] == "refund") {
                        value["paid_by_user_id"] = json!(p.user_id);
                    }
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
            if family_only(db, p).await? { force_family(kind, &mut after); }
            match *kind {
                "accounts" => {
                    if before["owner_id"] != p.user_id {
                        return Err(ApiError::forbidden());
                    }
                    if before["visibility"] == "private" && after["visibility"] == "shared" {
                        let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND EXISTS (SELECT 1 FROM json_each(resources.document,'$.movements') m WHERE json_extract(m.value,'$.account_id')=?)")
                            .bind(&p.household_id).bind(id).fetch_all(&mut *db).await?;
                        for row in rows {
                            let transaction: Value = serde_json::from_str(&row).map_err(|_| ApiError::invalid("Invalid stored transaction."))?;
                            for allocation in transaction["allocations"].as_array().into_iter().flatten() {
                                if let Some(category_id) = allocation["category_id"].as_str() {
                                    let category = storage::raw(db,p,"categories",category_id).await?;
                                    if category["visibility"] == "private" {
                                        return Err(ApiError::conflict("Move categories used by this account to household access first."));
                                    }
                                }
                            }
                        }
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
                    if before["owner_id"] != p.user_id { auth::admin(p)?; }
                    if after.get("visibility").is_none() { after["visibility"] = json!("shared"); }
                    if before["visibility"] != "private" && after["visibility"] == "private" {
                        return Err(ApiError::conflict("Household categories cannot be made personal after sharing."));
                    }
                    validate_category(db, p, &after, Some(id)).await?;
                }
                "transactions" => {
                    if before["voided"] == true {
                        return Err(ApiError::conflict("Voided transactions cannot be edited."));
                    }
                    if planning::transaction_linked(db, p, id).await? {
                        return Err(ApiError::conflict("Unlink this transaction from its investment holding before editing it."));
                    }
                    if !before["investment_id"].is_null() {
                        return Err(ApiError::conflict("Edit this movement from its investment month."));
                    }
                    if after["effective_at"].is_null() {
                        after.as_object_mut().unwrap().remove("effective_at");
                    }
                    if !["expense", "refund"].contains(&after["event_type"].as_str().unwrap_or("")) {
                        after.as_object_mut().unwrap().remove("paid_by_user_id");
                    } else if after["paid_by_user_id"].is_null() {
                        after["paid_by_user_id"] = json!(p.user_id);
                    }
                    validate_ledger_with_history(db, p, &after, Some(&before)).await?;
                }
                "budgets" => {
                    budget_write(p, &before)?;
                    if before["state"] == "archived" {
                        return Err(ApiError::conflict("Archived budgets cannot be edited."));
                    }
                    return Err(ApiError::conflict("Preview the budget change and save it as an amendment."));
                }
                _ => unreachable!(),
            }
            if *kind == "transactions" {
                reconciliation::invalidate(db, p, id).await?;
                after["reconciliation_state"] = json!("unmatched");
                let extension = money_manager_extension(db, p).await?;
                if extension {
                    after["money_manager_synced_at"] = Value::Null;
                } else {
                    after["money_manager_excluded"] = json!(true);
                }
                if extension
                    && !before["source_refs"].as_array().is_some_and(Vec::is_empty)
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
            if !before["investment_id"].is_null() {
                return Err(ApiError::conflict("Remove this movement from its investment month."));
            }
            if planning::transaction_linked(db, p, id).await? {
                return Err(ApiError::conflict("Unlink this transaction from its investment holding before deleting it."));
            }
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
            let before = storage::get(db, p, "categories", id).await?;
            if before["owner_id"] != p.user_id { auth::admin(p)?; }
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
                let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND EXISTS (SELECT 1 FROM json_each(resources.document,'$.movements') m WHERE json_extract(m.value,'$.account_id')=?)")
                    .bind(&p.household_id).bind(id).fetch_all(&mut *db).await?;
                for row in rows {
                    let transaction: Value = serde_json::from_str(&row).map_err(|_| ApiError::invalid("Invalid stored transaction."))?;
                    for allocation in transaction["allocations"].as_array().into_iter().flatten() {
                        if let Some(category_id) = allocation["category_id"].as_str() {
                            let category = storage::raw(db,p,"categories",category_id).await?;
                            if category["visibility"] == "private" { return Err(ApiError::conflict("Move categories used by this account to household access first.")); }
                        }
                    }
                }
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
                                "savings_goal",
                                "lines",
                                "people_limits",
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
        ("GET", ["budgets", id, "allocations"]) => budget_allocations(db, p, id, q).await,
        ("GET", ["budgets", id, "matrix"]) => budget_matrix(db, p, id, q).await,
        ("POST", ["budgets", id, "plan-preview"]) => {
            allowed_body(body, &["name", "expected_income", "savings_goal", "lines", "people_limits"])?;
            let before = storage::get(db, p, "budgets", id).await?;
            budget_write(p, &before)?;
            revision(headers, body, &before)?;
            if before["state"] == "archived" { return Err(ApiError::conflict("Archived budgets cannot be edited.")); }
            let (_, preview) = preview_budget_change(db, p, &before, body).await?;
            ok(preview)
        }
        ("POST", ["budgets", id, "amendments"]) => {
            allowed_body(body, &["proposal", "preview_hash", "reason", "accept_unfunded"])?;
            let before = storage::get(db, p, "budgets", id).await?;
            budget_write(p, &before)?;
            revision(headers, body, &before)?;
            if before["state"] == "archived" { return Err(ApiError::conflict("Archived budgets cannot be edited.")); }
            let reason = text(body, "reason")?.trim();
            if reason.is_empty() || reason.len() > 500 { return Err(ApiError::invalid("Amendment reason must be 1–500 characters.")); }
            let proposal = body.get("proposal").filter(|value| value.is_object()).ok_or_else(|| ApiError::invalid("proposal must be an object."))?;
            allowed_body(proposal, &["name", "expected_income", "savings_goal", "lines", "people_limits"])?;
            let (mut after, preview) = preview_budget_change(db, p, &before, proposal).await?;
            if preview["preview_hash"] != body["preview_hash"] { return Err(ApiError::conflict("Plan preview changed. Review the budget again.")); }
            if preview["unfunded_warning"] == true && body["accept_unfunded"] != true {
                return Err(ApiError::conflict("Confirm the unfunded budget increase before saving."));
            }
            after["last_amendment"] = json!({"reason":reason,"actor_id":p.user_id,"at":storage::now(),"total_allowance_delta":preview["total_allowance_delta"]});
            let result = storage::update(db, p, &before, after, "budget_amendment").await?;
            storage::audit(db, p, id, "budget_amendment_reason", None, Some(&json!({"reason":reason,"preview":preview}))).await?;
            ok(result)
        }
        ("GET", ["budgets", id, "forecast"]) => budget_forecast_view(db, p, id, q).await,
        ("GET", ["budgets", id, "people"]) => budget_people(db, p, id, q).await,
        ("GET", ["budgets", id, "commitments"]) => {
            allowed_query(q, &[])?;
            let budget = storage::get(db, p, "budgets", id).await?;
            ok(budget_commitments(db, p, &budget).await?)
        },
        ("GET", ["households", household, "members"]) if *household == p.household_id => {
            let rows=sqlx::query("SELECT m.id,m.role,m.revision,u.name,u.email,u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND m.active=1 ORDER BY m.id").bind(&p.household_id).fetch_all(db).await?;
            ok(collection(rows.into_iter().map(|r|json!({"id":r.get::<&str,_>(0),"role":r.get::<&str,_>(1),"revision":r.get::<i64,_>(2),"name":r.get::<&str,_>(3),"email":r.get::<&str,_>(4),"user_id":r.get::<&str,_>(5)})).collect()))
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

async fn family_only(db: &mut SqliteConnection, p: &Principal) -> Result<bool> {
    Ok(auth::me(db, p).await?["household"]["family_only"] == true)
}

async fn money_manager_extension(db: &mut SqliteConnection, p: &Principal) -> Result<bool> {
    Ok(auth::me(db, p).await?["household"]["money_manager_extension"] != false)
}

fn force_family(kind: &str, value: &mut Value) {
    match kind {
        "accounts" | "categories" => value["visibility"] = json!("shared"),
        "budgets" => value["scope"] = json!("family"),
        "transactions" => {
            if let Some(allocations) = value["allocations"].as_array_mut() {
                for allocation in allocations {
                    if allocation["scope"] == "personal" {
                        allocation.as_object_mut().map(|a| a.remove("budget_destination"));
                    }
                    allocation["scope"] = json!("family");
                    allocation.as_object_mut().map(|a| a.remove("beneficiary_id"));
                }
            }
        }
        _ => {}
    }
}

async fn enable_family_only(db: &mut SqliteConnection, p: &Principal) -> Result<()> {
    // The caller is a household admin. This runs in the request transaction.
    for kind in ["categories", "accounts", "planned_items", "transactions", "budgets"] {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT document FROM resources WHERE household_id=? AND kind=? ORDER BY id",
        )
        .bind(&p.household_id)
        .bind(kind)
        .fetch_all(&mut *db)
        .await?;
        for row in rows {
            let before: Value = serde_json::from_str(&row)
                .map_err(|_| ApiError::invalid("Invalid stored resource."))?;
            let mut after = before.clone();
            match kind {
                "categories" | "accounts" | "planned_items" => {
                    if after["visibility"] == "private" { after["visibility"] = json!("shared"); }
                }
                "transactions" => {
                    if let Some(allocations) = after["allocations"].as_array_mut() {
                        for allocation in allocations {
                            if allocation["scope"] == "personal" {
                                allocation.as_object_mut().map(|a| a.remove("budget_destination"));
                            }
                            allocation["scope"] = json!("family");
                            allocation.as_object_mut().map(|a| a.remove("beneficiary_id"));
                        }
                    }
                }
                "budgets" => {
                    if after["scope"] == "personal" {
                        let conflict: i64 = sqlx::query_scalar("SELECT count(*) FROM resources WHERE household_id=? AND kind='budgets' AND id<>? AND json_extract(document,'$.scope')='family' AND json_extract(document,'$.month')=? AND json_extract(document,'$.currency')=? AND json_extract(document,'$.state')<>'archived'")
                            .bind(&p.household_id).bind(text(&before,"id")?).bind(text(&before,"month")?).bind(text(&before,"currency")?).fetch_one(&mut *db).await?;
                        after["scope"] = json!("family");
                        if conflict > 0 { after["state"] = json!("archived"); }
                    }
                }
                _ => {}
            }
            if after != before {
                storage::update(db, p, &before, after, "family_only_conversion").await?;
            }
        }
    }
    Ok(())
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
async fn validate_planned_item(db: &mut SqliteConnection, p: &Principal, v: &Value) -> Result<()> {
    let title = text(v,"title")?;
    if title.trim().is_empty() || title.len() > 200 { return Err(ApiError::invalid("Title must be 1–200 characters.")); }
    domain::date(text(v,"due_date")?)?;
    let currency = text(v,"currency")?;
    if domain::money(text(v,"amount")?,currency)? <= 0 { return Err(ApiError::invalid("Planned amount must be positive.")); }
    domain::choice(v,"visibility",&["private","shared"])?;
    if let Some(account_id) = v["account_id"].as_str() {
        let account = storage::get(db,p,"accounts",account_id).await?;
        if account["currency"] != v["currency"] { return Err(ApiError::invalid("Planned account currency differs from amount.")); }
        if v["visibility"] == "shared" && account["visibility"] != "shared" { return Err(ApiError::invalid("A household plan needs a shared account, or no account.")); }
    } else if !v["account_id"].is_null() { return Err(ApiError::invalid("Invalid planned account.")); }
    if let Some(category_id) = v["category_id"].as_str() {
        let category = storage::get(db,p,"categories",category_id).await?;
        if category["kind"] != "expense" || category["archived"] == true { return Err(ApiError::invalid("Choose an active expense category.")); }
        if v["visibility"] == "shared" && category["visibility"] == "private" { return Err(ApiError::invalid("A household plan needs a household category.")); }
    } else if !v["category_id"].is_null() { return Err(ApiError::invalid("Invalid planned category.")); }
    if v.get("budget_commitment").is_some_and(|flag| !flag.is_boolean()) {
        return Err(ApiError::invalid("budget_commitment must be a boolean."));
    }
    if v["budget_commitment"] == true {
        if v["category_id"].is_null() {
            return Err(ApiError::invalid("A budget commitment needs an expense category."));
        }
        if let Some(destination) = v.get("budget_destination") {
            let destination = destination.as_str().ok_or_else(|| ApiError::invalid("Invalid budget destination."))?;
            if v["visibility"] == "private" {
                if destination != p.user_id { return Err(ApiError::invalid("A private commitment belongs to its owner.")); }
            } else if !["shared", "unassigned"].contains(&destination) {
                let known: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=?")
                    .bind(&p.household_id).bind(destination).fetch_one(&mut *db).await?;
                if known == 0 { return Err(ApiError::invalid("Budget destination must be a household member.")); }
            }
        }
    } else if v.get("budget_destination").is_some_and(|destination| !destination.is_null()) {
        return Err(ApiError::invalid("Only budget commitments have a budget destination."));
    }
    Ok(())
}
async fn validate_commitment_transaction(db: &mut SqliteConnection, p: &Principal, item: &Value, transaction: &Value) -> Result<()> {
    if transaction["voided"] == true || transaction["event_type"] != "expense"
        || transaction["currency"] != item["currency"]
        || money(text(transaction, "amount")?, text(item, "currency")?)? != money(text(item, "amount")?, text(item, "currency")?)? {
        return Err(ApiError::invalid("Match a posted expense with the same amount and currency."));
    }
    let due = text(item, "due_date")?;
    let posted = text(transaction, "effective_date")?;
    if due.get(..7) != posted.get(..7) {
        return Err(ApiError::invalid("The posted expense must belong to the commitment month."));
    }
    let scope = if item["visibility"] == "shared" { "family" } else { "personal" };
    if scope == "personal" && transaction["entered_by"] != item["owner_id"] {
        return Err(ApiError::invalid("A personal commitment needs the owner's expense."));
    }
    let allocations = transaction["allocations"].as_array().ok_or_else(|| ApiError::invalid("Invalid transaction allocations."))?;
    if allocations.is_empty() || allocations.iter().any(|line| line["scope"] != scope || line["category_id"] != item["category_id"]) {
        return Err(ApiError::invalid("The posted expense must use the commitment category and scope."));
    }
    if let Some(account_id) = item["account_id"].as_str()
        && !transaction["movements"].as_array().is_some_and(|movements| movements.iter().any(|movement| movement["account_id"] == account_id)) {
        return Err(ApiError::invalid("The posted expense uses a different account."));
    }
    if scope == "family" {
        for movement in transaction["movements"].as_array().into_iter().flatten() {
            let account = storage::raw(db, p, "accounts", text(movement, "account_id")?).await?;
            if account["visibility"] != "shared" {
                return Err(ApiError::invalid("Match a household commitment to an expense from a shared account."));
            }
        }
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
    domain::choice(v, "visibility", &["private", "shared"])?;
    if let Some(tracking) = v.get("tracking_type") {
        let tracking = tracking.as_str().ok_or_else(|| ApiError::invalid("tracking_type must be regular, investment, or subscription."))?;
        if !["regular", "investment", "subscription"].contains(&tracking) || (v["kind"] != "expense" && tracking != "regular") {
            return Err(ApiError::invalid("Only expense categories can track investments or subscriptions."));
        }
    }
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
        if v["visibility"] == "shared" && category["visibility"] == "private" {
            return Err(ApiError::invalid("A household category needs a household parent."));
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
    validate_ledger_with_history(db, p, v, None).await
}
pub(crate) async fn validate_ledger_with_history(
    db: &mut SqliteConnection,
    p: &Principal,
    v: &Value,
    before: Option<&Value>,
) -> Result<()> {
    domain::validate_transaction(v)?;
    if let Some(payer) = v.get("paid_by_user_id") {
        let payer = payer.as_str().ok_or_else(|| ApiError::invalid("Paid by must be a household member."))?;
        let active: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=? AND active=1")
            .bind(&p.household_id).bind(payer).fetch_one(&mut *db).await?;
        if active == 0 { return Err(ApiError::invalid("Paid by must be an active household member.")); }
    }
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
        let previously_used = before.is_some_and(|old| old["movements"].as_array().is_some_and(|legs| legs.iter().any(|leg| leg["account_id"] == a["id"])));
        if (a["active"] == false && !previously_used) || a["currency"] != v["currency"] {
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
        if let Some(destination) = allocation.get("budget_destination") {
            if !["expense", "refund"].contains(&v["event_type"].as_str().unwrap_or_default()) {
                return Err(ApiError::invalid("Only expense and refund allocations have a budget destination."));
            }
            let destination = destination.as_str().ok_or_else(|| ApiError::invalid("Budget destination must be a member ID, shared, or unassigned."))?;
            if allocation["scope"] == "personal" {
                if destination != p.user_id {
                    return Err(ApiError::invalid("Personal budget usage must stay with the current member."));
                }
            } else if !["shared", "unassigned"].contains(&destination) {
                let known: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=?")
                    .bind(&p.household_id).bind(destination).fetch_one(&mut *db).await?;
                if known == 0 {
                    return Err(ApiError::invalid("Budget destination must be a household member."));
                }
            }
        }
        if let Some(category) = allocation["category_id"].as_str() {
            let c = storage::get(db, p, "categories", category).await?;
            let expected = if v["event_type"] == "income" {
                "income"
            } else {
                "expense"
            };
            let previously_used = before.is_some_and(|old| old["allocations"].as_array().is_some_and(|items| items.iter().any(|item| item["category_id"] == c["id"])));
            if (c["archived"] == true && !previously_used) || c["kind"] != expected {
                return Err(ApiError::invalid(
                    "Allocation category must be active and match the event kind.",
                ));
            }
            if c["visibility"] == "private" {
                if allocation["scope"] != "personal" { return Err(ApiError::invalid("Personal categories require a personal allocation.")); }
                for movement in v["movements"].as_array().unwrap() {
                    let account = storage::get(db,p,"accounts",text(movement,"account_id")?).await?;
                    if account["visibility"] != "private" || account["owner_id"] != p.user_id {
                        return Err(ApiError::invalid("Personal categories require your private account."));
                    }
                    let grants: i64 = sqlx::query_scalar("SELECT count(*) FROM account_access WHERE account_id=?")
                        .bind(text(&account,"id")?).fetch_one(&mut *db).await?;
                    if grants > 0 { return Err(ApiError::invalid("Personal categories require an account without member access grants.")); }
                }
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
        && !["expense", "income", "refund", "transfer", "investment", "investment_withdrawal"].contains(&event_type.as_str())
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
            || (["transfer", "investment", "investment_withdrawal"].contains(&v["event_type"].as_str().unwrap_or(""))
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
    if (v["scope"] == "family" && ["owner", "admin"].contains(&p.role.as_str()))
        || (v["scope"] == "personal" && v["owner_id"] == p.user_id) {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}
async fn preview_budget_change(db: &mut SqliteConnection, p: &Principal, before: &Value, proposal: &Value) -> Result<(Value, Value)> {
    let after = patch(before, proposal, &["name", "expected_income", "savings_goal", "lines", "people_limits"]);
    validate_budget(db, p, &after, Some(text(before, "id")?)).await?;
    let fields = ["name", "expected_income", "savings_goal", "lines", "people_limits"];
    let currency = text(before, "currency")?;
    let sum_lines = |value: &Value| -> Result<i64> {
        value["lines"].as_array().into_iter().flatten().try_fold(0_i64, |sum, line| add(sum, money(text(line, "amount")?, currency)?))
    };
    let before_total = sum_lines(before)?;
    let after_total = sum_lines(&after)?;
    let summary = |value: &Value, total: i64| -> Result<Value> {
        let income = money(text(value, "expected_income")?, currency)?;
        let savings = value["savings_goal"].as_str().map(|amount| money(amount, currency)).transpose()?.unwrap_or(0);
        let gap = income.checked_sub(total).and_then(|remaining| remaining.checked_sub(savings))
            .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        Ok(json!({"total_allowance":format_money(total,currency)?,"expected_income":format_money(income,currency)?,"savings_goal":format_money(savings,currency)?,"funding_gap":format_money(gap,currency)?}))
    };
    let before_summary = summary(before, before_total)?;
    let after_summary = summary(&after, after_total)?;
    let before_gap = money(text(&before_summary, "funding_gap")?, currency)?;
    let after_gap = money(text(&after_summary, "funding_gap")?, currency)?;
    let changes = |key: &str| -> Result<Vec<Value>> {
        let mut old = HashMap::<String,(i64,String)>::new();
        let mut new = HashMap::<String,(i64,String)>::new();
        for line in before[key].as_array().into_iter().flatten() {
            let name = if key == "lines" { "category_id" } else { "destination" };
            old.insert(text(line, name)?.to_owned(), (money(text(line, "amount")?, currency)?, line["mode"].as_str().unwrap_or("exact").to_owned()));
        }
        for line in after[key].as_array().into_iter().flatten() {
            let name = if key == "lines" { "category_id" } else { "destination" };
            new.insert(text(line, name)?.to_owned(), (money(text(line, "amount")?, currency)?, line["mode"].as_str().unwrap_or("exact").to_owned()));
        }
        let mut ids: Vec<String> = old.keys().chain(new.keys()).cloned().collect();
        ids.sort(); ids.dedup();
        ids.into_iter().filter_map(|id| {
            let (from, before_mode) = old.get(&id).cloned().unwrap_or((0,"exact".into()));
            let (to, after_mode) = new.get(&id).cloned().unwrap_or((0,"exact".into()));
            (from != to || key == "lines" && before_mode != after_mode).then_some((id, from, to, before_mode, after_mode))
        }).map(|(id, from, to, before_mode, after_mode)| {
            let delta = to.checked_sub(from).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
            Ok(json!({"id":id,"before":format_money(from,currency)?,"after":format_money(to,currency)?,"delta":format_money(delta,currency)?,"before_mode":before_mode,"after_mode":after_mode}))
        }).collect()
    };
    let category_changes = changes("lines")?;
    let people_changes = changes("people_limits")?;
    let unchanged_savings = before["savings_goal"].as_str().map(|value| money(value, currency)).transpose()?.unwrap_or(0)
        == after["savings_goal"].as_str().map(|value| money(value, currency)).transpose()?.unwrap_or(0);
    if category_changes.is_empty() && people_changes.is_empty()
        && before["name"] == after["name"] && before_summary["expected_income"] == after_summary["expected_income"]
        && unchanged_savings {
        return Err(ApiError::invalid("The proposed budget has no changes."));
    }
    let mut normalized = json!({});
    for field in fields {
        if let Some(value) = after.get(field) { normalized[field] = value.clone(); }
    }
    let preview_hash = auth::hash(&format!("{}:{}:{}", text(before, "id")?, before["revision"], normalized));
    let total_delta = after_total.checked_sub(before_total).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
    let preview = json!({"budget_id":before["id"],"base_revision":before["revision"],"currency":currency,"before_name":before["name"].as_str().unwrap_or(""),"after_name":after["name"].as_str().unwrap_or(""),"proposal":normalized,"preview_hash":preview_hash,"before":before_summary,"after":after_summary,"total_allowance_delta":format_money(total_delta,currency)?,"category_changes":category_changes,"people_changes":people_changes,"unfunded_warning":after_gap < 0 && after_gap < before_gap});
    Ok((after, preview))
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
    let mut pooled = Vec::new();
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
        if v["scope"] == "family" && c["visibility"] == "private" {
            return Err(ApiError::invalid("Family budgets require household categories."));
        }
        match line.get("mode").map(|value| value.as_str()).unwrap_or(Some("exact")) {
            Some("exact") => {},
            Some("pooled") => pooled.push(category.to_owned()),
            _ => return Err(ApiError::invalid("Budget line mode must be exact or pooled.")),
        }
        let limit = money(text(line, "amount")?, currency)?;
        if limit < 0 {
            return Err(ApiError::invalid("Budget limits cannot be negative."));
        }
        sum = add(sum, limit)?;
    }
    if !pooled.is_empty() {
        let parents = budget_category_parents(db, p).await?;
        for root in &pooled {
            if seen.iter().any(|category| category != root && category_within(category, root, &parents)) {
                return Err(ApiError::invalid("A pooled category cannot have a separate descendant limit."));
            }
        }
    }
    if let Some(limits) = v.get("people_limits") {
        let limits = limits.as_array().ok_or_else(|| ApiError::invalid("people_limits must be an array."))?;
        let mut destinations = std::collections::HashSet::new();
        let mut allocated = 0_i64;
        for line in limits {
            let destination = text(line, "destination")?;
            if !destinations.insert(destination) {
                return Err(ApiError::invalid("People allowances must have unique destinations."));
            }
            if v["scope"] == "personal" {
                if destination != p.user_id {
                    return Err(ApiError::invalid("Personal allowance must belong to the plan owner."));
                }
            } else if !["shared", "unassigned"].contains(&destination) {
                let known: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE household_id=? AND user_id=?")
                    .bind(&p.household_id).bind(destination).fetch_one(&mut *db).await?;
                if known == 0 {
                    return Err(ApiError::invalid("People allowance destination must be a household member."));
                }
            }
            let amount = money(text(line, "amount")?, currency)?;
            if amount < 0 {
                return Err(ApiError::invalid("People allowances cannot be negative."));
            }
            allocated = add(allocated, amount)?;
        }
        if !limits.is_empty() && allocated != sum {
            return Err(ApiError::invalid("People allowances must equal the total category limits."));
        }
    }
    for plan in storage::list(db, p, "budgets").await? {
        if plan["id"].as_str() != current
            && plan["state"] != "archived"
            && v["state"] != "archived"
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

async fn budget_category_parents(db: &mut SqliteConnection, p: &Principal) -> Result<HashMap<String, String>> {
    let categories = storage::list(db, p, "categories").await?;
    Ok(categories.into_iter().filter_map(|category| {
        Some((category["id"].as_str()?.to_owned(), category["parent_id"].as_str()?.to_owned()))
    }).collect())
}
async fn investment_category_ids(db: &mut SqliteConnection, p: &Principal) -> Result<HashSet<String>> {
    Ok(storage::list(db, p, "categories").await?.into_iter()
        .filter(|category| category["tracking_type"] == "investment")
        .filter_map(|category| category["id"].as_str().map(str::to_owned))
        .collect())
}

fn category_within(category: &str, root: &str, parents: &HashMap<String, String>) -> bool {
    let mut current = category;
    for _ in 0..=parents.len() {
        if current == root { return true; }
        match parents.get(current) { Some(parent) => current = parent, None => return false }
    }
    false
}

fn budget_line_for_category<'a>(category: &str, lines: &'a [Value], parents: &HashMap<String, String>) -> Option<&'a str> {
    if let Some(line) = lines.iter().find(|line| line["category_id"] == category) {
        return line["category_id"].as_str();
    }
    lines.iter().find(|line| line["mode"] == "pooled" && line["category_id"].as_str().is_some_and(|root| category_within(category, root, parents)))
        .and_then(|line| line["category_id"].as_str())
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
    let investment_categories = investment_category_ids(db, p).await?;
    for transaction in &mut values {
        if matches!(transaction["event_type"].as_str(), Some("expense" | "refund")) {
            if let Some(allocations) = transaction["allocations"].as_array_mut() {
                allocations.retain(|allocation| !allocation["category_id"].as_str().is_some_and(|id| investment_categories.contains(id)));
            }
        }
    }
    let ledger_revision: i64 =
        sqlx::query_scalar("SELECT coalesce(max(id),0) FROM audit_events WHERE household_id=?")
            .bind(&p.household_id)
            .fetch_one(db)
            .await?;
    let meta = json!({"from":from,"to":to,"scope":scope,"currency":currency,"timezone":household["timezone"],"filters":q,"policy_version":"2","ledger_revision":ledger_revision,"coverage":"unknown","complete":false,"visibility":"authorized_accounts_only"});
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
    let investment_categories = investment_category_ids(db, p).await?;
    let transactions = storage::transactions_in_period(db, p, from, to, false).await?;
    for transaction in transactions {
        if transaction["voided"] == true
            || transaction["currency"] != currency
            || transaction["event_type"] == "transfer"
        {
            continue;
        }
        let imported_payer = if transaction["paid_by_user_id"].is_null()
            && transaction["source_refs"].as_array().is_some_and(|v| !v.is_empty())
        {
            let account_id = text(&transaction["movements"][0], "account_id")?;
            Some(storage::raw(db, p, "accounts", account_id).await?["owner_id"].clone())
        } else { None };
        let attribution = if transaction["event_type"] == "income" {
            transaction["entered_by"].as_str()
        } else {
            transaction["paid_by_user_id"].as_str()
                .or_else(|| imported_payer.as_ref().and_then(Value::as_str))
                .or_else(|| transaction["entered_by"].as_str())
        };
        let Some(member) = members
            .iter_mut()
            .find(|m| attribution == Some(m.id.as_str()))
        else {
            continue;
        };
        for allocation in transaction["allocations"].as_array().into_iter().flatten() {
            // A member's personal allocations are visible only to that member.
            if allocation["scope"] != "family"
                && !(transaction["entered_by"] == p.user_id && allocation["scope"] == "personal")
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
                if allocation["category_id"].as_str().is_some_and(|id| investment_categories.contains(id)) {
                    member.invested = add(member.invested, signed)?;
                    continue;
                }
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
                let scoped_amount = if ["transfer", "investment", "investment_withdrawal"].contains(&v["event_type"].as_str().unwrap_or("")) {
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
                if scoped_amount != 0 || !matches!(v["event_type"].as_str(), Some("expense" | "refund")) {
                    let entry = groups.entry(text(v, "event_type")?.to_owned()).or_default();
                    entry.0 = add(entry.0, scoped_amount)?;
                    entry.1 += 1;
                }
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
async fn budget_commitments(db: &mut SqliteConnection, p: &Principal, budget: &Value) -> Result<Value> {
    let (from, to) = month_bounds(text(budget, "month")?)?;
    let currency = text(budget, "currency")?;
    let scope = text(budget, "scope")?;
    let mut rows = Vec::new();
    let mut total = 0_i64;
    for item in storage::list(db, p, "planned_items").await? {
        if item["deleted"] == true || item["budget_commitment"] != true
            || item["currency"] != currency
            || item["due_date"].as_str().is_none_or(|date| date < from.as_str() || date >= to.as_str())
            || (item["visibility"] == "shared") != (scope == "family") {
            continue;
        }
        let amount = money(text(&item, "amount")?, currency)?;
        let match_id: Option<String> = sqlx::query_scalar("SELECT transaction_id FROM planned_item_matches WHERE household_id=? AND planned_item_id=?")
            .bind(&p.household_id).bind(text(&item, "id")?).fetch_optional(&mut *db).await?;
        let mut committed = if item["status"] == "planned" { amount } else { 0 };
        let mut state = item["status"].as_str().unwrap_or("planned").to_owned();
        if item["status"] == "done" {
            if let Some(transaction_id) = match_id {
                match storage::raw(db, p, "transactions", &transaction_id).await {
                    Ok(transaction) => {
                        let visible = storage::visible(db, p, "transactions", &transaction).await?;
                        let same_month = transaction["effective_date"].as_str().is_some_and(|date| date >= from.as_str() && date < to.as_str());
                        let same_scope = transaction["allocations"].as_array().is_some_and(|lines| lines.iter().any(|line| line["scope"] == scope));
                        let same_account = item["account_id"].as_str().is_none_or(|account_id| transaction["movements"].as_array().is_some_and(|movements| movements.iter().any(|movement| movement["account_id"] == account_id)));
                        let same_owner = scope != "personal" || transaction["entered_by"] == item["owner_id"];
                        if !visible || transaction["voided"] == true || transaction["event_type"] != "expense" || transaction["currency"] != currency || !same_month || !same_scope {
                            committed = amount;
                            state = "needs_review".into();
                        } else if money(text(&transaction, "amount")?, currency)? != amount || !same_account || !same_owner || transaction["allocations"].as_array().is_none_or(|lines| lines.iter().any(|line| line["category_id"] != item["category_id"] || line["scope"] != scope)) {
                            committed = amount;
                            state = "needs_review".into();
                        } else {
                            state = "posted".into();
                        }
                    }
                    Err(error) if error.status == StatusCode::NOT_FOUND => {
                        committed = amount;
                        state = "needs_review".into();
                    }
                    Err(error) => return Err(error),
                }
            } else {
                committed = amount;
                state = "needs_review".into();
            }
        }
        total = add(total, committed)?;
        let destination = if scope == "personal" { item["owner_id"].clone() } else { item.get("budget_destination").cloned().unwrap_or(json!("unassigned")) };
        rows.push(json!({"id":item["id"],"title":item["title"],"due_date":item["due_date"],"category_id":item["category_id"],"destination":destination,"amount":item["amount"],"committed":format_money(committed,currency)?,"state":state}));
    }
    rows.sort_by(|a,b| a["due_date"].as_str().cmp(&b["due_date"].as_str()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str())));
    Ok(json!({"data":rows,"total_committed":format_money(total,currency)?,"meta":{"plan_revision":budget["revision"],"visibility":"authorized_accounts_only"}}))
}

fn budget_destination(transaction: &Value, allocation: &Value, p: &Principal) -> String {
    if allocation["scope"] == "personal" {
        transaction["entered_by"].as_str().unwrap_or(&p.user_id).to_owned()
    } else {
        allocation["budget_destination"].as_str().unwrap_or("unassigned").to_owned()
    }
}

async fn budget_drilldown_line_filter(db: &mut SqliteConnection, p: &Principal, budget: &Value, q: &Query) -> Result<Option<HashSet<String>>> {
    let Some(root) = q.get("line_category_id") else { return Ok(None); };
    if q.contains_key("category_id") {
        return Err(ApiError::invalid("Choose either category_id or line_category_id."));
    }
    let line = budget["lines"].as_array().into_iter().flatten()
        .find(|line| line["category_id"] == *root)
        .ok_or_else(|| ApiError::invalid("line_category_id must be a budget line."))?;
    if line["mode"] != "pooled" { return Ok(Some(HashSet::from([root.clone()]))); }
    let parents = budget_category_parents(db, p).await?;
    let mut categories = HashSet::from([root.clone()]);
    for category in parents.keys() {
        if budget_line_for_category(category, budget["lines"].as_array().unwrap(), &parents) == Some(root.as_str()) {
            categories.insert(category.clone());
        }
    }
    Ok(Some(categories))
}

fn budget_drilldown_category_matches(category: Option<&str>, filter: &Option<HashSet<String>>) -> bool {
    match filter {
        None => true,
        Some(categories) => category.is_some_and(|category| categories.contains(category)),
    }
}

async fn budget_allocations(db: &mut SqliteConnection, p: &Principal, id: &str, q: &Query) -> Result<Reply> {
    allowed_query(q, &["category_id", "line_category_id", "destination", "cursor", "limit"])?;
    let budget = storage::get(db, p, "budgets", id).await?;
    let line_filter = budget_drilldown_line_filter(db, p, &budget, q).await?;
    let (from, to) = month_bounds(text(&budget, "month")?)?;
    let mut report_query = Query::from([
        ("from".into(), from), ("to".into(), to),
        ("scope".into(), text(&budget, "scope")?.into()),
        ("currency".into(), text(&budget, "currency")?.into()),
    ]);
    if let Some(category_id) = q.get("category_id").filter(|value| value.as_str() != "uncategorized") { report_query.insert("category_id".into(), category_id.clone()); }
    let (values, currency, mut meta) = report_inputs(db, p, &report_query, false).await?;
    let mut rows = Vec::new();
    for transaction in values {
        let sign = match transaction["event_type"].as_str() {
            Some("expense") => 1_i64,
            Some("refund") => -1_i64,
            _ => continue,
        };
        let transaction_id = text(&transaction, "id")?;
        for (index, allocation) in transaction["allocations"].as_array().into_iter().flatten().enumerate() {
            if q.get("category_id").is_some_and(|filter| filter == "uncategorized" && !allocation["category_id"].is_null()) { continue; }
            if !budget_drilldown_category_matches(allocation["category_id"].as_str(), &line_filter) { continue; }
            let destination = budget_destination(&transaction, allocation, p);
            if q.get("destination").is_some_and(|filter| filter != &destination) { continue; }
            let value = money(text(allocation, "amount")?, &currency)?.checked_mul(sign)
                .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
            rows.push(json!({"id":format!("{transaction_id}:{index}"),"transaction_id":transaction_id,"effective_date":transaction["effective_date"],"description":transaction["description"],"event_type":transaction["event_type"],"category_id":allocation["category_id"],"destination":destination,"amount":format_money(value,&currency)?,"currency":currency,"paid_by_user_id":transaction["paid_by_user_id"],"entered_by":transaction["entered_by"]}));
        }
    }
    rows.sort_by(|a,b| b["effective_date"].as_str().cmp(&a["effective_date"].as_str()).then_with(|| b["id"].as_str().cmp(&a["id"].as_str())));
    let mut result = paginate(rows, q)?;
    meta["plan_revision"] = budget["revision"].clone();
    result["meta"] = meta;
    ok(result)
}

async fn budget_matrix(db: &mut SqliteConnection, p: &Principal, id: &str, q: &Query) -> Result<Reply> {
    allowed_query(q, &["category_id", "line_category_id", "destination"])?;
    let budget = storage::get(db, p, "budgets", id).await?;
    let line_filter = budget_drilldown_line_filter(db, p, &budget, q).await?;
    let (from, to) = month_bounds(text(&budget, "month")?)?;
    let mut report_query = Query::from([
        ("from".into(), from), ("to".into(), to),
        ("scope".into(), text(&budget, "scope")?.into()),
        ("currency".into(), text(&budget, "currency")?.into()),
    ]);
    if let Some(category_id) = q.get("category_id").filter(|value| value.as_str() != "uncategorized") { report_query.insert("category_id".into(), category_id.clone()); }
    let (values, currency, mut meta) = report_inputs(db, p, &report_query, false).await?;
    let mut cells: std::collections::BTreeMap<(Option<String>, String), i64> = std::collections::BTreeMap::new();
    for transaction in values {
        let sign = match transaction["event_type"].as_str() {
            Some("expense") => 1_i64,
            Some("refund") => -1_i64,
            _ => continue,
        };
        for allocation in transaction["allocations"].as_array().into_iter().flatten() {
            let category_id = allocation["category_id"].as_str().map(str::to_owned);
            if q.get("category_id").is_some_and(|filter| filter == "uncategorized" && category_id.is_some()) { continue; }
            if !budget_drilldown_category_matches(category_id.as_deref(), &line_filter) { continue; }
            let destination = budget_destination(&transaction, allocation, p);
            if q.get("destination").is_some_and(|filter| filter != &destination) { continue; }
            let value = money(text(allocation, "amount")?, &currency)?.checked_mul(sign)
                .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
            let cell = cells.entry((category_id, destination)).or_insert(0);
            *cell = add(*cell, value)?;
        }
    }
    let mut total = 0_i64;
    let mut rows = Vec::new();
    for ((category_id, destination), spent) in cells {
        total = add(total, spent)?;
        rows.push(json!({"category_id":category_id,"destination":destination,"spent":format_money(spent,&currency)?}));
    }
    meta["plan_revision"] = budget["revision"].clone();
    meta["filters"] = json!({"category_id":q.get("category_id"),"line_category_id":q.get("line_category_id"),"destination":q.get("destination")});
    ok(json!({"data":rows,"total_spent":format_money(total,&currency)?,"meta":meta}))
}

async fn budget_forecast_view(db: &mut SqliteConnection, p: &Principal, id: &str, q: &Query) -> Result<Reply> {
    allowed_query(q, &[])?;
    let budget = storage::get(db, p, "budgets", id).await?;
    let (from, to) = month_bounds(text(&budget, "month")?)?;
    let household = auth::me(db, p).await?["household"].clone();
    let timezone = text(&household, "timezone")?.parse::<chrono_tz::Tz>()
        .map_err(|_| ApiError::invalid("Invalid household timezone."))?;
    let today = Utc::now().with_timezone(&timezone).date_naive();
    let phase = budget_forecast::phase(domain::date(&from)?, domain::date(&to)?, today);
    let query = Query::from([
        ("from".into(), from.clone()), ("to".into(), to.clone()),
        ("scope".into(), text(&budget, "scope")?.into()),
        ("currency".into(), text(&budget, "currency")?.into()),
    ]);
    let (values, currency, meta) = report_inputs(db, p, &query, false).await?;
    let commitments = budget_commitments(db, p, &budget).await?;
    let valid_posted: HashSet<String> = commitments["data"].as_array().into_iter().flatten()
        .filter(|item| item["state"] == "posted")
        .filter_map(|item| item["id"].as_str().map(str::to_owned)).collect();
    let linked_rows = sqlx::query("SELECT planned_item_id, transaction_id FROM planned_item_matches WHERE household_id=?")
        .bind(&p.household_id).fetch_all(&mut *db).await?;
    let all_linked_transactions: HashSet<String> = linked_rows.iter()
        .map(|row| row.get::<String, _>("transaction_id")).collect();
    let scheduled_transactions: HashSet<String> = linked_rows.iter()
        .filter(|row| valid_posted.contains(&row.get::<String, _>("planned_item_id")))
        .map(|row| row.get::<String, _>("transaction_id")).collect();
    let allowance = budget["lines"].as_array().into_iter().flatten().try_fold(0_i64, |sum, line| {
        add(sum, money(text(line, "amount")?, &currency)?)
    })?;
    let mut spent = 0_i64;
    let mut variable_spent = 0_i64;
    let mut future_dated_recorded = false;
    let today_string = today.to_string();
    for transaction in &values {
        let sign = match transaction["event_type"].as_str() {
            Some("expense") => 1_i64,
            Some("refund") => -1_i64,
            _ => continue,
        };
        let date = text(transaction, "effective_date")?;
        let elapsed_variable = date <= today_string.as_str()
            && !scheduled_transactions.contains(text(transaction, "id")?);
        if date > today_string.as_str() { future_dated_recorded = true; }
        for allocation in transaction["allocations"].as_array().into_iter().flatten() {
            let value = money(text(allocation, "amount")?, &currency)?
                .checked_mul(sign).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
            spent = add(spent, value)?;
            if elapsed_variable { variable_spent = add(variable_spent, value)?; }
        }
    }
    let committed = money(text(&commitments, "total_committed")?, &currency)?;
    let needs_review = commitments["data"].as_array().into_iter().flatten().any(|item| item["state"] == "needs_review");
    let possible_unmatched_payment = commitments["data"].as_array().into_iter().flatten()
        .filter(|item| item["state"] == "planned")
        .any(|item| values.iter().any(|transaction| {
            transaction["event_type"] == "expense"
                && money(transaction["amount"].as_str().unwrap_or(""), &currency).ok()
                    == money(item["amount"].as_str().unwrap_or(""), &currency).ok()
                && transaction["allocations"].as_array().is_some_and(|lines| !lines.is_empty() && lines.iter().all(|line| line["category_id"] == item["category_id"] && line["scope"] == budget["scope"]))
                && transaction["id"].as_str().is_some_and(|id| !all_linked_transactions.contains(id))
        }));
    let mut flags = vec!["coverage_unknown"];
    if needs_review { flags.push("commitment_needs_review"); }
    if possible_unmatched_payment { flags.push("possible_unmatched_payment"); }
    if future_dated_recorded { flags.push("future_dated_recorded_expense"); }
    if variable_spent < 0 { flags.push("negative_variable_spending_rate_floor"); }
    let (status, reason, elapsed, remaining, total, estimate) = match phase {
        PeriodPhase::Future => ("unavailable", "This budget month has not started.", 0, 0, 0, None),
        PeriodPhase::Past => ("unavailable", "This budget month has ended; use recorded results.", 0, 0, 0, None),
        PeriodPhase::Current { elapsed_days, remaining_days, total_days } if elapsed_days < 8 =>
            ("unavailable", "Fewer than eight days have elapsed and complete comparable history is not established.", elapsed_days, remaining_days, total_days, None),
        PeriodPhase::Current { elapsed_days, remaining_days, total_days } =>
            ("limited_history", "Projected from this month's elapsed variable spending; historical coverage is unconfirmed.", elapsed_days, remaining_days, total_days,
                budget_forecast::remaining_from_current_rate(variable_spent, elapsed_days, remaining_days)),
    };
    let estimate = estimate.map(|value| format_money(value, &currency)).transpose()?;
    let forecast_spending = estimate.as_ref().map(|value| {
        add(add(spent, committed)?, money(value, &currency)?)
    }).transpose()?;
    let headroom = forecast_spending.map(|value| allowance.checked_sub(value)
        .ok_or_else(|| ApiError::invalid("Money total is out of range."))).transpose()?;
    ok(json!({
        "status":status,"reason":reason,"as_of":today.to_string(),"month":budget["month"],
        "currency":currency,"effective_allowance":format_money(allowance,&currency)?,
        "spent":format_money(spent,&currency)?,"unmatched_commitments":format_money(committed,&currency)?,
        "elapsed_variable_spending":format_money(variable_spent,&currency)?,
        "elapsed_days":elapsed,"remaining_days":remaining,"total_days":total,
        "remaining_variable_estimate":estimate,"forecast_spending":forecast_spending.map(|value| format_money(value,&currency)).transpose()?,
        "forecast_headroom":headroom.map(|value| format_money(value,&currency)).transpose()?,
        "formula_version":"current_rate_v1","quality_flags":flags,
        "meta":{"plan_revision":budget["revision"],"ledger_revision":meta["ledger_revision"],"visibility":meta["visibility"],"coverage":meta["coverage"]}
    }))
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
    let commitments = budget_commitments(db, p, &budget).await?;
    let mut commitments_by_category: HashMap<String, i64> = HashMap::new();
    let mut total_committed = 0_i64;
    for item in commitments["data"].as_array().into_iter().flatten() {
        if item["due_date"].as_str().is_none_or(|date| date < from.as_str() || date >= to.as_str()) { continue; }
        let key = item["category_id"].as_str().unwrap_or("uncategorized").to_owned();
        let value = money(text(item, "committed")?, &currency)?;
        total_committed = add(total_committed, value)?;
        let previous = *commitments_by_category.get(&key).unwrap_or(&0);
        commitments_by_category.insert(key, add(previous, value)?);
    }
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
    let budget_lines = budget["lines"].as_array().unwrap();
    let parents = budget_category_parents(db, p).await?;
    let mut line_actuals: HashMap<String, i64> = HashMap::new();
    let mut line_commitments: HashMap<String, i64> = HashMap::new();
    let mut unbudgeted_actuals: HashMap<String, i64> = HashMap::new();
    let mut unbudgeted_commitments: HashMap<String, i64> = HashMap::new();
    for (category, value) in actuals {
        let target = match budget_line_for_category(&category, budget_lines, &parents) {
            Some(line) => line_actuals.entry(line.to_owned()).or_insert(0),
            None => unbudgeted_actuals.entry(category).or_insert(0),
        };
        *target = add(*target, value)?;
    }
    for (category, value) in commitments_by_category {
        let target = match budget_line_for_category(&category, budget_lines, &parents) {
            Some(line) => line_commitments.entry(line.to_owned()).or_insert(0),
            None => unbudgeted_commitments.entry(category).or_insert(0),
        };
        *target = add(*target, value)?;
    }
    let mut lines = vec![];
    let mut planned_total = 0_i64;
    let mut spent_in_lines = 0_i64;
    for line in budget_lines {
        let category = text(line, "category_id")?;
        let planned = money(text(line, "amount")?, &currency)?;
        let actual = line_actuals.remove(category).unwrap_or(0);
        let committed = line_commitments.remove(category).unwrap_or(0);
        planned_total = add(planned_total, planned)?;
        spent_in_lines = add(spent_in_lines, actual)?;
        let remaining = planned
            .checked_sub(actual)
            .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        let available = remaining.checked_sub(committed).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
        let pooled = line["mode"] == "pooled";
        lines.push(json!({"category_id":category,"mode":if pooled {"pooled"} else {"exact"},"planned":format_money(planned,&currency)?,"actual":format_money(actual,&currency)?,"committed":format_money(committed,&currency)?,"remaining":format_money(remaining,&currency)?,"available_after_commitments":format_money(available,&currency)?,"utilization":if planned==0{None}else{Some(actual as f64/planned as f64)},"coverage":"unknown","transactions_url":if pooled {format!("/api/v1/budgets/{id}/allocations?line_category_id={category}")} else {format!("/api/v1/budgets/{id}/allocations?category_id={category}")}}));
    }
    let unbudgeted = unbudgeted_actuals.values().try_fold(0, |a, b| add(a, *b))?;
    let unbudgeted_committed = unbudgeted_commitments.values().try_fold(0, |a, b| add(a, *b))?;
    let total_spent = add(spent_in_lines, unbudgeted)?;
    let available = planned_total.checked_sub(total_spent).and_then(|value| value.checked_sub(total_committed)).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
    let mut unbudgeted_lines = vec![];
    for (category_id, amount) in unbudgeted_actuals {
        unbudgeted_lines
            .push(json!({"category_id":category_id,"actual":format_money(amount,&currency)?}));
    }
    unbudgeted_lines.sort_by(|a, b| a["category_id"].as_str().cmp(&b["category_id"].as_str()));
    meta["plan_revision"] = budget["revision"].clone();
    meta["full_plan_period"] = json!(from == &start && to == &end);
    ok(
        json!({"data":lines,"unbudgeted":format_money(unbudgeted,&currency)?,"unbudgeted_committed":format_money(unbudgeted_committed,&currency)?,"unbudgeted_lines":unbudgeted_lines,"total_committed":format_money(total_committed,&currency)?,"available_after_commitments":format_money(available,&currency)?,"meta":meta}),
    )
}

async fn budget_people(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    q: &Query,
) -> Result<Reply> {
    allowed_query(q, &[])?;
    let budget = storage::get(db, p, "budgets", id).await?;
    let (from, to) = month_bounds(text(&budget, "month")?)?;
    let query = Query::from([
        ("from".into(), from),
        ("to".into(), to),
        ("scope".into(), text(&budget, "scope")?.into()),
        ("currency".into(), text(&budget, "currency")?.into()),
    ]);
    let (values, currency, mut meta) = report_inputs(db, p, &query, false).await?;
    let commitments = budget_commitments(db, p, &budget).await?;
    let mut commitments_by_destination: HashMap<String, i64> = HashMap::new();
    for item in commitments["data"].as_array().into_iter().flatten() {
        let destination = text(item, "destination")?;
        let value = money(text(item, "committed")?, &currency)?;
        let previous = *commitments_by_destination.get(destination).unwrap_or(&0);
        commitments_by_destination.insert(destination.to_owned(), add(previous, value)?);
    }
    let personal_allowance = if budget["scope"] == "personal" {
        Some(budget["lines"].as_array().into_iter().flatten().try_fold(0_i64, |sum, line| {
            add(sum, money(text(line, "amount")?, &currency)?)
        })?)
    } else {
        None
    };
    let mut allowances: HashMap<String, i64> = HashMap::new();
    for line in budget["people_limits"].as_array().into_iter().flatten() {
        allowances.insert(text(line, "destination")?.to_owned(), money(text(line, "amount")?, &currency)?);
    }
    let mut usage: HashMap<String, i64> = HashMap::new();
    for transaction in &values {
        let sign = match transaction["event_type"].as_str() {
            Some("expense") => 1,
            Some("refund") => -1,
            _ => continue,
        };
        for allocation in transaction["allocations"].as_array().into_iter().flatten() {
            let destination = budget_destination(transaction, allocation, p);
            let amount = money(text(allocation, "amount")?, &currency)?;
            let signed = amount.checked_mul(sign).ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
            let previous = *usage.get(&destination).unwrap_or(&0);
            usage.insert(destination, add(previous, signed)?);
        }
    }
    let mut rows = Vec::new();
    let members = sqlx::query("SELECT u.id,u.name,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? ORDER BY u.name,u.id")
        .bind(&p.household_id).fetch_all(&mut *db).await?;
    for member in members {
        let user_id: String = member.get(0);
        let amount = usage.remove(&user_id).unwrap_or(0);
        let committed = commitments_by_destination.remove(&user_id).unwrap_or(0);
        if amount != 0 || committed != 0 || user_id == p.user_id || allowances.contains_key(&user_id) {
            let allowance = allowances.remove(&user_id).or(if user_id == p.user_id { personal_allowance } else { None });
            let remaining = allowance.map(|limit| limit.checked_sub(amount).ok_or_else(|| ApiError::invalid("Money total is out of range."))).transpose()?;
            let available = remaining.map(|value| value.checked_sub(committed).ok_or_else(|| ApiError::invalid("Money total is out of range."))).transpose()?;
            rows.push(json!({"destination":user_id,"name":member.get::<String,_>(1),"active":member.get::<i64,_>(2) != 0,"spent":format_money(amount,&currency)?,"committed":format_money(committed,&currency)?,"allowance":allowance.map(|value| format_money(value,&currency)).transpose()?,"remaining":remaining.map(|value| format_money(value,&currency)).transpose()?,"available_after_commitments":available.map(|value| format_money(value,&currency)).transpose()?}));
        }
    }
    for (destination, name) in [("shared", "Shared household pool"), ("unassigned", "Unassigned")] {
        let amount = usage.remove(destination).unwrap_or(0);
        let committed = commitments_by_destination.remove(destination).unwrap_or(0);
        let allowance = allowances.remove(destination);
        if amount != 0 || committed != 0 || allowance.is_some() || (destination == "unassigned" && budget["scope"] == "family") {
            let remaining = allowance.map(|limit| limit.checked_sub(amount).ok_or_else(|| ApiError::invalid("Money total is out of range."))).transpose()?;
            let available = remaining.map(|value| value.checked_sub(committed).ok_or_else(|| ApiError::invalid("Money total is out of range."))).transpose()?;
            rows.push(json!({"destination":destination,"name":name,"spent":format_money(amount,&currency)?,"committed":format_money(committed,&currency)?,"allowance":allowance.map(|value| format_money(value,&currency)).transpose()?,"remaining":remaining.map(|value| format_money(value,&currency)).transpose()?,"available_after_commitments":available.map(|value| format_money(value,&currency)).transpose()?}));
        }
    }
    if !usage.is_empty() || !allowances.is_empty() || !commitments_by_destination.is_empty() {
        return Err(ApiError::invalid("Stored budget attribution refers to an unknown member."));
    }
    let total = rows.iter().try_fold(0_i64, |sum, row| {
        add(sum, money(text(row, "spent")?, &currency)?)
    })?;
    let total_committed = rows.iter().try_fold(0_i64, |sum, row| {
        add(sum, money(text(row, "committed")?, &currency)?)
    })?;
    meta["plan_revision"] = budget["revision"].clone();
    meta["visibility"] = json!("authorized_accounts_only");
    ok(json!({"data":rows,"total_spent":format_money(total,&currency)?,"total_committed":format_money(total_committed,&currency)?,"meta":meta}))
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
