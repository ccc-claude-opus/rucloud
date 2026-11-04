//! 持續複寫：把 state_dir 送到 S3 相容儲存（R2、AWS S3、MinIO、另一台 rucloud）或另一個資料夾。
//!
//! * SQLite：每隔 `interval` 秒，對有變動的資料庫做線上快照（gzip），保留最近 `keep` 份 → 可以還原到某個時間點
//! * 其他檔案（R2 物件、部署的版本…）：有變動就上傳最新的一份；本機刪掉的遠端也刪
//! * `manifest.json` 記錄所有快照與檔案，還原時只靠它（不需要 LIST）
//!
//! 遠端的樣子：
//!   <prefix>/manifest.json
//!   <prefix>/db/<相對路徑>/<時間>.sqlite.gz
//!   <prefix>/files/<相對路徑>
//!
//! 和 Litestream 的差異：不是逐筆送 WAL，最多會遺失最後一個 interval 的寫入；大資料庫每次都送整份快照。

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ReplicateCfg {
    /// s3://bucket/prefix 或 file:///絕對路徑
    pub target: String,
    /// S3 端點，例如 https://<帳號>.r2.cloudflarestorage.com；AWS 可省略
    pub endpoint: Option<String>,
    #[serde(default = "auto")]
    pub region: String,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    /// 幾秒檢查一次變動
    #[serde(default = "ten")]
    pub interval: u64,
    /// 每個資料庫保留幾份快照
    #[serde(default = "keep")]
    pub keep: usize,
}

