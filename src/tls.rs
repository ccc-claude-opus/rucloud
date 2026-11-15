//! HTTPS 入口：和 edge 一樣依 Host 分派到各應用。
//! 憑證二選一：自備的 PEM 檔，或 ACME（見 acme.rs：每個網域一張、on-demand、自動續期）。

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::extract::ConnectInfo;
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
#[serde(deny_unknown_fields)]
pub struct TlsCfg {
    #[serde(default = "https_port")]
    pub port: u16,
    /// 自備憑證（PEM，含中繼憑證）
    pub cert: Option<PathBuf>,
    pub key: Option<PathBuf>,
    /// 自動申請憑證
    pub acme: Option<crate::acme::AcmeCfg>,
    /// edge 的 HTTP 埠改成全部轉址到 HTTPS
    #[serde(default)]
    pub redirect_http: bool,
}

fn https_port() -> u16 {
    443
}
enum Certs {
    Static(Arc<ServerConfig>),
    Acme {
        acme: Arc<crate::acme::Acme>,
        normal: Arc<ServerConfig>,
    },
}

fn resolver_config(resolver: Arc<dyn rustls::server::ResolvesServerCert>) -> Result<ServerConfig> {
    Ok(ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_cert_resolver(resolver))
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
    registry: Arc<crate::registry::Registry>,
) -> Result<tokio::task::JoinHandle<()>> {
    let certs = match (&cfg.cert, &cfg.key, &cfg.acme) {
        (Some(c), Some(k), None) => Certs::Static(load_static(c, k)?),
        (None, None, Some(acme_cfg)) => {
            let reg = registry.clone();
            let acme = crate::acme::Acme::new(acme_cfg.clone(), state_root, Box::new(move |h| reg.owns_host(h)))?;
            let normal = with_alpn(resolver_config(Arc::new(crate::acme::Resolver(acme.clone())))?);
            // 先替所有應用的網域申請，之後定期續期
            let reg = registry.clone();
            tokio::spawn(acme.clone().run(move || reg.all_hosts()));
            Certs::Acme { acme, normal }
        }
        _ => bail!("[tls] 要設定 cert + key，或 acme（二選一）"),
    };
    let certs = Arc::new(certs);
    let addr: SocketAddr = format!("{bind}:{}", cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("無法監聽 {addr}"))?;
    tracing::info!("HTTPS：https://<網域>:{}（依 Host 分派）", cfg.port);
    // 讓應用知道是 https（request.url 的協定）；用內部標記，不用別人也能偽造的標頭
    let router = router.layer(axum::Extension(crate::gateway::ViaTls));
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
                    Certs::Acme { acme, normal } => {
                        let hello = start.client_hello();
                        let host = hello.server_name().map(|h| h.to_ascii_lowercase());
                        let is_challenge = hello.alpn().is_some_and(|mut a| a.any(|p| p == b"acme-tls/1"));
                        if is_challenge {
                            // CA 的 TLS-ALPN-01 驗證連線：給驗證用的憑證，完成交握就結束
                            let Some(ck) = host.as_deref().and_then(|h| acme.challenge(h)) else {
                                return;
                            };
                            let Ok(mut c) = resolver_config(Arc::new(crate::acme::Single(ck))) else {
                                return;
                            };
                            c.alpn_protocols = vec![b"acme-tls/1".to_vec()];
                            let _ = start.into_stream(Arc::new(c)).await;
                            return;
                        }
                        // on-demand：還沒有憑證、但確實屬於某個應用的網域，等申請完成再交握
                        if let Some(h) = &host
                            && acme.on_demand()
                            && !acme.has(h)
                            && acme.allowed(h)
                        {
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(90), acme.ensure(h)).await;
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
