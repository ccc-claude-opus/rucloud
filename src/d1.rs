//! D1：每個資料庫一個 SQLite 檔。查詢結果用「欄名 + 列陣列」傳回，
//! 由 JS 端組成物件（保留欄位順序，也方便 raw()）。

use anyhow::{Result, anyhow};
use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, Statement};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

pub struct D1 {
    conn: Mutex<Connection>,
}

#[derive(Deserialize)]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub meta: Value,
}

pub fn open_sqlite(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    )?;
    Ok(conn)
}

impl D1 {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        // D1 預設會檢查外鍵
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn query(&self, sql: &str, params: &[Value]) -> Result<QueryResult> {
        let conn = self.conn.lock().unwrap();
        run_one(&conn, sql, params)
    }

    /// 全部在同一個交易裡執行，任何一句失敗就整批回滾。
    pub fn batch(&self, stmts: &[Stmt]) -> Result<Vec<QueryResult>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut out = Vec::with_capacity(stmts.len());
        for s in stmts {
            out.push(run_one(&tx, &s.sql, &s.params)?);
        }
        tx.commit()?;
        Ok(out)
    }

    /// 執行多句 SQL（schema 檔、migration），回傳執行了幾句。
    pub fn exec(&self, sql: &str) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let start = Instant::now();
        let mut count = 0;
        use rusqlite::fallible_iterator::FallibleIterator;
        let mut batch = rusqlite::Batch::new(&conn, sql);
        while let Some(mut stmt) = batch.next()? {
            let mut rows = stmt.raw_query();
            while rows.next()?.is_some() {}
            count += 1;
        }
        Ok(json!({ "count": count, "duration": start.elapsed().as_secs_f64() * 1000.0 }))
    }
}

fn run_one(conn: &Connection, sql: &str, params: &[Value]) -> Result<QueryResult> {
    let start = Instant::now();
    let mut stmt = conn.prepare(sql)?;
    let expected = stmt.parameter_count();
    if params.len() != expected {
        return Err(anyhow!("Wrong number of parameter bindings. SQL statement needs {expected}, got {}", params.len()));
    }
    for (i, p) in params.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, to_sql(p)?)?;
    }
    let readonly = stmt.readonly();
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = if columns.is_empty() {
        stmt.raw_execute()?;
        Vec::new()
    } else {
        collect_rows(&mut stmt, columns.len())?
    };
    let changes = if readonly { 0 } else { conn.changes() };
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let meta = json!({
        "duration": ms,
        "changes": changes,
        "last_row_id": conn.last_insert_rowid(),
        "changed_db": changes > 0,
        "rows_read": rows.len(),
        "rows_written": changes,
        "served_by": "rucloud",
    });
    Ok(QueryResult { columns, rows, meta })
}

fn collect_rows(stmt: &mut Statement, ncol: usize) -> Result<Vec<Vec<Value>>> {
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut r = Vec::with_capacity(ncol);
        for i in 0..ncol {
            r.push(match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                // D1 把 BLOB 傳回成數字陣列
                ValueRef::Blob(b) => Value::Array(b.iter().map(|x| json!(x)).collect()),
            });
        }
        out.push(r);
    }
    Ok(out)
}

fn to_sql(v: &Value) -> Result<SqlValue> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) if o.contains_key("$blob") => {
            let b64 = o["$blob"].as_str().unwrap_or("");
            SqlValue::Blob(base64::engine::general_purpose::STANDARD.decode(b64)?)
        }
        other => return Err(anyhow!("D1_TYPE_ERROR: Type '{other}' not supported")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_batch_exec() {
        let dir = std::env::temp_dir().join(format!("rucloud-d1-{}", std::process::id()));
        let db = D1::open(&dir.join("t.sqlite")).unwrap();
        db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB); DELETE FROM t;").unwrap();
        let r = db.query("INSERT INTO t (name) VALUES (?)", &[json!("a")]).unwrap();
        assert_eq!(r.meta["changes"], 1);
        assert!(db.batch(&[
            Stmt { sql: "INSERT INTO t (name) VALUES (?)".into(), params: vec![json!("b")] },
            Stmt { sql: "INSERT INTO t (name) VALUES (?)".into(), params: vec![json!("a")] },
        ]).is_err());
        let r = db.query("SELECT id, name FROM t ORDER BY id", &[]).unwrap();
        assert_eq!(r.columns, vec!["id", "name"]);
        assert_eq!(r.rows.len(), 1, "失敗的 batch 要整批回滾");
        assert!(db.query("SELECT ?", &[]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