fn auto() -> String {
    "auto".into()
}
fn ten() -> u64 {
    10
}
fn keep() -> usize {
    48
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct Manifest {
    pub updated: String,
    /// 資料庫相對路徑 → 快照時間（由舊到新）
    pub dbs: BTreeMap<String, Vec<String>>,
    /// 其他檔案相對路徑 → (修改時間, 大小)
    pub files: BTreeMap<String, (u64, u64)>,
}

// ---------- 遠端 ----------

pub enum Remote {
    Dir(PathBuf),
    S3 {
        http: reqwest::Client,
        endpoint: String,
        host: String,
        bucket: String,
        prefix: String,
        region: String,
        key: String,
        secret: String,
    },
}

impl Remote {
    pub fn new(cfg: &ReplicateCfg) -> Result<Self> {
        if let Some(p) = cfg.target.strip_prefix("file://") {
            return Ok(Remote::Dir(PathBuf::from(p)));
        }
        let Some(rest) = cfg.target.strip_prefix("s3://") else {
            bail!("[replicate] target 要是 s3://bucket/prefix 或 file:///路徑")
        };
        let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
        let endpoint = cfg.endpoint.clone().unwrap_or_else(|| {
            format!(
                "https://s3.{}.amazonaws.com",
                if cfg.region == "auto" { "us-east-1" } else { &cfg.region }
            )
        });
        let endpoint = endpoint.trim_end_matches('/').to_string();
        let host = endpoint
            .split_once("://")
            .map(|(_, h)| h)
            .unwrap_or(&endpoint)
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        Ok(Remote::S3 {
            http: reqwest::Client::builder().timeout(Duration::from_secs(600)).build()?,
            endpoint,
            host,
            bucket: bucket.to_string(),
            prefix: prefix.trim_matches('/').to_string(),
            region: cfg.region.clone(),
            key: cfg.access_key_id.clone().context("[replicate] 缺 access_key_id")?,
            secret: cfg.secret_access_key.clone().context("[replicate] 缺 secret_access_key")?,
        })
    }

    fn describe(&self) -> String {
        match self {
            Remote::Dir(p) => p.display().to_string(),
            Remote::S3 {
                endpoint, bucket, prefix, ..
            } => format!("{endpoint}/{bucket}/{prefix}"),
        }
    }

    /// AWS Signature V4（path-style）
    fn signed(&self, method: reqwest::Method, key: &str, payload_hash: &str) -> reqwest::RequestBuilder {
        let Remote::S3 {
            http,
            endpoint,
            host,
            bucket,
            prefix,
            region,
            key: akid,
            secret,
        } = self
        else {
            unreachable!()
        };
        let full = if prefix.is_empty() {
            key.to_string()
        } else {
            format!("{prefix}/{key}")
        };
        let path = format!("/{}/{}", crate::s3::uri_encode(bucket, false), crate::s3::uri_encode(&full, true));
        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = &amz_date[..8];
        let canonical = format!(
            "{method}\n{path}\n\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload_hash}"
        );
        let scope = format!("{date}/{region}/s3/aws4_request");
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical.as_bytes()))
        );
        let mut k = crate::s3::hmac(format!("AWS4{secret}").as_bytes(), date);
        for part in [region.as_str(), "s3", "aws4_request"] {
            k = crate::s3::hmac(&k, part);
        }
        let sig = hex::encode(crate::s3::hmac(&k, &to_sign));
        http.request(method, format!("{endpoint}{path}"))
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header(
                "authorization",
                format!("AWS4-HMAC-SHA256 Credential={akid}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}"),
            )
    }

    pub async fn put(&self, key: &str, data: Vec<u8>) -> Result<()> {
        match self {
            Remote::Dir(root) => {
                let p = root.join(key);
                std::fs::create_dir_all(p.parent().unwrap())?;
                let tmp = p.with_extension("uploading");
                std::fs::write(&tmp, data)?;
                std::fs::rename(tmp, p)?;
            }
            Remote::S3 { .. } => {
                let hash = hex::encode(Sha256::digest(&data));
                let res = self.signed(reqwest::Method::PUT, key, &hash).body(data).send().await?;
                if !res.status().is_success() {
                    bail!("上傳 {key} 失敗：{} {}", res.status(), res.text().await.unwrap_or_default());
                }
            }
        }
        Ok(())
    }

    /// 大檔案：直接從檔案串流上傳
    pub async fn put_file(&self, key: &str, file: &Path) -> Result<()> {
        match self {
            Remote::Dir(root) => {
                let p = root.join(key);
                std::fs::create_dir_all(p.parent().unwrap())?;
                std::fs::copy(file, &p)?;
            }
            Remote::S3 { .. } => {
                let f = tokio::fs::File::open(file).await?;
                let len = f.metadata().await?.len();
                let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(f));
                let res = self
                    .signed(reqwest::Method::PUT, key, "UNSIGNED-PAYLOAD")
                    .header("content-length", len)
                    .body(body)
                    .send()
                    .await?;
                if !res.status().is_success() {
                    bail!("上傳 {key} 失敗：{} {}", res.status(), res.text().await.unwrap_or_default());
                }
            }
        }
        Ok(())
    }

    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self {
            Remote::Dir(root) => match std::fs::read(root.join(key)) {
                Ok(b) => Ok(Some(b)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            Remote::S3 { .. } => {
                let res = self
                    .signed(reqwest::Method::GET, key, &hex::encode(Sha256::digest(b"")))
                    .send()
                    .await?;
                if res.status() == 404 {
                    return Ok(None);
                }
                if !res.status().is_success() {
                    bail!("下載 {key} 失敗：{} {}", res.status(), res.text().await.unwrap_or_default());
                }
                Ok(Some(res.bytes().await?.to_vec()))
            }
        }
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        match self {
            Remote::Dir(root) => {
                let _ = std::fs::remove_file(root.join(key));
            }
            Remote::S3 { .. } => {
                let res = self
                    .signed(reqwest::Method::DELETE, key, &hex::encode(Sha256::digest(b"")))
                    .send()
                    .await?;
                if !res.status().is_success() && res.status() != 404 {
                    bail!("刪除 {key} 失敗：{}", res.status());
                }
            }
        }
        Ok(())
    }

    pub async fn manifest(&self) -> Result<Manifest> {
        Ok(match self.get("manifest.json").await? {
            Some(b) => serde_json::from_slice(&b).context("遠端的 manifest.json 格式不對")?,
            None => Manifest::default(),
        })
    }
}

// ---------- 掃描本機 ----------

