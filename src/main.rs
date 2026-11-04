//! rucloud：自架的 Cloudflare Workers 平台。
//! Rust 負責邊緣閘道、靜態檔案、所有資料綁定（D1/KV/R2/Queues/DO/Vectorize）與排程；
//! Worker 的 JS 程式碼跑在 Node.js 程序裡。

mod ai;
mod ai_gateway;
mod app;
mod assets;
mod bindings;
mod config;
mod d1;
mod durable;
mod gateway;
mod kv;
mod pool;
mod queues;
mod r2;
mod server;
mod vectorize;
mod ws;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use config::{AppEntry, ServeConfig};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "rucloud", version, about = "自架的 Cloudflare Workers 平台（Rust + Node.js）")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 開發模式跑一個應用（像 wrangler dev）
    Dev {
        /// 應用資料夾（有 wrangler.jsonc 的那層）
        #[arg(default_value = ".")]
        app: PathBuf,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        ip: String,
        /// Worker 程序數
        #[arg(long, default_value_t = 1)]
        instances: usize,
        /// 資料存放的資料夾
        #[arg(long, default_value = ".rucloud")]
        state: PathBuf,
        /// 啟動時執行 SQL 檔，例如 --d1-init DB=schema.sql（可重複）
        #[arg(long = "d1-init", value_name = "BINDING=FILE")]
        d1_init: Vec<String>,
        /// 程式碼改了不要自動重載
        #[arg(long)]
        no_watch: bool,
        #[arg(long, default_value = "node")]
        node: String,
    },
    /// 依 rucloud.toml 同時跑多個應用（正式部署用）
    Serve {
        #[arg(default_value = "rucloud.toml")]
        config: PathBuf,
    },
    /// D1 資料庫操作
    D1 {
        #[command(subcommand)]
        cmd: D1Cmd,
    },
    /// 單獨跑 AI Gateway
    AiGateway {
        #[arg(long, default_value_t = 8790)]
        port: u16,
        #[arg(long, default_value = ".rucloud")]
        state: PathBuf,
        /// 預設快取秒數（0 = 只有帶 cf-aig-cache-ttl 才快取）
        #[arg(long, default_value_t = 0)]
        cache_ttl: u64,
        #[arg(long, default_value_t = 2)]
        retries: u32,
    },
}

#[derive(Subcommand)]
enum D1Cmd {
    /// 執行 SQL：rucloud d1 execute <應用資料夾> <資料庫名稱或綁定> --file schema.sql
    Execute {
        app: PathBuf,
        database: String,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        command: Option<String>,
        #[arg(long, default_value = ".rucloud")]
        state: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("RUCLOUD_LOG").unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();
    match Cli::parse().cmd {
        Cmd::Dev { app, port, ip, instances, state, d1_init, no_watch, node } => {
            let mut init = BTreeMap::new();
            for s in d1_init {
                let (b, f) = s.split_once('=').context("--d1-init 的格式是 BINDING=FILE")?;
                init.insert(b.to_string(), PathBuf::from(f));
            }
            let cfg = ServeConfig {
                state_dir: state,
                node,
                bind: ip,
                edge: None,
                ai_gateway: None,
                apps: vec![AppEntry {
                    path: app,
                    name: None,
                    port: Some(port),
                    hosts: vec![],
                    instances,
                    env_file: None,
                    d1_init: init,
                    watch: !no_watch,
                }],
            };
            server::run(cfg, true).await
        }
        Cmd::Serve { config } => server::run(config::load_serve_config(&config)?, false).await,
        Cmd::D1 { cmd: D1Cmd::Execute { app, database, file, command, state } } => d1_execute(app, database, file, command, state),
        Cmd::AiGateway { port, state, cache_ttl, retries } => {
            std::fs::create_dir_all(&state)?;
            let gw = ai_gateway::Gateway::new(
                ai_gateway::GatewayCfg { port, cache_ttl, retries, ..Default::default() },
                &state,
            )?;
            let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
            tracing::info!("AI Gateway：http://localhost:{port}/<gateway>/<provider>/...");
            axum::serve(listener, ai_gateway::router(gw)).await?;
            Ok(())
        }
    }
}

fn d1_execute(app: PathBuf, database: String, file: Option<PathBuf>, command: Option<String>, state: PathBuf) -> Result<()> {
    let dir = app.canonicalize().with_context(|| format!("找不到 {}", app.display()))?;
    let cfg = config::load_wrangler(&dir)?;
    let name = cfg.name.clone().unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned());
    let db_cfg = cfg
        .d1_databases
        .iter()
        .find(|d| d.binding == database || d.db_name() == database)
        .with_context(|| format!("{name} 沒有叫 {database} 的 D1 資料庫"))?;
    let path = state.join(&name).join("d1").join(format!("{}.sqlite", db_cfg.db_name()));
    let db = d1::D1::open(&path)?;
    match (file, command) {
        (Some(f), _) => {
            let sql = std::fs::read_to_string(&f).with_context(|| format!("讀不到 {}", f.display()))?;
            let r = db.exec(&sql)?;
            println!("執行了 {} 句 SQL（{}）", r["count"], path.display());
        }
        (None, Some(sql)) => {
            let r = db.query(&sql, &[])?;
            println!("{}", serde_json::to_string_pretty(&r)?);
        }
        _ => anyhow::bail!("請給 --file 或 --command"),
    }
    Ok(())
}
