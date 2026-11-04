//! 設定檔：讀 wrangler.jsonc / wrangler.json（Cloudflare 的格式）、.dev.vars，
//! 以及 rucloud 自己的多應用設定 rucloud.toml。

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// wrangler.jsonc 裡 rucloud 看得懂的欄位；其他欄位忽略。
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Wrangler {
    pub name: Option<String>,
    pub main: Option<String>,
    pub compatibility_date: Option<String>,
    pub vars: serde_json::Map<String, Value>,
    pub d1_databases: Vec<D1Cfg>,
    pub kv_namespaces: Vec<KvCfg>,
    pub r2_buckets: Vec<R2Cfg>,
    pub assets: Option<AssetsCfg>,
    pub queues: QueuesCfg,
    pub triggers: TriggersCfg,
    pub durable_objects: DurableObjectsCfg,
    pub vectorize: Vec<VectorizeCfg>,
    pub ai: Option<AiCfg>,
    pub ratelimits: Vec<RateLimitCfg>,
    pub services: Vec<ServiceCfg>,
    pub migrations: Vec<MigrationCfg>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct D1Cfg {
    pub binding: String,
    pub database_name: Option<String>,
}

impl D1Cfg {
    pub fn db_name(&self) -> &str {
        self.database_name.as_deref().unwrap_or(&self.binding)
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct KvCfg {
    pub binding: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct R2Cfg {
    pub binding: String,
    pub bucket_name: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct AssetsCfg {
    pub directory: Option<String>,
    pub binding: Option<String>,
    /// true / false / ["/api/*", "!/api/docs/*"]
    pub run_worker_first: Value,
    /// "single-page-application" | "404-page" | "none"
    pub not_found_handling: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct QueuesCfg {
    pub producers: Vec<QueueProducerCfg>,
    pub consumers: Vec<QueueConsumerCfg>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QueueProducerCfg {
    pub binding: String,
    pub queue: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QueueConsumerCfg {
    pub queue: String,
    pub max_batch_size: Option<usize>,
    pub max_batch_timeout: Option<f64>,
    pub max_retries: Option<u32>,
    pub dead_letter_queue: Option<String>,
    pub retry_delay: Option<u64>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct TriggersCfg {
    pub crons: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct DurableObjectsCfg {
    pub bindings: Vec<DurableObjectBindingCfg>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DurableObjectBindingCfg {
    pub name: String,
    pub class_name: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct MigrationCfg {
    pub tag: Option<String>,
    pub new_classes: Vec<String>,
    pub new_sqlite_classes: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct VectorizeCfg {
    pub binding: String,
    pub index_name: String,
    /// rucloud 擴充：cosine（預設）、euclidean、dot-product
    pub metric: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AiCfg {
    pub binding: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimitCfg {
    pub name: String,
    pub simple: RateLimitSimple,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimitSimple {
    pub limit: u64,
    pub period: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ServiceCfg {
    pub binding: String,
    pub service: String,
}

/// 找應用資料夾裡的 wrangler 設定檔並解析（JSONC：允許註解與結尾逗號）。
pub fn load_wrangler(dir: &Path) -> Result<Wrangler> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let p = dir.join(name);
        if p.exists() {
            let text = std::fs::read_to_string(&p).with_context(|| format!("讀不到 {}", p.display()))?;
            return json5::from_str(&text).with_context(|| format!("{} 格式不對", p.display()));
        }
    }
    if dir.join("wrangler.toml").exists() {
        bail!("{}：目前只支援 wrangler.jsonc / wrangler.json", dir.display());
    }
    bail!("{} 裡找不到 wrangler.jsonc", dir.display())
}

/// 讀 .dev.vars（沒有就讀 .env）：KEY=VALUE，# 開頭是註解，值可以用引號包起來。
pub fn load_dev_vars(dir: &Path) -> BTreeMap<String, String> {
    for name in [".dev.vars", ".env"] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            return parse_env(&text);
        }
    }
    BTreeMap::new()
}

pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        let v = if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            v[1..v.len() - 1].replace("\\n", "\n")
        } else {
            v.to_string()
        };
        out.insert(k.trim().to_string(), v);
    }
    out
}

/// rucloud.toml：一個程序同時跑多個應用。
#[derive(Debug, Deserialize, Clone)]
pub struct ServeConfig {
    #[serde(default = "default_state")]
    pub state_dir: PathBuf,
    #[serde(default = "default_node")]
    pub node: String,
    #[serde(default = "default_bind")]
    pub bind: String,
    /// 依 Host 標頭分派到各應用的共用入口
    pub edge: Option<EdgeCfg>,
    pub ai_gateway: Option<crate::ai_gateway::GatewayCfg>,
    #[serde(default, rename = "app")]
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EdgeCfg {
    pub port: u16,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AppEntry {
    pub path: PathBuf,
    pub name: Option<String>,
    pub port: Option<u16>,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default = "one")]
    pub instances: usize,
    /// 額外的密鑰檔（KEY=VALUE），會覆蓋 .dev.vars
    pub env_file: Option<PathBuf>,
    /// 啟動時對 D1 執行的 SQL 檔：{ DB = "schema.sql" }
    #[serde(default)]
    pub d1_init: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub watch: bool,
}

fn default_state() -> PathBuf {
    PathBuf::from(".rucloud")
}
fn default_node() -> String {
    "node".into()
}
fn default_bind() -> String {
    "0.0.0.0".into()
}
fn one() -> usize {
    1
}

pub fn load_serve_config(path: &Path) -> Result<ServeConfig> {
    let text = std::fs::read_to_string(path).with_context(|| format!("讀不到 {}", path.display()))?;
    let mut cfg: ServeConfig = toml::from_str(&text).with_context(|| format!("{} 格式不對", path.display()))?;
    // 設定檔裡的相對路徑以設定檔所在的資料夾為準
    let base = path.parent().unwrap_or(Path::new("."));
    if cfg.state_dir.is_relative() {
        cfg.state_dir = base.join(&cfg.state_dir);
    }
    for app in &mut cfg.apps {
        if app.path.is_relative() {
            app.path = base.join(&app.path);
        }
        if let Some(f) = &app.env_file
            && f.is_relative()
        {
            app.env_file = Some(base.join(f));
        }
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jsonc_with_comments_and_trailing_commas() {
        let w: Wrangler = json5::from_str(
            r#"{
              // 註解
              "name": "x",
              "main": "src/worker.js",
              "d1_databases": [{ "binding": "DB", "database_name": "x-db", "database_id": "0" },],
              "assets": { "directory": "./public", "run_worker_first": ["/api/*"] },
            }"#,
        )
        .unwrap();
        assert_eq!(w.name.as_deref(), Some("x"));
        assert_eq!(w.d1_databases[0].db_name(), "x-db");
        assert!(w.assets.unwrap().run_worker_first.is_array());
    }

    #[test]
    fn parses_env_files() {
        let m = parse_env("# c\nA=1\nexport B=\"two words\"\nC='x'\n");
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "x");
    }
}
