//! 自動憑證（ACME，例如 Let's Encrypt）：每個網域一張憑證，存在 <state>/acme/。
//!
//! * 啟動時替所有應用的網域申請（rucloud.toml 的 hosts、wrangler 的 routes、[domain] 的 <名稱>.<base>）
//! * on-demand：第一次有人連到還沒有憑證的網域時才申請（例如執行中新增的應用）；
//!   只發給「確實屬於某個應用」的網域，那條連線的交握會等申請完成
//! * 到期前 30 天自動續期
//! * 驗證方式：TLS-ALPN-01（Let's Encrypt 連到 443 埠驗證，不需要 DNS API）

use anyhow::{Context, Result, anyhow, bail};
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus, RetryPolicy,
};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct AcmeCfg {
    /// 除了應用的網域以外，額外要申請的網域
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub email: Vec<String>,
    /// false 時用 Let's Encrypt 的 staging（測試用，憑證不被瀏覽器信任）
    #[serde(default = "yes")]
    pub production: bool,
    /// 第一次有人連到還沒有憑證的網域時才申請（只限屬於某個應用的網域）
    #[serde(default = "yes")]
    pub on_demand: bool,
    /// 自訂 ACME 伺服器（預設 Let's Encrypt）
    pub directory: Option<String>,
    /// ACME 伺服器的根憑證（PEM），例如測試用的 Pebble
    pub ca_root: Option<PathBuf>,
    /// 憑證存放處，預設 <state>/acme
    pub cache_dir: Option<PathBuf>,
}

fn yes() -> bool {
    true
}

/// 申請失敗後多久才再試同一個網域（避免撞到 Let's Encrypt 的失敗次數上限）
const RETRY_AFTER: Duration = Duration::from_secs(600);
/// 到期前多久續期
const RENEW_BEFORE: Duration = Duration::from_secs(30 * 86400);

pub struct Acme {
    cfg: AcmeCfg,
    dir: PathBuf,
    account: tokio::sync::OnceCell<Account>,
    certs: RwLock<HashMap<String, (Arc<CertifiedKey>, SystemTime)>>,
    /// TLS-ALPN-01 驗證用的憑證：網域 → 憑證
    challenges: RwLock<HashMap<String, Arc<CertifiedKey>>>,
    /// 同一個網域同時只申請一次
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    failed: Mutex<HashMap<String, Instant>>,
    /// 這個網域可以申請嗎（屬於某個應用，或在 domains 裡）
    allowed: Box<dyn Fn(&str) -> bool + Send + Sync>,
}

/// 能向公開的 CA 申請憑證的網域（localhost 與 IP 不行）
pub fn issuable(host: &str) -> bool {
    host.contains('.') && !host.ends_with(".localhost") && host.parse::<std::net::IpAddr>().is_err() && !host.contains('*')
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn certified_key(chain_pem: &str, key_pem: &str) -> Result<(Arc<CertifiedKey>, SystemTime)> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut chain_pem.as_bytes()).collect::<Result<_, _>>()?;
    let first = certs.first().context("憑證是空的")?;
    let (_, x509) = x509_parser::parse_x509_certificate(first).map_err(|e| anyhow!("憑證格式不對：{e}"))?;
    let not_after = SystemTime::UNIX_EPOCH + Duration::from_secs(x509.validity().not_after.timestamp().max(0) as u64);
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())?.context("沒有私鑰")?;
    let signer = provider().key_provider.load_private_key(key)?;
    Ok((Arc::new(CertifiedKey::new(certs, signer)), not_after))
}

