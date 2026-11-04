//! WebSocket（HTTP upgrade）的轉發：用原始 TCP 把請求送給 Worker 程序，
//! 對方回 101 之後兩邊的位元組直接對接，rucloud 不解讀 WebSocket 訊框。

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_HEAD: usize = 64 * 1024;

pub fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// 把 upgrade 請求轉給 127.0.0.1:port。headers 是已經整理好（含內部標頭）的請求標頭。
pub async fn tunnel(mut req: Request, port: u16, path: &str, headers: &HeaderMap) -> Result<Response<Body>> {
    let upgrade = req.headers().get(header::UPGRADE).cloned();
    let on_upgrade = hyper::upgrade::on(&mut req);

    let mut head = format!(
        "{} {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: Upgrade\r\n",
        req.method()
    );
    if let Some(u) = upgrade.as_ref().and_then(|u| u.to_str().ok()) {
        head.push_str(&format!("upgrade: {u}\r\n"));
    }
    for (k, v) in headers {
        if matches!(
            k.as_str(),
            "host" | "connection" | "upgrade" | "content-length" | "transfer-encoding"
        ) {
            continue;
        }
        if let Ok(v) = v.to_str() {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    head.push_str("\r\n");

    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.context("連不到 Worker 程序")?;
    stream.set_nodelay(true)?;
    stream.write_all(head.as_bytes()).await?;

    // 讀回應標頭
    let mut buf = Vec::with_capacity(1024);
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            bail!("Worker 的回應標頭太長");
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            bail!("Worker 在回應前就關閉了連線");
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let text = String::from_utf8_lossy(&buf[..end]).into_owned();
    let rest = buf[end + 4..].to_vec();
    let mut lines = text.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .context("Worker 的回應格式不對")?;
    let mut builder = Response::builder().status(StatusCode::from_u16(status)?);
    let mut content_length = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let (k, v) = (k.trim(), v.trim());
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.parse::<usize>().ok();
            }
            builder = builder.header(k, v);
        }
    }

    if status != 101 {
        // 不升級（例如 401、426）：把整個回應讀完照樣回傳
        let mut body = rest;
        match content_length {
            Some(n) => {
                while body.len() < n {
                    let mut chunk = vec![0u8; (n - body.len()).min(64 * 1024)];
                    let k = stream.read(&mut chunk).await?;
                    if k == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..k]);
                }
            }
            None => {
                stream.read_to_end(&mut body).await?;
            }
        }
        return Ok(builder.body(Body::from(body))?);
    }

    tokio::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(u) => u,
            Err(e) => {
                tracing::debug!("WebSocket 升級失敗：{e}");
                return;
            }
        };
        let mut client = TokioIo::new(upgraded);
        if !rest.is_empty() && client.write_all(&rest).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut stream).await;
    });
    Ok(builder.body(Body::empty())?)
}
