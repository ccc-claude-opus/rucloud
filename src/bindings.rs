//! 綁定 API：只聽 127.0.0.1，給 Worker 程序（Node）呼叫。
//! env.DB / env.KV / env.BUCKET … 在 JS 端都是這裡的薄包裝。每個請求都要帶 x-rucloud-token。

use crate::app::App;
use crate::queues::Queues;
use anyhow::anyhow;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub struct Hub {
    pub apps: HashMap<String, Arc<crate::app::Slot>>,
    pub queues: Arc<Queues>,
}

type S = State<Arc<Hub>>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}

type R<T> = Result<T, ApiError>;

fn not_found(what: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, format!("找不到 {what}"))
}

impl Hub {
    fn app(&self, name: &str) -> R<Arc<App>> {
        self.apps
            .get(name)
            .map(|s| s.get())
            .ok_or_else(|| not_found(&format!("應用 {name}")))
    }
}

/// 在執行緒池跑會阻塞的 SQLite 操作
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> R<T> {
    Ok(tokio::task::spawn_blocking(f).await.map_err(|e| anyhow!(e))??)
}

pub fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/b/{app}/d1/{binding}/{op}", post(d1))
        .route("/b/{app}/kv/{binding}", get(kv_get).put(kv_put).delete(kv_delete))
        .route("/b/{app}/kv/{binding}/list", get(kv_list))
        .route("/b/{app}/r2/{binding}/object", get(r2_get).put(r2_put).delete(r2_delete))
        .route("/b/{app}/r2/{binding}/head", get(r2_head))
        .route("/b/{app}/r2/{binding}/list", get(r2_list))
        .route("/b/{app}/r2/{binding}/delete", post(r2_delete_many))
        .route("/b/{app}/r2/{binding}/mpu/create", post(mpu_create))
        .route("/b/{app}/r2/{binding}/mpu/part", axum::routing::put(mpu_part))
        .route("/b/{app}/r2/{binding}/mpu/complete", post(mpu_complete))
        .route("/b/{app}/r2/{binding}/mpu/abort", post(mpu_abort))
        .route("/b/{app}/queue/{queue}/send", post(queue_send))
        .route("/b/{app}/ratelimit/{binding}", post(ratelimit))
        .route("/b/{app}/do-storage/{ns}/{id}", post(do_storage))
        .route("/b/{app}/do/{ns}/{id}/{op}", any(do_forward))
        .route("/b/{app}/vectorize/{binding}/{op}", post(vectorize))
        .route("/b/{app}/ai/run", post(ai_run))
        .route("/b/{app}/assets", any(assets))
        .route("/b/{app}/cache/{name}", get(cache_get).put(cache_put).delete(cache_delete))
        .route("/b/{app}/service/{binding}", any(service))
        .route("/b/{app}/service/{binding}/rpc", post(service_rpc))
        .route("/b/{app}/workflow/{name}", post(workflow))
        .layer(middleware::from_fn_with_state(hub.clone(), auth))
        .layer(DefaultBodyLimit::disable())
        .with_state(hub)
}

async fn auth(State(hub): S, req: Request, next: Next) -> Response {
    // 路徑是 /b/<應用>/…，token 必須是那個應用的
    let app = req
        .uri()
        .path()
        .strip_prefix("/b/")
        .and_then(|p| p.split('/').next())
        .map(|a| urlencoding::decode(a).map(|s| s.into_owned()).unwrap_or_default());
    let expected = app.and_then(|a| hub.apps.get(&a).map(|a| a.shared.token.clone()));
    if expected.is_none_or(|t| req.headers().get("x-rucloud-token").is_none_or(|h| h.as_bytes() != t.as_bytes())) {
        return ApiError(StatusCode::FORBIDDEN, "token 不對".into()).into_response();
    }
    // /b/<應用>/<種類>/… → 種類（d1、kv、r2…）
    if let Some((app, kind)) = req.uri().path().strip_prefix("/b/").and_then(|p| {
        let mut it = p.split('/');
        Some((it.next()?, it.next()?))
    }) && let Some(a) = hub.apps.get(&urlencoding::decode(app).map(|s| s.into_owned()).unwrap_or_default())
    {
        a.shared.metrics.binding(kind);
    }
    next.run(req).await
}

// ---------- D1 ----------

