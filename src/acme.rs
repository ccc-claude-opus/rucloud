//! 自動憑證（ACME，例如 Let's Encrypt）：每個網域一張憑證，存在 <state>/acme/。
//!
//! * 啟動時替所有應用的網域申請（rucloud.toml 的 hosts、wrangler 的 routes、[domain] 的 <名稱>.<base>）
//! * on-demand：第一次有人連到還沒有憑證的網域時才申請（例如執行中新增的應用）；
//!   只發給「確實屬於某個應用」的網域，那條連線的交握會等申請完成
//! * 到期前 30 天自動續期
//! * 驗證方式：TLS-ALPN-01（Let's Encrypt 連到 443 埠驗證，不需要 DNS API）
//! * 萬用字元憑證（*.example.com）：DNS-01，透過 DNS 供應商的 API 建立 TXT 記錄（Cloudflare、Linode）；
//!   被涵蓋的子網域不再個別申請，不會撞到每週的發證數量上限

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
    /// 萬用字元憑證：申請 *.<網域> 與 <網域>（需要 dns）。不寫時用 [domain] 的 base
    #[serde(default)]
    pub wildcard: Vec<String>,
    /// DNS 供應商的 API（DNS-01 驗證用）
    pub dns: Option<DnsCfg>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct DnsCfg {
    /// cloudflare 或 linode
    pub provider: String,
    /// API token；不寫時讀環境變數 CLOUDFLARE_API_TOKEN / LINODE_TOKEN
    pub api_token: Option<String>,
    /// API 的網址（測試用）
    pub api_url: Option<String>,
    /// 建立 TXT 記錄後等幾秒才請 CA 驗證（等 DNS 生效）
    #[serde(default = "propagation")]
    pub propagation_seconds: u64,
}

fn propagation() -> u64 {
    30
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
    /// 萬用字元憑證涵蓋的網域（example.com → *.example.com 與 example.com）
    wildcard: Vec<String>,
    dns: Option<Dns>,
}

