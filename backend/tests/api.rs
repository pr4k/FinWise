use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use finwise_api::{AppState, connect, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::path::Path;
use tower::ServiceExt;

#[tokio::test]
async fn analytics_dashboard_matches_individual_reports() {
    let (client, _) = setup().await;
    let account = client.account("Checking", "bank").await;
    let category = client.category("Groceries", "expense").await;
    let mut entry = transaction("expense", "42.00", &account, &category, "personal");
    entry["effective_date"] = json!("2026-10-08");
    client.create("transactions", entry).await;
    let query = "from=2026-10-01&to=2026-11-01&scope=personal&currency=INR";
    let dashboard = client.call("GET", &format!("analytics/dashboard?{query}"), json!({}), None, None).await;
    assert_eq!(dashboard.0, StatusCode::OK, "{}", dashboard.1);
    for report in ["summary", "categories", "income-categories", "merchants", "series", "types", "accounts"] {
        let suffix = if report == "series" { "&grain=day" } else { "" };
        let individual = client.call("GET", &format!("analytics/{report}?{query}{suffix}"), json!({}), None, None).await;
        assert_eq!(individual.0, StatusCode::OK, "{}", individual.1);
        if report == "summary" {
            assert_eq!(dashboard.1[report]["net_spending"], individual.1["net_spending"]);
        } else if report == "accounts" {
            assert_eq!(dashboard.1[report]["data"][0]["signed_movements"], individual.1["data"][0]["signed_movements"]);
            assert_eq!(dashboard.1[report]["data"][0]["balance"]["amount"], individual.1["data"][0]["balance"]["amount"]);
        } else {
            assert_eq!(dashboard.1[report]["data"], individual.1["data"], "{report}");
        }
    }
}

#[tokio::test]
async fn household_report_groups_visible_activity_and_opted_in_investments() {
    let (client, _) = setup().await;
    let account = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let salary = client.category("Salary", "income").await;
    for (kind, amount, category, scope) in [
        ("expense", "120.00", &food, "personal"),
        ("expense", "80.00", &food, "family"),
        ("income", "500.00", &salary, "family"),
    ] {
        let mut entry = transaction(kind, amount, &account, category, scope);
        entry["effective_date"] = json!("2026-10-08");
        client.create("transactions", entry).await;
    }
    let private = client
        .create(
            "investments",
            json!({"name":"Private fund","type":"investment","currency":"INR"}),
        )
        .await;
    let shared = client.create("investments",json!({"name":"Shared fund","type":"investment","currency":"INR","visibility":"shared"})).await;
    for (i, holding) in [private, shared].iter().enumerate() {
        let path = format!(
            "investments/{}/months/2026-10",
            holding["id"].as_str().unwrap()
        );
        let record = json!({"contribution":if i==0 {"20.00"} else {"30.00"},"withdrawal":"0.00","value":"50.00"});
        assert_eq!(
            client
                .call(
                    "PUT",
                    &path,
                    record,
                    Some(&format!("household-holding-{i}")),
                    Some(1)
                )
                .await
                .0,
            StatusCode::OK
        );
    }
    let response = client
        .call(
            "GET",
            "analytics/household?from=2026-10-01&to=2026-11-01&currency=INR",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    let member = &response.1["data"][0];
    assert_eq!(member["income"], "500.00");
    assert_eq!(member["net_spending"], "200.00");
    assert_eq!(member["net_invested"], "50.00");
    assert_eq!(member["categories"][0]["amount"], "200.00");
}

#[tokio::test]
async fn household_report_respects_other_members_private_records() {
    let (owner, _) = setup().await;
    let (member, _) = partner(&owner).await;
    let account = owner
        .create(
            "accounts",
            json!({"name":"Shared cash","subtype":"cash","currency":"INR","visibility":"shared"}),
        )
        .await;
    let food = owner.category("Food", "expense").await;
    for (client, amount, scope) in [
        (&owner, "60.00", "family"),
        (&member, "20.00", "personal"),
        (&member, "30.00", "family"),
    ] {
        let mut entry = transaction("expense", amount, &account, &food, scope);
        entry["effective_date"] = json!("2026-10-08");
        client.create("transactions", entry).await;
    }
    let private = member
        .create(
            "investments",
            json!({"name":"Private","type":"investment","currency":"INR"}),
        )
        .await;
    let shared = member
        .create(
            "investments",
            json!({"name":"Shared","type":"investment","currency":"INR","visibility":"shared"}),
        )
        .await;
    for (holding, amount) in [(&private, "40.00"), (&shared, "50.00")] {
        let path = format!(
            "investments/{}/months/2026-10",
            holding["id"].as_str().unwrap()
        );
        let response = member
            .call(
                "PUT",
                &path,
                json!({"contribution":amount,"withdrawal":"0","value":amount}),
                None,
                Some(1),
            )
            .await;
        assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    }
    let path = "analytics/household?from=2026-10-01&to=2026-11-01&currency=INR";
    let owner_report = owner.call("GET", path, json!({}), None, None).await.1;
    let member_report = member.call("GET", path, json!({}), None, None).await.1;
    let owner_id = owner.call("GET", "me", json!({}), None, None).await.1["user"]["id"].clone();
    let member_id = member.call("GET", "me", json!({}), None, None).await.1["user"]["id"].clone();
    let row = |report: &Value, id: &Value| {
        report["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == *id)
            .unwrap()
            .clone()
    };
    assert_eq!(row(&owner_report, &member_id)["net_spending"], "30.00");
    assert_eq!(row(&owner_report, &member_id)["net_invested"], "50.00");
    assert_eq!(row(&member_report, &member_id)["net_spending"], "50.00");
    assert_eq!(row(&member_report, &member_id)["net_invested"], "90.00");
    assert_eq!(row(&member_report, &owner_id)["net_spending"], "60.00");
}

#[tokio::test]
async fn recurring_payments_combine_ledger_and_bank_evidence_and_keep_subscription_tag() {
    let (client, pool) = setup().await;
    let account = client.account("Card", "credit_card").await;
    let category = client.category("Entertainment", "expense").await;
    for date in ["2026-01-05", "2026-02-05"] {
        let mut value = transaction("expense", "499.00", &account, &category, "personal");
        value["effective_date"] = json!(date);
        value["description"] = json!("Netflix");
        client.create("transactions", value).await;
    }
    let me = client.call("GET", "me", json!({}), None, None).await.1;
    let household = me["household"]["id"].as_str().unwrap();
    let account_id = account["id"].as_str().unwrap();
    for (index, date) in ["2026-01-05", "2026-03-05"].iter().enumerate() {
        let occurrence = format!("recurring-observation-{index}");
        sqlx::query("INSERT INTO import_occurrences(id,household_id,account_id,fingerprint,occurrence,source_refs_json) VALUES(?,?,?,?,?,?)")
            .bind(&occurrence).bind(household).bind(account_id).bind(&occurrence).bind(1_i64).bind("[]").execute(&pool).await.unwrap();
        let document = json!({"id":occurrence,"account_id":account_id,"effective_date":date,"currency":"INR","amount":"-499.00","description":"UPI/NETFLIX 12345/Payment"});
        sqlx::query("INSERT INTO bank_observations(id,household_id,account_id,effective_date,currency,amount_minor,document) VALUES(?,?,?,?,?,?,?)")
            .bind(&occurrence).bind(household).bind(account_id).bind(date).bind("INR").bind(-49900_i64).bind(document.to_string()).execute(&pool).await.unwrap();
    }
    let listed = client
        .call("GET", "recurring-transactions", json!({}), None, None)
        .await;
    assert_eq!(listed.0, StatusCode::OK, "{}", listed.1);
    let rows = listed.1["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["count"], 3);
    assert_eq!(rows[0]["frequency"], "monthly");
    let path = format!(
        "recurring-transactions/{}",
        rows[0]["key"].as_str().unwrap()
    );
    let tagged = client
        .call("PUT", &path, json!({"subscription":true}), None, None)
        .await;
    assert_eq!(tagged.0, StatusCode::OK, "{}", tagged.1);
    assert_eq!(tagged.1["ignored"], false);
    assert_eq!(
        client
            .call("GET", "recurring-transactions", json!({}), None, None)
            .await
            .1["data"][0]["subscription"],
        true
    );
    let ignored = client.call("PUT", &path, json!({"ignored":true}), None, None).await;
    assert_eq!(ignored.0, StatusCode::OK, "{}", ignored.1);
    assert_eq!(ignored.1["ignored"], true);
    assert_eq!(ignored.1["subscription"], false);
    let retained = client.call("GET", "recurring-transactions", json!({}), None, None).await.1;
    assert_eq!(retained["data"][0]["ignored"], true);
    let restored = client.call("PUT", &path, json!({"ignored":false}), None, None).await;
    assert_eq!(restored.0, StatusCode::OK, "{}", restored.1);
    assert_eq!(restored.1["ignored"], false);
    assert_eq!(restored.1["subscription"], false);
}

#[tokio::test]
async fn bulk_scope_moves_selected_allocations_and_preserves_ledger() {
    let (client, _) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Food", "expense").await;
    let first = client
        .transaction("expense", "120.00", &account, &category, "personal")
        .await;
    let second = client
        .transaction("expense", "75.00", &account, &category, "personal")
        .await;
    let bad = client
        .call(
            "POST",
            "transactions/bulk-scope",
            json!({"ids":[first["id"],"missing"],"scope":"family"}),
            Some("bad-bulk-scope"),
            None,
        )
        .await;
    assert_eq!(bad.0, StatusCode::NOT_FOUND);
    let path = format!("transactions/{}", first["id"].as_str().unwrap());
    assert_eq!(
        client.call("GET", &path, json!({}), None, None).await.1["allocations"][0]["scope"],
        "personal"
    );
    let moved = client
        .call(
            "POST",
            "transactions/bulk-scope",
            json!({"ids":[first["id"]],"scope":"family"}),
            Some("bulk-scope"),
            None,
        )
        .await;
    assert_eq!(moved.0, StatusCode::OK, "{}", moved.1);
    assert_eq!(moved.1["updated"], 1);
    let after = client.call("GET", &path, json!({}), None, None).await.1;
    assert_eq!(after["allocations"][0]["scope"], "family");
    assert_eq!(after["movements"], first["movements"]);
    assert_eq!(after["reconciliation_state"], first["reconciliation_state"]);
    assert_eq!(after["revision"], 2);
    let untouched = client
        .call(
            "GET",
            &format!("transactions/{}", second["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(untouched["allocations"][0]["scope"], "personal");
}

#[tokio::test]
async fn money_manager_import_applies_family_scope_to_all_new_allocations() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let cash = client.account("Cash", "cash").await;
    let food = client.category("Food", "expense").await;
    let salary = client.category("Salary", "income").await;
    let mapping = json!({"allocation_scope":"family","account_aliases":{"Bank":bank["id"],"Cash":cash["id"]},"category_mappings":[{"source_label":"Food","event_kind":"expense","category_id":food["id"]},{"source_label":"Salary","event_kind":"income","category_id":salary["id"]}]});
    let (status, uploaded) = upload_file(
        &client,
        json!({"files":[{"source_kind":"money_manager","mapping":mapping}]}),
        "month.xlsx",
        include_bytes!("fixtures/money-manager-synthetic.xlsx"),
        "family-import",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let batch = uploaded["id"].as_str().unwrap();
    let file = uploaded["files"][0]["id"].as_str().unwrap();
    wait_for_file(&client, batch, file).await;
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("family-commit"),
            None,
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    let transactions = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(transactions["data"].as_array().unwrap().len(), 4);
    assert!(
        transactions["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["event_type"] != "transfer")
            .all(|t| t["allocations"][0]["scope"] == "family")
    );
}

#[tokio::test]
async fn settlement_splits_and_repayments_preserve_each_persons_balance() {
    let (client, _) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Meals", "expense").await;
    let expense = client
        .transaction("expense", "900.00", &account, &category, "personal")
        .await;
    let bad=client.call("POST","settle-ups/splits",json!({"description":"Dinner","date":"2026-10-08","currency":"INR","total":"900.00","my_share":"300.00","shares":[{"person":"Alex","amount":"200.00"}]}),Some("bad-split"),None).await;
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
    let split=client.create("settle-ups/splits",json!({"description":"Dinner","date":"2026-10-08","currency":"INR","total":"900.00","my_share":"300.00","transaction_id":expense["id"],"shares":[{"person":"Alex","amount":"250.00"},{"person":"Sam","amount":"350.00"}]})).await;
    let duplicate=client.call("POST","settle-ups/splits",json!({"description":"Dinner","date":"2026-10-08","currency":"INR","total":"900.00","my_share":"300.00","transaction_id":expense["id"],"shares":[{"person":"Alex","amount":"600.00"}]}),Some("duplicate-split"),None).await;
    assert_eq!(duplicate.0, StatusCode::CONFLICT);
    let ledger = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(ledger["data"].as_array().unwrap().len(), 1);
    let alex = &split["obligations"][0];
    assert_eq!(alex["remaining"], "250.00");
    let path = format!("settle-ups/{}/repayments", alex["id"].as_str().unwrap());
    let paid = client
        .call(
            "POST",
            &path,
            json!({"amount":"100.00","date":"2026-10-09"}),
            Some("alex-paid"),
            Some(1),
        )
        .await;
    assert_eq!(paid.0, StatusCode::OK, "{}", paid.1);
    assert_eq!(paid.1["remaining"], "150.00");
    let too_small = client
        .call(
            "PATCH",
            &format!("settle-ups/{}", alex["id"].as_str().unwrap()),
            json!({"amount":"50.00"}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(too_small.0, StatusCode::BAD_REQUEST);
    let remove_path = format!(
        "settle-ups/{}/repayments/{}",
        alex["id"].as_str().unwrap(),
        paid.1["repayments"][0]["id"].as_str().unwrap()
    );
    let removed = client
        .call("DELETE", &remove_path, json!({}), None, Some(2))
        .await;
    assert_eq!(removed.0, StatusCode::NO_CONTENT, "{}", removed.1);
    let reopened = client
        .call(
            "GET",
            &format!("settle-ups/{}", alex["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(reopened.1["remaining"], "250.00");
    let excessive = client
        .call(
            "POST",
            &path,
            json!({"amount":"251.00","date":"2026-10-10"}),
            Some("too-much"),
            Some(3),
        )
        .await;
    assert_eq!(excessive.0, StatusCode::BAD_REQUEST);
    let listed = client
        .call("GET", "settle-ups", json!({}), None, None)
        .await
        .1;
    assert_eq!(listed["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["person"] == "Sam")
            .unwrap()["remaining"],
        "350.00"
    );
}

#[tokio::test]
async fn investment_months_calculate_net_additions_and_value_change() {
    let (client, _) = setup().await;
    let fund=client.create("investments",json!({"name":"Emergency fund","type":"emergency_fund","currency":"INR","target":"10000.00"})).await;
    let path = format!(
        "investments/{}/months/2026-09",
        fund["id"].as_str().unwrap()
    );
    let first = client
        .call(
            "PUT",
            &path,
            json!({"contribution":"1000.00","withdrawal":"0","value":"1010.00"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(first.1["gain_loss"], "10.00");
    let path2 = format!(
        "investments/{}/months/2026-10",
        fund["id"].as_str().unwrap()
    );
    let second = client
        .call(
            "PUT",
            &path2,
            json!({"contribution":"200.00","withdrawal":"100.00","value":"1140.00"}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(second.0, StatusCode::OK, "{}", second.1);
    assert_eq!(second.1["net_contributions"], "1100.00");
    assert_eq!(second.1["gain_loss"], "40.00");
    let invalid = client
        .call(
            "PUT",
            &path2,
            json!({"contribution":"0","withdrawal":"2000.00","value":"0"}),
            None,
            Some(3),
        )
        .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    let corrected = client
        .call(
            "PUT",
            &path2,
            json!({"contribution":"200.00","withdrawal":"100.00","value":"1150.00"}),
            None,
            Some(3),
        )
        .await;
    assert_eq!(corrected.0, StatusCode::OK, "{}", corrected.1);
    assert_eq!(corrected.1["gain_loss"], "50.00");
    assert_eq!(corrected.1["records"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn split_paid_by_another_person_records_only_my_payable() {
    let (client, _) = setup().await;
    let split=client.create("settle-ups/splits",json!({"description":"Trip","date":"2026-10-08","currency":"INR","total":"1200.00","my_share":"400.00","paid_by":"Alex","shares":[{"person":"Alex","amount":"500.00"},{"person":"Sam","amount":"300.00"}]})).await;
    assert_eq!(split["obligations"].as_array().unwrap().len(), 1);
    assert_eq!(split["obligations"][0]["person"], "Alex");
    assert_eq!(split["obligations"][0]["direction"], "i_owe");
    assert_eq!(split["obligations"][0]["remaining"], "400.00");
}

#[tokio::test]
async fn deleting_a_split_hides_every_obligation_and_keeps_the_expense() {
    let (client, pool) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Meals", "expense").await;
    let expense = client
        .transaction("expense", "90.00", &account, &category, "personal")
        .await;
    let body = json!({"description":"Dinner","date":"2026-10-08","currency":"INR","total":"90.00","my_share":"30.00","transaction_id":expense["id"],"shares":[{"person":"Alex","amount":"25.00"},{"person":"Sam","amount":"35.00"}]});
    let split = client.create("settle-ups/splits", body.clone()).await;
    let anchor = split["obligations"][0]["id"].as_str().unwrap();
    let stale = client
        .call(
            "DELETE",
            &format!("settle-ups/{anchor}"),
            json!({}),
            None,
            Some(99),
        )
        .await;
    assert_eq!(stale.0, StatusCode::CONFLICT);
    let removed = client
        .call(
            "DELETE",
            &format!("settle-ups/{anchor}"),
            json!({}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(removed.0, StatusCode::NO_CONTENT);
    let list = client
        .call("GET", "settle-ups", json!({}), None, None)
        .await
        .1;
    assert!(list["data"].as_array().unwrap().is_empty());
    let missing = client
        .call(
            "GET",
            &format!("settle-ups/{anchor}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(missing.0, StatusCode::NOT_FOUND);
    let ledger = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(ledger["data"].as_array().unwrap().len(), 1);
    client.create("settle-ups/splits", body).await;
    let audit_count:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action='delete' AND resource_id IN (SELECT id FROM resources WHERE kind='settlement_obligations')").fetch_one(&pool).await.unwrap();
    assert_eq!(audit_count, 2);
}

#[tokio::test]
async fn investment_month_and_holding_deletion_recalculate_and_hide() {
    let (client, pool) = setup().await;
    let investment = client
        .create(
            "investments",
            json!({"name":"Fund","type":"investment","currency":"INR"}),
        )
        .await;
    let key = investment["id"].as_str().unwrap();
    let september = client
        .call(
            "PUT",
            &format!("investments/{key}/months/2026-09"),
            json!({"contribution":"1000.00","withdrawal":"0","value":"1010.00"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(september.0, StatusCode::OK);
    let october = client
        .call(
            "PUT",
            &format!("investments/{key}/months/2026-10"),
            json!({"contribution":"0","withdrawal":"100.00","value":"920.00"}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(october.0, StatusCode::OK);
    let invalid = client
        .call(
            "DELETE",
            &format!("investments/{key}/months/2026-09"),
            json!({}),
            None,
            Some(3),
        )
        .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    let removed = client
        .call(
            "DELETE",
            &format!("investments/{key}/months/2026-10"),
            json!({}),
            None,
            Some(3),
        )
        .await;
    assert_eq!(removed.0, StatusCode::NO_CONTENT);
    let detail = client
        .call("GET", &format!("investments/{key}"), json!({}), None, None)
        .await
        .1;
    assert_eq!(detail["records"].as_array().unwrap().len(), 1);
    assert_eq!(detail["gain_loss"], "10.00");
    let deleted = client
        .call(
            "DELETE",
            &format!("investments/{key}"),
            json!({}),
            None,
            Some(4),
        )
        .await;
    assert_eq!(deleted.0, StatusCode::NO_CONTENT);
    assert!(
        client
            .call("GET", "investments", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        client
            .call("GET", &format!("investments/{key}"), json!({}), None, None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let audit_count:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE resource_id=? AND action IN ('monthly_valuation_removed','delete')").bind(key).fetch_one(&pool).await.unwrap();
    assert_eq!(audit_count, 2);
}

#[tokio::test]
async fn monthly_reset_clears_selected_activity_and_allows_reimport() {
    let (client, pool) = setup().await;
    let bank = client.account("Reset bank", "bank").await;
    let food = client.category("Reset food", "expense").await;
    let first = client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    for date in ["2026-10-15", "2026-11-15"] {
        let mut entry = transaction("expense", "7.00", &bank, &food, "personal");
        entry["effective_date"] = json!(date);
        client.create("transactions", entry).await;
    }
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let matched = client
        .call(
            "POST",
            &format!(
                "reconciliation/sessions/{}/auto-match",
                session["id"].as_str().unwrap()
            ),
            json!({}),
            Some("reset-match"),
            Some(1),
        )
        .await;
    assert_eq!(matched.0, StatusCode::OK, "{}", matched.1);
    assert_eq!(matched.1["matched_count"], 1);
    for month in ["2026-09", "2026-10", "2026-11"] {
        client.create("budgets", json!({"name":"Reset budget","month":month,"scope":"personal","currency":"INR","expected_income":"100.00","lines":[{"category_id":food["id"],"amount":"50.00"}]})).await;
    }
    // UTC September, but October in the account's household timezone: must survive.
    let check_path = format!("accounts/{}/balance-checks", bank["id"].as_str().unwrap());
    for (index, (key, at)) in [
        ("sept-check", "2026-09-30T23:30:00+05:30"),
        ("oct-check", "2026-10-01T01:30:00+05:30"),
    ]
    .into_iter()
    .enumerate()
    {
        let check = client
            .call(
                "POST",
                &check_path,
                json!({"amount":"100.00","basis":"posted","as_of":at,"timezone":"Asia/Kolkata"}),
                Some(key),
                Some(index as i64 + 1),
            )
            .await;
        assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    }
    let body = json!({"months":["2026-11","2026-09","2026-09"]});
    let preview = client
        .call(
            "POST",
            "data/reset-preview",
            body.clone(),
            Some("reset-preview"),
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["months"], json!(["2026-09", "2026-11"]));
    assert_eq!(preview.1["counts"]["transactions"], 2);
    assert_eq!(preview.1["counts"]["balance_checks"], 1);
    assert_eq!(preview.1["counts"]["budgets"], 2);
    assert_eq!(preview.1["counts"]["statement_entries"], 2);
    let apply = json!({"months":body["months"],"preview_token":preview.1["preview_token"],"confirmation":"RESET"});
    let reset = client
        .call(
            "POST",
            "data/reset",
            apply.clone(),
            Some("reset-apply"),
            None,
        )
        .await;
    assert_eq!(reset.0, StatusCode::OK, "{}", reset.1);
    let replay = client
        .call("POST", "data/reset", apply, Some("reset-apply"), None)
        .await;
    assert_eq!(reset.1, replay.1);
    let transactions = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(transactions["data"].as_array().unwrap().len(), 1);
    assert_eq!(transactions["data"][0]["effective_date"], "2026-10-15");
    let budgets = client.call("GET", "budgets", json!({}), None, None).await.1;
    assert_eq!(budgets["data"].as_array().unwrap().len(), 1);
    assert_eq!(budgets["data"][0]["month"], "2026-10");
    let checks = client
        .call("GET", &check_path, json!({}), None, None)
        .await
        .1;
    assert_eq!(
        checks["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["voided"] != true)
            .count(),
        1
    );
    for table in [
        "bank_observations",
        "reconciliation_links",
        "import_occurrences",
        "import_rows",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    let files: i64 = sqlx::query_scalar("SELECT count(*) FROM source_files")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(files, 1);
    let history = client
        .call(
            "GET",
            &format!("transactions/{}/revisions", first["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(history.0, StatusCode::OK);
    assert!(
        history.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["action"] == "monthly_data_reset")
    );
    let sessions = client
        .call("GET", "reconciliation/sessions", json!({}), None, None)
        .await
        .1;
    assert!(sessions["data"].as_array().unwrap().is_empty());
    let statements = client
        .call(
            "GET",
            &format!("accounts/{}/statement-months", bank["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert!(statements["data"].as_array().unwrap().is_empty());
    bank_evidence(&client, &bank).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM bank_observations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
}

#[tokio::test]
async fn monthly_reset_validates_confirmation_freshness_and_private_access() {
    let (owner, pool) = setup().await;
    let (member, _) = partner(&owner).await;
    let own = owner.account("Own", "cash").await;
    let private = member.account("Private", "cash").await;
    let food = owner.category("Food", "expense").await;
    owner
        .transaction("expense", "10.00", &own, &food, "personal")
        .await;
    let private_tx = member
        .transaction("expense", "20.00", &private, &food, "personal")
        .await;
    for months in [
        json!([]),
        json!(["2026-13"]),
        json!(["2026-9"]),
        json!(["€éxx"]),
        json!(vec!["2026-09"; 25]),
    ] {
        assert_eq!(
            owner
                .call(
                    "POST",
                    "data/reset-preview",
                    json!({"months":months}),
                    Some(&uuid::Uuid::new_v4().to_string()),
                    None
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let body = json!({"months":["2026-09"]});
    assert_eq!(
        member
            .call(
                "POST",
                "data/reset-preview",
                body.clone(),
                Some("member-reset"),
                None
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let preview = owner
        .call("POST", "data/reset-preview", body.clone(), Some("p1"), None)
        .await
        .1;
    assert_eq!(preview["counts"]["transactions"], 1);
    let apply = json!({"months":body["months"],"preview_token":preview["preview_token"],"confirmation":"RESET"});
    let mut bad = apply.clone();
    bad["confirmation"] = json!("yes");
    assert_eq!(
        owner
            .call("POST", "data/reset", bad, Some("bad-confirm"), None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    owner
        .transaction("expense", "5.00", &own, &food, "personal")
        .await;
    assert_eq!(
        owner
            .call("POST", "data/reset", apply, Some("stale-reset"), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions' AND json_extract(document,'$.voided') IS NOT 1").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 3);
    let preview = owner
        .call("POST", "data/reset-preview", body.clone(), Some("p2"), None)
        .await
        .1;
    let reset=owner.call("POST","data/reset",json!({"months":body["months"],"preview_token":preview["preview_token"],"confirmation":"RESET"}),Some("apply2"),None).await;
    assert_eq!(reset.0, StatusCode::OK, "{}", reset.1);
    let remaining = member
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(remaining["data"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["data"][0]["id"], private_tx["id"]);
}

#[tokio::test]
async fn monthly_reset_blocks_closed_sessions_and_rolls_back_on_failure() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let entry = client
        .transaction("expense", "10.00", &bank, &food, "personal")
        .await;
    client.create("budgets",json!({"month":"2026-09","scope":"personal","currency":"INR","expected_income":"100.00","lines":[]})).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    sqlx::query("UPDATE resources SET document=json_set(document,'$.state','closed') WHERE id=?")
        .bind(session["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let months = json!({"months":["2026-09"]});
    assert_eq!(
        client
            .call(
                "POST",
                "data/reset-preview",
                months.clone(),
                Some("closed-preview"),
                None
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE resources SET document=json_set(document,'$.state','open') WHERE id=?")
        .bind(session["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let preview = client
        .call(
            "POST",
            "data/reset-preview",
            months.clone(),
            Some("open-preview"),
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK);
    // Inject a late storage failure, after ledger entries have been voided.
    sqlx::query("CREATE TRIGGER fail_reset BEFORE DELETE ON resources WHEN OLD.kind='budgets' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").execute(&pool).await.unwrap();
    let request = json!({"months":months["months"],"preview_token":preview.1["preview_token"],"confirmation":"RESET"});
    assert_eq!(
        client
            .call(
                "POST",
                "data/reset",
                request.clone(),
                Some("atomic-reset"),
                None
            )
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let unchanged = client
        .call(
            "GET",
            &format!("transactions/{}", entry["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(unchanged["voided"], false);
    assert_eq!(unchanged["revision"], entry["revision"]);
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action='monthly_data_reset'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audits, 0);
    sqlx::query("DROP TRIGGER fail_reset")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        client
            .call("POST", "data/reset", request, Some("atomic-reset"), None)
            .await
            .0,
        StatusCode::OK
    );
}

#[derive(Clone)]
struct Client {
    app: Router,
    cookie: String,
    csrf: String,
}
impl Client {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        key: Option<&str>,
        revision: Option<i64>,
    ) -> (StatusCode, Value, HeaderMap) {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/api/v1/{path}"))
            .header("content-type", "application/json")
            .header("x-request-id", "integration-test");
        if !self.cookie.is_empty() {
            req = req
                .header("cookie", &self.cookie)
                .header("x-csrf-token", &self.csrf);
        }
        if let Some(k) = key {
            req = req.header("idempotency-key", k);
        }
        if let Some(r) = revision {
            req = req.header("if-match", r.to_string());
        }
        let response = self
            .app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        assert_eq!(headers["cache-control"], "no-store");
        assert_eq!(headers["x-request-id"], "integration-test");
        (status, value, headers)
    }
    async fn create(&self, kind: &str, v: Value) -> Value {
        let (status, body, _) = self
            .call(
                "POST",
                kind,
                v,
                Some(&uuid::Uuid::new_v4().to_string()),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
    }
    async fn account(&self, name: &str, subtype: &str) -> Value {
        self.create(
            "accounts",
            json!({"name":name,"subtype":subtype,"currency":"INR"}),
        )
        .await
    }
    async fn category(&self, name: &str, kind: &str) -> Value {
        self.create("categories", json!({"name":name,"kind":kind}))
            .await
    }
    async fn transaction(
        &self,
        kind: &str,
        amount: &str,
        account: &Value,
        category: &Value,
        scope: &str,
    ) -> Value {
        self.create(
            "transactions",
            transaction(kind, amount, account, category, scope),
        )
        .await
    }
}
fn setup_body() -> Value {
    json!({"owner":{"name":"Owner","email":"owner@example.test","password":"synthetic-password-123"},"household":{"name":"Home","timezone":"Asia/Kolkata","base_currency":"INR"}})
}
async fn setup() -> (Client, sqlx::SqlitePool) {
    let pool = connect("sqlite::memory:").await.unwrap();
    let mut client = Client {
        app: router(
            AppState {
                pool: pool.clone(),
                secure_cookies: true,
            },
            Path::new("../web"),
        ),
        cookie: String::new(),
        csrf: String::new(),
    };
    let (status, body, headers) = client
        .call(
            "POST",
            "auth/bootstrap",
            setup_body(),
            Some("bootstrap"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let cookie = headers["set-cookie"].to_str().unwrap();
    for flag in ["HttpOnly", "Secure", "SameSite=Lax"] {
        assert!(cookie.contains(flag));
    }
    client.cookie = cookie.split(';').next().unwrap().into();
    client.csrf = body["csrf_token"].as_str().unwrap().into();
    (client, pool)
}

#[tokio::test]
async fn opted_in_http_bootstrap_uses_a_non_secure_session_cookie() {
    let pool = connect("sqlite::memory:").await.unwrap();
    let mut client = Client {
        app: router(
            AppState {
                pool,
                secure_cookies: false,
            },
            Path::new("../web"),
        ),
        cookie: String::new(),
        csrf: String::new(),
    };
    let (status, mode, _) = client
        .call("GET", "auth/bootstrap-status", json!({}), None, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mode["required"], true);
    assert_eq!(mode["requires_https"], false);

    let (status, body, headers) = client
        .call(
            "POST",
            "auth/bootstrap",
            setup_body(),
            Some("http-bootstrap"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let cookie = headers["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(!cookie.contains("; Secure"));
    client.cookie = cookie.split(';').next().unwrap().into();
    client.csrf = body["csrf_token"].as_str().unwrap().into();
    assert_eq!(
        client.call("GET", "me", json!({}), None, None).await.0,
        StatusCode::OK
    );
}
fn transaction(kind: &str, amount: &str, account: &Value, category: &Value, scope: &str) -> Value {
    json!({"event_type":kind,"amount":amount,"currency":"INR","effective_date":"2026-09-15","description":"Synthetic entry","allocations":[{"category_id":category["id"],"amount":amount,"scope":scope}],"movements":[{"account_id":account["id"],"amount":if kind=="expense"{format!("-{amount}")}else{amount.to_owned()}}]})
}

#[tokio::test]
async fn authentication_rotation_csrf_and_error_contract() {
    let (client, pool) = setup().await;
    let bootstrap_status = client
        .call("GET", "auth/bootstrap-status", json!({}), None, None)
        .await
        .1;
    assert_eq!(bootstrap_status["required"], false);
    assert_eq!(bootstrap_status["requires_https"], true);
    assert_eq!(
        client
            .call(
                "POST",
                "auth/bootstrap",
                setup_body(),
                Some("second-bootstrap"),
                None
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut no_csrf = client.clone();
    no_csrf.csrf.clear();
    assert_eq!(
        no_csrf
            .call("POST", "accounts", json!({}), Some("csrf"), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, error, headers) = client
        .call("GET", "does-not-exist", json!({}), None, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["error"]["code"], "not_found");
    assert_eq!(error["request_id"], "integration-test");
    assert_eq!(headers["content-type"], "application/json; charset=utf-8");
    let (status, body, headers) = client
        .call(
            "POST",
            "auth/login",
            json!({"email":"owner@example.test","password":"synthetic-password-123"}),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(body["csrf_token"], client.csrf);
    assert_ne!(
        headers["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap(),
        client.cookie
    );
    assert_eq!(
        client.call("GET", "me", json!({}), None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM sessions LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!headers["set-cookie"].to_str().unwrap().contains(&stored));
}

#[tokio::test]
async fn idempotency_atomic_revisions_and_concurrent_edits() {
    let (client, pool) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Food", "expense").await;
    let input = transaction("expense", "1250.00", &account, &category, "personal");
    let a = client
        .call(
            "POST",
            "transactions",
            input.clone(),
            Some("purchase"),
            None,
        )
        .await;
    let b = client
        .call(
            "POST",
            "transactions",
            input.clone(),
            Some("purchase"),
            None,
        )
        .await;
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(a.1, b.1);
    let mut different = input.clone();
    different["description"] = json!("Changed");
    let conflict = client
        .call("POST", "transactions", different, Some("purchase"), None)
        .await;
    assert_eq!(conflict.1["error"]["code"], "idempotency_key_reused");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let path = format!("transactions/{}", a.1["id"].as_str().unwrap());
    let (left, right) = tokio::join!(
        client.call(
            "PATCH",
            &path,
            json!({"description":"First"}),
            None,
            Some(1)
        ),
        client.call(
            "PATCH",
            &path,
            json!({"description":"Second"}),
            None,
            Some(1)
        )
    );
    assert!(
        (left.0 == StatusCode::OK && right.0 == StatusCode::CONFLICT)
            || (right.0 == StatusCode::OK && left.0 == StatusCode::CONFLICT)
    );
    let conflict = if left.0 == StatusCode::CONFLICT {
        left
    } else {
        right
    };
    assert_eq!(conflict.1["error"]["current_revision"], 2);
    let history = client
        .call("GET", &format!("{path}/revisions"), json!({}), None, None)
        .await
        .1;
    assert_eq!(history["data"].as_array().unwrap().len(), 2);
    let void = client
        .call(
            "POST",
            &format!("{path}/void"),
            json!({"reason":"mistake"}),
            Some("void"),
            Some(2),
        )
        .await;
    assert_eq!(void.0, StatusCode::OK);
    assert_eq!(void.1["revision"], 3);
    assert!(
        client
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        client.call("GET", &path, json!({}), None, None).await.1["voided"],
        true
    );
}

#[tokio::test]
async fn ledger_validation_and_failed_writes_rollback() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let card = client.account("Card", "credit_card").await;
    let category = client.category("Food", "expense").await;
    let mut bad = transaction("expense", "20.00", &bank, &category, "personal");
    bad["allocations"][0]["amount"] = json!("19.00");
    assert_eq!(
        client
            .call("POST", "transactions", bad, Some("bad"), None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let expense = client
        .transaction("expense", "20.00", &bank, &category, "personal")
        .await;
    let path = format!("transactions/{}", expense["id"].as_str().unwrap());
    let convert = json!({"event_type":"transfer","allocations":[],"movements":[{"account_id":bank["id"],"amount":"-20.00"},{"account_id":card["id"],"amount":"20.00"}]});
    let response = client
        .call("PATCH", &path, convert.clone(), None, Some(1))
        .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    let mut same = convert;
    same["movements"][1]["account_id"] = bank["id"].clone();
    assert_eq!(
        client.call("PATCH", &path, same, None, Some(2)).await.0,
        StatusCode::BAD_REQUEST
    );
    let report = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(report["net_spending"], "0.00");
    assert_eq!(report["transfer_volume"], "20.00");
    let change = client
        .call(
            "PATCH",
            &format!("accounts/{}", bank["id"].as_str().unwrap()),
            json!({"currency":"USD"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(change.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn transaction_edit_and_delete_keep_revision_history() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let mut body = transaction("expense", "10.00", &bank, &food, "personal");
    body["effective_at"] = json!("2026-09-15T10:00:00+05:30");
    let created = client.create("transactions", body).await;
    let path = format!("transactions/{}", created["id"].as_str().unwrap());
    let edited = client.call("PATCH",&path,json!({"description":"Corrected","effective_date":"2026-09-16","effective_at":null,"amount":"12.00","movements":[{"account_id":bank["id"],"amount":"-12.00"}],"allocations":[{"category_id":food["id"],"amount":"12.00","scope":"personal"}]}),None,Some(1)).await;
    assert_eq!(edited.0, StatusCode::OK, "{}", edited.1);
    assert_eq!(edited.1["revision"], 2);
    assert_eq!(edited.1["effective_date"], "2026-09-16");
    assert!(edited.1.get("effective_at").is_none());
    let deleted = client
        .call(
            "DELETE",
            &path,
            json!({"reason":"Entered by mistake"}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(deleted.0, StatusCode::NO_CONTENT, "{}", deleted.1);
    assert!(
        client
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let revisions = client
        .call("GET", &format!("{path}/revisions"), json!({}), None, None)
        .await;
    assert_eq!(revisions.0, StatusCode::OK, "{}", revisions.1);
    assert!(
        revisions.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["action"] == "void")
    );
}

async fn partner(owner: &Client) -> (Client, Value) {
    let me = owner.call("GET", "me", json!({}), None, None).await.1;
    let token = finwise_api::auth::token();
    let path = format!(
        "households/{}/invites",
        me["household"]["id"].as_str().unwrap()
    );
    owner
        .create(
            &path,
            json!({"email":"partner@example.test","role":"member","token":token}),
        )
        .await;
    let mut client = Client {
        app: owner.app.clone(),
        cookie: String::new(),
        csrf: String::new(),
    };
    let (status,membership,headers)=client.call("POST",&format!("invites/{token}/accept"),json!({"email":"partner@example.test","name":"Partner","password":"synthetic-partner-123"}),Some("accept-invite"),None).await;
    assert_eq!(status, StatusCode::OK, "{membership}");
    client.cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into();
    client.csrf = client
        .call("GET", "auth/csrf", json!({}), None, None)
        .await
        .1["csrf_token"]
        .as_str()
        .unwrap()
        .into();
    (client, membership)
}

#[tokio::test]
async fn invited_member_can_record_family_spending() {
    let (owner, _) = setup().await;
    let (member, membership) = partner(&owner).await;
    assert_eq!(membership["role"], "member");
    let account = owner
        .create(
            "accounts",
            json!({"name":"Shared cash","subtype":"cash","currency":"INR","visibility":"shared"}),
        )
        .await;
    let category = owner.category("Groceries", "expense").await;
    let entry = member
        .transaction("expense", "125.00", &account, &category, "family")
        .await;
    let member_id = member.call("GET", "me", json!({}), None, None).await.1["user"]["id"].clone();
    assert_eq!(entry["entered_by"], member_id);
    let owner_entry = owner
        .call(
            "GET",
            &format!("transactions/{}", entry["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(owner_entry.0, StatusCode::OK, "{}", owner_entry.1);
    assert_eq!(owner_entry.1["entered_by"], member_id);
    for client in [&owner, &member] {
        let summary = client
            .call(
                "GET",
                "analytics/summary?scope=family&from=2026-09-01&to=2026-10-01",
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(summary.0, StatusCode::OK, "{}", summary.1);
        assert_eq!(summary.1["net_spending"], "125.00");
    }
}

#[tokio::test]
async fn combined_reports_and_transactions_include_own_personal_and_shared_once() {
    let (owner, _) = setup().await;
    let (member, _) = partner(&owner).await;
    let account = owner
        .create(
            "accounts",
            json!({"name":"Shared cash","subtype":"cash","currency":"INR","visibility":"shared"}),
        )
        .await;
    let category = owner.category("Groceries", "expense").await;
    let mixed = owner.create("transactions", json!({"event_type":"expense","amount":"100.00","currency":"INR","effective_date":"2026-09-15","description":"Mixed expense","movements":[{"account_id":account["id"],"amount":"-100.00"}],"allocations":[{"category_id":category["id"],"amount":"60.00","scope":"personal"},{"category_id":category["id"],"amount":"40.00","scope":"family"}]})).await;
    let shared = member
        .transaction("expense", "25.00", &account, &category, "family")
        .await;
    let private = member
        .transaction("expense", "10.00", &account, &category, "personal")
        .await;
    let period = "from=2026-09-01&to=2026-10-01";
    for (scope, expected) in [
        ("personal", "60.00"),
        ("family", "65.00"),
        ("combined", "125.00"),
    ] {
        let summary = owner
            .call(
                "GET",
                &format!("analytics/summary?scope={scope}&{period}"),
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(summary.0, StatusCode::OK, "{}", summary.1);
        assert_eq!(summary.1["net_spending"], expected);
        let categories = owner
            .call(
                "GET",
                &format!("analytics/categories?scope={scope}&{period}"),
                json!({}),
                None,
                None,
            )
            .await
            .1;
        assert_eq!(categories["data"][0]["amount"], expected);
        let types = owner
            .call(
                "GET",
                &format!("analytics/types?scope={scope}&{period}"),
                json!({}),
                None,
                None,
            )
            .await
            .1;
        assert_eq!(types["data"][0]["amount"], expected);
        let transactions = owner
            .call(
                "GET",
                &format!("transactions?scope={scope}&{period}"),
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(transactions.0, StatusCode::OK, "{}", transactions.1);
        let rows = transactions.1["data"].as_array().unwrap();
        assert_eq!(rows.iter().filter(|v| v["id"] == mixed["id"]).count(), 1);
        assert!(!rows.iter().any(|v| v["id"] == private["id"]));
        assert_eq!(
            rows.iter().any(|v| v["id"] == shared["id"]),
            scope != "personal"
        );
        let mixed_row = rows.iter().find(|v| v["id"] == mixed["id"]).unwrap();
        assert_eq!(
            mixed_row["allocations"].as_array().unwrap().len(),
            if scope == "combined" { 2 } else { 1 }
        );
    }
    let member_combined = member
        .call(
            "GET",
            &format!("analytics/summary?scope=combined&{period}"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(member_combined["net_spending"], "75.00");
}

#[tokio::test]
async fn existing_member_accepting_another_household_invite_switches_session() {
    let (owner, pool) = setup().await;
    let (partner, _) = partner(&owner).await;
    let original = owner.call("GET", "me", json!({}), None, None).await.1;
    let second = uuid::Uuid::new_v4().to_string();
    let mut document = original["household"].clone();
    document["id"] = json!(second);
    document["name"] = json!("Second household");
    sqlx::query("INSERT INTO households(id,document) VALUES(?,?)")
        .bind(&second)
        .bind(document.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships(id,household_id,user_id,role) VALUES(?,?,?,'owner')")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&second)
        .bind(original["user"]["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let login = owner
        .call(
            "POST",
            "auth/login",
            json!({"email":"owner@example.test","password":"synthetic-password-123"}),
            None,
            None,
        )
        .await;
    assert_eq!(login.0, StatusCode::OK);
    let mut second_owner = owner.clone();
    second_owner.cookie = login.2["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into();
    second_owner.csrf = login.1["csrf_token"].as_str().unwrap().into();
    assert_eq!(
        second_owner
            .call("GET", "me", json!({}), None, None)
            .await
            .1["household"]["id"],
        second
    );
    let token = finwise_api::auth::token();
    second_owner
        .create(
            &format!("households/{second}/invites"),
            json!({"email":"partner@example.test","role":"member","token":token}),
        )
        .await;
    let accepted = partner
        .call(
            "POST",
            &format!("invites/{token}/accept"),
            json!({}),
            Some("existing-member-join"),
            None,
        )
        .await;
    assert_eq!(accepted.0, StatusCode::OK, "{}", accepted.1);
    assert_eq!(
        partner.call("GET", "me", json!({}), None, None).await.1["household"]["id"],
        second
    );
}

#[tokio::test]
async fn private_accounts_are_hidden_from_owner_and_revocation_is_immediate() {
    let (owner, _) = setup().await;
    let (partner, membership) = partner(&owner).await;
    let private = partner.account("Private bank", "bank").await;
    let category = owner.category("Food", "expense").await;
    let transaction = partner
        .transaction("expense", "700.00", &private, &category, "personal")
        .await;
    for path in [
        format!("accounts/{}", private["id"].as_str().unwrap()),
        format!("accounts/{}/ledger", private["id"].as_str().unwrap()),
        format!(
            "accounts/{}/balance-at?as_of=2026-09-15T00%3A00%3A00%2B05%3A30",
            private["id"].as_str().unwrap()
        ),
        format!("transactions/{}", transaction["id"].as_str().unwrap()),
        format!(
            "transactions/{}/revisions",
            transaction["id"].as_str().unwrap()
        ),
    ] {
        assert_eq!(
            owner.call("GET", &path, json!({}), None, None).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert!(
        owner.call("GET", "accounts", json!({}), None, None).await.1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        owner
            .call(
                "GET",
                "transactions?account_type=bank",
                json!({}),
                None,
                None
            )
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        owner
            .call(
                "GET",
                "analytics/summary?scope=family&from=2026-09-01&to=2026-10-01",
                json!({}),
                None,
                None
            )
            .await
            .1["net_spending"],
        "0.00"
    );
    let me = owner.call("GET", "me", json!({}), None, None).await.1;
    let grant_path = format!(
        "accounts/{}/access/{}",
        private["id"].as_str().unwrap(),
        me["membership"]["id"].as_str().unwrap()
    );
    assert_eq!(
        owner
            .call("PUT", &grant_path, json!({"granted":true}), None, Some(1))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        partner
            .call("PUT", &grant_path, json!({"granted":true}), None, Some(1))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        owner
            .call(
                "GET",
                &format!("transactions/{}", transaction["id"].as_str().unwrap()),
                json!({}),
                None,
                None
            )
            .await
            .0,
        StatusCode::OK
    );
    let revoke_path = format!(
        "households/{}/members/{}",
        me["household"]["id"].as_str().unwrap(),
        membership["id"].as_str().unwrap()
    );
    assert_eq!(
        owner
            .call("DELETE", &revoke_path, json!({}), None, Some(1))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        partner.call("GET", "me", json!({}), None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn budgets_refunds_reporting_periods_and_revision_history() {
    let (client, _) = setup().await;
    let bank = client.account("Shared bank", "bank").await;
    let category = client.category("Groceries", "expense").await;
    client
        .transaction("expense", "3000.00", &bank, &category, "family")
        .await;
    client
        .transaction("expense", "2000.00", &bank, &category, "family")
        .await;
    client
        .transaction("refund", "500.00", &bank, &category, "family")
        .await;
    let plan=client.create("budgets",json!({"month":"2026-09","scope":"family","currency":"INR","expected_income":"20000.00","lines":[{"category_id":category["id"],"amount":"10000.00"}]})).await;
    let path = format!("budgets/{}", plan["id"].as_str().unwrap());
    let tracking = client
        .call("GET", &format!("{path}/tracking"), json!({}), None, None)
        .await;
    assert_eq!(tracking.0, StatusCode::OK, "{}", tracking.1);
    assert_eq!(tracking.1["data"][0]["actual"], "4500.00");
    assert_eq!(tracking.1["data"][0]["remaining"], "5500.00");
    assert_eq!(tracking.1["meta"]["complete"], false);
    let summary = client
        .call(
            "GET",
            "analytics/summary?scope=family&from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["net_spending"], tracking.1["data"][0]["actual"]);
    assert_eq!(
        client
            .call(
                "GET",
                "analytics/summary?scope=family&from=2026-09-01&to=2026-09-15",
                json!({}),
                None,
                None
            )
            .await
            .1["net_spending"],
        "0.00"
    );
    let activated = client
        .call(
            "POST",
            &format!("{path}/activate"),
            json!({}),
            Some("activate"),
            Some(1),
        )
        .await;
    assert_eq!(activated.1["state"], "active");
    assert_eq!(
        client
            .call("GET", &format!("{path}/revisions"), json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let edited = client
        .call(
            "PATCH",
            &path,
            json!({"expected_income":"22000.00","lines":[{"category_id":category["id"],"amount":"12000.00"}]}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(edited.0, StatusCode::OK, "{}", edited.1);
    assert_eq!(edited.1["revision"], 3);
    assert_eq!(
        client
            .call("GET", &format!("{path}/tracking"), json!({}), None, None)
            .await
            .1["data"][0]["remaining"],
        "7500.00"
    );
    let copied = client
        .call(
            "POST",
            &format!("{path}/copy"),
            json!({"month":"2026-10"}),
            Some("copy"),
            Some(3),
        )
        .await;
    assert_eq!(copied.0, StatusCode::CREATED);
    assert_eq!(copied.1["state"], "draft");
    assert_ne!(copied.1["id"], plan["id"]);
}

#[tokio::test]
async fn cursor_pages_are_stable_and_reject_changed_snapshots() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let category = client.category("Food", "expense").await;
    for amount in ["1.00", "2.00", "3.00"] {
        client
            .transaction("expense", amount, &bank, &category, "personal")
            .await;
    }
    let first = client
        .call("GET", "transactions?limit=2", json!({}), None, None)
        .await
        .1;
    let cursor = first["page"]["next_cursor"].as_str().unwrap();
    let path = format!("transactions?limit=2&cursor={cursor}");
    let second = client.call("GET", &path, json!({}), None, None).await.1;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert!(second["page"].get("next_cursor").is_none());
    assert_ne!(second["data"][0]["id"], first["data"][0]["id"]);
    client
        .transaction("expense", "4.00", &bank, &category, "personal")
        .await;
    assert_eq!(
        client.call("GET", &path, json!({}), None, None).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .call(
                "GET",
                "transactions?sort=sql-injection",
                json!({}),
                None,
                None
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn limits_contract_and_unknown_api_never_fall_back_to_html() {
    let (client, _) = setup().await;
    let public = Client {
        cookie: String::new(),
        csrf: String::new(),
        ..client.clone()
    };
    assert_eq!(
        public.call("GET", "unknown", json!({}), None, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        public
            .call("GET", "accounts", json!({}), None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client.call("GET", "imports", json!({}), None, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        client
            .call("GET", "imports/a/nonsense", json!({}), None, None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let spec = public
        .call("GET", "openapi.json", json!({}), None, None)
        .await
        .1;
    assert_eq!(spec["openapi"], "3.1.0");
    assert_eq!(
        spec["paths"]["/transactions"]["post"]["x-implemented"],
        true
    );
    assert_eq!(spec["paths"]["/imports"]["post"]["x-implemented"], true);
    assert_eq!(
        client
            .call(
                "POST",
                "accounts",
                json!({"name":"x".repeat(1024*1024)}),
                Some("oversized"),
                None
            )
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn persistent_database_reopens_and_migrations_are_repeatable() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("test.sqlite").display());
    let pool = connect(&url).await.unwrap();
    let client = Client {
        app: router(
            AppState {
                pool: pool.clone(),
                secure_cookies: true,
            },
            Path::new("../web"),
        ),
        cookie: String::new(),
        csrf: String::new(),
    };
    assert_eq!(
        client
            .call(
                "POST",
                "auth/bootstrap",
                setup_body(),
                Some("bootstrap"),
                None
            )
            .await
            .0,
        StatusCode::CREATED
    );
    drop(client);
    pool.close().await;
    let reopened = connect(&url).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM households")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn known_balance_today_projects_backward_across_earlier_activity() {
    let (client, _) = setup().await;
    let food = client.category("Food", "expense").await;
    for (subtype, today, expected_before, expected_after) in [
        ("bank", "700.00", "1000.00", "900.00"),
        ("credit_card", "700.00", "400.00", "500.00"),
    ] {
        let account = client.create("accounts", json!({"name":subtype,"subtype":subtype,"currency":"INR","timezone":"Asia/Kolkata","opening_balance":{"amount":today,"as_of":"2026-09-30T23:59:00+05:30"}})).await;
        for (amount, at) in [
            ("100.00", "2026-09-15T10:00:00+05:30"),
            ("200.00", "2026-09-20T10:00:00+05:30"),
        ] {
            let mut event = transaction("expense", amount, &account, &food, "personal");
            event["effective_at"] = json!(at);
            event["effective_date"] = json!(&at[..10]);
            client.create("transactions", event).await;
        }
        let id = account["id"].as_str().unwrap();
        let balance = |date: &str| format!("accounts/{id}/balance-at?as_of={date}");
        let before = client
            .call(
                "GET",
                &balance("2026-09-14T12%3A00%3A00%2B05%3A30"),
                json!({}),
                None,
                None,
            )
            .await;
        let after = client
            .call(
                "GET",
                &balance("2026-09-15T12%3A00%3A00%2B05%3A30"),
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(before.1["amount"], expected_before);
        assert_eq!(after.1["amount"], expected_after);
        assert_eq!(before.1["source"], "opening_balance");
        let ledger = client
            .call(
                "GET",
                &format!("accounts/{id}/ledger"),
                json!({}),
                None,
                None,
            )
            .await
            .1;
        let rows = ledger["data"].as_array().unwrap();
        assert!(rows.iter().any(|r| r["transaction_id"].is_string()
            && r["effective_date"] == "2026-09-15"
            && r["balance_after"] == expected_after
            && r["computed_from_start"] == expected_after));
    }
}

#[tokio::test]
async fn balance_checks_use_exact_cutoffs_and_preserve_stale_snapshots() {
    let (client, _) = setup().await;
    let bank=client.create("accounts",json!({"name":"Bank","subtype":"bank","currency":"INR","timezone":"Asia/Kolkata","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let category = client.category("Food", "expense").await;
    let mut before = transaction("expense", "100.00", &bank, &category, "personal");
    before["effective_at"] = json!("2026-09-15T10:00:00+05:30");
    let first = client.create("transactions", before).await;
    let mut after = transaction("expense", "200.00", &bank, &category, "personal");
    after["effective_at"] = json!("2026-09-15T18:00:00+05:30");
    client.create("transactions", after).await;
    let path = format!("accounts/{}/balance-checks", bank["id"].as_str().unwrap());
    let check=client.call("POST",&path,json!({"amount":"890.00","as_of":"2026-09-15T12:00:00+05:30","timezone":"Asia/Kolkata","basis":"posted"}),Some("check"),Some(1)).await;
    assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    assert_eq!(check.1["calculated"], "900.00");
    assert_eq!(check.1["variance"], "-10.00");
    let changed=client.call("PATCH",&format!("transactions/{}",first["id"].as_str().unwrap()),json!({"amount":"110.00","movements":[{"account_id":bank["id"],"amount":"-110.00"}],"allocations":[{"category_id":category["id"],"amount":"110.00","scope":"personal"}]}),None,Some(1)).await;
    assert_eq!(changed.0, StatusCode::OK);
    let history = client.call("GET", &path, json!({}), None, None).await.1;
    assert_eq!(history["data"][0]["stale"], true);
    assert_eq!(history["data"][0]["calculated"], "900.00");
    assert_eq!(history["data"][0]["variance"], "-10.00");
    let statement = client
        .call(
            "GET",
            &format!(
                "accounts/{}/statements?month=2026-09",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(statement.0, StatusCode::OK);
    assert_eq!(statement.1["closing"]["amount"], "690.00");
    assert_eq!(statement.1["statement"], Value::Null);
}

#[tokio::test]
async fn starting_balance_and_manual_checks_can_be_corrected_and_removed() {
    let (client, pool) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Food", "expense").await;
    let mut event = transaction("expense", "100.00", &account, &category, "personal");
    event["effective_at"] = json!("2026-09-15T10:00:00+05:30");
    client.create("transactions", event).await;
    let account_id = account["id"].as_str().unwrap();
    let path = format!("accounts/{account_id}/balance-checks");
    let check = client.call("POST",&path,json!({"amount":"890.00","as_of":"2026-09-16T12:00:00+05:30","timezone":"Asia/Kolkata","basis":"posted"}),Some("manual-check"),Some(1)).await;
    assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    assert!(check.1["variance"].is_null());
    let invalid = client
        .call(
            "PATCH",
            &format!("accounts/{account_id}"),
            json!({"opening_balance":{"amount":"1000.00","as_of":"2026-09-16T00:00:00+05:30"}}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(invalid.0, StatusCode::OK, "{}", invalid.1);
    let dated = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let rows = dated["data"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["event_type"] == "opening_balance" && r["effective_date"] == "2026-09-16")
    );
    assert!(rows.iter().any(|r| r["transaction_id"].is_string()
        && r["effective_date"] == "2026-09-15"
        && r["computed_from_start"] == "1000.00"));
    let opening = client
        .call(
            "PATCH",
            &format!("accounts/{account_id}"),
            json!({"opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}}),
            None,
            Some(3),
        )
        .await;
    assert_eq!(opening.0, StatusCode::OK, "{}", opening.1);
    let history = client.call("GET", &path, json!({}), None, None).await.1;
    assert_eq!(history["data"][0]["current_calculated"], "900.00");
    assert_eq!(history["data"][0]["current_variance"], "-10.00");
    let current = client
        .call(
            "GET",
            &format!("accounts/{account_id}"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(current["balance"]["source"], "balance_check");
    assert_eq!(current["balance"]["amount"], "890.00");
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":account_id,"month":"2026-09"}),
        )
        .await;
    let session_path = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let review = client
        .call("GET", &session_path, json!({}), None, None)
        .await
        .1;
    assert_eq!(review["current"]["balance_check_unresolved_count"], 1);
    let check_id = check.1["id"].as_str().unwrap();
    let item_path = format!("{path}/{check_id}");
    let edited = client
        .call(
            "PATCH",
            &item_path,
            json!({"amount":"900.00"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(edited.0, StatusCode::OK, "{}", edited.1);
    assert_eq!(edited.1["variance"], "0.00");
    let review = client
        .call("GET", &session_path, json!({}), None, None)
        .await
        .1;
    assert_eq!(review["current"]["balance_check_unresolved_count"], 0);
    let stale = client
        .call(
            "PATCH",
            &item_path,
            json!({"amount":"905.00"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(stale.0, StatusCode::CONFLICT);
    let removed = client
        .call("DELETE", &item_path, json!({}), None, Some(2))
        .await;
    assert_eq!(removed.0, StatusCode::NO_CONTENT, "{}", removed.1);
    let history = client.call("GET", &path, json!({}), None, None).await.1;
    assert_eq!(history["data"][0]["voided"], true);
    let account = client
        .call(
            "GET",
            &format!("accounts/{account_id}"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(account["balance"]["source"], "opening_balance");
    assert_eq!(account["balance"]["amount"], "900.00");
    let audit: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_events WHERE resource_id=? ORDER BY id")
            .bind(check_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(audit.contains(&"balance_check_corrected".to_string()));
    assert!(audit.contains(&"balance_check_removed".to_string()));
}

#[tokio::test]
async fn transaction_account_type_filters_and_extra_analytics_reports() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let cash = client.account("Wallet", "cash").await;
    let food = client.category("Food", "expense").await;
    let dining = client
        .create(
            "categories",
            json!({"name":"Dining","kind":"expense","parent_id":food["id"]}),
        )
        .await;
    let salary = client.category("Salary", "income").await;
    client
        .transaction("expense", "25.00", &bank, &dining, "personal")
        .await;
    client
        .transaction("income", "100.00", &cash, &salary, "personal")
        .await;
    client.create("transactions",json!({"event_type":"transfer","amount":"10.00","currency":"INR","effective_date":"2026-09-15","description":"Move cash","movements":[{"account_id":bank["id"],"amount":"-10.00"},{"account_id":cash["id"],"amount":"10.00"}],"allocations":[]})).await;
    let count = |value: &Value| value["data"].as_array().unwrap().len();
    let bank_expense = client
        .call(
            "GET",
            &format!(
                "transactions?account_id={}&account_type=bank&event_type=expense",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(count(&bank_expense.1), 1);
    let cash_expense = client
        .call(
            "GET",
            "transactions?account_type=cash&event_type=expense",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(count(&cash_expense.1), 0);
    let cash_transfer = client
        .call(
            "GET",
            "transactions?account_type=cash&event_type=transfer",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(count(&cash_transfer.1), 1);
    let invalid = client
        .call(
            "GET",
            "transactions?account_type=unknown",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    let query = "scope=personal&from=2026-09-01&to=2026-10-01&currency=INR";
    let income = client
        .call(
            "GET",
            &format!("analytics/income-categories?{query}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(income.1["data"][0]["id"], salary["id"]);
    assert_eq!(income.1["data"][0]["amount"], "100.00");
    let types = client
        .call(
            "GET",
            &format!("analytics/types?{query}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(count(&types.1), 3);
    assert!(
        types.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["event_type"] == "transfer" && v["amount"] == "10.00")
    );
}

#[tokio::test]
async fn dated_check_recomputes_ledger_in_both_directions_and_month_filters() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let category = client.category("Food", "expense").await;
    let mut early = transaction("expense", "100.00", &bank, &category, "personal");
    early["effective_at"] = json!("2026-09-15T10:00:00+05:30");
    let early = client.create("transactions", early).await;
    let mut late = transaction("expense", "50.00", &bank, &category, "personal");
    late["effective_at"] = json!("2026-09-15T18:00:00+05:30");
    let late = client.create("transactions", late).await;
    let account_id = bank["id"].as_str().unwrap();
    let unknown = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(unknown.1["data"][0]["balance_after"], Value::Null);
    let check = client.call("POST", &format!("accounts/{account_id}/balance-checks"),
        json!({"amount":"900.00","basis":"posted","as_of":"2026-09-15T12:00:00+05:30","timezone":"Asia/Kolkata"}), Some("dated-anchor"), Some(1)).await;
    assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    let before = client
        .call(
            "GET",
            &format!("accounts/{account_id}/balance-at?as_of=2026-09-15T09%3A00%3A00%2B05%3A30"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(before.1["amount"], "1000.00");
    assert_eq!(before.1["source"], "balance_check");
    let ledger = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger?from=2026-09-01&to=2026-10-01"),
            json!({}),
            None,
            None,
        )
        .await;
    let transaction_rows: Vec<_> = ledger.1["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["transaction_id"].is_string())
        .collect();
    assert_eq!(transaction_rows[0]["transaction_id"], late["id"]);
    assert_eq!(transaction_rows[0]["balance_after"], "850.00");
    assert_eq!(transaction_rows[1]["transaction_id"], early["id"]);
    assert_eq!(transaction_rows[1]["balance_after"], "900.00");
    assert!(
        ledger.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["event_type"] == "balance_check")
    );
    let october = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger?from=2026-10-01&to=2026-11-01"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(october.1["data"].as_array().unwrap().len(), 0);
    let september_transactions = client
        .call(
            "GET",
            "transactions?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await;
    let october_transactions = client
        .call(
            "GET",
            "transactions?from=2026-10-01&to=2026-11-01",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(
        september_transactions.1["data"].as_array().unwrap().len(),
        2
    );
    assert_eq!(october_transactions.1["data"].as_array().unwrap().len(), 0);
    let account = client
        .call(
            "GET",
            &format!("accounts/{account_id}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(account.1["balance"]["amount"], "850.00");
}

#[tokio::test]
async fn ledger_exposes_starting_balance_calculation_for_check_comparison() {
    let (client, _) = setup().await;
    let bank = client.create("accounts", json!({"name":"Bank","subtype":"bank","currency":"INR","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let food = client.category("Food", "expense").await;
    client
        .transaction("expense", "100.00", &bank, &food, "personal")
        .await;
    let account_id = bank["id"].as_str().unwrap();
    let check = client.call("POST", &format!("accounts/{account_id}/balance-checks"), json!({"amount":"950.00","basis":"posted","as_of":"2026-09-30T23:59:00+05:30","timezone":"Asia/Kolkata"}), Some("check-gap"), Some(1)).await;
    assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    assert_eq!(check.1["variance"], "50.00");
    let ledger = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let rows = ledger["data"].as_array().unwrap();
    let transaction = rows
        .iter()
        .find(|r| r["transaction_id"].is_string())
        .unwrap();
    assert_eq!(transaction["computed_from_start"], "900.00");
    assert_eq!(transaction["balance_after"], "900.00");
    assert_eq!(transaction["balance_source"], "opening_balance");
    assert!(rows.iter().any(|r| r["event_type"] == "opening_balance"));
    assert!(
        rows.iter()
            .any(|r| r["event_type"] == "balance_check" && r["balance_after"] == "950.00")
    );
}

#[tokio::test]
async fn card_purchases_increase_debt_and_unknown_openings_remain_unknown() {
    let (client, _) = setup().await;
    let card=client.create("accounts",json!({"name":"Card","subtype":"credit_card","currency":"INR","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let category = client.category("Food", "expense").await;
    client
        .transaction("expense", "250.00", &card, &category, "personal")
        .await;
    let path = format!("accounts/{}/balance-checks", card["id"].as_str().unwrap());
    let check=client.call("POST",&path,json!({"amount":"1250.00","basis":"current","as_of":"2026-09-30T23:59:59+05:30","timezone":"Asia/Kolkata"}),Some("card-check"),Some(1)).await;
    assert_eq!(check.0, StatusCode::CREATED, "{}", check.1);
    assert_eq!(check.1["calculated"], "1250.00");
    assert_eq!(check.1["variance"], "0.00");
    let cash = client.account("Cash", "cash").await;
    let unknown=client.call("POST",&format!("accounts/{}/balance-checks",cash["id"].as_str().unwrap()),json!({"amount":"10.00","basis":"cash_count","as_of":"2026-09-30T23:59:59+05:30","timezone":"Asia/Kolkata"}),Some("cash-check"),Some(1)).await;
    assert_eq!(unknown.0, StatusCode::CREATED);
    assert_eq!(unknown.1["calculated"], Value::Null);
    assert_eq!(unknown.1["variance"], Value::Null);
    assert_eq!(unknown.1["complete"], false);
}

#[tokio::test]
async fn api_namespace_root_does_not_serve_the_spa() {
    let (client, _) = setup().await;
    for path in ["/api", "/api/", "/api/v1", "/api/v1/"] {
        let response = client
            .app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert_eq!(
            response.headers()["content-type"],
            "application/json; charset=utf-8"
        );
    }
}

#[tokio::test]
async fn failed_login_attempts_are_persistently_throttled() {
    let (client, _) = setup().await;
    for _ in 0..10 {
        assert_eq!(
            client
                .call(
                    "POST",
                    "auth/login",
                    json!({"email":"owner@example.test","password":"incorrect-password"}),
                    None,
                    None
                )
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let limited = client
        .call(
            "POST",
            "auth/login",
            json!({"email":"owner@example.test","password":"synthetic-password-123"}),
            None,
            None,
        )
        .await;
    assert_eq!(limited.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.1["error"]["code"], "rate_limited");
}

async fn upload_file(
    client: &Client,
    manifest: Value,
    filename: &str,
    bytes: &[u8],
    key: &str,
) -> (StatusCode, Value) {
    let boundary = "finwise-synthetic-boundary";
    let mut data = Vec::new();
    data.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n{}\r\n",manifest).as_bytes());
    data.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[]\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    data.extend_from_slice(bytes);
    data.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/imports")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &client.cookie)
        .header("x-csrf-token", &client.csrf)
        .header("idempotency-key", key)
        .body(Body::from(data))
        .unwrap();
    let response = client.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn wait_for_file(client: &Client, batch: &str, file: &str) -> Value {
    for _ in 0..50 {
        let result = client
            .call(
                "GET",
                &format!("imports/{batch}/files/{file}"),
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
        if !["uploaded", "parsing"].contains(&result.1["state"].as_str().unwrap_or("")) {
            return result.1;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("parse job did not finish")
}
#[tokio::test]
async fn xlsx_import_exact_money_multiplicity_pairing_and_repeat_upload() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let cash = client.account("Cash", "cash").await;
    let food = client.category("Food", "expense").await;
    let salary = client.category("Salary", "income").await;
    let mapping = json!({"account_aliases":{"Bank":bank["id"],"Cash":cash["id"]},"category_mappings":[{"source_label":"Food","event_kind":"expense","category_id":food["id"]},{"source_label":"Salary","event_kind":"income","category_id":salary["id"]}]});
    let manifest = json!({"files":[{"source_kind":"money_manager","mapping":mapping}]});
    let fixture = include_bytes!("fixtures/money-manager-synthetic.xlsx");
    let (status, uploaded) = upload_file(
        &client,
        manifest.clone(),
        "month.xlsx",
        fixture,
        "month-upload",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{uploaded}");
    let batch = uploaded["id"].as_str().unwrap();
    let file_id = uploaded["files"][0]["id"].as_str().unwrap();
    let file = wait_for_file(&client, batch, file_id).await;
    assert_eq!(file["row_count"], 5, "{file}");
    assert_eq!(file["state"], "needs_mapping");
    assert!(
        file["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "duplicate_accounts_header_last_column_ignored")
    );
    let preview = client
        .call(
            "GET",
            &format!("imports/{batch}/preview?file_id={file_id}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["meta"]["unresolved_count"], 0, "{}", preview.1);
    assert_eq!(preview.1["data"][0]["amount"], "120.00");
    assert_eq!(preview.1["data"][0]["effective_date"], "2026-09-15");
    assert_eq!(
        preview.1["data"][2]["proposed_action"],
        "review_or_pair_transfer"
    );
    let batch_now = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1;
    let revision = batch_now["revision"].as_i64().unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("first-commit"),
            None,
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    assert_eq!(committed.1["counts"]["created"], 3);
    assert_eq!(committed.1["counts"]["paired_transfers"], 1);
    assert_eq!(committed.1["outcomes"][0]["state"], "committed");
    let txs = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(txs["data"].as_array().unwrap().len(), 4);
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["income"], "500.00");
    assert_eq!(summary["net_spending"], "240.00");
    assert_eq!(summary["transfer_volume"], "100.00");
    let replay = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("first-commit"),
            None,
        )
        .await;
    assert_eq!(replay.1, committed.1);
    let (status, second) =
        upload_file(&client, manifest, "month.xlsx", fixture, "second-upload").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let batch2 = second["id"].as_str().unwrap();
    let file2 = second["files"][0]["id"].as_str().unwrap();
    wait_for_file(&client, batch2, file2).await;
    let preview = client
        .call(
            "GET",
            &format!("imports/{batch2}/preview?file_id={file2}"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(preview["meta"]["duplicate_candidate_count"], 5);
    let revision = client
        .call("GET", &format!("imports/{batch2}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let repeat = client
        .call(
            "POST",
            &format!("imports/{batch2}/commit"),
            json!({"expected_revision":revision}),
            Some("repeat-commit"),
            None,
        )
        .await;
    assert_eq!(repeat.0, StatusCode::OK, "{}", repeat.1);
    assert_eq!(repeat.1["counts"]["created"], 0);
    assert_eq!(repeat.1["counts"]["paired_transfers"], 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 4);
    let manual = client
        .transaction("expense", "7.00", &bank, &food, "personal")
        .await;
    let yearly = client
        .call(
            "POST",
            "imports/money-manager/cleanup-preview",
            json!({"period":"2026"}),
            Some("year-cleanup-preview"),
            None,
        )
        .await;
    assert_eq!(yearly.0, StatusCode::OK, "{}", yearly.1);
    assert_eq!(yearly.1["count"], 4);
    let preview = client
        .call(
            "POST",
            "imports/money-manager/cleanup-preview",
            json!({"period":"2026-09"}),
            Some("month-cleanup-preview"),
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["count"], 4);
    let reset = client
        .call(
            "POST",
            "imports/money-manager/cleanup",
            json!({"period":"2026-09","preview_token":preview.1["preview_token"]}),
            Some("month-cleanup-apply"),
            None,
        )
        .await;
    assert_eq!(reset.0, StatusCode::OK, "{}", reset.1);
    assert_eq!(reset.1["removed"], 4);
    let remaining = client
        .call("GET", "transactions", json!({}), None, None)
        .await
        .1;
    assert_eq!(remaining["data"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["data"][0]["id"], manual["id"]);
    let (status,again)=upload_file(&client,json!({"files":[{"source_kind":"money_manager","mapping":{"account_aliases":{"Bank":bank["id"],"Cash":cash["id"]},"category_mappings":[{"source_label":"Food","event_kind":"expense","category_id":food["id"]},{"source_label":"Salary","event_kind":"income","category_id":salary["id"]}]}}]}),"month.xlsx",fixture,"after-cleanup-upload").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{again}");
    let again_batch = again["id"].as_str().unwrap();
    wait_for_file(
        &client,
        again_batch,
        again["files"][0]["id"].as_str().unwrap(),
    )
    .await;
    let revision = client
        .call(
            "GET",
            &format!("imports/{again_batch}"),
            json!({}),
            None,
            None,
        )
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let restored = client
        .call(
            "POST",
            &format!("imports/{again_batch}/commit"),
            json!({"expected_revision":revision}),
            Some("after-cleanup-commit"),
            None,
        )
        .await;
    assert_eq!(restored.0, StatusCode::OK, "{}", restored.1);
    assert_eq!(restored.1["counts"]["created"], 3);
    assert_eq!(restored.1["counts"]["paired_transfers"], 1);
    assert_eq!(
        client
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[tokio::test]
#[ignore = "set FINWISE_TEST_BANK_WORKBOOK to a local account statement XLSX"]
async fn real_bank_statement_xlsx_imports_as_reconciliation_evidence() {
    let path = std::env::var("FINWISE_TEST_BANK_WORKBOOK").expect("FINWISE_TEST_BANK_WORKBOOK");
    let bytes = std::fs::read(path).unwrap();
    let (client, _) = setup().await;
    let bank = client.account("Statement bank", "bank").await;
    let manifest = json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR","date_locale":"DMY"}}]});
    let (status, upload) = upload_file(
        &client,
        manifest,
        "statement.xlsx",
        &bytes,
        "statement-xlsx-upload",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
    let batch = upload["id"].as_str().unwrap();
    let file = upload["files"][0]["id"].as_str().unwrap();
    let parsed = wait_for_file(&client, batch, file).await;
    assert_eq!(parsed["row_count"], 27, "{parsed}");
    let preview = client
        .call(
            "GET",
            &format!("imports/{batch}/preview?file_id={file}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK);
    assert_eq!(preview.1["meta"]["adapter"], "bank-statement-xlsx-v1");
    assert_eq!(preview.1["meta"]["unresolved_count"], 0);
    assert_eq!(preview.1["data"][0]["effective_date"], "2026-08-01");
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("statement-xlsx-commit"),
            None,
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    assert_eq!(committed.1["counts"]["observations"], 27);
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-08"}),
        )
        .await;
    let items = client
        .call(
            "GET",
            &format!(
                "reconciliation/sessions/{}/items?side=statement&limit=200",
                session["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(items.0, StatusCode::OK, "{}", items.1);
    let observations = items.1["data"].as_array().unwrap();
    assert_eq!(observations.len(), 27);
    assert!(
        observations
            .iter()
            .all(|row| row["statement_balance"].is_string())
    );
    assert!(
        client
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn bank_csv_stays_evidence_only_and_download_is_scoped() {
    let (owner, _) = setup().await;
    let (partner, _) = partner(&owner).await;
    let bank = owner.account("Private bank", "bank").await;
    let manifest = json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]});
    let fixture = include_bytes!("fixtures/bank-synthetic.csv");
    let (status, uploaded) =
        upload_file(&owner, manifest, "bank.csv", fixture, "bank-upload").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let batch = uploaded["id"].as_str().unwrap();
    let file = uploaded["files"][0]["id"].as_str().unwrap();
    let parsed = wait_for_file(&owner, batch, file).await;
    assert_eq!(parsed["row_count"], 2, "{parsed}");
    let preview = owner
        .call(
            "GET",
            &format!("imports/{batch}/preview?file_id={file}"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(preview["meta"]["unresolved_count"], 0, "{preview}");
    assert_eq!(preview["data"][0]["signed_movement"], "-120.00");
    let revision = owner
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let commit = owner
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("bank-commit"),
            None,
        )
        .await;
    assert_eq!(commit.0, StatusCode::OK, "{}", commit.1);
    assert_eq!(commit.1["counts"]["observations"], 2);
    let monthly = owner
        .call(
            "GET",
            &format!(
                "accounts/{}/statements?month=2026-09",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(monthly.0, StatusCode::OK, "{}", monthly.1);
    assert_eq!(monthly.1["statement_imports"].as_array().unwrap().len(), 1);
    assert_eq!(monthly.1["observation_unmatched_count"], 2);
    assert_eq!(monthly.1["provider_statement_available"], true);
    assert!(
        owner
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let path = format!("/api/v1/source-files/{file}/download");
    for (client, expected) in [(&owner, StatusCode::OK), (&partner, StatusCode::NOT_FOUND)] {
        let response = client
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header("cookie", &client.cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(
                response
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .as_ref(),
                fixture
            );
        }
    }
}

#[tokio::test]
async fn multi_month_statement_reports_each_files_opening_and_closing() {
    let (client, _) = setup().await;
    let bank = client.account("Statement bank", "bank").await;
    let csv = b"Date,Debit,Credit,Description,Currency,Balance\n2026-07-31,100.00,,July purchase,INR,900.00\n2026-08-01,,200.00,August income,INR,1100.00\n2026-08-31,50.00,,August purchase,INR,1050.00\n";
    let (status, upload) = upload_file(&client, json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}), "two-months.csv", csv, "two-month-upload").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let batch = upload["id"].as_str().unwrap();
    let file = upload["files"][0]["id"].as_str().unwrap();
    wait_for_file(&client, batch, file).await;
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("two-month-commit"),
            None,
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    let (status, response, _) = client
        .call(
            "GET",
            &format!("accounts/{}/statement-months", bank["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let months = response["data"].as_array().unwrap();
    assert_eq!(months.len(), 2);
    assert_eq!(months[0]["month"], "2026-08");
    assert_eq!(months[0]["opening_balance"], "900.00");
    assert_eq!(months[0]["closing_balance"], "1050.00");
    assert_eq!(months[1]["month"], "2026-07");
    assert_eq!(months[1]["opening_balance"], "1000.00");
    assert_eq!(months[1]["closing_balance"], "900.00");
}

#[tokio::test]
async fn changed_reexport_requires_explicit_new_event_decision() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let cash = client.account("Cash", "cash").await;
    let food = client.category("Food", "expense").await;
    let salary = client.category("Salary", "income").await;
    let manifest = json!({"files":[{"source_kind":"money_manager","mapping":{"account_aliases":{"Bank":bank["id"],"Cash":cash["id"]},"category_mappings":[{"source_label":"Food","event_kind":"expense","category_id":food["id"]},{"source_label":"Salary","event_kind":"income","category_id":salary["id"]}]}}]});
    for (i, fixture) in [
        include_bytes!("fixtures/money-manager-synthetic.xlsx").as_slice(),
        include_bytes!("fixtures/money-manager-edited-note.xlsx").as_slice(),
    ]
    .into_iter()
    .enumerate()
    {
        let (_, upload) = upload_file(
            &client,
            manifest.clone(),
            "month.xlsx",
            fixture,
            &format!("edited-upload-{i}"),
        )
        .await;
        let batch = upload["id"].as_str().unwrap();
        let file = upload["files"][0]["id"].as_str().unwrap();
        wait_for_file(&client, batch, file).await;
        let preview = client
            .call(
                "GET",
                &format!("imports/{batch}/preview?file_id={file}"),
                json!({}),
                None,
                None,
            )
            .await
            .1;
        if i == 1 {
            assert_eq!(preview["meta"]["unresolved_count"], 2, "{preview}");
            assert_eq!(preview["data"][0]["issues"][0], "possible_existing_event");
        }
        let revision = client
            .call("GET", &format!("imports/{batch}"), json!({}), None, None)
            .await
            .1["revision"]
            .as_i64()
            .unwrap();
        let commit = client
            .call(
                "POST",
                &format!("imports/{batch}/commit"),
                json!({"expected_revision":revision}),
                Some(&format!("edited-commit-{i}")),
                None,
            )
            .await;
        assert_eq!(commit.0, StatusCode::OK, "{}", commit.1);
        if i == 1 {
            assert_eq!(commit.1["counts"]["created"], 0);
            assert_eq!(commit.1["counts"]["pending_review"], 2);
            assert_eq!(commit.1["outcomes"][0]["state"], "needs_review");
        }
    }
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["net_spending"], "240.00");
}

#[tokio::test]
async fn saved_source_profile_mappings_resolve_unmapped_import() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let cash = client.account("Cash", "cash").await;
    let food = client.category("Food", "expense").await;
    let salary = client.category("Salary", "income").await;
    let (_, uploaded) = upload_file(
        &client,
        json!({"files":[{"source_kind":"money_manager"}]}),
        "month.xlsx",
        include_bytes!("fixtures/money-manager-synthetic.xlsx"),
        "profile-upload",
    )
    .await;
    let batch = uploaded["id"].as_str().unwrap();
    let file = uploaded["files"][0]["id"].as_str().unwrap();
    let parsed = wait_for_file(&client, batch, file).await;
    assert_eq!(parsed["state"], "needs_mapping");
    let profile = parsed["profile_id"].as_str().unwrap();
    for (label, account) in [("Bank", &bank), ("Cash", &cash)] {
        let id = uuid::Uuid::new_v4();
        let result = client
            .call(
                "PUT",
                &format!("source-profiles/{profile}/account-aliases/{id}"),
                json!({"source_label":label,"account_id":account["id"]}),
                None,
                None,
            )
            .await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }
    for (label, kind, category) in [("Food", "expense", &food), ("Salary", "income", &salary)] {
        let id = uuid::Uuid::new_v4();
        let result = client
            .call(
                "PUT",
                &format!("source-profiles/{profile}/category-mappings/{id}"),
                json!({"source_label":label,"event_kind":kind,"category_id":category["id"]}),
                None,
                None,
            )
            .await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }
    let preview = client
        .call(
            "GET",
            &format!("imports/{batch}/preview?file_id={file}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["meta"]["unresolved_count"], 0, "{}", preview.1);
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({"expected_revision":revision}),
            Some("profile-commit"),
            None,
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    assert_eq!(committed.1["counts"]["created"], 3);
    assert_eq!(committed.1["counts"]["paired_transfers"], 1);
}

async fn bank_evidence(client: &Client, bank: &Value) {
    let key = uuid::Uuid::new_v4().to_string();
    let (status,upload)=upload_file(client,json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}),"bank.csv",include_bytes!("fixtures/bank-synthetic.csv"),&key).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
    let batch = upload["id"].as_str().unwrap();
    wait_for_file(client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let result = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({}),
            Some(&format!("commit-{key}")),
            Some(revision),
        )
        .await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
}

#[tokio::test]
async fn automatic_matching_marks_only_unique_exact_pairs_without_changing_balance() {
    let (client, _) = setup().await;
    let bank = client
        .create("accounts", json!({"name":"Bank","subtype":"bank","currency":"INR","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}}))
        .await;
    let food = client.category("Food", "expense").await;
    let tx = client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    let salary = client.category("Salary", "income").await;
    let mut income = transaction("income", "500.00", &bank, &salary, "personal");
    income["effective_date"] = json!("2026-09-16");
    let income = client.create("transactions", income).await;
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let before = client
        .call(
            "GET",
            &format!(
                "accounts/{}/balance-at?as_of=2026-09-30T23%3A59%3A00%2B05%3A30",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let matched = client
        .call(
            "POST",
            &format!("{root}/auto-match"),
            json!({}),
            Some("auto-exact"),
            Some(1),
        )
        .await;
    assert_eq!(matched.0, StatusCode::OK, "{}", matched.1);
    assert_eq!(matched.1["matched_count"], 2);
    let ledger = client
        .call(
            "GET",
            &format!("{root}/items?side=ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(ledger["data"][0]["id"], tx["id"]);
    assert_eq!(ledger["data"][0]["state"], "matched");
    assert_eq!(ledger["data"][1]["id"], income["id"]);
    assert_eq!(ledger["data"][1]["state"], "matched");
    let observations = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(
        observations["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["state"] == "unmatched")
            .count(),
        0
    );
    let after = client
        .call(
            "GET",
            &format!(
                "accounts/{}/balance-at?as_of=2026-09-30T23%3A59%3A00%2B05%3A30",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(before["amount"], "1380.00");
    assert_eq!(before["amount"], after["amount"]);
}

#[tokio::test]
async fn automatic_matching_leaves_ambiguous_pairs_for_review() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let result = client
        .call(
            "POST",
            &format!("{root}/auto-match"),
            json!({}),
            Some("auto-ambiguous"),
            Some(1),
        )
        .await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    assert_eq!(result.1["matched_count"], 0);
    assert_eq!(result.1["session_revision"], 1);
}

#[tokio::test]
async fn grouped_match_attaches_multiple_rows_on_both_sides() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let eighty = client
        .transaction("expense", "80.00", &bank, &food, "personal")
        .await;
    let forty = client
        .transaction("expense", "40.00", &bank, &food, "personal")
        .await;
    let csv=b"Date,Debit,Credit,Description,Currency\n2026-09-15,70.00,,First debit,INR\n2026-09-15,50.00,,Second debit,INR\n";
    let key = uuid::Uuid::new_v4().to_string();
    let (status,upload)=upload_file(&client,json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}),"grouped.csv",csv,&key).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
    let batch = upload["id"].as_str().unwrap();
    wait_for_file(&client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({}),
            Some("grouped-commit"),
            Some(revision),
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let observations = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let rows = observations["data"].as_array().unwrap();
    let seventy = rows.iter().find(|v| v["amount"] == "-70.00").unwrap();
    let fifty = rows.iter().find(|v| v["amount"] == "-50.00").unwrap();
    let allocations = json!([
        {"ledger_id":eighty["id"],"ledger_revision":1,"observation_id":seventy["id"],"amount":"-70.00"},
        {"ledger_id":eighty["id"],"ledger_revision":1,"observation_id":fifty["id"],"amount":"-10.00"},
        {"ledger_id":forty["id"],"ledger_revision":1,"observation_id":fifty["id"],"amount":"-40.00"}
    ]);
    let matched = client
        .call(
            "POST",
            &format!("{root}/matches"),
            json!({"decision":"accept","allocations":allocations}),
            Some("grouped-match"),
            Some(1),
        )
        .await;
    assert_eq!(matched.0, StatusCode::OK, "{}", matched.1);
    let ledger = client
        .call(
            "GET",
            &format!("{root}/items?side=ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert!(
        ledger["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["state"] == "matched")
    );
    let first = client
        .call(
            "GET",
            &format!("transactions/{}", eighty["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(
        first["reconciliation_evidence"].as_array().unwrap().len(),
        2
    );
    assert_eq!(first["reconciliation_state"], "matched");
}

#[tokio::test]
async fn reconciliation_amendment_updates_ledger_and_preserves_original_for_export() {
    let (client, _) = setup().await;
    let bank = client.create("accounts", json!({"name":"Bank","subtype":"bank","currency":"INR","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let food = client.category("Food", "expense").await;
    let travel = client.category("Travel", "expense").await;
    let tx = client.create("transactions",json!({"event_type":"expense","amount":"100.00","currency":"INR","effective_date":"2026-09-15","description":"Split expense","movements":[{"account_id":bank["id"],"amount":"-100.00"}],"allocations":[{"category_id":food["id"],"amount":"60.00","scope":"personal"},{"category_id":travel["id"],"amount":"40.00","scope":"personal"}]})).await;
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let observations = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let observation = observations["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["amount"] == "-120.00")
        .unwrap();
    let body = json!({"ledger_id":tx["id"],"ledger_revision":tx["revision"],"observation_id":observation["id"],"proposed_amount":"-120.00","reason":"Statement shows a different amount"});
    let saved = client
        .call(
            "POST",
            &format!("{root}/amendments"),
            body.clone(),
            Some("amendment"),
            Some(1),
        )
        .await;
    assert_eq!(saved.0, StatusCode::OK, "{}", saved.1);
    assert_eq!(saved.1["original_movement"], "-100.00");
    assert_eq!(saved.1["proposed_movement"], "-120.00");
    assert_eq!(saved.1["difference"], "-20.00");
    let original = client
        .call(
            "GET",
            &format!("transactions/{}", tx["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(original["amount"], "120.00");
    assert_eq!(original["revision"], 2);
    assert_eq!(original["allocations"][0]["amount"], "72.00");
    assert_eq!(original["allocations"][1]["amount"], "48.00");
    assert_eq!(original["amendment"]["original_amount"], "100.00");
    assert_eq!(original["amendment"]["id"], saved.1["id"]);
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["net_spending"], "120.00");
    let categories = client
        .call(
            "GET",
            "analytics/categories?scope=personal&from=2026-09-01&to=2026-10-01&currency=INR",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let category_rows = categories["data"].as_array().unwrap();
    assert_eq!(
        category_rows
            .iter()
            .find(|v| v["id"] == food["id"])
            .unwrap()["amount"],
        "72.00"
    );
    assert_eq!(
        category_rows
            .iter()
            .find(|v| v["id"] == travel["id"])
            .unwrap()["amount"],
        "48.00"
    );
    let balance = client
        .call(
            "GET",
            &format!(
                "accounts/{}/balance-at?as_of=2026-09-30T23%3A59%3A00%2B05%3A30",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(balance["amount"], "880.00");
    let listed = client
        .call("GET", &format!("{root}/amendments"), json!({}), None, None)
        .await
        .1;
    assert_eq!(listed["data"][0]["id"], saved.1["id"]);
    assert_eq!(listed["data"][0]["stale"], false);
    let current_session = client.call("GET", &root, json!({}), None, None).await.1;
    let session_revision = current_session["revision"].as_i64().unwrap();
    let duplicate = client
        .call(
            "POST",
            &format!("{root}/amendments"),
            body.clone(),
            Some("duplicate-amendment"),
            Some(session_revision),
        )
        .await;
    assert_eq!(duplicate.0, StatusCode::CONFLICT);
    let cancelled = client
        .call(
            "POST",
            &format!(
                "{root}/amendments/{}/cancel",
                saved.1["id"].as_str().unwrap()
            ),
            json!({"amendment_revision":1,"reason":"Wrong pair selected"}),
            Some("cancel-amendment"),
            Some(session_revision),
        )
        .await;
    assert_eq!(cancelled.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn grouped_difference_can_amend_one_transaction_after_partial_attachment() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let first = client
        .transaction("expense", "80.00", &bank, &food, "personal")
        .await;
    let second = client
        .transaction("expense", "40.00", &bank, &food, "personal")
        .await;
    let csv = b"Date,Debit,Credit,Description,Currency\n2026-09-15,121.00,,Combined debit,INR\n";
    let key = uuid::Uuid::new_v4().to_string();
    let (status, upload) = upload_file(&client, json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}), "group-difference.csv", csv, &key).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
    let batch = upload["id"].as_str().unwrap();
    wait_for_file(&client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
    let revision = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let committed = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({}),
            Some("group-difference-commit"),
            Some(revision),
        )
        .await;
    assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let statement = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let observation = &statement["data"][0];
    let matched = client.call("POST", &format!("{root}/matches"), json!({"decision":"accept","allocations":[
        {"ledger_id":first["id"],"ledger_revision":1,"observation_id":observation["id"],"amount":"-80.00"},
        {"ledger_id":second["id"],"ledger_revision":1,"observation_id":observation["id"],"amount":"-40.00"}
    ]}), Some("group-difference-match"), Some(1)).await;
    assert_eq!(matched.0, StatusCode::OK, "{}", matched.1);
    let before = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(before["data"][0]["remaining"], "-1.00");
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let failed = client.call("POST", &format!("{root}/amendments/batch"), json!({"amendments":[
        {"ledger_id":first["id"],"ledger_revision":1,"observation_id":observation["id"],"proposed_amount":"-81.00","proposed_date":"2026-09-15","reason":"One rupee missing"},
        {"ledger_id":second["id"],"ledger_revision":1,"observation_id":observation["id"],"proposed_amount":"40.00","proposed_date":"2026-09-15","reason":"Invalid direction"}
    ]}), Some("group-difference-invalid-batch"), current["revision"].as_i64()).await;
    assert_eq!(failed.0, StatusCode::BAD_REQUEST, "{}", failed.1);
    let unchanged = client
        .call(
            "GET",
            &format!("{root}/items?side=ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(
        unchanged["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == first["id"])
            .unwrap()["amount"],
        "-80.00"
    );
    let amendment = client.call("POST", &format!("{root}/amendments/batch"), json!({"amendments":[{"ledger_id":first["id"],"ledger_revision":1,"observation_id":observation["id"],"proposed_amount":"-81.00","proposed_date":"2026-09-15","reason":"One rupee missing from the first transaction"}]}), Some("group-difference-amendment"), current["revision"].as_i64()).await;
    assert_eq!(amendment.0, StatusCode::OK, "{}", amendment.1);
    let ledger = client
        .call(
            "GET",
            &format!("{root}/items?side=ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let first_after = ledger["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == first["id"])
        .unwrap();
    let second_after = ledger["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == second["id"])
        .unwrap();
    assert_eq!(first_after["remaining"], "-81.00");
    assert_eq!(second_after["remaining"], "-40.00");
    let statement_after = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(statement_after["data"][0]["remaining"], "-121.00");
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let finished = client.call("POST", &format!("{root}/matches"), json!({"decision":"accept","allocations":[
        {"ledger_id":first["id"],"ledger_revision":first_after["revision"],"observation_id":observation["id"],"amount":"-81.00"},
        {"ledger_id":second["id"],"ledger_revision":second_after["revision"],"observation_id":observation["id"],"amount":"-40.00"}
    ]}), Some("group-difference-finish"), current["revision"].as_i64()).await;
    assert_eq!(finished.0, StatusCode::OK, "{}", finished.1);
    let final_statement = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(final_statement["data"][0]["state"], "matched");
}

#[tokio::test]
async fn reconciliation_ignores_and_grouped_statement_creation_are_auditable() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let existing = client
        .transaction("expense", "10.00", &bank, &food, "personal")
        .await;
    let csv=b"Date,Debit,Credit,Description,Currency\n2026-09-15,70.00,,First debit,INR\n2026-09-16,50.00,,Second debit,INR\n";
    let key = uuid::Uuid::new_v4().to_string();
    let (status,upload)=upload_file(&client,json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}),"create-group.csv",csv,&key).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
    let batch = upload["id"].as_str().unwrap();
    wait_for_file(&client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
    let rev = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    assert_eq!(
        client
            .call(
                "POST",
                &format!("imports/{batch}/commit"),
                json!({}),
                Some("create-group-commit"),
                Some(rev)
            )
            .await
            .0,
        StatusCode::OK
    );
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let statements = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let ids: Vec<Value> = statements["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    let ignored=client.call("POST",&format!("{root}/ignored"),json!({"ledger_ids":[existing["id"]],"observation_ids":[ids[0]],"reason":"Review separately"}),Some("ignore-both"),Some(1)).await;
    assert_eq!(ignored.0, StatusCode::OK, "{}", ignored.1);
    let ledger = client
        .call(
            "GET",
            &format!("{root}/items?side=ledger"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(ledger["data"][0]["state"], "ignored");
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    assert_eq!(current["current"]["ledger_unmatched_count"], 0);
    assert_eq!(current["current"]["observation_unmatched_count"], 1);
    let create_body = json!({"observation_ids":ids,"description":"Grouped card spending","effective_date":"2026-09-16","category_id":food["id"],"scope":"personal","reason":"Missing from Money Manager"});
    let rejected = client
        .call(
            "POST",
            &format!("{root}/created-ledger-entries"),
            create_body.clone(),
            Some("create-ignored"),
            current["revision"].as_i64(),
        )
        .await;
    assert_eq!(rejected.0, StatusCode::CONFLICT);
    for ignored_row in ignored.1["ignored"].as_array().unwrap() {
        let current = client.call("GET", &root, json!({}), None, None).await.1;
        let restored = client
            .call(
                "POST",
                &format!(
                    "{root}/ignored/{}/restore",
                    ignored_row["id"].as_str().unwrap()
                ),
                json!({"ignore_revision":ignored_row["revision"]}),
                Some(&format!("restore-{}", ignored_row["id"].as_str().unwrap())),
                current["revision"].as_i64(),
            )
            .await;
        assert_eq!(restored.0, StatusCode::OK, "{}", restored.1);
    }
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let created = client
        .call(
            "POST",
            &format!("{root}/created-ledger-entries"),
            create_body,
            Some("create-grouped-entry"),
            current["revision"].as_i64(),
        )
        .await;
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    assert_eq!(created.1["transaction"]["amount"], "120.00");
    assert_eq!(
        created.1["transaction"]["reconciliation_created"]["status"],
        "pending_money_manager_update"
    );
    assert_eq!(
        created.1["transaction"]["source_refs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let listed = client
        .call(
            "GET",
            &format!("{root}/created-ledger-entries"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    let refreshed = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert!(
        refreshed["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["state"] == "matched")
    );
    let detail = client
        .call(
            "GET",
            &format!(
                "transactions/{}",
                created.1["transaction"]["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(
        detail["reconciliation_evidence"].as_array().unwrap().len(),
        2
    );
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["net_spending"], "130.00");
}

#[tokio::test]
async fn internal_transfer_connects_both_accounts_and_statement_reviews() {
    let (client, _) = setup().await;
    let source = client.account("Source bank", "bank").await;
    let destination = client.account("Destination bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let existing = client
        .transaction("expense", "30.00", &source, &food, "personal")
        .await;
    let statements:[(&Value,&str,&[u8]);2]=[
        (&source,"source-transfer.csv",b"Date,Debit,Credit,Description,Currency\n2026-09-15,75.00,,Transfer out,INR\n2026-09-15,30.00,,Second transfer out,INR\n2026-09-15,20.00,,Automatically matched transfer out,INR\n"),
        (&destination,"destination-transfer.csv",b"Date,Debit,Credit,Description,Currency\n2026-09-15,,75.00,Transfer in,INR\n2026-09-15,,30.00,Second transfer in,INR\n2026-09-15,,20.00,Automatically matched transfer in,INR\n"),
    ];
    for (account, name, csv) in statements {
        let key = uuid::Uuid::new_v4().to_string();
        let (status,upload)=upload_file(&client,json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":account["id"],"currency":"INR"}}]}),name,csv,&key).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{upload}");
        let batch = upload["id"].as_str().unwrap();
        wait_for_file(&client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
        let revision = client
            .call("GET", &format!("imports/{batch}"), json!({}), None, None)
            .await
            .1["revision"]
            .as_i64()
            .unwrap();
        let committed = client
            .call(
                "POST",
                &format!("imports/{batch}/commit"),
                json!({}),
                Some(&format!("commit-{key}")),
                Some(revision),
            )
            .await;
        assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
    }
    let review = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":source["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!("reconciliation/sessions/{}", review["id"].as_str().unwrap());
    let source_rows = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let outgoing = source_rows["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["amount"] == "-75.00")
        .unwrap();
    let candidate = client
        .call(
            "GET",
            &format!(
                "{root}/internal-transfer-candidates?observation_id={}",
                outgoing["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(candidate.0, StatusCode::OK, "{}", candidate.1);
    assert_eq!(candidate.1["data"].as_array().unwrap().len(), 1);
    let incoming = &candidate.1["data"][0];
    assert_eq!(incoming["account_id"], destination["id"]);
    let created=client.call("POST",&format!("{root}/internal-transfer"),json!({"observation_id":outgoing["id"],"counterpart_account_id":destination["id"],"counterpart_observation_id":incoming["observation_id"],"description":"Move between banks","reason":"Own-account transfer"}),Some("create-internal-transfer"),Some(1)).await;
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    assert_eq!(created.1["transaction"]["event_type"], "transfer");
    assert_eq!(
        created.1["transaction"]["reconciliation_created"]["action"],
        "add_transfer"
    );
    assert_eq!(
        created.1["transaction"]["movements"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(created.1["source_match"].is_object());
    assert!(created.1["counterpart_match"].is_object());
    let destination_root = format!(
        "reconciliation/sessions/{}",
        created.1["counterpart_session_id"].as_str().unwrap()
    );
    let dest_rows = client
        .call(
            "GET",
            &format!("{destination_root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(
        dest_rows["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["amount"] == "75.00")
            .unwrap()["state"],
        "matched"
    );
    let remaining = source_rows["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["amount"] == "-30.00")
        .unwrap();
    let candidate = client
        .call(
            "GET",
            &format!(
                "{root}/internal-transfer-candidates?ledger_id={}",
                existing["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let incoming_second = &candidate["data"][0];
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let converted=client.call("POST",&format!("{root}/internal-transfer"),json!({"ledger_id":existing["id"],"observation_id":remaining["id"],"counterpart_account_id":destination["id"],"counterpart_observation_id":incoming_second["observation_id"],"reason":"This expense was a transfer"}),Some("convert-internal-transfer"),current["revision"].as_i64()).await;
    assert_eq!(converted.0, StatusCode::OK, "{}", converted.1);
    assert_eq!(converted.1["transaction"]["id"], existing["id"]);
    assert_eq!(converted.1["transaction"]["event_type"], "transfer");
    assert_eq!(
        converted.1["transaction"]["allocations"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        converted.1["transaction"]["reconciliation_created"]["action"],
        "update_transfer"
    );
    let detail = client
        .call(
            "GET",
            &format!("transactions/{}", existing["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(detail["reconciliation_state"], "matched");
    assert_eq!(
        detail["reconciliation_evidence"].as_array().unwrap().len(),
        2
    );
    let changes = client
        .call(
            "GET",
            &format!("{root}/created-ledger-entries"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(changes["data"].as_array().unwrap().len(), 2);
    let auto_expense = client
        .transaction("expense", "20.00", &source, &food, "personal")
        .await;
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let automatic = client
        .call(
            "POST",
            &format!("{root}/auto-match"),
            json!({}),
            Some("auto-match-transfer"),
            current["revision"].as_i64(),
        )
        .await;
    assert_eq!(automatic.0, StatusCode::OK, "{}", automatic.1);
    assert_eq!(automatic.1["matched_count"], 1);
    let matched_candidate = client
        .call(
            "GET",
            &format!(
                "{root}/internal-transfer-candidates?ledger_id={}",
                auto_expense["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(
        matched_candidate.0,
        StatusCode::OK,
        "{}",
        matched_candidate.1
    );
    assert_eq!(matched_candidate.1["data"].as_array().unwrap().len(), 1);
    let current = client.call("GET", &root, json!({}), None, None).await.1;
    let reclassified = client.call("POST", &format!("{root}/internal-transfer"),json!({"ledger_id":auto_expense["id"],"counterpart_account_id":destination["id"],"counterpart_observation_id":matched_candidate.1["data"][0]["observation_id"],"reason":"Automatic match was an internal transfer"}),Some("convert-auto-matched-transfer"),current["revision"].as_i64()).await;
    assert_eq!(reclassified.0, StatusCode::OK, "{}", reclassified.1);
    assert_eq!(reclassified.1["transaction"]["event_type"], "transfer");
    assert!(reclassified.1["source_match"].is_object());
    assert!(reclassified.1["counterpart_match"].is_object());
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["net_spending"], "0.00");
    assert_eq!(summary["transfer_volume"], "125.00");
}

#[tokio::test]
async fn date_only_amendment_moves_transaction_to_statement_date() {
    let (client, _) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let salary = client.category("Salary", "income").await;
    let tx = client
        .transaction("income", "500.00", &bank, &salary, "personal")
        .await;
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let observations = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let observation = observations["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["amount"] == "500.00")
        .unwrap();
    let saved = client.call("POST", &format!("{root}/amendments"), json!({"ledger_id":tx["id"],"ledger_revision":1,"observation_id":observation["id"],"proposed_amount":"500.00","reason":"Posting date differs"}), Some("date-amendment"), Some(1)).await;
    assert_eq!(saved.0, StatusCode::OK, "{}", saved.1);
    assert_eq!(saved.1["difference"], "0.00");
    assert_eq!(saved.1["original_date"], "2026-09-15");
    assert_eq!(saved.1["proposed_date"], "2026-09-16");
    let original = client
        .call(
            "GET",
            &format!("transactions/{}", tx["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(original["amount"], "500.00");
    assert_eq!(original["effective_date"], "2026-09-16");
    assert_eq!(original["amendment"]["original_date"], "2026-09-15");
}

#[tokio::test]
async fn transfer_amendment_updates_both_account_movements_without_spending() {
    let (client, _) = setup().await;
    let bank=client.create("accounts",json!({"name":"Bank","subtype":"bank","currency":"INR","opening_balance":{"amount":"1000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let cash=client.create("accounts",json!({"name":"Cash","subtype":"cash","currency":"INR","opening_balance":{"amount":"0.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let tx=client.create("transactions",json!({"event_type":"transfer","amount":"100.00","currency":"INR","effective_date":"2026-09-15","description":"Cash withdrawal","movements":[{"account_id":bank["id"],"amount":"-100.00"},{"account_id":cash["id"],"amount":"100.00"}],"allocations":[]})).await;
    bank_evidence(&client, &bank).await;
    let session = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!(
        "reconciliation/sessions/{}",
        session["id"].as_str().unwrap()
    );
    let observations = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    let observation = observations["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["amount"] == "-120.00")
        .unwrap();
    let saved=client.call("POST",&format!("{root}/amendments"),json!({"ledger_id":tx["id"],"ledger_revision":1,"observation_id":observation["id"],"proposed_amount":"-120.00","reason":"Correct transfer amount"}),Some("transfer-amendment"),Some(1)).await;
    assert_eq!(saved.0, StatusCode::OK, "{}", saved.1);
    let current = client
        .call(
            "GET",
            &format!("transactions/{}", tx["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(current["movements"][0]["amount"], "-120.00");
    assert_eq!(current["movements"][1]["amount"], "120.00");
    let summary = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(summary["transfer_volume"], "120.00");
    assert_eq!(summary["net_spending"], "0.00");
}

#[tokio::test]
async fn reconciliation_partial_matching_conserves_value_and_edits_invalidate() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let tx = client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    bank_evidence(&client, &bank).await;
    // Overlapping imports retain one immutable observation for each occurrence.
    bank_evidence(&client, &bank).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM bank_observations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let s = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!("reconciliation/sessions/{}", s["id"].as_str().unwrap());
    let rows = client
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(rows.0, StatusCode::OK, "{}", rows.1);
    let obs = &rows.1["data"][0];
    let candidates = client
        .call(
            "GET",
            &format!("{root}/candidates?ledger_id={}", tx["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(candidates.1["data"][0]["observation_id"], obs["id"]);
    assert_eq!(candidates.1["data"][0]["exact_amount"], true);
    let body = json!({"decision":"accept","allocations":[{"ledger_id":tx["id"],"ledger_revision":1,"observation_id":obs["id"],"amount":"-70.00"}]});
    let matched = client
        .call(
            "POST",
            &format!("{root}/matches"),
            body.clone(),
            Some("partial-match"),
            Some(1),
        )
        .await;
    assert_eq!(matched.0, StatusCode::OK, "{}", matched.1);
    assert_eq!(
        client
            .call(
                "POST",
                &format!("{root}/matches"),
                body.clone(),
                Some("partial-match"),
                Some(1)
            )
            .await
            .1,
        matched.1
    );
    assert_eq!(
        client
            .call(
                "POST",
                &format!("{root}/matches"),
                body.clone(),
                Some("stale-match"),
                Some(1)
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .call(
                "POST",
                &format!("{root}/matches"),
                body.clone(),
                Some("over-match"),
                Some(2)
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut rest = body.clone();
    rest["allocations"][0]["amount"] = json!("-50.00");
    let second = client
        .call(
            "POST",
            &format!("{root}/matches"),
            rest,
            Some("rest-match"),
            Some(2),
        )
        .await;
    assert_eq!(second.0, StatusCode::OK, "{}", second.1);
    let current = client
        .call(
            "GET",
            &format!("transactions/{}", tx["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(current["revision"], 1);
    assert_eq!(current["reconciliation_state"], "matched");
    let statement = client
        .call(
            "GET",
            &format!(
                "accounts/{}/statements?month=2026-09",
                bank["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(statement["signed_movements"], "-120.00");
    assert_eq!(statement["ledger_unmatched_count"], 0);
    assert_eq!(statement["observation_unmatched_count"], 1);
    let close=client.call("POST",&format!("{root}/close"),json!({"reason":"Income is still unrecorded; coverage unknown.","closing_evidence":{"note":"Synthetic fixture"}}),Some("close-review"),Some(3)).await;
    assert_eq!(close.0, StatusCode::OK, "{}", close.1);
    assert_eq!(close.1["closure"]["snapshot"]["unresolved_count"], 1);
    let edited = client
        .call(
            "PATCH",
            &format!("transactions/{}", tx["id"].as_str().unwrap()),
            json!({"description":"Corrected merchant"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(edited.0, StatusCode::OK, "{}", edited.1);
    let session = client.call("GET", &root, json!({}), None, None).await.1;
    assert_eq!(session["stale"], true);
    assert_eq!(session["needs_review"], true);
    assert_eq!(session["revision"], 5);
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reconciliation_links WHERE active=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, 0);
    let reopen = client
        .call(
            "POST",
            &format!("{root}/reopen"),
            json!({"reason":"Review corrected merchant"}),
            Some("reopen-review"),
            Some(5),
        )
        .await;
    assert_eq!(reopen.0, StatusCode::OK, "{}", reopen.1);
    let totals = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(totals["net_spending"], "120.00");
}

#[tokio::test]
async fn reconciliation_authorization_atomic_missing_entry_rejection_and_replay() {
    let (owner, pool) = setup().await;
    let (partner, member) = partner(&owner).await;
    let bank = owner.account("Private", "bank").await;
    bank_evidence(&owner, &bank).await;
    let s = owner
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!("reconciliation/sessions/{}", s["id"].as_str().unwrap());
    assert_eq!(
        partner
            .call(
                "GET",
                &format!("{root}/items?side=statement"),
                json!({}),
                None,
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        partner
            .call("GET", "reconciliation/sessions", json!({}), None, None)
            .await
            .1["data"],
        json!([])
    );
    let grant = format!(
        "accounts/{}/access/{}",
        bank["id"].as_str().unwrap(),
        member["id"].as_str().unwrap()
    );
    assert_eq!(
        owner
            .call("PUT", &grant, json!({"granted":true}), None, Some(1))
            .await
            .0,
        StatusCode::OK
    );
    let obs = partner
        .call(
            "GET",
            &format!("{root}/items?side=statement"),
            json!({}),
            None,
            None,
        )
        .await
        .1["data"][0]
        .clone();
    let transaction = json!({"event_type":"expense","amount":"120.00","currency":"INR","effective_date":"2026-09-15","movements":[{"account_id":bank["id"],"amount":"-120.00"}],"allocations":[{"amount":"120.00","scope":"personal"}]});
    let mut body = json!({"observation_id":obs["id"],"reason":"Confirmed missing purchase","transaction":transaction});
    body["transaction"]["movements"][0]["amount"] = json!("-119.00");
    assert_eq!(
        partner
            .call(
                "POST",
                &format!("{root}/missing-ledger-entry"),
                body.clone(),
                Some("bad-missing"),
                Some(1)
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    body["transaction"]["movements"][0]["amount"] = json!("-120.00");
    let created = partner
        .call(
            "POST",
            &format!("{root}/missing-ledger-entry"),
            body.clone(),
            Some("missing"),
            Some(1),
        )
        .await;
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    let reject = format!(
        "{root}/matches/{}/reject",
        created.1["match"]["id"].as_str().unwrap()
    );
    let rejected = partner
        .call(
            "POST",
            &reject,
            json!({"reason":"Wrong evidence","match_revision":1}),
            Some("reject"),
            Some(2),
        )
        .await;
    assert_eq!(rejected.0, StatusCode::OK, "{}", rejected.1);
    let tx = owner
        .call(
            "GET",
            &format!(
                "transactions/{}",
                created.1["transaction"]["id"].as_str().unwrap()
            ),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(tx["voided"], false);
    assert_eq!(tx["revision"], 1);
    assert_eq!(tx["reconciliation_state"], "unmatched");
    assert_eq!(
        owner
            .call("PUT", &grant, json!({"granted":false}), None, Some(2))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        partner
            .call(
                "POST",
                &format!("{root}/missing-ledger-entry"),
                body,
                Some("missing"),
                Some(1)
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn reconciliation_preview_corrections_and_duplicate_merges_preserve_history() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let food = client.category("Food", "expense").await;
    let a = client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    let b = client
        .transaction("expense", "120.00", &bank, &food, "personal")
        .await;
    let s = client
        .create(
            "reconciliation/sessions",
            json!({"account_id":bank["id"],"month":"2026-09"}),
        )
        .await;
    let root = format!("reconciliation/sessions/{}", s["id"].as_str().unwrap());
    let candidates = client
        .call("GET", &format!("{root}/duplicates"), json!({}), None, None)
        .await
        .1;
    assert_eq!(candidates["data"].as_array().unwrap().len(), 1);
    let path = format!(
        "{root}/duplicates/{}",
        candidates["data"][0]["id"].as_str().unwrap()
    );
    let mut body = json!({"survivor_id":a["id"],"discarded_id":b["id"],"survivor_revision":1,"discarded_revision":1});
    let preview = client
        .call(
            "POST",
            &format!("{path}/merge-preview"),
            body.clone(),
            Some("merge-preview"),
            Some(1),
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["impact"]["net_spending_delta"], "-120.00");
    assert_eq!(
        preview.1["impact"]["account_movement_deltas"][0]["amount"],
        "120.00"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions' AND json_extract(document,'$.voided')=0").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 2);
    body["reason"] = json!("Confirmed duplicate in source exports");
    body["preview_token"] = json!("wrong");
    assert_eq!(
        client
            .call(
                "POST",
                &format!("{path}/merge"),
                body.clone(),
                Some("bad-merge"),
                Some(1)
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    body["preview_token"] = preview.1["preview_token"].clone();
    let merge = client
        .call(
            "POST",
            &format!("{path}/merge"),
            body,
            Some("merge"),
            Some(1),
        )
        .await;
    assert_eq!(merge.0, StatusCode::OK, "{}", merge.1);
    assert_eq!(merge.1["discarded"]["voided"], true);
    assert_eq!(merge.1["discarded"]["merged_into"], a["id"]);
    assert_eq!(merge.1["survivor"]["revision"], 2);
    let mut correction = json!({"mode":"preview","ledger_id":a["id"],"ledger_revision":2,"changes":{"amount":"100.00","movements":[{"account_id":bank["id"],"amount":"-100.00"}],"allocations":[{"category_id":food["id"],"amount":"100.00","scope":"personal"}]}});
    let preview = client
        .call(
            "POST",
            &format!("{root}/corrections"),
            correction.clone(),
            Some("correct-preview"),
            Some(2),
        )
        .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    assert_eq!(preview.1["impact"]["net_spending_delta"], "-20.00");
    correction["mode"] = json!("apply");
    correction["preview_token"] = preview.1["preview_token"].clone();
    correction["reason"] = json!("Corrected receipt amount");
    let applied = client
        .call(
            "POST",
            &format!("{root}/corrections"),
            correction.clone(),
            Some("apply-correction"),
            Some(2),
        )
        .await;
    assert_eq!(applied.0, StatusCode::OK, "{}", applied.1);
    assert_eq!(applied.1["transaction"]["revision"], 3);
    assert_eq!(
        client
            .call(
                "POST",
                &format!("{root}/corrections"),
                correction,
                Some("stale-correction"),
                Some(3)
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let history = client
        .call(
            "GET",
            &format!("transactions/{}/revisions", b["id"].as_str().unwrap()),
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(history["data"][1]["action"], "duplicate_merged");
    let total = client
        .call(
            "GET",
            "analytics/summary?from=2026-09-01&to=2026-10-01",
            json!({}),
            None,
            None,
        )
        .await
        .1;
    assert_eq!(total["net_spending"], "100.00");
}

#[tokio::test]
async fn bank_observation_identity_includes_direction_reference_and_survives_recovery() {
    let (client, pool) = setup().await;
    let bank = client.account("Bank", "bank").await;
    let bytes=b"Date,Debit,Credit,Description,Currency,Reference\n2026-09-15,10.00,,Same,INR,A\n2026-09-15,,10.00,Same,INR,A\n2026-09-15,10.00,,Same,INR,B\n";
    let (_,upload)=upload_file(&client,json!({"files":[{"source_kind":"bank_statement","mapping":{"account_id":bank["id"],"currency":"INR"}}]}),"bank.csv",bytes,"directions").await;
    let batch = upload["id"].as_str().unwrap();
    wait_for_file(&client, batch, upload["files"][0]["id"].as_str().unwrap()).await;
    let rev = client
        .call("GET", &format!("imports/{batch}"), json!({}), None, None)
        .await
        .1["revision"]
        .as_i64()
        .unwrap();
    let commit = client
        .call(
            "POST",
            &format!("imports/{batch}/commit"),
            json!({}),
            Some("directions-commit"),
            Some(rev),
        )
        .await;
    assert_eq!(commit.0, StatusCode::OK, "{}", commit.1);
    assert_eq!(commit.1["counts"]["observations"], 3);
    let before: Vec<String> =
        sqlx::query_scalar("SELECT document FROM bank_observations ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    // Simulate the old unsigned fingerprint and its combined occurrence ordinals.
    let legacy = finwise_api::auth::hash(&json!({"event_type":"observation","effective_date":"2026-09-15","currency":"INR","amount":"10.00","source_account":null,"source_category":null,"source_subcategory":null,"description":"Same","note":null}).to_string());
    for doc in &before {
        let doc: Value = serde_json::from_str(doc).unwrap();
        sqlx::query("UPDATE import_occurrences SET fingerprint=?,occurrence=? WHERE id=?")
            .bind(&legacy)
            .bind(doc["raw_row_ref"]["row_number"].as_i64().unwrap() - 1)
            .bind(doc["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    // Startup must recover the original IDs and split ordinals, exactly once.
    sqlx::query("DELETE FROM bank_observations")
        .execute(&pool)
        .await
        .unwrap();
    finwise_api::imports::recover(&pool).await.unwrap();
    finwise_api::imports::recover(&pool).await.unwrap();
    let after: Vec<String> =
        sqlx::query_scalar("SELECT document FROM bank_observations ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let ordinals: Vec<i64> = sqlx::query_scalar("SELECT occurrence FROM import_occurrences")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(ordinals, vec![1, 1, 1]);
}

/// Opt-in local acceptance test. Never copy personal workbooks into test fixtures.
#[tokio::test]
#[ignore = "requires FINWISE_TEST_WORKBOOK pointing to a local Money Manager XLSX"]
async fn real_money_manager_workbook_import() {
    use finwise_api::{
        domain::{format_money, money},
        import_parse,
    };
    use std::collections::{BTreeMap, BTreeSet};
    let path = std::env::var("FINWISE_TEST_WORKBOOK").expect("Set FINWISE_TEST_WORKBOOK");
    let bytes = std::fs::read(path).expect("Read local workbook");
    let parsed = import_parse::parse_xlsx(&bytes).expect("Parse XLSX");
    let rows: Vec<Value> = parsed
        .rows
        .iter()
        .map(|r| import_parse::normalize(&parsed, r, "money_manager", None))
        .collect();
    assert!(!rows.is_empty());
    println!(
        "Workbook fields: description populated on {} rows; note populated on {} rows; category populated on {} rows.",
        rows.iter()
            .filter(|r| r["description"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty()))
            .count(),
        rows.iter()
            .filter(|r| r["note"].as_str().is_some_and(|s| !s.trim().is_empty()))
            .count(),
        rows.iter()
            .filter(|r| r["source_category"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty()))
            .count()
    );
    let mut labels = BTreeSet::new();
    let mut kinds = BTreeMap::<String, usize>::new();
    let mut categories = BTreeSet::new();
    let mut totals = BTreeMap::<String, i64>::new();
    for row in &rows {
        assert!(
            row["issues"].as_array().unwrap().is_empty(),
            "Source row has normalization issues"
        );
        labels.insert(row["source_account"].as_str().unwrap().trim().to_owned());
        let kind = row["event_type"].as_str().unwrap();
        *kinds.entry(kind.into()).or_default() += 1;
        *totals.entry(kind.into()).or_default() +=
            money(row["amount"].as_str().unwrap(), "INR").unwrap();
        if ["expense", "income"].contains(&kind) {
            categories.insert((
                row["source_category"].as_str().unwrap().trim().to_owned(),
                row["source_subcategory"]
                    .as_str()
                    .unwrap()
                    .trim()
                    .to_owned(),
                kind.to_owned(),
            ));
        }
    }
    let (client, pool) = setup().await;
    let mut aliases = json!({});
    for label in &labels {
        aliases[label] = client.account(label, "bank").await["id"].clone();
    }
    let mut mappings = Vec::new();
    for (label, sub, kind) in &categories {
        let category = client.category(&format!("{label} {sub}"), kind).await;
        mappings.push(json!({"source_label":label,"subcategory":sub,"event_kind":kind,"category_id":category["id"]}));
    }
    let manifest = json!({"files":[{"source_kind":"money_manager","mapping":{"account_aliases":aliases,"category_mappings":mappings}}]});
    let mut first_count = 0;
    for attempt in 0..2 {
        let (status, upload) = upload_file(
            &client,
            manifest.clone(),
            "local-acceptance.xlsx",
            &bytes,
            &format!("real-upload-{attempt}"),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let batch = upload["id"].as_str().unwrap();
        let file = upload["files"][0]["id"].as_str().unwrap();
        wait_for_file(&client, batch, file).await;
        let preview = client
            .call(
                "GET",
                &format!("imports/{batch}/preview?file_id={file}&limit=200"),
                json!({}),
                None,
                None,
            )
            .await;
        assert_eq!(preview.0, StatusCode::OK);
        assert_eq!(
            preview.1["meta"]["row_count"].as_u64().unwrap() as usize,
            rows.len()
        );
        assert_eq!(
            preview.1["meta"]["unresolved_count"], 0,
            "Preview has unresolved rows"
        );
        let revision = client
            .call("GET", &format!("imports/{batch}"), json!({}), None, None)
            .await
            .1["revision"]
            .as_i64()
            .unwrap();
        let result = client
            .call(
                "POST",
                &format!("imports/{batch}/commit"),
                json!({}),
                Some(&format!("real-commit-{attempt}")),
                Some(revision),
            )
            .await;
        assert_eq!(result.0, StatusCode::OK);
        assert_eq!(
            result.1["counts"]["pending_review"], 0,
            "Transfer or duplicate review remains"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM resources WHERE kind='transactions'")
                .fetch_one(&pool)
                .await
                .unwrap();
        if attempt == 0 {
            first_count = count;
            let candidate = rows
                .iter()
                .enumerate()
                .find(|(_, r)| {
                    ["expense", "income"].contains(&r["event_type"].as_str().unwrap_or(""))
                        && r["source_description"]
                            .as_str()
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        && !r["note"].as_str().unwrap_or("").trim().is_empty()
                })
                .unwrap();
            let row_number = parsed.rows[candidate.0].row_number as i64;
            let items = client
                .call("GET", "transactions?limit=200", json!({}), None, None)
                .await
                .1;
            let transaction = items["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| {
                    v["source_refs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["row_number"] == row_number && r["file_id"] == file)
                })
                .unwrap();
            assert_eq!(transaction["description"], candidate.1["note"]);
        } else {
            assert_eq!(count, first_count, "Repeated import created events");
            assert_eq!(result.1["counts"]["created"], 0);
            assert_eq!(result.1["counts"]["paired_transfers"], 0);
        }
        assert_eq!(
            count as usize,
            kinds.get("expense").unwrap_or(&0)
                + kinds.get("income").unwrap_or(&0)
                + kinds.get("transfer_out").unwrap_or(&0)
        );
    }
    let first = rows
        .iter()
        .map(|r| r["effective_date"].as_str().unwrap())
        .min()
        .unwrap();
    let last = rows
        .iter()
        .map(|r| r["effective_date"].as_str().unwrap())
        .max()
        .unwrap();
    let end = finwise_api::domain::date(last).unwrap().succ_opt().unwrap();
    let report = client
        .call(
            "GET",
            &format!("analytics/summary?from={first}&to={end}"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(report.0, StatusCode::OK);
    for (field, kind) in [
        ("net_spending", "expense"),
        ("income", "income"),
        ("transfer_volume", "transfer_out"),
    ] {
        assert_eq!(
            report.1[field],
            format_money(*totals.get(kind).unwrap_or(&0), "INR").unwrap(),
            "Report disagrees with source totals"
        );
    }
    println!(
        "Money Manager acceptance: {} rows, {} accounts, {} category/subcategory/kind mappings, {} events; event counts {:?}; dates {} through {}. Exact totals and duplicate re-import passed. Temporary database only.",
        rows.len(),
        labels.len(),
        categories.len(),
        first_count,
        kinds,
        first,
        last
    );
}

#[tokio::test]
async fn money_manager_note_fills_description_and_repeat_import_reuses_legacy_occurrence() {
    let (client, pool) = setup().await;
    let account = client.account("Bank", "bank").await;
    let category = client.category("Groceries", "expense").await;
    let bytes=b"Period,Income/Expense,Accounts,Category,Subcategory,Amount,Currency,Description,Note\n2026-09-15,Exp.,Bank,Groceries,,12.34,INR,,Synthetic receipt note\n";
    let mapping = json!({"account_aliases":{"Bank":account["id"]},"category_mappings":[{"source_label":"Groceries","event_kind":"expense","category_id":category["id"]}]});
    let mut original_id = String::new();
    for index in 0..2 {
        let (_, uploaded) = upload_file(
            &client,
            json!({"files":[{"source_kind":"money_manager","mapping":mapping}]}),
            "note.csv",
            bytes,
            &format!("note-upload-{index}"),
        )
        .await;
        let batch = uploaded["id"].as_str().unwrap();
        let file = uploaded["files"][0]["id"].as_str().unwrap();
        wait_for_file(&client, batch, file).await;
        let preview = client
            .call(
                "GET",
                &format!("imports/{batch}/preview?file_id={file}"),
                json!({}),
                None,
                None,
            )
            .await
            .1;
        assert_eq!(preview["data"][0]["description"], "Synthetic receipt note");
        assert_eq!(preview["data"][0]["source_description"], "");
        let revision = client
            .call("GET", &format!("imports/{batch}"), json!({}), None, None)
            .await
            .1["revision"]
            .as_i64()
            .unwrap();
        let committed = client
            .call(
                "POST",
                &format!("imports/{batch}/commit"),
                json!({"files":[file]}),
                Some(&format!("note-commit-{index}")),
                Some(revision),
            )
            .await;
        assert_eq!(committed.0, StatusCode::OK, "{}", committed.1);
        assert_eq!(
            committed.1["counts"]["created"],
            if index == 0 { 1 } else { 0 }
        );
        let transactions = client
            .call("GET", "transactions", json!({}), None, None)
            .await
            .1;
        assert_eq!(transactions["data"].as_array().unwrap().len(), 1);
        let item = &transactions["data"][0];
        assert_eq!(item["description"], "Synthetic receipt note");
        if index == 0 {
            original_id = item["id"].as_str().unwrap().into();
            // Emulate an entry committed by the previous parser before Note fallback.
            sqlx::query(
                "UPDATE resources SET document=json_set(document,'$.description','') WHERE id=?",
            )
            .bind(&original_id)
            .execute(&pool)
            .await
            .unwrap();
            finwise_api::imports::recover(&pool).await.unwrap();
            finwise_api::imports::recover(&pool).await.unwrap();
            let repaired = client
                .call(
                    "GET",
                    &format!("transactions/{original_id}"),
                    json!({}),
                    None,
                    None,
                )
                .await
                .1;
            assert_eq!(repaired["description"], "Synthetic receipt note");
            assert_eq!(repaired["revision"], 2);
            let revisions = client
                .call(
                    "GET",
                    &format!("transactions/{original_id}/revisions"),
                    json!({}),
                    None,
                    None,
                )
                .await
                .1;
            assert_eq!(
                revisions["data"][1]["action"],
                "source_description_repaired"
            );
        } else {
            assert_eq!(item["id"], original_id);
        }
    }
}

#[tokio::test]
async fn money_manager_queue_and_card_due_are_revisioned() {
    let (client, _) = setup().await;
    let bank = client.account("Current", "bank").await;
    let bank_id = bank["id"].as_str().unwrap();
    let card = client
        .call(
            "PATCH",
            &format!("accounts/{bank_id}"),
            json!({"subtype":"credit_card","card_due":{"amount":"250.00","due_date":"2026-10-15"}}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(card.0, StatusCode::OK, "{}", card.1);
    assert_eq!(card.1["balance"]["basis"], "amount_owed");
    assert_eq!(card.1["card_due"]["amount"], "250.00");
    let category = client.category("Food", "expense").await;
    let entry = client
        .transaction("expense", "25.00", &card.1, &category, "personal")
        .await;
    let queue = client
        .call(
            "GET",
            "money-manager/changes?limit=200",
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(queue.0, StatusCode::OK, "{}", queue.1);
    assert!(
        queue.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == entry["id"])
    );
    let entry_id = entry["id"].as_str().unwrap();
    let sync_path = format!("money-manager/changes/{entry_id}/sync");
    let synced = client
        .call(
            "POST",
            &sync_path,
            json!({"synced":true}),
            Some("sync-entry"),
            Some(1),
        )
        .await;
    assert_eq!(synced.0, StatusCode::OK, "{}", synced.1);
    assert!(synced.1["money_manager_synced_at"].is_string());
    let queue = client
        .call(
            "GET",
            "money-manager/changes?limit=200",
            json!({}),
            None,
            None,
        )
        .await;
    assert!(
        !queue.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == entry["id"])
    );
    let done = client
        .call(
            "GET",
            "money-manager/changes?include_done=true&limit=200",
            json!({}),
            None,
            None,
        )
        .await;
    assert!(
        done.1["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == entry["id"] && v["money_manager_synced_at"].is_string())
    );
}

#[tokio::test]
async fn card_conversion_needs_no_statement_due_amount() {
    let (client, _) = setup().await;
    let bank = client.create("accounts", json!({"name":"Card import","subtype":"bank","currency":"INR","opening_balance":{"amount":"0.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    let food = client.category("Food", "expense").await;
    client
        .transaction("expense", "125.00", &bank, &food, "personal")
        .await;
    let path = format!("accounts/{}", bank["id"].as_str().unwrap());
    let converted = client
        .call(
            "PATCH",
            &path,
            json!({"subtype":"credit_card"}),
            None,
            Some(1),
        )
        .await;
    assert_eq!(converted.0, StatusCode::OK, "{}", converted.1);
    assert!(converted.1["card_due"].is_null());
    let balance = client
        .call(
            "GET",
            &format!("{path}/balance-at?as_of=2026-09-30T23%3A59%3A00%2B05%3A30"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(balance.1["basis"], "amount_owed");
    assert_eq!(balance.1["amount"], "125.00");
    let reminder = client
        .call(
            "PATCH",
            &path,
            json!({"card_due":{"due_date":"2026-10-15"}}),
            None,
            Some(2),
        )
        .await;
    assert_eq!(reminder.0, StatusCode::OK, "{}", reminder.1);
    assert_eq!(reminder.1["card_due"]["due_date"], "2026-10-15");
    assert!(reminder.1["card_due"]["amount"].is_null());
}

#[tokio::test]
async fn same_time_group_exposes_combined_movement_not_single_row_movement() {
    let (client, _) = setup().await;
    let bank = client.create("accounts", json!({"name":"Bank","subtype":"bank","currency":"INR","opening_balance":{"amount":"12328.00","as_of":"2026-04-30T13:02:00+05:30"}})).await;
    let category = client.category("Family", "expense").await;
    for amount in ["50000.00", "20000.00", "11000.00"] {
        let mut input = transaction("expense", amount, &bank, &category, "personal");
        input["effective_date"] = json!("2026-05-01");
        client.create("transactions", input).await;
    }
    let account_id = bank["id"].as_str().unwrap();
    let ledger = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger?from=2026-05-01&to=2026-05-02"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(ledger.0, StatusCode::OK, "{}", ledger.1);
    let rows = ledger.1["data"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!(row["same_time_count"], 3);
        assert_eq!(row["same_time_group_movement"], "-81000.00");
        assert_eq!(row["balance_after"], "-68672.00");
    }
}

#[tokio::test]
async fn date_only_transaction_is_assumed_at_ten_am_account_local_time() {
    let (client, _) = setup().await;
    let account = client.create("accounts", json!({"name":"Bank","subtype":"bank","currency":"INR","timezone":"Asia/Kolkata","opening_balance":{"amount":"100.00","as_of":"2026-09-15T00:00:00+05:30"}})).await;
    let category = client.category("Food", "expense").await;
    client
        .transaction("expense", "20.00", &account, &category, "personal")
        .await;
    let account_id = account["id"].as_str().unwrap();
    let before = client
        .call(
            "GET",
            &format!("accounts/{account_id}/balance-at?as_of=2026-09-15T09%3A59%3A00%2B05%3A30"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(before.1["amount"], "100.00");
    let after = client
        .call(
            "GET",
            &format!("accounts/{account_id}/balance-at?as_of=2026-09-15T10%3A00%3A00%2B05%3A30"),
            json!({}),
            None,
            None,
        )
        .await;
    assert_eq!(after.1["amount"], "80.00");
    let ledger = client
        .call(
            "GET",
            &format!("accounts/{account_id}/ledger"),
            json!({}),
            None,
            None,
        )
        .await;
    let movement = ledger.1["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["transaction_id"].is_string())
        .unwrap();
    assert_eq!(movement["effective_at"], "2026-09-15T04:30:00+00:00");
}
