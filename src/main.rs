//! rucloud：自架的 Cloudflare Workers 平台。
//! Rust 負責邊緣閘道、靜態檔案、所有資料綁定（D1/KV/R2/Queues/DO/Vectorize）與排程；
//! Worker 的 JS 程式碼跑在 Node.js 程序裡。

mod admin;
mod ai;
mod ai_gateway;
mod app;
mod assets;
mod bindings;
mod cli;
mod config;
mod d1;
mod durable;
mod gateway;
mod kv;
mod observe;
mod pool;
mod queues;
mod r2;
mod s3;
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
        /// wrangler 設定的環境（env.<名稱>）
        #[arg(long)]
        env: Option<String>,
        /// 啟動時套用 D1 的 migrations（migrations/ 資料夾）
        #[arg(long)]
        d1_migrate: bool,
        /// 程式碼改了不要自動重載
        #[arg(long)]
        no_watch: bool,
        #[arg(long, default_value = "node")]
        node: String,
        /// 關掉 Node 權限模型沙箱（Worker 可以讀寫任何檔案、開子程序）
        #[arg(long)]
        no_sandbox: bool,
        /// 每個 Worker 程序的 JS heap 上限（MB）
        #[arg(long)]
        memory_mb: Option<u32>,
        /// 事件迴圈卡住超過幾毫秒就重開程序（0 = 不檢查）
        #[arg(long, default_value_t = 30_000)]
        max_block_ms: u64,
        /// 開管理埠（/health、/metrics、log；只聽 127.0.0.1）
        #[arg(long)]
        admin_port: Option<u16>,
        /// 開 R2 的 S3 相容 API（金鑰取自 RUCLOUD_S3_ACCESS_KEY_ID / RUCLOUD_S3_SECRET_ACCESS_KEY）
        #[arg(long)]
        s3_port: Option<u16>,
    },
    /// 依 rucloud.toml 同時跑多個應用（正式部署用）
    Serve {
        #[arg(default_value = "rucloud.toml")]
        config: PathBuf,
    },
    /// D1 資料庫操作（execute、migrations）
    D1 {
        #[command(subcommand)]
        cmd: cli::D1Cmd,
    },
    /// KV 操作（put、get、list、delete）
    Kv {
        #[command(subcommand)]
        cmd: cli::KvCmd,
    },
    /// R2 物件操作
    R2 {
        #[command(subcommand)]
        cmd: cli::R2Cmd,
    },
    /// 即時看應用的 log（連到 rucloud 的管理埠）
    Tail {
        /// 應用名稱
        app: String,
        /// 管理埠的網址
        #[arg(long, default_value = "http://127.0.0.1:8799")]
        admin: String,
        /// 管理 token（也可以用環境變數 RUCLOUD_ADMIN_TOKEN）
        #[arg(long, env = "RUCLOUD_ADMIN_TOKEN")]
        token: Option<String>,
        /// 先印出最近幾筆
        #[arg(short, default_value_t = 20)]
        n: usize,
        /// 只看某一種：console、error、request
        #[arg(long)]
        kind: Option<String>,
        /// 輸出原始 JSON
        #[arg(long)]
        json: bool,
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("RUCLOUD_LOG").unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();
    match Cli::parse().cmd {
        Cmd::Dev {
            app,
            port,
            ip,
            instances,
            state,
            d1_init,
            no_watch,
            node,
            s3_port,
            no_sandbox,
            memory_mb,
            max_block_ms,
            env,
            d1_migrate,
            admin_port,
        } => {
            let s3 = match s3_port {
                Some(port) => Some(s3::S3Cfg {
                    port,
                    access_key_id: std::env::var("RUCLOUD_S3_ACCESS_KEY_ID").context("--s3-port 需要環境變數 RUCLOUD_S3_ACCESS_KEY_ID")?,
                    secret_access_key: std::env::var("RUCLOUD_S3_SECRET_ACCESS_KEY")
                        .context("--s3-port 需要環境變數 RUCLOUD_S3_SECRET_ACCESS_KEY")?,
                }),
                None => None,
            };
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
                s3,
                admin: admin_port.map(|port| config::AdminCfg {
                    port,
                    bind: "127.0.0.1".into(),
                    token: None,
                }),
                shutdown_timeout: 10,
                apps: vec![AppEntry {
                    path: app,
                    name: None,
                    port: Some(port),
                    hosts: vec![],
                    instances,
                    env_file: None,
                    d1_init: init,
                    env,
                    d1_migrate,
                    watch: !no_watch,
                    sandbox: !no_sandbox,
                    allow_read: vec![],
                    allow_write: vec![],
                    memory_mb,
                    max_block_ms: Some(max_block_ms),
                    log_files: true,
                }],
            };
            server::run(cfg, true).await
        }
        Cmd::Serve { config } => server::run(config::load_serve_config(&config)?, false).await,
        Cmd::D1 { cmd } => cli::d1(cmd),
        Cmd::Kv { cmd } => cli::kv(cmd),
        Cmd::Tail {
            app,
            admin,
            token,
            n,
            kind,
            json,
        } => cli::tail(&admin, &app, token.as_deref(), n, kind.as_deref(), json).await,
        Cmd::R2 { cmd } => cli::r2(cmd),
        Cmd::AiGateway {
            port,
            state,
            cache_ttl,
            retries,
        } => {
            std::fs::create_dir_all(&state)?;
            let gw = ai_gateway::Gateway::new(
                ai_gateway::GatewayCfg {
                    port,
                    cache_ttl,
                    retries,
                    ..Default::default()
                },
                &state,
            )?;
            let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
            tracing::info!("AI Gateway：http://localhost:{port}/<gateway>/<provider>/...");
            axum::serve(listener, ai_gateway::router(gw)).await?;
            Ok(())
        }
    }
}
