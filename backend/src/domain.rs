use crate::error::{ApiError, Result};
use chrono::NaiveDate;
use serde_json::Value;

pub fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::invalid(format!("{key} must be a nonempty string.")))
}
pub fn choice(v: &Value, key: &str, allowed: &[&str]) -> Result<()> {
    if !allowed.contains(&text(v, key)?) {
        return Err(ApiError::invalid(format!("Invalid {key}.")));
    }
    Ok(())
}
pub fn exponent(currency: &str) -> Result<u32> {
    match currency {
        "JPY" | "KRW" | "VND" | "CLP" => Ok(0),
        "BHD" | "KWD" | "OMR" | "JOD" | "TND" => Ok(3),
        "INR" | "USD" | "EUR" | "GBP" | "CAD" | "AUD" | "NZD" | "CHF" | "CNY" | "HKD" | "SGD"
        | "AED" | "SAR" | "ZAR" | "BRL" | "MXN" | "SEK" | "NOK" | "DKK" | "PLN" | "THB" | "IDR"
        | "MYR" | "PHP" => Ok(2),
        _ => Err(ApiError::invalid("Unsupported currency.")),
    }
}
pub fn money(amount: &str, currency: &str) -> Result<i64> {
    let scale = exponent(currency)? as usize;
    let (negative, value) = amount
        .strip_prefix('-')
        .map_or((false, amount), |s| (true, s));
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > scale
        || parts.next().is_some()
        || amount.ends_with('.')
    {
        return Err(ApiError::invalid(
            "Money must be a decimal string with currency precision.",
        ));
    }
    let digits = format!("{whole}{fraction}{}", "0".repeat(scale - fraction.len()));
    let signed = if negative {
        format!("-{digits}")
    } else {
        digits
    };
    signed
        .parse::<i64>()
        .map_err(|_| ApiError::invalid("Money is out of range."))
}
pub fn format_money(value: i64, currency: &str) -> Result<String> {
    let scale = exponent(currency)?;
    let magnitude = value.unsigned_abs();
    let sign = if value < 0 { "-" } else { "" };
    if scale == 0 {
        return Ok(format!("{sign}{magnitude}"));
    }
    let factor = 10_u64.pow(scale);
    Ok(format!(
        "{sign}{}.{:0width$}",
        magnitude / factor,
        magnitude % factor,
        width = scale as usize
    ))
}
pub fn add(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b)
        .ok_or_else(|| ApiError::invalid("Money total is out of range."))
}
pub fn date(value: &str) -> Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| ApiError::invalid("Date must be YYYY-MM-DD."))?;
    if parsed.to_string() != value {
        return Err(ApiError::invalid("Date must be YYYY-MM-DD."));
    }
    Ok(parsed)
}
pub fn validate_transaction(v: &Value) -> Result<()> {
    choice(
        v,
        "event_type",
        &["expense", "income", "refund", "transfer"],
    )?;
    let currency = text(v, "currency")?;
    let amount = money(text(v, "amount")?, currency)?;
    if amount <= 0 {
        return Err(ApiError::invalid("Transaction amount must be positive."));
    }
    let date = date(text(v, "effective_date")?)?;
    if let Some(at) = v.get("effective_at") {
        let local = chrono::DateTime::parse_from_rfc3339(
            at.as_str()
                .ok_or_else(|| ApiError::invalid("effective_at must be a timestamp."))?,
        )
        .map_err(|_| ApiError::invalid("effective_at must include an offset."))?;
        if local.date_naive() != date {
            return Err(ApiError::invalid(
                "effective_at date must equal effective_date.",
            ));
        }
    }
    for key in ["description", "merchant"] {
        if v.get(key).is_some_and(|value| !value.is_string()) {
            return Err(ApiError::invalid(format!("{key} must be a string.")));
        }
    }
    let kind = text(v, "event_type")?;
    let movements = v["movements"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("movements must be an array."))?;
    let allocations = v["allocations"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("allocations must be an array."))?;
    if kind == "transfer" {
        if movements.len() != 2
            || text(&movements[0], "account_id")? == text(&movements[1], "account_id")?
            || !allocations.is_empty()
        {
            return Err(ApiError::invalid(
                "Transfers require two distinct accounts and no allocations.",
            ));
        }
        let a = money(text(&movements[0], "amount")?, currency)?;
        let b = money(text(&movements[1], "amount")?, currency)?;
        if a.checked_add(b) != Some(0) || a.unsigned_abs() != amount as u64 {
            return Err(ApiError::invalid(
                "Transfer movements must be equal and opposite to the magnitude.",
            ));
        }
    } else {
        let expected = if kind == "expense" { -amount } else { amount };
        if movements.len() != 1 || money(text(&movements[0], "amount")?, currency)? != expected {
            return Err(ApiError::invalid(
                "Movement direction or magnitude does not match the event.",
            ));
        }
        let mut total = 0;
        for allocation in allocations {
            if allocation
                .get("category_id")
                .is_some_and(|v| !v.is_string() && !v.is_null())
            {
                return Err(ApiError::invalid("category_id must be a string or null."));
            }
            let n = money(text(allocation, "amount")?, currency)?;
            if n <= 0 {
                return Err(ApiError::invalid("Allocations must be positive."));
            }
            choice(allocation, "scope", &["personal", "family"])?;
            total = add(total, n)?;
        }
        if total != amount {
            return Err(ApiError::invalid(
                "Allocations must sum to the transaction amount.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_money_and_overflow() {
        assert_eq!(money("123.45", "INR").unwrap(), 12345);
        assert_eq!(money("0.001", "KWD").unwrap(), 1);
        assert!(money("1.1", "JPY").is_err());
        for bad in [
            "1e2",
            "1.001",
            "NaN",
            "+1",
            " 1",
            "1.",
            "92233720368547758.08",
        ] {
            assert!(money(bad, "INR").is_err(), "{bad}");
        }
        assert_eq!(
            format_money(i64::MIN, "INR").unwrap(),
            "-92233720368547758.08"
        );
        assert!(add(i64::MAX, 1).is_err());
    }
    #[test]
    fn transfer_conserves_value() {
        let mut v = json!({"event_type":"transfer","amount":"10.00","currency":"INR","effective_date":"2026-09-01","allocations":[],"movements":[{"account_id":"a","amount":"-10.00"},{"account_id":"b","amount":"10.00"}]});
        assert!(validate_transaction(&v).is_ok());
        v["movements"][1]["account_id"] = json!("a");
        assert!(validate_transaction(&v).is_err());
    }
}
