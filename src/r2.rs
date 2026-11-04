//! R2：物件內容存成檔案（檔名是 key 的 SHA-256），中繼資料存在 SQLite。

use crate::d1::open_sqlite;
use anyhow::Result;
use md5::{Digest, Md5};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::Sha256;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct R2 {
    root: PathBuf,
    conn: Mutex<Connection>,
}

impl R2 {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("tmp"))?;
        let conn = open_sqlite(&root.join("r2.sqlite"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS objects (
               bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
               version TEXT NOT NULL, uploaded INTEGER NOT NULL,
               http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL,
               PRIMARY KEY (bucket, key)) WITHOUT ROWID;",
        )?;
        Ok(Self { root: root.to_path_buf(), conn: Mutex::new(conn) })
    }

    pub fn file_path(&self, bucket: &str, key: &str) -> PathBuf {
        let h = hex::encode(Sha256::digest(key.as_bytes()));
        self.root.join("objects").join(bucket).join(&h[..2]).join(h)
    }

    pub fn tmp_path(&self) -> PathBuf {
        self.root.join("tmp").join(format!("{:032x}", rand::random::<u128>()))
    }

    /// 已經寫好的暫存檔搬到正式位置並記錄中繼資料。
    #[allow(clippy::too_many_arguments)]
    pub fn commit(&self, bucket: &str, key: &str, tmp: &Path, size: u64, md5: Md5, http: &Value, custom: &Value) -> Result<Value> {
        let dest = self.file_path(bucket, key);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::rename(tmp, &dest)?;
        let etag = hex::encode(md5.finalize());
        let version = format!("{:032x}", rand::random::<u128>());
        let uploaded = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![bucket, key, size as i64, etag, version, uploaded, http.to_string(), custom.to_string()],
        )?;
        Ok(object_json(key, size as i64, &etag, &version, uploaded, http.clone(), custom.clone()))
    }

    pub fn head(&self, bucket: &str, key: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata FROM objects WHERE bucket = ? AND key = ?",
                params![bucket, key],
                row_json,
            )
            .optional()?)
    }

    pub fn delete(&self, bucket: &str, keys: &[String]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for k in keys {
            conn.execute("DELETE FROM objects WHERE bucket = ? AND key = ?", params![bucket, k])?;
            let _ = std::fs::remove_file(self.file_path(bucket, k));
        }
        Ok(())
    }

    pub fn list(&self, bucket: &str, prefix: &str, limit: usize, cursor: Option<&str>, delimiter: Option<&str>) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let limit = limit.clamp(1, 1000);
        let mut stmt = conn.prepare_cached(
            "SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata FROM objects
             WHERE bucket = ?1 AND substr(key, 1, length(?2)) = ?2 AND key > ?3 ORDER BY key",
        )?;
        let mut rows = stmt.query(params![bucket, prefix, cursor.unwrap_or("")])?;
        let mut objects = Vec::new();
        let mut prefixes: Vec<String> = Vec::new();
        let mut last = String::new();
        let mut truncated = false;
        while let Some(r) = rows.next()? {
            if objects.len() + prefixes.len() >= limit {
                truncated = true;
                break;
            }
            let key: String = r.get(0)?;
            if let Some(d) = delimiter.filter(|d| !d.is_empty())
                && let Some(pos) = key[prefix.len()..].find(d)
            {
                let p = key[..prefix.len() + pos + d.len()].to_string();
                if prefixes.last() != Some(&p) {
                    prefixes.push(p);
                }
                last = key;
                continue;
            }
            objects.push(row_json(r)?);
            last = key;
        }
        let mut out = json!({ "objects": objects, "truncated": truncated, "delimitedPrefixes": prefixes });
        if truncated {
            out["cursor"] = json!(last);
        }
        Ok(out)
    }
}

fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let http: String = r.get(5)?;
    let custom: String = r.get(6)?;
    Ok(object_json(
        &r.get::<_, String>(0)?,
        r.get(1)?,
        &r.get::<_, String>(2)?,
        &r.get::<_, String>(3)?,
        r.get(4)?,
        serde_json::from_str(&http).unwrap_or(json!({})),
        serde_json::from_str(&custom).unwrap_or(json!({})),
    ))
}

fn object_json(key: &str, size: i64, etag: &str, version: &str, uploaded: i64, http: Value, custom: Value) -> Value {
    json!({
        "key": key, "size": size, "etag": etag, "httpEtag": format!("\"{etag}\""),
        "version": version, "uploaded": uploaded,
        "httpMetadata": http, "customMetadata": custom, "storageClass": "Standard",
    })
}
