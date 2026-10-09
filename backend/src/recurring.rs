use crate::{
    auth::{self, Principal},
    domain::{self, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use chrono::NaiveDate;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone)]
struct Payment {
    id: String,
    source: &'static str,
    account_id: String,
    currency: String,
    name: String,
    date: NaiveDate,
    amount: i64,
}

fn normalize(raw: &str) -> String {
    let words: Vec<String> = raw
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c.is_ascii_digit()))
        .filter(|s| {
            ![
                "upi", "pos", "debit", "card", "payment", "paid", "to", "the", "txn", "ref", "ach",
                "ecs", "nach",
            ]
            .contains(s)
        })
        .map(str::to_owned)
        .collect();
    words.join(" ")
}

fn key(p: &Payment) -> String {
    auth::hash(&format!(
        "{}\u{1f}{}\u{1f}{}",
        p.account_id,
        p.currency,
        normalize(&p.name)
    ))
}

fn frequency(items: &[Payment]) -> Option<&'static str> {
    let mut dates: Vec<_> = items.iter().map(|p| p.date).collect();
    dates.sort();
    dates.dedup();
    if dates.len() < 2 {
        return None;
    }
    let gaps: Vec<_> = dates.windows(2).map(|w| (w[1] - w[0]).num_days()).collect();
    for (label, lo, hi) in [
        ("weekly", 6, 8),
        ("monthly", 25, 35),
        ("quarterly", 80, 100),
        ("yearly", 330, 400),
    ] {
        if gaps.iter().all(|gap| (lo..=hi).contains(gap)) {
            return Some(label);
        }
    }
    None
}

async fn payments(db: &mut SqliteConnection, p: &Principal) -> Result<Vec<Payment>> {
    let mut result = Vec::new();
    for t in storage::list(db, p, "transactions").await? {
        if t["voided"] == true || t["event_type"] != "expense" {
            continue;
        }
        let name = t["merchant"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| t["description"].as_str())
            .unwrap_or("");
        if normalize(name).len() < 3 {
            continue;
        }
        let currency = text(&t, "currency")?;
        let account_id = t["movements"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|m| m["amount"].as_str().is_some_and(|v| v.starts_with('-')))
            })
            .and_then(|m| m["account_id"].as_str());
        if let Some(account_id) = account_id {
            result.push(Payment {
                id: text(&t, "id")?.to_owned(),
                source: "money_manager_or_ledger",
                account_id: account_id.to_owned(),
                currency: currency.to_owned(),
                name: name.to_owned(),
                date: domain::date(text(&t, "effective_date")?)?,
                amount: money(text(&t, "amount")?, currency)?,
            });
        }
    }
    let linked: HashSet<String> = sqlx::query_scalar("SELECT DISTINCT l.observation_id FROM reconciliation_links l JOIN bank_observations b ON b.id=l.observation_id WHERE b.household_id=? AND l.active=1")
        .bind(&p.household_id).fetch_all(&mut *db).await?.into_iter().collect();
    let ledger_signatures: HashSet<_> = result
        .iter()
        .map(|p| {
            (
                p.account_id.clone(),
                p.currency.clone(),
                p.date,
                p.amount,
                normalize(&p.name),
            )
        })
        .collect();
    let rows = sqlx::query(
        "SELECT document FROM bank_observations WHERE household_id=? AND amount_minor<0",
    )
    .bind(&p.household_id)
    .fetch_all(&mut *db)
    .await?;
    for row in rows {
        let v: Value = serde_json::from_str(row.get::<&str, _>(0))
            .map_err(|_| ApiError::invalid("Invalid bank observation."))?;
        if linked.contains(text(&v, "id")?) {
            continue;
        }
        let account_id = text(&v, "account_id")?;
        if storage::get(db, p, "accounts", account_id).await.is_err() {
            continue;
        }
        let name = v["description"].as_str().unwrap_or("");
        if normalize(name).len() < 3 {
            continue;
        }
        let currency = text(&v, "currency")?;
        let signed = money(text(&v, "amount")?, currency)?;
        let amount = signed
            .checked_abs()
            .ok_or_else(|| ApiError::invalid("Statement amount is out of range."))?;
        let date = domain::date(text(&v, "effective_date")?)?;
        if ledger_signatures.contains(&(
            account_id.to_owned(),
            currency.to_owned(),
            date,
            amount,
            normalize(name),
        )) {
            continue;
        }
        result.push(Payment {
            id: text(&v, "id")?.to_owned(),
            source: "bank_statement",
            account_id: account_id.to_owned(),
            currency: currency.to_owned(),
            name: name.to_owned(),
            date,
            amount,
        });
    }
    Ok(result)
}

