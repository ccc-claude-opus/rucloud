//! HTTPS 入口：和 edge 一樣依 Host 分派到各應用。
//! 憑證二選一：自備的 PEM 檔，或 ACME（Let's Encrypt，TLS-ALPN-01 驗證，自動續期）。

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::extract::ConnectInfo;
use futures_util::StreamExt;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use rustls::ServerConfig;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize, Clone)]
pub struct TlsCfg {
    #[serde(default = "https_port")]
    pub port: u16,
    /// 自備憑證（PEM，含中繼憑證）
    pub cert: Option<PathBuf>,
    pub key: Option<PathBuf>,
    /// 自動申請憑證
    pub acme: Option<AcmeCfg>,
    /// edge 的 HTTP 埠改成全部轉址到 HTTPS
    #[serde(default)]
    pub redirect_http: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AcmeCfg {
    pub domains: Vec<String>,
    #[serde(default)]
    pub email: Vec<String>,
    /// false 時用 Let's Encrypt 的 staging（測試用，憑證不被瀏覽器信任）
    #[serde(default = "yes")]
    pub production: bool,
    /// 憑證快取，預設 <state>/acme
    pub cache_dir: Option<PathBuf>,
}

fn https_port() -> u16 {
    443
}
fn yes() -> bool {
    true
}

enum Certs {
    Static(Arc<ServerConfig>),
    Acme {
        normal: Arc<ServerConfig>,
        challenge: Arc<ServerConfig>,
    },
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn with_alpn(mut c: ServerConfig) -> Arc<ServerConfig> {
    c.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Arc::new(c)
}

fn load_static(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut std::io::BufReader::new(
        std::fs::File::open(cert).with_context(|| format!("讀不到憑證 {}", cert.display()))?,
    ))
    .collect::<Result<_, _>>()
    .context("憑證格式不對")?;
    if certs.is_empty() {
        bail!("{} 裡沒有憑證", cert.display());
    }
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(
        std::fs::File::open(key).with_context(|| format!("讀不到私鑰 {}", key.display()))?,
    ))
    .context("私鑰格式不對")?
    .with_context(|| format!("{} 裡沒有私鑰", key.display()))?;
    let cfg = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("憑證和私鑰不相符")?;
    Ok(with_alpn(cfg))
}

/// 起 HTTPS 伺服器；shutdown 取消時停止接受新連線，等現有連線結束
pub async fn serve(
    cfg: TlsCfg,
    bind: &str,
    state_root: &Path,
    router: Router,
    shutdown: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>> {
    let certs = match (&cfg.cert, &cfg.key, &cfg.acme) {
        (Some(c), Some(k), None) => Certs::Static(load_static(c, k)?),
        (None, None, Some(acme)) => {
            let mut state = rustls_acme::AcmeConfig::new(acme.domains.clone())
                .contact(acme.email.iter().map(|e| format!("mailto:{e}")))
                .cache(rustls_acme::caches::DirCache::new(
                    acme.cache_dir.clone().unwrap_or_else(|| state_root.join("acme")),
                ))
                .directory_lets_encrypt(acme.production)
                .state();
            let normal = with_alpn(
                ServerConfig::builder_with_provider(provider())
                    .with_safe_default_protocol_versions()?
                    .with_no_client_auth()
                    .with_cert_resolver(state.resolver()),
            );
            let challenge = state.challenge_rustls_config();
            // 推動申請與續期
            tokio::spawn(async move {
                while let Some(ev) = state.next().await {
                    match ev {
                        Ok(ok) => tracing::info!("ACME：{ok:?}"),
                        Err(e) => tracing::error!("ACME 錯誤：{e:?}"),
                    }
                }
            });
            Certs::Acme { normal, challenge }
        }
        _ => bail!("[tls] 要設定 cert + key，或 acme（二選一）"),
    };
    let certs = Arc::new(certs);
    let addr: SocketAddr = format!("{bind}:{}", cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("無法監聽 {addr}"))?;
    tracing::info!("HTTPS：https://<網域>:{}（依 Host 分派）", cfg.port);
    // 讓應用知道是 https（request.url 的協定）
    let router = router.layer(axum::middleware::map_request(|mut req: axum::extract::Request| async move {
        req.headers_mut()
            .insert("x-forwarded-proto", axum::http::HeaderValue::from_static("https"));
        req
    }));
    Ok(tokio::spawn(async move {
        let graceful = hyper_util::server::graceful::GracefulShutdown::new();
        loop {
            let (tcp, peer) = tokio::select! {
                r = listener.accept() => match r {
                    Ok(x) => x,
                    Err(_) => continue,
                },
                _ = shutdown.cancelled() => break,
            };
            let (certs, router, watcher) = (certs.clone(), router.clone(), graceful.watcher());
            tokio::spawn(async move {
                let _ = tcp.set_nodelay(true);
                let start = match tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), tcp).await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let config = match certs.as_ref() {
                    Certs::Static(c) => c.clone(),
                    Certs::Acme { normal, challenge } => {
                        if rustls_acme::is_tls_alpn_challenge(&start.client_hello()) {
                            // Let's Encrypt 的驗證連線：完成交握就結束
                            let _ = start.into_stream(challenge.clone()).await;
                            return;
                        }
                        normal.clone()
                    }
                };
                let Ok(tls) = start.into_stream(config).await else { return };
                let svc = TowerToHyperService::new(router.layer(axum::Extension(ConnectInfo(peer))));
                let conn = Builder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(TokioIo::new(tls), svc)
                    .into_owned();
                let _ = watcher.watch(conn).await;
            });
        }
        graceful.shutdown().await;
    }))
}
