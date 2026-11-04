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
            "CREATE TABLE IF NOT EXISTS uploads (
               upload_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL,
               http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL, created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS parts (
               upload_id TEXT NOT NULL, n INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL,
               PRIMARY KEY (upload_id, n)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS objects (
               bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
               version TEXT NOT NULL, uploaded INTEGER NOT NULL,
               http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL,
               PRIMARY KEY (bucket, key)) WITHOUT ROWID;",
        )?;
        Ok(Self {
            root: root.to_path_buf(),
            conn: Mutex::new(conn),
        })
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
    pub fn commit(&self, bucket: &str, key: &str, tmp: &Path, size: u64, etag: &str, http: &Value, custom: &Value) -> Result<Value> {
        let dest = self.file_path(bucket, key);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::rename(tmp, &dest)?;
        let version = format!("{:032x}", rand::random::<u128>());
        let uploaded = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                bucket,
                key,
                size as i64,
                etag,
                version,
                uploaded,
                http.to_string(),
                custom.to_string()
            ],
        )?;
        Ok(object_json(
            key,
            size as i64,
            etag,
            &version,
            uploaded,
            http.clone(),
            custom.clone(),
        ))
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

    /// 複製物件；metadata 給 None 就沿用來源的
    pub fn copy(
        &self,
        src_bucket: &str,
        src_key: &str,
        bucket: &str,
        key: &str,
        metadata: Option<(&Value, &Value)>,
    ) -> Result<Option<Value>> {
        let Some(src) = self.head(src_bucket, src_key)? else {
            return Ok(None);
        };
        let tmp = self.tmp_path();
        std::fs::copy(self.file_path(src_bucket, src_key), &tmp)?;
        let (http, custom) = match metadata {
            Some((h, c)) => (h.clone(), c.clone()),
            None => (src["httpMetadata"].clone(), src["customMetadata"].clone()),
        };
        let size = src["size"].as_u64().unwrap_or(0);
        Ok(Some(self.commit(
            bucket,
            key,
            &tmp,
            size,
            src["etag"].as_str().unwrap_or(""),
            &http,
            &custom,
        )?))
    }

    // ---------- multipart upload ----------

    pub fn create_upload(&self, bucket: &str, key: &str, http: &Value, custom: &Value) -> Result<String> {
        let id = format!("{:032x}", rand::random::<u128>());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?)",
            params![
                id,
                bucket,
                key,
                http.to_string(),
                custom.to_string(),
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(id)
    }

    /// (bucket, key)；上傳不存在回 None
    pub fn upload(&self, upload_id: &str) -> Result<Option<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT bucket, key FROM uploads WHERE upload_id = ?", [upload_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?)
    }

    pub fn part_path(&self, upload_id: &str, n: u32) -> PathBuf {
        self.root.join("parts").join(upload_id).join(n.to_string())
    }

    pub fn commit_part(&self, upload_id: &str, n: u32, tmp: &Path, size: u64, etag: &str) -> Result<()> {
        let dest = self.part_path(upload_id, n);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::rename(tmp, &dest)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO parts VALUES (?, ?, ?, ?)",
            params![upload_id, n, etag, size as i64],
        )?;
        Ok(())
    }

    /// 依 parts 的順序接起來。etag 和 S3 一樣是「各段 MD5 的 MD5」加上 -段數
    pub fn complete_upload(&self, upload_id: &str, parts: &[(u32, String)]) -> Result<Value> {
        use std::io::Write;
        let (bucket, key, http, custom): (String, String, String, String) = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT bucket, key, http_metadata, custom_metadata FROM uploads WHERE upload_id = ?",
                [upload_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("NoSuchUpload：找不到上傳 {upload_id}"))?
        };
        if parts.is_empty() {
            anyhow::bail!("InvalidPart：至少要有一段");
        }
        let known: std::collections::HashMap<u32, String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT n, etag FROM parts WHERE upload_id = ?")?;
            stmt.query_map([upload_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let tmp = self.tmp_path();
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        let mut digests = Vec::new();
        let mut size = 0u64;
        let mut last = 0;
        for (n, etag) in parts {
            if *n <= last {
                anyhow::bail!("InvalidPartOrder：段號要遞增");
            }
            last = *n;
            let want = etag.trim_matches('"');
            if known.get(n).map(|e| e.as_str()) != Some(want) {
                anyhow::bail!("InvalidPart：第 {n} 段不存在或 ETag 不符");
            }
            let mut f = std::fs::File::open(self.part_path(upload_id, *n))?;
            size += std::io::copy(&mut f, &mut out)?;
            digests.extend(hex::decode(want)?);
        }
        out.flush()?;
        drop(out);
        let etag = format!("{}-{}", hex::encode(Md5::digest(&digests)), parts.len());
        let obj = self.commit(
            &bucket,
            &key,
            &tmp,
            size,
            &etag,
            &serde_json::from_str(&http).unwrap_or(json!({})),
            &serde_json::from_str(&custom).unwrap_or(json!({})),
        )?;
        self.abort_upload(upload_id)?;
        Ok(obj)
    }

    pub fn abort_upload(&self, upload_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM uploads WHERE upload_id = ?", [upload_id])?;
        conn.execute("DELETE FROM parts WHERE upload_id = ?", [upload_id])?;
        let _ = std::fs::remove_dir_all(self.root.join("parts").join(upload_id));
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

/// 收一個上傳的內容寫到暫存檔，同時算 MD5 與 SHA-256。
/// aws_chunked = true 時解開 S3 的 aws-chunked 編碼（每段前面有「十六進位長度;簽章」）。
pub struct Received {
    pub size: u64,
    pub md5: String,
    pub sha256: String,
}

pub async fn receive(body: axum::body::Body, aws_chunked: bool, tmp: &Path) -> Result<Received> {
    use futures_util::TryStreamExt;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let mut reader = tokio::io::BufReader::new(tokio_util::io::StreamReader::new(stream));
    let mut file = tokio::io::BufWriter::new(tokio::fs::File::create(tmp).await?);
    let mut md5 = Md5::new();
    let mut sha = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    if aws_chunked {
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).await? == 0 {
                break;
            }
            let hex_len = line.trim().split(';').next().unwrap_or("0");
            let mut left = u64::from_str_radix(hex_len.trim(), 16).map_err(|_| anyhow::anyhow!("aws-chunked 格式不對"))?;
            if left == 0 {
                break; // 後面是 trailer（checksum），不需要
            }
            while left > 0 {
                let want = left.min(buf.len() as u64) as usize;
                let n = reader.read(&mut buf[..want]).await?;
                if n == 0 {
                    anyhow::bail!("aws-chunked 內容不完整");
                }
                md5.update(&buf[..n]);
                sha.update(&buf[..n]);
                file.write_all(&buf[..n]).await?;
                size += n as u64;
                left -= n as u64;
            }
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf).await?;
        }
    } else {
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            md5.update(&buf[..n]);
            sha.update(&buf[..n]);
            file.write_all(&buf[..n]).await?;
            size += n as u64;
        }
    }
    file.flush().await?;
    Ok(Received {
        size,
        md5: hex::encode(md5.finalize()),
        sha256: hex::encode(sha.finalize()),
    })
}

