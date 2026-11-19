//! 部署：版本存在 `<state>/<應用>/versions/<id>/`，`versions.json` 記錄清單與目前版本。
//! 換版時先把新版本的 Worker 程序起好，再把槽裡的 App 換掉，舊版本等一段時間（讓進行中的請求做完）才關。

use crate::app::{App, Ctx, Slot};
use crate::queues::Queues;
use crate::registry::Kind;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// 每個應用最多保留幾個版本（目前版本永遠保留）
const KEEP: usize = 10;
/// 上傳的壓縮檔最大（解開前）
pub const MAX_UPLOAD: usize = 200 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Version {
    pub id: String,
    pub created: String,
    pub message: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Manifest {
    /// None：跑設定檔 path 的程式碼
    pub current: Option<String>,
    pub versions: Vec<Version>,
}

pub struct Deployer {
    pub ctx: Ctx,
    pub registry: Arc<crate::registry::Registry>,
    pub queues: Arc<Queues>,
    /// 舊版本留多久才關
    pub grace: Duration,
    /// `[dynamic]`：允許在執行中新增應用
    pub dynamic: Option<crate::config::DynamicCfg>,
    /// `[install]`：安裝的應用
    pub install: Option<crate::config::InstallCfg>,
    /// 新增、刪除應用一次只做一個
    pub dynamic_lock: tokio::sync::Mutex<()>,
}

fn versions_dir(ctx: &Ctx, app: &str) -> PathBuf {
    ctx.state_root.join(app).join("versions")
}

pub fn manifest(ctx: &Ctx, app: &str) -> Manifest {
    std::fs::read_to_string(ctx.state_root.join(app).join("versions.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_manifest(ctx: &Ctx, app: &str, m: &Manifest) -> Result<()> {
    let path = ctx.state_root.join(app).join("versions.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(m)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// 啟動時用：有部署過的版本就跑那個，否則跑設定檔的 path
pub fn code_dir(ctx: &Ctx, app: &str, entry_path: &Path) -> PathBuf {
    match manifest(ctx, app).current {
        Some(id) if versions_dir(ctx, app).join(&id).is_dir() => versions_dir(ctx, app).join(id),
        _ => entry_path.to_path_buf(),
    }
}

impl Deployer {
    pub fn slot(&self, app: &str) -> Result<Arc<Slot>> {
        self.registry.get(app).with_context(|| format!("找不到應用 {app}"))
    }

    /// 收一個 tar.gz，解到新的版本資料夾。檢查 wrangler 設定讀得起來才算數
    pub fn store(&self, app: &str, tar_gz: &[u8], message: &str) -> Result<Version> {
        let slot = self.slot(app)?;
        self.store_version(app, slot.entry.env.as_deref(), self.registry.kind(app), tar_gz, message)
    }

    fn store_version(&self, app: &str, env: Option<&str>, kind: Kind, tar_gz: &[u8], message: &str) -> Result<Version> {
        let id = format!("{}-{:04x}", chrono::Utc::now().format("%Y%m%d-%H%M%S"), rand::random::<u16>());
        let root = versions_dir(&self.ctx, app);
        let tmp = root.join(format!(".{id}.tmp"));
        std::fs::create_dir_all(&tmp)?;
        let result = (|| -> Result<(usize, u64)> {
            let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz));
            let (mut files, mut bytes) = (0, 0);
            for entry in archive.entries()? {
                let mut entry = entry?;
                let kind = entry.header().entry_type();
                // 只收一般檔案與資料夾：符號連結可能指到應用外面
                if !(kind.is_file() || kind.is_dir()) {
                    continue;
                }
                // macOS 的 tar 會放進 ._xxx（延伸屬性）與 .DS_Store
                let fname = entry
                    .path()?
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if fname.starts_with("._") || fname == ".DS_Store" {
                    continue;
                }
                // unpack_in 會拒絕 .. 與絕對路徑
                if !entry.unpack_in(&tmp)? {
                    bail!("壓縮檔裡有不安全的路徑：{}", entry.path()?.display());
                }
                if kind.is_file() {
                    files += 1;
                    bytes += entry.header().size()?;
                }
            }
            let cfg = crate::config::load_wrangler(&tmp, env).context("上傳的版本裡的 wrangler 設定有問題")?;
            if kind.restricted() {
                check_dynamic(&tmp, &cfg, kind)?;
            }
            Ok((files, bytes))
        })();
        let (files, bytes) = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(e);
            }
        };
        std::fs::rename(&tmp, root.join(&id))?;
        let v = Version {
            id,
            created: chrono::Utc::now().to_rfc3339(),
            message: message.to_string(),
            files,
            bytes,
        };
        let mut m = manifest(&self.ctx, app);
        m.versions.push(v.clone());
        // 清掉太舊的版本
        while m.versions.len() > KEEP {
            let Some(pos) = m.versions.iter().position(|x| Some(&x.id) != m.current.as_ref()) else {
                break;
            };
            let old = m.versions.remove(pos);
            let _ = std::fs::remove_dir_all(root.join(&old.id));
        }
        save_manifest(&self.ctx, app, &m)?;
        Ok(v)
    }

    /// 換成某個版本（None = 設定檔的 path）。新版本起不來就保持原狀並回報錯誤
    pub async fn activate(&self, app: &str, id: Option<&str>) -> Result<()> {
        let slot = self.slot(app)?;
        let code = match id {
            Some(id) => {
                let d = versions_dir(&self.ctx, app).join(id);
                if !d.is_dir() {
                    bail!("找不到版本 {id}");
                }
                d
            }
            None => slot.entry.path.clone(),
        };
        let (ctx, s2, code2) = (self.ctx.clone(), slot.clone(), code.clone());
        let new = tokio::task::spawn_blocking(move || App::load(&s2.entry, &ctx, &code2, &s2.name, &s2.shared)).await??;
        let hosts = self.registry.hosts_for_cfg(&slot, &new.cfg, self.registry.kind(app).restricted());
        if let Err(e) = self.registry.check_hosts(app, &hosts) {
            if let Some(p) = &new.pool {
                p.stop();
            }
            return Err(e.context("維持原本的版本"));
        }
        if let Some(pool) = &new.pool {
            wait_ready(pool, &slot).await.context("維持原本的版本")?;
        }
        let old = slot.set(new.clone());
        self.registry.refresh_hosts(&slot)?;
        slot.shared.cache.clear_edge();
        restart_background(&slot, &new, &self.queues);
        let mut m = manifest(&self.ctx, app);
        m.current = id.map(String::from);
        save_manifest(&self.ctx, app, &m)?;
        slot.shared
            .logs
            .push("system", &format!("切換到版本 {}", id.unwrap_or("（設定檔的 path）")), true);
        // 舊版本等進行中的請求做完再關
        let grace = self.grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            if let Some(p) = &old.pool {
                p.stop();
            }
        });
        Ok(())
    }

    /// 重新載入目前的版本（改了 wrangler 設定、.dev.vars 之後）
    pub async fn reload(&self, app: &str) -> Result<()> {
        let current = manifest(&self.ctx, app).current;
        self.activate(app, current.as_deref()).await
    }

    /// 回到上一個版本（目前版本在清單裡的前一個；目前是 path 時回到最新的部署版本）
    pub async fn rollback(&self, app: &str) -> Result<Option<String>> {
        let m = manifest(&self.ctx, app);
        let target = match &m.current {
            Some(cur) => {
                let pos = m.versions.iter().position(|v| &v.id == cur).unwrap_or(0);
                if pos == 0 { None } else { Some(m.versions[pos - 1].id.clone()) }
            }
            None => bail!("目前跑的是設定檔的 path，沒有可以回退的部署版本"),
        };
        self.activate(app, target.as_deref()).await?;
        Ok(target)
    }
}

