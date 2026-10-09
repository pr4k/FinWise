use crate::{
    AppState,
    auth::{self, Principal},
    domain::{self, text},
    error::{ApiError, Result},
    import_parse::{self, ParsedFile, ParsedRow},
    storage,
};
use axum::{
    Json,
    body::Body,
    extract::{FromRequest, Multipart, Request},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};

pub type Reply = (StatusCode, Value);
const DEFAULT_FILE_LIMIT: usize = 8 * 1024 * 1024;
const MAX_BATCH_FILES: usize = 4;
fn fail(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code, message)
}
fn file_limit() -> usize {
    std::env::var("FINWISE_UPLOAD_FILE_MAX_BYTES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_FILE_LIMIT)
        .clamp(1024, 32 * 1024 * 1024)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn collection(data: Vec<Value>, next: Option<String>) -> Value {
    json!({"data":data,"page":if let Some(next)=next {json!({"next_cursor":next})}else{json!({})},"meta":{}})
}
fn bound(q: &HashMap<String, String>) -> Result<usize> {
    let limit = q
        .get("limit")
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| ApiError::invalid("Invalid limit."))?
        .unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(ApiError::invalid("limit must be 1–200."));
    }
    Ok(limit)
}
fn expect_revision(headers: &HeaderMap, body: &Value, current: i64) -> Result<()> {
    let expected = headers
        .get(header::IF_MATCH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.trim_matches('"').parse::<i64>().ok())
        .or_else(|| body["expected_revision"].as_i64())
        .ok_or_else(|| ApiError::invalid("If-Match or expected_revision is required."))?;
    if expected != current {
        return Err(ApiError::revision(current));
    }
    Ok(())
}
fn idempotency(headers: &HeaderMap) -> Result<&str> {
    headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| ApiError::invalid("Idempotency-Key is required."))
}
struct Upload {
    filename: String,
    media_type: String,
    bytes: Vec<u8>,
}
fn safe_filename(filename: &str) -> String {
    filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("upload")
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect()
}
fn validate_mapping_claim(config: &Value) -> Result<()> {
    if let Some(claim) = config.get("coverage_claim") {
        let status = text(claim, "status")?;
        if !["unknown", "owner_confirmed"].contains(&status) {
            return Err(ApiError::invalid("Invalid coverage claim status."));
        }
        let from = domain::date(text(claim, "from")?)?;
        let to = domain::date(text(claim, "to")?)?;
        if from >= to {
            return Err(ApiError::invalid("Coverage claim period must be positive."));
        }
    }
    Ok(())
}

