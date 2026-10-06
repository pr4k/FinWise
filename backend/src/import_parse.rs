use crate::{
    domain,
    error::{ApiError, Result},
};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
};

pub const MAX_ROWS: usize = 20_000;
#[derive(Clone, Debug)]
pub struct ParsedFile {
    pub headers: Vec<String>,
    pub rows: Vec<ParsedRow>,
    pub warnings: Vec<String>,
    pub adapter: &'static str,
}
#[derive(Clone, Debug)]
pub struct ParsedRow {
    pub row_number: usize,
    pub cells: Vec<String>,
}
impl ParsedRow {
    pub fn raw(&self, headers: &[String]) -> Value {
        let columns=self.cells.iter().enumerate().map(|(i,v)|json!({"index":i,"header":headers.get(i).map(String::as_str).unwrap_or(""),"value":v})).collect::<Vec<_>>();
        json!({"row_number":self.row_number,"columns":columns})
    }
    pub fn at<'a>(&'a self, headers: &[String], name: &str) -> &'a str {
        headers
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
            .and_then(|i| self.cells.get(i))
            .map(String::as_str)
            .unwrap_or("")
    }
}
fn fail(code: &'static str) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_REQUEST,
        code,
        "File could not be parsed safely.",
    )
}
fn validate(parsed: &ParsedFile) -> Result<()> {
    if parsed.rows.len() > MAX_ROWS
        || parsed.headers.len() > 64
        || parsed.headers.iter().any(|s| s.len() > 4096)
        || parsed
            .rows
            .iter()
            .any(|r| r.cells.iter().any(|s| s.len() > 8192))
    {
        return Err(fail("parse_limit"));
    }
    if parsed.headers.is_empty() {
        return Err(fail("empty_file"));
    }
    Ok(())
}
pub fn parse_csv(bytes: &[u8]) -> Result<ParsedFile> {
    let text = std::str::from_utf8(bytes).map_err(|_| fail("invalid_utf8"))?;
    if text.as_bytes().contains(&0) {
        return Err(fail("invalid_utf8"));
    }
    let mut reader = csv::ReaderBuilder::new()
        .flexible(false)
        .from_reader(text.as_bytes());
    let headers = reader
        .headers()
        .map_err(|_| fail("invalid_csv"))?
        .iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = vec![];
    for (index, row) in reader.records().enumerate() {
        if index >= MAX_ROWS {
            return Err(fail("parse_limit"));
        }
        let record = row.map_err(|_| fail("invalid_csv"))?;
        rows.push(ParsedRow {
            row_number: index + 2,
            cells: record.iter().map(str::to_owned).collect(),
        });
    }
    let parsed = ParsedFile {
        headers,
        rows,
        warnings: vec![],
        adapter: "csv-v1",
    };
    validate(&parsed)?;
    Ok(parsed)
}
fn zip_text(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    max: usize,
) -> Result<String> {
    let file = archive.by_name(name).map_err(|_| fail("invalid_xlsx"))?;
    if file.size() > max as u64 {
        return Err(fail("parse_limit"));
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("invalid_xlsx"))?;
    if bytes.len() > max {
        return Err(fail("parse_limit"));
    }
    let text = String::from_utf8(bytes).map_err(|_| fail("invalid_xlsx"))?;
    if text.contains("<!DOCTYPE") || text.contains("<!ENTITY") {
        return Err(fail("invalid_xlsx"));
    }
    Ok(text)
}
fn name<'a>(n: roxmltree::Node<'a, 'a>) -> &'a str {
    n.tag_name().name()
}
fn descendant_text(node: roxmltree::Node<'_, '_>, tag: &str) -> String {
    node.descendants()
        .filter(|n| n.is_element() && name(*n) == tag)
        .filter_map(|n| n.text())
        .collect::<String>()
}
fn cell_index(reference: &str) -> Option<usize> {
    let mut col = 0usize;
    let mut found = false;
    for b in reference.bytes().take_while(|b| b.is_ascii_alphabetic()) {
        found = true;
        col = col
            .checked_mul(26)?
            .checked_add((b.to_ascii_uppercase() - b'A' + 1) as usize)?;
    }
    found.then_some(col - 1)
}
pub fn parse_xlsx(bytes: &[u8]) -> Result<ParsedFile> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| fail("invalid_xlsx"))?;
    if archive.len() > 150 {
        return Err(fail("parse_limit"));
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|_| fail("invalid_xlsx"))?;
        let path = file.name();
        if path.contains("..")
            || path.starts_with('/')
            || path.contains('\\')
            || path.to_ascii_lowercase().ends_with("vbaproject.bin")
            || path.to_ascii_lowercase().ends_with(".exe")
            || path.to_ascii_lowercase().ends_with(".xlsb")
        {
            return Err(fail("unsafe_xlsx"));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| fail("parse_limit"))?;
        if total > 24 * 1024 * 1024 {
            return Err(fail("parse_limit"));
        }
    }
    let workbook = zip_text(&mut archive, "xl/workbook.xml", 1024 * 1024)?;
    let workbook_xml = roxmltree::Document::parse(&workbook).map_err(|_| fail("invalid_xlsx"))?;
    let date1904 = workbook_xml.descendants().any(|n| {
        n.is_element()
            && name(n) == "workbookPr"
            && n.attribute("date1904")
                .is_some_and(|v| v == "1" || v == "true")
    });
    let sheets = workbook_xml
        .descendants()
        .filter(|n| n.is_element() && name(*n) == "sheet")
        .collect::<Vec<_>>();
    if sheets.len() != 1 {
        return Err(fail("unsupported_workbook"));
    }
    let sheet_id = sheets[0]
        .attributes()
        .find(|a| a.name().ends_with(":id") || a.name() == "id")
        .map(|a| a.value());
    let sheet_path = if let Some(sheet_id) = sheet_id {
        let rels = zip_text(&mut archive, "xl/_rels/workbook.xml.rels", 1024 * 1024)?;
        let doc = roxmltree::Document::parse(&rels).map_err(|_| fail("invalid_xlsx"))?;
        let target = doc
            .descendants()
            .find(|n| {
                n.is_element() && name(*n) == "Relationship" && n.attribute("Id") == Some(sheet_id)
            })
            .and_then(|n| n.attribute("Target"))
            .ok_or_else(|| fail("invalid_xlsx"))?;
        if target.contains("..") || target.contains('\\') || target.starts_with("//") {
            return Err(fail("unsafe_xlsx"));
        }
        if target.trim_start_matches('/').starts_with("xl/") {
            target.trim_start_matches('/').to_owned()
        } else {
            format!("xl/{target}")
        }
    } else {
        "xl/worksheets/sheet1.xml".into()
    };
    if !sheet_path.starts_with("xl/worksheets/") {
        return Err(fail("invalid_xlsx"));
    }
    let shared = if archive.file_names().any(|n| n == "xl/sharedStrings.xml") {
        let content = zip_text(&mut archive, "xl/sharedStrings.xml", 8 * 1024 * 1024)?;
        let doc = roxmltree::Document::parse(&content).map_err(|_| fail("invalid_xlsx"))?;
        doc.descendants()
            .filter(|n| n.is_element() && name(*n) == "si")
            .map(|n| descendant_text(n, "t"))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let sheet = zip_text(&mut archive, &sheet_path, 16 * 1024 * 1024)?;
    let doc = roxmltree::Document::parse(&sheet).map_err(|_| fail("invalid_xlsx"))?;
    let mut rows = vec![];
    let mut headers = vec![];
    let mut header_seen = false;
    for row in doc
        .descendants()
        .filter(|n| n.is_element() && name(*n) == "row")
    {
        if rows.len() > MAX_ROWS {
            return Err(fail("parse_limit"));
        }
        let row_number = row
            .attribute("r")
            .and_then(|r| r.parse().ok())
            .unwrap_or(rows.len() + 1);
        let mut cells = vec![];
        for cell in row.children().filter(|n| n.is_element() && name(*n) == "c") {
            if cell.children().any(|n| n.is_element() && name(n) == "f") {
                return Err(fail("unsupported_formula"));
            }
            let index = cell
                .attribute("r")
                .and_then(cell_index)
                .unwrap_or(cells.len());
            if index >= 64 {
                return Err(fail("parse_limit"));
            }
            while cells.len() <= index {
                cells.push(String::new());
            }
            let kind = cell.attribute("t").unwrap_or("");
            let raw = if kind == "inlineStr" {
                descendant_text(cell, "t")
            } else {
                descendant_text(cell, "v")
            };
            let value = if kind == "s" {
                let i = raw.parse::<usize>().map_err(|_| fail("invalid_xlsx"))?;
                shared.get(i).ok_or_else(|| fail("invalid_xlsx"))?.clone()
            } else {
                raw
            };
            cells[index] = value;
        }
        if !header_seen {
            headers = cells;
            header_seen = true;
        } else if cells.iter().any(|s| !s.trim().is_empty()) {
            rows.push(ParsedRow { row_number, cells });
        }
    }
    let mut parsed = ParsedFile {
        headers,
        rows,
        warnings: vec![],
        adapter: "money-manager-xlsx-v1",
    };
    validate(&parsed)?;
    if date1904 {
        parsed.warnings.push("excel_1904_date_system".into());
    }
    // Carry the workbook date system through a nonfinancial parser marker.
    parsed.warnings.push(
        if date1904 {
            "date_system_1904"
        } else {
            "date_system_1900"
        }
        .into(),
    );
    Ok(parsed)
}
pub fn bank_statement_xlsx(mut parsed: ParsedFile) -> Result<ParsedFile> {
    let header_index = parsed
        .rows
        .iter()
        .position(|row| {
            let has = |name: &str| {
                row.cells
                    .iter()
                    .any(|v| v.trim().eq_ignore_ascii_case(name))
            };
            has("Date")
                && has("Particulars")
                && has("Withdrawals")
                && has("Deposits")
                && has("Balance")
        })
        .ok_or_else(|| fail("unsupported_statement_layout"))?;
    parsed.headers = parsed.rows[header_index].cells.clone();
    parsed.rows = parsed
        .rows
        .into_iter()
        .skip(header_index + 1)
        .filter(|row| {
            let date = row.at(&parsed.headers, "Date").trim();
            let debit = row.at(&parsed.headers, "Withdrawals").trim();
            let credit = row.at(&parsed.headers, "Deposits").trim();
            !date.is_empty()
                && (!debit.is_empty() || !credit.is_empty())
                && self::date(date, "bank-statement-xlsx-v1", false, Some("DMY")).is_ok()
        })
        .collect();
    if parsed.rows.is_empty() {
        return Err(fail("unsupported_statement_layout"));
    }
    parsed.adapter = "bank-statement-xlsx-v1";
    parsed
        .warnings
        .push("statement_cover_and_totals_rows_ignored".into());
    validate(&parsed)?;
    Ok(parsed)
}
pub fn parse(bytes: &[u8], filename: &str) -> Result<ParsedFile> {
    if filename.to_ascii_lowercase().ends_with(".xlsx") {
        parse_xlsx(bytes)
    } else if filename.to_ascii_lowercase().ends_with(".csv") {
        parse_csv(bytes)
    } else {
        Err(fail("unsupported_file"))
    }
}
pub fn money_manager(parsed: &ParsedFile) -> Result<bool> {
    let required = [
        "Period",
        "Accounts",
        "Category",
        "Income/Expense",
        "Amount",
        "Currency",
    ];
    Ok(required.iter().all(|name| {
        parsed
            .headers
            .iter()
            .any(|h| h.trim().eq_ignore_ascii_case(name))
    }))
}
pub fn serial_date(raw: &str, date1904: bool) -> Result<(String, Option<String>)> {
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 12
    {
        return Err(ApiError::invalid("Invalid Excel serial date."));
    }
    let days: i64 = whole
        .parse()
        .map_err(|_| ApiError::invalid("Date out of range."))?;
    if !date1904 && days == 60 {
        return Err(ApiError::invalid(
            "Excel serial 60 is not a real calendar date.",
        ));
    }
    let base = if date1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1)
    } else if days < 60 {
        NaiveDate::from_ymd_opt(1899, 12, 31)
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30)
    }
    .unwrap();
    let date = base
        .checked_add_signed(Duration::days(days))
        .ok_or_else(|| ApiError::invalid("Date out of range."))?;
    let micros = if fraction.is_empty() {
        0
    } else {
        let frac: u128 = fraction
            .parse()
            .map_err(|_| ApiError::invalid("Invalid Excel time."))?;
        let denominator = 10_u128.pow(fraction.len() as u32);
        ((frac * 86_400_000_000_u128) / denominator) as u64
    };
    let time = if micros == 0 {
        None
    } else {
        let secs = micros / 1_000_000;
        Some(format!(
            "{:02}:{:02}:{:02}.{:06}",
            secs / 3600,
            (secs / 60) % 60,
            secs % 60,
            micros % 1_000_000
        ))
    };
    Ok((date.to_string(), time))
}
pub fn date(
    raw: &str,
    adapter: &str,
    date1904: bool,
    locale: Option<&str>,
) -> Result<(String, Option<String>)> {
    if adapter.contains("xlsx") && raw.parse::<f64>().is_ok() {
        return serial_date(raw, date1904);
    }
    if let Ok(date) = domain::date(raw) {
        return Ok((date.to_string(), None));
    }
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok((
            at.date_naive().to_string(),
            Some(at.time().format("%H:%M:%S%.6f").to_string()),
        ));
    }
    if let Some(locale) = locale {
        let format = match locale {
            "DMY" => "%d/%m/%Y",
            "MDY" => "%m/%d/%Y",
            _ => return Err(ApiError::invalid("Unknown date locale.")),
        };
        if let Ok(date) = NaiveDate::parse_from_str(raw, format) {
            return Ok((date.to_string(), None));
        }
    }
    Err(ApiError::invalid("Date format needs mapping."))
}
pub fn normalize(
    parsed: &ParsedFile,
    row: &ParsedRow,
    source_kind: &str,
    locale: Option<&str>,
) -> Value {
    let date1904 = parsed.warnings.iter().any(|w| w == "date_system_1904");
    let period = row
        .at(
            &parsed.headers,
            if source_kind == "money_manager" {
                "Period"
            } else {
                "Date"
            },
        )
        .trim();
    let (effective_date, local_time, date_error) =
        match date(period, parsed.adapter, date1904, locale) {
            Ok((d, t)) => (Some(d), t, None),
            Err(_) => (None, None, Some("invalid_date")),
        };
    let event_type = if source_kind == "money_manager" {
        match row.at(&parsed.headers, "Income/Expense").trim() {
            "Exp." => "expense",
            "Income" => "income",
            "Transfer-In" => "transfer_in",
            "Transfer-Out" => "transfer_out",
            _ => "unknown",
        }
    } else {
        "unknown"
    };
    let currency = row.at(&parsed.headers, "Currency").trim();
    let amount_raw = row.at(&parsed.headers, "Amount").trim();
    let amount = domain::money(amount_raw, currency).ok().filter(|v| *v > 0);
    let source_account = row.at(&parsed.headers, "Accounts");
    let category = row.at(&parsed.headers, "Category");
    let subcategory = row.at(&parsed.headers, "Subcategory");
    let mut issues = vec![];
    if let Some(error) = date_error {
        issues.push(error);
    }
    if amount.is_none() {
        issues.push("invalid_amount");
    }
    if event_type == "unknown" && source_kind == "money_manager" {
        issues.push("unknown_event_type");
    }
    if source_kind == "money_manager"
        && currency == "INR"
        && parsed.headers.iter().any(|h| h == "INR")
        && domain::money(row.at(&parsed.headers, "INR").trim(), currency).ok() != amount
    {
        issues.push("inr_amount_disagreement");
    }
    let source_description = row.at(&parsed.headers, "Description");
    let note = row.at(&parsed.headers, "Note");
    let description = if source_description.trim().is_empty() {
        note
    } else {
        source_description
    };
    json!({"source_kind":source_kind,"event_type":event_type,"effective_date":effective_date,"local_time":local_time,"currency":currency,"amount":amount.map(|v|domain::format_money(v,currency).unwrap()),"signed_movement":amount.map(|v|domain::format_money(if event_type=="expense"||event_type=="transfer_out"{-v}else{v},currency).unwrap()),"source_account":source_account,"source_category":category,"source_subcategory":subcategory,"description":description,"source_description":source_description,"note":note,"issues":issues,"proposed_action":if source_kind=="money_manager"{"create_ledger_event"}else{"store_observation"}})
}
pub(crate) fn legacy_fingerprint(row: &Value) -> String {
    let signature = json!({"event_type":row["event_type"],"effective_date":row["effective_date"],"currency":row["currency"],"amount":row["amount"],"source_account":row["source_account"],"source_category":row["source_category"],"source_subcategory":row["source_subcategory"],"description":row.get("source_description").unwrap_or(&row["description"]),"note":row["note"]});
    crate::auth::hash(&signature.to_string())
}
pub fn fingerprint(row: &Value) -> String {
    let legacy = legacy_fingerprint(row);
    if row["event_type"] == "observation" {
        crate::auth::hash(&json!({"legacy":legacy,"signed_movement":row["signed_movement"],"reference":row["reference"]}).to_string())
    } else {
        legacy
    }
}
pub fn occurrence_numbers(rows: &[Value]) -> Vec<usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    rows.iter()
        .map(|r| {
            let fp = fingerprint(r);
            let counter = counts.entry(fp).or_default();
            *counter += 1;
            *counter
        })
        .collect()
}
