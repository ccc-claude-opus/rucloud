//! 管理埠（預設只聽 127.0.0.1）：
//!   GET /                       管理介面（網頁）
//!   GET /stats                  各應用的狀態與計數（JSON，管理介面用）
//!   GET /queues                 各佇列的訊息數
//!   GET /health                 健康檢查（關閉中回 503）
//!   GET /metrics                Prometheus 格式的計數
//!   GET /apps                   應用列表
//!   GET /apps/<應用>/logs?n=100  最近的 log（JSON）
//!   GET /apps/<應用>/tail?n=20   即時 log（SSE），`rucloud tail` 用的
//!   GET  /apps/<應用>/versions                版本列表
//!   POST /apps/<應用>/versions?message=…      上傳新版本（tar.gz）並啟用；?activate=false 只上傳
//!   POST /apps/<應用>/versions/<id>/activate  切換到某個版本（rollback 也是用這個）
//!   POST /apps/<應用>/rollback                回到上一個版本
//!   POST /apps/<應用>/reload                  重新載入目前的版本（改了設定、密鑰之後）
//!   POST /analytics/sql                       Analytics Engine 的 SQL 查詢（body 是 SQL）
//!   POST /queues/<佇列>/messages              送訊息 {body, contentType?, delaySeconds?}
//!   POST /queues/<佇列>/messages/pull         HTTP pull consumer 取訊息 {batch_size, visibility_timeout_ms}
//!   POST /queues/<佇列>/messages/ack          {acks: [{lease_id}], retries: [{lease_id, delay_seconds}]}
//! 有設定 token 時 /apps/* 要帶 `Authorization: Bearer <token>` 或 `?token=`。

use crate::queues::Queues;
use axum::Router;
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Admin {
    pub apps: BTreeMap<String, Arc<crate::app::Slot>>,
    pub queues: Arc<Queues>,
    pub token: Option<String>,
    pub draining: Arc<AtomicBool>,
    pub deployer: Arc<crate::deploy::Deployer>,
    pub analytics: Arc<crate::analytics::Analytics>,
}

type S = State<Arc<Admin>>;

pub fn router(admin: Arc<Admin>) -> Router {
    let protected = Router::new()
        .route("/apps", get(apps))
        .route("/apps/{app}/logs", get(logs))
        .route("/apps/{app}/tail", get(tail))
        .route("/apps/{app}/versions", get(versions).post(upload))
        .route("/apps/{app}/versions/{id}/activate", post(activate))
        .route("/apps/{app}/rollback", post(rollback))
        .route("/apps/{app}/reload", post(reload))
        .route("/apps/{app}/cache/purge", post(purge))
        .route("/stats", get(stats))
        .route("/queues", get(queues))
        .route("/analytics/sql", post(analytics_sql))
        .route("/queues/{queue}/messages", post(queue_send))
        .route("/queues/{queue}/messages/pull", post(queue_pull))
        .route("/queues/{queue}/messages/ack", post(queue_ack))
        .layer(axum::extract::DefaultBodyLimit::max(crate::deploy::MAX_UPLOAD))
        .layer(middleware::from_fn_with_state(admin.clone(), auth));
    Router::new()
        .route("/", get(dashboard))
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .merge(protected)
        .with_state(admin)
}

async fn auth(State(admin): S, req: Request, next: Next) -> Response {
    if let Some(want) = &admin.token {
        let bearer = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        let query = req.uri().query().unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("token="));
        if bearer.or(query) != Some(want.as_str()) {
            return (StatusCode::UNAUTHORIZED, "需要管理 token\n").into_response();
        }
    }
    next.run(req).await
}

async fn health(State(admin): S) -> Response {
    let apps: BTreeMap<&str, serde_json::Value> = admin
        .apps
        .iter()
        .map(|(name, slot)| {
            let a = slot.get();
            let workers = a.pool.as_ref().map(|p| json!({ "ready": p.ready_count(), "total": p.len() }));
            (name.as_str(), json!({ "workers": workers }))
        })
        .collect();
    if admin.draining.load(Ordering::Relaxed) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "status": "draining", "apps": apps })),
        )
            .into_response();
    }
    axum::Json(json!({ "status": "ok", "apps": apps })).into_response()
}

async fn metrics(State(admin): S) -> Response {
    let mut out = String::from(crate::observe::METRIC_HELP);
    for (name, slot) in &admin.apps {
        let a = slot.get();
        slot.shared
            .metrics
            .render(name, a.pool.as_ref().map(|p| p.restarts()).unwrap_or(0), &mut out);
        let c = &slot.shared.cache;
        if let Some(e) = &c.edge {
            out.push_str(&format!(
                "rucloud_cache_hits_total{{app=\"{name}\"}} {}\n",
                c.hits.load(Ordering::Relaxed)
            ));
            out.push_str(&format!(
                "rucloud_cache_misses_total{{app=\"{name}\"}} {}\n",
                c.misses.load(Ordering::Relaxed)
            ));
            out.push_str(&format!("rucloud_cache_bytes{{app=\"{name}\",cache=\"edge\"}} {}\n", e.stats().1));
        }
        out.push_str(&format!(
            "rucloud_cache_bytes{{app=\"{name}\",cache=\"api\"}} {}\n",
            c.api.stats().1
        ));
    }
    out.push_str("# HELP rucloud_queue_messages 佇列裡的訊息數\n# TYPE rucloud_queue_messages gauge\n");
    let q = admin.queues.clone();
    for (queue, n) in tokio::task::spawn_blocking(move || q.depth()).await.unwrap_or_default() {
        out.push_str(&format!("rucloud_queue_messages{{queue=\"{}\"}} {n}\n", queue.replace('"', "")));
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], out).into_response()
}

