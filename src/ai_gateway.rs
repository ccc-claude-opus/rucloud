//! AI Gateway：放在 Worker 和 LLM 供應商之間的代理，提供 log、回應快取、限流、重試。
//!
//!   http://<gateway>/<gateway 名稱>/<provider>/<供應商原本的路徑>
//!   例：http://localhost:8790/default/nvidia/v1/chat/completions
//!
//! 請求標頭：cf-aig-cache-ttl（秒，開啟快取）、cf-aig-skip-cache: true
//! 回應標頭：cf-aig-cache-status: HIT | MISS
//! GET /__logs?limit=50 看最近的請求記錄

use crate::d1::open_sqlite;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use bytes::Bytes;
use futures_util::StreamExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct GatewayCfg {
    pub port: u16,
    /// 預設快取秒數，0 = 只有帶 cf-aig-cache-ttl 時才快取
    pub cache_ttl: u64,
    /// 上游 429 / 5xx / 連線失敗時重試幾次
    pub retries: u32,
    pub rate_limit: Option<crate::config::RateLimitSimple>,
    /// 自訂供應商：名稱 → base URL
    pub providers: HashMap<String, String>,
}

const BUILTIN: &[(&str, &str)] = &[
    ("openai", "https://api.openai.com"),
    ("anthropic", "https://api.anthropic.com"),
    ("nvidia", "https://integrate.api.nvidia.com"),
    ("deepseek", "https://api.deepseek.com"),
    ("openrouter", "https://openrouter.ai/api"),
    ("groq", "https://api.groq.com/openai"),
    ("mistral", "https://api.mistral.ai"),
    ("google-ai-studio", "https://generativelanguage.googleapis.com"),
    ("zhipu", "https://open.bigmodel.cn/api/paas"),
    ("moonshot", "https://api.moonshot.cn"),
];

const MAX_CACHE_BODY: usize = 8 * 1024 * 1024;

pub struct Gateway {
    cfg: GatewayCfg,
    db: Mutex<Connection>,
    http: reqwest::Client,
    windows: Mutex<HashMap<String, (u64, u64)>>,
}

impl Gateway {
    pub fn new(cfg: GatewayCfg, state: &Path) -> anyhow::Result<Arc<Self>> {
        let db = open_sqlite(&state.join("ai-gateway.sqlite"))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, gateway TEXT, provider TEXT, path TEXT,
               model TEXT, status INTEGER, duration_ms REAL, cached INTEGER, req_bytes INTEGER, resp_bytes INTEGER);
             CREATE TABLE IF NOT EXISTS cache (
               key TEXT PRIMARY KEY, status INTEGER, content_type TEXT, body BLOB, expires INTEGER);",
        )?;
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build()?;
        Ok(Arc::new(Self {
            cfg,
            db: Mutex::new(db),
            http,
            windows: Mutex::new(HashMap::new()),
        }))
    }

    fn upstream(&self, provider: &str) -> Option<String> {
        self.cfg
            .providers
            .get(provider)
            .cloned()
            .or_else(|| BUILTIN.iter().find(|(p, _)| *p == provider).map(|(_, u)| u.to_string()))
    }

    fn allow(&self, gateway: &str) -> bool {
        let Some(rl) = &self.cfg.rate_limit else { return true };
        let w = crate::kv::now_secs() as u64 / rl.period.max(1);
        let mut m = self.windows.lock().unwrap();
        let e = m.entry(gateway.to_string()).or_insert((w, 0));
        if e.0 != w {
            *e = (w, 0);
        }
        e.1 += 1;
        e.1 <= rl.limit
    }

    #[allow(clippy::too_many_arguments)]
    fn log(&self, gateway: &str, provider: &str, path: &str, model: &str, status: u16, ms: f64, cached: bool, req: usize, resp: usize) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO logs (ts, gateway, provider, path, model, status, duration_ms, cached, req_bytes, resp_bytes) VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![chrono::Utc::now().timestamp_millis(), gateway, provider, path, model, status, ms, cached, req as i64, resp as i64],
        );
    }
}

pub fn router(gw: Arc<Gateway>) -> Router {
    Router::new()
        .route("/__logs", get(logs))
        .fallback(proxy)
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(gw)
}

#[derive(Deserialize)]
struct LogQuery {
    limit: Option<i64>,
}

async fn logs(State(gw): State<Arc<Gateway>>, Query(q): Query<LogQuery>) -> axum::Json<Value> {
    let db = gw.db.lock().unwrap();
    let rows: Vec<Value> = db
        .prepare("SELECT ts, gateway, provider, path, model, status, duration_ms, cached, req_bytes, resp_bytes FROM logs ORDER BY id DESC LIMIT ?")
        .and_then(|mut s| {
            s.query_map([q.limit.unwrap_or(50).clamp(1, 1000)], |r| {
                Ok(json!({
                    "ts": r.get::<_, i64>(0)?, "gateway": r.get::<_, String>(1)?, "provider": r.get::<_, String>(2)?,
                    "path": r.get::<_, String>(3)?, "model": r.get::<_, String>(4)?, "status": r.get::<_, i64>(5)?,
                    "duration_ms": r.get::<_, f64>(6)?, "cached": r.get::<_, bool>(7)?,
                    "req_bytes": r.get::<_, i64>(8)?, "resp_bytes": r.get::<_, i64>(9)?,
                }))
            })?
            .collect()
        })
        .unwrap_or_default();
    axum::Json(json!({ "logs": rows }))
}

