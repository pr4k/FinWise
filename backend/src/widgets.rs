use crate::{
    AppState,
    api::{self, Query},
    auth::Principal,
    balances,
    domain::{add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use axum::http::{HeaderMap, StatusCode};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{HashMap, HashSet};

type Reply = (StatusCode, Value);

pub async fn settings(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    query: &Query,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Reply> {
    if p.role != "owner" {
        return Err(ApiError::forbidden());
    }
    let row = sqlx::query(
        "SELECT enabled,user_id,revision,family_enabled,accounts_enabled FROM widget_settings WHERE household_id=?",
    )
    .bind(&p.household_id)
    .fetch_optional(&mut *db)
    .await?;
    let current = if let Some(row) = row {
        json!({"enabled":row.get::<bool,_>(0),"user_id":row.get::<Option<String>,_>(1),"revision":row.get::<i64,_>(2),"family_enabled":row.get::<bool,_>(3),"accounts_enabled":row.get::<bool,_>(4)})
    } else {
        json!({"enabled":false,"user_id":null,"revision":0,"family_enabled":false,"accounts_enabled":false})
    };
    if method == "PATCH" {
        api::allowed_query(query, &[])?;
        api::allowed_body(body, &["enabled", "user_id", "family_enabled", "accounts_enabled"])?;
        api::revision(headers, body, &current)?;
        let enabled = body["enabled"]
            .as_bool()
            .ok_or_else(|| ApiError::invalid("enabled must be a boolean."))?;
        if !enabled {
            if current["enabled"] == true {
                sqlx::query(
                    "UPDATE widget_settings SET enabled=0,revision=revision+1 WHERE household_id=?",
                )
                .bind(&p.household_id)
                .execute(&mut *db)
                .await?;
                let saved = json!({"enabled":false,"user_id":current["user_id"],"family_enabled":current["family_enabled"],"accounts_enabled":current["accounts_enabled"],"revision":current["revision"].as_i64().unwrap_or(0)+1});
                storage::audit(
                    db,
                    p,
                    &p.household_id,
                    "widget_settings_updated",
                    Some(&current),
                    Some(&saved),
                )
                .await?;
                return Ok((StatusCode::OK, saved));
            }
            return Ok((StatusCode::OK, current));
        }
        let user_id = text(body, "user_id")?;
        let family_enabled = match body.get("family_enabled") {
            None => current["family_enabled"].as_bool().unwrap_or(false),
            Some(Value::Bool(value)) => *value,
            _ => return Err(ApiError::invalid("family_enabled must be a boolean.")),
        };
        let accounts_enabled = match body.get("accounts_enabled") {
            None => current["accounts_enabled"].as_bool().unwrap_or(false),
            Some(Value::Bool(value)) => *value,
            _ => return Err(ApiError::invalid("accounts_enabled must be a boolean.")),
        };
        member(db, &p.household_id, user_id).await?;
        let other: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM widget_settings WHERE enabled=1 AND household_id<>?",
        )
        .bind(&p.household_id)
        .fetch_one(&mut *db)
        .await?;
        if other > 0 {
            return Err(ApiError::conflict(
                "Another household already has widgets enabled.",
            ));
        }
        let revision = current["revision"].as_i64().unwrap_or(0) + 1;
        sqlx::query("INSERT INTO widget_settings(household_id,enabled,user_id,revision,family_enabled,accounts_enabled) VALUES(?,1,?,?,?,?) ON CONFLICT(household_id) DO UPDATE SET enabled=1,user_id=excluded.user_id,revision=excluded.revision,family_enabled=excluded.family_enabled,accounts_enabled=excluded.accounts_enabled")
            .bind(&p.household_id).bind(user_id).bind(revision).bind(family_enabled).bind(accounts_enabled).execute(&mut *db).await?;
        let saved = json!({"enabled":true,"user_id":user_id,"family_enabled":family_enabled,"accounts_enabled":accounts_enabled,"revision":revision});
        storage::audit(
            db,
            p,
            &p.household_id,
            "widget_settings_updated",
            Some(&current),
            Some(&saved),
        )
        .await?;
        return Ok((StatusCode::OK, saved));
    }
    api::allowed_query(query, &["user_id"])?;
    let selected_user = query.get("user_id").map(String::as_str).or_else(|| current["user_id"].as_str()).unwrap_or(&p.user_id);
    let selected_member = member(db, &p.household_id, selected_user).await?;
    let household: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
        .bind(&p.household_id).fetch_one(&mut *db).await?;
    let household: Value = serde_json::from_str(&household)
        .map_err(|_| ApiError::invalid("Invalid household settings."))?;
    let currency = text(&household, "base_currency")?;
    let owner_account_ids: HashSet<String> = storage::list(db, p, "accounts").await?
        .into_iter()
        .filter_map(|account| account["id"].as_str().map(str::to_owned))
        .collect();
    let mut accounts = storage::list(db, &selected_member, "accounts").await?
        .into_iter()
        .filter(|account| account["active"] != false && account["archived"] != true && account["currency"] == currency && account["id"].as_str().is_some_and(|id| owner_account_ids.contains(id)))
        .map(|account| json!({"id":account["id"],"name":account["name"],"currency":account["currency"]}))
        .collect::<Vec<_>>();
    accounts.sort_by(|a, b| (a["name"].as_str(), a["id"].as_str()).cmp(&(b["name"].as_str(), b["id"].as_str())));
    let members=sqlx::query("SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND m.active=1 ORDER BY u.name")
        .bind(&p.household_id).fetch_all(&mut *db).await?.into_iter()
        .map(|r|json!({"id":r.get::<&str,_>(0),"name":r.get::<&str,_>(1),"email":r.get::<&str,_>(2)})).collect::<Vec<_>>();
    Ok((
        StatusCode::OK,
        json!({"enabled":current["enabled"],"user_id":current["user_id"],"family_enabled":current["family_enabled"],"accounts_enabled":current["accounts_enabled"],"revision":current["revision"],"members":members,"accounts":accounts}),
    ))
}

async fn member(db: &mut SqliteConnection, household: &str, user: &str) -> Result<Principal> {
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

pub async fn spending(state: &AppState, query: &Query) -> Result<Reply> {
    let mut db = state.pool.acquire().await?;
    let row = sqlx::query(
        "SELECT household_id,user_id,family_enabled FROM widget_settings WHERE enabled=1",
    )
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(ApiError::missing)?;
    let household: String = row.get(0);
    let user: String = row.get(1);
    let family_enabled: bool = row.get(2);
    let p = member(&mut db, &household, &user).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "widget_unavailable",
            "Widget configuration is no longer valid.",
        )
    })?;
    calculate(&mut db, &p, query, family_enabled, Utc::now()).await
}