fn source_kind(v: &Value) -> Result<&str> {
    let kind = text(v, "source_kind")?;
    if !["money_manager", "bank_statement"].contains(&kind) {
        return Err(ApiError::invalid("Unsupported source_kind."));
    }
    Ok(kind)
}
pub async fn upload(state: &AppState, request: Request) -> Result<Reply> {
    let (parts, body) = request.into_parts();
    let mut db = state.pool.acquire().await?;
    let p = auth::principal(&mut db, &parts.headers).await?;
    auth::csrf(&p, &parts.headers)?;
    let key = idempotency(&parts.headers)?.to_owned();
    drop(db);
    let mut multipart = Multipart::from_request(Request::from_parts(parts, body), state)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "Use multipart/form-data.",
            )
        })?;
    let limit = file_limit();
    let mut files = vec![];
    let mut manifest: Option<Value> = None;
    let mut total = 0usize;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::invalid("Invalid multipart body."))?
    {
        let part = field.name().unwrap_or_default().to_owned();
        if part == "manifest" {
            if manifest.is_some() {
                return Err(ApiError::invalid("Only one manifest is allowed."));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|_| ApiError::invalid("Invalid manifest."))?
            {
                if bytes.len() + chunk.len() > 256 * 1024 {
                    return Err(ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "payload_too_large",
                        "Manifest exceeds 256 KiB.",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            manifest = Some(
                serde_json::from_slice(&bytes)
                    .map_err(|_| ApiError::invalid("Manifest must be JSON."))?,
            );
        } else if part == "files[]" {
            if files.len() >= MAX_BATCH_FILES {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "Too many files in batch.",
                ));
            }
            let filename = safe_filename(field.file_name().unwrap_or("upload"));
            if !["csv", "xlsx"]
                .iter()
                .any(|ext| filename.to_ascii_lowercase().ends_with(&format!(".{ext}")))
            {
                return Err(ApiError::new(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "unsupported_media_type",
                    "Only CSV and XLSX uploads are supported.",
                ));
            }
            let media_type = field
                .content_type()
                .map(|v| v.to_owned())
                .unwrap_or_else(|| "application/octet-stream".into());
            let mut bytes = Vec::new();
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|_| ApiError::invalid("Invalid file part."))?
            {
                if bytes.len() + chunk.len() > limit
                    || total + chunk.len() > limit * MAX_BATCH_FILES
                {
                    return Err(ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "payload_too_large",
                        "Upload exceeds the configured limit.",
                    ));
                }
                total += chunk.len();
                bytes.extend_from_slice(&chunk);
            }
            if bytes.is_empty() {
                return Err(ApiError::invalid("Empty files cannot be imported."));
            }
            if filename.ends_with(".xlsx") && !bytes.starts_with(b"PK\x03\x04") {
                return Err(ApiError::new(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "unsupported_media_type",
                    "XLSX content is invalid.",
                ));
            }
            files.push(Upload {
                filename,
                media_type,
                bytes,
            });
        } else {
            return Err(ApiError::invalid("Unexpected multipart part."));
        }
    }
    if files.is_empty() {
        return Err(ApiError::invalid("At least one file is required."));
    }
    let manifest = manifest.ok_or_else(|| ApiError::invalid("manifest is required."))?;
    let entries = manifest["files"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("manifest.files must be an array."))?;
    if entries.len() != files.len() {
        return Err(ApiError::invalid(
            "manifest.files must match files[] order and count.",
        ));
    }
    for entry in entries {
        source_kind(entry)?;
        if entry.get("mapping").is_some_and(|m| !m.is_object()) {
            return Err(ApiError::invalid("mapping must be an object."));
        }
        if let Some(config) = entry.get("mapping") {
            validate_mapping_claim(config)?;
        }
    }
    let fingerprint=hash(json!({"manifest":manifest,"files":files.iter().map(|f|json!({"filename":f.filename,"hash":hash(&f.bytes)})).collect::<Vec<_>>()} ).to_string().as_bytes());
    let mut tx = state.pool.begin().await?;
    let existing = sqlx::query(
        "SELECT fingerprint,status,response FROM idempotency WHERE principal=? AND key=?",
    )
    .bind(&p.user_id)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = existing {
        if row.get::<&str, _>(0) != fingerprint {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "idempotency_key_reused",
                "Key already used for another upload.",
            ));
        }
        let response: Value = serde_json::from_str(row.get(2))
            .map_err(|_| ApiError::invalid("Invalid saved response."))?;
        let _: Value = batch(&mut tx, &p, text(&response, "id")?).await?;
        return Ok((
            StatusCode::from_u16(row.get::<i64, _>(1) as u16).unwrap_or(StatusCode::ACCEPTED),
            response,
        ));
    }
    let batch_id = storage::id();
    sqlx::query("INSERT INTO import_batches(id,household_id,owner_id,state,created_at) VALUES(?,?,?,'uploaded',?)")
        .bind(&batch_id).bind(&p.household_id).bind(&p.user_id).bind(storage::now()).execute(&mut *tx).await?;
    let mut result_files = vec![];
    for (file, entry) in files.into_iter().zip(entries) {
        let id = storage::id();
        let job_id = storage::id();
        let kind = source_kind(entry)?;
        let profile_id = profile(&mut tx, &p, kind).await?;
        let mapping = entry.get("mapping").cloned().unwrap_or_else(|| json!({}));
        let account_id = mapping["account_id"]
            .as_str()
            .or_else(|| entry["account_id"].as_str());
        if let Some(account_id) = account_id {
            storage::get(&mut tx, &p, "accounts", account_id).await?;
        }
        sqlx::query("INSERT INTO source_files(id,batch_id,household_id,owner_id,account_id,profile_id,source_kind,filename,media_type,sha256,bytes,byte_count,state,mapping_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'uploaded',?,?)")
            .bind(&id).bind(&batch_id).bind(&p.household_id).bind(&p.user_id).bind(account_id).bind(&profile_id).bind(kind).bind(&file.filename).bind(&file.media_type).bind(hash(&file.bytes)).bind(&file.bytes).bind(file.bytes.len() as i64).bind(mapping.to_string()).bind(storage::now()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO import_jobs(id,household_id,owner_id,batch_id,file_id,state,created_at) VALUES(?,?,?,?,?,'queued',?)")
            .bind(&job_id).bind(&p.household_id).bind(&p.user_id).bind(&batch_id).bind(&id).bind(storage::now()).execute(&mut *tx).await?;
        result_files.push(json!({"id":id,"job_id":job_id,"filename":file.filename,"state":"uploaded","revision":1}));
    }
    let response = json!({"id":batch_id,"state":"uploaded","revision":1,"files":result_files});
    storage::audit(
        &mut tx,
        &p,
        &batch_id,
        "import_uploaded",
        None,
        Some(&json!({"id":batch_id,"file_count":entries.len()})),
    )
    .await?;
    sqlx::query(
        "INSERT INTO idempotency(principal,key,fingerprint,status,response) VALUES(?,?,?,202,?)",
    )
    .bind(&p.user_id)
    .bind(&key)
    .bind(fingerprint)
    .bind(response.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    for item in response["files"].as_array().unwrap() {
        spawn_parse(state.pool.clone(), text(item, "id")?.to_owned());
    }
    Ok((StatusCode::ACCEPTED, response))
}
async fn profile(db: &mut SqliteConnection, p: &Principal, kind: &str) -> Result<String> {
    if let Some(id) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM source_profiles WHERE household_id=? AND owner_id=? AND source_kind=?",
    )
    .bind(&p.household_id)
    .bind(&p.user_id)
    .bind(kind)
    .fetch_optional(&mut *db)
    .await?
    {
        return Ok(id);
    }
    let id = storage::id();
    sqlx::query(
        "INSERT INTO source_profiles(id,household_id,owner_id,source_kind,name) VALUES(?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&p.household_id)
    .bind(&p.user_id)
    .bind(kind)
    .bind(if kind == "money_manager" {
        "Money Manager"
    } else {
        "Bank statement"
    })
    .execute(db)
    .await?;
    Ok(id)
}
fn worker_p(owner: String, household: String) -> Principal {
    Principal {
        user_id: owner,
        household_id: household,
        member_id: String::new(),
        role: "member".into(),
        csrf: String::new(),
    }
}
pub async fn recover(pool: &SqlitePool) -> Result<()> {
    recover_observations(pool).await?;
    recover_descriptions(pool).await?;
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM source_files WHERE state IN ('uploaded','parsing')")
            .fetch_all(pool)
            .await?;
    for id in ids {
        spawn_parse(pool.clone(), id);
    }
    Ok(())
}
fn spawn_parse(pool: SqlitePool, id: String) {
    tokio::spawn(async move {
        if parse_job(pool.clone(), id.clone()).await.is_err()
            && let Ok(mut tx) = pool.begin().await
        {
            let current = sqlx::query(
                "SELECT household_id,owner_id,batch_id,state FROM source_files WHERE id=?",
            )
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await;
            if let Ok(Some(row)) = current {
                let state: String = row.get(3);
                if state == "parsing" {
                    let p = worker_p(row.get(1), row.get(0));
                    let batch: String = row.get(2);
                    let _ = fail_parse(tx, &p, &id, &batch, "transient_parse_failed").await;
                }
            }
        }
    });
}
async fn parse_job(pool: SqlitePool, id: String) -> Result<()> {
    let mut conn = pool.acquire().await?;
    let row=sqlx::query("SELECT household_id,owner_id,batch_id,filename,source_kind,bytes FROM source_files WHERE id=? AND state IN ('uploaded','parsing')").bind(&id).fetch_optional(&mut *conn).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let household: String = row.get(0);
    let owner: String = row.get(1);
    let batch: String = row.get(2);
    let filename: String = row.get(3);
    let kind: String = row.get(4);
    let bytes: Vec<u8> = row.get(5);
    let changed=sqlx::query("UPDATE source_files SET state='parsing',revision=revision+1 WHERE id=? AND state IN ('uploaded','parsing')")
        .bind(&id).execute(&mut *conn).await?;
    if changed.rows_affected() == 0 {
        return Ok(());
    }
    sqlx::query("UPDATE import_jobs SET state='running',progress=10,revision=revision+1 WHERE file_id=? AND state IN ('queued','running')").bind(&id).execute(&mut *conn).await?;
    drop(conn);
    let bank_xlsx = kind == "bank_statement" && filename.to_ascii_lowercase().ends_with(".xlsx");
    let parsed = tokio::task::spawn_blocking(move || import_parse::parse(&bytes, &filename))
        .await
        .map_err(|_| fail("parse_failed", "Parser task failed."))?;
    let mut tx = pool.begin().await?;
    let current: Option<String> = sqlx::query_scalar("SELECT state FROM source_files WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    if current.as_deref() != Some("parsing") {
        return Ok(());
    }
    let actor = worker_p(owner, household);
    match parsed {
        Ok(mut file) => {
            if bank_xlsx {
                file = import_parse::bank_statement_xlsx(file)?;
            }
            if kind == "money_manager" && !import_parse::money_manager(&file)? {
                return fail_parse(tx, &actor, &id, &batch, "unsupported_layout").await;
            }
            let duplicate_account_column = if kind == "money_manager" {
                file.headers
                    .iter()
                    .enumerate()
                    .filter(|(_, h)| h.trim() == "Accounts")
                    .map(|(i, _)| i)
                    .nth(1)
            } else {
                None
            };
            if let Some(last) = duplicate_account_column {
                let all_redundant = file.rows.iter().all(|row| {
                    let currency = row.at(&file.headers, "Currency").trim();
                    let first =
                        domain::money(row.at(&file.headers, "Amount").trim(), currency).ok();
                    let last = row
                        .cells
                        .get(last)
                        .and_then(|s| domain::money(s.trim(), currency).ok());
                    first.is_some() && first == last
                });
                file.warnings.push(
                    if all_redundant {
                        "duplicate_accounts_header_last_column_ignored"
                    } else {
                        "ambiguous_duplicate_accounts_column"
                    }
                    .into(),
                );
            }
            sqlx::query("DELETE FROM import_rows WHERE file_id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            let mut normalized = Vec::new();
            for row in &file.rows {
                normalized.push(import_parse::normalize(&file, row, &kind, None));
            }
            let occurrences = import_parse::occurrence_numbers(&normalized);
            for ((row, mut value), occurrence) in file.rows.iter().zip(normalized).zip(occurrences)
            {
                if let Some(last) = duplicate_account_column {
                    let currency = row.at(&file.headers, "Currency").trim();
                    let main = domain::money(row.at(&file.headers, "Amount").trim(), currency).ok();
                    let extra = row
                        .cells
                        .get(last)
                        .and_then(|s| domain::money(s.trim(), currency).ok());
                    if main.is_none() || main != extra {
                        value["issues"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!("ambiguous_duplicate_accounts_column"));
                    }
                }
                value["item_id"] = json!(storage::id());
                let fingerprint = import_parse::fingerprint(&value);
                sqlx::query("INSERT INTO import_rows(file_id,row_number,raw_json,normalized_json,fingerprint,occurrence) VALUES(?,?,?,?,?,?)")
                    .bind(&id).bind(row.row_number as i64).bind(row.raw(&file.headers).to_string()).bind(value.to_string()).bind(fingerprint).bind(occurrence as i64).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE source_files SET state='needs_mapping',warnings_json=?,error_code=NULL,revision=revision+1 WHERE id=?")
                .bind(json!(file.warnings).to_string()).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE import_jobs SET state='completed',progress=100,error_code=NULL,revision=revision+1 WHERE file_id=? AND state='running'").bind(&id).execute(&mut *tx).await?;
            update_batch(&mut tx, &batch).await?;
            storage::audit(
                &mut tx,
                &actor,
                &id,
                "parse_complete",
                None,
                Some(&json!({"row_count":file.rows.len(),"adapter":file.adapter})),
            )
            .await?;
            tx.commit().await?;
            Ok(())
        }
        Err(err) => {
            let code = err.code;
            fail_parse(tx, &actor, &id, &batch, code).await
        }
    }
}
async fn fail_parse(
    mut db: sqlx::Transaction<'_, sqlx::Sqlite>,
    p: &Principal,
    file: &str,
    batch: &str,
    code: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE source_files SET state='failed',error_code=?,revision=revision+1 WHERE id=?",
    )
    .bind(code)
    .bind(file)
    .execute(&mut *db)
    .await?;
    sqlx::query("UPDATE import_jobs SET state='failed',error_code=?,progress=100,revision=revision+1 WHERE file_id=? AND state='running'").bind(code).bind(file).execute(&mut *db).await?;
    update_batch(&mut db, batch).await?;
    storage::audit(
        &mut db,
        p,
        file,
        "parse_failed",
        None,
        Some(&json!({"error_code":code})),
    )
    .await?;
    db.commit().await?;
    Ok(())
}
async fn update_batch(db: &mut SqliteConnection, id: &str) -> Result<()> {
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM source_files WHERE batch_id=?")
        .bind(id)
        .fetch_all(&mut *db)
        .await?;
    let state = if states.iter().all(|s| s == "committed" || s == "omitted") {
        "committed"
    } else if states.iter().any(|s| s == "failed") {
        "failed"
    } else if states.iter().any(|s| s == "needs_review") {
        "needs_review"
    } else if states.iter().any(|s| s == "needs_mapping") {
        "needs_mapping"
    } else if states.iter().any(|s| s == "ready") {
        "ready"
    } else if states.iter().any(|s| s == "parsing") {
        "parsing"
    } else {
        "uploaded"
    };
    sqlx::query("UPDATE import_batches SET state=?,revision=revision+1 WHERE id=?")
        .bind(state)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
async fn batch(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT state,revision,created_at FROM import_batches WHERE id=? AND household_id=? AND owner_id=?").bind(id).bind(&p.household_id).bind(&p.user_id).fetch_optional(&mut *db).await?.ok_or_else(ApiError::missing)?;
    let files=sqlx::query("SELECT id,filename,byte_count,source_kind,account_id,state,revision,warnings_json,error_code,sha256 FROM source_files WHERE batch_id=? ORDER BY id").bind(id).fetch_all(&mut *db).await?;
    let mut value = vec![];
    for f in files {
        let file_id: String = f.get(0);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM import_rows WHERE file_id=?")
            .bind(&file_id)
            .fetch_one(&mut *db)
            .await?;
        value.push(json!({"id":file_id,"filename":f.get::<String,_>(1),"byte_count":f.get::<i64,_>(2),"source_kind":f.get::<String,_>(3),"account_id":f.get::<Option<String>,_>(4),"state":f.get::<String,_>(5),"revision":f.get::<i64,_>(6),"warnings":serde_json::from_str::<Value>(f.get(7)).unwrap_or(json!([])),"error_code":f.get::<Option<String>,_>(8),"sha256":f.get::<String,_>(9),"row_count":count}));
    }
    Ok(
        json!({"id":id,"state":row.get::<String,_>(0),"revision":row.get::<i64,_>(1),"created_at":row.get::<String,_>(2),"files":value}),
    )
}
async fn file(
    db: &mut SqliteConnection,
    p: &Principal,
    batch_id: &str,
    file_id: &str,
) -> Result<Value> {
    batch(db, p, batch_id).await?;
    let row=sqlx::query("SELECT filename,media_type,sha256,byte_count,source_kind,account_id,profile_id,state,revision,mapping_json,warnings_json,error_code FROM source_files WHERE id=? AND batch_id=? AND household_id=? AND owner_id=?")
        .bind(file_id).bind(batch_id).bind(&p.household_id).bind(&p.user_id).fetch_optional(&mut *db).await?.ok_or_else(ApiError::missing)?;
    let row_count: i64 = sqlx::query_scalar("SELECT count(*) FROM import_rows WHERE file_id=?")
        .bind(file_id)
        .fetch_one(&mut *db)
        .await?;
    Ok(
        json!({"row_count":row_count,"id":file_id,"batch_id":batch_id,"filename":row.get::<String,_>(0),"media_type":row.get::<String,_>(1),"sha256":row.get::<String,_>(2),"byte_count":row.get::<i64,_>(3),"source_kind":row.get::<String,_>(4),"account_id":row.get::<Option<String>,_>(5),"profile_id":row.get::<String,_>(6),"state":row.get::<String,_>(7),"revision":row.get::<i64,_>(8),"mapping":serde_json::from_str::<Value>(row.get(9)).unwrap_or(json!({})),"warnings":serde_json::from_str::<Value>(row.get(10)).unwrap_or(json!([])),"error_code":row.get::<Option<String>,_>(11)}),
    )
}

struct Mapping {
    accounts: HashMap<String, String>,
    categories: HashMap<(String, String, String), String>,
}
async fn mapping(db: &mut SqliteConnection, p: &Principal, file: &Value) -> Result<Mapping> {
    let profile = text(file, "profile_id")?;
    let accounts =
        sqlx::query("SELECT source_label,account_id FROM account_aliases WHERE profile_id=?")
            .bind(profile)
            .fetch_all(&mut *db)
            .await?;
    let categories=sqlx::query("SELECT source_label,subcategory,event_kind,category_id FROM category_mappings WHERE profile_id=?").bind(profile).fetch_all(&mut *db).await?;
    let mut a: HashMap<String, String> = HashMap::new();
    let mut c: HashMap<(String, String, String), String> = HashMap::new();
    for r in accounts {
        a.insert(r.get::<String, _>(0), r.get::<String, _>(1));
    }
    for r in categories {
        c.insert(
            (
                r.get::<String, _>(0),
                r.get::<String, _>(1),
                r.get::<String, _>(2),
            ),
            r.get::<String, _>(3),
        );
    }
    let config = &file["mapping"];
    if let Some(aliases) = config["account_aliases"].as_object() {
        for (label, id) in aliases {
            a.insert(
                label.trim().into(),
                id.as_str()
                    .ok_or_else(|| ApiError::invalid("Account alias IDs must be strings."))?
                    .into(),
            );
        }
    }
    if let Some(mappings) = config["category_mappings"].as_array() {
        for m in mappings {
            c.insert(
                (
                    text(m, "source_label")?.trim().into(),
                    m["subcategory"].as_str().unwrap_or("").trim().into(),
                    text(m, "event_kind")?.into(),
                ),
                text(m, "category_id")?.into(),
            );
        }
    }
    for id in a.values() {
        storage::get(db, p, "accounts", id).await?;
    }
    for id in c.values() {
        storage::get(db, p, "categories", id).await?;
    }
    Ok(Mapping {
        accounts: a,
        categories: c,
    })
}
fn raw_row(value: &Value) -> Result<ParsedRow> {
    let row_number = value["row_number"]
        .as_u64()
        .ok_or_else(|| ApiError::invalid("Invalid source row."))? as usize;
    let cells = value["columns"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("Invalid source columns."))?
        .iter()
        .map(|c| c["value"].as_str().unwrap_or("").to_owned())
        .collect();
    Ok(ParsedRow { row_number, cells })
}
fn raw_headers(raw: &Value) -> Vec<String> {
    raw["columns"]
        .as_array()
        .map(|columns| {
            columns
                .iter()
                .map(|c| c["header"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}
fn normalize_bank(parsed: &ParsedFile, row: &ParsedRow, config: &Value) -> Value {
    let columns = &config["columns"];
    let statement_xlsx = parsed.adapter == "bank-statement-xlsx-v1";
    let lookup = |name: &str, default: &str| -> String {
        row.at(&parsed.headers, columns[name].as_str().unwrap_or(default))
            .trim()
            .to_owned()
    };
    let currency = config["currency"]
        .as_str()
        .unwrap_or_else(|| row.at(&parsed.headers, "Currency"))
        .trim()
        .to_owned();
    let raw_date = lookup("date", "Date");
    let (date, time, error) = match import_parse::date(
        &raw_date,
        parsed.adapter,
        false,
        config["date_locale"]
            .as_str()
            .or(if statement_xlsx { Some("DMY") } else { None }),
    ) {
        Ok((d, t)) => (Some(d), t, None),
        Err(_) => (None, None, Some("invalid_date")),
    };
    let debit = lookup(
        "debit",
        if statement_xlsx {
            "Withdrawals"
        } else {
            "Debit"
        },
    );
    let credit = lookup("credit", if statement_xlsx { "Deposits" } else { "Credit" });
    let signed = if !debit.is_empty() || !credit.is_empty() {
        if !debit.is_empty() && !credit.is_empty() {
            None
        } else if !debit.is_empty() {
            domain::money(&debit, &currency)
                .ok()
                .and_then(|n| n.checked_neg())
        } else {
            domain::money(&credit, &currency).ok()
        }
    } else {
        domain::money(&lookup("amount", "Amount"), &currency).ok()
    };
    let mut issues = vec![];
    if let Some(error) = error {
        issues.push(error);
    }
    if signed.is_none_or(|n| n == 0 || n == i64::MIN) {
        issues.push("invalid_amount");
    }
    let raw_balance = lookup("balance", "Balance");
    let statement_balance = if raw_balance.is_empty() {
        None
    } else {
        domain::money(&raw_balance, &currency)
            .ok()
            .and_then(|n| domain::format_money(n, &currency).ok())
    };
    if (statement_xlsx || !raw_balance.is_empty()) && statement_balance.is_none() {
        issues.push("invalid_statement_balance");
    }
    json!({"source_kind":"bank_statement","event_type":"observation","effective_date":date,"local_time":time,"currency":currency,"amount":signed.and_then(|n|n.checked_abs()).and_then(|n|domain::format_money(n,&currency).ok()),"signed_movement":signed.and_then(|n|domain::format_money(n,&currency).ok()),"description":lookup("description",if statement_xlsx { "Particulars" } else { "Description" }),"reference":lookup("reference",if statement_xlsx { "Cheque Details" } else { "Reference" }),"statement_balance":statement_balance,"issues":issues,"proposed_action":"store_observation"})
}
pub(crate) fn normalize_again(raw: &Value, file: &Value) -> Result<Value> {
    let row = raw_row(raw)?;
    let parsed = ParsedFile {
        headers: raw_headers(raw),
        rows: vec![],
        warnings: file["warnings"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        adapter: if text(file, "filename")?
            .to_ascii_lowercase()
            .ends_with(".xlsx")
        {
            if file["source_kind"] == "bank_statement" {
                "bank-statement-xlsx-v1"
            } else {
                "money-manager-xlsx-v1"
            }
        } else {
            "csv-v1"
        },
    };
    let config = &file["mapping"];
    Ok(if file["source_kind"] == "bank_statement" {
        normalize_bank(&parsed, &row, config)
    } else {
        import_parse::normalize(
            &parsed,
            &row,
            "money_manager",
            config["date_locale"].as_str(),
        )
    })
}
async fn prepared(db: &mut SqliteConnection, p: &Principal, file: &Value) -> Result<Vec<Value>> {
    let maps = mapping(db, p, file).await?;
    let rows=sqlx::query("SELECT row_number,raw_json,normalized_json,occurrence FROM import_rows WHERE file_id=? ORDER BY row_number").bind(text(file,"id")?).fetch_all(&mut *db).await?;
    let mut output = vec![];
    let mut counts: HashMap<(String, String), i64> = HashMap::new();
    for r in rows {
        let raw: Value = serde_json::from_str(r.get::<&str, _>(1))
            .map_err(|_| ApiError::invalid("Invalid saved source row."))?;
        let saved: Value = serde_json::from_str(r.get::<&str, _>(2))
            .map_err(|_| ApiError::invalid("Invalid saved normalized row."))?;
        let mut value = normalize_again(&raw, file)?;
        value["item_id"] = saved["item_id"].clone();
        value["revision"] = file["revision"].clone();
        value["raw_row_ref"] = json!({"file_id":file["id"],"row_number":r.get::<i64,_>(0)});
        value["source_coordinates"] = json!({"row":r.get::<i64,_>(0),"sheet":if text(file,"filename")?.ends_with(".xlsx"){Some("Sheet1")}else{None}});
        value["raw"] = raw;
        let account_id = if file["source_kind"] == "bank_statement" {
            file["mapping"]["account_id"]
                .as_str()
                .or_else(|| file["account_id"].as_str())
                .map(str::to_owned)
        } else {
            maps.accounts
                .get(value["source_account"].as_str().unwrap_or("").trim())
                .cloned()
        };
        let mut issues = value["issues"].as_array().cloned().unwrap_or_default();
        for code in ["ambiguous_duplicate_accounts_column"] {
            if saved["issues"]
                .as_array()
                .is_some_and(|a| a.contains(&json!(code)))
            {
                issues.push(json!(code));
            }
        }
        let account = if let Some(id) = account_id.as_deref() {
            Some(storage::get(db, p, "accounts", id).await?)
        } else {
            issues.push(json!("unmapped_account"));
            None
        };
        value["account_id"] = json!(account_id);
        if let Some(account) = &account
            && account["currency"] != value["currency"]
        {
            issues.push(json!("account_currency_mismatch"));
        }
        if file["source_kind"] == "money_manager" {
            let kind = value["event_type"].as_str().unwrap_or("");
            if kind == "expense" || kind == "income" {
                let key = (
                    value["source_category"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .to_owned(),
                    value["source_subcategory"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .to_owned(),
                    kind.to_owned(),
                );
                let category_id = maps.categories.get(&key).cloned();
                if let Some(id) = category_id.as_deref() {
                    let category = storage::get(db, p, "categories", id).await?;
                    if category["kind"] != kind || category["archived"] == true {
                        issues.push(json!("invalid_category_mapping"));
                    }
                } else {
                    issues.push(json!("unmapped_category"));
                }
                value["category_id"] = json!(category_id);
            } else if kind.starts_with("transfer") {
                let counterpart = maps
                    .accounts
                    .get(value["source_category"].as_str().unwrap_or("").trim())
                    .cloned();
                if counterpart.is_none() {
                    issues.push(json!("unmapped_counterpart_account"));
                }
                if counterpart == account_id {
                    issues.push(json!("same_transfer_account"));
                }
                value["counterpart_account_id"] = json!(counterpart);
                value["proposed_action"] = json!("review_or_pair_transfer");
            }
        }
        value["issues"] = json!(issues);
        let fingerprint = import_parse::fingerprint(&value);
        let account_key = account_id.unwrap_or_default();
        let occurrence = counts
            .entry((account_key.clone(), fingerprint.clone()))
            .or_default();
        *occurrence += 1;
        value["fingerprint"] = json!(fingerprint);
        value["occurrence"] = json!(*occurrence);
        if !account_key.is_empty() {
            let existing=sqlx::query("SELECT transaction_id FROM import_occurrences WHERE household_id=? AND account_id=? AND fingerprint=? AND occurrence=?")
                .bind(&p.household_id).bind(&account_key).bind(&fingerprint).bind(*occurrence).fetch_optional(&mut *db).await?;
            if let Some(existing) = existing {
                value["duplicate_candidates"] = json!([{"transaction_id":existing.get::<Option<String>,_>(0),"reason":"same_account_source_occurrence"}]);
            } else if file["source_kind"] == "money_manager"
                && ["expense", "income"].contains(&value["event_type"].as_str().unwrap_or(""))
                && value["effective_date"].as_str().is_some()
            {
                let candidate_ids:Vec<String>=sqlx::query_scalar("SELECT r.id FROM resources r,json_each(r.document,'$.movements') m WHERE r.household_id=? AND r.kind='transactions' AND json_extract(m.value,'$.account_id')=? AND json_extract(r.document,'$.effective_date')=? AND json_extract(r.document,'$.event_type')=? AND json_extract(r.document,'$.description')=? AND json_extract(r.document,'$.voided')=0 LIMIT 10")
                    .bind(&p.household_id).bind(&account_key).bind(value["effective_date"].as_str().unwrap()).bind(value["event_type"].as_str().unwrap()).bind(value["description"].as_str().unwrap()).fetch_all(&mut *db).await?;
                if candidate_ids.is_empty() {
                    value["duplicate_candidates"] = json!([]);
                } else {
                    value["duplicate_candidates"]=json!(candidate_ids.into_iter().map(|id|json!({"transaction_id":id,"reason":"possibly_edited_or_new_occurrence"})).collect::<Vec<_>>());
                    value["issues"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("possible_existing_event"));
                }
            } else {
                value["duplicate_candidates"] = json!([]);
            }
        }
        output.push(value);
    }
    if file["source_kind"] == "bank_statement"
        && text(file, "filename")?
            .to_ascii_lowercase()
            .ends_with(".xlsx")
    {
        let mut previous: Option<i64> = None;
        for row in &mut output {
            let currency = text(row, "currency")?;
            let balance = row["statement_balance"]
                .as_str()
                .map(|v| domain::money(v, currency))
                .transpose()?;
            let movement = row["signed_movement"]
                .as_str()
                .map(|v| domain::money(v, currency))
                .transpose()?;
            if let (Some(before), Some(movement), Some(after)) = (previous, movement, balance)
                && domain::add(before, movement)? != after
            {
                row["issues"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("statement_balance_discontinuity"));
            }
            previous = balance;
        }
    }
    Ok(output)
}
async fn refresh_state(db: &mut SqliteConnection, p: &Principal, file: &Value) -> Result<String> {
    let rows = prepared(db, p, file).await?;
    let unresolved = rows
        .iter()
        .any(|r| r["issues"].as_array().is_some_and(|a| !a.is_empty()));
    let state = if unresolved { "needs_review" } else { "ready" };
    sqlx::query("UPDATE source_files SET state=?,revision=revision+1 WHERE id=?")
        .bind(state)
        .bind(text(file, "id")?)
        .execute(&mut *db)
        .await?;
    update_batch(db, text(file, "batch_id")?).await?;
    Ok(state.into())
}
async fn profile_owned(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT name,source_kind,revision FROM source_profiles WHERE id=? AND household_id=? AND owner_id=?").bind(id).bind(&p.household_id).bind(&p.user_id).fetch_optional(db).await?.ok_or_else(ApiError::missing)?;
    Ok(
        json!({"id":id,"name":row.get::<String,_>(0),"source_kind":row.get::<String,_>(1),"revision":row.get::<i64,_>(2)}),
    )
}
fn safe_file_response(file: &Value) -> Value {
    let mut result = file.clone();
    result.as_object_mut().unwrap().remove("mapping");
    result
}

async fn list_batches(
    db: &mut SqliteConnection,
    p: &Principal,
    q: &HashMap<String, String>,
) -> Result<Reply> {
    let limit = bound(q)?;
    let rows=sqlx::query("SELECT id FROM import_batches WHERE household_id=? AND owner_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?")
        .bind(&p.household_id).bind(&p.user_id).bind(q.get("cursor")).bind(q.get("cursor")).bind((limit+1) as i64).fetch_all(&mut *db).await?;
    let has_more = rows.len() > limit;
    let mut data = vec![];
    for row in rows.into_iter().take(limit) {
        let id: String = row.get(0);
        data.push(batch(db, p, &id).await?);
    }
    let next = if has_more {
        data.last()
            .and_then(|v| v["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok((StatusCode::OK, collection(data, next)))
}
async fn preview(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    q: &HashMap<String, String>,
) -> Result<Reply> {
    let batch_value = batch(db, p, id).await?;
    let file_id = if let Some(id) = q.get("file_id") {
        id.as_str()
    } else if batch_value["files"].as_array().unwrap().len() == 1 {
        batch_value["files"][0]["id"].as_str().unwrap()
    } else {
        return Err(ApiError::invalid(
            "file_id is required for multi-file batches.",
        ));
    };
    let file = file(db, p, id, file_id).await?;
    if ["uploaded", "parsing"].contains(&text(&file, "state")?) {
        return Err(ApiError::conflict("File is not parsed yet."));
    }
    let rows = prepared(db, p, &file).await?;
    let limit = bound(q)?;
    let cursor = q
        .get("cursor")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| ApiError::invalid("Invalid cursor."))?
        .unwrap_or(0);
    let selected = rows
        .iter()
        .filter(|r| r["raw_row_ref"]["row_number"].as_i64().unwrap_or(0) > cursor)
        .take(limit + 1)
        .cloned()
        .collect::<Vec<_>>();
    let has_more = selected.len() > limit;
    let data = selected.into_iter().take(limit).collect::<Vec<_>>();
    let next = if has_more {
        data.last()
            .and_then(|r| r["raw_row_ref"]["row_number"].as_i64())
            .map(|n| n.to_string())
    } else {
        None
    };
    let unresolved = rows
        .iter()
        .filter(|r| r["issues"].as_array().is_some_and(|i| !i.is_empty()))
        .count();
    let duplicates = rows
        .iter()
        .filter(|r| {
            r["duplicate_candidates"]
                .as_array()
                .is_some_and(|i| !i.is_empty())
        })
        .count();
    let mut totals: HashMap<(String, String), i64> = HashMap::new();
    for r in &rows {
        if let (Some(kind), Some(amount), Some(currency)) = (
            r["event_type"].as_str(),
            r["amount"].as_str(),
            r["currency"].as_str(),
        ) && let Ok(n) = domain::money(amount, currency)
        {
            let total = totals.entry((kind.into(), currency.into())).or_default();
            *total = total
                .checked_add(n)
                .ok_or_else(|| ApiError::invalid("Import total exceeds supported amount."))?;
        }
    }
    let mut amount_totals = json!({});
    for ((kind, currency), amount) in totals {
        amount_totals[&kind][&currency] = json!(domain::format_money(amount, &currency)?);
    }
    Ok((
        StatusCode::OK,
        json!({"data":data,"page":if let Some(next)=next{json!({"next_cursor":next})}else{json!({})},"meta":{"file_id":file_id,"batch_id":id,"file_revision":file["revision"],"row_count":rows.len(),"unresolved_count":unresolved,"duplicate_candidate_count":duplicates,"totals_by_event_type":amount_totals,"warnings":file["warnings"],"coverage":"unknown","adapter":if file["filename"].as_str().unwrap_or("").ends_with(".xlsx"){if file["source_kind"]=="bank_statement"{"bank-statement-xlsx-v1"}else{"money-manager-xlsx-v1"}}else{"csv-v1"}}}),
    ))
}
async fn update_mapping(
    db: &mut SqliteConnection,
    p: &Principal,
    batch_id: &str,
    file_id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    let original_file = file(db, p, batch_id, file_id).await?;
    expect_revision(
        headers,
        body,
        original_file["revision"].as_i64().unwrap_or(1),
    )?;
    if ["committed", "omitted", "cancelled", "uploaded", "parsing"]
        .contains(&text(&original_file, "state")?)
    {
        return Err(ApiError::conflict(
            "Mapping cannot be changed in this file state.",
        ));
    }
    let mut config = original_file["mapping"].clone();
    let input = body.get("mapping").unwrap_or(body);
    for key in [
        "account_id",
        "currency",
        "date_locale",
        "account_aliases",
        "category_mappings",
        "columns",
        "period",
        "coverage_claim",
        "allocation_scope",
    ] {
        if let Some(value) = input.get(key) {
            config[key] = value.clone();
        }
    }
    validate_mapping_claim(&config)?;
    if let Some(scope) = config["allocation_scope"].as_str()
        && !["personal", "family"].contains(&scope)
    {
        return Err(ApiError::invalid("Invalid allocation scope."));
    }
    if config.get("allocation_scope").is_some() && !config["allocation_scope"].is_string() {
        return Err(ApiError::invalid("Invalid allocation scope."));
    }
    if let Some(locale) = config["date_locale"].as_str()
        && !["DMY", "MDY"].contains(&locale)
    {
        return Err(ApiError::invalid("date_locale must be DMY or MDY."));
    }
    if let Some(account_id) = config["account_id"].as_str() {
        storage::get(db, p, "accounts", account_id).await?;
    }
    if config["account_aliases"].is_object() {
        for id in config["account_aliases"].as_object().unwrap().values() {
            storage::get(
                db,
                p,
                "accounts",
                id.as_str()
                    .ok_or_else(|| ApiError::invalid("Invalid account alias."))?,
            )
            .await?;
        }
    }
    if let Some(category_mappings) = config["category_mappings"].as_array() {
        for m in category_mappings {
            let category = storage::get(db, p, "categories", text(m, "category_id")?).await?;
            if category["kind"] != m["event_kind"] {
                return Err(ApiError::invalid(
                    "Category kind differs from mapping event kind.",
                ));
            }
        }
    }
    sqlx::query(
        "UPDATE source_files SET mapping_json=?,account_id=?,revision=revision+1 WHERE id=?",
    )
    .bind(config.to_string())
    .bind(config["account_id"].as_str())
    .bind(file_id)
    .execute(&mut *db)
    .await?;
    let mut updated = file(db, p, batch_id, file_id).await?;
    let state = refresh_state(db, p, &updated).await?;
    updated = file(db, p, batch_id, file_id).await?;
    storage::audit(
        db,
        p,
        file_id,
        "mapping_updated",
        Some(&safe_file_response(&original_file)),
        Some(&json!({"state":state,"revision":updated["revision"]})),
    )
    .await?;
    Ok((StatusCode::OK, updated))
}
async fn mark_file(
    db: &mut SqliteConnection,
    p: &Principal,
    batch_id: &str,
    file_id: &str,
    headers: &HeaderMap,
    body: &Value,
    action: &str,
) -> Result<Reply> {
    let file = file(db, p, batch_id, file_id).await?;
    expect_revision(headers, body, file["revision"].as_i64().unwrap_or(1))?;
    if action == "omit" {
        text(body, "reason")?;
        if file["state"] == "committed" {
            return Err(ApiError::conflict("Committed files cannot be omitted."));
        }
    }
    if action == "retry" {
        if file["state"] != "failed" {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "job_not_retryable",
                "Only failed files can be retried.",
            ));
        }
        if !["parse_failed", "transient_parse_failed"]
            .contains(&file["error_code"].as_str().unwrap_or(""))
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "job_not_retryable",
                "This parse error requires a corrected file.",
            ));
        }
    }
    let state = if action == "retry" {
        "uploaded"
    } else {
        "omitted"
    };
    sqlx::query("UPDATE source_files SET state=?,error_code=NULL,revision=revision+1 WHERE id=?")
        .bind(state)
        .bind(file_id)
        .execute(&mut *db)
        .await?;
    if action == "retry" {
        sqlx::query("INSERT INTO import_jobs(id,household_id,owner_id,batch_id,file_id,state,created_at) VALUES(?,?,?,?,?,'queued',?)")
        .bind(storage::id()).bind(&p.household_id).bind(&p.user_id).bind(batch_id).bind(file_id).bind(storage::now()).execute(&mut *db).await?;
    }
    update_batch(db, batch_id).await?;
    storage::audit(
        db,
        p,
        file_id,
        action,
        Some(&safe_file_response(&file)),
        Some(&json!({"state":state,"reason":body["reason"]})),
    )
    .await?;
    Ok((
        StatusCode::OK,
        json!({"file_id":file_id,"state":state,"revision":file["revision"].as_i64().unwrap_or(1)+1}),
    ))
}
async fn cancel(
    db: &mut SqliteConnection,
    p: &Principal,
    batch_id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    let before = batch(db, p, batch_id).await?;
    expect_revision(headers, body, before["revision"].as_i64().unwrap_or(1))?;
    sqlx::query("UPDATE source_files SET state='cancelled',revision=revision+1 WHERE batch_id=? AND state IN ('uploaded','parsing','needs_mapping','needs_review','ready','failed')").bind(batch_id).execute(&mut *db).await?;
    sqlx::query("UPDATE import_jobs SET state='cancelled',revision=revision+1 WHERE batch_id=? AND state IN ('queued','running')").bind(batch_id).execute(&mut *db).await?;
    update_batch(db, batch_id).await?;
    let after = batch(db, p, batch_id).await?;
    storage::audit(db, p, batch_id, "cancel", Some(&before), Some(&after)).await?;
    Ok((StatusCode::OK, after))
}
async fn job(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT batch_id,file_id,state,error_code,progress,revision,created_at FROM import_jobs WHERE id=? AND household_id=? AND owner_id=?").bind(id).bind(&p.household_id).bind(&p.user_id).fetch_optional(db).await?.ok_or_else(ApiError::missing)?;
    Ok(
        json!({"id":id,"batch_id":row.get::<String,_>(0),"file_id":row.get::<String,_>(1),"state":row.get::<String,_>(2),"error_code":row.get::<Option<String>,_>(3),"progress":row.get::<i64,_>(4),"revision":row.get::<i64,_>(5),"created_at":row.get::<String,_>(6),"result_link":format!("/api/v1/imports/{}",row.get::<String,_>(0))}),
    )
}
async fn source_profiles(db: &mut SqliteConnection, p: &Principal) -> Result<Reply> {
    let rows=sqlx::query("SELECT id,name,source_kind,revision FROM source_profiles WHERE household_id=? AND owner_id=? ORDER BY id").bind(&p.household_id).bind(&p.user_id).fetch_all(db).await?;
    let data=rows.into_iter().map(|r|json!({"id":r.get::<String,_>(0),"name":r.get::<String,_>(1),"source_kind":r.get::<String,_>(2),"revision":r.get::<i64,_>(3)})).collect();
    Ok((StatusCode::OK, collection(data, None)))
}
async fn profile_mappings(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Reply> {
    profile_owned(db, p, id).await?;
    let rows=sqlx::query("SELECT id,source_label,subcategory,event_kind,category_id,revision FROM category_mappings WHERE profile_id=? ORDER BY id").bind(id).fetch_all(db).await?;
    let data=rows.into_iter().map(|r|json!({"id":r.get::<String,_>(0),"source_label":r.get::<String,_>(1),"subcategory":r.get::<String,_>(2),"event_kind":r.get::<String,_>(3),"category_id":r.get::<String,_>(4),"revision":r.get::<i64,_>(5)})).collect();
    Ok((StatusCode::OK, collection(data, None)))
}
async fn put_mapping(
    db: &mut SqliteConnection,
    p: &Principal,
    profile_id: &str,
    mapping_id: &str,
    headers: &HeaderMap,
    body: &Value,
    kind: &str,
) -> Result<Reply> {
    profile_owned(db, p, profile_id).await?;
    let table = if kind == "category" {
        "category_mappings"
    } else {
        "account_aliases"
    };
    let existing = sqlx::query(&format!(
        "SELECT revision FROM {table} WHERE id=? AND profile_id=?"
    ))
    .bind(mapping_id)
    .bind(profile_id)
    .fetch_optional(&mut *db)
    .await?;
    if let Some(row) = existing {
        expect_revision(headers, body, row.get(0))?;
    } else if uuid::Uuid::parse_str(mapping_id).is_err() {
        return Err(ApiError::invalid("New mapping IDs must be UUIDs."));
    }
    let label = text(body, "source_label")?.trim();
    if label.len() > 256 {
        return Err(ApiError::invalid("Source label too long."));
    }
    if kind == "category" {
        let event_kind = text(body, "event_kind")?;
        if !["expense", "income"].contains(&event_kind) {
            return Err(ApiError::invalid("Invalid event kind."));
        }
        let category = storage::get(db, p, "categories", text(body, "category_id")?).await?;
        if category["kind"] != event_kind || category["archived"] == true {
            return Err(ApiError::invalid(
                "Category kind/archived state differs from mapping.",
            ));
        }
        let subcategory = body["subcategory"].as_str().unwrap_or("").trim();
        sqlx::query("INSERT INTO category_mappings(id,profile_id,source_label,subcategory,event_kind,category_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_label=excluded.source_label,subcategory=excluded.subcategory,event_kind=excluded.event_kind,category_id=excluded.category_id,revision=revision+1")
            .bind(mapping_id).bind(profile_id).bind(label).bind(subcategory).bind(event_kind).bind(text(body,"category_id")?).execute(&mut *db).await?;
    } else {
        storage::get(db, p, "accounts", text(body, "account_id")?).await?;
        sqlx::query("INSERT INTO account_aliases(id,profile_id,source_label,account_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_label=excluded.source_label,account_id=excluded.account_id,revision=revision+1")
            .bind(mapping_id).bind(profile_id).bind(label).bind(text(body,"account_id")?).execute(&mut *db).await?;
    }
    let row = sqlx::query(&format!("SELECT revision FROM {table} WHERE id=?"))
        .bind(mapping_id)
        .fetch_one(&mut *db)
        .await?;
    let value = json!({"id":mapping_id,"profile_id":profile_id,"revision":row.get::<i64,_>(0),"source_label":label,"category_id":body["category_id"],"account_id":body["account_id"],"subcategory":body["subcategory"],"event_kind":body["event_kind"]});
    storage::audit(
        db,
        p,
        mapping_id,
        "source_mapping_updated",
        None,
        Some(&value),
    )
    .await?;
    Ok((StatusCode::OK, value))
}

fn row_ref(row: &Value) -> Value {
    json!({"file_id":row["raw_row_ref"]["file_id"],"row_number":row["raw_row_ref"]["row_number"],"source_account":row["source_account"],"source_category":row["source_category"],"source_subcategory":row["source_subcategory"]})
}
async fn money_manager_cleanup(
    db: &mut SqliteConnection,
    p: &Principal,
    body: &Value,
    apply: bool,
) -> Result<Reply> {
    let period = text(body, "period")?;
    let (from, to) = if period.len() == 7 {
        crate::api::month_bounds(period)?
    } else if period.len() == 4 && period.bytes().all(|b| b.is_ascii_digit()) {
        let year: i32 = period
            .parse()
            .map_err(|_| ApiError::invalid("Invalid year."))?;
        let from = format!("{year:04}-01-01");
        let to = format!("{:04}-01-01", year + 1);
        domain::date(&from)?;
        domain::date(&to)?;
        (from, to)
    } else {
        return Err(ApiError::invalid("period must be YYYY-MM or YYYY."));
    };
    let files: HashSet<String> = sqlx::query_scalar("SELECT id FROM source_files WHERE household_id=? AND owner_id=? AND source_kind='money_manager'")
        .bind(&p.household_id).bind(&p.user_id).fetch_all(&mut *db).await?.into_iter().collect();
    let mut candidates = Vec::new();
    let mut skipped_mixed_sources = 0;
    for transaction in storage::list(db, p, "transactions").await? {
        let date = text(&transaction, "effective_date")?;
        if transaction["owner_id"] != p.user_id
            || transaction["voided"] == true
            || date < from.as_str()
            || date >= to.as_str()
        {
            continue;
        }
        let refs = transaction["source_refs"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("Invalid transaction sources."))?;
        let own = refs.iter().any(|source| {
            source["file_id"]
                .as_str()
                .is_some_and(|id| files.contains(id))
        });
        if !own {
            continue;
        }
        if refs.iter().any(|source| {
            !source["file_id"]
                .as_str()
                .is_some_and(|id| files.contains(id))
        }) {
            skipped_mixed_sources += 1;
            continue;
        }
        candidates.push(transaction);
    }
    if candidates.len() > 5000 {
        return Err(ApiError::invalid(
            "More than 5000 imported transactions match; choose a smaller period.",
        ));
    }
    candidates.sort_by(|a, b| {
        (a["effective_date"].as_str(), a["id"].as_str())
            .cmp(&(b["effective_date"].as_str(), b["id"].as_str()))
    });
    let identity: Vec<Value> = candidates
        .iter()
        .map(|v| json!([v["id"], v["revision"]]))
        .collect();
    let token = auth::hash(
        &json!([
            p.household_id,
            p.user_id,
            period,
            identity,
            skipped_mixed_sources
        ])
        .to_string(),
    );
    if apply {
        if body["preview_token"] != token {
            return Err(ApiError::conflict(
                "Import cleanup preview changed. Preview again before removing entries.",
            ));
        }
        for before in &candidates {
            let id = text(before, "id")?;
            crate::reconciliation::invalidate(db, p, id).await?;
            let mut after = before.clone();
            after["voided"] = json!(true);
            after["void_reason"] = json!(format!("Money Manager {period} reimport reset"));
            after["reconciliation_state"] = json!("unmatched");
            storage::update(db, p, before, after, "money_manager_import_reset").await?;
            sqlx::query("DELETE FROM import_occurrences WHERE household_id=? AND transaction_id=?")
                .bind(&p.household_id)
                .bind(id)
                .execute(&mut *db)
                .await?;
        }
        storage::audit(db,p,&p.user_id,"money_manager_period_reset",None,Some(&json!({"period":period,"removed":candidates.len(),"skipped_mixed_sources":skipped_mixed_sources}))).await?;
        Ok((
            StatusCode::OK,
            json!({"period":period,"removed":candidates.len(),"skipped_mixed_sources":skipped_mixed_sources}),
        ))
    } else {
        let rows: Vec<Value> = candidates.iter().map(|v| json!({"id":v["id"],"effective_date":v["effective_date"],"description":v["description"],"event_type":v["event_type"],"amount":v["amount"],"currency":v["currency"]})).collect();
        Ok((
            StatusCode::OK,
            json!({"period":period,"count":rows.len(),"skipped_mixed_sources":skipped_mixed_sources,"transactions":rows,"preview_token":token}),
        ))
    }
}
async fn occurrence(
    db: &mut SqliteConnection,
    p: &Principal,
    row: &Value,
) -> Result<Option<Option<String>>> {
    let existing=sqlx::query("SELECT transaction_id FROM import_occurrences WHERE household_id=? AND account_id=? AND fingerprint=? AND occurrence=?")
        .bind(&p.household_id).bind(text(row,"account_id")?).bind(text(row,"fingerprint")?).bind(row["occurrence"].as_i64().unwrap_or(1)).fetch_optional(db).await?;
    Ok(existing.map(|r| r.get(0)))
}
async fn record_occurrence(
    db: &mut SqliteConnection,
    p: &Principal,
    row: &Value,
    transaction_id: Option<&str>,
) -> Result<bool> {
    let account = text(row, "account_id")?;
    let fp = text(row, "fingerprint")?;
    let ordinal = row["occurrence"]
        .as_i64()
        .ok_or_else(|| ApiError::invalid("Invalid row occurrence."))?;
    let source = row_ref(row);
    let existing=sqlx::query("SELECT id,transaction_id,source_refs_json FROM import_occurrences WHERE household_id=? AND account_id=? AND fingerprint=? AND occurrence=?")
        .bind(&p.household_id).bind(account).bind(fp).bind(ordinal).fetch_optional(&mut *db).await?;
    if let Some(existing) = existing {
        let old_id: Option<String> = existing.get(1);
        if old_id.as_deref() != transaction_id {
            return Err(ApiError::conflict(
                "A source occurrence is linked to another ledger action.",
            ));
        }
        let mut refs: Vec<Value> = serde_json::from_str(existing.get::<&str, _>(2))
            .map_err(|_| ApiError::invalid("Invalid source references."))?;
        if !refs.contains(&source) {
            if let Some(transaction_id) = transaction_id {
                storage::audit(db, p, transaction_id, "source_linked", None, Some(&source)).await?;
            }
            refs.push(source);
            sqlx::query("UPDATE import_occurrences SET source_refs_json=? WHERE id=?")
                .bind(json!(refs).to_string())
                .bind(existing.get::<&str, _>(0))
                .execute(db)
                .await?;
        }
        Ok(false)
    } else {
        sqlx::query("INSERT INTO import_occurrences(id,household_id,account_id,fingerprint,occurrence,transaction_id,source_refs_json) VALUES(?,?,?,?,?,?,?)")
            .bind(storage::id()).bind(&p.household_id).bind(account).bind(fp).bind(ordinal).bind(transaction_id).bind(json!([source]).to_string()).execute(db).await?;
        Ok(true)
    }
}
fn selected(row: &Value, body: &Value) -> bool {
    let file = row["raw_row_ref"]["file_id"].as_str().unwrap_or_default();
    body["row_numbers"][file]
        .as_array()
        .is_none_or(|rows| rows.iter().any(|n| n == &row["raw_row_ref"]["row_number"]))
}
fn compatible(out: &Value, input: &Value) -> bool {
    if out["event_type"] != "transfer_out"
        || input["event_type"] != "transfer_in"
        || out["account_id"] != input["counterpart_account_id"]
        || out["counterpart_account_id"] != input["account_id"]
        || out["amount"] != input["amount"]
        || out["currency"] != input["currency"]
        || out["issues"].as_array().is_none_or(|a| !a.is_empty())
        || input["issues"].as_array().is_none_or(|a| !a.is_empty())
    {
        return false;
    }
    let a = out["effective_date"]
        .as_str()
        .and_then(|s| domain::date(s).ok());
    let b = input["effective_date"]
        .as_str()
        .and_then(|s| domain::date(s).ok());
    a.zip(b).is_some_and(|(a, b)| (a - b).num_days().abs() <= 3)
}
async fn commit(
    db: &mut SqliteConnection,
    p: &Principal,
    batch_id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    crate::api::allowed_body(body, &["files", "row_numbers", "accept_as_new"])?;
    let before = batch(db, p, batch_id).await?;
    expect_revision(headers, body, before["revision"].as_i64().unwrap_or(1))?;
    let ids: Vec<String> = if let Some(array) = body["files"].as_array() {
        array
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| ApiError::invalid("files must contain IDs."))
            })
            .collect::<Result<_>>()?
    } else {
        before["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                ["ready", "needs_review", "needs_mapping"]
                    .contains(&f["state"].as_str().unwrap_or(""))
            })
            .filter_map(|f| f["id"].as_str().map(str::to_owned))
            .collect()
    };
    if ids.is_empty() {
        return Err(ApiError::invalid("No selected files are ready to commit."));
    }
    let mut unique = HashSet::new();
    if ids.iter().any(|id| !unique.insert(id)) {
        return Err(ApiError::invalid("Duplicate file selection."));
    }
    let mut files = vec![];
    let mut rows = vec![];
    for id in &ids {
        let value = file(db, p, batch_id, id).await?;
        if !["ready", "needs_review", "needs_mapping"].contains(&text(&value, "state")?) {
            return Err(ApiError::conflict("Selected file is not reviewable."));
        }
        let prepared = prepared(db, p, &value).await?;
        for row in prepared {
            if selected(&row, body) {
                rows.push(row);
            }
        }
        files.push(value);
    }
    if rows.is_empty() {
        return Err(ApiError::invalid("No selected rows to commit."));
    }
    let mut pairs: HashMap<String, String> = HashMap::new();
    for out in rows.iter().filter(|r| r["event_type"] == "transfer_out") {
        let possible = rows
            .iter()
            .filter(|input| compatible(out, input))
            .collect::<Vec<_>>();
        if possible.len() != 1 {
            continue;
        }
        let input = possible[0];
        let reverse = rows.iter().filter(|other| compatible(other, input)).count();
        if reverse == 1 {
            pairs.insert(text(out, "item_id")?.into(), text(input, "item_id")?.into());
        }
    }
    let mut processed = HashSet::new();
    let mut counts =
        json!({"created":0,"reused":0,"observations":0,"paired_transfers":0,"pending_review":0});
    let mut file_counts: HashMap<String, (usize, usize)> = HashMap::new();
    for row in &rows {
        let file_id = text(&row["raw_row_ref"], "file_id")?.to_owned();
        file_counts.entry(file_id.clone()).or_default().0 += 1;
        if !processed.insert(text(row, "item_id")?.to_owned()) {
            continue;
        }
        let issues = row["issues"].as_array().cloned().unwrap_or_default();
        let accepted = body["accept_as_new"]
            .as_array()
            .is_some_and(|items| items.iter().any(|id| id == &row["item_id"]));
        if !(issues.is_empty()
            || accepted && issues.iter().all(|code| code == "possible_existing_event"))
        {
            counts["pending_review"] = json!(counts["pending_review"].as_i64().unwrap() + 1);
            continue;
        }
        let kind = text(row, "event_type")?;
        if kind == "transfer_in" {
            continue;
        }
        if kind == "transfer_out" {
            let Some(pair_id) = pairs.get(text(row, "item_id")?) else {
                counts["pending_review"] = json!(counts["pending_review"].as_i64().unwrap() + 1);
                continue;
            };
            let input = rows
                .iter()
                .find(|r| r["item_id"] == pair_id.as_str())
                .ok_or_else(|| ApiError::invalid("Missing transfer counterpart."))?;
            processed.insert(pair_id.clone());
            let counterpart_file = text(&input["raw_row_ref"], "file_id")?.to_owned();
            file_counts.entry(counterpart_file).or_default().1 += 1;
            let existing_out = occurrence(db, p, row).await?;
            let existing_in = occurrence(db, p, input).await?;
            let reused_pair =
                matches!((&existing_out,&existing_in),(Some(Some(a)),Some(Some(b))) if a==b);
            let transaction_id = match (existing_out, existing_in) {
                (Some(Some(a)), Some(Some(b))) if a == b => a,
                (None, None) => {
                    let value = json!({"event_type":"transfer","amount":row["amount"],"currency":row["currency"],"effective_date":row["effective_date"],"description":row["description"],"movements":[{"account_id":row["account_id"],"amount":row["signed_movement"]},{"account_id":input["account_id"],"amount":input["signed_movement"]}],"allocations":[],"voided":false,"entered_by":p.user_id,"source_refs":[row_ref(row),row_ref(input)],"reconciliation_state":"unmatched"});
                    domain::validate_transaction(&value)?;
                    let created = storage::create(db, p, "transactions", value).await?;
                    counts["paired_transfers"] =
                        json!(counts["paired_transfers"].as_i64().unwrap() + 1);
                    text(&created, "id")?.into()
                }
                _ => {
                    return Err(ApiError::conflict(
                        "Overlapping transfer evidence needs explicit review.",
                    ));
                }
            };
            record_occurrence(db, p, row, Some(&transaction_id)).await?;
            record_occurrence(db, p, input, Some(&transaction_id)).await?;
            if reused_pair {
                counts["reused"] = json!(counts["reused"].as_i64().unwrap() + 1);
            }
            file_counts.entry(file_id.clone()).or_default().1 += 1;
            continue;
        }
        if kind == "observation" {
            let inserted = record_occurrence(db, p, row, None).await?;
            crate::reconciliation::store_observation(db, p, row).await?;
            counts[if inserted { "observations" } else { "reused" }] = json!(
                counts[if inserted { "observations" } else { "reused" }]
                    .as_i64()
                    .unwrap()
                    + 1
            );
            file_counts.entry(file_id.clone()).or_default().1 += 1;
            continue;
        }
        if !["expense", "income"].contains(&kind) {
            counts["pending_review"] = json!(counts["pending_review"].as_i64().unwrap() + 1);
            continue;
        }
        if let Some(Some(existing_id)) = occurrence(db, p, row).await? {
            record_occurrence(db, p, row, Some(&existing_id)).await?;
            counts["reused"] = json!(counts["reused"].as_i64().unwrap() + 1);
            file_counts.entry(file_id.clone()).or_default().1 += 1;
            continue;
        }
        let scope = files
            .iter()
            .find(|f| f["id"] == file_id)
            .and_then(|f| f["mapping"]["allocation_scope"].as_str())
            .unwrap_or("personal");
        if !["personal", "family"].contains(&scope) {
            return Err(ApiError::invalid("Invalid allocation scope."));
        }
        let value = json!({"event_type":kind,"amount":row["amount"],"currency":row["currency"],"effective_date":row["effective_date"],"description":row["description"],"movements":[{"account_id":row["account_id"],"amount":row["signed_movement"]}],"allocations":[{"category_id":row["category_id"],"amount":row["amount"],"scope":scope}],"voided":false,"entered_by":p.user_id,"source_refs":[row_ref(row)],"reconciliation_state":"unmatched"});
        domain::validate_transaction(&value)?;
        let created = storage::create(db, p, "transactions", value).await?;
        record_occurrence(db, p, row, Some(text(&created, "id")?)).await?;
        counts["created"] = json!(counts["created"].as_i64().unwrap() + 1);
        file_counts.entry(file_id.clone()).or_default().1 += 1;
    }
    let mut outcomes = vec![];
    for f in files {
        let id = text(&f, "id")?;
        let (selected_count, committed_count) = file_counts.get(id).copied().unwrap_or_default();
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM import_rows WHERE file_id=?")
            .bind(id)
            .fetch_one(&mut *db)
            .await?;
        let state = if selected_count > 0 && committed_count == total as usize {
            "committed"
        } else {
            "needs_review"
        };
        sqlx::query("UPDATE source_files SET state=?,revision=revision+1 WHERE id=?")
            .bind(state)
            .bind(id)
            .execute(&mut *db)
            .await?;
        outcomes.push(json!({"file_id":id,"state":state,"selected":selected_count,"committed":committed_count,"pending":selected_count.saturating_sub(committed_count)}));
    }
    update_batch(db, batch_id).await?;
    let result = json!({"batch_id":batch_id,"revision":before["revision"].as_i64().unwrap()+1,"outcomes":outcomes,"counts":counts,"coverage":"unknown"});
    storage::audit(
        db,
        p,
        batch_id,
        "import_commit",
        Some(&json!({"revision":before["revision"]})),
        Some(&result),
    )
    .await?;
    Ok((StatusCode::OK, result))
}

pub async fn route(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    path: &str,
    q: &HashMap<String, String>,
    headers: &HeaderMap,
    body: &Value,
) -> Option<Result<Reply>> {
    let parts = path.split('/').collect::<Vec<_>>();
    let result = match (method, parts.as_slice()) {
        ("POST", ["imports", "money-manager", "cleanup-preview"]) => {
            money_manager_cleanup(db, p, body, false).await
        }
        ("POST", ["imports", "money-manager", "cleanup"]) => {
            money_manager_cleanup(db, p, body, true).await
        }
        ("GET", ["imports"]) => list_batches(db, p, q).await,
        ("GET", ["imports", id]) => batch(db, p, id).await.map(|v| (StatusCode::OK, v)),
        ("GET", ["imports", id, "files", file_id]) => {
            file(db, p, id, file_id).await.map(|v| (StatusCode::OK, v))
        }
        ("PATCH", ["imports", id, "files", file_id, "mapping"]) => {
            update_mapping(db, p, id, file_id, headers, body).await
        }
        ("GET", ["imports", id, "preview"]) => preview(db, p, id, q).await,
        ("POST", ["imports", id, "commit"]) => commit(db, p, id, headers, body).await,
        ("POST", ["imports", id, "files", file_id, "retry"]) => {
            mark_file(db, p, id, file_id, headers, body, "retry").await
        }
        ("POST", ["imports", id, "files", file_id, "omit"]) => {
            mark_file(db, p, id, file_id, headers, body, "omit").await
        }
        ("POST", ["imports", id, "cancel"]) => cancel(db, p, id, headers, body).await,
        ("GET", ["jobs", id]) => job(db, p, id).await.map(|v| (StatusCode::OK, v)),
        ("GET", ["source-profiles"]) => source_profiles(db, p).await,
        ("GET", ["source-profiles", id, "category-mappings"]) => profile_mappings(db, p, id).await,
        ("PUT", ["source-profiles", id, "category-mappings", mapping_id]) => {
            put_mapping(db, p, id, mapping_id, headers, body, "category").await
        }
        ("PUT", ["source-profiles", id, "account-aliases", mapping_id]) => {
            put_mapping(db, p, id, mapping_id, headers, body, "account").await
        }
        ("GET", ["transfers", "review-queue"]) => review_queue(db, p, q).await,
        ("POST", ["transfers", "review-queue", item, "pair"]) => {
            review_pair(db, p, item, headers, body).await
        }
        ("POST", ["transfers", "review-queue", item, "reject"]) => {
            review_reject(db, p, item, headers, body).await
        }
        _ => return None,
    };
    Some(result)
}
async fn review_queue(
    db: &mut SqliteConnection,
    p: &Principal,
    q: &HashMap<String, String>,
) -> Result<Reply> {
    let files=sqlx::query("SELECT id,batch_id FROM source_files WHERE household_id=? AND owner_id=? AND source_kind='money_manager' AND state IN ('needs_review','ready','committed') ORDER BY id")
        .bind(&p.household_id).bind(&p.user_id).fetch_all(&mut *db).await?;
    let mut data = vec![];
    for row in files {
        let file = file(db, p, row.get(1), row.get(0)).await?;
        for candidate in prepared(db, p, &file).await? {
            if !candidate["event_type"]
                .as_str()
                .unwrap_or("")
                .starts_with("transfer")
            {
                continue;
            }
            if candidate["account_id"].as_str().is_some()
                && occurrence(db, p, &candidate).await?.is_some()
            {
                continue;
            }
            data.push(candidate);
        }
    }
    data.sort_by(|a, b| a["item_id"].as_str().cmp(&b["item_id"].as_str()));
    let limit = bound(q)?;
    let after = q.get("cursor").map(String::as_str).unwrap_or("");
    let mut slice = data
        .into_iter()
        .filter(|v| v["item_id"].as_str().unwrap_or("") > after)
        .take(limit + 1)
        .collect::<Vec<_>>();
    let more = slice.len() > limit;
    slice.truncate(limit);
    let next = if more {
        slice
            .last()
            .and_then(|v| v["item_id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok((StatusCode::OK, collection(slice, next)))
}
async fn review_item(db: &mut SqliteConnection, p: &Principal, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT f.id,f.batch_id FROM import_rows r JOIN source_files f ON f.id=r.file_id WHERE json_extract(r.normalized_json,'$.item_id')=? AND f.household_id=? AND f.owner_id=?")
        .bind(id).bind(&p.household_id).bind(&p.user_id).fetch_optional(&mut *db).await?.ok_or_else(ApiError::missing)?;
    let file = file(db, p, row.get(1), row.get(0)).await?;
    prepared(db, p, &file)
        .await?
        .into_iter()
        .find(|v| v["item_id"] == id)
        .ok_or_else(ApiError::missing)
}
async fn review_pair(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    let a = review_item(db, p, id).await?;
    expect_revision(headers, body, a["revision"].as_i64().unwrap_or(1))?;
    let b = review_item(db, p, text(body, "counterpart_item_id")?).await?;
    let (out, input) = if a["event_type"] == "transfer_out" {
        (&a, &b)
    } else {
        (&b, &a)
    };
    if !compatible(out, input) {
        return Err(ApiError::invalid(
            "Transfer rows do not conserve value or have reciprocal accounts within three days.",
        ));
    }
    let prior_out = occurrence(db, p, out).await?;
    let prior_in = occurrence(db, p, input).await?;
    if prior_out.is_some() || prior_in.is_some() {
        return Err(ApiError::conflict(
            "Transfer evidence was already consumed.",
        ));
    }
    let value = json!({"event_type":"transfer","amount":out["amount"],"currency":out["currency"],"effective_date":out["effective_date"],"description":out["description"],"movements":[{"account_id":out["account_id"],"amount":out["signed_movement"]},{"account_id":input["account_id"],"amount":input["signed_movement"]}],"allocations":[],"voided":false,"entered_by":p.user_id,"source_refs":[row_ref(out),row_ref(input)],"reconciliation_state":"unmatched"});
    domain::validate_transaction(&value)?;
    let created = storage::create(db, p, "transactions", value).await?;
    let transaction_id = text(&created, "id")?;
    record_occurrence(db, p, out, Some(transaction_id)).await?;
    record_occurrence(db, p, input, Some(transaction_id)).await?;
    for row in [out, input] {
        sqlx::query("INSERT INTO transfer_review_decisions(item_id,decision,actor_id,created_at) VALUES(?,'paired',?,?) ON CONFLICT(item_id) DO UPDATE SET decision='paired'")
        .bind(text(row,"item_id")?).bind(&p.user_id).bind(storage::now()).execute(&mut *db).await?;
    }
    let mut file_ids = std::collections::HashSet::new();
    for file_id in [
        text(&a["raw_row_ref"], "file_id")?,
        text(&b["raw_row_ref"], "file_id")?,
    ] {
        if file_ids.insert(file_id) {
            recompute_commit_state(db, p, file_id).await?;
        }
    }
    Ok((StatusCode::OK, created))
}
async fn recompute_commit_state(
    db: &mut SqliteConnection,
    p: &Principal,
    file_id: &str,
) -> Result<()> {
    let batch_id: String = sqlx::query_scalar(
        "SELECT batch_id FROM source_files WHERE id=? AND household_id=? AND owner_id=?",
    )
    .bind(file_id)
    .bind(&p.household_id)
    .bind(&p.user_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(ApiError::missing)?;
    let source = file(db, p, &batch_id, file_id).await?;
    let rows = prepared(db, p, &source).await?;
    let mut all_committed = !rows.is_empty();
    for row in &rows {
        if occurrence(db, p, row).await?.is_none() {
            all_committed = false;
            break;
        }
    }
    if all_committed {
        sqlx::query("UPDATE source_files SET state='committed',revision=revision+1 WHERE id=?")
            .bind(file_id)
            .execute(&mut *db)
            .await?;
        update_batch(db, &batch_id).await?;
    }
    Ok(())
}

async fn review_reject(
    db: &mut SqliteConnection,
    p: &Principal,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    let row = review_item(db, p, id).await?;
    expect_revision(headers, body, row["revision"].as_i64().unwrap_or(1))?;
    text(body, "reason")?;
    if occurrence(db, p, &row).await?.is_some() {
        return Err(ApiError::conflict(
            "Transfer evidence was already consumed.",
        ));
    }
    sqlx::query("INSERT INTO transfer_review_decisions(item_id,decision,reason,actor_id,created_at) VALUES(?,'rejected',?,?,?) ON CONFLICT(item_id) DO UPDATE SET decision='rejected',reason=excluded.reason,actor_id=excluded.actor_id,created_at=excluded.created_at")
        .bind(id).bind(text(body,"reason")?).bind(&p.user_id).bind(storage::now()).execute(&mut *db).await?;
    let value = json!({"item_id":id,"decision":"rejected","reason":body["reason"],"available_for_review":true});
    storage::audit(db, p, id, "transfer_pair_rejected", None, Some(&value)).await?;
    Ok((StatusCode::OK, value))
}

fn request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .map(str::to_owned)
        .unwrap_or_else(storage::id)
}
fn response_error(error: ApiError, id: &str) -> Response {
    let mut response = (error.status, Json(error.body(id))).into_response();
    response
        .headers_mut()
        .insert("x-request-id", id.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/json; charset=utf-8".parse().unwrap(),
    );
    response
}
pub async fn download(state: AppState, request: Request) -> Response {
    let id = request_id(request.headers());
    let headers = request.headers().clone();
    let file_id = request
        .uri()
        .path()
        .trim_end_matches("/download")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    drop(request);
    let result=async {
        let mut tx=state.pool.begin().await?;
        let p=auth::principal(&mut tx,&headers).await?;
        let row=sqlx::query("SELECT owner_id,account_id,bytes,filename FROM source_files WHERE id=? AND household_id=?").bind(&file_id).bind(&p.household_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
        let owner:String=row.get(0);let account:Option<String>=row.get(1);
        if owner!=p.user_id {
            let Some(account)=account else{return Err(ApiError::missing());};
            storage::get(&mut tx,&p,"accounts",&account).await?;
        }
        let bytes:Vec<u8>=row.get(2);let filename:String=row.get(3);
        storage::audit(&mut tx,&p,&file_id,"source_downloaded",None,None).await?;tx.commit().await?;
        Ok::<_,ApiError>((bytes,filename))
    }.await;
    match result {
        Ok((bytes, filename)) => {
            let disposition = format!(
                "attachment; filename=\"{}\"",
                safe_filename(&filename).replace('"', "_")
            );
            let mut response = (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CACHE_CONTROL, "no-store"),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                ],
                Body::from(bytes),
            )
                .into_response();
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, disposition.parse().unwrap());
            response
                .headers_mut()
                .insert("x-request-id", id.parse().unwrap());
            response
        }
        Err(error) => response_error(error, &id),
    }
}
pub async fn events(state: AppState, request: Request) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio_stream::wrappers::ReceiverStream;
    let id = request_id(request.headers());
    let headers = request.headers().clone();
    let job_id = request
        .uri()
        .path()
        .trim_end_matches("/events")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    drop(request);
    let first = async {
        let mut db = state.pool.acquire().await?;
        let p = auth::principal(&mut db, &headers).await?;
        job(&mut db, &p, &job_id).await
    }
    .await;
    if let Err(error) = first {
        return response_error(error, &id);
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    let pool = state.pool.clone();
    tokio::spawn(async move {
        let mut last_revision = -1_i64;
        for _ in 0..240 {
            let value = async {
                let mut db = pool.acquire().await?;
                let p = auth::principal(&mut db, &headers).await?;
                job(&mut db, &p, &job_id).await
            }
            .await;
            let Ok(value) = value else {
                break;
            };
            let revision = value["revision"].as_i64().unwrap_or(0);
            if revision != last_revision {
                last_revision = revision;
                let data = json!({"id":value["id"],"state":value["state"],"progress":value["progress"],"error_code":value["error_code"]});
                if sender
                    .send(Ok::<Event, std::convert::Infallible>(
                        Event::default().event("progress").data(data.to_string()),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if ["completed", "failed", "cancelled"].contains(&value["state"].as_str().unwrap_or(""))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
    let mut response = Sse::new(ReceiverStream::new(receiver))
        .keep_alive(KeepAlive::default())
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-request-id", id.parse().unwrap());
    response
}

pub fn retry_after_commit(pool: SqlitePool, id: String) {
    spawn_parse(pool, id);
}

pub async fn download_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request,
) -> Response {
    download(state, request).await
}
pub async fn events_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request,
) -> Response {
    events(state, request).await
}

// Upgrade committed bank evidence written before immutable observation snapshots existed.
// Recover only a row whose fingerprint still agrees with its committed occurrence.
async fn recover_observations(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let rows = sqlx::query("SELECT o.id,o.household_id,o.account_id,o.fingerprint,o.occurrence,f.owner_id,f.filename,f.mapping_json,r.raw_json,j.value FROM import_occurrences o JOIN json_each(o.source_refs_json) j JOIN source_files f ON f.id=json_extract(j.value,'$.file_id') JOIN import_rows r ON r.file_id=f.id AND r.row_number=json_extract(j.value,'$.row_number') WHERE f.source_kind='bank_statement' AND NOT EXISTS(SELECT 1 FROM bank_observations b WHERE b.id=o.id) ORDER BY o.id")
        .fetch_all(&mut *tx).await?;
    let mut recovered: HashMap<String, String> = HashMap::new();
    for row in rows {
        let id: String = row.get(0);
        let p = worker_p(row.get(5), row.get(1));
        let file = json!({"filename":row.get::<&str,_>(6),"source_kind":"bank_statement","mapping":serde_json::from_str::<Value>(row.get(7)).map_err(|_|ApiError::invalid("Invalid legacy mapping."))?});
        let raw: Value = serde_json::from_str(row.get(8))
            .map_err(|_| ApiError::invalid("Invalid legacy source row."))?;
        let mut value = normalize_again(&raw, &file)?;
        let fingerprint = import_parse::fingerprint(&value);
        if let Some(previous) = recovered.get(&id) {
            if previous != &fingerprint {
                return Err(ApiError::conflict(
                    "Legacy bank occurrence contains conflicting source rows; review the original evidence before upgrading.",
                ));
            }
            continue;
        }
        recovered.insert(id.clone(), fingerprint.clone());
        let old: &str = row.get(3);
        if old != fingerprint && old != import_parse::legacy_fingerprint(&value) {
            return Err(ApiError::conflict(
                "Legacy bank evidence mapping changed after commit; restore its original mapping before upgrading.",
            ));
        }
        let source: Value = serde_json::from_str(row.get(9))
            .map_err(|_| ApiError::invalid("Invalid legacy source reference."))?;
        // Splitting a legacy unsigned fingerprint also resets its multiplicity ordinal.
        let preceding: Vec<String> = sqlx::query_scalar("SELECT raw_json FROM import_rows WHERE file_id=? AND row_number<=? ORDER BY row_number")
            .bind(text(&source,"file_id")?).bind(source["row_number"].as_i64()).fetch_all(&mut *tx).await?;
        let mut ordinal = 0i64;
        for raw in preceding {
            let raw: Value = serde_json::from_str(&raw)
                .map_err(|_| ApiError::invalid("Invalid legacy source row."))?;
            if import_parse::fingerprint(&normalize_again(&raw, &file)?) == fingerprint {
                ordinal += 1;
            }
        }
        if ordinal == 0 {
            return Err(ApiError::invalid("Missing legacy source occurrence."));
        }
        sqlx::query("UPDATE import_occurrences SET fingerprint=?,occurrence=? WHERE id=?")
            .bind(&fingerprint)
            .bind(ordinal)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        value["fingerprint"] = json!(fingerprint);
        value["occurrence"] = json!(ordinal);
        value["account_id"] = json!(row.get::<&str, _>(2));
        value["raw_row_ref"] = source;
        crate::reconciliation::store_observation(&mut tx, &p, &value).await?;
    }
    tx.commit().await?;
    Ok(())
}

// Repair only untouched imported ledger entries whose original Description cell
// was blank and whose Note cell supplied a meaningful display description.
// This runs in one transaction on startup and records normal audit revisions.
async fn recover_descriptions(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let rows=sqlx::query("SELECT DISTINCT r.document,r.household_id,r.owner_id FROM resources r JOIN json_each(r.document,'$.source_refs') s JOIN import_rows ir ON ir.file_id=json_extract(s.value,'$.file_id') AND ir.row_number=json_extract(s.value,'$.row_number') JOIN source_files f ON f.id=ir.file_id WHERE r.kind='transactions' AND r.revision=1 AND json_extract(r.document,'$.description')='' AND f.source_kind='money_manager'")
        .fetch_all(&mut *tx).await?;
    for row in rows {
        let before: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid imported transaction."))?;
        let sources = before["source_refs"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("Invalid source references."))?;
        for source in sources {
            let raw: Option<String>=sqlx::query_scalar("SELECT ir.raw_json FROM import_rows ir JOIN source_files f ON f.id=ir.file_id WHERE ir.file_id=? AND ir.row_number=? AND f.source_kind='money_manager'")
                .bind(text(source,"file_id")?).bind(source["row_number"].as_i64()).fetch_optional(&mut *tx).await?;
            let Some(raw) = raw else { continue };
            let raw: Value = serde_json::from_str(&raw)
                .map_err(|_| ApiError::invalid("Invalid saved source row."))?;
            let columns = raw["columns"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Invalid saved source columns."))?;
            let cell = |heading: &str| {
                columns
                    .iter()
                    .find(|c| {
                        c["header"]
                            .as_str()
                            .is_some_and(|v| v.trim().eq_ignore_ascii_case(heading))
                    })
                    .and_then(|c| c["value"].as_str())
                    .unwrap_or("")
                    .trim()
            };
            if cell("Description").is_empty() && !cell("Note").is_empty() {
                let mut after = before.clone();
                after["description"] = json!(cell("Note"));
                let p = worker_p(row.get(2), row.get(1));
                storage::update(&mut tx, &p, &before, after, "source_description_repaired").await?;
                break;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}
