//! Workers AI 綁定（env.AI.run）：轉給任何 OpenAI 相容的後端（Ollama、vLLM、NVIDIA、OpenAI…）。
//!   RUCLOUD_AI_BASE_URL  例如 http://localhost:11434/v1
//!   RUCLOUD_AI_API_KEY   可省略
//!   RUCLOUD_AI_MODEL     可省略；設定後忽略程式碼裡的 @cf/... 模型名稱
//!   RUCLOUD_AI_EMBEDDING_MODEL  可省略；embedding 用的模型

use anyhow::{Result, bail};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};

pub async fn run(http: &reqwest::Client, model: &str, inputs: &Value) -> Result<Value> {
    let Ok(base) = std::env::var("RUCLOUD_AI_BASE_URL") else {
        bail!("env.AI 需要設定 RUCLOUD_AI_BASE_URL（OpenAI 相容的端點，例如 http://localhost:11434/v1）");
    };
    let base = base.trim_end_matches('/');
    let key = std::env::var("RUCLOUD_AI_API_KEY").ok();
    let post = |path: &str, body: Value| {
        let mut rb = http.post(format!("{base}{path}")).json(&body);
        if let Some(k) = &key {
            rb = rb.bearer_auth(k);
        }
        rb
    };

    if let Some(text) = inputs.get("text") {
        // 文字 embedding：{text: string | string[]} → {shape, data}
        let model = std::env::var("RUCLOUD_AI_EMBEDDING_MODEL").unwrap_or_else(|_| model.to_string());
        let res: Value = post("/embeddings", json!({ "model": model, "input": text }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
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
    let model = std::env::var("RUCLOUD_AI_MODEL").unwrap_or_else(|_| model.to_string());
    let mut body = json!({ "model": model, "messages": messages, "stream": false });
    if inputs["stream"] == json!(true) {
        bail!("串流請用 run_stream");
    }
    for k in ["max_tokens", "temperature", "top_p", "tools", "seed"] {
        if let Some(v) = inputs.get(k) {
            body[k] = v.clone();
        }
    }
    let res: Value = post("/chat/completions", body).send().await?.error_for_status()?.json().await?;
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
    http: &reqwest::Client,
    model: &str,
    inputs: &Value,
) -> Result<impl Stream<Item = Result<Bytes, std::io::Error>> + use<>> {
    let Ok(base) = std::env::var("RUCLOUD_AI_BASE_URL") else {
        bail!("env.AI 需要設定 RUCLOUD_AI_BASE_URL（OpenAI 相容的端點，例如 http://localhost:11434/v1）");
    };
    let messages = match (inputs.get("messages"), inputs.get("prompt")) {
        (Some(m), _) => m.clone(),
        (None, Some(p)) => json!([{ "role": "user", "content": p }]),
        _ => bail!("串流只支援文字生成（messages 或 prompt）"),
    };
    let model = std::env::var("RUCLOUD_AI_MODEL").unwrap_or_else(|_| model.to_string());
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
    for k in ["max_tokens", "temperature", "top_p", "seed"] {
        if let Some(v) = inputs.get(k) {
            body[k] = v.clone();
        }
    }
    let mut rb = http.post(format!("{}/chat/completions", base.trim_end_matches('/'))).json(&body);
    if let Ok(k) = std::env::var("RUCLOUD_AI_API_KEY") {
        rb = rb.bearer_auth(k);
    }
    let upstream = rb.send().await?.error_for_status()?.bytes_stream();
    // 逐行讀上游的 SSE，每個 delta 轉成一個 Workers AI 事件
    let stream = futures_util::stream::unfold((upstream, String::new(), false), |(mut up, mut buf, mut done)| async move {
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
                    return Some((Ok(Bytes::from_static(b"data: [DONE]\n\n")), (up, buf, done)));
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                let Some(text) = v["choices"][0]["delta"]["content"].as_str().filter(|t| !t.is_empty()) else {
                    continue;
                };
                let ev = format!("data: {}\n\n", json!({ "response": text }));
                return Some((Ok(Bytes::from(ev)), (up, buf, done)));
            }
            match up.next().await {
                Some(Ok(chunk)) => buf.push_str(&String::from_utf8_lossy(&chunk)),
                Some(Err(e)) => {
                    done = true;
                    return Some((Err(std::io::Error::other(e)), (up, buf, done)));
                }
                None => {
                    // 上游沒送 [DONE] 就結束了：補一個
                    done = true;
                    return Some((Ok(Bytes::from_static(b"data: [DONE]\n\n")), (up, buf, done)));
                }
            }
        }
    });
    Ok(stream)
}
