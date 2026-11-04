//! `rucloud types`：依 wrangler 設定產生 `Env` 的 TypeScript 型別（和 `wrangler types` 類似）。
//! 綁定的型別（D1Database、KVNamespace…）來自 @cloudflare/workers-types。

use crate::config::{self, Wrangler};
use anyhow::{Context, Result};
use serde_json::Value;
use std::fmt::Write;
use std::path::Path;

/// TS 的屬性名稱：不是合法識別字就加引號
fn key(k: &str) -> String {
    let ident = k.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident { k.to_string() } else { serde_json::to_string(k).unwrap() }
}

/// vars 的值轉成型別：字串、數字、布林是字面量型別，物件 / 陣列照結構
fn value_type(v: &Value) -> String {
    match v {
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => format!("[{}]", a.iter().map(value_type).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{ {} }}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", key(k), value_type(v)))
                .collect::<Vec<_>>()
                .join("; ")
        ),
    }
}

pub fn generate(dir: &Path, w: &Wrangler, secrets: &[String], out_dir: &Path) -> String {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut add = |k: &str, t: String| fields.push((key(k), t));
    for d in &w.d1_databases {
        add(&d.binding, "D1Database".into());
    }
    for k in &w.kv_namespaces {
        add(&k.binding, "KVNamespace".into());
    }
    for r in &w.r2_buckets {
        add(&r.binding, "R2Bucket".into());
    }
    for q in &w.queues.producers {
        add(&q.binding, "Queue".into());
    }
    // Durable Object 的型別參數指向 main 模組 export 的類別，RPC 方法才有型別
    let main_import = w.main.as_ref().map(|m| {
        let p = dir.join(m);
        let rel = pathdiff(&p, out_dir);
        let rel = rel
            .trim_end_matches(".ts")
            .trim_end_matches(".js")
            .trim_end_matches(".mts")
            .trim_end_matches(".mjs")
            .to_string();
        if rel.starts_with('.') { rel } else { format!("./{rel}") }
    });
    for d in &w.durable_objects.bindings {
        let t = match &main_import {
            Some(m) => format!("DurableObjectNamespace<import({m:?}).{}>", d.class_name),
            None => "DurableObjectNamespace".into(),
        };
        add(&d.name, t);
    }
    for wf in &w.workflows {
        add(&wf.binding, "Workflow".into());
    }
    for v in &w.vectorize {
        add(&v.binding, "VectorizeIndex".into());
    }
    for r in &w.ratelimits {
        add(&r.name, "RateLimit".into());
    }
    for s in &w.services {
        add(&s.binding, "Fetcher".into());
    }
    for h in &w.hyperdrive {
        add(&h.binding, "Hyperdrive".into());
    }
    for a in &w.analytics_engine_datasets {
        add(&a.binding, "AnalyticsEngineDataset".into());
    }
    if let Some(ai) = &w.ai {
        add(&ai.binding, "Ai".into());
    }
    if let Some(b) = w.assets.as_ref().and_then(|a| a.binding.as_ref()) {
        add(b, "Fetcher".into());
    }
    for (k, v) in &w.vars {
        add(k, value_type(v));
    }
    for s in secrets {
        if !w.vars.contains_key(s) {
            add(s, "string".into());
        }
    }
    let mut out = String::from(
        "// 由 `rucloud types` 依 wrangler 設定產生，設定改了請重新產生，不要手改。\n// 綁定的型別來自 @cloudflare/workers-types（tsconfig 的 compilerOptions.types）。\n\n",
    );
    out.push_str("interface Env {\n");
    for (k, t) in &fields {
        let _ = writeln!(out, "  {k}: {t};");
    }
    out.push_str("}\n");
    out
}

/// 相對路徑（用 / 分隔），給 import() 用
fn pathdiff(target: &Path, base: &Path) -> String {
    let t: Vec<_> = target.components().collect();
    let b: Vec<_> = base.components().collect();
    let common = t.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), b.len() - common).collect();
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

pub fn run(app: &Path, env: Option<&str>, out: Option<&Path>) -> Result<()> {
    let dir = app.canonicalize().with_context(|| format!("找不到 {}", app.display()))?;
    let w = config::load_wrangler(&dir, env)?;
    // 密鑰的名稱取自 .dev.vars / .env（值不會寫出去）
    let secrets: Vec<String> = config::load_dev_vars(&dir, env).into_keys().collect();
    let out = out
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| dir.join("worker-configuration.d.ts"));
    let out_dir = out
        .parent()
        .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
        .unwrap_or(dir.clone());
    let text = generate(&dir, &w, &secrets, &out_dir);
    std::fs::write(&out, &text).with_context(|| format!("無法寫入 {}", out.display()))?;
    println!(
        "已產生 {}（{} 個欄位）",
        out.display(),
        text.lines().filter(|l| l.starts_with("  ")).count()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_types() {
        let w: Wrangler = json5::from_str(
            r#"{ name: "x", main: "src/worker.ts",
                 d1_databases: [{ binding: "DB" }], kv_namespaces: [{ binding: "KV" }],
                 durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
                 assets: { directory: "public", binding: "ASSETS" },
                 vars: { MODE: "dev", N: 3, FLAGS: { on: true }, "bad-name": "x" } }"#,
        )
        .unwrap();
        let t = generate(Path::new("/p"), &w, &["SECRET".into(), "MODE".into()], Path::new("/p"));
        assert!(t.contains("  DB: D1Database;"));
        assert!(t.contains("  KV: KVNamespace;"));
        assert!(t.contains(r#"  ROOMS: DurableObjectNamespace<import("./src/worker").Room>;"#));
        assert!(t.contains("  ASSETS: Fetcher;"));
        assert!(t.contains(r#"  MODE: "dev";"#));
        assert!(t.contains("  N: 3;"));
        assert!(t.contains("  FLAGS: { on: true };"));
        assert!(t.contains(r#"  "bad-name": "x";"#));
        assert!(t.contains("  SECRET: string;"));
        assert_eq!(t.matches("MODE").count(), 1, "vars 有的密鑰不重複");
    }
}
