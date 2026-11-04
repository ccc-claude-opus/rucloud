//! KV：一個應用一個 SQLite 檔，表格以 (namespace, key) 為主鍵。
//! 和 Cloudflare 不同的是這裡是強一致的（單機，沒有 60 秒的傳播延遲）。

use crate::d1::open_sqlite;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;

pub struct Kv {
    conn: Mutex<Connection>,
}

pub struct Entry {
    pub value: Vec<u8>,
    pub metadata: Option<String>,
    pub expiration: Option<i64>,
}

pub fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Kv {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (
               ns TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
               metadata TEXT, expiration INTEGER,
               PRIMARY KEY (ns, key)) WITHOUT ROWID;",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn get(&self, ns: &str, key: &str) -> Result<Option<Entry>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .prepare_cached("SELECT value, metadata, expiration FROM kv WHERE ns = ? AND key = ?")?
            .query_row(params![ns, key], |r| {
                Ok(Entry { value: r.get(0)?, metadata: r.get(1)?, expiration: r.get(2)? })
            })
            .optional()?;
        Ok(row.filter(|e| e.expiration.is_none_or(|t| t > now_secs())))
    }

    pub fn put(&self, ns: &str, key: &str, value: &[u8], metadata: Option<&str>, expiration: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.prepare_cached("INSERT OR REPLACE INTO kv (ns, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)")?
            .execute(params![ns, key, value, metadata, expiration])?;
        Ok(())
    }

    pub fn delete(&self, ns: &str, key: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.prepare_cached("DELETE FROM kv WHERE ns = ? AND key = ?")?.execute(params![ns, key])?;
        Ok(())
    }

    /// 依字典序列出鍵；cursor 是上一頁最後一個鍵。
    pub fn list(&self, ns: &str, prefix: &str, limit: usize, cursor: Option<&str>) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let limit = limit.clamp(1, 1000);
        let mut stmt = conn.prepare_cached(
            "SELECT key, metadata, expiration FROM kv
             WHERE ns = ?1 AND substr(key, 1, length(?2)) = ?2 AND key > ?3
               AND (expiration IS NULL OR expiration > ?4)
             ORDER BY key LIMIT ?5",
        )?;
        let mut keys: Vec<Value> = stmt
            .query_map(params![ns, prefix, cursor.unwrap_or(""), now_secs(), (limit + 1) as i64], |r| {
                let name: String = r.get(0)?;
                let meta: Option<String> = r.get(1)?;
                let exp: Option<i64> = r.get(2)?;
                let mut o = json!({ "name": name });
                if let Some(e) = exp {
                    o["expiration"] = json!(e);
                }
                if let Some(m) = meta.and_then(|m| serde_json::from_str::<Value>(&m).ok()) {
                    o["metadata"] = m;
                }
                Ok(o)
            })?
            .collect::<rusqlite::Result<_>>()?;
        let complete = keys.len() <= limit;
        keys.truncate(limit);
        let mut out = json!({ "keys": keys, "list_complete": complete, "cacheStatus": null });
        if !complete {
            out["cursor"] = keys.last().map(|k| k["name"].clone()).unwrap_or(Value::Null);
        }
        Ok(out)
    }

    pub fn purge_expired(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute("DELETE FROM kv WHERE expiration IS NOT NULL AND expiration <= ?", [now_secs()])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_list_expire() {
        let dir = std::env::temp_dir().join(format!("rucloud-kv-{}", std::process::id()));
        let kv = Kv::open(&dir.join("kv.sqlite")).unwrap();
        for k in ["a:1", "a:2", "a:3", "b:1"] {
            kv.put("NS", k, k.as_bytes(), Some("{\"x\":1}"), None).unwrap();
        }
        kv.put("NS", "old", b"x", None, Some(now_secs() - 1)).unwrap();
        assert_eq!(kv.get("NS", "a:2").unwrap().unwrap().value, b"a:2");
        assert!(kv.get("NS", "old").unwrap().is_none());
        let page = kv.list("NS", "a:", 2, None).unwrap();
        assert_eq!(page["keys"].as_array().unwrap().len(), 2);
        assert_eq!(page["list_complete"], false);
        let next = kv.list("NS", "a:", 2, page["cursor"].as_str()).unwrap();
        assert_eq!(next["keys"][0]["name"], "a:3");
        assert_eq!(next["list_complete"], true);
        let _ = std::fs::remove_dir_all(dir);
    }
}
