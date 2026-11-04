//! Workers AI 綁定（env.AI.run）：轉給任何 OpenAI 相容的後端（Ollama、vLLM、NVIDIA、OpenAI…）。
//!   RUCLOUD_AI_BASE_URL  例如 http://localhost:11434/v1
//!   RUCLOUD_AI_API_KEY   可省略
//!   RUCLOUD_AI_MODEL     可省略；設定後忽略程式碼裡的 @cf/... 模型名稱
//!   RUCLOUD_AI_EMBEDDING_MODEL  可省略；embedding 用的模型

use anyhow::{Result, bail};
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
