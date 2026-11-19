//! Workers AI 綁定（env.AI.run）：轉給任何 OpenAI 相容的後端（Ollama、vLLM、NVIDIA、OpenAI…）。
//! 後端的設定依序取：`<state_dir>/ai.json`（管理 API 的 /ai 改的）、rucloud.toml 的 [ai]、環境變數
//!   RUCLOUD_AI_BASE_URL  例如 http://localhost:11434/v1
//!   RUCLOUD_AI_API_KEY   可省略
//!   RUCLOUD_AI_MODEL     可省略；設定後忽略程式碼裡的 @cf/... 模型名稱
//!   RUCLOUD_AI_EMBEDDING_MODEL  可省略；embedding 用的模型
//! 每個應用每天的請求數與 token 數記在 `<state_dir>/ai-usage.sqlite`，可以設每天的上限。

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct AiBackend {
    /// OpenAI 相容的端點，例如 http://localhost:11434/v1
    pub base_url: String,
    pub api_key: Option<String>,
    /// 設定後忽略程式碼裡的 @cf/... 模型名稱
    pub model: Option<String>,
    pub embedding_model: Option<String>,
    /// 每個應用每天最多幾次請求、幾個 token（0 或不設：不限）
    #[serde(default)]
    pub daily_requests: u64,
    #[serde(default)]
    pub daily_tokens: u64,
}

impl AiBackend {
    fn from_env() -> Option<Self> {
        let base_url = std::env::var("RUCLOUD_AI_BASE_URL").ok()?;
        Some(Self {
            base_url,
            api_key: std::env::var("RUCLOUD_AI_API_KEY").ok(),
            model: std::env::var("RUCLOUD_AI_MODEL").ok(),
            embedding_model: std::env::var("RUCLOUD_AI_EMBEDDING_MODEL").ok(),
            ..Default::default()
        })
    }
}

fn check(b: &AiBackend) -> Result<()> {
    if !b.base_url.starts_with("http://") && !b.base_url.starts_with("https://") {
        bail!("AI 後端的網址要是 http:// 或 https:// 開頭（例如 http://localhost:11434/v1）");
    }
    Ok(())
}