async fn proxy(State(gw): State<Arc<Gateway>>, req: Request) -> Response<Body> {
    let start = Instant::now();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let mut seg = path.trim_start_matches('/').splitn(3, '/');
    let (gateway, provider, rest) = (seg.next().unwrap_or(""), seg.next().unwrap_or(""), seg.next().unwrap_or(""));
    let (gateway, provider) = (gateway.to_string(), provider.to_string());
    let Some(base) = gw.upstream(&provider) else {
        return (StatusCode::NOT_FOUND, format!("AI Gateway：不認識的供應商 {provider:?}\n")).into_response();
    };
    if !gw.allow(&gateway) {
        gw.log(&gateway, &provider, rest, "", 429, 0.0, false, 0, 0);
        return (StatusCode::TOO_MANY_REQUESTS, axum::Json(json!({ "error": "AI Gateway 限流" }))).into_response();
    }
    let url = format!("{}/{rest}{query}", base.trim_end_matches('/'));
    let (parts, body) = req.into_parts();
    let body = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let model = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["model"].as_str().map(String::from))
        .unwrap_or_default();
    let h = &parts.headers;
    let hv = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ttl = hv("cf-aig-cache-ttl").parse::<u64>().unwrap_or(gw.cfg.cache_ttl);
    let use_cache = ttl > 0 && hv("cf-aig-skip-cache") != "true";
    // 金鑰也算進快取鍵：不同使用者不會拿到別人的快取
    let key = hex::encode(Sha256::digest(
        [
            provider.as_bytes(),
            rest.as_bytes(),
            query.as_bytes(),
            hv("authorization").as_bytes(),
            hv("x-api-key").as_bytes(),
            &body,
        ]
        .concat(),
    ));

    if use_cache {
        let hit = {
            let db = gw.db.lock().unwrap();
            db.query_row(
                "SELECT status, content_type, body FROM cache WHERE key = ? AND expires > ?",
                params![key, crate::kv::now_secs()],
                |r| Ok((r.get::<_, u16>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?)),
            )
            .optional()
            .ok()
            .flatten()
        };
        if let Some((status, ctype, data)) = hit {
            gw.log(
                &gateway,
                &provider,
                rest,
                &model,
                status,
                start.elapsed().as_secs_f64() * 1000.0,
                true,
                body.len(),
                data.len(),
            );
            return Response::builder()
                .status(status)
                .header("content-type", ctype)
                .header("cf-aig-cache-status", "HIT")
                .body(Body::from(data))
                .unwrap();
        }
    }

    let mut fwd = HeaderMap::new();
    for (k, v) in h {
        let n = k.as_str();
        if !matches!(
            n,
            "host" | "content-length" | "connection" | "transfer-encoding" | "accept-encoding"
        ) && !n.starts_with("cf-aig-")
        {
            fwd.append(k.clone(), v.clone());
        }
    }
    let mut attempt = 0;
    let resp = loop {
        let r = gw
            .http
            .request(parts.method.clone(), &url)
            .headers(fwd.clone())
            .body(body.clone())
            .send()
            .await;
        let retryable = match &r {
            Ok(r) => r.status() == 429 || r.status().is_server_error(),
            Err(_) => true,
        };
        if !retryable || attempt >= gw.cfg.retries {
            break r;
        }
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
    };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            gw.log(
                &gateway,
                &provider,
                rest,
                &model,
                502,
                start.elapsed().as_secs_f64() * 1000.0,
                false,
                body.len(),
                0,
            );
            return (StatusCode::BAD_GATEWAY, format!("AI Gateway：連不到上游：{e}\n")).into_response();
        }
    };
    let status = resp.status();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut out = Response::builder().status(status).header("cf-aig-cache-status", "MISS");
    for (k, v) in resp.headers() {
        if !matches!(
            k.as_str(),
            "connection" | "transfer-encoding" | "content-length" | "content-encoding"
        ) {
            out = out.header(k, v);
        }
    }
    // 一邊串流給呼叫端，一邊收集（為了快取與記錄大小），串流結束再寫入
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let req_len = body.len();
    tokio::spawn(async move {
        let mut stream = resp.bytes_stream();
        let mut buf = Vec::new();
        let mut total = 0usize;
        let mut complete = true;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(c) => {
                    total += c.len();
                    if use_cache && buf.len() + c.len() <= MAX_CACHE_BODY {
                        buf.extend_from_slice(&c);
                    }
                    if tx.send(Ok(c)).await.is_err() {
                        complete = false;
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e))).await;
                    complete = false;
                    break;
                }
            }
        }
        if use_cache && complete && status.is_success() && total == buf.len() {
            let db = gw.db.lock().unwrap();
            let _ = db.execute(
                "INSERT OR REPLACE INTO cache VALUES (?, ?, ?, ?, ?)",
                params![key, status.as_u16(), ctype, buf, crate::kv::now_secs() + ttl as i64],
            );
        }
        gw.log(
            &gateway,
            &provider,
            rest_owned(&path),
            &model,
            status.as_u16(),
            start.elapsed().as_secs_f64() * 1000.0,
            false,
            req_len,
            total,
        );
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) });
    out.body(Body::from_stream(stream)).unwrap()
}

fn rest_owned(path: &str) -> &str {
    path.trim_start_matches('/').splitn(3, '/').nth(2).unwrap_or("")
}