async fn apps(State(admin): S) -> axum::Json<serde_json::Value> {
    axum::Json(json!(
        admin
            .apps
            .iter()
            .map(|(n, slot)| {
                let a = slot.get();
                json!({
                    "name": n,
                    "dir": a.dir,
                    "instances": a.pool.as_ref().map(|p| p.len()),
                    "version": crate::deploy::manifest(&admin.deployer.ctx, n).current,
                })
            })
            .collect::<Vec<_>>()
    ))
}

#[derive(Deserialize)]
struct LogQuery {
    n: Option<usize>,
}

fn not_found(app: &str) -> Response {
    (StatusCode::NOT_FOUND, format!("找不到應用 {app}\n")).into_response()
}

async fn logs(State(admin): S, Path(app): Path<String>, Query(q): Query<LogQuery>) -> Response {
    match admin.apps.get(&app) {
        Some(a) => axum::Json(a.shared.logs.recent(q.n.unwrap_or(100))).into_response(),
        None => not_found(&app),
    }
}

async fn tail(State(admin): S, Path(app): Path<String>, Query(q): Query<LogQuery>) -> Response {
    let Some(a) = admin.apps.get(&app).cloned() else {
        return not_found(&app);
    };
    // 先訂閱再取最近的紀錄，中間進來的不會漏掉（頂多重複一筆）
    let rx = a.shared.logs.subscribe();
    let recent = a.shared.logs.recent(q.n.unwrap_or(20));
    let head = futures_util::stream::iter(
        recent
            .into_iter()
            .map(|v| Ok::<_, std::convert::Infallible>(Event::default().data(v.to_string()))),
    );
    let live = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(v) => return Some((Ok(Event::default().data(v.to_string())), rx)),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    });
    use futures_util::StreamExt;
    Sse::new(head.chain(live)).keep_alive(KeepAlive::default()).into_response()
}

// ---------- 部署 ----------