pub struct Ai {
    path: PathBuf,
    cfg: RwLock<Option<AiBackend>>,
    usage: Mutex<Connection>,
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

impl Ai {
    pub fn open(state_root: &std::path::Path, default: Option<AiBackend>) -> Result<Self> {
        let path = state_root.join("ai.json");
        let cfg = match std::fs::read(&path) {
            Ok(b) => Some(serde_json::from_slice(&b).context("ai.json 讀不懂")?),
            Err(_) => default.or_else(AiBackend::from_env),
        };
        if let Some(c) = &cfg {
            check(c).context("AI 的設定")?;
        }
        let usage = crate::d1::open_sqlite(&state_root.join("ai-usage.sqlite"))?;
        usage.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage (app TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
               tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app, day));",
        )?;
        Ok(Self { path, cfg: RwLock::new(cfg), usage: Mutex::new(usage) })
    }

    /// 給管理 API 看的設定（不含金鑰）
    pub fn describe(&self) -> Value {
        match &*self.cfg.read().unwrap() {
            None => json!({ "configured": false }),
            Some(c) => json!({
                "configured": true, "base_url": c.base_url, "has_api_key": c.api_key.as_deref().is_some_and(|k| !k.is_empty()),
                "model": c.model, "embedding_model": c.embedding_model, "daily_requests": c.daily_requests, "daily_tokens": c.daily_tokens,
            }),
        }
    }

    /// 換設定；api_key 沒給時沿用原來的
    pub fn set(&self, mut cfg: AiBackend) -> Result<()> {
        check(&cfg)?;
        if cfg.api_key.is_none() {
            cfg.api_key = self.cfg.read().unwrap().as_ref().and_then(|c| c.api_key.clone());
        }
        crate::secrets::write_private(&self.path, &serde_json::to_vec_pretty(&cfg)?)?;
        *self.cfg.write().unwrap() = Some(cfg);
        Ok(())
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.path);
        *self.cfg.write().unwrap() = None;
    }

    /// 最近 days 天每個應用的用量：[{app, day, requests, tokens}]
    pub fn usage(&self, days: u32) -> Result<Vec<Value>> {
        let since = (chrono::Utc::now() - chrono::Duration::days(days.saturating_sub(1) as i64)).format("%Y-%m-%d").to_string();
        let conn = self.usage.lock().unwrap();
        let mut st = conn.prepare("SELECT app, day, requests, tokens FROM usage WHERE day >= ? ORDER BY day DESC, app")?;
        let rows = st.query_map([since], |r| {
            Ok(json!({ "app": r.get::<_, String>(0)?, "day": r.get::<_, String>(1)?, "requests": r.get::<_, i64>(2)?, "tokens": r.get::<_, i64>(3)? }))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 呼叫前：有設定、今天還沒到上限
    fn begin(&self, app: &str) -> Result<AiBackend> {
        let cfg = self.cfg.read().unwrap().clone().context("還沒設定 AI 的後端（OpenAI 相容的端點，例如 http://localhost:11434/v1）")?;
        let (req, tok): (i64, i64) = self
            .usage
            .lock()
            .unwrap()
            .query_row("SELECT requests, tokens FROM usage WHERE app = ? AND day = ?", params![app, today()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((0, 0));
        if cfg.daily_requests > 0 && req as u64 >= cfg.daily_requests {
            bail!("{app} 今天的 AI 請求已達上限（{} 次）", cfg.daily_requests);
        }
        if cfg.daily_tokens > 0 && tok as u64 >= cfg.daily_tokens {
            bail!("{app} 今天的 AI 用量已達上限（{} tokens）", cfg.daily_tokens);
        }
        Ok(cfg)
    }

    fn record(&self, app: &str, tokens: u64) {
        let _ = self.usage.lock().unwrap().execute(
            "INSERT INTO usage (app, day, requests, tokens) VALUES (?, ?, 1, ?)
             ON CONFLICT(app, day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens",
            params![app, today(), tokens as i64],
        );
    }
}

fn request(http: &reqwest::Client, b: &AiBackend, path: &str, body: Value) -> reqwest::RequestBuilder {
    let mut rb = http.post(format!("{}{path}", b.base_url.trim_end_matches('/'))).json(&body);
    if let Some(k) = b.api_key.as_deref().filter(|k| !k.is_empty()) {
        rb = rb.bearer_auth(k);
    }
    rb
}

pub async fn run(ai: &Ai, http: &reqwest::Client, app: &str, model: &str, inputs: &Value) -> Result<Value> {
    let b = ai.begin(app)?;
    if let Some(text) = inputs.get("text") {
        // 文字 embedding：{text: string | string[]} → {shape, data}
        let model = b.embedding_model.clone().unwrap_or_else(|| model.to_string());
        let res: Value = request(http, &b, "/embeddings", json!({ "model": model, "input": text }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        ai.record(app, res["usage"]["total_tokens"].as_u64().unwrap_or(0));
        let data: Vec<Value> = res["data"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| d["embedding"].clone())
            .collect();
        let dims = data.first().and_then(|d| d.as_array()).map(|a| a.len()).unwrap_or(0);
        return Ok(json!({ "shape": [data.len(), dims], "data": data }));
    }

    let messages = match (inputs.get("messages"), inputs.get("prompt")) {
        (Some(m), _) => m.clone(),
        (None, Some(p)) => json!([{ "role": "user", "content": p }]),
        _ => bail!("env.AI.run：目前支援 {{messages}}、{{prompt}}（文字生成）與 {{text}}（embedding）"),
    };
    let model = b.model.clone().unwrap_or_else(|| model.to_string());
    let mut body = json!({ "model": model, "messages": messages, "stream": false });
    if inputs["stream"] == json!(true) {
        bail!("串流請用 run_stream");
    }
    for k in ["max_tokens", "temperature", "top_p", "tools", "seed"] {
        if let Some(v) = inputs.get(k) {
            body[k] = v.clone();
        }
    }
    let res: Value = request(http, &b, "/chat/completions", body).send().await?.error_for_status()?.json().await?;
    ai.record(app, res["usage"]["total_tokens"].as_u64().unwrap_or(0));
    let msg = &res["choices"][0]["message"];
    let mut out = json!({ "response": msg["content"].as_str().unwrap_or("") });
    if let Some(tc) = msg.get("tool_calls").filter(|v| v.is_array()) {
        out["tool_calls"] = tc.clone();
    }
    if let Some(u) = res.get("usage") {
        out["usage"] = u.clone();
    }
    Ok(out)
}

/// `{ stream: true }`：上游的 OpenAI 格式 SSE 轉成 Workers AI 的格式
///   data: {"response":"…"}  …  data: [DONE]
pub async fn run_stream(
    ai: Arc<Ai>,
    http: &reqwest::Client,
    app: &str,
    model: &str,
    inputs: &Value,
) -> Result<impl Stream<Item = Result<Bytes, std::io::Error>> + use<>> {
    let b = ai.begin(app)?;
    let messages = match (inputs.get("messages"), inputs.get("prompt")) {
        (Some(m), _) => m.clone(),
        (None, Some(p)) => json!([{ "role": "user", "content": p }]),
        _ => bail!("串流只支援文字生成（messages 或 prompt）"),
    };
    let model = b.model.clone().unwrap_or_else(|| model.to_string());
    // 最後一個事件帶用量（OpenAI 的 stream_options；不支援的後端就只記請求數）
    let mut body = json!({ "model": model, "messages": messages, "stream": true, "stream_options": { "include_usage": true } });
    for k in ["max_tokens", "temperature", "top_p", "seed"] {
        if let Some(v) = inputs.get(k) {
            body[k] = v.clone();
        }
    }
    let upstream = request(http, &b, "/chat/completions", body).send().await?.error_for_status()?.bytes_stream();
    // 逐行讀上游的 SSE，每個 delta 轉成一個 Workers AI 事件；結束時記用量
    let usage = Usage { ai, app: app.to_string(), tokens: 0 };
    let stream = futures_util::stream::unfold((upstream, String::new(), false, usage), |(mut up, mut buf, mut done, mut usage)| async move {
        loop {
            if done {
                return None;
            }
            if let Some(i) = buf.find('\n') {
                let line: String = buf.drain(..=i).collect();
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    return Some((Ok(Bytes::from_static(b"data: [DONE]\n\n")), (up, buf, done, usage)));
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(t) = v["usage"]["total_tokens"].as_u64() {
                    usage.tokens = t;
                }
                let Some(text) = v["choices"][0]["delta"]["content"].as_str().filter(|t| !t.is_empty()) else {
                    continue;
                };
                let ev = format!("data: {}\n\n", json!({ "response": text }));
                return Some((Ok(Bytes::from(ev)), (up, buf, done, usage)));
            }
            match up.next().await {
                Some(Ok(chunk)) => buf.push_str(&String::from_utf8_lossy(&chunk)),
                Some(Err(e)) => {
                    done = true;
                    return Some((Err(std::io::Error::other(e)), (up, buf, done, usage)));
                }
                None => {
                    // 上游沒送 [DONE] 就結束了：補一個
                    done = true;
                    return Some((Ok(Bytes::from_static(b"data: [DONE]\n\n")), (up, buf, done, usage)));
                }
            }
        }
    });
    Ok(stream)
}

/// 串流結束（或中途被丟掉）時記一次用量
struct Usage {
    ai: Arc<Ai>,
    app: String,
    tokens: u64,
}

impl Drop for Usage {
    fn drop(&mut self) {
        self.ai.record(&self.app, self.tokens);
    }
}
