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
//!   GET  /apps/<應用>/grants                  安裝的應用的權限（[install]）
//!   PUT  /apps/<應用>/grants                  改權限 {services: [{binding, service, props}], network}，然後重新載入
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
    pub apps: Arc<crate::registry::Registry>,
    pub queues: Arc<Queues>,
    pub token: Option<String>,
    /// [dynamic] 的 token：只能新增、更新、刪除、查看 prefix 開頭的應用
    pub dynamic_token: Option<String>,
    pub dynamic_prefix: Option<String>,
    /// [install] 的 token：只能安裝、更新、移除安裝的應用，改它們的權限
    pub install_token: Option<String>,
    pub draining: Arc<AtomicBool>,
    pub deployer: Arc<crate::deploy::Deployer>,
    pub analytics: Arc<crate::analytics::Analytics>,
    pub mailer: Arc<crate::email::Mailer>,
    pub ai: Arc<crate::ai::Ai>,
}

type S = State<Arc<Admin>>;

pub fn router(admin: Arc<Admin>) -> Router {
    let protected = Router::new()
        .route("/apps", get(apps))
        .route("/apps/{app}", axum::routing::put(put_app).delete(delete_app))
        .route("/apps/{app}/secrets", get(list_secrets))
        .route("/apps/{app}/secrets/{name}", axum::routing::put(put_secret).delete(delete_secret))
        .route("/apps/{app}/logs", get(logs))
        .route("/apps/{app}/tail", get(tail))
        .route("/apps/{app}/versions", get(versions).post(upload))
        .route("/apps/{app}/versions/{id}/activate", post(activate))
        .route("/apps/{app}/rollback", post(rollback))
        .route("/apps/{app}/grants", get(get_grants).put(put_grants))
        .route("/apps/{app}/reload", post(reload))
        .route("/apps/{app}/cache/purge", post(purge))
        .route("/stats", get(stats))
        .route("/email", get(get_email).put(put_email).delete(delete_email))
        .route("/email/test", post(test_email))
        .route("/ai", get(get_ai).put(put_ai).delete(delete_ai))
        .route("/ai/test", post(test_ai))
        .route("/ai/usage", get(ai_usage))
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
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let query = req.uri().query().unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("token="));
    let given = bearer.or(query);
    if given.is_some() && given == admin.install_token.as_deref() {
        if install_scope(&admin, req.method(), req.uri().path()) {
            let mut req = req;
            req.extensions_mut().insert(InstallScope);
            return next.run(req).await;
        }
        return (StatusCode::FORBIDDEN, "這個 token 只能管理安裝的應用\n").into_response();
    }
    if given.is_some() && given == admin.dynamic_token.as_deref() {
        if dynamic_scope(&admin, req.method(), req.uri().path()) {
            let mut req = req;
            req.extensions_mut().insert(DynamicScope);
            return next.run(req).await;
        }
        return (StatusCode::FORBIDDEN, "這個 token 只能管理執行中新增的應用\n").into_response();
    }
    if let Some(want) = &admin.token
        && given != Some(want.as_str())
    {
        return (StatusCode::UNAUTHORIZED, "需要管理 token\n").into_response();
    }
    next.run(req).await
}

/// 標記：這個請求用的是 [dynamic] 的 token
#[derive(Clone, Copy)]
struct DynamicScope;

/// 標記：這個請求用的是 [install] 的 token
#[derive(Clone, Copy)]
struct InstallScope;

/// [install] 的 token 能做的事：GET /apps（清單）；PUT /apps/<名稱>（安裝或更新，名稱沒被用掉或是安裝的應用）；
/// 安裝的應用的 DELETE、GET logs / versions / grants、PUT grants、POST rollback、PUT secrets/<名稱>
fn install_scope(admin: &Admin, method: &axum::http::Method, path: &str) -> bool {
    use axum::http::Method;
    // 寄信與 AI 的設定（不含密碼、金鑰）：安裝程式用來說明 email、ai 權限
    if path == "/apps" || path == "/email" || path == "/ai" {
        return *method == Method::GET;
    }
    let Some(rest) = path.strip_prefix("/apps/") else { return false };
    let mut it = rest.split('/');
    let name = it.next().unwrap_or("");
    let installed = admin.apps.kind(name) == crate::registry::Kind::Installed && admin.apps.get(name).is_some();
    let free = admin.apps.get(name).is_none();
    match (it.next(), it.next()) {
        (None, _) => (*method == Method::PUT && (installed || free)) || (*method == Method::DELETE && installed),
        (Some("logs" | "versions"), None) => installed && *method == Method::GET,
        (Some("grants"), None) => installed && (*method == Method::GET || *method == Method::PUT),
        (Some("rollback"), None) => installed && *method == Method::POST,
        // 套件宣告的密鑰（例如登入用的簽章金鑰）由安裝程式產生
        (Some("secrets"), Some(_)) => installed && *method == Method::PUT,
        _ => false,
    }
}