/// 等新的 Worker 程序都起來；只要有一個程序結束（例如語法錯誤）就判定失敗，不必等到逾時
async fn wait_ready(pool: &crate::pool::Pool, slot: &Slot) -> Result<()> {
    let started = std::time::Instant::now();
    while pool.ready_count() != pool.len() {
        if pool.restarts() > 0 || started.elapsed() > Duration::from_secs(30) {
            pool.stop();
            let recent: Vec<String> = slot
                .shared
                .logs
                .recent(5)
                .into_iter()
                .filter(|l| l["kind"] == "error")
                .filter_map(|l| l["message"].as_str().map(String::from))
                .collect();
            bail!("新版本的 Worker 起不來。\n{}", recent.join("\n"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

// ---------- 執行中新增的應用（[dynamic]） ----------

/// 執行中新增的應用不能用的綁定：它們會碰到其他應用或伺服器的資源
///（佇列與 Analytics 是全域共用的、Hyperdrive 讀伺服器的環境變數、AI 用伺服器的金鑰、service binding 呼叫其他應用）。
/// 安裝的應用（[install]）可以用佇列與 workflow：佇列名稱加上應用名稱前綴（app.rs 的 installed_queues），
/// workflow 本來就是每個應用一份；send_email 要安裝程式給 email 權限才能寄
pub fn check_dynamic(dir: &Path, cfg: &crate::config::Wrangler, kind: Kind) -> Result<()> {
    let installed = kind == Kind::Installed;
    let mut bad = Vec::new();
    if !cfg.services.is_empty() {
        bad.push("services");
    }
    if !installed && (!cfg.queues.producers.is_empty() || !cfg.queues.consumers.is_empty()) {
        bad.push("queues");
    }
    if cfg.ai.is_some() {
        bad.push("ai");
    }
    if !cfg.analytics_engine_datasets.is_empty() {
        bad.push("analytics_engine_datasets");
    }
    if !cfg.hyperdrive.is_empty() {
        bad.push("hyperdrive");
    }
    if !installed && !cfg.workflows.is_empty() {
        bad.push("workflows");
    }
    if !installed && !cfg.send_email.is_empty() {
        bad.push("send_email");
    }
    if !bad.is_empty() {
        bail!(
            "執行中新增的應用不能使用這些綁定（會碰到其他應用或伺服器的資源）：{}",
            bad.join("、")
        );
    }
    // 路徑都要在版本資料夾裡：靜態檔案與 migrations 由 rucloud 直接讀，不受 Worker 沙箱限制
    let root = dir.canonicalize()?;
    let mut paths: Vec<(&str, &str)> = Vec::new();
    if let Some(m) = &cfg.main {
        paths.push(("main", m));
    }
    if let Some(d) = cfg.assets.as_ref().and_then(|a| a.directory.as_deref()) {
        paths.push(("assets.directory", d));
    }
    for db in &cfg.d1_databases {
        if let Some(m) = &db.migrations_dir {
            paths.push(("d1_databases.migrations_dir", m));
        }
    }
    for (what, p) in paths {
        let full = root.join(p);
        // 還不存在的路徑（例如沒有 migrations）只檢查字面上有沒有往上跳
        let inside = match full.canonicalize() {
            Ok(c) => c.starts_with(&root),
            Err(_) => !Path::new(p).is_absolute() && !Path::new(p).components().any(|c| matches!(c, std::path::Component::ParentDir)),
        };
        if !inside {
            bail!("{what} 必須在上傳的資料夾裡：{p}");
        }
    }
    Ok(())
}

/// 應用名稱：小寫英文、數字與 -，最多 63 字（要能當網域的一段）
fn valid_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 63
        || name.starts_with('-')
        || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        bail!("應用名稱只能有小寫英文、數字與 -（最多 63 字）：{name}");
    }
    Ok(())
}

fn valid_dynamic_name(name: &str, prefix: &str) -> Result<()> {
    if !name.starts_with(prefix) || name.len() <= prefix.len() {
        bail!("應用名稱必須以 {prefix} 開頭");
    }
    valid_name(name)
}

/// 執行中新增的應用清單：dynamic.json（[dynamic]）、managed.json（部署時自動新增的）
fn list_path(ctx: &Ctx, kind: Kind) -> PathBuf {
    ctx.state_root
        .join(match kind {
            Kind::Dynamic => "dynamic.json",
            Kind::Installed => "installed.json",
            _ => "managed.json",
        })
}

fn read_list(ctx: &Ctx, kind: Kind) -> Vec<String> {
    std::fs::read_to_string(list_path(ctx, kind))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn update_list(ctx: &Ctx, kind: Kind, name: &str, present: bool) -> Result<()> {
    let mut names = read_list(ctx, kind);
    names.retain(|x| x != name);
    if present {
        names.push(name.to_string());
    }
    let path = list_path(ctx, kind);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&names)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// 執行中新增的應用的設定。path 指到一個空資料夾：沒有 .dev.vars（密鑰用 rucloud secret 設定）。
/// [dynamic] 的應用另外有自己的沙箱、記憶體與卡住的上限
/// 限制：(instances, memory_mb, max_block_ms)
type Limits = (usize, u32, u64);

fn runtime_entry(limits: Option<Limits>, ctx: &Ctx, name: &str) -> Result<crate::config::AppEntry> {
    let source = ctx.state_root.join(name).join("source");
    std::fs::create_dir_all(&source)?;
    let mut v = serde_json::json!({ "path": source, "name": name, "d1_migrate": true, "sandbox": true });
    if let Some((instances, memory_mb, max_block_ms)) = limits {
        v["instances"] = instances.into();
        v["memory_mb"] = memory_mb.into();
        v["max_block_ms"] = max_block_ms.into();
    }
    Ok(serde_json::from_value(v)?)
}

fn dynamic_limits(d: &crate::config::DynamicCfg) -> Limits {
    (d.instances, d.memory_mb, d.max_block_ms)
}

fn install_entry(i: &crate::config::InstallCfg, ctx: &Ctx, name: &str) -> Result<crate::config::AppEntry> {
    let mut e = runtime_entry(Some((i.instances, i.memory_mb, i.max_block_ms)), ctx, name)?;
    e.installed = true;
    Ok(e)
}

/// 安裝的應用的權限（沒有檔案 = 沒有任何權限）
pub fn load_grants(state_root: &Path, app: &str) -> crate::config::Grants {
    std::fs::read_to_string(state_root.join(app).join("grants.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

impl Deployer {
    fn dynamic_cfg(&self) -> Result<&crate::config::DynamicCfg> {
        self.dynamic.as_ref().context("rucloud.toml 沒有 [dynamic]，不能在執行中新增應用")
    }

    /// 用 [dynamic] 的 token：新增應用，或替已經存在的（執行中新增的）應用部署新版本
    pub async fn put_dynamic(&self, name: &str, tar_gz: Vec<u8>, message: String) -> Result<(Version, bool)> {
        let d = self.dynamic_cfg()?.clone();
        valid_dynamic_name(name, &d.prefix)?;
        let _guard = self.dynamic_lock.lock().await;
        if self.registry.get(name).is_some() {
            if !self.registry.is_dynamic(name) {
                bail!("{name} 不是執行中新增的應用，不能用這個 token 覆蓋");
            }
            return Ok((self.deploy_existing(name, tar_gz, message).await?, false));
        }
        if self.registry.dynamic_count() >= d.max_apps {
            bail!("執行中新增的應用已經有 {} 個（max_apps）", d.max_apps);
        }
        let entry = runtime_entry(Some(dynamic_limits(&d)), &self.ctx, name)?;
        Ok((self.create(name, entry, Kind::Dynamic, tar_gz, message).await?, true))
    }

    fn install_cfg(&self) -> Result<&crate::config::InstallCfg> {
        self.install.as_ref().context("rucloud.toml 沒有 [install]，不能安裝應用")
    }

    /// 用 [install] 的 token：安裝應用（用自己的名稱），或更新已安裝的應用。
    /// 新安裝的應用沒有任何權限，安裝程式再用 set_grants 給
    pub async fn put_installed(&self, name: &str, tar_gz: Vec<u8>, message: String) -> Result<(Version, bool)> {
        let i = self.install_cfg()?.clone();
        valid_name(name)?;
        if let Some(d) = &self.dynamic
            && name.starts_with(&d.prefix)
        {
            bail!("{} 開頭的名稱保留給 [dynamic] 的應用", d.prefix);
        }
        let _guard = self.dynamic_lock.lock().await;
        if self.registry.get(name).is_some() {
            if self.registry.kind(name) != Kind::Installed {
                bail!("{name} 這個名稱已經是系統的應用，不能用來安裝");
            }
            return Ok((self.deploy_existing(name, tar_gz, message).await?, false));
        }
        if self.registry.installed_count() >= i.max_apps {
            bail!("安裝的應用已經有 {} 個（max_apps）", i.max_apps);
        }
        // 上次移除但保留了資料的應用：舊的權限不沿用
        let _ = std::fs::remove_file(self.ctx.state_root.join(name).join("grants.json"));
        let entry = install_entry(&i, &self.ctx, name)?;
        Ok((self.create(name, entry, Kind::Installed, tar_gz, message).await?, true))
    }

    /// 改變安裝的應用的權限，然後重新載入它
    pub async fn set_grants(&self, name: &str, grants: crate::config::Grants) -> Result<()> {
        let i = self.install_cfg()?;
        if self.registry.kind(name) != Kind::Installed || self.registry.get(name).is_none() {
            bail!("{name} 不是安裝的應用");
        }
        let mut seen = std::collections::BTreeSet::new();
        for s in &grants.services {
            if !i.services.contains(&s.service) {
                bail!("不能綁定到 {}（不在 [install] services 裡）", s.service);
            }
            let ok = !s.binding.is_empty()
                && s.binding.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && s.binding.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !ok || !seen.insert(s.binding.clone()) {
                bail!("綁定名稱不對或重複：{}", s.binding);
            }
            if s.entrypoint.is_some() {
                bail!("安裝的應用的綁定不能指定 entrypoint");
            }
        }
        let path = self.ctx.state_root.join(name).join("grants.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&grants)?)?;
        std::fs::rename(tmp, path)?;
        self.reload(name).await
    }

    /// 用完整的管理 token（rucloud deploy）：應用存在就部署新版本，不存在就新增（可以用所有綁定）
    pub async fn put_app(&self, name: &str, tar_gz: Vec<u8>, message: String) -> Result<(Version, bool)> {
        valid_name(name)?;
        match self.registry.kind(name) {
            Kind::Dynamic => return self.put_dynamic(name, tar_gz, message).await,
            Kind::Installed => return self.put_installed(name, tar_gz, message).await,
            _ => {}
        }
        let _guard = self.dynamic_lock.lock().await;
        if self.registry.get(name).is_some() {
            return Ok((self.deploy_existing(name, tar_gz, message).await?, false));
        }
        if let Some(d) = &self.dynamic
            && name.starts_with(&d.prefix)
        {
            bail!("{} 開頭的名稱保留給 [dynamic] 的應用", d.prefix);
        }
        let entry = runtime_entry(None, &self.ctx, name)?;
        Ok((self.create(name, entry, Kind::Managed, tar_gz, message).await?, true))
    }

    async fn deploy_existing(&self, name: &str, tar_gz: Vec<u8>, message: String) -> Result<Version> {
        let (me, n) = (self.clone_handle(), name.to_string());
        let v = tokio::task::spawn_blocking(move || me.store(&n, &tar_gz, &message)).await??;
        self.activate(name, Some(&v.id)).await?;
        Ok(v)
    }

    async fn create(&self, name: &str, entry: crate::config::AppEntry, kind: Kind, tar_gz: Vec<u8>, message: String) -> Result<Version> {
        // 已經有資料（例如移除時保留了資料、或原本是設定檔裡的應用）：失敗時不能刪
        let had_state = self.ctx.state_root.join(name).join("versions").is_dir()
            || std::fs::read_dir(self.ctx.state_root.join(name))
                .is_ok_and(|d| d.filter_map(|e| e.ok()).any(|e| e.file_name() != "source" && e.file_name() != "versions"));
        let before = manifest(&self.ctx, name);
        let result = async {
            let (me, n) = (self.clone_handle(), name.to_string());
            let v = tokio::task::spawn_blocking(move || me.store_version(&n, None, kind, &tar_gz, &message)).await??;
            let code = versions_dir(&self.ctx, name).join(&v.id);
            let ctx = self.ctx.clone();
            let slot = tokio::task::spawn_blocking(move || Slot::create(&entry, &ctx, &code)).await??;
            let app = slot.get();
            if let Some(pool) = &app.pool {
                wait_ready(pool, &slot).await?;
            }
            if let Err(e) = self.registry.insert(slot.clone(), kind) {
                if let Some(p) = &app.pool {
                    p.stop();
                }
                return Err(e);
            }
            let mut m = manifest(&self.ctx, name);
            m.current = Some(v.id.clone());
            save_manifest(&self.ctx, name, &m)?;
            self.start_app(&slot, kind);
            update_list(&self.ctx, kind, name, true)?;
            slot.shared.logs.push("system", &format!("新增應用，版本 {}", v.id), true);
            tracing::info!("[{name}] 新增應用（{kind:?}），版本 {}", v.id);
            Ok(v)
        }
        .await;
        if result.is_err() && self.registry.get(name).is_none() {
            if had_state {
                // 資料留著，版本清單回到原來的樣子
                let _ = save_manifest(&self.ctx, name, &before);
            } else {
                let _ = std::fs::remove_dir_all(self.ctx.state_root.join(name));
            }
        }
        result
    }

    fn start_app(&self, slot: &Arc<Slot>, kind: Kind) {
        restart_background(slot, &slot.get(), &self.queues);
        if kind != Kind::Dynamic {
            let (s, stop) = (slot.clone(), slot.stopped.clone());
            tokio::spawn(async move {
                tokio::select! {
                    _ = stop.cancelled() => {}
                    _ = crate::workflows::run_loop(s.clone(), s.shared.workflows.clone()) => {}
                }
            });
        }
    }

    /// 刪除執行中新增的應用（[dynamic] 的或部署時自動新增的）；purge 連資料一起刪
    pub async fn delete_app(&self, name: &str, purge: bool) -> Result<()> {
        let _guard = self.dynamic_lock.lock().await;
        let kind = self.registry.kind(name);
        if self.registry.get(name).is_none() {
            bail!("找不到應用 {name}");
        }
        if kind == Kind::Config {
            bail!("{name} 是 rucloud.toml 裡的應用，請從設定檔移除");
        }
        let slot = self.registry.remove(name).context("找不到應用")?;
        slot.stopped.cancel();
        slot.background.lock().unwrap().cancel();
        if let Some(pool) = &slot.get().pool {
            pool.stop();
        }
        slot.shared.logs.flush();
        update_list(&self.ctx, kind, name, false)?;
        if purge {
            // 等 Worker 程序真的結束，再刪資料夾
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::remove_dir_all(self.ctx.state_root.join(name))?;
            if kind == Kind::Installed {
                // 它的佇列（`<app>:<queue>`）裡還沒處理的訊息
                self.queues.purge_prefix(&format!("{name}:"))?;
            }
        }
        tracing::info!("[{name}] 已刪除{}", if purge { "（含資料）" } else { "" });
        Ok(())
    }

    /// 啟動時載入上次執行中新增的應用
    pub async fn load_runtime_apps(&self) {
        for kind in [Kind::Managed, Kind::Dynamic, Kind::Installed] {
            for name in read_list(&self.ctx, kind) {
                let entry = match (kind, &self.dynamic, &self.install) {
                    (Kind::Dynamic, None, _) => {
                        tracing::warn!("[{name}] rucloud.toml 沒有 [dynamic]，略過");
                        continue;
                    }
                    (Kind::Installed, _, None) => {
                        tracing::warn!("[{name}] rucloud.toml 沒有 [install]，略過");
                        continue;
                    }
                    (Kind::Dynamic, Some(d), _) => runtime_entry(Some(dynamic_limits(d)), &self.ctx, &name),
                    (Kind::Installed, _, Some(i)) => install_entry(i, &self.ctx, &name),
                    _ => runtime_entry(None, &self.ctx, &name),
                };
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::error!("[{name}] 無法載入：{e:#}");
                        continue;
                    }
                };
                let code = code_dir(&self.ctx, &name, &entry.path);
                if code == entry.path {
                    tracing::warn!("[{name}] 沒有部署過的版本，略過");
                    continue;
                }
                let ctx = self.ctx.clone();
                match tokio::task::spawn_blocking(move || Slot::create(&entry, &ctx, &code)).await {
                    Ok(Ok(slot)) => match self.registry.insert(slot.clone(), kind) {
                        Ok(()) => self.start_app(&slot, kind),
                        Err(e) => tracing::error!("[{name}] 無法載入：{e:#}"),
                    },
                    Ok(Err(e)) => tracing::error!("[{name}] 無法載入：{e:#}"),
                    Err(e) => tracing::error!("[{name}] 無法載入：{e}"),
                }
            }
        }
    }

    /// 給 spawn_blocking 用的輕量複本（共用同一份清單與設定）
    fn clone_handle(&self) -> Deployer {
        Deployer {
            ctx: self.ctx.clone(),
            registry: self.registry.clone(),
            queues: self.queues.clone(),
            grace: self.grace,
            dynamic: self.dynamic.clone(),
            install: self.install.clone(),
            dynamic_lock: Default::default(),
        }
    }
}

/// 啟動某個版本的背景工作：cron、佇列消費者、Durable Object 鬧鐘、KV 過期清理、開發模式的檔案監看
pub fn restart_background(slot: &Slot, app: &Arc<App>, queues: &Arc<Queues>) {
    let token = CancellationToken::new();
    let old = std::mem::replace(&mut *slot.background.lock().unwrap(), token.clone());
    old.cancel();
    let spawn = |f: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>| {
        let t = token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = t.cancelled() => {}
                _ = f => {}
            }
        });
    };
    for cron in &app.cfg.triggers.crons {
        spawn(Box::pin(crate::server::cron_loop(app.clone(), cron.clone())));
    }
    for consumer in app.cfg.queues.consumers.iter().filter(|c| c.kind.as_deref() != Some("http_pull")) {
        spawn(Box::pin(queues.clone().consume(app.clone(), consumer.clone())));
    }
    if !app.cfg.durable_objects.bindings.is_empty() {
        spawn(Box::pin(crate::server::alarm_loop(app.clone())));
    }
    spawn(Box::pin(crate::server::purge_loop(app.clone())));
    // 監看檔案只對設定檔的 path 有意義（部署的版本不會被改）
    if slot.entry.watch && app.dir.starts_with(slot.entry.path.canonicalize().unwrap_or_default()) {
        spawn(Box::pin(crate::server::watch_loop(app.clone())));
    }
}

/// `rucloud deploy` 用：把應用資料夾打包成 tar.gz（跳過 .git、node_modules 以外的暫存與密鑰檔）
pub fn pack(dir: &Path) -> Result<Vec<u8>> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for e in std::fs::read_dir(dir.join(&rel))? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if matches!(name.as_str(), ".git" | ".wrangler" | ".rucloud" | "target" | ".DS_Store")
                || name.starts_with(".dev.vars")
                || name == ".env"
                || name.starts_with(".env.")
            {
                continue;
            }
            let path = rel.join(&name);
            let meta = e.metadata()?;
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let mut f = std::fs::File::open(e.path())?;
                builder.append_file(&path, &mut f)?;
            }
        }
    }
    Ok(builder.into_inner()?.finish()?)
}
