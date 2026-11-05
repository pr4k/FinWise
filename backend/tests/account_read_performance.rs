//! Synthetic account projections, privacy checks, and an opt-in batch benchmark.
use finwise_api::{auth::Principal, balances, connect, storage};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::time::Instant;

async fn save(db: &mut SqliteConnection, kind: &str, value: &Value) {
    sqlx::query("INSERT INTO resources(id,household_id,owner_id,kind,document,created_at) VALUES(?,'h','u',?,?,'')")
        .bind(value["id"].as_str().unwrap()).bind(kind).bind(value.to_string()).execute(db).await.unwrap();
}
async fn setup(db: &mut SqliteConnection, count: usize) -> Principal {
    sqlx::query("INSERT INTO households VALUES('h','{\"id\":\"h\",\"timezone\":\"Asia/Kolkata\",\"base_currency\":\"INR\"}')").execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO users VALUES('u','test@example.test','Test','unused')")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO memberships(id,household_id,user_id,role) VALUES('m','h','u','owner')",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    for i in 0..count {
        save(db,"accounts",&json!({"id":format!("a{i:03}"),"name":format!("Bank {i}"),"owner_id":"u","visibility":"shared","subtype":"bank","currency":"INR","revision":1,"opening_balance":{"amount":"100000.00","as_of":"2026-09-01T00:00:00+05:30"}})).await;
    }
    Principal {
        user_id: "u".into(),
        household_id: "h".into(),
        member_id: "m".into(),
        role: "owner".into(),
        csrf: String::new(),
    }
}
fn normalize(account: &mut Value) {
    account["balance"].as_object_mut().unwrap().remove("as_of");
}
#[tokio::test]
async fn batched_accounts_preserve_anchors_private_transfers_card_signs_and_goal_reservations() {
    let pool = connect("sqlite::memory:").await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    let p = setup(&mut db, 2).await;
    save(&mut db,"accounts",&json!({"id":"private","name":"SECRET ACCOUNT","owner_id":"other","visibility":"private","subtype":"bank","currency":"INR"})).await;
    save(&mut db,"accounts",&json!({"id":"card","owner_id":"u","visibility":"private","subtype":"credit_card","currency":"INR","opening_balance":{"amount":"500.00","as_of":"2026-09-01T00:00:00Z"}})).await;
    save(&mut db,"accounts",&json!({"id":"unknown","owner_id":"u","visibility":"private","subtype":"cash","currency":"INR"})).await;
    save(&mut db,"accounts",&json!({"id":"future","owner_id":"u","visibility":"private","subtype":"cash","currency":"INR","timezone":"America/New_York"})).await;
    for (id, date, legs, voided) in [
        (
            "t1",
            "2026-09-30",
            json!([{"account_id":"a000","amount":"-100.00"}]),
            false,
        ),
        (
            "t2",
            "2026-10-03",
            json!([{"account_id":"a000","amount":"-50.00"}]),
            false,
        ),
        (
            "t3",
            "2026-10-04",
            json!([{"account_id":"a000","amount":"-70.00"},{"account_id":"private","amount":"70.00"}]),
            false,
        ),
        (
            "t4",
            "2026-10-04",
            json!([{"account_id":"card","amount":"-25.00"}]),
            false,
        ),
        (
            "t5",
            "2026-10-04",
            json!([{"account_id":"a000","amount":"-1000.00"}]),
            true,
        ),
        (
            "t6",
            "2026-08-01",
            json!([{"account_id":"a000","amount":"-20.00"}]),
            false,
        ),
        (
            "t7",
            "2049-12-30",
            json!([{"account_id":"future","amount":"-20.00"}]),
            false,
        ),
    ] {
        save(&mut db,"transactions",&json!({"id":id,"revision":1,"description":if id=="t3" {"SECRET TRANSFER"} else {"Fixture payment"},"currency":"INR","event_type":"transfer","effective_date":date,"movements":legs,"voided":voided})).await;
    }
    for (id, account, date, amount) in [
        ("check", "a000", "2026-10-02T00:00:00Z", "99950.00"),
        ("future-check", "future", "2050-01-01T00:00:00Z", "100.00"),
    ] {
        save(&mut db,"balance_checks",&json!({"id":id,"account_id":account,"as_of":date,"amount":amount,"basis":"current","ledger_snapshot":"original","currency":"INR"})).await;
    }
    for (id, owner, name, kind, amount) in [
        ("g1", "u", "Emergency", "emergency", "200.00"),
        ("g2", "other", "SECRET GOAL", "general", "100.00"),
    ] {
        save(&mut db,"investment_goals",&json!({"id":id,"owner_id":owner,"name":name,"visibility":"private","currency":"INR","kind":kind,"allocations":[{"asset_kind":"account","asset_id":"a000","mode":"fixed","amount":amount}]})).await;
    }
    let original = storage::list(&mut db, &p, "accounts").await.unwrap();
    assert_eq!(original.len(), 5);
    let mut serial = original.clone();
    for a in &mut serial {
        balances::decorate(&mut db, &p, a).await.unwrap();
        normalize(a);
    }
    let mut batch = original.clone();
    balances::decorate_many(&mut db, &p, &mut batch)
        .await
        .unwrap();
    for a in &mut batch {
        normalize(a);
    }
    assert_eq!(serial, batch);
    let bank = batch.iter().find(|a| a["id"] == "a000").unwrap();
    assert_eq!(bank["balance"]["amount"], "99830.00");
    assert_eq!(bank["funds"]["available"], "99530.00");
    assert!(!bank.to_string().contains("SECRET"));
    assert_eq!(bank["funds"]["goals"][1]["name"], "Private goal");
    assert_eq!(
        batch.iter().find(|a| a["id"] == "card").unwrap()["balance"]["amount"],
        "525.00"
    );
    assert!(batch.iter().find(|a| a["id"] == "unknown").unwrap()["balance"]["amount"].is_null());
    assert_eq!(
        batch.iter().find(|a| a["id"] == "future").unwrap()["balance"]["amount"],
        "120.00"
    );
    let ledger = balances::ledger(&mut db, &p, &original[0]).await.unwrap();
    let private = ledger
        .iter()
        .find(|r| r["description"] == "Private transfer")
        .unwrap();
    assert!(private["transaction_id"].is_null());
    assert_eq!(private["movement"], "-70.00");
    assert!(!serde_json::to_string(&ledger).unwrap().contains("SECRET"));
    let history = balances::history(&mut db, &p, &original[0]).await.unwrap();
    assert_eq!(history[0]["current_calculated"], "99900.00");
    assert_eq!(history[0]["current_variance"], "50.00");
    assert_eq!(history[0]["stale"], true);
    sqlx::query("INSERT INTO account_access VALUES('private','m')")
        .execute(&mut *db)
        .await
        .unwrap();
    let granted = balances::ledger(&mut db, &p, &original[0]).await.unwrap();
    assert!(
        granted
            .iter()
            .any(|r| r["transaction_id"] == "t3" && r["description"] == "SECRET TRANSFER")
    );
    sqlx::query("DELETE FROM account_access WHERE account_id='private' AND member_id='m'")
        .execute(&mut *db)
        .await
        .unwrap();
    let revoked = balances::ledger(&mut db, &p, &original[0]).await.unwrap();
    assert!(!serde_json::to_string(&revoked).unwrap().contains("SECRET"));
    balances::decorate_many(&mut db, &p, &mut []).await.unwrap();
}
#[tokio::test]
#[ignore = "Synthetic timing comparison; no fixed performance threshold"]
async fn account_batch_benchmark() {
    let directory = tempfile::tempdir().unwrap();
    let pool = connect(&format!(
        "sqlite://{}",
        directory.path().join("bench.sqlite").display()
    ))
    .await
    .unwrap();
    let mut db = pool.acquire().await.unwrap();
    let p = setup(&mut db, 24).await;
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<6000) INSERT INTO resources(id,household_id,owner_id,kind,document,created_at) SELECT printf('t%05d',i),'h','u','transactions',json_object('id',printf('t%05d',i),'revision',1,'event_type','expense','currency','INR','effective_date','2026-10-15','movements',json_array(json_object('account_id',printf('a%03d',i%24),'amount','-1.00'))),'' FROM n").execute(&mut *db).await.unwrap();
    let accounts = storage::list(&mut db, &p, "accounts").await.unwrap();
    let mut serial = accounts.clone();
    let start = Instant::now();
    for a in &mut serial {
        balances::decorate(&mut db, &p, a).await.unwrap();
    }
    let serial_time = start.elapsed();
    let mut batch = accounts.clone();
    let start = Instant::now();
    balances::decorate_many(&mut db, &p, &mut batch)
        .await
        .unwrap();
    let batch_time = start.elapsed();
    for a in &mut serial {
        normalize(a);
    }
    for a in &mut batch {
        normalize(a);
    }
    assert_eq!(serial, batch);
    println!(
        "24 accounts, 6000 transactions, file-backed SQLite, debug: per-account {serial_time:?}, batch {batch_time:?}"
    );
}