pub async fn expense_calendar(state: &AppState, query: &Query) -> Result<Reply> {
    api::allowed_query(query, &["scope", "month", "account_id"])?;
    let mut db = state.pool.acquire().await?;
    let row = sqlx::query(
        "SELECT household_id,user_id,family_enabled FROM widget_settings WHERE enabled=1",
    )
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(ApiError::missing)?;
    let household: String = row.get(0);
    let user: String = row.get(1);
    let family_enabled: bool = row.get(2);
    let p = member(&mut db, &household, &user).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "widget_unavailable",
            "Widget configuration is no longer valid.",
        )
    })?;
    let scope = query.get("scope").map(String::as_str).unwrap_or("personal");
    if !["personal", "family", "combined"].contains(&scope) {
        return Err(ApiError::invalid("scope must be personal, family, or combined."));
    }
    if scope != "personal" && !family_enabled {
        return Err(ApiError::forbidden());
    }
    if let Some(account_id) = query.get("account_id") {
        storage::get(&mut db, &p, "accounts", account_id).await?;
    }
    let settings: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
        .bind(&p.household_id)
        .fetch_one(&mut *db)
        .await?;
    let settings: Value = serde_json::from_str(&settings)
        .map_err(|_| ApiError::invalid("Invalid household settings."))?;
    let currency = text(&settings, "base_currency")?;
    let tz: Tz = text(&settings, "timezone")?
        .parse()
        .map_err(|_| ApiError::invalid("Invalid household timezone."))?;
    let now = Utc::now();
    let today = now.with_timezone(&tz).date_naive();
    let month = query
        .get("month")
        .cloned()
        .unwrap_or_else(|| today.format("%Y-%m").to_string());
    if month.len() != 7 || month.as_bytes()[4] != b'-' {
        return Err(ApiError::invalid("month must be YYYY-MM."));
    }
    let month_start = crate::domain::date(&format!("{month}-01"))
        .map_err(|_| ApiError::invalid("month must be YYYY-MM."))?;
    let (_, _, _, month_end) = period_bounds(month_start)?;
    let last = std::cmp::min(month_end, today);
    let mut days = Vec::new();
    if last >= month_start {
        let from = month_start.to_string();
        let to = (last + Duration::days(1)).to_string();
        let mut amounts = vec![0_i64; (last - month_start).num_days() as usize + 1];
        for tx in crate::classification::reporting(storage::transactions_in_period(&mut db, &p, &from, &to, false).await?) {
            if tx["voided"] == true
                || tx["currency"] != currency
                || !matches!(tx["event_type"].as_str(), Some("expense" | "refund"))
            {
                continue;
            }
            if query.get("account_id").is_some_and(|id| {
                !tx["movements"].as_array().is_some_and(|legs| {
                    legs.iter().any(|movement| movement["account_id"] == id.as_str())
                })
            }) {
                continue;
            }
            let at = balances::effective_at(&tx, tz)?;
            if at > now {
                continue;
            }
            let date = at.with_timezone(&tz).date_naive();
            if date < month_start || date > last {
                continue;
            }
            let mut amount = 0_i64;
            for allocation in tx["allocations"].as_array().into_iter().flatten() {
                if !allocation_in_scope(allocation, &tx, &p, scope) {
                    continue;
                }
                let value = money(text(allocation, "amount")?, currency)?;
                amount = add(amount, if tx["event_type"] == "refund" { -value } else { value })?;
            }
            let index = (date - month_start).num_days() as usize;
            amounts[index] = add(amounts[index], amount)?;
        }
        for (index, amount) in amounts.into_iter().enumerate() {
            let expense: Value = serde_json::from_str(&format_money(amount, currency)?)
                .map_err(|_| ApiError::invalid("Invalid money total."))?;
            days.push(json!({
                "date": (month_start + Duration::days(index as i64)).to_string(),
                "expense": expense,
            }));
        }
    }
    Ok((StatusCode::OK, json!({
        "month": month,
        "currency": currency,
        "complete": last >= month_start,
        "days": days,
    })))
}

