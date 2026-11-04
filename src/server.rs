//! 把所有元件組起來：綁定 API、各應用的閘道、排程、佇列消費者、DO 鬧鐘、開發模式的熱重載。

use crate::app::{App, Ctx};
use crate::bindings::{self, Hub};
use crate::config::ServeConfig;
use crate::gateway;
use crate::queues::Queues;
use anyhow::{Context, Result};
use axum::Router;
use axum::routing::any;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const HOST_JS: &str = include_str!("../runtime/host.mjs");
const WORKERS_JS: &str = include_str!("../runtime/cloudflare-workers.mjs");
const REWRITER_JS: &str = include_str!("../runtime/html-rewriter.mjs");

/// 把內嵌的 JS 執行環境寫到 state 資料夾，回傳 host.mjs 的路徑
fn write_runtime(state_root: &Path) -> Result<PathBuf> {
    let dir = state_root.join("runtime");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("host.mjs"), HOST_JS)?;
    std::fs::write(dir.join("cloudflare-workers.mjs"), WORKERS_JS)?;
    std::fs::write(dir.join("html-rewriter.mjs"), REWRITER_JS)?;
    Ok(dir.join("host.mjs").canonicalize()?)
}

pub async fn run(cfg: ServeConfig, dev: bool) -> Result<()> {
    std::fs::create_dir_all(&cfg.state_dir)?;
    let state_root = cfg.state_dir.canonicalize()?;
    let host_js = write_runtime(&state_root)?;

    let bind_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let bindings_url = format!("http://{}", bind_listener.local_addr()?);
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(256)
        .tcp_nodelay(true)
        .build()?;

    let ctx = Ctx {
        state_root: &state_root,
        node: &cfg.node,
        host_js: &host_js,
        bindings_url: &bindings_url,
        http,
        dev,
    };
    let mut apps: Vec<(Arc<App>, &crate::config::AppEntry)> = Vec::new();
    for entry in &cfg.apps {
        let app = App::load(entry, &ctx)?;
        if apps.iter().any(|(a, _)| a.name == app.name) {
            anyhow::bail!("應用名稱重複：{}", app.name);
        }
        apps.push((app, entry));
    }

    let queues = Arc::new(Queues::open(&state_root.join("queues.sqlite"))?);
    let hub = Arc::new(Hub {
        apps: apps.iter().map(|(a, _)| (a.name.clone(), a.clone())).collect(),
        queues: queues.clone(),
    });
    tokio::spawn(async move { axum::serve(bind_listener, bindings::router(hub)).await });

    let mut edge_routes: HashMap<String, Arc<App>> = HashMap::new();
    for (app, entry) in &apps {
        edge_routes.insert(app.name.clone(), app.clone());
        for h in &entry.hosts {
            edge_routes.insert(h.clone(), app.clone());
        }
        if let Some(port) = entry.port {
            let addr: SocketAddr = format!("{}:{port}", cfg.bind).parse().context("bind 位址不對")?;
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .with_context(|| format!("無法監聽 {addr}"))?;
            let router = Router::new().fallback(any(gateway::app_handler)).with_state(app.clone());
            tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await });
            let shown = if cfg.bind == "0.0.0.0" {
                "localhost".to_string()
            } else {
                cfg.bind.clone()
            };
            tracing::info!("[{}] http://{shown}:{port}  ({})", app.name, app.dir.display());
        }
        for cron in &app.cfg.triggers.crons {
            tokio::spawn(cron_loop(app.clone(), cron.clone()));
        }
        for consumer in &app.cfg.queues.consumers {
            tokio::spawn(queues.clone().consume(app.clone(), consumer.clone()));
        }
        if !app.cfg.durable_objects.bindings.is_empty() {
            tokio::spawn(alarm_loop(app.clone()));
        }
        tokio::spawn(purge_loop(app.clone()));
        if entry.watch {
            tokio::spawn(watch_loop(app.clone()));
        }
    }
    if let Some(edge) = &cfg.edge {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, edge.port).parse()?;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        let router = Router::new().fallback(any(gateway::edge_handler)).with_state(Arc::new(edge_routes));
        tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await });
        tracing::info!("edge：http://<應用名稱>.localhost:{}（依 Host 分派）", edge.port);
    }
    if let Some(gw_cfg) = cfg.ai_gateway.clone() {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, gw_cfg.port).parse()?;
        let gw = crate::ai_gateway::Gateway::new(gw_cfg, &state_root)?;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        tokio::spawn(async move { axum::serve(listener, crate::ai_gateway::router(gw)).await });
        tracing::info!("AI Gateway：http://{addr}/<gateway>/<provider>/...");
    }

    if let Some(s3_cfg) = cfg.s3.clone() {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, s3_cfg.port).parse()?;
        let all: Vec<Arc<App>> = apps.iter().map(|(a, _)| a.clone()).collect();
        let s3 = crate::s3::S3::new(s3_cfg, &all);
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        tokio::spawn(async move { axum::serve(listener, crate::s3::router(s3)).await });
        tracing::info!("R2 的 S3 API：http://{addr}（path-style）");
    }

    tokio::signal::ctrl_c().await?;
    tracing::info!("收到中斷訊號，結束");
    Ok(())
}

