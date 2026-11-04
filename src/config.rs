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
    pub rules: Vec<RuleCfg>,
    pub workflows: Vec<WorkflowCfg>,
    pub hyperdrive: Vec<HyperdriveCfg>,
    pub analytics_engine_datasets: Vec<AnalyticsCfg>,
}

/// Hyperdrive：rucloud 不做連線池，直接把資料庫的連線字串交給 Worker
#[derive(Debug, Deserialize, Clone)]
pub struct HyperdriveCfg {
    pub binding: String,
    /// 和 wrangler dev 相同的欄位；也可以用環境變數
    /// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING> 或 .dev.vars 裡的同名變數
    #[serde(rename = "localConnectionString")]
    pub local_connection_string: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AnalyticsCfg {
    pub binding: String,
    pub dataset: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct WorkflowCfg {
    pub name: String,
    pub binding: String,
    pub class_name: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct D1Cfg {
    pub binding: String,
    pub database_name: Option<String>,
    pub migrations_dir: Option<String>,
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
    /// rucloud 擴充：物件變動時送訊息到佇列（Cloudflare 是用 wrangler r2 bucket notification 設定）
    #[serde(default)]
    pub event_notifications: Vec<R2NotificationCfg>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct R2NotificationCfg {
    pub queue: String,
    /// PutObject、CopyObject、CompleteMultipartUpload、DeleteObject；不給就全部
    #[serde(default)]
    pub actions: Vec<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
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
    /// "http_pull"：不推給 Worker，由外部用管理埠的 pull API 取
    #[serde(rename = "type")]
    pub kind: Option<String>,
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

/// 模組規則：import 非 JS 檔時怎麼處理（Text、Data、CompiledWasm）
#[derive(Debug, Deserialize, Clone, serde::Serialize)]
pub struct RuleCfg {
    #[serde(rename = "type")]
    pub kind: String,
    pub globs: Vec<String>,
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
    /// 具名 entrypoint（目標應用 export 的 WorkerEntrypoint 類別）；不給就是 default
    pub entrypoint: Option<String>,
}

/// 這些設定不會從最上層繼承到 env.<名稱>（和 wrangler 一樣），環境裡沒寫就是沒有
const NON_INHERITABLE: &[&str] = &[
    "vars",
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "durable_objects",
    "queues",
    "services",
    "vectorize",
    "ai",
    "ratelimits",
];

/// 找應用資料夾裡的 wrangler 設定檔並解析（wrangler.jsonc / wrangler.json / wrangler.toml）。
/// env 有給時套用 `env.<名稱>` 的設定，應用名稱變成 `<name>-<env>`。
pub fn load_wrangler(dir: &Path, env: Option<&str>) -> Result<Wrangler> {
    let raw = load_wrangler_value(dir, env)?;
    serde_json::from_value(raw).with_context(|| format!("{} 的 wrangler 設定有欄位格式不對", dir.display()))
}

/// rucloud 讀得到但不支援（會被忽略）的 wrangler 欄位，和原因
pub const UNSUPPORTED: &[(&str, &str)] = &[
    ("routes", "rucloud 依 rucloud.toml 的 hosts / port 分派，不讀 routes"),
    ("route", "rucloud 依 rucloud.toml 的 hosts / port 分派，不讀 route"),
    ("compatibility_flags", "會被忽略；Node.js 相容（nodejs_compat）一律開著"),
    (
        "tail_consumers",
        "不支援 Tail Workers；請用 rucloud tail 或管理埠的 /apps/<應用>/tail",
    ),
    ("unsafe", "不支援 unsafe 綁定"),
    ("containers", "不支援 Containers"),
    ("browser", "不支援 Browser Rendering"),
    ("images", "不支援 Images"),
    ("send_email", "不支援 Email Workers"),
    ("dispatch_namespaces", "不支援 Workers for Platforms"),
    ("mtls_certificates", "不支援 mTLS 憑證綁定"),
    ("secrets_store_secrets", "不支援 Secrets Store；請用 .dev.vars 或 env_file"),
    ("pipelines", "不支援 Pipelines"),
    ("vpc_services", "不支援 VPC services"),
    ("placement", "單機，Smart Placement 沒有意義"),
    ("limits", "會被忽略；請用 rucloud.toml 的 max_block_ms、memory_mb"),
];

/// 設定裡用到、但 rucloud 不支援的欄位
pub fn unsupported_keys(dir: &Path, env: Option<&str>) -> Vec<(&'static str, &'static str)> {
    let Ok(raw) = load_wrangler_value(dir, env) else { return vec![] };
    UNSUPPORTED
        .iter()
        .filter(|(k, _)| raw.get(*k).is_some_and(|v| !v.is_null()))
        .copied()
        .collect()
}

/// 讀 wrangler 設定成 JSON，並套用環境（還沒轉成 Wrangler）
pub fn load_wrangler_value(dir: &Path, env: Option<&str>) -> Result<Value> {
    let mut raw: Value = 'found: {
        for name in ["wrangler.jsonc", "wrangler.json"] {
            let p = dir.join(name);
            if p.exists() {
                let text = std::fs::read_to_string(&p).with_context(|| format!("讀不到 {}", p.display()))?;
                break 'found json5::from_str(&text).with_context(|| format!("{} 格式不對", p.display()))?;
            }
        }
        let p = dir.join("wrangler.toml");
        if p.exists() {
            let text = std::fs::read_to_string(&p).with_context(|| format!("讀不到 {}", p.display()))?;
            break 'found toml::from_str(&text).with_context(|| format!("{} 格式不對", p.display()))?;
        }
        bail!("{} 裡找不到 wrangler.jsonc / wrangler.json / wrangler.toml", dir.display())
    };
    let envs = raw.as_object_mut().and_then(|o| o.remove("env"));
    if let Some(env) = env {
        let over = envs
            .as_ref()
            .and_then(|e| e.get(env))
            .and_then(|e| e.as_object())
            .with_context(|| format!("{}：wrangler 設定裡沒有 env.{env}", dir.display()))?;
        let top = raw.as_object_mut().context("wrangler 設定的最上層要是物件")?;
        for k in NON_INHERITABLE {
            top.remove(*k);
        }
        let base_name = top.get("name").and_then(|n| n.as_str()).map(String::from);
        for (k, v) in over {
            top.insert(k.clone(), v.clone());
        }
        if !over.contains_key("name")
            && let Some(n) = base_name
        {
            top.insert("name".into(), Value::String(format!("{n}-{env}")));
        }
    }
    Ok(raw)
}

/// 讀 .dev.vars（有 env 時優先讀 .dev.vars.<env>；都沒有就讀 .env）：KEY=VALUE，# 開頭是註解，值可以用引號包起來。
pub fn load_dev_vars(dir: &Path, env: Option<&str>) -> BTreeMap<String, String> {
    let mut names = Vec::new();
    if let Some(e) = env {
        names.push(format!(".dev.vars.{e}"));
    }
    names.extend([".dev.vars".to_string()]);
    if let Some(e) = env {
        names.push(format!(".env.{e}"));
    }
    names.push(".env".to_string());
    for name in names {
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
#[serde(deny_unknown_fields)]
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
    /// R2 的 S3 相容 API
    pub s3: Option<crate::s3::S3Cfg>,
    /// 管理埠：/health、/metrics、log
    pub admin: Option<AdminCfg>,
    /// HTTPS（自備憑證或 ACME）
    pub tls: Option<crate::tls::TlsCfg>,
    /// 回應壓縮（gzip、brotli）
    #[serde(default = "yes")]
    pub compression: bool,
    /// 收到 SIGTERM 後最多等幾秒讓進行中的請求做完
    #[serde(default = "thirty")]
    pub shutdown_timeout: u64,
    #[serde(default, rename = "app")]
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct AdminCfg {
    #[serde(default = "admin_port")]
    pub port: u16,
    /// 預設只聽 127.0.0.1
    #[serde(default = "localhost")]
    pub bind: String,
    /// 有設定時 /apps/* 需要帶 token（Authorization: Bearer 或 ?token=）
    pub token: Option<String>,
}

fn admin_port() -> u16 {
    8799
}
fn localhost() -> String {
    "127.0.0.1".into()
}
fn thirty() -> u64 {
    30
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct EdgeCfg {
    pub port: u16,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
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
    /// wrangler 設定的環境（env.<名稱>）
    pub env: Option<String>,
    /// 啟動時套用 D1 的 migrations（migrations/ 資料夾）
    #[serde(default)]
    pub d1_migrate: bool,
    /// 啟動時對 D1 執行的 SQL 檔：{ DB = "schema.sql" }
    #[serde(default)]
    pub d1_init: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub watch: bool,
    /// Node 權限模型：只能讀應用資料夾、不能開子程序（預設開啟）
    #[serde(default = "yes")]
    pub sandbox: bool,
    /// 沙箱額外允許讀取的路徑（例如 monorepo 上層的 node_modules）
    #[serde(default)]
    pub allow_read: Vec<PathBuf>,
    /// 沙箱額外允許寫入的路徑
    #[serde(default)]
    pub allow_write: Vec<PathBuf>,
    /// 每個 Worker 程序的 JS heap 上限（MB）
    pub memory_mb: Option<u32>,
    /// 事件迴圈卡住超過幾毫秒就重開程序；0 = 不檢查。預設 30000
    pub max_block_ms: Option<u64>,
    /// 閘道快取 Worker 回應的容量（MB），依 Cache-Control；不設 = 不快取
    pub cache_mb: Option<usize>,
    /// Durable Object 閒置多久（毫秒）就從記憶體移除；0 = 不移除。預設 60000
    pub do_idle_ms: Option<u64>,
    /// Worker 的 log 每天寫一個檔（<state>/<應用>/logs/）
    #[serde(default = "yes")]
    pub log_files: bool,
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
fn yes() -> bool {
    true
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
        for p in app.allow_read.iter_mut().chain(app.allow_write.iter_mut()) {
            if p.is_relative() {
                *p = base.join(&*p);
            }
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
    fn wrangler_toml_and_environments() {
        let dir = std::env::temp_dir().join(format!("rucloud-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("wrangler.toml"),
            r#"
name = "app"
main = "src/index.ts"
[vars]
MODE = "dev"
[[d1_databases]]
binding = "DB"
database_name = "app-db"
[env.staging]
vars = { MODE = "staging" }
[[env.staging.kv_namespaces]]
binding = "KV"
id = "x"
"#,
        )
        .unwrap();
        let base = load_wrangler(&dir, None).unwrap();
        assert_eq!(base.vars["MODE"], "dev");
        assert_eq!(base.d1_databases.len(), 1);
        let st = load_wrangler(&dir, Some("staging")).unwrap();
        assert_eq!(st.name.as_deref(), Some("app-staging"));
        assert_eq!(st.main.as_deref(), Some("src/index.ts"), "main 會繼承");
        assert_eq!(st.vars["MODE"], "staging");
        assert!(st.d1_databases.is_empty(), "綁定不會繼承");
        assert_eq!(st.kv_namespaces[0].binding, "KV");
        assert!(load_wrangler(&dir, Some("nope")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_env_files() {
        let m = parse_env("# c\nA=1\nexport B=\"two words\"\nC='x'\n");
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "x");
    }
}
