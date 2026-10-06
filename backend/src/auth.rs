use crate::{
    domain::{exponent, text},
    error::{ApiError, Result},
    storage::{audit, id},
};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::http::HeaderMap;
use chrono::Utc;
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: String,
    pub household_id: String,
    pub member_id: String,
    pub role: String,
    pub csrf: String,
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|c| c.trim().strip_prefix("finwise_session="))
}
pub async fn principal(db: &mut SqliteConnection, headers: &HeaderMap) -> Result<Principal> {
    let token = cookie_token(headers).ok_or_else(ApiError::unauthenticated)?;
    let row=sqlx::query("SELECT s.user_id,s.household_id,s.csrf,m.id,m.role FROM sessions s JOIN memberships m ON m.user_id=s.user_id AND m.household_id=s.household_id WHERE s.token_hash=? AND s.expires_at>? AND m.active=1")
        .bind(hash(token)).bind(Utc::now().timestamp()).fetch_optional(db).await?.ok_or_else(ApiError::unauthenticated)?;
    Ok(Principal {
        user_id: row.get(0),
        household_id: row.get(1),
        csrf: row.get(2),
        member_id: row.get(3),
        role: row.get(4),
    })
}
pub fn csrf(p: &Principal, headers: &HeaderMap) -> Result<()> {
    if headers.get("x-csrf-token").and_then(|v| v.to_str().ok()) != Some(p.csrf.as_str()) {
        return Err(ApiError::forbidden());
    }
    Ok(())
}
pub fn admin(p: &Principal) -> Result<()> {
    if p.role == "owner" || p.role == "admin" {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}
pub fn password_valid(value: &str) -> Result<()> {
    if !(12..=1024).contains(&value.len()) {
        return Err(ApiError::invalid("Password must contain 12–1024 bytes."));
    }
    Ok(())
}
pub async fn password_hash(value: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(value.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| ApiError::invalid("Password operation failed."))?
    .map_err(|_| ApiError::invalid("Password operation failed."))
}
pub async fn verify(value: String, encoded: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&encoded).is_ok_and(|h| {
            Argon2::default()
                .verify_password(value.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false)
}
pub async fn me(db: &mut SqliteConnection, p: &Principal) -> Result<Value> {
    let user = sqlx::query("SELECT name,email FROM users WHERE id=?")
        .bind(&p.user_id)
        .fetch_one(&mut *db)
        .await?;
    let household: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
        .bind(&p.household_id)
        .fetch_one(&mut *db)
        .await?;
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM memberships WHERE id=?")
        .bind(&p.member_id)
        .fetch_one(db)
        .await?;
    Ok(
        json!({"user":{"id":p.user_id,"name":user.get::<&str,_>(0),"email":user.get::<&str,_>(1)},"household":serde_json::from_str::<Value>(&household).unwrap_or(Value::Null),"membership":{"id":p.member_id,"role":p.role,"revision":revision},"capabilities":{"ledger":true,"imports":true,"reconciliation":true,"ai":false,"backups":false}}),
    )
}
pub async fn start_session(
    db: &mut SqliteConnection,
    p: &mut Principal,
    headers: &HeaderMap,
) -> Result<String> {
    if let Some(old) = cookie_token(headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(hash(old))
            .execute(&mut *db)
            .await?;
    }
    let session = token();
    p.csrf = token();
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,household_id,csrf,expires_at) VALUES(?,?,?,?,?)",
    )
    .bind(hash(&session))
    .bind(&p.user_id)
    .bind(&p.household_id)
    .bind(&p.csrf)
    .bind(Utc::now().timestamp() + 86400 * 7)
    .execute(db)
    .await?;
    Ok(session)
}
pub async fn throttle(db: &mut SqliteConnection, identity: &str) -> Result<()> {
    let key = hash(identity);
    let now = Utc::now().timestamp();
    sqlx::query("INSERT INTO login_attempts(identity,attempts,window_start) VALUES(?,1,?) ON CONFLICT(identity) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END")
        .bind(&key).bind(now).bind(now-900).bind(now-900).execute(&mut *db).await?;
    let count: i64 = sqlx::query_scalar("SELECT attempts FROM login_attempts WHERE identity=?")
        .bind(key)
        .fetch_one(db)
        .await?;
    if count > 10 {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many authentication attempts. Try again later.",
        ));
    }
    Ok(())
}
pub async fn bootstrap(db: &mut SqliteConnection, body: &Value) -> Result<Principal> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM households")
        .fetch_one(&mut *db)
        .await?;
    if count > 0 {
        return Err(ApiError::conflict("Bootstrap is already complete."));
    }
    let owner = &body["owner"];
    let household = &body["household"];
    let email = text(owner, "email")?.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Err(ApiError::invalid("Invalid email."));
    }
    let name = text(owner, "name")?;
    let password = text(owner, "password")?;
    password_valid(password)?;
    text(household, "name")?;
    exponent(text(household, "base_currency")?)?;
    text(household, "timezone")?
        .parse::<chrono_tz::Tz>()
        .map_err(|_| ApiError::invalid("Invalid IANA timezone."))?;
    let p = Principal {
        user_id: id(),
        household_id: id(),
        member_id: id(),
        role: "owner".into(),
        csrf: String::new(),
    };
    let document = json!({"id":p.household_id,"name":household["name"],"timezone":household["timezone"],"base_currency":household["base_currency"],"locale":"en-IN","revision":1});
    let encoded = password_hash(password.into()).await?;
    sqlx::query("INSERT INTO households(id,document) VALUES(?,?)")
        .bind(&p.household_id)
        .bind(document.to_string())
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)")
        .bind(&p.user_id)
        .bind(email)
        .bind(name)
        .bind(encoded)
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO memberships(id,household_id,user_id,role) VALUES(?,?,?,'owner')")
        .bind(&p.member_id)
        .bind(&p.household_id)
        .bind(&p.user_id)
        .execute(&mut *db)
        .await?;
    audit(db, &p, &p.household_id, "bootstrap", None, Some(&document)).await?;
    Ok(p)
}
pub async fn login(db: &mut SqliteConnection, body: &Value) -> Result<Principal> {
    let email = text(body, "email")?.trim().to_lowercase();
    let password = text(body, "password")?;
    if password.len() > 1024 {
        return Err(ApiError::unauthenticated());
    }
    let row=sqlx::query("SELECT u.id,u.password_hash,m.household_id,m.id,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? AND m.active=1 ORDER BY m.rowid DESC LIMIT 1")
        .bind(email).fetch_optional(&mut *db).await?;
    let Some(row) = row else {
        // Spend the same password work for unknown identities.
        let _ = password_hash(password.into()).await?;
        return Err(ApiError::unauthenticated());
    };
    if !verify(password.into(), row.get(1)).await {
        return Err(ApiError::unauthenticated());
    }
    Ok(Principal {
        user_id: row.get(0),
        household_id: row.get(2),
        member_id: row.get(3),
        role: row.get(4),
        csrf: String::new(),
    })
}
