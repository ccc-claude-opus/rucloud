//! 出口代理：關在 network namespace 裡的 Worker（[isolation]）連到外面的唯一通道。
//! 每個可以連外的程序池一個 Unix socket（`<程序池的資料夾>/egress.sock`）；Worker 程序裡的轉送把
//! `HTTP(S)_PROXY=http://127.0.0.1:3128` 接過來。只放行網際網路上的位址：在籠子外面查 DNS，
//! 本機、私有網路、CGNAT、連結本地等位址一律拒絕（和執行環境裡 JS 的檢查一樣，但 Worker 繞不過）。
use anyhow::{Context, Result, bail};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;

/// 網際網路上的位址（不是本機、私有網路、CGNAT、連結本地、多播…）
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..128).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..32).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v6.segments()[0];
            !(v6.is_unspecified() || v6.is_loopback() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80 || (s & 0xff00) == 0xff00)
        }
    }
}

/// 查 DNS，所有位址都要是網際網路上的（有一個不是就拒絕）；回傳要連的位址
async fn resolve_public(host: &str, port: u16) -> Result<SocketAddr> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        bail!("{host}：只能連到網際網路上的位址");
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await.with_context(|| format!("查不到 {host}"))?.collect();
    if addrs.is_empty() {
        bail!("查不到 {host}");
    }
    if let Some(a) = addrs.iter().find(|a| !is_public(a.ip())) {
        bail!("{host}（{}）：只能連到網際網路上的位址", a.ip());
    }
    Ok(addrs[0])
}

async fn refuse(c: &mut UnixStream, status: &str, msg: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{msg}",
        msg.len()
    );
    let _ = c.write_all(resp.as_bytes()).await;
}

/// `CONNECT host:port`（HTTPS、WebSocket over TLS），或 `GET http://host/path`（HTTP）
async fn handle(mut c: UnixStream) -> Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 32 * 1024 {
            refuse(&mut c, "431 Request Header Fields Too Large", "標頭太大").await;
            return Ok(());
        }
        let mut chunk = [0u8; 4096];
        let n = c.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let rest = buf[end..].to_vec();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (method, target, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("HTTP/1.1"));

    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = target.rsplit_once(':').context("CONNECT 的目標要是 host:port")?;
        let port: u16 = port.parse().context("埠號不對")?;
        let addr = match resolve_public(host, port).await {
            Ok(a) => a,
            Err(e) => return Ok(refuse(&mut c, "403 Forbidden", &format!("{e:#}")).await),
        };
        let mut up = match TcpStream::connect(addr).await {
            Ok(s) => s,
            Err(e) => return Ok(refuse(&mut c, "502 Bad Gateway", &format!("連不上 {host}：{e}")).await),
        };
        c.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
        if !rest.is_empty() {
            up.write_all(&rest).await?;
        }
        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        return Ok(());
    }

    // 一般的 HTTP：絕對網址 → 連到那台主機，請求列改成路徑；這條連線只用一次（connection: close），
    // 免得同一條代理連線被拿去連別的主機
    let Some(after) = target.strip_prefix("http://") else {
        refuse(&mut c, "400 Bad Request", "只接受 CONNECT 或 http:// 的絕對網址").await;
        return Ok(());
    };
    let (authority, path) = after.split_at(after.find('/').unwrap_or(after.len()));
    let path = if path.is_empty() { "/" } else { path };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || authority.starts_with('[') => match p.parse::<u16>() {
            Ok(p) => (h, p),
            Err(_) => (authority, 80),
        },
        _ => (authority, 80),
    };
    let addr = match resolve_public(host, port).await {
        Ok(a) => a,
        Err(e) => return Ok(refuse(&mut c, "403 Forbidden", &format!("{e:#}")).await),
    };
    let mut up = match TcpStream::connect(addr).await {
        Ok(s) => s,
        Err(e) => return Ok(refuse(&mut c, "502 Bad Gateway", &format!("連不上 {host}：{e}")).await),
    };
    let mut out = format!("{method} {path} {version}\r\n");
    for l in lines.filter(|l| !l.is_empty()) {
        let name = l.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        if matches!(name.as_str(), "proxy-connection" | "proxy-authorization" | "connection" | "keep-alive") {
            continue;
        }
        out.push_str(l);
        out.push_str("\r\n");
    }
    out.push_str("connection: close\r\n\r\n");
    up.write_all(out.as_bytes()).await?;
    if !rest.is_empty() {
        up.write_all(&rest).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
    Ok(())
}

/// 在 path 聽出口代理，直到 stop
pub fn serve(path: &Path, stop: CancellationToken, app: String) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).with_context(|| format!("出口代理 {}", path.display()))?;
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                r = listener.accept() => match r {
                    Ok((c, _)) => {
                        let app = app.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle(c).await {
                                tracing::debug!("[{app}] 出口代理：{e:#}");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("[{app}] 出口代理：{e}");
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                },
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_public;

    #[test]
    fn public_addresses() {
        for a in ["1.1.1.1", "8.8.8.8", "2606:4700::1111"] {
            assert!(is_public(a.parse().unwrap()), "{a}");
        }
        for a in ["127.0.0.1", "10.0.2.2", "192.168.1.1", "172.16.0.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"] {
            assert!(!is_public(a.parse().unwrap()), "{a}");
        }
    }
}