/// [dynamic] 的 token 能做的事：PUT / DELETE /apps/<名稱>，GET /apps/<名稱>/logs、versions（名稱以 prefix 開頭）
fn dynamic_scope(admin: &Admin, method: &axum::http::Method, path: &str) -> bool {
    use axum::http::Method;
    let Some(prefix) = &admin.dynamic_prefix else { return false };
    let Some(rest) = path.strip_prefix("/apps/") else { return false };
    let mut it = rest.split('/');
    let name = it.next().unwrap_or("");
    if !name.starts_with(prefix.as_str()) {
        return false;
    }
    match (it.next(), it.next()) {
        (None, _) => *method == Method::PUT || *method == Method::DELETE,
        (Some("logs" | "versions"), None) => *method == Method::GET,
        _ => false,
    }
}

async fn health(State(admin): S) -> Response {
    let apps: BTreeMap<String, serde_json::Value> = admin
        .apps
        .all()
        .into_iter()
        .map(|(name, slot)| {
            let a = slot.get();
            let workers = a.pool.as_ref().map(|p| json!({ "ready": p.ready_count(), "total": p.len() }));
            (name, json!({ "workers": workers }))
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
    for (name, slot) in &admin.apps.all() {
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
            .all()
            .iter()
            .map(|(n, slot)| {
                let a = slot.get();
                json!({
                    "name": n,
                    "dynamic": admin.apps.is_dynamic(n),
                    "kind": format!("{:?}", admin.apps.kind(n)).to_lowercase(),
                    "hosts": admin.apps.hosts_of(n),
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
    let Some(a) = admin.apps.get(&app) else {
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
    if admin.apps.get(&app).is_none() {
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
    if admin.apps.get(&app).is_none() {
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

/// 新增應用或部署新版本：body 是 tar.gz。
/// 完整的管理 token：應用不存在就新增（rucloud deploy）；[dynamic] 的 token：只能管 prefix 開頭、有限制的應用
async fn put_app(
    State(admin): S,
    Path(app): Path<String>,
    Query(q): Query<UploadQuery>,
    scope: Option<axum::Extension<DynamicScope>>,
    install: Option<axum::Extension<InstallScope>>,
    body: axum::body::Bytes,
) -> Response {
    let msg = q.message.unwrap_or_default();
    let result = if install.is_some() {
        admin.deployer.put_installed(&app, body.to_vec(), msg).await
    } else if scope.is_some() {
        admin.deployer.put_dynamic(&app, body.to_vec(), msg).await
    } else {
        admin.deployer.put_app(&app, body.to_vec(), msg).await
    };
    match result {
        Ok((v, created)) => {
            let status = if created { StatusCode::CREATED } else { StatusCode::OK };
            let hosts = admin.apps.hosts_of(&app);
            (
                status,
                axum::Json(json!({ "app": app, "created": created, "version": v, "hosts": hosts })),
            )
                .into_response()
        }
        Err(e) => fail(e),
    }
}

// ---------- 密鑰 ----------

async fn list_secrets(State(admin): S, Path(app): Path<String>) -> Response {
    if admin.apps.get(&app).is_none() {
        return not_found(&app);
    }
    let names: Vec<String> = crate::secrets::load(&admin.deployer.ctx.state_root, &app).into_keys().collect();
    axum::Json(json!({ "secrets": names })).into_response()
}

/// 設定密鑰後重新載入應用（新的 Worker 程序起來才換掉舊的）
async fn put_secret(State(admin): S, Path((app, name)): Path<(String, String)>, body: String) -> Response {
    if admin.apps.get(&app).is_none() {
        return not_found(&app);
    }
    if let Err(e) = crate::secrets::put(&admin.deployer.ctx.state_root, &app, &name, &body) {
        return fail(e);
    }
    match admin.deployer.reload(&app).await {
        Ok(()) => axum::Json(json!({ "app": app, "secret": name })).into_response(),
        Err(e) => fail(e.context("密鑰已存，但重新載入失敗")),
    }
}

async fn delete_secret(State(admin): S, Path((app, name)): Path<(String, String)>) -> Response {
    if admin.apps.get(&app).is_none() {
        return not_found(&app);
    }
    match crate::secrets::delete(&admin.deployer.ctx.state_root, &app, &name) {
        Ok(false) => (StatusCode::NOT_FOUND, axum::Json(json!({ "error": format!("沒有密鑰 {name}") }))).into_response(),
        Ok(true) => match admin.deployer.reload(&app).await {
            Ok(()) => axum::Json(json!({ "app": app, "deleted": name })).into_response(),
            Err(e) => fail(e.context("密鑰已刪，但重新載入失敗")),
        },
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct DeleteQuery {
    purge: Option<bool>,
}

async fn delete_app(State(admin): S, Path(app): Path<String>, Query(q): Query<DeleteQuery>) -> Response {
    let purge = q.purge.unwrap_or(false);
    match admin.deployer.delete_app(&app, purge).await {
        Ok(()) => axum::Json(json!({ "deleted": app, "purged": purge })).into_response(),
        Err(e) => fail(e),
    }
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

async fn get_grants(State(admin): S, Path(app): Path<String>) -> Response {
    if admin.apps.kind(&app) != crate::registry::Kind::Installed {
        return fail(anyhow::anyhow!("{app} 不是安裝的應用"));
    }
    axum::Json(crate::deploy::load_grants(&admin.deployer.ctx.state_root, &app)).into_response()
}

async fn put_grants(State(admin): S, Path(app): Path<String>, axum::Json(g): axum::Json<crate::config::Grants>) -> Response {
    match admin.deployer.set_grants(&app, g).await {
        Ok(()) => axum::Json(crate::deploy::load_grants(&admin.deployer.ctx.state_root, &app)).into_response(),
        Err(e) => fail(e),
    }
}

// ---------- 寄信設定（send_email 綁定用的 SMTP） ----------

async fn get_email(State(admin): S) -> Response {
    axum::Json(admin.mailer.describe()).into_response()
}

async fn put_email(State(admin): S, axum::Json(cfg): axum::Json<crate::email::EmailCfg>) -> Response {
    match admin.mailer.set(cfg) {
        Ok(()) => axum::Json(admin.mailer.describe()).into_response(),
        Err(e) => fail(e),
    }
}

async fn delete_email(State(admin): S) -> Response {
    match admin.mailer.clear() {
        Ok(()) => axum::Json(admin.mailer.describe()).into_response(),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct TestEmail {
    to: String,
}

/// 寄一封測試信給驗證過的收件地址
async fn test_email(State(admin): S, axum::Json(t): axum::Json<TestEmail>) -> Response {
    let from = admin.mailer.describe()["from"].as_str().unwrap_or_default().to_string();
    let raw = format!(
        "From: rucloud <{from}>\r\nTo: <{}>\r\nSubject: rucloud test\r\nDate: {}\r\nMessage-ID: <{:032x}@rucloud>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n這是 rucloud 的測試信，寄信的設定可以用。\r\n",
        t.to,
        chrono::Utc::now().to_rfc2822(),
        rand::random::<u128>()
    );
    match admin.mailer.send(None, &from, std::slice::from_ref(&t.to), raw.as_bytes()).await {
        Ok(()) => axum::Json(json!({ "ok": true })).into_response(),
        Err(e) => fail(e),
    }
}

// ---------- Workers AI 的後端與用量 ----------

async fn get_ai(State(admin): S) -> Response {
    axum::Json(admin.ai.describe()).into_response()
}

async fn put_ai(State(admin): S, axum::Json(cfg): axum::Json<crate::ai::AiBackend>) -> Response {
    match admin.ai.set(cfg) {
        Ok(()) => axum::Json(admin.ai.describe()).into_response(),
        Err(e) => fail(e),
    }
}

async fn delete_ai(State(admin): S) -> Response {
    admin.ai.clear();
    axum::Json(admin.ai.describe()).into_response()
}

/// 用設定的後端問一句話（記在 "(test)" 的用量裡）
async fn test_ai(State(admin): S) -> Response {
    let http = reqwest::Client::new();
    let inputs = json!({ "prompt": "Reply with the single word OK.", "max_tokens": 10 });
    match crate::ai::run(&admin.ai, &http, "(test)", "@cf/meta/llama-3.1-8b-instruct", &inputs).await {
        Ok(v) => axum::Json(json!({ "ok": true, "response": v["response"] })).into_response(),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct UsageQuery {
    days: Option<u32>,
}

async fn ai_usage(State(admin): S, axum::extract::Query(q): axum::extract::Query<UsageQuery>) -> Response {
    match admin.ai.usage(q.days.unwrap_or(30).clamp(1, 366)) {
        Ok(rows) => axum::Json(json!({ "usage": rows })).into_response(),
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
        .all()
        .iter()
        .map(|(name, slot)| {
            let a = slot.get();
            let c = &slot.shared.cache;
            let mut m = slot.shared.metrics.snapshot();
            m["name"] = json!(name);
            m["dir"] = json!(a.dir);
            m["version"] = json!(crate::deploy::manifest(&admin.deployer.ctx, name).current);
            m["hosts"] = json!(admin.apps.hosts_of(name));
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
