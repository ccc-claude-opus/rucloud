//! 一個應用（= 一個 wrangler 專案）：設定、各種綁定的儲存、Worker 程序池。

use crate::assets::Assets;
use crate::config::{self, AppEntry, RateLimitSimple, Wrangler};
use crate::d1::D1;
use crate::durable::DoStore;
use crate::kv::Kv;
use crate::pool::{Pool, WorkerSpec};
use crate::r2::R2;
use crate::vectorize::VectorStore;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub struct App {
    pub name: String,
    pub dir: PathBuf,
    pub cfg: Wrangler,
    pub assets: Option<Assets>,
    pub pool: Option<Arc<Pool>>,
    pub d1: HashMap<String, Arc<D1>>,
    pub kv: Arc<Kv>,
    /// binding → bucket 名稱
    pub r2_buckets: HashMap<String, String>,
    r2: OnceLock<Arc<R2>>,
    pub durable: Arc<DoStore>,
    pub vectors: Arc<VectorStore>,
    pub ratelimits: HashMap<String, RateLimitSimple>,
    pub ratelimit_state: Mutex<HashMap<(String, String), (u64, u64)>>,
    pub state: PathBuf,
    pub dev: bool,
    pub http: reqwest::Client,
    pub token: String,
    pub metrics: Arc<crate::observe::Metrics>,
    pub logs: Arc<crate::observe::Logs>,
    pub cache: Arc<crate::cache::Caches>,
    pub workflows: Arc<crate::workflows::Workflows>,
}

/// 建立應用時需要的共用資訊
#[derive(Clone)]
pub struct Ctx {
    pub state_root: PathBuf,
    pub node: String,
    pub host_js: PathBuf,
    pub bindings_url: String,
    pub http: reqwest::Client,
    pub dev: bool,
}

/// 跨版本不變的東西：換版時新舊 Worker 程序會同時存在一下子，token 要相同；計數與 log 也要接續
pub struct Shared {
    pub cache: Arc<crate::cache::Caches>,
    pub workflows: Arc<crate::workflows::Workflows>,
    pub token: String,
    pub metrics: Arc<crate::observe::Metrics>,
    pub logs: Arc<crate::observe::Logs>,
}

/// 一個應用名稱對應的「目前版本」。部署、rollback 時替換裡面的 App
pub struct Slot {
    pub name: String,
    pub entry: AppEntry,
    pub shared: Shared,
    current: std::sync::RwLock<Arc<App>>,
    /// 目前版本的背景工作（cron、佇列消費者、鬧鐘…），換版時取消
    pub background: Mutex<tokio_util::sync::CancellationToken>,
}

impl Slot {
    pub fn get(&self) -> Arc<App> {
        self.current.read().unwrap().clone()
    }

    /// 換成新版本，回傳舊的
    pub fn set(&self, app: Arc<App>) -> Arc<App> {
        std::mem::replace(&mut *self.current.write().unwrap(), app)
    }
}

/// 應用名稱：rucloud.toml 的 name > wrangler 的 name > 資料夾名稱
pub fn app_name(entry: &AppEntry) -> Result<String> {
    let dir = entry
        .path
        .canonicalize()
        .with_context(|| format!("找不到應用資料夾 {}", entry.path.display()))?;
    let cfg = config::load_wrangler(&dir, entry.env.as_deref())?;
    Ok(entry
        .name
        .clone()
        .or(cfg.name)
        .unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned()))
}

impl Slot {
    /// 第一次載入：code_dir 是要跑的程式碼（部署過的版本，或設定檔的 path）
    pub fn create(entry: &AppEntry, ctx: &Ctx, code_dir: &Path) -> Result<Arc<Slot>> {
        let name = app_name(entry)?;
        let state = ctx.state_root.join(&name);
        let shared = Shared {
            cache: Arc::new(crate::cache::Caches::new(entry.cache_mb)),
            workflows: Arc::new(crate::workflows::Workflows::open(&state.join("workflows.sqlite"))?),
            // 每個應用一把自己的 token：Worker 只能用它存取自己的綁定
            token: format!("{:032x}", rand::random::<u128>()),
            metrics: Arc::default(),
            logs: Arc::new(crate::observe::Logs::new(&name, entry.log_files.then(|| state.join("logs")))),
        };
        let app = App::load(entry, ctx, code_dir, &name, &shared)?;
        Ok(Arc::new(Slot {
            name,
            entry: entry.clone(),
            shared,
            current: std::sync::RwLock::new(app),
            background: Mutex::new(tokio_util::sync::CancellationToken::new()),
        }))
    }
}

