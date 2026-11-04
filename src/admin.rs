//! 管理埠（預設只聽 127.0.0.1）：
//!   GET /health                 健康檢查（關閉中回 503）
//!   GET /metrics                Prometheus 格式的計數
//!   GET /apps                   應用列表
//!   GET /apps/<應用>/logs?n=100  最近的 log（JSON）
//!   GET /apps/<應用>/tail?n=20   即時 log（SSE），`rucloud tail` 用的
//! 有設定 token 時 /apps/* 要帶 `Authorization: Bearer <token>` 或 `?token=`。

use crate::app::App;
use crate::queues::Queues;
use axum::Router;
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Admin {
    pub apps: BTreeMap<String, Arc<App>>,
    pub queues: Arc<Queues>,
    pub token: Option<String>,
    pub draining: Arc<AtomicBool>,
}

type S = State<Arc<Admin>>;

pub fn router(admin: Arc<Admin>) -> Router {
    let protected = Router::new()
        .route("/apps", get(apps))
        .route("/apps/{app}/logs", get(logs))
        .route("/apps/{app}/tail", get(tail))
        .layer(middleware::from_fn_with_state(admin.clone(), auth));
    Router::new()
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
        .map(|(name, a)| {
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
    for (name, a) in &admin.apps {
        a.metrics.render(name, a.pool.as_ref().map(|p| p.restarts()).unwrap_or(0), &mut out);
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
            .map(|(n, a)| json!({ "name": n, "dir": a.dir, "instances": a.pool.as_ref().map(|p| p.len()) }))
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
        Some(a) => axum::Json(a.logs.recent(q.n.unwrap_or(100))).into_response(),
        None => not_found(&app),
    }
}

async fn tail(State(admin): S, Path(app): Path<String>, Query(q): Query<LogQuery>) -> Response {
    let Some(a) = admin.apps.get(&app).cloned() else {
        return not_found(&app);
    };
    // 先訂閱再取最近的紀錄，中間進來的不會漏掉（頂多重複一筆）
    let rx = a.logs.subscribe();
    let recent = a.logs.recent(q.n.unwrap_or(20));
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
