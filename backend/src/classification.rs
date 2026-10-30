//! Independent economic classification. Ledger movements and source evidence are never rewritten.
use crate::{
    auth::Principal,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::{HashMap, HashSet};
pub const TYPES: &[&str] = &[
    "income",
    "expense",
    "investment",
    "transfer",
    "reimbursement",
    "paid_on_behalf",
    "refund",
    "debt",
    "adjustment",
    "unknown",
];
pub fn baseline(v: &Value, manual: bool) -> Value {
    let kind = match v["event_type"].as_str().unwrap_or("unknown") {
        "investment_withdrawal" => "investment",
        other => other,
    };
    json!({"transaction_type":kind,"status":if manual {"confirmed"} else {"needs_review"},"confidence_score":if manual {100} else {60},"classification_source":if manual {"manual"} else {"system"}})
}
fn suggestion(kind: &str, score: i64, reason: &str) -> Value {
    json!({"transaction_type":kind,"status":if score>=70 {"suggested"} else {"needs_review"},"confidence_score":score,"classification_source":"system","reason":reason})
}
pub fn kind<'a>(v: &'a Value, a: &'a Value) -> &'a str {
    a["transaction_type"]
        .as_str()
        .or_else(|| v["classification"]["transaction_type"].as_str())
        .unwrap_or_else(|| match v["event_type"].as_str().unwrap_or("unknown") {
            "investment_withdrawal" => "investment",
            x => x,
        })
}
pub fn credit(v: &Value) -> bool {
    v["movements"][0]["amount"]
        .as_str()
        .is_some_and(|n| !n.starts_with('-'))
}
pub fn validate(v: &Value) -> Result<()> {
    domain::choice(v, "transaction_type", TYPES)?;
    if let Some(splits) = v.get("splits") {
        let splits = splits
            .as_array()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::invalid("splits must be a nonempty array."))?;
        for s in splits {
            domain::choice(s, "transaction_type", TYPES)?;
        }
    }
    Ok(())
}
/// Enrich authorized rows using authorized context only. Saved manual decisions always win.
pub async fn enrich(db: &mut SqliteConnection, p: &Principal, values: &mut [Value]) -> Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let categories = storage::list(db, p, "categories").await?;
    let category_types: HashMap<String, &str> = categories
        .iter()
        .filter_map(|category| {
            let id = category["id"].as_str()?;
            let mut current = Some(category);
            let mut seen = HashSet::new();
            while let Some(c) = current {
                if !seen.insert(c["id"].as_str().unwrap_or("")) {
                    break;
                }
                if c["tracking_type"] == "investment" {
                    return Some((id.to_owned(), "investment"));
                }
                let name = c["name"].as_str().unwrap_or("").trim().to_lowercase();
                if [
                    "credit card settlement",
                    "card settlement",
                    "credit card payment",
                    "card payment",
                    "credit card repayment",
                    "card repayment",
                    "emergency fund allocation",
                ]
                .contains(&name.as_str())
                {
                    return Some((id.to_owned(), "transfer"));
                }
                current = c["parent_id"]
                    .as_str()
                    .and_then(|parent| categories.iter().find(|c| c["id"] == parent));
            }
            None
        })
        .collect();
    let rules = storage::list(db, p, "classification_rules").await?;
    let mut rules: Vec<_> = rules
        .iter()
        .filter(|r| r["enabled"] != false && r["owner_id"] == p.user_id)
        .collect();
    rules.sort_by_key(|r| std::cmp::Reverse(r["priority"].as_i64().unwrap_or(0)));
    let accounts = storage::list(db, p, "accounts").await?;
    let owned: HashSet<_> = accounts.iter().filter_map(|a| a["id"].as_str()).collect();
    // Matching context is independent of report filters and pagination. Do not read hidden accounts.
    let needs_context = values.iter().any(|v| {
        v["classification"].is_null()
            || (v["classification"]["classification_source"] != "manual"
                && v["classification"]["status"] != "confirmed")
    });
    let documents: Vec<String> = if needs_context {
        sqlx::query_scalar(
            "SELECT document FROM resources WHERE household_id=? AND kind='transactions'",
        )
        .bind(&p.household_id)
        .fetch_all(&mut *db)
        .await?
    } else {
        Vec::new()
    };
    let snapshot: Vec<Value> = documents
        .into_iter()
        .map(|s| {
            serde_json::from_str::<Value>(&s)
                .map_err(|_| ApiError::invalid("Invalid stored transaction."))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|v| {
            v["voided"] != true
                && v["movements"].as_array().is_some_and(|legs| {
                    legs.iter().all(|m| {
                        m["account_id"]
                            .as_str()
                            .is_some_and(|id| owned.contains(id))
                    })
                })
        })
        .collect();
    let mut candidates_by_amount: HashMap<(String, i64, bool), Vec<&Value>> = HashMap::new();
    for row in &snapshot {
        if row["movements"].as_array().is_some_and(|m| m.len() == 1) {
            let c = text(row, "currency")?;
            candidates_by_amount
                .entry((c.to_owned(), money(text(row, "amount")?, c)?, credit(row)))
                .or_default()
                .push(row);
        }
    }
    for v in values {
        v["report_scope"] =
            json!(if v["movements"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|m| accounts
                    .iter()
                    .any(|a| a["id"] == m["account_id"] && a["visibility"] == "shared"))
            {
                "family"
            } else {
                "personal"
            });
        if v["classification"].is_null() {
            v["classification"] = baseline(v, false);
        }
        if let Some(lines) = v["allocations"].as_array_mut() {
            for line in lines {
                if line["transaction_type"].is_null() {
                    if let Some(kind) = line["category_id"]
                        .as_str()
                        .and_then(|id| category_types.get(id))
                    {
                        line["transaction_type"] = json!(kind);
                    }
                }
            }
        }
        if v["classification"]["classification_source"] == "manual"
            || v["classification"]["status"] == "confirmed"
        {
            continue;
        }
        if v["event_type"] == "transfer" || !v["investment_id"].is_null() {
            v["classification"] = baseline(v, false);
            v["classification"]["status"] = json!("confirmed");
            v["classification"]["confidence_score"] = json!(99);
            continue;
        }
        let description = format!(
            "{} {}",
            v["merchant"].as_str().unwrap_or(""),
            v["description"].as_str().unwrap_or("")
        )
        .to_lowercase();
        let matching: Vec<_> = rules
            .iter()
            .filter(|r| {
                v["created_at"].as_str() > r["created_at"].as_str()
                    && description.contains(&r["contains"].as_str().unwrap_or("\0").to_lowercase())
            })
            .collect();
        if let Some(rule) = matching.first() {
            let priority = rule["priority"].as_i64().unwrap_or(0);
            let conflict = matching.iter().any(|r| {
                r["priority"].as_i64().unwrap_or(0) == priority
                    && (r["transaction_type"] != rule["transaction_type"]
                        || r["category_id"] != rule["category_id"])
            });
            v["classification"] = if conflict {
                suggestion("unknown", 30, "Conflicting saved rules require review")
            } else {
                json!({"transaction_type":rule["transaction_type"],"status":"confirmed","confidence_score":98,"classification_source":"rule","rule_id":rule["id"]})
            };
            let k = v["classification"]["transaction_type"]
                .as_str()
                .unwrap_or("unknown");
            if (k == "expense" && credit(v))
                || (matches!(k, "income" | "refund" | "reimbursement") && !credit(v))
            {
                v["classification"] = suggestion(
                    "unknown",
                    30,
                    "Saved rule conflicts with the movement direction",
                );
            }
            let kind = v["classification"]["transaction_type"].clone();
            if let Some(lines) = v["allocations"].as_array_mut() {
                for line in lines {
                    line["transaction_type"] = kind.clone();
                }
            }
        } else if ["sip", "mutual fund", "zerodha", "groww", "broker"]
            .iter()
            .any(|s| description.contains(s))
        {
            v["classification"] = suggestion("investment", 85, "Investment payment pattern");
        } else if ["credit card payment", "card bill", "cc payment"]
            .iter()
            .any(|s| description.contains(s))
        {
            v["classification"] =
                suggestion("transfer", 85, "Possible credit card liability settlement");
        } else if description.contains("emergency fund") {
            v["classification"] = suggestion(
                "transfer",
                80,
                "Reserve allocation, excluded from consumption",
            );
        } else if description.contains("reimburs") && credit(v) {
            v["classification"] = suggestion(
                "reimbursement",
                85,
                "Reimbursement; match the original expense or receivable",
            );
        } else if description.contains("loan")
            && !description.contains("interest")
            && !description.contains("fee")
        {
            v["classification"] = suggestion("debt", 80, "Possible loan principal movement");
        } else if description.contains("salary") && credit(v) {
            v["classification"] = suggestion("income", 90, "Salary pattern");
        } else if description.contains("refund") && credit(v) {
            v["classification"] = suggestion("refund", 85, "Merchant refund pattern");
        } else if description.contains("unknown")
            || v["allocations"]
                .as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|a| a["category_id"].is_null()))
        {
            v["classification"] = suggestion("unknown", 30, "Unresolved economic purpose");
        }
        if v["classification"]["confidence_score"]
            .as_i64()
            .unwrap_or(0)
            < 70
            && !v["merchant"].as_str().unwrap_or("").is_empty()
        {
            let historical: HashSet<_> = snapshot
                .iter()
                .filter(|other| {
                    other["id"] != v["id"]
                        && other["merchant"] == v["merchant"]
                        && other["effective_date"].as_str() < v["effective_date"].as_str()
                        && other["classification"]["status"] == "confirmed"
                        && credit(other) == credit(v)
                })
                .filter_map(|other| other["classification"]["transaction_type"].as_str())
                .collect();
            if historical.len() == 1 {
                v["classification"] = suggestion(
                    historical.iter().next().unwrap(),
                    75,
                    "Previous confirmed merchant classification",
                );
            }
        }
        // A distinct, opposite account movement nearby is evidence, never sufficient to confirm.
        if v["classification"]["status"] != "confirmed"
            && v["movements"].as_array().is_some_and(|m| m.len() == 1)
        {
            let c = text(v, "currency")?;
            let candidates: Vec<_> = candidates_by_amount
                .get(&(c.to_owned(), money(text(v, "amount")?, c)?, !credit(v)))
                .into_iter()
                .flatten()
                .copied()
                .filter(|other| {
                    if other["id"] == v["id"]
                        || other["voided"] == true
                        || other["currency"] != v["currency"]
                        || other["movements"].as_array().is_none_or(|m| m.len() != 1)
                        || credit(other) == credit(v)
                    {
                        return false;
                    }
                    let a = v["movements"][0]["account_id"].as_str().unwrap_or("");
                    let b = other["movements"][0]["account_id"].as_str().unwrap_or("");
                    a != b
                        && owned.contains(a)
                        && owned.contains(b)
                        && domain::date(v["effective_date"].as_str().unwrap_or(""))
                            .ok()
                            .zip(domain::date(other["effective_date"].as_str().unwrap_or("")).ok())
                            .is_some_and(|(a, b)| (a - b).num_days().abs() <= 3)
                })
                .collect();
            if candidates.len() == 1 {
                v["classification"] = suggestion(
                    "transfer",
                    80,
                    "Opposite movement between visible owned accounts; confirm the pair",
                );
                v["classification"]["suggested_link_id"] = candidates[0]["id"].clone();
            }
        }
    }
    Ok(())
}
/// Adapt economic allocations to existing report consumers. Raw movements remain attached.
pub fn reporting(values: Vec<Value>) -> Vec<Value> {
    let mut result = Vec::new();
    for v in values {
        let mut groups: std::collections::BTreeMap<&str, Vec<Value>> =
            std::collections::BTreeMap::new();
        for a in v["allocations"].as_array().into_iter().flatten() {
            let k = kind(&v, a);
            let report_kind = match k {
                "income" => "income",
                "expense" => "expense",
                "refund" => "refund",
                "reimbursement" if a["offset_expense"] == true => "refund",
                _ => continue,
            };
            groups.entry(report_kind).or_default().push(a.clone());
        }
        if groups.is_empty() {
            let mut row = v.clone();
            row["event_type"] = json!(kind(&v, &Value::Null));
            row["allocations"] = json!([]);
            result.push(row);
        } else {
            for (k, allocations) in groups {
                let mut row = v.clone();
                row["event_type"] = json!(k);
                row["allocations"] = json!(allocations);
                result.push(row);
            }
        }
    }
    result
}
pub fn summary(values: &[Value], currency: &str) -> Result<Value> {
    let mut buckets: HashMap<String, i64> = HashMap::new();
    let mut breakdown = Vec::new();
    let mut pending = 0;
    let (
        mut income,
        mut gross,
        mut offsets,
        mut invested,
        mut raw_credit,
        mut raw_debit,
        mut transfers,
    ) = (0, 0, 0, 0, 0, 0, 0);
    for v in values {
        if v["classification"]["status"] != "confirmed" {
            pending += 1;
        }
        let mut lines = v["allocations"].as_array().cloned().unwrap_or_default();
        if lines.is_empty() {
            lines.push(json!({"amount":v["amount"]}));
        }
        if v["event_type"] == "transfer" {
            transfers = add(transfers, money(text(v, "amount")?, currency)?)?;
            for movement in v["movements"].as_array().into_iter().flatten() {
                let n = money(text(movement, "amount")?, currency)?;
                let key = if n > 0 {
                    raw_credit = add(raw_credit, n)?;
                    "transfer_credits"
                } else {
                    raw_debit = add(raw_debit, -n)?;
                    "transfer_debits"
                };
                let entry = buckets.entry(key.to_owned()).or_default();
                *entry = add(*entry, n.abs())?;
            }
            breakdown.push(json!({"transaction_id":v["id"],"transaction_type":"transfer","amount":v["amount"],"income":"0","spending":"0","net_invested":"0"}));
            continue;
        }
        for a in lines {
            let n = money(text(&a, "amount")?, currency)?;
            let k = kind(v, &a);
            let incoming = credit(v);
            let bucket = format!("{}_{}", k, if incoming { "credits" } else { "debits" });
            let entry = buckets.entry(bucket).or_default();
            *entry = add(*entry, n)?;
            if incoming {
                raw_credit = add(raw_credit, n)?;
            } else {
                raw_debit = add(raw_debit, n)?;
            }
            if k == "transfer" && !incoming {
                transfers = add(transfers, n)?;
            }
            let (mut earned, mut spent, mut flow) = (0, 0, 0);
            match k {
                "income" => {
                    earned = n;
                    income = add(income, n)?;
                }
                "expense" => {
                    spent = n;
                    gross = add(gross, n)?;
                }
                "refund" => {
                    spent = -n;
                    offsets = add(offsets, n)?;
                }
                "reimbursement" if a["offset_expense"] == true => {
                    spent = -n;
                    offsets = add(offsets, n)?;
                }
                "investment" => {
                    flow = if incoming { -n } else { n };
                    invested = add(invested, flow)?;
                }
                _ => {}
            }
            breakdown.push(json!({"transaction_id":v["id"],"transaction_type":k,"category_id":a["category_id"],"amount":format_money(n,currency)?,"income":format_money(earned,currency)?,"spending":format_money(spent,currency)?,"net_invested":format_money(flow,currency)?}));
        }
    }
    let spending = domain::subtract(gross, offsets)?;
    let surplus = domain::subtract(income, spending)?;
    let reconciliation = buckets
        .into_iter()
        .map(|(k, n)| Ok((k, json!(format_money(n, currency)?))))
        .collect::<Result<serde_json::Map<_, _>>>()?;
    Ok(
        json!({"income":format_money(income,currency)?,"net_spending":format_money(spending,currency)?,"recorded_surplus":format_money(surplus,currency)?,"earned_income":format_money(income,currency)?,"actual_spending":format_money(spending,currency)?,"gross_expenses":format_money(gross,currency)?,"expense_offsets":format_money(offsets,currency)?,"net_invested":format_money(invested,currency)?,"economic_surplus":format_money(surplus,currency)?,"after_investment_cash_flow":format_money(domain::subtract(surplus,invested)?,currency)?,"raw_credits":format_money(raw_credit,currency)?,"raw_debits":format_money(raw_debit,currency)?,"unresolved_count":pending,"reconciliation":reconciliation,"breakdown":breakdown,"currency":currency,"transfer_volume":format_money(transfers,currency)?}),
    )
}

