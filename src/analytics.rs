//! Analytics Engine：`writeDataPoint` 的資料存在 `<state>/analytics.sqlite`（所有應用共用，和 Cloudflare 的帳號層級一樣）。
//! 查詢用 SQLite 的 SQL，每個 dataset 是一個 view：
//!   SELECT blob1 AS path, SUM(double1) FROM my_dataset WHERE timestamp > datetime('now', '-1 day') GROUP BY blob1
//! 欄位：timestamp（UTC 文字）、index1、blob1…blob20、double1…double20、_sample_interval。資料保留 92 天。

use crate::d1::open_sqlite;
use anyhow::{Result, bail};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const RETENTION_DAYS: i64 = 92;
const MAX_ROWS: usize = 10_000;

pub struct Analytics {
    path: PathBuf,
    conn: Mutex<Connection>,
}

fn columns() -> String {
    let blobs: Vec<String> = (1..=20).map(|i| format!("blob{i}")).collect();
    let doubles: Vec<String> = (1..=20).map(|i| format!("double{i}")).collect();
    format!("timestamp, index1, {}, {}, _sample_interval", blobs.join(", "), doubles.join(", "))
}

impl Analytics {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        let blobs: Vec<String> = (1..=20).map(|i| format!("blob{i} TEXT")).collect();
        let doubles: Vec<String> = (1..=20).map(|i| format!("double{i} REAL")).collect();
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS events (
               dataset TEXT NOT NULL, timestamp TEXT NOT NULL, index1 TEXT, {}, {},
               _sample_interval INTEGER NOT NULL DEFAULT 1);
             CREATE INDEX IF NOT EXISTS idx_events ON events(dataset, timestamp);",
            blobs.join(", "),
            doubles.join(", ")
        ))?;
        Ok(Self {
            path: path.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    /// points：[{blobs, doubles, index, timestamp(ms)}]
    pub fn write(&self, dataset: &str, points: &[Value]) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let placeholders = vec!["?"; 43].join(", ");
            let mut stmt = tx.prepare_cached(&format!("INSERT INTO events (dataset, {}) VALUES ({placeholders}, 1)", columns()))?;
            for p in points {
                let ts = p["timestamp"].as_i64().unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
                let ts = chrono::DateTime::from_timestamp_millis(ts)
                    .unwrap_or_default()
                    .format("%Y-%m-%d %H:%M:%S%.3f")
                    .to_string();
                let mut vals: Vec<rusqlite::types::Value> = vec![dataset.to_string().into(), ts.into()];
                vals.push(
                    p["index"]
                        .as_str()
                        .map(|s| s.to_string().into())
                        .unwrap_or(rusqlite::types::Value::Null),
                );
                for i in 0..20 {
                    vals.push(
                        p["blobs"][i]
                            .as_str()
                            .map(|s| s.to_string().into())
                            .unwrap_or(rusqlite::types::Value::Null),
                    );
                }
                for i in 0..20 {
                    vals.push(p["doubles"][i].as_f64().map(Into::into).unwrap_or(rusqlite::types::Value::Null));
                }
                stmt.execute(params_from_iter(vals))?;
            }
        }
        tx.commit()?;
        Ok(points.len())
    }

    /// 唯讀查詢；每個 dataset 都是一個同名的 view
    pub fn query(&self, sql: &str) -> Result<Value> {
        let conn = Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let datasets: Vec<String> = conn
            .prepare("SELECT DISTINCT dataset FROM events")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for d in &datasets {
            conn.execute_batch(&format!(
                "CREATE TEMP VIEW IF NOT EXISTS \"{}\" AS SELECT {} FROM main.events WHERE dataset = '{}';",
                d.replace('"', "\"\""),
                columns(),
                d.replace('\'', "''")
            ))?;
        }
        // view 建好之後才鎖成唯讀（temp view 也算寫入）
        conn.execute_batch("PRAGMA query_only = ON;")?;
        let mut stmt = conn.prepare(sql)?;
        if !stmt.readonly() {
            bail!("只能查詢（SELECT）");
        }
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query([])?;
        let mut data = Vec::new();
        while let Some(row) = rows.next()? {
            if data.len() >= MAX_ROWS {
                break;
            }
            let mut o = serde_json::Map::new();
            for (i, n) in names.iter().enumerate() {
                o.insert(
                    n.clone(),
                    match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                        ValueRef::Blob(b) => json!(hex::encode(b)),
                    },
                );
            }
            data.push(Value::Object(o));
        }
        Ok(json!({ "meta": names.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>(), "data": data, "rows": data.len() }))
    }

    pub fn purge_old(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            &format!("DELETE FROM events WHERE timestamp < datetime('now', '-{RETENTION_DAYS} days')"),
            [],
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_query() {
        let dir = std::env::temp_dir().join(format!("rucloud-ae-{}", std::process::id()));
        let a = Analytics::open(&dir.join("a.sqlite")).unwrap();
        a.write(
            "hits",
            &[
                json!({ "blobs": ["/a", "tw"], "doubles": [1.0, 120.0], "index": "u1" }),
                json!({ "blobs": ["/a", "jp"], "doubles": [1.0, 80.0], "index": "u2" }),
                json!({ "blobs": ["/b"], "doubles": [1.0] }),
            ],
        )
        .unwrap();
        a.write("other", &[json!({ "blobs": ["x"] })]).unwrap();
        let r = a
            .query("SELECT blob1 AS path, SUM(double1) AS n, AVG(double2) AS ms FROM hits GROUP BY blob1 ORDER BY blob1")
            .unwrap();
        assert_eq!(r["rows"], 2);
        assert_eq!(r["data"][0], json!({ "path": "/a", "n": 2.0, "ms": 100.0 }));
        assert!(a.query("DELETE FROM events").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
