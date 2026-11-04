//! 邊緣閘道：每個請求先看靜態檔案，再轉給 Worker 程序（串流進、串流出）。

use crate::app::App;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode, header};
use axum::response::IntoResponse;
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub async fn app_handler(
    State(slot): State<Arc<crate::app::Slot>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response<Body> {
    handle(&slot.get(), req, peer).await
}

/// 共用入口：依 Host 找應用
pub async fn edge_handler(
    State(routes): State<Arc<HashMap<String, Arc<crate::app::Slot>>>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response<Body> {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let host = host
        .rsplit_once(':')
        .filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
        .map(|(h, _)| h)
        .unwrap_or(host);
    let app = routes.get(host).or_else(|| routes.get(host.split('.').next().unwrap_or("")));
    match app {
        Some(slot) => handle(&slot.get(), req, peer).await,
        None => (StatusCode::NOT_FOUND, format!("rucloud：沒有應用對應到主機 {host}\n")).into_response(),
    }
}

pub async fn handle(app: &Arc<App>, req: Request, peer: SocketAddr) -> Response<Body> {
    use std::sync::atomic::Ordering;
    let start = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    app.metrics.inflight.fetch_add(1, Ordering::Relaxed);
    let resp = route(app, req, peer).await;
    app.metrics.inflight.fetch_sub(1, Ordering::Relaxed);
    let secs = start.elapsed().as_secs_f64();
    let kind = if resp.extensions().get::<crate::assets::AssetHit>().is_some() {
        "asset"
    } else {
        "worker"
    };
    app.metrics.request(kind, resp.status().as_u16(), secs);
    let line = format!("{method} {path} {} {:.1}ms", resp.status().as_u16(), secs * 1000.0);
    tracing::info!("[{}] {line}", app.name);
    app.logs.push("request", &line, false);
    resp
}

async fn route(app: &Arc<App>, req: Request, peer: SocketAddr) -> Response<Body> {
    let path = req.uri().path().to_string();
    if path.starts_with("/__rucloud") {
        return StatusCode::NOT_FOUND.into_response();
    }
    // 開發模式：手動觸發排程，和 wrangler dev --test-scheduled 一樣
    if app.dev && path == "/__scheduled" {
        let cron = req.uri().query().and_then(|q| {
            q.split('&').find_map(|kv| kv.strip_prefix("cron=")).map(|c| {
                urlencoding::decode(&c.replace('+', " "))
                    .map(|s| s.into_owned())
                    .unwrap_or_default()
            })
        });
        let body = serde_json::json!({ "cron": cron.unwrap_or_default(), "scheduledTime": chrono::Utc::now().timestamp_millis() });
        return match invoke(app, "scheduled", &body).await {
            Ok(_) => "Ran scheduled event\n".into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}\n")).into_response(),
        };
    }
    if let Some(assets) = &app.assets
        && (app.pool.is_none() || !assets.worker_first(&path))
    {
        if assets.resolve(&path).is_some()
            && let Some(r) = assets.serve(req.method(), &path, req.headers()).await
        {
            return r;
        }
        // 沒有 Worker，或是 SPA 的導覽請求：交給 not_found_handling
        if app.pool.is_none()
            || assets
                .not_found_file(&path, req.headers())
                .is_some_and(|(_, s)| s == StatusCode::OK)
        {
            return match assets.serve(req.method(), &path, req.headers()).await {
                Some(r) => r,
                None => StatusCode::NOT_FOUND.into_response(),
            };
        }
    }
    if app.pool.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let scheme = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http")
        .to_string();
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    let url = format!("{scheme}://{host}{}", req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/"));
    let mut extra = vec![
        ("x-rucloud-url", url),
        ("cf-connecting-ip", peer.ip().to_string()),
        ("x-real-ip", peer.ip().to_string()),
    ];
    if !req.headers().contains_key("x-forwarded-for") {
        extra.push(("x-forwarded-for", peer.ip().to_string()));
    }
    match forward(app, None, req, &extra, true).await {
        Ok(r) => r,
        Err(e) => (StatusCode::BAD_GATEWAY, format!("rucloud：Worker 沒有回應：{e:#}\n")).into_response(),
    }
}

/// 把請求轉給某個 Worker 程序。外來的 x-rucloud-* 標頭一律拿掉，避免偽造內部呼叫。
/// external = true：來自外部使用者（計入 WebSocket 連線數）；false：內部轉送（DO、service）
pub async fn forward(
    app: &App,
    affinity: Option<usize>,
    req: Request,
    extra: &[(&str, String)],
    external: bool,
) -> anyhow::Result<Response<Body>> {
    let pool = app.pool.as_ref().ok_or_else(|| anyhow::anyhow!("{} 沒有 Worker", app.name))?;
    let port = pool.port(affinity).await?;
    let mut headers = HeaderMap::new();
    for (k, v) in req.headers().iter() {
        let name = k.as_str();
        if HOP_BY_HOP.contains(&name) || name == "host" || name.starts_with("x-rucloud-") {
            continue;
        }
        headers.append(k.clone(), v.clone());
    }
    for (k, v) in extra {
        if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            headers.insert(n, v);
        }
    }
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    if crate::ws::is_upgrade(req.headers()) {
        return crate::ws::tunnel(req, port, &pq, &headers, external.then(|| app.metrics.clone())).await;
    }
    let (parts, body) = req.into_parts();
    let resp = app
        .http
        .request(parts.method, format!("http://127.0.0.1:{port}{pq}"))
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await?;
    let mut out = Response::builder().status(resp.status());
    for (k, v) in resp.headers() {
        if !HOP_BY_HOP.contains(&k.as_str()) {
            out = out.header(k, v);
        }
    }
    Ok(out.body(Body::from_stream(resp.bytes_stream()))?)
}

/// 內部事件（queue、scheduled、alarm）：POST JSON 給 Worker，取回 JSON。
pub async fn invoke(app: &App, kind: &str, body: &Value) -> anyhow::Result<Value> {
    invoke_on(app, None, kind, body, &[]).await
}

pub async fn invoke_on(app: &App, affinity: Option<usize>, kind: &str, body: &Value, extra: &[(&str, String)]) -> anyhow::Result<Value> {
    let pool = app.pool.as_ref().ok_or_else(|| anyhow::anyhow!("{} 沒有 Worker", app.name))?;
    let port = pool.port(affinity).await?;
    let mut rb = app
        .http
        .post(format!("http://127.0.0.1:{port}/__rucloud/{kind}"))
        .header("x-rucloud-kind", kind)
        .header("x-rucloud-token", &app.token)
        .json(body);
    for (k, v) in extra {
        rb = rb.header(*k, v);
    }
    let resp = rb.send().await?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        anyhow::bail!("{kind} 事件失敗（{status}）：{}", v["error"].as_str().unwrap_or(""));
    }
    Ok(v)
}
