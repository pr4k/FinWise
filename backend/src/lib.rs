pub mod api;
pub mod auth;
pub mod balances;
pub mod domain;
pub mod error;
pub mod recovery;
pub mod recurring;
pub mod reset;
pub mod storage;

use axum::{Router, routing::any};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{path::Path, str::FromStr, time::Duration};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub secure_cookies: bool,
}

pub async fn connect(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));
    // One writer serializes revision/idempotency decisions, including in-memory tests.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    imports::recover(&pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.message))?;
    Ok(pool)
}

pub fn router(state: AppState, web: &Path) -> Router {
    Router::new()
        .route("/api", any(api::dispatch))
        .route("/api/", any(api::dispatch))
        .route("/api/{*path}", any(api::dispatch))
        .route(
            "/api/v1/source-files/{file_id}/download",
            axum::routing::get(imports::download_handler),
        )
        .route(
            "/api/v1/jobs/{job_id}/events",
            axum::routing::get(imports::events_handler),
        )
        .route("/health/live", any(api::dispatch))
        .route("/health/ready", any(api::dispatch))
        .fallback_service(
            ServeDir::new(web).not_found_service(ServeFile::new(web.join("index.html"))),
        )
        .with_state(state)
}
pub mod import_parse;
pub mod imports;

pub mod planning;
pub mod reconciliation;
