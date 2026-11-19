//! 寄信（`send_email` 綁定）：透過設定的 SMTP 伺服器寄出。和 Cloudflare 一樣只能寄到**驗證過的收件地址**
//!（這裡是設定裡的 recipients，例如自己的信箱），綁定的 destination_address、allowed_destination_addresses、
//! allowed_sender_addresses 也照 Cloudflare 的規則檢查。
//! 設定存在 `<state_dir>/email.json`（管理 API 的 /email 修改）；沒有這個檔案時用 rucloud.toml 的 [email]。
use anyhow::{Context, Result, bail};
use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct EmailCfg {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// tls（直接 TLS，通常 465）、starttls（通常 587）、none（只限本機的 SMTP 伺服器）
    #[serde(default = "default_security")]
    pub security: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// 寄件者（SMTP 的 MAIL FROM），通常就是 SMTP 帳號的地址
    pub from: String,
    /// 驗證過的收件地址：只能寄給這些地址
    #[serde(default)]
    pub recipients: Vec<String>,
}

fn default_port() -> u16 {
    587
}
fn default_security() -> String {
    "starttls".into()
}

/// wrangler 設定的 send_email 綁定
#[derive(Debug, Deserialize, Clone)]
pub struct SendEmailCfg {
    pub name: String,
    pub destination_address: Option<String>,
    #[serde(default)]
    pub allowed_destination_addresses: Vec<String>,
    #[serde(default)]
    pub allowed_sender_addresses: Vec<String>,
}

pub struct Mailer {
    path: PathBuf,
    cfg: RwLock<Option<EmailCfg>>,
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn addr(s: &str) -> Result<Address> {
    s.trim().parse::<Address>().with_context(|| format!("不是有效的電子郵件地址：{s}"))
}

fn check(cfg: &EmailCfg) -> Result<()> {
    if cfg.host.trim().is_empty() {
        bail!("要填 SMTP 伺服器");
    }
    match cfg.security.as_str() {
        "tls" | "starttls" => {}
        "none" => {
            if !matches!(cfg.host.as_str(), "localhost" | "127.0.0.1" | "::1") {
                bail!("不加密（none）只能用在本機的 SMTP 伺服器，請用 tls 或 starttls");
            }
        }
        s => bail!("security 要是 tls、starttls 或 none（{s}）"),
    }
    addr(&cfg.from)?;
    for r in &cfg.recipients {
        addr(r)?;
    }
    Ok(())
}

impl Mailer {
    pub fn open(state_root: &std::path::Path, default: Option<EmailCfg>) -> Result<Self> {
        let path = state_root.join("email.json");
        let cfg = match std::fs::read(&path) {
            Ok(b) => Some(serde_json::from_slice(&b).context("email.json 讀不懂")?),
            Err(_) => default,
        };
        if let Some(c) = &cfg {
            check(c).context("寄信的設定")?;
        }
        Ok(Self { path, cfg: RwLock::new(cfg) })
    }

    /// 給管理 API 看的設定（不含密碼）
    pub fn describe(&self) -> Value {
        match &*self.cfg.read().unwrap() {
            None => json!({ "configured": false }),
            Some(c) => json!({
                "configured": true, "host": c.host, "port": c.port, "security": c.security, "username": c.username,
                "has_password": c.password.as_deref().is_some_and(|p| !p.is_empty()), "from": c.from, "recipients": c.recipients,
            }),
        }
    }

    /// 換設定；password 沒給時沿用原來的
    pub fn set(&self, mut cfg: EmailCfg) -> Result<()> {
        check(&cfg)?;
        if cfg.password.is_none() {
            cfg.password = self.cfg.read().unwrap().as_ref().and_then(|c| c.password.clone());
        }
        crate::secrets::write_private(&self.path, &serde_json::to_vec_pretty(&cfg)?)?;
        *self.cfg.write().unwrap() = Some(cfg);
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        let _ = std::fs::remove_file(&self.path);
        *self.cfg.write().unwrap() = None;
        Ok(())
    }

    /// 寄一封 MIME 格式的信。binding 是應用的 send_email 綁定（管理 API 的測試信沒有）
    pub async fn send(&self, binding: Option<&SendEmailCfg>, from: &str, to: &[String], raw: &[u8]) -> Result<()> {
        let cfg = self.cfg.read().unwrap().clone().context("還沒設定寄信（SMTP），請先在設定裡填寄信的帳號")?;
        if to.is_empty() {
            bail!("沒有收件人");
        }
        for t in to {
            if !cfg.recipients.iter().any(|r| same(r, t)) {
                bail!("{t} 不是驗證過的收件地址（只能寄給設定裡的收件地址）");
            }
            if let Some(b) = binding {
                if b.destination_address.as_deref().is_some_and(|d| !same(d, t)) {
                    bail!("這個綁定只能寄給 {}", b.destination_address.as_deref().unwrap_or_default());
                }
                if !b.allowed_destination_addresses.is_empty() && !b.allowed_destination_addresses.iter().any(|d| same(d, t)) {
                    bail!("{t} 不在這個綁定的 allowed_destination_addresses 裡");
                }
            }
        }
        if let Some(b) = binding
            && !b.allowed_sender_addresses.is_empty()
            && !b.allowed_sender_addresses.iter().any(|s| same(s, from))
        {
            bail!("{from} 不在這個綁定的 allowed_sender_addresses 裡");
        }
        addr(from)?;
        if raw.len() > 25 * 1024 * 1024 {
            bail!("信件太大（上限 25 MB）");
        }
        let envelope = Envelope::new(Some(addr(&cfg.from)?), to.iter().map(|t| addr(t)).collect::<Result<_>>()?)?;
        let mut builder = match cfg.security.as_str() {
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)?,
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)?,
            _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
        }
        .port(cfg.port)
        .timeout(Some(std::time::Duration::from_secs(30)));
        if let Some(u) = cfg.username.as_deref().filter(|u| !u.is_empty()) {
            builder = builder.credentials(Credentials::new(u.to_string(), cfg.password.clone().unwrap_or_default()));
        }
        builder.build().send_raw(&envelope, raw).await.context("SMTP 伺服器拒絕或連不上")?;
        Ok(())
    }
}