async fn d1(State(hub): S, Path((app, binding, op)): Path<(String, String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let db = app
        .d1
        .get(&binding)
        .cloned()
        .ok_or_else(|| not_found(&format!("D1 綁定 {binding}")))?;
    let out = blocking(move || -> anyhow::Result<Value> {
        Ok(match op.as_str() {
            "query" => {
                let params: Vec<Value> = serde_json::from_value(body["params"].clone()).unwrap_or_default();
                serde_json::to_value(db.query(body["sql"].as_str().unwrap_or(""), &params)?)?
            }
            "batch" => {
                let stmts: Vec<crate::d1::Stmt> = serde_json::from_value(body["statements"].clone())?;
                serde_json::to_value(db.batch(&stmts)?)?
            }
            "exec" => db.exec(body["sql"].as_str().unwrap_or(""))?,
            _ => anyhow::bail!("不支援的 D1 操作 {op}"),
        })
    })
    .await?;
    Ok(Json(out))
}

// ---------- KV ----------

#[derive(Deserialize)]
struct KvQuery {
    key: Option<String>,
    expiration: Option<i64>,
    expiration_ttl: Option<i64>,
    metadata: Option<String>,
    prefix: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn kv_get(State(hub): S, Path((app, ns)): Path<(String, String)>, Query(q): Query<KvQuery>) -> R<Response> {
    let app = hub.app(&app)?;
    let kv = app.kv.clone();
    let key = q.key.unwrap_or_default();
    let Some(e) = blocking(move || kv.get(&ns, &key)).await? else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let mut h = HeaderMap::new();
    if let Some(m) = e.metadata {
        h.insert("x-kv-metadata", HeaderValue::from_str(&urlencoding::encode(&m)).unwrap());
    }
    if let Some(x) = e.expiration {
        h.insert("x-kv-expiration", HeaderValue::from(x));
    }
    Ok((h, e.value).into_response())
}

async fn kv_put(State(hub): S, Path((app, ns)): Path<(String, String)>, Query(q): Query<KvQuery>, body: Bytes) -> R<StatusCode> {
    let app = hub.app(&app)?;
    let kv = app.kv.clone();
    let key = q.key.filter(|k| !k.is_empty()).ok_or_else(|| anyhow!("KV 的 key 不能是空的"))?;
    if key.len() > 512 {
        return Err(anyhow!("KV 的 key 最長 512 bytes").into());
    }
    let exp = q.expiration.or(q.expiration_ttl.map(|t| crate::kv::now_secs() + t));
    blocking(move || kv.put(&ns, &key, &body, q.metadata.as_deref(), exp)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kv_delete(State(hub): S, Path((app, ns)): Path<(String, String)>, Query(q): Query<KvQuery>) -> R<StatusCode> {
    let app = hub.app(&app)?;
    let kv = app.kv.clone();
    blocking(move || kv.delete(&ns, &q.key.unwrap_or_default())).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kv_list(State(hub): S, Path((app, ns)): Path<(String, String)>, Query(q): Query<KvQuery>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let kv = app.kv.clone();
    Ok(Json(
        blocking(move || kv.list(&ns, q.prefix.as_deref().unwrap_or(""), q.limit.unwrap_or(1000), q.cursor.as_deref())).await?,
    ))
}

// ---------- R2 ----------

#[derive(Deserialize)]
struct R2Query {
    key: Option<String>,
    offset: Option<u64>,
    length: Option<u64>,
    suffix: Option<u64>,
    prefix: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    delimiter: Option<String>,
}

fn bucket(app: &App, binding: &str) -> R<String> {
    app.r2_buckets
        .get(binding)
        .cloned()
        .ok_or_else(|| not_found(&format!("R2 綁定 {binding}")))
}

async fn r2_head(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<R2Query>) -> R<Response> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    Ok(match blocking(move || r2.head(&b, &q.key.unwrap_or_default())).await? {
        Some(o) => Json(o).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn r2_get(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<R2Query>) -> R<Response> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let key = q.key.clone().unwrap_or_default();
    let (b2, k2, r22) = (b.clone(), key.clone(), r2.clone());
    let Some(meta) = blocking(move || r22.head(&b2, &k2)).await? else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let size = meta["size"].as_u64().unwrap_or(0);
    let (offset, length) = match (q.offset, q.length, q.suffix) {
        (_, _, Some(s)) => (size.saturating_sub(s), s.min(size)),
        (o, l, None) => {
            let o = o.unwrap_or(0).min(size);
            (o, l.unwrap_or(size - o).min(size - o))
        }
    };
    let mut f = tokio::fs::File::open(r2.file_path(&b, &key)).await.map_err(|e| anyhow!(e))?;
    f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| anyhow!(e))?;
    let mut h = HeaderMap::new();
    h.insert(
        "x-r2-object",
        HeaderValue::from_str(&urlencoding::encode(&meta.to_string())).unwrap(),
    );
    if offset != 0 || length != size {
        h.insert("x-r2-range", HeaderValue::from_str(&format!("{offset},{length}")).unwrap());
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    Ok((h, Body::from_stream(tokio_util::io::ReaderStream::new(f.take(length)))).into_response())
}

async fn r2_put(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<R2Query>, req: Request) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let key = q.key.filter(|k| !k.is_empty()).ok_or_else(|| anyhow!("R2 的 key 不能是空的"))?;
    let opts: Value = req
        .headers()
        .get("x-r2-put")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok().and_then(|s| serde_json::from_str(&s).ok()))
        .unwrap_or(json!({}));
    // 一邊收一邊寫暫存檔、算 MD5，不把整個物件放進記憶體
    let tmp = r2.tmp_path();
    let got = crate::r2::receive(req.into_body(), false, &tmp).await?;
    let http = if opts["httpMetadata"].is_object() {
        opts["httpMetadata"].clone()
    } else {
        json!({})
    };
    let custom = if opts["customMetadata"].is_object() {
        opts["customMetadata"].clone()
    } else {
        json!({})
    };
    Ok(Json(
        blocking(move || r2.commit(&b, &key, &tmp, got.size, &got.md5, &http, &custom)).await?,
    ))
}

async fn r2_delete(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<R2Query>) -> R<StatusCode> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    blocking(move || r2.delete(&b, &[q.key.unwrap_or_default()])).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn r2_delete_many(State(hub): S, Path((app, binding)): Path<(String, String)>, Json(body): Json<Value>) -> R<StatusCode> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let keys: Vec<String> = serde_json::from_value(body["keys"].clone()).unwrap_or_default();
    blocking(move || r2.delete(&b, &keys)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn r2_list(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<R2Query>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    Ok(Json(
        blocking(move || {
            r2.list(
                &b,
                q.prefix.as_deref().unwrap_or(""),
                q.limit.unwrap_or(1000),
                q.cursor.as_deref(),
                q.delimiter.as_deref(),
            )
        })
        .await?,
    ))
}

// ---------- R2 multipart upload ----------

async fn mpu_create(State(hub): S, Path((app, binding)): Path<(String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let key = body["key"]
        .as_str()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("R2 的 key 不能是空的"))?
        .to_string();
    let http = if body["httpMetadata"].is_object() {
        body["httpMetadata"].clone()
    } else {
        json!({})
    };
    let custom = if body["customMetadata"].is_object() {
        body["customMetadata"].clone()
    } else {
        json!({})
    };
    let id = blocking(move || r2.create_upload(&b, &key, &http, &custom)).await?;
    Ok(Json(json!({ "uploadId": id })))
}

#[derive(Deserialize)]
struct PartQuery {
    #[serde(rename = "uploadId")]
    upload_id: String,
    #[serde(rename = "partNumber")]
    part_number: u32,
}

async fn mpu_part(State(hub): S, Path((app, binding)): Path<(String, String)>, Query(q): Query<PartQuery>, req: Request) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let (r2a, id) = (r2.clone(), q.upload_id.clone());
    match blocking(move || r2a.upload(&id)).await? {
        Some((ub, _)) if ub == b => {}
        _ => return Err(not_found(&format!("multipart upload {}", q.upload_id))),
    }
    let tmp = r2.tmp_path();
    let got = crate::r2::receive(req.into_body(), false, &tmp).await?;
    let etag = got.md5.clone();
    blocking(move || r2.commit_part(&q.upload_id, q.part_number, &tmp, got.size, &got.md5)).await?;
    Ok(Json(json!({ "partNumber": q.part_number, "etag": etag })))
}

async fn mpu_complete(State(hub): S, Path((app, binding)): Path<(String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (_b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let id = body["uploadId"].as_str().unwrap_or_default().to_string();
    let parts: Vec<(u32, String)> = body["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                p["partNumber"].as_u64().unwrap_or(0) as u32,
                p["etag"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    Ok(Json(blocking(move || r2.complete_upload(&id, &parts)).await?))
}

async fn mpu_abort(State(hub): S, Path((app, binding)): Path<(String, String)>, Json(body): Json<Value>) -> R<StatusCode> {
    let app = hub.app(&app)?;
    let (_b, r2) = (bucket(&app, &binding)?, app.r2()?);
    let id = body["uploadId"].as_str().unwrap_or_default().to_string();
    blocking(move || r2.abort_upload(&id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- Queues、Rate limiting ----------

async fn queue_send(State(hub): S, Path((_app, queue)): Path<(String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let queues = hub.queues.clone();
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let n = blocking(move || queues.send(&queue, &msgs)).await?;
    Ok(Json(json!({ "sent": n })))
}

async fn ratelimit(State(hub): S, Path((app, binding)): Path<(String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let key = body["key"].as_str().map(String::from).unwrap_or_else(|| body["key"].to_string());
    let ok = app
        .rate_limit(&binding, &key)
        .ok_or_else(|| not_found(&format!("限流綁定 {binding}")))?;
    Ok(Json(json!({ "success": ok })))
}

// ---------- Durable Objects ----------

async fn do_storage(State(hub): S, Path((app, ns, id)): Path<(String, String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let store = app.durable.clone();
    Ok(Json(blocking(move || store.op(&ns, &id, &body)).await?))
}

/// stub.fetch() / stub.method()：轉給「擁有」這個 id 的 Worker 程序
async fn do_forward(State(hub): S, Path((app, ns, id, op)): Path<(String, String, String, String)>, mut req: Request) -> R<Response> {
    let app = hub.app(&app)?;
    let do_url = req
        .headers()
        .get("x-rucloud-do-url")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http://do/")
        .to_string();
    *req.uri_mut() = "/__rucloud/do".parse().unwrap();
    let extra = [
        ("x-rucloud-kind", "do".to_string()),
        ("x-rucloud-token", app.token.clone()),
        ("x-rucloud-do-ns", ns),
        ("x-rucloud-do-op", op),
        ("x-rucloud-do-url", do_url),
        ("x-rucloud-do-id", id.clone()),
    ];
    Ok(crate::gateway::forward(&app, Some(App::do_affinity(&id)), req, &extra, false).await?)
}

// ---------- Vectorize、AI ----------

async fn vectorize(State(hub): S, Path((app, binding, op)): Path<(String, String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let (index, metric) = app
        .vector_metric(&binding)
        .ok_or_else(|| not_found(&format!("Vectorize 綁定 {binding}")))?;
    let store = app.vectors.clone();
    Ok(Json(blocking(move || store.op(&index, &metric, &op, &body)).await?))
}

async fn ai_run(State(hub): S, Path(app): Path<String>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    Ok(Json(
        crate::ai::run(&app.http, body["model"].as_str().unwrap_or(""), &body["inputs"]).await?,
    ))
}

// ---------- Cache API（caches.default / caches.open），所有 Worker 程序共用 ----------

#[derive(Deserialize)]
struct CacheQuery {
    url: String,
}

fn cache_key(name: &str, url: &str) -> String {
    format!("{name}\u{0}{url}")
}

async fn cache_get(State(hub): S, Path((app, name)): Path<(String, String)>, Query(q): Query<CacheQuery>) -> R<Response> {
    let app = hub.app(&app)?;
    let Some((e, age)) = app.cache.api.get(&cache_key(&name, &q.url)) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let meta = json!({ "status": e.status, "headers": e.headers });
    let mut h = HeaderMap::new();
    h.insert(
        "x-cache-meta",
        HeaderValue::from_str(&urlencoding::encode(&meta.to_string())).unwrap(),
    );
    h.insert("x-cache-age", HeaderValue::from(age));
    Ok((h, e.body).into_response())
}

async fn cache_put(
    State(hub): S,
    Path((app, name)): Path<(String, String)>,
    Query(q): Query<CacheQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    let meta: Value = headers
        .get("x-cache-meta")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok().and_then(|s| serde_json::from_str(&s).ok()))
        .ok_or_else(|| anyhow!("缺少 x-cache-meta"))?;
    let status = StatusCode::from_u16(meta["status"].as_u64().unwrap_or(200) as u16).map_err(|e| anyhow!(e))?;
    let pairs: Vec<(String, String)> = meta["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p[0].as_str()?.to_string(), p[1].as_str()?.to_string())))
        .collect();
    let mut hm = HeaderMap::new();
    for (k, v) in &pairs {
        if let (Ok(k), Ok(v)) = (axum::http::HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            hm.append(k, v);
        }
    }
    // Cache API 只看 Cache-Control 決定存多久（和 Cloudflare 一樣，沒有就不存）
    let stored = match crate::cache::ttl_of(status, &hm) {
        Some(ttl) => {
            app.cache.api.put(
                cache_key(&name, &q.url),
                status.as_u16(),
                crate::cache::keep_headers(&hm),
                body,
                ttl,
            );
            true
        }
        None => false,
    };
    Ok(Json(json!({ "stored": stored })))
}

async fn cache_delete(State(hub): S, Path((app, name)): Path<(String, String)>, Query(q): Query<CacheQuery>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    Ok(Json(json!({ "deleted": app.cache.api.delete(&cache_key(&name, &q.url)) })))
}

// ---------- Assets、Service bindings ----------

#[derive(Deserialize)]
struct AssetQuery {
    path: String,
}

async fn assets(State(hub): S, Path(app): Path<String>, Query(q): Query<AssetQuery>, method: Method, headers: HeaderMap) -> R<Response> {
    let app = hub.app(&app)?;
    let assets = app.assets.as_ref().ok_or_else(|| not_found("ASSETS 綁定"))?;
    Ok(match assets.serve(&method, &q.path, &headers).await {
        Some(r) => r,
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

/// env.OTHER.fetch()：呼叫同一個 rucloud 裡的另一個應用（靜態檔案 + Worker）
async fn service(State(hub): S, Path((app, binding)): Path<(String, String)>, mut req: Request) -> R<Response> {
    let app = hub.app(&app)?;
    let target = app
        .cfg
        .services
        .iter()
        .find(|s| s.binding == binding)
        .ok_or_else(|| not_found(&format!("service 綁定 {binding}")))?;
    let target = hub.app(&target.service)?;
    let url = req
        .headers()
        .get("x-rucloud-svc-url")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http://localhost/")
        .to_string();
    let (host, pq) = match url.split_once("://").map(|(_, r)| r.split_once('/').unwrap_or((r, ""))) {
        Some((h, p)) => (h.to_string(), format!("/{p}")),
        None => ("localhost".into(), "/".into()),
    };
    *req.uri_mut() = pq.parse().map_err(|e| anyhow!("{e}"))?;
    let h = req.headers_mut();
    h.remove("x-rucloud-token");
    h.remove("x-rucloud-svc-url");
    h.insert(header::HOST, HeaderValue::from_str(&host).map_err(|e| anyhow!(e))?);
    Ok(crate::gateway::handle(&target, req, ([127, 0, 0, 1], 0).into()).await)
}

// ---------- Workflows ----------

async fn workflow(State(hub): S, Path((app, name)): Path<(String, String)>, Json(body): Json<Value>) -> R<Json<Value>> {
    let app = hub.app(&app)?;
    if !app.cfg.workflows.iter().any(|w| w.name == name) {
        return Err(not_found(&format!("Workflow {name}")));
    }
    let wfs = app.workflows.clone();
    Ok(Json(blocking(move || wfs.op(&name, &body)).await?))
}

/// env.SVC.method(...)：呼叫另一個應用的 WorkerEntrypoint 方法。參數與回傳值由 JS 端序列化，這裡原樣轉送
async fn service_rpc(State(hub): S, Path((app, binding)): Path<(String, String)>, body: Bytes) -> R<Response> {
    let app = hub.app(&app)?;
    let svc = app
        .cfg
        .services
        .iter()
        .find(|s| s.binding == binding)
        .ok_or_else(|| not_found(&format!("service 綁定 {binding}")))?;
    let target = hub.app(&svc.service)?;
    let pool = target.pool.as_ref().ok_or_else(|| anyhow!("{} 沒有 Worker", target.name))?;
    let port = pool.port(None).await?;
    let mut rb = target
        .http
        .post(format!("http://127.0.0.1:{port}/__rucloud/rpc"))
        .header("x-rucloud-kind", "rpc")
        .header("x-rucloud-token", &target.token)
        .body(body);
    if let Some(ep) = &svc.entrypoint {
        rb = rb.header("x-rucloud-entrypoint", ep);
    }
    let res = rb.send().await.map_err(|e| anyhow!(e))?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let bytes = res.bytes().await.map_err(|e| anyhow!(e))?;
    Ok((status, bytes).into_response())
}
