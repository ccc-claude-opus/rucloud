//! 部署：版本存在 `<state>/<應用>/versions/<id>/`，`versions.json` 記錄清單與目前版本。
//! 換版時先把新版本的 Worker 程序起好，再把槽裡的 App 換掉，舊版本等一段時間（讓進行中的請求做完）才關。

use crate::app::{App, Ctx, Slot};
use crate::queues::Queues;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    pub slots: BTreeMap<String, Arc<Slot>>,
    pub queues: Arc<Queues>,
    /// 舊版本留多久才關
    pub grace: Duration,
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
    pub fn slot(&self, app: &str) -> Result<&Arc<Slot>> {
        self.slots.get(app).with_context(|| format!("找不到應用 {app}"))
    }

    /// 收一個 tar.gz，解到新的版本資料夾。檢查 wrangler 設定讀得起來才算數
    pub fn store(&self, app: &str, tar_gz: &[u8], message: &str) -> Result<Version> {
        let slot = self.slot(app)?;
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
                // unpack_in 會拒絕 .. 與絕對路徑
                if !entry.unpack_in(&tmp)? {
                    bail!("壓縮檔裡有不安全的路徑：{}", entry.path()?.display());
                }
                if kind.is_file() {
                    files += 1;
                    bytes += entry.header().size()?;
                }
            }
            crate::config::load_wrangler(&tmp, slot.entry.env.as_deref()).context("上傳的版本裡的 wrangler 設定有問題")?;
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
        let slot = self.slot(app)?.clone();
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
        if let Some(pool) = &new.pool {
            // 等所有程序都起來；只要有一個程序結束（例如語法錯誤）就判定失敗，不必等到逾時
            let started = std::time::Instant::now();
            loop {
                if pool.ready_count() == pool.len() {
                    break;
                }
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
                    bail!("新版本的 Worker 起不來，維持原本的版本。\n{}", recent.join("\n"));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let old = slot.set(new.clone());
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
    for consumer in &app.cfg.queues.consumers {
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
