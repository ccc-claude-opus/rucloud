//! 直接操作本機資料的指令（像 wrangler d1 / kv / r2 的 --local）：
//! rucloud d1 execute | migrations、rucloud kv、rucloud r2 object。
//! 直接開 state 資料夾裡的 SQLite，rucloud 執行中也可以用（WAL 模式）。

use crate::config::{self, Wrangler};
use crate::d1::D1;
use crate::kv::Kv;
use crate::r2::R2;
use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// 每個指令都要指定的應用
#[derive(Args, Clone)]
pub struct AppRef {
    /// 應用資料夾（有 wrangler 設定檔的那層）
    pub app: PathBuf,
    /// wrangler 設定的環境（env.<名稱>）
    #[arg(long)]
    pub env: Option<String>,
    /// 資料存放的資料夾
    #[arg(long, default_value = ".rucloud")]
    pub state: PathBuf,
}

struct Resolved {
    dir: PathBuf,
    cfg: Wrangler,
    state: PathBuf,
}

impl AppRef {
    fn resolve(&self) -> Result<Resolved> {
        let dir = self.app.canonicalize().with_context(|| format!("找不到 {}", self.app.display()))?;
        let cfg = config::load_wrangler(&dir, self.env.as_deref())?;
        let name = cfg
            .name
            .clone()
            .unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned());
        Ok(Resolved {
            state: self.state.join(name),
            dir,
            cfg,
        })
    }
}

#[derive(Subcommand)]
pub enum D1Cmd {
    /// 執行 SQL：rucloud d1 execute <應用> <資料庫> --file schema.sql | --command "SELECT …"
    Execute {
        #[command(flatten)]
        app: AppRef,
        /// 資料庫名稱或綁定名稱
        database: String,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        command: Option<String>,
    },
    /// migrations（和 wrangler d1 migrations 相同的資料夾與紀錄表）
    Migrations {
        #[command(subcommand)]
        cmd: MigrationsCmd,
    },
}

#[derive(Subcommand)]
pub enum MigrationsCmd {
    /// 列出 migrations 與是否已套用
    List {
        #[command(flatten)]
        app: AppRef,
        database: String,
    },
    /// 套用還沒套用的 migrations
    Apply {
        #[command(flatten)]
        app: AppRef,
        database: String,
    },
    /// 新增一個空的 migration 檔：0001_<名稱>.sql
    Create {
        #[command(flatten)]
        app: AppRef,
        database: String,
        name: String,
    },
}

#[derive(Subcommand)]
pub enum KvCmd {
    /// 寫入：rucloud kv put <應用> <key> <value> --binding KV（或 --path 檔案）
    Put {
        #[command(flatten)]
        app: AppRef,
        key: String,
        value: Option<String>,
        #[arg(long)]
        binding: String,
        #[arg(long)]
        path: Option<PathBuf>,
        /// 幾秒後過期
        #[arg(long)]
        ttl: Option<i64>,
        /// JSON
        #[arg(long)]
        metadata: Option<String>,
    },
    /// 讀出（寫到 stdout）
    Get {
        #[command(flatten)]
        app: AppRef,
        key: String,
        #[arg(long)]
        binding: String,
    },
    /// 列出鍵
    List {
        #[command(flatten)]
        app: AppRef,
        #[arg(long)]
        binding: String,
        #[arg(long, default_value = "")]
        prefix: String,
    },
    Delete {
        #[command(flatten)]
        app: AppRef,
        key: String,
        #[arg(long)]
        binding: String,
    },
}

#[derive(Subcommand)]
pub enum R2Cmd {
    /// 物件操作：路徑寫成 <bucket>/<key>
    Object {
        #[command(subcommand)]
        cmd: R2ObjectCmd,
    },
}

