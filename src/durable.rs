//! Durable Objects 的儲存（ctx.storage）與鬧鐘（setAlarm）。
//! 物件實例本身活在 Node 程序裡；同一個 id 永遠交給同一個程序，所以是單一實例。

use crate::d1::open_sqlite;
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;

pub struct DoStore {
    conn: Mutex<Connection>,
}

impl DoStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS storage (
               ns TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
               PRIMARY KEY (ns, id, key)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS alarms (
               ns TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
               PRIMARY KEY (ns, id)) WITHOUT ROWID;",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 一次處理一個操作：{op: get|put|delete|list|deleteAll|getAlarm|setAlarm|deleteAlarm, ...}
    /// 值是 JS 端已經編碼好的字串，這裡不解讀。
    pub fn op(&self, ns: &str, id: &str, req: &Value) -> Result<Value> {
        let mut conn = self.conn.lock().unwrap();
        let strs = |k: &str| -> Vec<String> {
            req[k]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        Ok(match req["op"].as_str().unwrap_or("") {
            "get" => {
                let mut stmt = conn.prepare_cached("SELECT value FROM storage WHERE ns = ? AND id = ? AND key = ?")?;
                let mut out = serde_json::Map::new();
                for k in strs("keys") {
                    let mut rows = stmt.query(params![ns, id, k])?;
                    if let Some(r) = rows.next()? {
                        out.insert(k, Value::String(r.get(0)?));
                    }
                }
                json!({ "values": out })
            }
            "put" => {
                let tx = conn.transaction()?;
                if let Some(entries) = req["entries"].as_object() {
                    let mut stmt = tx.prepare_cached("INSERT OR REPLACE INTO storage VALUES (?, ?, ?, ?)")?;
                    for (k, v) in entries {
                        stmt.execute(params![ns, id, k, v.as_str().unwrap_or("null")])?;
                    }
                }
                tx.commit()?;
                json!({})
            }
            "delete" => {
                let mut n = 0;
                let mut stmt = conn.prepare_cached("DELETE FROM storage WHERE ns = ? AND id = ? AND key = ?")?;
                for k in strs("keys") {
                    n += stmt.execute(params![ns, id, k])?;
                }
                json!({ "deleted": n })
            }
            "deleteAll" => {
                conn.execute("DELETE FROM storage WHERE ns = ? AND id = ?", params![ns, id])?;
                json!({})
            }
            "list" => {
                let prefix = req["prefix"].as_str().unwrap_or("");
                let start = req["start"].as_str().unwrap_or("");
                let end = req["end"].as_str();
                let reverse = req["reverse"].as_bool().unwrap_or(false);
                let limit = req["limit"].as_i64().unwrap_or(-1);
                let sql = format!(
                    "SELECT key, value FROM storage WHERE ns = ?1 AND id = ?2
                       AND substr(key, 1, length(?3)) = ?3 AND key >= ?4 AND (?5 IS NULL OR key < ?5)
                     ORDER BY key {} LIMIT ?6",
                    if reverse { "DESC" } else { "ASC" }
                );
                let mut stmt = conn.prepare_cached(&sql)?;
                let entries: Vec<Value> = stmt
                    .query_map(params![ns, id, prefix, start, end, limit], |r| {
                        Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?]))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                json!({ "entries": entries })
            }
            "getAlarm" => {
                let at: Option<i64> = conn
                    .query_row("SELECT at FROM alarms WHERE ns = ? AND id = ?", params![ns, id], |r| r.get(0))
                    .ok();
                json!({ "at": at })
            }
            "setAlarm" => {
                conn.execute(
                    "INSERT OR REPLACE INTO alarms VALUES (?, ?, ?)",
                    params![ns, id, req["at"].as_i64().unwrap_or(0)],
                )?;
                json!({})
            }
            "deleteAlarm" => {
                conn.execute("DELETE FROM alarms WHERE ns = ? AND id = ?", params![ns, id])?;
                json!({})
            }
            other => anyhow::bail!("不支援的 storage 操作 {other}"),
        })
    }

    /// 取出已到期的鬧鐘並刪掉（觸發失敗時由呼叫端重新排定）。
    pub fn take_due_alarms(&self, now_ms: i64) -> Result<Vec<(String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let due: Vec<(String, String, i64)> = conn
            .prepare("SELECT ns, id, at FROM alarms WHERE at <= ?")?
            .query_map([now_ms], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (ns, id, at) in &due {
            conn.execute("DELETE FROM alarms WHERE ns = ? AND id = ? AND at = ?", params![ns, id, at])?;
        }
        Ok(due)
    }
}