/// Cron Triggers：5 欄位的 cron（UTC），到時間呼叫 scheduled()
async fn cron_loop(app: Arc<App>, expr: String) {
    let schedule = match cron::Schedule::from_str(&format!("0 {expr}")) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[{}] cron 格式不對 {expr:?}：{e}", app.name);
            return;
        }
    };
    tracing::info!("[{}] 排程 {expr}", app.name);
    for next in schedule.upcoming(chrono::Utc) {
        let wait = (next - chrono::Utc::now()).to_std().unwrap_or_default();
        tokio::time::sleep(wait).await;
        let body = json!({ "cron": expr, "scheduledTime": next.timestamp_millis() });
        if let Err(e) = gateway::invoke(&app, "scheduled", &body).await {
            tracing::error!("[{}] 排程 {expr} 執行失敗：{e:#}", app.name);
        }
    }
}

/// Durable Object 鬧鐘：到期就呼叫該物件的 alarm()，失敗 10 秒後重試
async fn alarm_loop(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tick.tick().await;
        let now = chrono::Utc::now().timestamp_millis();
        let store = app.durable.clone();
        let due = tokio::task::spawn_blocking(move || store.take_due_alarms(now))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        for (ns, id, _) in due {
            let app = app.clone();
            tokio::spawn(async move {
                let extra = [("x-rucloud-do-ns", ns.clone()), ("x-rucloud-do-id", id.clone())];
                if let Err(e) = gateway::invoke_on(&app, Some(App::do_affinity(&id)), "alarm", &json!({}), &extra).await {
                    tracing::error!("[{}] {ns} 的 alarm() 失敗：{e:#}", app.name);
                    let at = chrono::Utc::now().timestamp_millis() + 10_000;
                    let _ = app.durable.op(&ns, &id, &json!({ "op": "setAlarm", "at": at }));
                }
            });
        }
    }
}

async fn purge_loop(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        let kv = app.kv.clone();
        let _ = tokio::task::spawn_blocking(move || kv.purge_expired()).await;
    }
}

/// 開發模式：Worker 程式碼（main 所在資料夾）有變動就重開程序
async fn watch_loop(app: Arc<App>) {
    let Some(pool) = app.pool.clone() else { return };
    let Some(main) = app.cfg.main.as_ref() else { return };
    let root = app.dir.join(main).parent().map(Path::to_path_buf).unwrap_or(app.dir.clone());
    let mut last = fingerprint(&root);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let now = fingerprint(&root);
        if now != last {
            last = now;
            pool.restart();
        }
    }
}

fn fingerprint(dir: &Path) -> (u64, u128) {
    let mut count = 0;
    let mut sum = 0u128;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name();
            if matches!(name.to_str(), Some("node_modules" | ".git" | ".wrangler" | ".rucloud")) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                count += 1;
                sum += meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
            }
        }
    }
    (count, sum)
}
