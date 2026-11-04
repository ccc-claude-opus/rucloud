//! 把所有元件組起來：綁定 API、各應用的閘道、排程、佇列消費者、DO 鬧鐘、開發模式的熱重載。

use crate::app::{App, Ctx, Slot};
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
        state_root: state_root.clone(),
        node: cfg.node.clone(),
        host_js: host_js.clone(),
        bindings_url: bindings_url.clone(),
        http,
        dev,
    };
    let mut apps: Vec<(Arc<Slot>, &crate::config::AppEntry)> = Vec::new();
    for entry in &cfg.apps {
        let name = crate::app::app_name(entry)?;
        if apps.iter().any(|(a, _)| a.name == name) {
            anyhow::bail!("應用名稱重複：{name}");
        }
        let code = crate::deploy::code_dir(&ctx, &name, &entry.path);
        apps.push((Slot::create(entry, &ctx, &code)?, entry));
    }

    let queues = Arc::new(Queues::open(&state_root.join("queues.sqlite"))?);
    let hub = Arc::new(Hub {
        apps: apps.iter().map(|(a, _)| (a.name.clone(), a.clone())).collect(),
        queues: queues.clone(),
    });
    // 綁定 API 不參與優雅關閉：還在處理的請求可能需要它，程序結束時才停
    tokio::spawn(async move { axum::serve(bind_listener, bindings::router(hub)).await });

    // 對外的伺服器都掛在 shutdown 上：收到 SIGTERM 就停止收新連線，等進行中的請求做完
    let shutdown = tokio_util::sync::CancellationToken::new();
    let mut servers: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    macro_rules! serve {
        ($listener:expr, $svc:expr) => {{
            let stop = shutdown.clone();
            let (listener, svc) = ($listener, $svc);
            servers.push(tokio::spawn(async move {
                let _ = axum::serve(listener, svc).with_graceful_shutdown(stop.cancelled_owned()).await;
            }));
        }};
    }
    let mut edge_routes: HashMap<String, Arc<Slot>> = HashMap::new();
    for (slot, entry) in &apps {
        let app = slot.get();
        edge_routes.insert(slot.name.clone(), slot.clone());
        for h in &entry.hosts {
            edge_routes.insert(h.clone(), slot.clone());
        }
        if let Some(port) = entry.port {
            let addr: SocketAddr = format!("{}:{port}", cfg.bind).parse().context("bind 位址不對")?;
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .with_context(|| format!("無法監聽 {addr}"))?;
            let router = Router::new().fallback(any(gateway::app_handler)).with_state(slot.clone());
            serve!(listener, router.into_make_service_with_connect_info::<SocketAddr>());
            let shown = if cfg.bind == "0.0.0.0" {
                "localhost".to_string()
            } else {
                cfg.bind.clone()
            };
            tracing::info!("[{}] http://{shown}:{port}  ({})", slot.name, app.dir.display());
        }
        crate::deploy::restart_background(slot, &app, &queues);
    }
    if let Some(edge) = &cfg.edge {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, edge.port).parse()?;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        let router = Router::new().fallback(any(gateway::edge_handler)).with_state(Arc::new(edge_routes));
        serve!(listener, router.into_make_service_with_connect_info::<SocketAddr>());
        tracing::info!("edge：http://<應用名稱>.localhost:{}（依 Host 分派）", edge.port);
    }
    if let Some(gw_cfg) = cfg.ai_gateway.clone() {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, gw_cfg.port).parse()?;
        let gw = crate::ai_gateway::Gateway::new(gw_cfg, &state_root)?;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        serve!(listener, crate::ai_gateway::router(gw));
        tracing::info!("AI Gateway：http://{addr}/<gateway>/<provider>/...");
    }

    if let Some(s3_cfg) = cfg.s3.clone() {
        let addr: SocketAddr = format!("{}:{}", cfg.bind, s3_cfg.port).parse()?;
        let all: Vec<Arc<Slot>> = apps.iter().map(|(a, _)| a.clone()).collect();
        let s3 = crate::s3::S3::new(s3_cfg, all);
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        serve!(listener, crate::s3::router(s3));
        tracing::info!("R2 的 S3 API：http://{addr}（path-style）");
    }

    let draining = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(admin_cfg) = cfg.admin.clone() {
        let addr: SocketAddr = format!("{}:{}", admin_cfg.bind, admin_cfg.port).parse()?;
        let deployer = Arc::new(crate::deploy::Deployer {
            ctx: ctx.clone(),
            slots: apps.iter().map(|(a, _)| (a.name.clone(), a.clone())).collect(),
            queues: queues.clone(),
            grace: Duration::from_secs(cfg.shutdown_timeout),
        });
        let admin = Arc::new(crate::admin::Admin {
            apps: apps.iter().map(|(a, _)| (a.name.clone(), a.clone())).collect(),
            queues: queues.clone(),
            token: admin_cfg.token.clone(),
            draining: draining.clone(),
            deployer,
        });
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("無法監聽 {addr}"))?;
        // 管理埠不掛 shutdown：關閉期間 /health 回 503，負載平衡器才知道要把流量移走
        tokio::spawn(async move { axum::serve(listener, crate::admin::router(admin)).await });
        tracing::info!("管理埠：http://{addr}（/health、/metrics、/apps/<應用>/tail）");
    }

    wait_for_signal().await;
    tracing::info!("收到結束訊號：停止接受新請求，最多等 {} 秒讓進行中的請求做完", cfg.shutdown_timeout);
    draining.store(true, std::sync::atomic::Ordering::Relaxed);
    shutdown.cancel();
    let drained = tokio::time::timeout(Duration::from_secs(cfg.shutdown_timeout), futures_util::future::join_all(servers)).await;
    if drained.is_err() {
        tracing::warn!("還有請求沒做完，強制結束");
    }
    for (slot, _) in &apps {
        slot.background.lock().unwrap().cancel();
        if let Some(pool) = &slot.get().pool {
            pool.stop();
        }
        slot.shared.logs.flush();
    }
    // 讓 Worker 程序有時間收到 kill
    tokio::time::sleep(Duration::from_millis(200)).await;
    tracing::info!("已結束");
    Ok(())
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(t) => t,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Cron Triggers：5 欄位的 cron（UTC），到時間呼叫 scheduled()
pub async fn cron_loop(app: Arc<App>, expr: String) {
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
pub async fn alarm_loop(app: Arc<App>) {
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

pub async fn purge_loop(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        let kv = app.kv.clone();
        let _ = tokio::task::spawn_blocking(move || kv.purge_expired()).await;
    }
}

/// 開發模式：Worker 程式碼（main 所在資料夾）有變動就重開程序
pub async fn watch_loop(app: Arc<App>) {
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