/// 要複寫的檔案：(相對路徑, 是不是 SQLite, 變動指紋)
fn scan(root: &Path) -> Vec<(String, bool, (u64, u64))> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(root.join(&rel)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = rel.join(&name);
            let Ok(meta) = e.metadata() else { continue };
            // 執行環境每次啟動會重寫；log、暫存、上傳到一半的分段不需要
            if (rel.as_os_str().is_empty() && name == "runtime")
                || matches!(name.as_str(), "logs" | "tmp" | "parts")
                || name.ends_with("-wal")
                || name.ends_with("-shm")
                || name.ends_with(".tmp")
                || name.ends_with("-journal")
            {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let rel_s = path.to_string_lossy().replace('\\', "/");
            if name.ends_with(".sqlite") {
                // WAL 模式下寫入先進 -wal 檔：主檔加 WAL 的時間與大小一起當指紋
                let wal = root.join(format!("{}-wal", path.display()));
                let (wm, ws) = std::fs::metadata(&wal)
                    .ok()
                    .map(|m| {
                        (
                            m.modified()
                                .ok()
                                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0),
                            m.len(),
                        )
                    })
                    .unwrap_or((0, 0));
                out.push((rel_s, true, (mtime.max(wm), meta.len() + ws)));
            } else {
                out.push((rel_s, false, (mtime, meta.len())));
            }
        }
    }
    out.sort();
    out
}

/// 線上快照一個 SQLite 檔並 gzip
fn snapshot(path: &Path) -> Result<Vec<u8>> {
    let src = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tmp = std::env::temp_dir().join(format!("rucloud-rep-{:016x}.sqlite", rand::random::<u64>()));
    {
        let mut dst = rusqlite::Connection::open(&tmp)?;
        rusqlite::backup::Backup::new(&src, &mut dst)?.run_to_completion(512, Duration::from_millis(10), None)?;
    }
    let raw = std::fs::read(&tmp)?;
    let _ = std::fs::remove_file(&tmp);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&raw)?;
    Ok(gz.finish()?)
}

fn now_tag() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string()
}

/// 複寫一輪；回傳 (送出的快照數, 送出的檔案數, 刪除的檔案數)
pub async fn round(
    root: &Path,
    remote: &Remote,
    m: &mut Manifest,
    seen: &mut BTreeMap<String, (u64, u64)>,
    keep: usize,
) -> Result<(usize, usize, usize)> {
    let (mut dbs, mut files, mut deleted) = (0, 0, 0);
    let local = scan(root);
    for (rel, is_db, fp) in &local {
        if seen.get(rel) == Some(fp) {
            continue;
        }
        if *is_db {
            let path = root.join(rel);
            let data = tokio::task::spawn_blocking(move || snapshot(&path)).await??;
            let tag = now_tag();
            remote.put(&format!("db/{rel}/{tag}.sqlite.gz"), data).await?;
            let list = m.dbs.entry(rel.clone()).or_default();
            list.push(tag);
            while list.len() > keep.max(1) {
                let old = list.remove(0);
                remote.delete(&format!("db/{rel}/{old}.sqlite.gz")).await?;
            }
            dbs += 1;
        } else {
            remote.put_file(&format!("files/{rel}"), &root.join(rel)).await?;
            m.files.insert(rel.clone(), *fp);
            files += 1;
        }
        seen.insert(rel.clone(), *fp);
    }
    // 本機已經沒有的一般檔案（例如刪掉的 R2 物件），遠端也刪
    let present: std::collections::HashSet<&String> = local.iter().map(|(r, _, _)| r).collect();
    let gone: Vec<String> = m.files.keys().filter(|k| !present.contains(k)).cloned().collect();
    for rel in gone {
        remote.delete(&format!("files/{rel}")).await?;
        m.files.remove(&rel);
        seen.remove(&rel);
        deleted += 1;
    }
    if dbs + files + deleted > 0 {
        m.updated = chrono::Utc::now().to_rfc3339();
        remote.put("manifest.json", serde_json::to_vec_pretty(m)?).await?;
    }
    Ok((dbs, files, deleted))
}

