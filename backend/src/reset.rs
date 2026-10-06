//! Month-scoped resets run atomically inside the API transaction.
use crate::{
    api,
    auth::{self, Principal},
    balances,
    domain::text,
    error::{ApiError, Result},
    storage,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeSet, HashSet};

pub async fn run(
    db: &mut SqliteConnection,
    p: &Principal,
    body: &Value,
    apply: bool,
) -> Result<Value> {
    auth::admin(p)?;
    api::allowed_body(body, &["months", "preview_token", "confirmation"])?;
    let input = body["months"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 24)
        .ok_or_else(|| ApiError::invalid("Select between 1 and 24 months."))?;
    let mut months = BTreeSet::new();
    for value in input {
        let month = value
            .as_str()
            .ok_or_else(|| ApiError::invalid("Months must use YYYY-MM."))?;
        if month.len() != 7
            || !month.bytes().enumerate().all(|(i, b)| {
                if i == 4 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
        {
            return Err(ApiError::invalid("Months must use YYYY-MM."));
        }
        api::month_bounds(month)?;
        months.insert(month.to_owned());
    }
    let selected = |date: &str| date.get(..7).is_some_and(|month| months.contains(month));
    let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM import_jobs WHERE household_id=? AND state IN ('queued','running','parsing')")
        .bind(&p.household_id).fetch_one(&mut *db).await?;
    if busy > 0 {
        return Err(ApiError::conflict(
            "Wait for imports to finish before resetting data.",
        ));
    }

    let accounts = storage::list(db, p, "accounts").await?;
    let account_ids: HashSet<&str> = accounts.iter().filter_map(|a| a["id"].as_str()).collect();
    let mut targets: Vec<(String, Value)> = Vec::new();
    let mut counts = json!({"transactions":0,"statement_entries":0,"reconciliation_sessions":0,"balance_checks":0,"budgets":0,"import_rows":0});
    for kind in [
        "transactions",
        "balance_checks",
        "budgets",
        "reconciliation_sessions",
    ] {
        for value in storage::list(db, p, kind).await? {
            let matches = match kind {
                "transactions" => {
                    value["voided"] != true && selected(text(&value, "effective_date")?)
                }
                "balance_checks" => {
                    let account = accounts
                        .iter()
                        .find(|a| a["id"] == value["account_id"])
                        .ok_or_else(ApiError::missing)?;
                    let tz = balances::timezone(db, p, account).await?;
                    value["voided"] != true
                        && selected(
                            &balances::timestamp(text(&value, "as_of")?)?
                                .with_timezone(&tz)
                                .format("%Y-%m-%d")
                                .to_string(),
                        )
                }
                _ => selected(text(&value, "month")?),
            };
            if !matches {
                continue;
            }
            if kind == "reconciliation_sessions" && value["state"] == "closed" {
                return Err(ApiError::conflict(
                    "Reopen closed reconciliation sessions in the selected months before resetting data.",
                ));
            }
            counts[kind] = json!(counts[kind].as_u64().unwrap() + 1);
            targets.push((kind.to_owned(), value));
        }
    }
    let session_ids: HashSet<String> = targets
        .iter()
        .filter(|(kind, _)| kind == "reconciliation_sessions")
        .filter_map(|(_, v)| v["id"].as_str().map(str::to_owned))
        .collect();
    for kind in [
        "reconciliation_matches",
        "reconciliation_amendments",
        "reconciliation_ignores",
    ] {
        for value in storage::list(db, p, kind).await? {
            if value["session_id"]
                .as_str()
                .is_some_and(|id| session_ids.contains(id))
            {
                targets.push((kind.to_owned(), value));
            }
        }
    }
    let mut observations = Vec::new();
    for row in
        sqlx::query("SELECT document FROM bank_observations WHERE household_id=? ORDER BY id")
            .bind(&p.household_id)
            .fetch_all(&mut *db)
            .await?
    {
        let value: Value = serde_json::from_str(row.get(0))
            .map_err(|_| ApiError::invalid("Invalid statement entry."))?;
        if selected(text(&value, "effective_date")?)
            && account_ids.contains(text(&value, "account_id")?)
        {
            observations.push(value);
        }
    }
    counts["statement_entries"] = json!(observations.len());
    let mut rows = Vec::new();
    for row in sqlx::query("SELECT r.file_id,r.row_number,r.normalized_json,r.raw_json,f.owner_id FROM import_rows r JOIN source_files f ON f.id=r.file_id WHERE f.household_id=? ORDER BY r.file_id,r.row_number")
        .bind(&p.household_id).fetch_all(&mut *db).await? {
        let value: Value = serde_json::from_str(row.get(2)).map_err(|_| ApiError::invalid("Invalid import row."))?;
        if value["effective_date"].as_str().is_some_and(selected)
            && value["account_id"].as_str().map_or(row.get::<&str,_>(4) == p.user_id, |id| account_ids.contains(id)) {
            rows.push(json!({"file_id":row.get::<String,_>(0),"row_number":row.get::<i64,_>(1),"normalized":value,"raw":row.get::<String,_>(3)}));
        }
    }
    counts["import_rows"] = json!(rows.len());
    if targets.len() + observations.len() + rows.len() > 50000 {
        return Err(ApiError::invalid("Too many records. Select fewer months."));
    }
    // Include related link state and permissions so stale confirmations cannot delete new work.
    let links: Vec<Value> = sqlx::query("SELECT l.* FROM reconciliation_links l JOIN resources r ON r.id=l.session_id WHERE r.household_id=? ORDER BY l.match_id,l.transaction_id,l.observation_id")
        .bind(&p.household_id).fetch_all(&mut *db).await?.into_iter()
        .map(|r| json!([r.get::<String,_>("match_id"),r.get::<String,_>("session_id"),r.get::<String,_>("transaction_id"),r.get::<String,_>("observation_id"),r.get::<i64,_>("active")])).collect();
    let token = auth::hash(
        &json!([
            p.household_id,
            p.user_id,
            months,
            accounts,
            targets,
            observations,
            rows,
            links
        ])
        .to_string(),
    );
    let response = json!({"months":months,"counts":counts,"preview_token":token,"scope":"authorized_accounts_and_visible_budgets"});
    if !apply {
        return Ok(response);
    }
    if body["confirmation"] != "RESET" {
        return Err(ApiError::invalid("Type RESET to confirm."));
    }
    if body["preview_token"] != token {
        return Err(ApiError::conflict(
            "Data changed since the preview. Preview the reset again.",
        ));
    }

    // Void ledger entries and checks to retain their normal revision history.
    for (kind, before) in &targets {
        if !["transactions", "balance_checks"].contains(&kind.as_str()) {
            continue;
        }
        let id = text(before, "id")?;
        if kind == "transactions" {
            crate::reconciliation::invalidate(db, p, id).await?;
            sqlx::query("DELETE FROM import_occurrences WHERE household_id=? AND transaction_id=?")
                .bind(&p.household_id)
                .bind(id)
                .execute(&mut *db)
                .await?;
        }
        let mut after = before.clone();
        after["voided"] = json!(true);
        after["void_reason"] = json!("Monthly data reset");
        if kind == "transactions" {
            after["reconciliation_state"] = json!("unmatched");
        }
        storage::update(db, p, before, after, "monthly_data_reset").await?;
    }
    // Remove link rows before their evidence/session foreign keys; snapshots remain in audit.
    for observation in &observations {
        let id = text(observation, "id")?;
        sqlx::query("DELETE FROM reconciliation_links WHERE observation_id=?")
            .bind(id)
            .execute(&mut *db)
            .await?;
        storage::audit(db, p, id, "monthly_data_reset", Some(observation), None).await?;
        sqlx::query("DELETE FROM bank_observations WHERE id=? AND household_id=?")
            .bind(id)
            .bind(&p.household_id)
            .execute(&mut *db)
            .await?;
        sqlx::query("DELETE FROM import_occurrences WHERE id=? AND household_id=?")
            .bind(id)
            .bind(&p.household_id)
            .execute(&mut *db)
            .await?;
    }
    for session in &session_ids {
        sqlx::query("DELETE FROM reconciliation_links WHERE session_id=?")
            .bind(session)
            .execute(&mut *db)
            .await?;
    }
    for (kind, value) in &targets {
        if ["transactions", "balance_checks"].contains(&kind.as_str()) {
            continue;
        }
        let current = storage::raw(db, p, kind, text(value, "id")?).await?;
        storage::audit(
            db,
            p,
            text(value, "id")?,
            "monthly_data_reset",
            Some(&current),
            None,
        )
        .await?;
        sqlx::query("DELETE FROM resources WHERE id=? AND household_id=?")
            .bind(text(value, "id")?)
            .bind(&p.household_id)
            .execute(&mut *db)
            .await?;
    }
    for row in &rows {
        if let Some(item_id) = row["normalized"]["item_id"].as_str() {
            sqlx::query("DELETE FROM transfer_review_decisions WHERE item_id=?")
                .bind(item_id)
                .execute(&mut *db)
                .await?;
        }
        storage::audit(
            db,
            p,
            text(row, "file_id")?,
            "monthly_import_row_reset",
            Some(row),
            None,
        )
        .await?;
        sqlx::query("DELETE FROM import_rows WHERE file_id=? AND row_number=?")
            .bind(text(row, "file_id")?)
            .bind(row["row_number"].as_i64())
            .execute(&mut *db)
            .await?;
    }
    storage::audit(
        db,
        p,
        &p.household_id,
        "monthly_data_reset_completed",
        None,
        Some(&response),
    )
    .await?;
    Ok(response)
}