impl Acme {
    pub fn new(cfg: AcmeCfg, state_root: &Path, allowed: Box<dyn Fn(&str) -> bool + Send + Sync>) -> Result<Arc<Acme>> {
        let dir = cfg.cache_dir.clone().unwrap_or_else(|| state_root.join("acme"));
        std::fs::create_dir_all(dir.join("certs"))?;
        let acme = Acme {
            cfg,
            dir,
            account: Default::default(),
            certs: Default::default(),
            challenges: Default::default(),
            locks: Default::default(),
            failed: Default::default(),
            allowed,
        };
        // 之前申請過的憑證
        for e in std::fs::read_dir(acme.dir.join("certs"))?.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let Some(host) = name.strip_suffix(".crt").map(String::from) else {
                continue;
            };
            let key_path = acme.dir.join("certs").join(format!("{host}.key"));
            let loaded = std::fs::read_to_string(&path)
                .and_then(|c| std::fs::read_to_string(&key_path).map(|k| (c, k)))
                .map_err(anyhow::Error::from)
                .and_then(|(c, k)| certified_key(&c, &k));
            match loaded {
                Ok(ck) => {
                    acme.certs.write().unwrap().insert(host, ck);
                }
                Err(e) => tracing::warn!("讀不到 {host} 的憑證：{e:#}"),
            }
        }
        Ok(Arc::new(acme))
    }

    pub fn allowed(&self, host: &str) -> bool {
        issuable(host) && (self.cfg.domains.iter().any(|d| d.eq_ignore_ascii_case(host)) || (self.allowed)(host))
    }

    pub fn on_demand(&self) -> bool {
        self.cfg.on_demand
    }

    pub fn has(&self, host: &str) -> bool {
        self.certs.read().unwrap().contains_key(host)
    }

    pub fn challenge(&self, host: &str) -> Option<Arc<CertifiedKey>> {
        self.challenges.read().unwrap().get(host).cloned()
    }

    fn needs(&self, host: &str) -> bool {
        match self.certs.read().unwrap().get(host) {
            Some((_, not_after)) => SystemTime::now() + RENEW_BEFORE > *not_after,
            None => true,
        }
    }

    async fn account(&self) -> Result<&Account> {
        self.account
            .get_or_try_init(|| async {
                let builder = || match &self.cfg.ca_root {
                    Some(root) => Account::builder_with_root(root).map_err(|e| anyhow!("ACME 的根憑證：{e}")),
                    None => Account::builder().map_err(|e| anyhow!("{e}")),
                };
                let path = self.dir.join("account.json");
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let creds: AccountCredentials = serde_json::from_str(&text)?;
                    return builder()?.from_credentials(creds).await.map_err(|e| anyhow!("ACME 帳號：{e}"));
                }
                let url = self.cfg.directory.clone().unwrap_or_else(|| {
                    if self.cfg.production {
                        instant_acme::LetsEncrypt::Production.url().to_string()
                    } else {
                        instant_acme::LetsEncrypt::Staging.url().to_string()
                    }
                });
                let contact: Vec<String> = self.cfg.email.iter().map(|e| format!("mailto:{e}")).collect();
                let contact: Vec<&str> = contact.iter().map(String::as_str).collect();
                let (account, creds) = builder()?
                    .create(
                        &NewAccount {
                            contact: &contact,
                            terms_of_service_agreed: true,
                            only_return_existing: false,
                        },
                        url,
                        None,
                    )
                    .await
                    .map_err(|e| anyhow!("建立 ACME 帳號失敗：{e}"))?;
                std::fs::write(&path, serde_json::to_vec_pretty(&creds)?)?;
                #[cfg(unix)]
                std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
                Ok(account)
            })
            .await
    }

    /// 確保這個網域有有效的憑證（沒有或快到期就申請）
    pub async fn ensure(&self, host: &str) -> Result<()> {
        let host = host.to_ascii_lowercase();
        if !self.needs(&host) {
            return Ok(());
        }
        if !self.allowed(&host) {
            bail!("{host} 不屬於任何應用，不申請憑證");
        }
        let lock = self.locks.lock().unwrap().entry(host.clone()).or_default().clone();
        let _guard = lock.lock().await;
        if !self.needs(&host) {
            return Ok(()); // 等鎖的時候別人申請好了
        }
        if let Some(t) = self.failed.lock().unwrap().get(&host)
            && t.elapsed() < RETRY_AFTER
        {
            bail!("{host} 剛申請失敗，{} 秒後再試", (RETRY_AFTER - t.elapsed()).as_secs());
        }
        match self.issue(&host).await {
            Ok(()) => {
                self.failed.lock().unwrap().remove(&host);
                tracing::info!("ACME：{host} 的憑證已申請");
                Ok(())
            }
            Err(e) => {
                self.failed.lock().unwrap().insert(host.clone(), Instant::now());
                self.challenges.write().unwrap().remove(&host);
                tracing::error!("ACME：{host} 申請失敗：{e:#}");
                Err(e)
            }
        }
    }

    async fn issue(&self, host: &str) -> Result<()> {
        let account = self.account().await?;
        let ids = [Identifier::Dns(host.to_string())];
        let mut order = account
            .new_order(&NewOrder::new(&ids))
            .await
            .map_err(|e| anyhow!("建立訂單：{e}"))?;
        let mut authzs = order.authorizations();
        while let Some(a) = authzs.next().await {
            let mut authz = a.map_err(|e| anyhow!("{e}"))?;
            match authz.status {
                AuthorizationStatus::Valid => continue,
                AuthorizationStatus::Pending => {}
                s => bail!("驗證狀態 {s:?}"),
            }
            let mut ch = authz
                .challenge(ChallengeType::TlsAlpn01)
                .context("ACME 伺服器沒有提供 TLS-ALPN-01 驗證")?;
            // 驗證用的憑證：SAN 是網域，加上 acmeIdentifier 延伸欄位（金鑰授權的 SHA-256）
            let mut params = rcgen::CertificateParams::new(vec![host.to_string()])?;
            params.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(
                ch.key_authorization().digest().as_ref(),
            )];
            let key = rcgen::KeyPair::generate()?;
            let cert = params.self_signed(&key)?;
            let ck = certified_key(&cert.pem(), &key.serialize_pem())?.0;
            self.challenges.write().unwrap().insert(host.to_string(), ck);
            ch.set_ready().await.map_err(|e| anyhow!("{e}"))?;
        }
        let status = order
            .poll_ready(&RetryPolicy::default())
            .await
            .map_err(|e| anyhow!("等待驗證：{e}"))?;
        self.challenges.write().unwrap().remove(host);
        if status != OrderStatus::Ready {
            bail!("驗證沒有通過（{status:?}）");
        }
        let key_pem = order.finalize().await.map_err(|e| anyhow!("送出 CSR：{e}"))?;
        let chain_pem = order
            .poll_certificate(&RetryPolicy::default())
            .await
            .map_err(|e| anyhow!("取得憑證：{e}"))?;
        let ck = certified_key(&chain_pem, &key_pem)?;
        // 檔名不能用 with_extension：網域裡的 .test、.com 會被當成副檔名
        let certs_dir = self.dir.join("certs");
        let key_path = certs_dir.join(format!("{host}.key"));
        std::fs::write(&key_path, &key_pem)?;
        #[cfg(unix)]
        std::fs::set_permissions(&key_path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        std::fs::write(certs_dir.join(format!("{host}.crt")), &chain_pem)?;
        self.certs.write().unwrap().insert(host.to_string(), ck);
        Ok(())
    }

    /// 背景工作：先替現有的網域申請，之後每 12 小時檢查續期
    pub async fn run(self: Arc<Self>, hosts: impl Fn() -> Vec<String> + Send + 'static) {
        loop {
            let mut list = hosts();
            list.extend(self.cfg.domains.iter().map(|d| d.to_ascii_lowercase()));
            list.extend(self.certs.read().unwrap().keys().cloned());
            list.sort();
            list.dedup();
            for h in list.into_iter().filter(|h| self.allowed(h) && self.needs(h)) {
                let _ = self.ensure(&h).await;
            }
            tokio::time::sleep(Duration::from_secs(12 * 3600)).await;
        }
    }
}

/// 依 SNI 找憑證
pub struct Resolver(pub Arc<Acme>);

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("acme::Resolver")
    }
}

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let host = hello.server_name()?.to_ascii_lowercase();
        let certs = self.0.certs.read().unwrap();
        certs.get(&host).map(|(ck, _)| ck.clone())
    }
}

/// 只有一張憑證（TLS-ALPN-01 驗證連線用）
#[derive(Debug)]
pub struct Single(pub Arc<CertifiedKey>);

impl ResolvesServerCert for Single {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn issuable() {
        assert!(super::issuable("shop.example.com"));
        assert!(!super::issuable("localhost"));
        assert!(!super::issuable("shop.localhost"));
        assert!(!super::issuable("10.0.0.1"));
        assert!(!super::issuable("*.example.com"));
    }
}