pub async fn accounts(state: &AppState, query: &Query) -> Result<Reply> {
    api::allowed_query(query, &[])?;
    let mut db = state.pool.acquire().await?;
    let row = sqlx::query("SELECT household_id,user_id FROM widget_settings WHERE enabled=1 AND accounts_enabled=1")
        .fetch_optional(&mut *db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let household: String = row.get(0);
    let user: String = row.get(1);
    let p = member(&mut db, &household, &user).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "widget_unavailable",
            "Widget configuration is no longer valid.",
        )
    })?;
    let household_document: String =
        sqlx::query_scalar("SELECT document FROM households WHERE id=?")
            .bind(&p.household_id)
            .fetch_one(&mut *db)
            .await?;
    let household_document: Value = serde_json::from_str(&household_document)
        .map_err(|_| ApiError::invalid("Invalid household settings."))?;
    let currency = text(&household_document, "base_currency")?;
    let timezone: Tz = text(&household_document, "timezone")?
        .parse()
        .map_err(|_| ApiError::invalid("Invalid household timezone."))?;
    let now = Utc::now();
    let mut items = Vec::new();
    for account in storage::list(&mut db, &p, "accounts").await? {
        if account["active"] == false
            || account["archived"] == true
            || account["currency"] != currency
        {
            continue;
        }
        let account_id = text(&account, "id")?;
        let account_tz = balances::timezone(&mut db, &p, &account).await?;
        let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND EXISTS(SELECT 1 FROM json_each(document,'$.movements') WHERE json_extract(value,'$.account_id')=?)")
            .bind(&p.household_id)
            .bind(account_id)
            .fetch_all(&mut *db)
            .await?;
        let mut last_date: Option<NaiveDate> = None;
        for row in rows {
            let event: Value = serde_json::from_str(&row)
                .map_err(|_| ApiError::invalid("Invalid stored transaction."))?;
            if event["voided"] == true {
                continue;
            }
            let at = balances::effective_at(&event, account_tz)?;
            if at <= now {
                let date = at.with_timezone(&account_tz).date_naive();
                last_date = Some(last_date.map_or(date, |previous| previous.max(date)));
            }
        }
        let derived = balances::derived(&mut db, &p, &account, now).await?;
        // Account balances are assets less liabilities in this compact widget.
        let balance = derived["amount"]
            .as_str()
            .map(|amount| {
                if account["subtype"] == "credit_card" {
                    money(amount, currency)
                        .and_then(|value| {
                            value
                                .checked_neg()
                                .ok_or_else(|| ApiError::invalid("Card balance out of range."))
                        })
                        .and_then(|value| format_money(value, currency))
                } else {
                    Ok(amount.to_owned())
                }
            })
            .transpose()?;
        items.push(json!({
            "id":account_id,
            "name":text(&account,"name")?,
            "type":text(&account,"subtype")?,
            "balance":balance,
            "last_transaction_date":last_date.map(|date| date.to_string()),
        }));
    }
    items.sort_by(|a, b| {
        (a["name"].as_str(), a["id"].as_str()).cmp(&(b["name"].as_str(), b["id"].as_str()))
    });
    Ok((
        StatusCode::OK,
        json!({
            "success":true,
            "generated_at":now.with_timezone(&timezone).to_rfc3339(),
            "currency":currency,
            "accounts":items,
        }),
    ))
}

