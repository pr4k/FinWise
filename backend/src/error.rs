use axum::http::StatusCode;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub revision: Option<i64>,
}
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            revision: None,
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "validation_error", message)
    }
    pub fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "Resource not found.")
    }
    pub fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Action is not permitted.",
        )
    }
    pub fn unauthenticated() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Sign in to continue.",
        )
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }
    pub fn revision(current: i64) -> Self {
        Self {
            revision: Some(current),
            ..Self::new(
                StatusCode::CONFLICT,
                "revision_conflict",
                "Resource changed; reload before retrying.",
            )
        }
    }
    pub fn body(&self, request_id: &str) -> Value {
        let mut error = json!({"code":self.code,"message":self.message,"fields":[]});
        if let Some(r) = self.revision {
            error["current_revision"] = json!(r);
        }
        json!({"error":error,"request_id":request_id})
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Database operation failed.",
        )
    }
}
