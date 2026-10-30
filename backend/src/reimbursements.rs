//! Paid-on-behalf receivables reuse settlement_obligations and their repayment history.
use crate::{
    auth::Principal,
    classification,
    domain::{self, add, format_money, money, text},
    error::{ApiError, Result},
    storage,
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

fn active(v: &Value) -> bool {
    v["deleted"] != true && v["reversed"] != true
}
pub fn remaining(v: &Value) -> Result<i64> {
    if !active(v) {
        return Ok(0);
    }
    let c = text(v, "currency")?;
    let paid = v["repayments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["reversed"] != true)
        .try_fold(0, |sum, r| add(sum, money(text(r, "amount")?, c)?))?;
    let result = domain::subtract(money(text(v, "amount")?, c)?, paid)?;
    if result < 0 {
        return Err(ApiError::invalid("Repayments exceed the receivable."));
    }
    Ok(result)
}
async fn all(db: &mut SqliteConnection, p: &Principal) -> Result<Vec<Value>> {
    let docs: Vec<String> = sqlx::query_scalar(
        "SELECT document FROM resources WHERE household_id=? AND kind='settlement_obligations'",
    )
    .bind(&p.household_id)
    .fetch_all(db)
    .await?;
    docs.into_iter()
        .map(|s| {
            serde_json::from_str(&s).map_err(|_| ApiError::invalid("Invalid settlement record."))
        })
        .collect()
}
/// Check source links across private obligations without exposing their contents.
pub async fn has_source(
    db: &mut SqliteConnection,
    p: &Principal,
    transaction_id: &str,
) -> Result<bool> {
    Ok(all(db, p)
        .await?
        .iter()
        .any(|o| active(o) && o["transaction_id"] == transaction_id))
}
pub async fn allocated(
    db: &mut SqliteConnection,
    p: &Principal,
    transaction_id: &str,
    currency: &str,
) -> Result<i64> {
    let mut total = 0;
    for obligation in all(db, p).await?.iter().filter(|o| active(o)) {
        for payment in obligation["repayments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["reversed"] != true && r["transaction_id"] == transaction_id)
        {
            if obligation["currency"] != currency {
                return Err(ApiError::conflict("Linked reimbursement currency changed."));
            }
            total = add(total, money(text(payment, "amount")?, currency)?)?;
        }
    }
    Ok(total)
}
/// Build an exact purchase/receivable split while retaining original categories and scopes.
pub fn split(before: &Value, body: &Value) -> Result<Option<Vec<Value>>> {
    if body["transaction_type"] != "paid_on_behalf" || body.get("paid_on_behalf_amount").is_none() {
        return Ok(None);
    }
    if classification::credit(before)
        || before["movements"]
            .as_array()
            .is_none_or(|legs| legs.len() != 1)
    {
        return Err(ApiError::invalid(
            "Choose the original outgoing purchase, rather than a credit or internal transfer.",
        ));
    }
    let person = text(body, "person")?.trim();
    if person.is_empty() || person.len() > 100 {
        return Err(ApiError::invalid(
            "Enter a person with at most 100 characters.",
        ));
    }
    let c = text(before, "currency")?;
    let mut to_allocate = money(text(body, "paid_on_behalf_amount")?, c)?;
    if to_allocate <= 0 || to_allocate > money(text(before, "amount")?, c)? {
        return Err(ApiError::invalid(
            "Paid-on-behalf amount must be positive and no greater than the outgoing amount.",
        ));
    }
    let original=before["allocations"].as_array().cloned().filter(|a|!a.is_empty()).unwrap_or_else(||vec![json!({"amount":before["amount"],"scope":before["report_scope"].as_str().unwrap_or("personal")})]);
    let mut result = Vec::new();
    for a in original {
        let n = money(text(&a, "amount")?, c)?;
        let on_behalf = n.min(to_allocate);
        to_allocate -= on_behalf;
        if n > on_behalf {
            let mut own = a.clone();
            own["amount"] = json!(format_money(n - on_behalf, c)?);
            own["transaction_type"] = json!(match classification::kind(before, &a) {
                "transfer" => "transfer",
                "debt" => "debt",
                "investment" => "investment",
                "adjustment" => "adjustment",
                _ => "expense",
            });
            own.as_object_mut().unwrap().remove("receivable_id");
            result.push(own);
        }
        if on_behalf > 0 {
            let mut paid = a;
            paid["amount"] = json!(format_money(on_behalf, c)?);
            paid["transaction_type"] = json!("paid_on_behalf");
            paid["person"] = json!(person);
            paid["offset_expense"] = json!(false);
            result.push(paid);
        }
    }
    Ok(Some(result))
}
/// Create one linked Settle Up receivable for this purchase; repeated saves reuse its ID.
pub async fn prepare(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    after: &mut Value,
    body: &Value,
) -> Result<()> {
    let lines: Vec<_> = after["allocations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| classification::kind(after, a) == "paid_on_behalf")
        .cloned()
        .collect();
    if lines.is_empty() {
        return Ok(());
    }
    if classification::credit(before) || before["event_type"] == "transfer" {
        return Err(ApiError::invalid(
            "Paid on Behalf requires an outgoing purchase.",
        ));
    }
    let c = text(before, "currency")?;
    let amount = lines
        .iter()
        .try_fold(0, |sum, a| add(sum, money(text(a, "amount")?, c)?))?;
    let person = body["person"]
        .as_str()
        .or_else(|| lines[0]["person"].as_str())
        .unwrap_or("")
        .trim();
    if person.is_empty()
        || person.len() > 100
        || lines
            .iter()
            .any(|a| a["person"].as_str().is_some_and(|s| s.trim() != person))
    {
        return Err(ApiError::invalid(
            "Select one person for this paid-on-behalf purchase.",
        ));
    }
    let existing = all(db, p).await?.into_iter().find(|o| {
        active(o) && o["kind"] == "paid_on_behalf" && o["transaction_id"] == before["id"]
    });
    let obligation = if let Some(existing) = existing {
        if existing["owner_id"] != p.user_id
            || money(text(&existing, "amount")?, c)? != amount
            || existing["person"] != person
        {
            return Err(ApiError::conflict(
                "Reverse the existing receivable before changing its person or amount.",
            ));
        }
        existing
    } else {
        if has_source(db, p, text(before, "id")?).await? {
            return Err(ApiError::conflict(
                "This purchase already has a Settle Up obligation. Reverse that link before creating another.",
            ));
        }
        let description = body["receivable_description"]
            .as_str()
            .or_else(|| before["description"].as_str())
            .unwrap_or("");
        if description.len() > 500 {
            return Err(ApiError::invalid(
                "Description must have at most 500 characters.",
            ));
        }
        storage::create(db,p,"settlement_obligations",json!({"kind":"paid_on_behalf","direction":"owed_to_me","person":person,"amount":format_money(amount,c)?,"currency":c,"date":before["effective_date"],"description":description,"transaction_id":before["id"],"classification_before":before["classification"],"allocations_before":before["allocations"],"repayments":[]})).await?
    };
    after["classification"]["receivable_id"] = obligation["id"].clone();
    for a in after["allocations"].as_array_mut().unwrap() {
        if a["transaction_type"] == "paid_on_behalf" {
            a["receivable_id"] = obligation["id"].clone();
            a["person"] = json!(person);
        }
    }
    Ok(())
}
pub async fn link(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    body: &Value,
) -> Result<Value> {
    if !active(before) || before["direction"] != "owed_to_me" {
        return Err(ApiError::invalid(
            "Link an incoming reimbursement to an active receivable.",
        ));
    }
    let transaction = storage::get(db, p, "transactions", text(body, "transaction_id")?).await?;
    let c = text(before, "currency")?;
    if transaction["voided"] == true
        || transaction["currency"] != c
        || !classification::credit(&transaction)
        || transaction["movements"]
            .as_array()
            .is_none_or(|legs| legs.len() != 1)
        || !transaction["investment_id"].is_null()
    {
        return Err(ApiError::invalid(
            "Choose an active incoming transaction in the receivable currency.",
        ));
    }
    if (transaction["classification"]["transaction_type"] == "transfer"
        && transaction["classification"]["status"] == "confirmed")
        || !transaction["classification"]["linked_transaction_id"].is_null()
    {
        return Err(ApiError::conflict(
            "Unlink the existing transfer, refund or expense offset before matching this credit.",
        ));
    }
    let n = money(text(body, "amount")?, c)?;
    let used = allocated(db, p, text(&transaction, "id")?, c).await?;
    if n <= 0 || n > remaining(before)? || add(used, n)? > money(text(&transaction, "amount")?, c)?
    {
        return Err(ApiError::invalid(
            "Reimbursement exceeds the outstanding receivable or the credit's available amount.",
        ));
    }
    if body["note"].as_str().is_some_and(|s| s.len() > 500) {
        return Err(ApiError::invalid("Note must have at most 500 characters."));
    }
    let mut classified = transaction.clone();
    if classified["reimbursement_classification_before"].is_null() {
        classified["reimbursement_classification_before"] = transaction["classification"].clone();
        classified["reimbursement_allocations_before"] = transaction["allocations"].clone();
    }
    classified["classification"] = json!({"transaction_type":"reimbursement","status":"confirmed","confidence_score":100,"classification_source":"manual","confirmed_at":storage::now()});
    if classified["allocations"]
        .as_array()
        .is_none_or(|a| a.is_empty())
    {
        classified["allocations"] = json!([{"amount":transaction["amount"],"scope":transaction["report_scope"].as_str().unwrap_or("personal")}]);
    }
    for a in classified["allocations"].as_array_mut().unwrap() {
        a["transaction_type"] = json!("reimbursement");
        a["offset_expense"] = json!(false);
    }
    storage::update(db, p, &transaction, classified, "reimbursement_classified").await?;
    let mut after = before.clone();
    after["repayments"].as_array_mut().unwrap().push(json!({"id":storage::id(),"amount":format_money(n,c)?,"date":transaction["effective_date"],"note":body.get("note").cloned().unwrap_or(Value::Null),"transaction_id":transaction["id"],"linked_at":storage::now(),"reversed":false}));
    storage::update(db, p, before, after, "reimbursement_linked").await
}
pub async fn unlink(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    payment_id: &str,
) -> Result<Value> {
    let mut after = before.clone();
    let payment = after["repayments"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == payment_id && r["reversed"] != true)
        .ok_or_else(ApiError::missing)?;
    payment["reversed"] = json!(true);
    payment["reversed_at"] = json!(storage::now());
    storage::update(db, p, before, after, "reimbursement_unlinked").await
}
pub async fn reverse(db: &mut SqliteConnection, p: &Principal, before: &Value) -> Result<Value> {
    if before["kind"] != "paid_on_behalf" || !active(before) {
        return Err(ApiError::invalid(
            "Choose an active paid-on-behalf receivable.",
        ));
    }
    let source = storage::get(db, p, "transactions", text(before, "transaction_id")?).await?;
    let mut after = before.clone();
    after["reversed"] = json!(true);
    after["reversed_at"] = json!(storage::now());
    for r in after["repayments"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|r| r["reversed"] != true)
    {
        r["reversed"] = json!(true);
        r["reversed_at"] = json!(storage::now());
    }
    let saved = storage::update(db, p, before, after, "receivable_reversed").await?;
    let mut restored = source.clone();
    restored["classification"] = before["classification_before"].clone();
    restored["allocations"] = before["allocations_before"].clone();
    storage::update(db, p, &source, restored, "paid_on_behalf_reversed").await?;
    Ok(saved)
}
/// Protect source purchases and credit allocations from ordinary edits, voids and classification undo.
pub async fn validate_change(
    db: &mut SqliteConnection,
    p: &Principal,
    before: &Value,
    after: &Value,
) -> Result<()> {
    if after.get("event_type").is_none() {
        return Ok(());
    }
    let id = text(before, "id")?;
    let c = text(before, "currency")?;
    let records = all(db, p).await?;
    let source = records
        .iter()
        .find(|o| active(o) && o["kind"] == "paid_on_behalf" && o["transaction_id"] == id);
    let used = allocated(db, p, id, c).await?;
    if source.is_some() || used > 0 {
        if after["voided"] == true
            || after["amount"] != before["amount"]
            || after["currency"] != before["currency"]
            || after["effective_date"] != before["effective_date"]
            || after["movements"] != before["movements"]
        {
            return Err(ApiError::conflict(
                "Reverse or unlink the Settle Up records before changing this transaction's movements.",
            ));
        }
    }
    if let Some(o) = source {
        let paid = after["allocations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["transaction_type"] == "paid_on_behalf" && a["receivable_id"] == o["id"])
            .try_fold(0, |sum, a| add(sum, money(text(a, "amount")?, c)?))?;
        if paid != money(text(o, "amount")?, c)? {
            return Err(ApiError::conflict(
                "Reverse the linked Settle Up receivable before changing the paid-on-behalf allocation.",
            ));
        }
    }
    if used > 0 {
        let reimbursed = after["allocations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| {
                classification::kind(after, a) == "reimbursement" && a["offset_expense"] != true
            })
            .try_fold(0, |sum, a| add(sum, money(text(a, "amount")?, c)?))?;
        if reimbursed < used {
            return Err(ApiError::conflict(
                "Unlink the reimbursements in Settle Up before changing their classification.",
            ));
        }
    }
    Ok(())
}
pub async fn candidates(
    db: &mut SqliteConnection,
    p: &Principal,
    obligation: &Value,
) -> Result<Value> {
    let c = text(obligation, "currency")?;
    let due = remaining(obligation)?;
    let person = text(obligation, "person")?.to_lowercase();
    let mut result = Vec::new();
    for t in storage::list(db, p, "transactions").await? {
        if t["voided"] == true
            || t["currency"] != c
            || !classification::credit(&t)
            || t["movements"].as_array().is_none_or(|a| a.len() != 1)
            || (t["classification"]["transaction_type"] == "transfer"
                && t["classification"]["status"] == "confirmed")
            || !t["classification"]["linked_transaction_id"].is_null()
            || !t["investment_id"].is_null()
        {
            continue;
        }
        let available = domain::subtract(
            money(text(&t, "amount")?, c)?,
            allocated(db, p, text(&t, "id")?, c).await?,
        )?;
        if available <= 0 {
            continue;
        }
        let description = format!(
            "{} {}",
            t["description"].as_str().unwrap_or(""),
            t["merchant"].as_str().unwrap_or("")
        )
        .to_lowercase();
        result.push(json!({"id":t["id"],"description":t["description"],"effective_date":t["effective_date"],"amount":t["amount"],"currency":c,"available":format_money(available,c)?,"suggested_amount":format_money(available.min(due),c)?,"suggested":person.len()>=3&&description.contains(&person),"classification":t["classification"]}));
    }
    result.sort_by(|a, b| {
        b["suggested"]
            .as_bool()
            .cmp(&a["suggested"].as_bool())
            .then_with(|| {
                b["effective_date"]
                    .as_str()
                    .cmp(&a["effective_date"].as_str())
            })
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(
        json!({"data":result,"currency":c,"remaining":format_money(due,c)?,"matching_policy":"Suggestions require explicit confirmation; all dates included"}),
    )
}