fn fail(e: anyhow::Error) -> Response {
    (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": format!("{e:#}") }))).into_response()
}

async fn versions(State(admin): S, Path(app): Path<String>) -> Response {
    if !admin.apps.contains_key(&app) {
        return not_found(&app);
    }
    let m = crate::deploy::manifest(&admin.deployer.ctx, &app);
    axum::Json(json!({ "current": m.current, "versions": m.versions })).into_response()
}

#[derive(Deserialize)]
struct UploadQuery {
    message: Option<String>,
    activate: Option<bool>,
}

async fn upload(State(admin): S, Path(app): Path<String>, Query(q): Query<UploadQuery>, body: axum::body::Bytes) -> Response {
    if !admin.apps.contains_key(&app) {
        return not_found(&app);
    }
    let (d, a2, msg) = (admin.deployer.clone(), app.clone(), q.message.unwrap_or_default());
    let v = match tokio::task::spawn_blocking(move || d.store(&a2, &body, &msg)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return fail(e),
        Err(e) => return fail(anyhow::anyhow!(e)),
    };
    if q.activate.unwrap_or(true)
        && let Err(e) = admin.deployer.activate(&app, Some(&v.id)).await
    {
        return fail(e.context(format!("版本 {} 已上傳但啟用失敗，目前版本沒有變", v.id)));
    }
    axum::Json(json!({ "version": v, "active": q.activate.unwrap_or(true) })).into_response()
}

async fn activate(State(admin): S, Path((app, id)): Path<(String, String)>) -> Response {
    let target = if id == "path" { None } else { Some(id.as_str()) };
    match admin.deployer.activate(&app, target).await {
        Ok(()) => axum::Json(json!({ "current": target })).into_response(),
        Err(e) => fail(e),
    }
}

async fn rollback(State(admin): S, Path(app): Path<String>) -> Response {
    match admin.deployer.rollback(&app).await {
        Ok(to) => axum::Json(json!({ "current": to })).into_response(),
        Err(e) => fail(e),
    }
}

async fn reload(State(admin): S, Path(app): Path<String>) -> Response {
    match admin.deployer.reload(&app).await {
        Ok(()) => axum::Json(json!({ "reloaded": app })).into_response(),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct PurgeQuery {
    prefix: Option<String>,
}

/// 清閘道快取：prefix 是「主機 + 路徑」的開頭，例如 example.com/blog/；不給就全部清
async fn purge(State(admin): S, Path(app): Path<String>, Query(q): Query<PurgeQuery>) -> Response {
    let Some(slot) = admin.apps.get(&app) else { return not_found(&app) };
    let n = slot
        .shared
        .cache
        .edge
        .as_ref()
        .map(|e| e.purge(q.prefix.as_deref().unwrap_or("")))
        .unwrap_or(0);
    axum::Json(json!({ "purged": n })).into_response()
}

// ---------- Analytics Engine、Queues ----------

async fn analytics_sql(State(admin): S, sql: String) -> Response {
    let a = admin.analytics.clone();
    match tokio::task::spawn_blocking(move || a.query(&sql)).await {
        Ok(Ok(v)) => axum::Json(v).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

async fn queue_send(State(admin): S, Path(queue): Path<String>, axum::Json(body): axum::Json<serde_json::Value>) -> Response {
    let ct = body["contentType"].as_str().unwrap_or("json").to_string();
    let text = match (&ct[..], &body["body"]) {
        ("json", v) => v.to_string(),
        (_, serde_json::Value::String(s)) => s.clone(),
        (_, v) => v.to_string(),
    };
    let msg = json!({ "body": text, "contentType": ct, "delaySeconds": body["delaySeconds"] });
    let q = admin.queues.clone();
    match tokio::task::spawn_blocking(move || q.send(&queue, &[msg])).await {
        Ok(Ok(_)) => axum::Json(json!({ "success": true })).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

async fn queue_pull(State(admin): S, Path(queue): Path<String>, body: axum::body::Bytes) -> Response {
    let b: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let n = b["batch_size"].as_u64().unwrap_or(5).clamp(1, 100) as usize;
    let vis = b["visibility_timeout_ms"].as_i64().unwrap_or(30_000).clamp(0, 12 * 3600 * 1000);
    let q = admin.queues.clone();
    match tokio::task::spawn_blocking(move || q.pull(&queue, n, vis)).await {
        Ok(Ok(messages)) => axum::Json(json!({ "messages": messages })).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

async fn queue_ack(State(admin): S, Path(_queue): Path<String>, axum::Json(b): axum::Json<serde_json::Value>) -> Response {
    let acks: Vec<String> = b["acks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["lease_id"].as_str().map(String::from))
        .collect();
    let retries: Vec<(String, i64)> = b["retries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| Some((r["lease_id"].as_str()?.to_string(), r["delay_seconds"].as_i64().unwrap_or(0))))
        .collect();
    let q = admin.queues.clone();
    match tokio::task::spawn_blocking(move || q.ack_pulled(&acks, &retries)).await {
        Ok(Ok((a, r))) => axum::Json(json!({ "ackCount": a, "retryCount": r })).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

// ---------- 管理介面 ----------

const DASHBOARD: &str = include_str!("dashboard.html");

async fn dashboard() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        DASHBOARD,
    )
        .into_response()
}

async fn stats(State(admin): S) -> Response {
    let apps: Vec<serde_json::Value> = admin
        .apps
        .iter()
        .map(|(name, slot)| {
            let a = slot.get();
            let c = &slot.shared.cache;
            let mut m = slot.shared.metrics.snapshot();
            m["name"] = json!(name);
            m["dir"] = json!(a.dir);
            m["version"] = json!(crate::deploy::manifest(&admin.deployer.ctx, name).current);
            m["workers"] = json!(
                a.pool
                    .as_ref()
                    .map(|p| json!({ "ready": p.ready_count(), "total": p.len(), "restarts": p.restarts() }))
            );
            m["cache"] = json!({
                "enabled": c.edge.is_some(),
                "hits": c.hits.load(Ordering::Relaxed),
                "misses": c.misses.load(Ordering::Relaxed),
                "bytes": c.edge.as_ref().map(|e| e.stats().1).unwrap_or(0),
                "api_bytes": c.api.stats().1,
            });
            m["bindings_config"] = json!({
                "d1": a.cfg.d1_databases.iter().map(|d| &d.binding).collect::<Vec<_>>(),
                "kv": a.cfg.kv_namespaces.iter().map(|k| &k.binding).collect::<Vec<_>>(),
                "r2": a.cfg.r2_buckets.iter().map(|r| &r.binding).collect::<Vec<_>>(),
                "durable_objects": a.cfg.durable_objects.bindings.iter().map(|d| &d.name).collect::<Vec<_>>(),
                "queues": a.cfg.queues.producers.iter().map(|q| &q.queue).collect::<Vec<_>>(),
                "workflows": a.cfg.workflows.iter().map(|w| &w.name).collect::<Vec<_>>(),
                "crons": a.cfg.triggers.crons,
            });
            m
        })
        .collect();
    axum::Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "draining": admin.draining.load(Ordering::Relaxed),
        "token_required": admin.token.is_some(),
        "apps": apps,
    }))
    .into_response()
}

async fn queues(State(admin): S) -> Response {
    let q = admin.queues.clone();
    let depth = tokio::task::spawn_blocking(move || q.depth()).await.unwrap_or_default();
    axum::Json(json!(
        depth
            .into_iter()
            .map(|(q, n)| json!({ "queue": q, "messages": n }))
            .collect::<Vec<_>>()
    ))
    .into_response()
}