impl App {
    /// code_dir：程式碼所在的資料夾；密鑰（.dev.vars）仍然從設定檔的 path 讀，部署的版本裡不放密鑰
    pub fn load(entry: &AppEntry, ctx: &Ctx, code_dir: &Path, name: &str, shared: &Shared) -> Result<Arc<App>> {
        let dir = code_dir
            .canonicalize()
            .with_context(|| format!("找不到應用資料夾 {}", code_dir.display()))?;
        let cfg = config::load_wrangler(&dir, entry.env.as_deref())?;
        for (key, why) in config::unsupported_keys(&dir, entry.env.as_deref()) {
            tracing::warn!("[{name}] wrangler 設定的 {key}：{why}");
        }
        let name = name.to_string();
        let state = ctx.state_root.join(&name);
        std::fs::create_dir_all(state.join("do-sqlite"))?;
        let token = shared.token.clone();

        let mut d1 = HashMap::new();
        for db in &cfg.d1_databases {
            let store = Arc::new(D1::open(&state.join("d1").join(format!("{}.sqlite", db.db_name())))?);
            d1.insert(db.binding.clone(), store);
        }
        if entry.d1_migrate {
            crate::cli::migrate_all(&dir, &cfg, &d1, &name)?;
        }
        for (binding, file) in &entry.d1_init {
            let db = d1
                .get(binding)
                .with_context(|| format!("{name}：d1_init 指定的 {binding} 不是 D1 綁定"))?;
            let path = if file.is_relative() { dir.join(file) } else { file.clone() };
            let sql = std::fs::read_to_string(&path).with_context(|| format!("讀不到 {}", path.display()))?;
            db.exec(&sql).with_context(|| format!("{name}：執行 {} 失敗", path.display()))?;
            tracing::info!("[{name}] {binding} 已執行 {}", path.display());
        }

        let mut vars: BTreeMap<String, Value> = cfg.vars.clone().into_iter().collect();
        let secrets_dir = entry.path.canonicalize().unwrap_or_else(|_| dir.clone());
        for (k, v) in config::load_dev_vars(&secrets_dir, entry.env.as_deref()) {
            vars.insert(k, Value::String(v));
        }
        if let Some(f) = &entry.env_file {
            let text = std::fs::read_to_string(f).with_context(|| format!("讀不到 {}", f.display()))?;
            for (k, v) in config::parse_env(&text) {
                vars.insert(k, Value::String(v));
            }
        }

        let assets = cfg.assets.as_ref().map(|a| Assets::new(&dir, a));
        let spec = json!({
            "app": name,
            "main": cfg.main.as_ref().map(|m| dir.join(m)),
            "bindingsUrl": format!("{}/b/{}", ctx.bindings_url, urlencoding::encode(&name)),
            "token": token,
            "vars": vars,
            "d1": cfg.d1_databases.iter().map(|d| &d.binding).collect::<Vec<_>>(),
            "kv": cfg.kv_namespaces.iter().map(|k| &k.binding).collect::<Vec<_>>(),
            "r2": cfg.r2_buckets.iter().map(|r| &r.binding).collect::<Vec<_>>(),
            "queues": cfg.queues.producers.iter().map(|p| json!({ "binding": p.binding, "queue": p.queue })).collect::<Vec<_>>(),
            "durableObjects": cfg.durable_objects.bindings.iter().map(|d| json!({ "binding": d.name, "className": d.class_name })).collect::<Vec<_>>(),
            "vectorize": cfg.vectorize.iter().map(|v| &v.binding).collect::<Vec<_>>(),
            "ratelimits": cfg.ratelimits.iter().map(|r| &r.name).collect::<Vec<_>>(),
            "services": cfg.services.iter().map(|s| &s.binding).collect::<Vec<_>>(),
            "workflows": cfg.workflows.iter().map(|w| json!({ "binding": w.binding, "name": w.name })).collect::<Vec<_>>(),
            "hyperdrive": cfg.hyperdrive.iter().map(|h| {
                let var = format!("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{}", h.binding);
                let conn = vars.get(&var).and_then(|v| v.as_str().map(String::from))
                    .or_else(|| std::env::var(&var).ok())
                    .or_else(|| h.local_connection_string.clone());
                json!({ "binding": h.binding, "connectionString": conn })
            }).collect::<Vec<_>>(),
            "analytics": cfg.analytics_engine_datasets.iter().map(|a| json!({ "binding": a.binding, "dataset": a.dataset.clone().unwrap_or(a.binding.clone()) })).collect::<Vec<_>>(),
            "ai": cfg.ai.as_ref().map(|a| &a.binding),
            "assets": cfg.assets.as_ref().and_then(|a| a.binding.clone()),
            "compatibilityDate": cfg.compatibility_date,
            "sqliteClasses": cfg.migrations.iter().flat_map(|m| m.new_sqlite_classes.iter()).collect::<Vec<_>>(),
            "doSqliteDir": state.join("do-sqlite"),
            "rules": cfg.rules,
            "doIdleMs": entry.do_idle_ms.unwrap_or(60_000),
        });
        let logs = shared.logs.clone();
        let mut node_args = Vec::new();
        if entry.sandbox {
            // 可讀：應用資料夾、rucloud 的執行環境；可寫：SQLite 型 Durable Object 的資料夾
            let runtime_dir = ctx.host_js.parent().unwrap_or(&ctx.host_js);
            node_args.push("--permission".to_string());
            for p in [dir.as_path(), runtime_dir]
                .into_iter()
                .chain(entry.allow_read.iter().map(|p| p.as_path()))
            {
                node_args.push(format!("--allow-fs-read={}", p.display()));
            }
            for p in std::iter::once(state.join("do-sqlite")).chain(entry.allow_write.iter().cloned()) {
                node_args.push(format!("--allow-fs-read={}", p.display()));
                node_args.push(format!("--allow-fs-write={}", p.display()));
            }
        }
        if let Some(mb) = entry.memory_mb {
            node_args.push(format!("--max-old-space-size={mb}"));
        }
        let max_block = match entry.max_block_ms.unwrap_or(30_000) {
            0 => None,
            ms => Some(std::time::Duration::from_millis(ms)),
        };
        let pool = cfg.main.as_ref().map(|_| {
            Pool::start(
                WorkerSpec {
                    app: name.clone(),
                    node: ctx.node.to_string(),
                    host_js: ctx.host_js.to_path_buf(),
                    cwd: dir.clone(),
                    spec_json: spec.to_string(),
                    node_args,
                    max_block,
                    http: ctx.http.clone(),
                    token: token.clone(),
                    logs: logs.clone(),
                },
                entry.instances,
            )
        });

        Ok(Arc::new(App {
            r2_buckets: cfg
                .r2_buckets
                .iter()
                .map(|r| (r.binding.clone(), r.bucket_name.clone().unwrap_or(r.binding.clone())))
                .collect(),
            ratelimits: cfg.ratelimits.iter().map(|r| (r.name.clone(), r.simple.clone())).collect(),
            kv: Arc::new(Kv::open(&state.join("kv.sqlite"))?),
            durable: Arc::new(DoStore::open(&state.join("durable.sqlite"))?),
            vectors: Arc::new(VectorStore::open(&state.join("vectorize.sqlite"))?),
            ratelimit_state: Mutex::new(HashMap::new()),
            r2: OnceLock::new(),
            name,
            dir,
            cfg,
            assets,
            pool,
            d1,
            state,
            dev: ctx.dev,
            http: ctx.http.clone(),
            token,
            metrics: shared.metrics.clone(),
            logs,
            cache: shared.cache.clone(),
            workflows: shared.workflows.clone(),
        }))
    }

