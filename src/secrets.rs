//! 應用的密鑰（rucloud secret put，對應 wrangler secret put）：存在 <state>/<應用>/secrets.json（權限 600），
//! 放進 Worker 的 env，蓋過 .dev.vars 與 env_file。值只寫入、不能讀回來。

use anyhow::{Result, bail};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn path(state_root: &Path, app: &str) -> PathBuf {
    state_root.join(app).join("secrets.json")
}

pub fn load(state_root: &Path, app: &str) -> BTreeMap<String, String> {
    std::fs::read_to_string(path(state_root, app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(state_root: &Path, app: &str, m: &BTreeMap<String, String>) -> Result<()> {
    write_private(&path(state_root, app), &serde_json::to_vec_pretty(m)?)
}

/// 只有自己讀得到（0600）的檔案，先寫暫存檔再換名
pub fn write_private(p: &Path, data: &[u8]) -> Result<()> {
    std::fs::create_dir_all(p.parent().unwrap())?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    #[cfg(unix)]
    std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

pub fn valid_name(name: &str) -> Result<()> {
    let ok = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 128;
    if !ok {
        bail!("密鑰名稱只能有英文、數字與 _，而且不能以數字開頭：{name}");
    }
    Ok(())
}

pub fn put(state_root: &Path, app: &str, name: &str, value: &str) -> Result<()> {
    valid_name(name)?;
    if value.len() > 64 * 1024 {
        bail!("密鑰太長（最多 64 KB）");
    }
    let mut m = load(state_root, app);
    m.insert(name.to_string(), value.to_string());
    save(state_root, app, &m)
}

/// 回傳有沒有刪到
pub fn delete(state_root: &Path, app: &str, name: &str) -> Result<bool> {
    let mut m = load(state_root, app);
    let existed = m.remove(name).is_some();
    if existed {
        save(state_root, app, &m)?;
    }
    Ok(existed)
}