#[derive(Subcommand)]
pub enum R2ObjectCmd {
    Put {
        #[command(flatten)]
        app: AppRef,
        /// <bucket>/<key>
        path: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        content_type: Option<String>,
    },
    /// 讀出（沒給 --file 就寫到 stdout）
    Get {
        #[command(flatten)]
        app: AppRef,
        path: String,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    Delete {
        #[command(flatten)]
        app: AppRef,
        path: String,
    },
    List {
        #[command(flatten)]
        app: AppRef,
        bucket: String,
        #[arg(long, default_value = "")]
        prefix: String,
    },
}

// ---------- D1 ----------

fn open_d1(r: &Resolved, database: &str) -> Result<(D1, PathBuf, PathBuf)> {
    let db = r
        .cfg
        .d1_databases
        .iter()
        .find(|d| d.binding == database || d.db_name() == database)
        .with_context(|| format!("沒有叫 {database} 的 D1 資料庫"))?;
    let path = r.state.join("d1").join(format!("{}.sqlite", db.db_name()));
    let migrations = r.dir.join(db.migrations_dir.as_deref().unwrap_or("migrations"));
    Ok((D1::open(&path)?, path, migrations))
}

pub fn d1(cmd: D1Cmd) -> Result<()> {
    match cmd {
        D1Cmd::Execute {
            app,
            database,
            file,
            command,
        } => {
            let r = app.resolve()?;
            let (db, path, _) = open_d1(&r, &database)?;
            match (file, command) {
                (Some(f), _) => {
                    let sql = std::fs::read_to_string(&f).with_context(|| format!("讀不到 {}", f.display()))?;
                    let out = db.exec(&sql)?;
                    println!("執行了 {} 句 SQL（{}）", out["count"], path.display());
                }
                (None, Some(sql)) => println!("{}", serde_json::to_string_pretty(&db.query(&sql, &[])?)?),
                _ => bail!("請給 --file 或 --command"),
            }
        }
        D1Cmd::Migrations {
            cmd: MigrationsCmd::List { app, database },
        } => {
            let r = app.resolve()?;
            let (db, _, dir) = open_d1(&r, &database)?;
            for (name, applied) in db.migrations(&dir)? {
                println!("{} {name}", if applied { "✓" } else { "·" });
            }
        }
        D1Cmd::Migrations {
            cmd: MigrationsCmd::Apply { app, database },
        } => {
            let r = app.resolve()?;
            let (db, _, dir) = open_d1(&r, &database)?;
            let done = db.migrate(&dir)?;
            if done.is_empty() {
                println!("沒有要套用的 migration");
            }
            for name in done {
                println!("已套用 {name}");
            }
        }
        D1Cmd::Migrations {
            cmd: MigrationsCmd::Create { app, database, name },
        } => {
            let r = app.resolve()?;
            let (db, _, dir) = open_d1(&r, &database)?;
            std::fs::create_dir_all(&dir)?;
            let next = db.migrations(&dir)?.len() + 1;
            let slug: String = name.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
            let file = dir.join(format!("{next:04}_{slug}.sql"));
            std::fs::write(&file, format!("-- Migration number: {next:04}\n"))?;
            println!("{}", file.display());
        }
    }
    Ok(())
}

// ---------- KV ----------

fn kv_store(r: &Resolved, binding: &str) -> Result<Kv> {
    if !r.cfg.kv_namespaces.iter().any(|k| k.binding == binding) {
        bail!("沒有叫 {binding} 的 KV 綁定");
    }
    Kv::open(&r.state.join("kv.sqlite"))
}

pub fn kv(cmd: KvCmd) -> Result<()> {
    match cmd {
        KvCmd::Put {
            app,
            key,
            value,
            binding,
            path,
            ttl,
            metadata,
        } => {
            let r = app.resolve()?;
            let kv = kv_store(&r, &binding)?;
            let bytes = match (value, path) {
                (_, Some(p)) => std::fs::read(&p).with_context(|| format!("讀不到 {}", p.display()))?,
                (Some(v), None) => v.into_bytes(),
                (None, None) => bail!("請給值或 --path"),
            };
            if let Some(m) = &metadata {
                serde_json::from_str::<Value>(m).context("--metadata 要是 JSON")?;
            }
            kv.put(&binding, &key, &bytes, metadata.as_deref(), ttl.map(|t| crate::kv::now_secs() + t))?;
        }
        KvCmd::Get { app, key, binding } => {
            let r = app.resolve()?;
            match kv_store(&r, &binding)?.get(&binding, &key)? {
                Some(e) => {
                    use std::io::Write;
                    std::io::stdout().write_all(&e.value)?;
                }
                None => bail!("找不到 {key}"),
            }
        }
        KvCmd::List { app, binding, prefix } => {
            let r = app.resolve()?;
            let kv = kv_store(&r, &binding)?;
            let mut cursor: Option<String> = None;
            loop {
                let page = kv.list(&binding, &prefix, 1000, cursor.as_deref())?;
                for k in page["keys"].as_array().into_iter().flatten() {
                    println!("{}", k["name"].as_str().unwrap_or(""));
                }
                match page["cursor"].as_str() {
                    Some(c) if page["list_complete"] == json!(false) => cursor = Some(c.to_string()),
                    _ => break,
                }
            }
        }
        KvCmd::Delete { app, key, binding } => {
            let r = app.resolve()?;
            kv_store(&r, &binding)?.delete(&binding, &key)?;
        }
    }
    Ok(())
}

// ---------- R2 ----------

fn r2_store(r: &Resolved, bucket: &str) -> Result<R2> {
    if !r
        .cfg
        .r2_buckets
        .iter()
        .any(|b| b.bucket_name.as_deref().unwrap_or(&b.binding) == bucket)
    {
        bail!("沒有叫 {bucket} 的 R2 bucket");
    }
    R2::open(&r.state.join("r2"))
}

fn split_path(p: &str) -> Result<(&str, &str)> {
    p.split_once('/')
        .filter(|(b, k)| !b.is_empty() && !k.is_empty())
        .context("路徑要寫成 <bucket>/<key>")
}

pub fn r2(cmd: R2Cmd) -> Result<()> {
    let R2Cmd::Object { cmd } = cmd;
    match cmd {
        R2ObjectCmd::Put {
            app,
            path,
            file,
            content_type,
        } => {
            let r = app.resolve()?;
            let (bucket, key) = split_path(&path)?;
            let store = r2_store(&r, bucket)?;
            let data = std::fs::read(&file).with_context(|| format!("讀不到 {}", file.display()))?;
            let tmp = store.tmp_path();
            std::fs::write(&tmp, &data)?;
            let ct = content_type.unwrap_or_else(|| mime_guess::from_path(&file).first_or_octet_stream().to_string());
            let etag = hex::encode(<md5::Md5 as md5::Digest>::digest(&data));
            let obj = store.commit(
                bucket,
                key,
                &tmp,
                data.len() as u64,
                &etag,
                &json!({ "contentType": ct }),
                &json!({}),
            )?;
            println!(
                "{} {} bytes etag {}",
                obj["key"].as_str().unwrap_or(""),
                obj["size"],
                obj["etag"].as_str().unwrap_or("")
            );
        }
        R2ObjectCmd::Get { app, path, file } => {
            let r = app.resolve()?;
            let (bucket, key) = split_path(&path)?;
            let store = r2_store(&r, bucket)?;
            store.head(bucket, key)?.with_context(|| format!("找不到 {path}"))?;
            let data = std::fs::read(store.file_path(bucket, key))?;
            match file {
                Some(f) => std::fs::write(&f, data)?,
                None => {
                    use std::io::Write;
                    std::io::stdout().write_all(&data)?;
                }
            }
        }
        R2ObjectCmd::Delete { app, path } => {
            let r = app.resolve()?;
            let (bucket, key) = split_path(&path)?;
            r2_store(&r, bucket)?.delete(bucket, &[key.to_string()])?;
        }
        R2ObjectCmd::List { app, bucket, prefix } => {
            let r = app.resolve()?;
            let store = r2_store(&r, &bucket)?;
            let mut cursor: Option<String> = None;
            loop {
                let page = store.list(&bucket, &prefix, 1000, cursor.as_deref(), None)?;
                for o in page["objects"].as_array().into_iter().flatten() {
                    println!("{:>12}  {}", o["size"], o["key"].as_str().unwrap_or(""));
                }
                match page["cursor"].as_str() {
                    Some(c) if page["truncated"] == json!(true) => cursor = Some(c.to_string()),
                    _ => break,
                }
            }
        }
    }
    Ok(())
}

/// serve / dev 啟動時用：每個 D1 有 migrations 資料夾就套用
pub fn migrate_all(dir: &Path, cfg: &Wrangler, d1: &std::collections::HashMap<String, std::sync::Arc<D1>>, app: &str) -> Result<()> {
    for db in &cfg.d1_databases {
        let mdir = dir.join(db.migrations_dir.as_deref().unwrap_or("migrations"));
        if !mdir.is_dir() {
            continue;
        }
        if let Some(store) = d1.get(&db.binding) {
            for name in store.migrate(&mdir)? {
                tracing::info!("[{app}] {} 已套用 migration {name}", db.binding);
            }
        }
    }
    Ok(())
}