    pub fn r2(&self) -> Result<Arc<R2>> {
        if let Some(r) = self.r2.get() {
            return Ok(r.clone());
        }
        let r = Arc::new(R2::open(&self.state.join("r2"))?);
        Ok(self.r2.get_or_init(|| r).clone())
    }

    /// 固定窗口限流：period 秒內最多 limit 次
    pub fn rate_limit(&self, binding: &str, key: &str) -> Option<bool> {
        let cfg = self.ratelimits.get(binding)?;
        let now = kv_now();
        let window = now / cfg.period.max(1);
        let mut st = self.ratelimit_state.lock().unwrap();
        if st.len() > 100_000 {
            st.retain(|_, (w, _)| *w == window);
        }
        let e = st.entry((binding.to_string(), key.to_string())).or_insert((window, 0));
        if e.0 != window {
            *e = (window, 0);
        }
        e.1 += 1;
        Some(e.1 <= cfg.limit)
    }

    pub fn vector_metric(&self, binding: &str) -> Option<(String, String)> {
        let v = self.cfg.vectorize.iter().find(|v| v.binding == binding)?;
        Some((v.index_name.clone(), v.metric.clone().unwrap_or_else(|| "cosine".into())))
    }

    /// Durable Object id 固定對應到某個程序
    pub fn do_affinity(id: &str) -> usize {
        usize::from_str_radix(&id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect::<String>(), 16).unwrap_or(0)
    }
}

fn kv_now() -> u64 {
    crate::kv::now_secs() as u64
}