async fn calculate(
    db: &mut SqliteConnection,
    p: &Principal,
    query: &Query,
    family_enabled: bool,
    now: DateTime<Utc>,
) -> Result<Reply> {
    api::allowed_query(
        query,
        &["account_id", "category_limit", "include_children", "scope"],
    )?;
    let scope = query.get("scope").map(String::as_str).unwrap_or("personal");
    if !["personal", "family", "combined"].contains(&scope) {
        return Err(ApiError::invalid(
            "scope must be personal, family, or combined.",
        ));
    }
    if scope != "personal" && !family_enabled {
        return Err(ApiError::forbidden());
    }
    let limit = match query.get("category_limit") {
        None => 5,
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=20).contains(n))
            .ok_or_else(|| ApiError::invalid("category_limit must be between 1 and 20."))?,
    };
    let include_children = match query.get("include_children").map(String::as_str) {
        None | Some("true") => true,
        Some("false") => false,
        _ => return Err(ApiError::invalid("include_children must be true or false.")),
    };
    if let Some(id) = query.get("account_id") {
        storage::get(db, p, "accounts", id).await?;
    }
    let household: String = sqlx::query_scalar("SELECT document FROM households WHERE id=?")
        .bind(&p.household_id)
        .fetch_one(&mut *db)
        .await?;
    let household: Value = serde_json::from_str(&household)
        .map_err(|_| ApiError::invalid("Invalid household settings."))?;
    let currency = text(&household, "base_currency")?;
    let timezone = text(&household, "timezone")?;
    let tz: Tz = timezone
        .parse()
        .map_err(|_| ApiError::invalid("Invalid household timezone."))?;
    let local = now.with_timezone(&tz);
    let today = local.date_naive();
    let seven_start = today - Duration::days(6);
    let (monday, sunday, month_start, month_end) = period_bounds(today)?;
    let categories = storage::list(db, p, "categories").await?;
    let by_id: HashMap<String, Value> = categories
        .into_iter()
        .filter_map(|c| c["id"].as_str().map(|id| (id.to_owned(), c.clone())))
        .collect();
    let mut today_amount = 0_i64;
    let mut week_amount = 0_i64;
    let mut month_amount = 0_i64;
    let mut today_count = 0_u64;
    let mut week_count = 0_u64;
    let mut month_count = 0_u64;
    let mut daily_amounts = [0_i64; 7];
    let mut grouped: HashMap<String, i64> = HashMap::new();
    let from = std::cmp::min(std::cmp::min(monday, month_start), seven_start).to_string();
    let to = (today + Duration::days(1)).to_string();
    for tx in crate::classification::reporting(storage::transactions_in_period(db, p, &from, &to, false).await?) {
        if tx["voided"] == true
            || tx["currency"] != currency
            || !matches!(tx["event_type"].as_str(), Some("expense" | "refund"))
        {
            continue;
        }
        if query.get("account_id").is_some_and(|id| {
            !tx["movements"]
                .as_array()
                .is_some_and(|legs| legs.iter().any(|m| m["account_id"] == id.as_str()))
        }) {
            continue;
        }
        let at = balances::effective_at(&tx, tz)?;
        if at > now {
            continue;
        }
        let date = at.with_timezone(&tz).date_naive();
        let sign = if tx["event_type"] == "refund" { -1 } else { 1 };
        let mut eligible = 0_i64;
        let mut any = false;
        for allocation in tx["allocations"].as_array().into_iter().flatten() {
            if !allocation_in_scope(allocation, &tx, p, scope) {
                continue;
            }
            let category_id = allocation["category_id"]
                .as_str()
                .unwrap_or("uncategorized");
            let amount = money(text(allocation, "amount")?, currency)?;
            let signed = if sign < 0 { -amount } else { amount };
            eligible = add(eligible, signed)?;
            any = true;
            if date >= month_start && date <= today {
                let key = category_group(category_id, &by_id, include_children);
                let old = *grouped.get(&key).unwrap_or(&0);
                grouped.insert(key, add(old, signed)?);
            }
        }
        if !any {
            continue;
        }
        if date >= seven_start && date <= today {
            let day = (date - seven_start).num_days() as usize;
            daily_amounts[day] = add(daily_amounts[day], eligible)?;
        }
        if date == today {
            today_amount = add(today_amount, eligible)?;
            if sign > 0 {
                today_count += 1;
            }
        }
        if date >= monday && date <= today {
            week_amount = add(week_amount, eligible)?;
            if sign > 0 {
                week_count += 1;
            }
        }
        if date >= month_start && date <= today {
            month_amount = add(month_amount, eligible)?;
            if sign > 0 {
                month_count += 1;
            }
        }
    }
    let mut groups = grouped.into_iter().collect::<Vec<_>>();
    groups.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut selected = 0_i64;
    let mut items = Vec::new();
    for (id, amount) in groups.into_iter().take(limit) {
        selected = add(selected, amount)?;
        let label = by_id
            .get(&id)
            .and_then(|c| c["name"].as_str())
            .unwrap_or("Uncategorized");
        let percentage = if month_amount == 0 {
            0.0
        } else {
            let numerator = amount as i128 * 10_000;
            let denominator = month_amount as i128;
            let magnitude = (numerator.abs() + denominator.abs() / 2) / denominator.abs();
            let basis = if numerator.signum() == denominator.signum() {
                magnitude
            } else {
                -magnitude
            };
            basis as f64 / 100.0
        };
        items.push(json!({"id":id,"label":label,"amount":format_money(amount,currency)?,"percentage":percentage}));
    }
    let other = month_amount
        .checked_sub(selected)
        .ok_or_else(|| ApiError::invalid("Money total is out of range."))?;
    let daily_spending = daily_amounts
        .into_iter()
        .enumerate()
        .map(|(day, amount)| {
            Ok(json!({
                "date": (seven_start + Duration::days(day as i64)).to_string(),
                "spent": format_money(amount, currency)?
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((
        StatusCode::OK,
        json!({
            "success":true,"generated_at":local.to_rfc3339(),"currency":currency,"timezone":timezone,"scope":scope,
            "summary":{
                "today":{"date":today.to_string(),"spent":format_money(today_amount,currency)?,"transaction_count":today_count},
                "week":{"start_date":monday.to_string(),"end_date":sunday.to_string(),"spent":format_money(week_amount,currency)?,"transaction_count":week_count},
                "month":{"start_date":month_start.to_string(),"end_date":month_end.to_string(),"spent":format_money(month_amount,currency)?,"transaction_count":month_count}
            },
            "daily_spending":daily_spending,
            "categories":{"period":"month","total_spent":format_money(month_amount,currency)?,"items":items,"other_amount":format_money(other,currency)?}
        }),
    ))
}

fn allocation_in_scope(allocation: &Value, tx: &Value, p: &Principal, scope: &str) -> bool {
    let personal = allocation["scope"] == "personal" && allocation["member_id"].as_str().or_else(||tx["entered_by"].as_str()) == Some(p.user_id.as_str());
    let family = allocation["scope"] == "family";
    match scope {
        "personal" => personal,
        "family" => family,
        _ => personal || family,
    }
}

fn period_bounds(today: NaiveDate) -> Result<(NaiveDate, NaiveDate, NaiveDate, NaiveDate)> {
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let sunday = monday + Duration::days(6);
    let month_start = today
        .with_day(1)
        .ok_or_else(|| ApiError::invalid("Invalid month."))?;
    let next_month = if month_start.month() == 12 {
        NaiveDate::from_ymd_opt(month_start.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(month_start.year(), month_start.month() + 1, 1)
    }
    .ok_or_else(|| ApiError::invalid("Invalid month."))?;
    let month_end = next_month - Duration::days(1);
    Ok((monday, sunday, month_start, month_end))
}

fn category_group(id: &str, categories: &HashMap<String, Value>, include_children: bool) -> String {
    if !include_children {
        return id.to_owned();
    }
    let mut current = id.to_owned();
    let mut seen = HashSet::new();
    while seen.insert(current.clone()) {
        let Some(parent) = categories
            .get(&current)
            .and_then(|c| c["parent_id"].as_str())
        else {
            break;
        };
        if !categories.contains_key(parent) {
            break;
        }
        current = parent.to_owned();
    }
    current
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weeks_start_monday_and_month_end_is_inclusive() {
        let monday = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        assert_eq!(
            period_bounds(monday).unwrap(),
            (
                monday,
                NaiveDate::from_ymd_opt(2026, 10, 18).unwrap(),
                NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()
            )
        );
        let sunday = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        assert_eq!(
            period_bounds(sunday).unwrap(),
            (
                NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(),
                sunday,
                sunday,
                NaiveDate::from_ymd_opt(2026, 11, 30).unwrap()
            )
        );
    }
}