/// 物件變動時依應用的 event_notifications 送訊息到佇列（內容格式和 Cloudflare 的 R2 事件通知相同）
pub fn notify(app: &crate::app::App, queues: &crate::queues::Queues, bucket: &str, action: &str, key: &str, obj: Option<&Value>) {
    let Some(cfg) = app
        .cfg
        .r2_buckets
        .iter()
        .find(|b| b.bucket_name.as_deref().unwrap_or(&b.binding) == bucket)
    else {
        return;
    };
    for n in &cfg.event_notifications {
        if (!n.actions.is_empty() && !n.actions.iter().any(|a| a == action))
            || n.prefix.as_deref().is_some_and(|p| !key.starts_with(p))
            || n.suffix.as_deref().is_some_and(|s| !key.ends_with(s))
        {
            continue;
        }
        let mut object = json!({ "key": key });
        if let Some(o) = obj {
            object["size"] = o["size"].clone();
            object["eTag"] = o["etag"].clone();
        }
        let body = json!({
            "account": "rucloud", "action": action, "bucket": bucket, "object": object,
            "eventTime": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        if let Err(e) = queues.send(&n.queue, &[json!({ "body": body.to_string(), "contentType": "json" })]) {
            tracing::warn!("R2 事件通知送不出去（佇列 {}）：{e:#}", n.queue);
        }
    }
}