/// serve 裡的背景工作
pub async fn run_loop(root: PathBuf, cfg: ReplicateCfg, stop: tokio_util::sync::CancellationToken) {
    let remote = match Remote::new(&cfg) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("複寫設定有問題：{e:#}");
            return;
        }
    };
    tracing::info!("持續複寫到 {}（每 {} 秒）", remote.describe(), cfg.interval);
    let mut m = match remote.manifest().await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("讀不到遠端的 manifest：{e:#}");
            return;
        }
    };
    // 第一輪：遠端已經有的一般檔案、資料庫，用 manifest 的指紋略過沒變的
    let mut seen: BTreeMap<String, (u64, u64)> = m.files.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(cfg.interval.max(1)));
    loop {
        let stopping = tokio::select! {
            _ = tick.tick() => false,
            _ = stop.cancelled() => true,
        };
        match round(&root, &remote, &mut m, &mut seen, cfg.keep).await {
            Ok((d, f, x)) if d + f + x > 0 => tracing::info!("複寫：{d} 個資料庫快照、{f} 個檔案、刪除 {x} 個"),
            Ok(_) => {}
            Err(e) => tracing::warn!("複寫失敗（下一輪再試）：{e:#}"),
        }
        if stopping {
            return;
        }
    }
}

// ---------- 還原 ----------

/// 從遠端還原到 state 資料夾。at 給了就用每個資料庫在那之前最新的快照
pub async fn restore(cfg: &ReplicateCfg, state: &Path, at: Option<&str>, force: bool) -> Result<()> {
    if state.exists() && std::fs::read_dir(state)?.next().is_some() && !force {
        bail!("{} 不是空的；確定要覆蓋請加 --force（請先停掉 rucloud）", state.display());
    }
    let at = match at {
        Some(s) => Some(
            chrono::DateTime::parse_from_rfc3339(s)
                .with_context(|| format!("--at 要是 RFC 3339 時間，例如 2026-11-05T10:00:00Z：{s}"))?
                .with_timezone(&chrono::Utc)
                .format("%Y%m%dT%H%M%S%3fZ")
                .to_string(),
        ),
        None => None,
    };
    let remote = Remote::new(cfg)?;
    let m = remote.manifest().await?;
    if m.dbs.is_empty() && m.files.is_empty() {
        bail!("{} 沒有複寫的資料", remote.describe());
    }
    std::fs::create_dir_all(state)?;
    let (mut dbs, mut files) = (0, 0);
    for (rel, tags) in &m.dbs {
        let tag = match &at {
            Some(a) => tags.iter().rev().find(|t| t.as_str() <= a.as_str()),
            None => tags.last(),
        };
        let Some(tag) = tag else {
            println!("  略過 {rel}（{} 之前沒有快照）", at.as_deref().unwrap_or(""));
            continue;
        };
        let gz = remote
            .get(&format!("db/{rel}/{tag}.sqlite.gz"))
            .await?
            .with_context(|| format!("遠端少了 {rel} 的快照 {tag}"))?;
        let mut raw = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut raw)?;
        let dest = state.join(rel);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        for ext in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", dest.display()));
        }
        std::fs::write(&dest, raw)?;
        dbs += 1;
    }
    for rel in m.files.keys() {
        let data = remote
            .get(&format!("files/{rel}"))
            .await?
            .with_context(|| format!("遠端少了檔案 {rel}"))?;
        let dest = state.join(rel);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::write(dest, data)?;
        files += 1;
    }
    println!(
        "已從 {} 還原 {dbs} 個資料庫、{files} 個檔案到 {}",
        remote.describe(),
        state.display()
    );
    Ok(())
}

/// 列出遠端的狀態
pub async fn status(cfg: &ReplicateCfg) -> Result<()> {
    let remote = Remote::new(cfg)?;
    let m = remote.manifest().await?;
    println!(
        "{}（最後更新 {}）",
        remote.describe(),
        if m.updated.is_empty() { "從未" } else { &m.updated }
    );
    for (rel, tags) in &m.dbs {
        println!(
            "  {rel}：{} 份快照，最新 {}",
            tags.len(),
            tags.last().map(String::as_str).unwrap_or("—")
        );
    }
    println!("  其他檔案 {} 個", m.files.len());
    Ok(())
}
