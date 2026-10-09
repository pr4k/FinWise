use crate::{auth, storage};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{str::FromStr, time::Duration};

pub async fn connect_existing(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
}

/// Console-only recovery for an administrator with direct database access.
pub async fn reset_password(
    pool: &SqlitePool,
    email: &str,
    password: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    auth::password_valid(password).map_err(|error| std::io::Error::other(error.message))?;
    let email = email.trim().to_lowercase();
    let mut tx = pool.begin().await?;
    let account = sqlx::query("SELECT u.id,m.household_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? AND m.active=1 ORDER BY m.rowid DESC LIMIT 1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(account) = account else {
        return Ok(false);
    };
    let user_id: String = account.get(0);
    let household_id: String = account.get(1);
    let encoded = auth::password_hash(password.to_owned())
        .await
        .map_err(|error| std::io::Error::other(error.message))?;
    sqlx::query("UPDATE users SET password_hash=? WHERE id=?")
        .bind(encoded)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM login_attempts WHERE identity=?")
        .bind(auth::hash(&email))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO audit_events(household_id,actor_id,resource_id,action,created_at) VALUES(?,?,?,'password_reset_console',?)")
        .bind(&household_id)
        .bind(&user_id)
        .bind(&user_id)
        .bind(storage::now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn reset_replaces_password_and_revokes_sessions() {
        let pool = crate::connect("sqlite::memory:").await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let mut principal = auth::bootstrap(
            &mut tx,
            &json!({"owner":{"name":"Owner","email":"owner@example.test","password":"original-password-123"},"household":{"name":"Home","base_currency":"INR","timezone":"Asia/Kolkata"}}),
        )
        .await
        .unwrap();
        auth::start_session(&mut tx, &mut principal, &axum::http::HeaderMap::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        auth::throttle(&mut pool.acquire().await.unwrap(), "owner@example.test")
            .await
            .unwrap();

        assert!(
            reset_password(&pool, " OWNER@EXAMPLE.TEST ", "replacement-password-123")
                .await
                .unwrap()
        );
        let stored: String = sqlx::query_scalar("SELECT password_hash FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!auth::verify("original-password-123".into(), stored.clone()).await);
        assert!(auth::verify("replacement-password-123".into(), stored).await);
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM login_attempts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((sessions, attempts), (0, 0));
    }
}