/// 檔名：*.example.com 存成 _wildcard.example.com
fn file_key(host: &str) -> String {
    host.strip_prefix("*.")
        .map(|r| format!("_wildcard.{r}"))
        .unwrap_or_else(|| host.to_string())
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
        let dns = cfg.dns.as_ref().map(Dns::new).transpose()?;
        if !cfg.wildcard.is_empty() && dns.is_none() {
            bail!("[tls.acme] wildcard 需要 dns（DNS 供應商的 API）");
        }
        let wildcard = cfg
            .wildcard
            .iter()
            .map(|w| w.trim_start_matches("*.").to_ascii_lowercase())
            .collect();
        let acme = Acme {
            wildcard,
            dns,
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
            let Some(file) = name.strip_suffix(".crt").map(String::from) else {
                continue;
            };
            let key_path = acme.dir.join("certs").join(format!("{file}.key"));
            let host = file.strip_prefix("_wildcard.").map(|r| format!("*.{r}")).unwrap_or(file);
            let loaded = std::fs::read_to_string(&path)
                .and_then(|c| std::fs::read_to_string(&key_path).map(|k| (c, k)))
                .map_err(anyhow::Error::from)
                .and_then(|(c, k)| certified_key(&c, &k));
            match loaded {
                Ok(ck) => {
                    let mut certs = acme.certs.write().unwrap();
                    // 萬用字元憑證也涵蓋網域本身
                    if let Some(base) = host.strip_prefix("*.") {
                        certs.insert(base.to_string(), ck.clone());
                    }
                    certs.insert(host, ck);
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
        lookup(&self.certs.read().unwrap(), host).is_some()
    }

    /// 這個網域被哪個萬用字元憑證涵蓋（只涵蓋一層子網域）
    fn covered_by(&self, host: &str) -> Option<String> {
        self.wildcard
            .iter()
            .find(|b| {
                host == b.as_str()
                    || host
                        .strip_suffix(b.as_str())
                        .and_then(|p| p.strip_suffix('.'))
                        .is_some_and(|l| !l.contains('.'))
            })
            .map(|b| format!("*.{b}"))
    }

    pub fn challenge(&self, host: &str) -> Option<Arc<CertifiedKey>> {
        self.challenges.read().unwrap().get(host).cloned()
    }

    fn needs(&self, host: &str) -> bool {
        let key = self.covered_by(host).unwrap_or_else(|| host.to_string());
        match self.certs.read().unwrap().get(&key) {
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
        let mut host = host.to_ascii_lowercase();
        if !self.needs(&host) {
            return Ok(());
        }
        if let Some(w) = self.covered_by(&host) {
            host = w; // 申請萬用字元憑證
        } else if !self.allowed(&host) {
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
        let result = if host.starts_with("*.") {
            self.issue_wildcard(&host).await
        } else {
            self.issue(&host).await
        };
        match result {
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
        self.save(host, &chain_pem, &key_pem)
    }

    fn save(&self, host: &str, chain_pem: &str, key_pem: &str) -> Result<()> {
        let ck = certified_key(chain_pem, key_pem)?;
        // 檔名不能用 with_extension：網域裡的 .test、.com 會被當成副檔名
        let certs_dir = self.dir.join("certs");
        let key_path = certs_dir.join(format!("{}.key", file_key(host)));
        std::fs::write(&key_path, key_pem)?;
        #[cfg(unix)]
        std::fs::set_permissions(&key_path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        std::fs::write(certs_dir.join(format!("{}.crt", file_key(host))), chain_pem)?;
        let mut certs = self.certs.write().unwrap();
        if let Some(base) = host.strip_prefix("*.") {
            certs.insert(base.to_string(), ck.clone());
        }
        certs.insert(host.to_string(), ck);
        Ok(())
    }

    /// 萬用字元憑證：*.base 與 base，DNS-01 驗證
    async fn issue_wildcard(&self, wild: &str) -> Result<()> {
        let dns = self.dns.as_ref().context("萬用字元憑證需要 [tls.acme] dns")?;
        let base = wild.trim_start_matches("*.");
        let account = self.account().await?;
        let ids = [Identifier::Dns(wild.to_string()), Identifier::Dns(base.to_string())];
        let mut order = account
            .new_order(&NewOrder::new(&ids))
            .await
            .map_err(|e| anyhow!("建立訂單：{e}"))?;
        // 第一輪：建立所有 TXT 記錄（*.base 與 base 都是 _acme-challenge.base，兩個值並存）
        let mut records = Vec::new();
        let result = async {
            let mut authzs = order.authorizations();
            while let Some(a) = authzs.next().await {
                let mut authz = a.map_err(|e| anyhow!("{e}"))?;
                if authz.status == AuthorizationStatus::Valid {
                    continue;
                }
                let ch = authz.challenge(ChallengeType::Dns01).context("ACME 伺服器沒有提供 DNS-01 驗證")?;
                let Identifier::Dns(name) = &ch.identifier().identifier else {
                    bail!("不支援的識別")
                };
                let fqdn = format!("_acme-challenge.{name}");
                records.push(dns.create(&fqdn, &ch.key_authorization().dns_value()).await?);
            }
            if !records.is_empty() {
                tokio::time::sleep(Duration::from_secs(dns.propagation)).await;
            }
            // 第二輪：DNS 生效後請 CA 驗證
            let mut authzs = order.authorizations();
            while let Some(a) = authzs.next().await {
                let mut authz = a.map_err(|e| anyhow!("{e}"))?;
                if authz.status != AuthorizationStatus::Pending {
                    continue;
                }
                let mut ch = authz.challenge(ChallengeType::Dns01).context("ACME 伺服器沒有提供 DNS-01 驗證")?;
                ch.set_ready().await.map_err(|e| anyhow!("{e}"))?;
            }
            let status = order
                .poll_ready(&RetryPolicy::default())
                .await
                .map_err(|e| anyhow!("等待驗證：{e}"))?;
            if status != OrderStatus::Ready {
                bail!("驗證沒有通過（{status:?}）");
            }
            let key_pem = order.finalize().await.map_err(|e| anyhow!("送出 CSR：{e}"))?;
            let chain_pem = order
                .poll_certificate(&RetryPolicy::default())
                .await
                .map_err(|e| anyhow!("取得憑證：{e}"))?;
            self.save(wild, &chain_pem, &key_pem)
        }
        .await;
        for r in &records {
            if let Err(e) = dns.delete(r).await {
                tracing::warn!("ACME：刪除 TXT 記錄失敗：{e:#}");
            }
        }
        result
    }

    /// 背景工作：先替現有的網域申請，之後每 12 小時檢查續期
    pub async fn run(self: Arc<Self>, hosts: impl Fn() -> Vec<String> + Send + 'static) {
        loop {
            // 萬用字元憑證先申請：涵蓋的網域就不必一個一個申請
            for w in self.wildcard.clone() {
                let _ = self.ensure(&w).await;
            }
            let mut list = hosts();
            list.extend(self.cfg.domains.iter().map(|d| d.to_ascii_lowercase()));
            list.extend(self.certs.read().unwrap().keys().cloned());
            list.sort();
            list.dedup();
            for h in list
                .into_iter()
                .filter(|h| !h.starts_with("*.") && self.covered_by(h).is_none() && self.allowed(h) && self.needs(h))
            {
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
        lookup(&self.0.certs.read().unwrap(), &host)
    }
}

/// 先找完全相同的網域，再找涵蓋它的萬用字元憑證（只涵蓋一層）
fn lookup(certs: &HashMap<String, (Arc<CertifiedKey>, SystemTime)>, host: &str) -> Option<Arc<CertifiedKey>> {
    certs
        .get(host)
        .or_else(|| host.split_once('.').and_then(|(_, rest)| certs.get(&format!("*.{rest}"))))
        .map(|(ck, _)| ck.clone())
}

// ---------- DNS 供應商（DNS-01） ----------

pub struct Dns {
    provider: String,
    token: String,
    api: String,
    propagation: u64,
    http: reqwest::Client,
}

/// 建立的 TXT 記錄：(zone id, record id)
pub struct Record(String, String);

impl Dns {
    fn new(cfg: &DnsCfg) -> Result<Dns> {
        let (env, api) = match cfg.provider.as_str() {
            "cloudflare" => ("CLOUDFLARE_API_TOKEN", "https://api.cloudflare.com/client/v4"),
            "linode" => ("LINODE_TOKEN", "https://api.linode.com/v4"),
            p => bail!("不支援的 DNS 供應商 {p}（cloudflare、linode）"),
        };
        let token = cfg
            .api_token
            .clone()
            .or_else(|| std::env::var(env).ok())
            .with_context(|| format!("[tls.acme.dns] 缺 api_token（或環境變數 {env}）"))?;
        Ok(Dns {
            provider: cfg.provider.clone(),
            token,
            api: cfg.api_url.clone().unwrap_or_else(|| api.into()).trim_end_matches('/').to_string(),
            propagation: cfg.propagation_seconds,
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?,
        })
    }

    async fn call(&self, rb: reqwest::RequestBuilder) -> Result<serde_json::Value> {
        let res = rb.bearer_auth(&self.token).send().await?;
        let status = res.status();
        let v: serde_json::Value = res.json().await.unwrap_or_default();
        if !status.is_success() || v["success"] == false {
            bail!("{} API {status}：{}", self.provider, v);
        }
        Ok(v)
    }

    /// 找管理這個名稱的 zone：從最長的父網域往上找
    async fn zone(&self, fqdn: &str) -> Result<(String, String)> {
        let labels: Vec<&str> = fqdn.split('.').collect();
        for i in 1..labels.len().saturating_sub(1) {
            let cand = labels[i..].join(".");
            let found = match self.provider.as_str() {
                "cloudflare" => self
                    .call(self.http.get(format!("{}/zones", self.api)).query(&[("name", &cand)]))
                    .await?["result"][0]["id"]
                    .as_str()
                    .map(String::from),
                _ => self
                    .call(
                        self.http
                            .get(format!("{}/domains", self.api))
                            .header("X-Filter", serde_json::json!({ "domain": cand }).to_string()),
                    )
                    .await?["data"][0]["id"]
                    .as_i64()
                    .map(|n| n.to_string()),
            };
            if let Some(id) = found {
                return Ok((id, cand));
            }
        }
        bail!("{} 上找不到管理 {fqdn} 的網域", self.provider)
    }

    async fn create(&self, fqdn: &str, value: &str) -> Result<Record> {
        let (zone, zone_name) = self.zone(fqdn).await?;
        let id = match self.provider.as_str() {
            "cloudflare" => {
                let body = serde_json::json!({ "type": "TXT", "name": fqdn, "content": value, "ttl": 60 });
                let v = self
                    .call(self.http.post(format!("{}/zones/{zone}/dns_records", self.api)).json(&body))
                    .await?;
                v["result"]["id"].as_str().context("Cloudflare 沒有回傳記錄 id")?.to_string()
            }
            _ => {
                // Linode 的記錄名稱是相對於網域的
                let name = fqdn.strip_suffix(&format!(".{zone_name}")).unwrap_or(fqdn);
                let body = serde_json::json!({ "type": "TXT", "name": name, "target": value, "ttl_sec": 300 });
                let v = self
                    .call(self.http.post(format!("{}/domains/{zone}/records", self.api)).json(&body))
                    .await?;
                v["id"].as_i64().context("Linode 沒有回傳記錄 id")?.to_string()
            }
        };
        Ok(Record(zone, id))
    }

    async fn delete(&self, r: &Record) -> Result<()> {
        let url = match self.provider.as_str() {
            "cloudflare" => format!("{}/zones/{}/dns_records/{}", self.api, r.0, r.1),
            _ => format!("{}/domains/{}/records/{}", self.api, r.0, r.1),
        };
        self.call(self.http.delete(url)).await.map(|_| ())
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