pub async fn save(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    body: &Value,
) -> Result<Value> {
    crate::api::allowed_body(
        body,
        &[
            "transaction_type",
            "category_id",
            "splits",
            "linked_transaction_id",
            "investment_id", "person", "paid_on_behalf_amount", "receivable_description",
        ],
    )?;
    validate(body)?;
    if before["voided"] == true {
        return Err(ApiError::conflict(
            "Voided transactions cannot be classified.",
        ));
    }
    if before["event_type"] == "transfer" && body["transaction_type"] != "transfer" {
        return Err(ApiError::invalid(
            "Edit the transfer ledger before changing its economic purpose.",
        ));
    }
    if (!before["investment_id"].is_null()
        || crate::planning::transaction_linked(db, p, text(before, "id")?).await?)
        && (body["transaction_type"] != "investment"
            || body["splits"]
                .as_array()
                .is_some_and(|a| a.iter().any(|a| a["transaction_type"] != "investment")))
    {
        return Err(ApiError::conflict(
            "Unlink this transaction from its investment holding before changing its purpose.",
        ));
    }
    let currency = text(before, "currency")?;
    let amount = money(text(before, "amount")?, currency)?;
    if before["classification"]["linked_transaction_id"].is_string()
        && body["linked_transaction_id"] != before["classification"]["linked_transaction_id"]
    {
        return Err(ApiError::conflict(
            "Undo the existing linked classification before changing its relationship.",
        ));
    }
    let mut after = before.clone();
    let mut classification = json!({"transaction_type":body["transaction_type"],"status":"confirmed","confidence_score":100,"classification_source":"manual","confirmed_at":storage::now()});
    if let Some(link) = body["linked_transaction_id"].as_str() {
        let target = storage::get(db, p, "transactions", link).await?;
        if target["id"] == before["id"]
            || target["currency"] != before["currency"]
            || target["voided"] == true
        {
            return Err(ApiError::invalid(
                "Choose another active transaction in the same currency.",
            ));
        }
        if body["transaction_type"] == "transfer" {
            if credit(&target) == credit(before)
                || money(text(&target, "amount")?, currency)? != amount
                || target["movements"][0]["account_id"] == before["movements"][0]["account_id"]
            {
                return Err(ApiError::invalid(
                    "A transfer pair requires equal, opposite movements on distinct accounts.",
                ));
            }
            let mut paired = target.clone();
            paired["classification"] = json!({"transaction_type":"transfer","status":"confirmed","confidence_score":100,"classification_source":"manual","confirmed_at":storage::now(),"linked_transaction_id":before["id"]});
            if !target["classification"]["linked_transaction_id"].is_null()
                && target["classification"]["linked_transaction_id"] != before["id"]
            {
                return Err(ApiError::conflict(
                    "The matching transaction already has a link.",
                ));
            }
            if let Some(lines) = paired["allocations"].as_array_mut() {
                for line in lines {
                    line["transaction_type"] = json!("transfer");
                }
            }
            storage::update(db, p, &target, paired, "classification_link").await?;
        }
        classification["linked_transaction_id"] = json!(link);
    }
    if let Some(holding) = body["investment_id"].as_str() {
        let holding = storage::get(db, p, "investments", holding).await?;
        if holding["currency"] != before["currency"] || holding["deleted"] == true {
            return Err(ApiError::invalid(
                "Choose an active investment in this currency.",
            ));
        }
        classification["investment_id"] = holding["id"].clone();
    }
    let paid_splits=crate::reimbursements::split(before,body)?;
    let mut lines = if let Some(splits)=paid_splits {splits} else if let Some(splits) = body["splits"].as_array() {
        splits.clone()
    } else {
        before["allocations"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    if lines.is_empty() {
        lines.push(json!({"amount":before["amount"],"scope":if before["entered_by"]==p.user_id {"personal"}else{"family"}}));
    }
    let mut total = 0;
    let mut new_offsets: HashMap<String, i64> = HashMap::new();
    for line in &mut lines {
        if line
            .get("category_id")
            .is_some_and(|c| !c.is_string() && !c.is_null())
            || line.get("offset_expense").is_some_and(|c| !c.is_boolean())
        {
            return Err(ApiError::invalid(
                "Invalid split category or expense offset flag.",
            ));
        }
        let n = money(text(line, "amount")?, currency)?;
        if n <= 0 {
            return Err(ApiError::invalid("Split amounts must be positive."));
        }
        total = add(total, n)?;
        if body.get("splits").is_none() && body.get("paid_on_behalf_amount").is_none() {
            line["transaction_type"] = body["transaction_type"].clone();
        }
        domain::choice(line, "transaction_type", TYPES)?;
        if line["scope"].is_null() {
            line["scope"] = json!("personal");
        }
        domain::choice(line, "scope", &["personal", "family"])?;
        if line["scope"] == "personal" && before["entered_by"] != p.user_id {
            return Err(ApiError::forbidden());
        }
        if let Some(member) = line["member_id"].as_str() {
            let known: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM memberships WHERE household_id=? AND user_id=? AND active=1",
            )
            .bind(&p.household_id)
            .bind(member)
            .fetch_one(&mut *db)
            .await?;
            if known == 0 || (line["scope"] == "personal" && member != p.user_id) {
                return Err(ApiError::invalid("Invalid member for the split scope."));
            }
        }
        if let Some(category) = body.get("category_id") {
            line["category_id"] = category.clone();
        }
        if body.get("splits").is_none() && body.get("category_id").is_none() {
            if let Some(category) = line["category_id"].as_str() {
                let category = storage::get(db, p, "categories", category).await?;
                let expected = if line["transaction_type"] == "income" {
                    "income"
                } else {
                    "expense"
                };
                if category["kind"] != expected {
                    line["category_id"] = Value::Null;
                }
            }
        }
        if let Some(category) = line["category_id"].as_str() {
            let category = storage::get(db, p, "categories", category).await?;
            if category["visibility"] == "private" {
                for movement in before["movements"].as_array().into_iter().flatten() {
                    let account =
                        storage::get(db, p, "accounts", text(movement, "account_id")?).await?;
                    let grants: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM account_access WHERE account_id=?",
                    )
                    .bind(text(&account, "id")?)
                    .fetch_one(&mut *db)
                    .await?;
                    if account["visibility"] != "private"
                        || account["owner_id"] != p.user_id
                        || grants > 0
                    {
                        return Err(ApiError::invalid(
                            "Private categories require your private account without access grants.",
                        ));
                    }
                }
            }
            if category["visibility"] == "private" && line["scope"] != "personal" {
                return Err(ApiError::invalid(
                    "Private categories require a personal allocation.",
                ));
            }
            if matches!(line["transaction_type"].as_str(), Some("income"))
                && category["kind"] != "income"
            {
                return Err(ApiError::invalid("Income requires an income category."));
            }
            if matches!(
                line["transaction_type"].as_str(),
                Some("expense" | "refund")
            ) && category["kind"] != "expense"
            {
                return Err(ApiError::invalid(
                    "Consumption requires an expense category.",
                ));
            }
        }
        if line["transaction_type"] == "refund" && body["linked_transaction_id"].is_string() {
            line["offset_expense"] = json!(true);
        }
        // Offsets need verified expense evidence; a receivable settlement never reduces spending twice.
        if line["offset_expense"] == true {
            if !matches!(
                line["transaction_type"].as_str(),
                Some("reimbursement" | "refund")
            ) || !credit(before)
            {
                return Err(ApiError::invalid(
                    "Only received refunds and reimbursements can offset an expense.",
                ));
            }
            let link = body["linked_transaction_id"].as_str().ok_or_else(|| {
                ApiError::invalid("An expense offset requires its original transaction.")
            })?;
            let original = storage::get(db, p, "transactions", link).await?;
            let eligible_lines: Vec<_> = original["allocations"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| {
                    kind(&original, a) == "expense"
                        && a["scope"] == line["scope"]
                        && (a["scope"] == "family" || allocation_owner(&original, a) == p.user_id)
                        && (line["member_id"].is_null()
                            || a["member_id"] == line["member_id"]
                            || (a["scope"] == "personal"
                                && original["entered_by"] == line["member_id"]))
                })
                .collect();
            if line["category_id"].is_null() {
                let categories: HashSet<_> = eligible_lines
                    .iter()
                    .map(|a| a["category_id"].to_string())
                    .collect();
                if categories.len() == 1 {
                    line["category_id"] = eligible_lines[0]["category_id"].clone();
                } else if categories.len() > 1 {
                    return Err(ApiError::invalid(
                        "Choose the original expense category for this offset.",
                    ));
                }
            }
            if line["member_id"].is_null() {
                let owners: HashSet<_> = eligible_lines
                    .iter()
                    .filter(|a| a["category_id"] == line["category_id"])
                    .map(|a| allocation_owner(&original, a))
                    .collect();
                if owners.len() == 1 {
                    line["member_id"] = json!(owners.iter().next().unwrap());
                } else if owners.len() > 1 {
                    return Err(ApiError::invalid(
                        "Choose the original expense member for this offset.",
                    ));
                }
            }
            let key = offset_key(before, line);
            let eligible = eligible_lines
                .iter()
                .filter(|a| offset_key(&original, a) == key)
                .try_fold(0, |sum, a| add(sum, money(text(a, "amount")?, currency)?))?;
            let mut used = 0;
            for other in storage::list(db, p, "transactions").await? {
                if other["id"] != before["id"]
                    && other["voided"] != true
                    && other["classification"]["linked_transaction_id"] == link
                {
                    for a in other["allocations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|a| a["offset_expense"] == true && offset_key(&other, a) == key)
                    {
                        used = add(used, money(text(a, "amount")?, currency)?)?;
                    }
                }
            }
            let pending = new_offsets.entry(key).or_default();
            *pending = add(*pending, n)?;
            if add(used, *pending)? > eligible {
                return Err(ApiError::invalid(
                    "Offsets exceed the original personal consumption expense.",
                ));
            }
        }
        if matches!(
            line["transaction_type"].as_str(),
            Some("income" | "refund" | "reimbursement")
        ) && !credit(before)
        {
            return Err(ApiError::invalid(
                "Income and received refunds require a credit movement.",
            ));
        }
        if matches!(line["transaction_type"].as_str(),Some("expense"|"paid_on_behalf")) && credit(before) {
            return Err(ApiError::invalid("Expenses require a debit movement."));
        }
    }
    if total != amount {
        return Err(ApiError::invalid(
            "Classification splits must sum to the transaction amount.",
        ));
    }
    if body["investment_id"].is_string()
        && !lines.iter().any(|a| a["transaction_type"] == "investment")
    {
        return Err(ApiError::invalid(
            "An investment link requires an investment allocation.",
        ));
    }
    if classification["transaction_type"] == "unknown"
        || lines.iter().any(|a| a["transaction_type"] == "unknown")
    {
        classification["status"] = json!("needs_review");
        classification["confidence_score"] = json!(0);
    }
    after["classification"] = classification;
    after["allocations"] = if before["event_type"] == "transfer" {
        before["allocations"].clone()
    } else {
        json!(lines)
    };
    // Preserve the exact imported ledger allocations separately on first correction.
    if after["original_allocations"].is_null() {
        after["original_allocations"] =
            storage::raw(db, p, "transactions", text(before, "id")?).await?["allocations"].clone();
    }
    crate::reimbursements::prepare(db,p,before,&mut after,body).await?;
    let saved = storage::update(db, p, before, after, "classify").await?;
    if let Some(holding_id) = body["investment_id"].as_str() {
        if before["classification"]["investment_id"] != holding_id
            && before["investment_id"].is_null()
        {
            let holding = storage::get(db, p, "investments", holding_id).await?;
            if holding["tracking_mode"] != "full_history" {
                crate::planning::route(
                    db,
                    p,
                    "POST",
                    &format!("investments/{holding_id}/linked-transactions"),
                    &crate::api::Query::new(),
                    &axum::http::HeaderMap::new(),
                    &json!({"transaction_id":saved["id"],"expected_revision":holding["revision"]}),
                )
                .await?;
            }
        }
    }
    Ok(saved)
}
pub fn review_priority(v: &Value) -> i128 {
    let n = money(
        v["amount"].as_str().unwrap_or("0"),
        v["currency"].as_str().unwrap_or("INR"),
    )
    .unwrap_or(0) as i128;
    let uncertainty = 100
        - v["classification"]["confidence_score"]
            .as_i64()
            .unwrap_or(0)
            .clamp(0, 100);
    n.abs()
        * uncertainty as i128
        * if v["classification"]["suggested_link_id"].is_string() {
            2
        } else {
            1
        }
}

pub async fn route(
    db: &mut SqliteConnection,
    p: &Principal,
    method: &str,
    path: &str,
    q: &crate::api::Query,
    headers: &axum::http::HeaderMap,
    body: &Value,
) -> Result<Value> {
    use crate::api::{allowed_body, allowed_query, revision};
    let parts: Vec<_> = path.split('/').collect();
    match (method, parts.as_slice()) {
        ("POST", ["transactions", id, "classification"]) => {
            let before = storage::get(db, p, "transactions", id).await?;
            revision(headers, body, &before)?;
            save(db, p, &before, body).await
        }
        ("POST", ["transactions", id, "classification-undo"]) => {
            allowed_body(body, &[])?;
            let before = storage::get(db, p, "transactions", id).await?;
            revision(headers, body, &before)?;
            if crate::planning::transaction_linked(db, p, id).await? {
                return Err(ApiError::conflict(
                    "Unlink the investment funding before undoing its classification.",
                ));
            }
            let history = storage::history(db, p, "transactions", id).await?;
            let previous = history["data"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .find(|a| {
                    a["action"] == "classify"
                        && a["after"]["classification"] == before["classification"]
                        && a["after"]["allocations"] == before["allocations"]
                })
                .ok_or_else(|| {
                    ApiError::conflict("No current classification correction to undo.")
                })?;
            let mut after = before.clone();
            if let Some(link) = before["classification"]["linked_transaction_id"].as_str() {
                let target = storage::get(db, p, "transactions", link).await?;
                if target["classification"]["linked_transaction_id"] == *id {
                    let target_history = storage::history(db, p, "transactions", link).await?;
                    let paired = target_history["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .rev()
                        .find(|a| {
                            a["action"] == "classification_link"
                                && a["after"]["revision"] == target["revision"]
                        })
                        .ok_or_else(|| {
                            ApiError::conflict(
                                "Linked classification changed; review the pair before undoing.",
                            )
                        })?;
                    let mut restored = target.clone();
                    restored["classification"] = paired["before"]["classification"].clone();
                    restored["allocations"] = paired["before"]["allocations"].clone();
                    storage::update(db, p, &target, restored, "classification_undo").await?;
                }
            }
            after["classification"] = previous["before"]["classification"].clone();
            after["allocations"] = previous["before"]["allocations"].clone();
            storage::update(db, p, &before, after, "classification_undo").await
        }
        ("POST", ["classification-rules", "preview"]) => {
            if body["transaction_type"]=="paid_on_behalf" {return Err(ApiError::invalid("Paid on Behalf requires a person and amount; classify each purchase individually."));}
            allowed_body(body, &["contains", "transaction_type"])?;
            validate(body)?;
            let needle = text(body, "contains")?.to_lowercase();
            if needle.len() < 3 {
                return Err(ApiError::invalid(
                    "Use at least three characters for a reusable rule.",
                ));
            }
            let values = storage::list(db, p, "transactions").await?;
            let data: Vec<_> = values
                .into_iter()
                .filter(|v| {
                    v["voided"] != true
                        && format!(
                            "{} {}",
                            v["merchant"].as_str().unwrap_or(""),
                            v["description"].as_str().unwrap_or("")
                        )
                        .to_lowercase()
                        .contains(&needle)
                })
                .collect();
            Ok(json!({"data":data,"proposed_type":body["transaction_type"]}))
        }
        ("POST", ["classification-rules", "apply"]) => {
            if body["transaction_type"]=="paid_on_behalf" {return Err(ApiError::invalid("Paid on Behalf requires a person and amount; classify each purchase individually."));}
            allowed_body(
                body,
                &["contains", "transaction_type", "transactions", "save_rule"],
            )?;
            validate(body)?;
            let needle = text(body, "contains")?.to_lowercase();
            if needle.len() < 3 {
                return Err(ApiError::invalid("Use at least three characters."));
            }
            let selections = body["transactions"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 5000)
                .ok_or_else(|| {
                    ApiError::invalid("Approve between 1 and 5000 previewed transactions.")
                })?;
            let mut seen = HashSet::new();
            let mut result = Vec::new();
            for selection in selections {
                let id = text(selection, "id")?;
                if !seen.insert(id) {
                    return Err(ApiError::invalid("Duplicate selection."));
                }
                let before = storage::get(db, p, "transactions", id).await?;
                if before["revision"] != selection["revision"] {
                    return Err(ApiError::conflict(
                        "Preview changed; refresh before bulk approval.",
                    ));
                }
                if !format!(
                    "{} {}",
                    before["merchant"].as_str().unwrap_or(""),
                    before["description"].as_str().unwrap_or("")
                )
                .to_lowercase()
                .contains(&needle)
                {
                    return Err(ApiError::invalid("Selection does not match the preview."));
                }
                result.push(
                    save(
                        db,
                        p,
                        &before,
                        &json!({"transaction_type":body["transaction_type"]}),
                    )
                    .await?,
                );
            }
            if body["save_rule"] == true {
                storage::create(db,p,"classification_rules",json!({"contains":needle,"transaction_type":body["transaction_type"],"enabled":true,"priority":0})).await?;
            }
            Ok(json!({"data":result}))
        }
        ("GET", ["classification-reviews"]) => {
            allowed_query(q, &["from", "to", "scope", "currency", "limit"])?;
            for key in ["from", "to"] {
                if let Some(date) = q.get(key) {
                    domain::date(date)?;
                }
            }
            if let (Some(from), Some(to)) = (q.get("from"), q.get("to")) {
                if from >= to {
                    return Err(ApiError::invalid("from must precede to."));
                }
            }
            let currency = q
                .get("currency")
                .cloned()
                .unwrap_or(auth_currency(db, p).await?);
            domain::exponent(&currency)?;
            let mut values = storage::transactions_in_range(
                db,
                p,
                q.get("from").map(String::as_str),
                q.get("to").map(String::as_str),
                false,
            )
            .await?;
            values.retain(|v| {
                v["voided"] != true
                    && v["classification"]["status"] != "confirmed"
                    && v["currency"] == currency
            });
            if let Some(scope) = q.get("scope") {
                crate::api::validate_report_scope(scope)?;
                crate::api::retain_scope(&mut values, scope, p, None);
            }
            values.sort_by(|a, b| {
                review_priority(b)
                    .cmp(&review_priority(a))
                    .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            });
            let count = values.len();
            let limit = q
                .get("limit")
                .map(|s| s.parse::<usize>())
                .transpose()
                .map_err(|_| ApiError::invalid("Invalid limit."))?
                .unwrap_or(5)
                .clamp(1, 200);
            values.truncate(limit);
            Ok(json!({"data":values,"pending_count":count,"currency":currency}))
        }
        _ => Err(ApiError::missing()),
    }
}

fn allocation_owner<'a>(transaction: &'a Value, allocation: &'a Value) -> &'a str {
    allocation["member_id"]
        .as_str()
        .or_else(|| transaction["paid_by_user_id"].as_str())
        .or_else(|| transaction["entered_by"].as_str())
        .unwrap_or("")
}
fn offset_key(transaction: &Value, allocation: &Value) -> String {
    json!([
        allocation["scope"],
        allocation["category_id"],
        allocation_owner(transaction, allocation)
    ])
    .to_string()
}

/// All ledger edits, voids and undo operations must preserve previously approved offsets.
pub async fn validate_dependents(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    after: &Value,
) -> Result<()> {
    if after.get("event_type").is_none() {
        return Ok(());
    }
    let currency = text(after, "currency")?;
    let mut eligible: HashMap<String, i64> = HashMap::new();
    if after["voided"] != true {
        for a in after["allocations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| kind(after, a) == "expense")
        {
            let value = eligible.entry(offset_key(after, a)).or_default();
            *value = add(*value, money(text(a, "amount")?, currency)?)?;
        }
    }
    let documents:Vec<String>=sqlx::query_scalar("SELECT document FROM resources WHERE household_id=? AND kind='transactions' AND json_extract(document,'$.classification.linked_transaction_id')=? AND coalesce(json_extract(document,'$.voided'),0)=0").bind(&p.household_id).bind(text(before,"id")?).fetch_all(&mut *db).await?;
    let mut offsets: HashMap<String, i64> = HashMap::new();
    for document in documents {
        let other: Value = serde_json::from_str(&document)
            .map_err(|_| ApiError::invalid("Invalid stored expense offset."))?;
        for a in other["allocations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["offset_expense"] == true)
        {
            if other["currency"] != currency {
                return Err(ApiError::conflict(
                    "A linked expense offset uses the original currency.",
                ));
            }
            let value = offsets.entry(offset_key(&other, a)).or_default();
            *value = add(*value, money(text(a, "amount")?, currency)?)?;
        }
    }
    if offsets
        .iter()
        .any(|(key, amount)| *amount > eligible.get(key).copied().unwrap_or(0))
    {
        return Err(ApiError::conflict(
            "Undo linked expense offsets before reducing or removing the original expense.",
        ));
    }
    Ok(())
}

async fn auth_currency(db: &mut SqliteConnection, p: &Principal) -> Result<String> {
    Ok(crate::auth::me(db, p).await?["household"]["base_currency"]
        .as_str()
        .unwrap_or("INR")
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn currencies_keep_their_exact_precision_and_overflow_is_an_error() {
        for (currency, amount, expected) in [
            ("JPY", "1", "2"),
            ("KWD", "0.001", "0.002"),
            ("INR", "0.01", "0.02"),
        ] {
            let row = json!({"id":"a","currency":currency,"amount":amount,"event_type":"expense","movements":[{"amount":format!("-{amount}")}],"allocations":[{"amount":amount}],"classification":{"transaction_type":"expense","status":"confirmed"}});
            let totals = summary(&[row.clone(), row.clone()], currency).unwrap();
            assert_eq!(totals["actual_spending"], expected);
            assert_eq!(totals["raw_debits"], expected);
        }
        let row = json!({"id":"a","amount":"92233720368547758.07","event_type":"expense","movements":[{"amount":"-92233720368547758.07"}],"allocations":[{"amount":"92233720368547758.07"}],"classification":{"transaction_type":"expense","status":"confirmed"}});
        assert!(summary(&[row.clone(), row], "INR").is_err());
    }
}
