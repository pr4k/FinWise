//! Synthetic fixtures only; no production database is opened by these checks.
use finwise_api::{auth::Principal, connect, storage};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::time::Instant;

async fn fixture(db: &mut SqliteConnection, count: i64) -> Principal {
    sqlx::query("INSERT INTO households VALUES('h','{}')")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users VALUES('u','synthetic@example.test','Synthetic','unused')")
        .execute(&mut *db)
        .await
        .unwrap();
    for (id, document) in [
        ("a", json!({"id":"a","owner_id":"u","visibility":"private"})),
        (
            "private",
            json!({"id":"private","owner_id":"other","visibility":"private"}),
        ),
    ] {
        sqlx::query("INSERT INTO resources(id,household_id,owner_id,kind,document,created_at) VALUES(?,'h','u','accounts',?,'')")
            .bind(id).bind(document.to_string()).execute(&mut *db).await.unwrap();
    }
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO resources(id,household_id,owner_id,kind,document,created_at) SELECT printf('t%05d',i),'h','u','transactions',json_object('id',printf('t%05d',i),'currency','INR','amount','10.00','event_type','expense','allocations',json('[]'),'effective_date',CASE WHEN i%60=0 THEN '2026-10-15' ELSE '2025-01-01' END,'source_refs',json('[]'),'movements',json('[{\"account_id\":\"a\",\"amount\":\"-10.00\"}]')),'' FROM n")
        .bind(count).execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO import_occurrences(id,household_id,account_id,fingerprint,occurrence,transaction_id,source_refs_json) SELECT id,'h','a',id,1,id,'[{\"file_id\":\"synthetic\",\"row_number\":1}]' FROM resources WHERE kind='transactions'")
        .execute(&mut *db).await.unwrap();
    Principal {
        user_id: "u".into(),
        household_id: "h".into(),
        member_id: "m".into(),
        role: "owner".into(),
        csrf: String::new(),
    }
}

#[tokio::test]
async fn batched_reads_preserve_sources_evidence_visibility_and_date_bounds() {
    let pool = connect("sqlite::memory:").await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    let p = fixture(&mut db, 120).await;
    // Duplicate evidence must not duplicate the existing source reference.
    sqlx::query("UPDATE resources SET document=json_set(document,'$.source_refs',json('[{\"file_id\":\"synthetic\",\"row_number\":1}]')) WHERE id='t00060'")
        .execute(&mut *db).await.unwrap();
    // A transfer is hidden if even one of its accounts is private.
    sqlx::query("UPDATE resources SET document=json_set(document,'$.movements',json('[{\"account_id\":\"a\",\"amount\":\"-10.00\"},{\"account_id\":\"private\",\"amount\":\"10.00\"}]')) WHERE id='t00001'")
        .execute(&mut *db).await.unwrap();
    for (id, account, amount) in [
        ("o1", "a", -400),
        ("o2", "a", -600),
        ("inactive", "a", -1000),
    ] {
        sqlx::query("INSERT INTO import_occurrences VALUES(?,'h',?,?,1,NULL,'[]')")
            .bind(id)
            .bind(account)
            .bind(id)
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO bank_observations VALUES(?,'h',?,'2026-10-15','INR',?,?)")
            .bind(id)
            .bind(account)
            .bind(amount)
            .bind(
                json!({"effective_date":"2026-10-15","description":id,"reference":id}).to_string(),
            )
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO reconciliation_links VALUES('a','a','t00060',?,?,?,?)")
            .bind(account)
            .bind(id)
            .bind(amount)
            .bind(if id == "inactive" { 0 } else { 1 })
            .execute(&mut *db)
            .await
            .unwrap();
    }
    let all = storage::list(&mut db, &p, "transactions").await.unwrap();
    assert_eq!(all.len(), 119);
    for value in &all {
        let single = storage::get(&mut db, &p, "transactions", value["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(*value, single);
        assert_eq!(value["source_refs"].as_array().unwrap().len(), 1);
    }
    let matched = all.iter().find(|v| v["id"] == "t00060").unwrap();
    assert_eq!(matched["reconciliation_state"], "matched");
    assert_eq!(
        matched["reconciliation_evidence"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        matched["reconciliation_evidence"][0]["matched_amount"],
        "-4.00"
    );
    let period = storage::transactions_in_period(&mut db, &p, "2026-10-01", "2026-11-01", true)
        .await
        .unwrap();
    assert_eq!(
        period,
        all.iter()
            .filter(|v| v["effective_date"] == "2026-10-15")
            .cloned()
            .collect::<Vec<_>>()
    );
    assert!(
        storage::transactions_in_range(&mut db, &p, None, Some("2025-01-01"), true)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        storage::transactions_in_range(&mut db, &p, Some("2026-10-15"), None, true)
            .await
            .unwrap(),
        period
    );
    let raw = storage::transactions_in_period(&mut db, &p, "2026-10-01", "2026-11-01", false)
        .await
        .unwrap();
    assert!(raw[0].get("reconciliation_evidence").is_none());
    let plan = sqlx::query("EXPLAIN QUERY PLAN SELECT source_refs_json FROM import_occurrences WHERE household_id='h' AND transaction_id='t00060'")
        .fetch_all(&mut *db).await.unwrap();
    assert!(plan.iter().any(|r| {
        r.get::<String, _>(3)
            .contains("import_occurrences_transaction")
    }));
    let plan = sqlx::query("EXPLAIN QUERY PLAN SELECT document FROM resources WHERE household_id='h' AND kind='transactions' AND json_extract(document,'$.effective_date')>='2026-10-01' AND json_extract(document,'$.effective_date')<'2026-11-01' ORDER BY id")
        .fetch_all(&mut *db).await.unwrap();
    assert!(
        plan.iter()
            .any(|r| r.get::<String, _>(3).contains("resources_transactions_"))
    );
}

#[tokio::test]
#[ignore = "synthetic timing benchmark; run explicitly with --ignored --nocapture"]
async fn transaction_read_benchmark() {
    let temporary = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}",
        temporary.path().join("benchmark.sqlite").display()
    );
    let pool = connect(&url).await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    let p = fixture(&mut db, 6000).await;
    let start = Instant::now();
    let mut per_item = Vec::<Value>::new();
    for i in 1..=6000 {
        per_item.push(
            storage::get(&mut db, &p, "transactions", &format!("t{i:05}"))
                .await
                .unwrap(),
        );
    }
    let per_item_time = start.elapsed();
    let start = Instant::now();
    let all = storage::list(&mut db, &p, "transactions").await.unwrap();
    let batch_time = start.elapsed();
    assert_eq!(per_item, all);
    let start = Instant::now();
    let period = storage::transactions_in_period(&mut db, &p, "2026-10-01", "2026-11-01", true)
        .await
        .unwrap();
    let period_time = start.elapsed();
    assert_eq!(period.len(), 100);
    println!(
        "6000 transactions + 6000 source occurrences, local file SQLite, debug build: per-item reads {per_item_time:?}, batched all-date reads {batch_time:?}, indexed month (100 transactions) {period_time:?}"
    );
}