pub async fn list(db: &mut SqliteConnection, p: &Principal) -> Result<Value> {
    let labels: BTreeMap<String, (bool, bool)> =
        sqlx::query("SELECT key,subscription,ignored FROM recurring_labels WHERE household_id=?")
            .bind(&p.household_id)
            .fetch_all(&mut *db)
            .await?
            .into_iter()
            .map(|r| {
                (
                    r.get::<String, _>(0),
                    (r.get::<i64, _>(1) != 0, r.get::<i64, _>(2) != 0),
                )
            })
            .collect();
    let mut groups: BTreeMap<String, Vec<Payment>> = BTreeMap::new();
    for payment in payments(db, p).await? {
        groups.entry(key(&payment)).or_default().push(payment);
    }
    let mut data = Vec::new();
    for (key, mut items) in groups {
        items.sort_by_key(|p| p.date);
        let cadence = frequency(&items);
        let (subscription, ignored) = labels.get(&key).copied().unwrap_or((false, false));
        if cadence.is_none() && !subscription && !ignored {
            continue;
        }
        let latest = items.last().unwrap();
        let currency = &latest.currency;
        let amounts: Vec<i64> = items.iter().map(|p| p.amount).collect();
        let min = *amounts.iter().min().unwrap();
        let max = *amounts.iter().max().unwrap();
        let name = latest.name.clone();
        let account_id = latest.account_id.clone();
        let occurrences: Vec<Value>=items.iter().rev().map(|p| json!({"id":p.id,"source":p.source,"date":p.date.to_string(),"amount":format_money(p.amount,currency).unwrap_or_default()})).collect();
        data.push(json!({"key":key,"name":name,"account_id":account_id,"currency":currency,"frequency":cadence.unwrap_or("unconfirmed"),"subscription":subscription,"ignored":ignored,"count":items.len(),"first_date":items.first().unwrap().date.to_string(),"last_date":latest.date.to_string(),"min_amount":format_money(min,currency)?,"max_amount":format_money(max,currency)?,"occurrences":occurrences}));
    }
    data.sort_by(|a, b| {
        (b["last_date"].as_str(), b["key"].as_str())
            .cmp(&(a["last_date"].as_str(), a["key"].as_str()))
    });
    Ok(json!({"data":data,"page":{},"meta":{}}))
}

pub async fn tag(
    db: &mut SqliteConnection,
    p: &Principal,
    key: &str,
    body: &Value,
) -> Result<Value> {
    crate::api::allowed_body(body, &["subscription", "ignored"])?;
    if body.get("subscription").is_none() && body.get("ignored").is_none() {
        return Err(ApiError::invalid("subscription or ignored is required."));
    }
    let requested_subscription = body
        .get("subscription")
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| ApiError::invalid("subscription must be boolean."))
        })
        .transpose()?;
    let requested_ignored = body
        .get("ignored")
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| ApiError::invalid("ignored must be boolean."))
        })
        .transpose()?;
    if requested_subscription == Some(true) && requested_ignored == Some(true) {
        return Err(ApiError::invalid(
            "A payment cannot be a subscription and ignored.",
        ));
    }
    let item = list(db, p).await?["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["key"] == key)
        .cloned()
        .ok_or_else(ApiError::missing)?;
    let before = sqlx::query(
        "SELECT subscription,ignored FROM recurring_labels WHERE household_id=? AND key=?",
    )
    .bind(&p.household_id)
    .bind(key)
    .fetch_optional(&mut *db)
    .await?;
    let mut subscription = before.as_ref().is_some_and(|r| r.get::<i64, _>(0) != 0);
    let mut ignored = before.as_ref().is_some_and(|r| r.get::<i64, _>(1) != 0);
    if let Some(value) = requested_subscription {
        subscription = value;
        if value {
            ignored = false;
        }
    }
    if let Some(value) = requested_ignored {
        ignored = value;
        if value {
            subscription = false;
        }
    }
    if subscription && ignored {
        return Err(ApiError::invalid(
            "A payment cannot be a subscription and ignored.",
        ));
    }
    sqlx::query("INSERT INTO recurring_labels(household_id,key,subscription,ignored,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(household_id,key) DO UPDATE SET subscription=excluded.subscription,ignored=excluded.ignored,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
        .bind(&p.household_id).bind(key).bind(subscription).bind(ignored).bind(&p.user_id).bind(storage::now()).execute(&mut *db).await?;
    storage::audit(
        db,
        p,
        key,
        "recurring_status_changed",
        before
            .as_ref()
            .map(|r| json!({"subscription":r.get::<i64,_>(0)!=0,"ignored":r.get::<i64,_>(1)!=0}))
            .as_ref(),
        Some(&json!({"subscription":subscription,"ignored":ignored})),
    )
    .await?;
    let mut result = item;
    result["subscription"] = json!(subscription);
    result["ignored"] = json!(ignored);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cadence_and_normalization() {
        assert_eq!(normalize("UPI/NETFLIX 12345/Payment"), "netflix");
        let mk = |day: u32| Payment {
            id: day.to_string(),
            source: "bank_statement",
            account_id: "a".into(),
            currency: "INR".into(),
            name: "Netflix".into(),
            date: NaiveDate::from_ymd_opt(2026, day, 5).unwrap(),
            amount: 100,
        };
        assert_eq!(frequency(&[mk(1), mk(2), mk(3)]), Some("monthly"));
    }
}
