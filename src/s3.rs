//! R2 的 S3 相容 API：讓 aws-cli、rclone、boto3 這類工具直接存取 R2 bucket。
//!
//! * 驗證：AWS Signature V4（Authorization 標頭或 presigned URL），只接受設定的那一組金鑰
//! * 路徑風格：http://host:port/<bucket>/<key>（也接受 <bucket>.host 的虛擬主機風格）
//! * 操作：ListBuckets、ListObjects(V2)、Head/Get（含 Range）/Put/Delete/Copy Object、
//!   DeleteObjects、multipart upload（Create/UploadPart/Complete/Abort）、GetBucketLocation
//!
//! bucket 名稱就是 wrangler 設定裡的 bucket_name；同名的 bucket 以第一個應用為準。

use crate::app::App;
use crate::r2::R2;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, Response, StatusCode, header};
use axum::response::IntoResponse;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct S3Cfg {
    #[serde(default = "s3_port")]
    pub port: u16,
    pub access_key_id: String,
    pub secret_access_key: String,
}

fn s3_port() -> u16 {
    8780
}

pub struct S3 {
    cfg: S3Cfg,
    /// 所有應用；bucket 依目前版本的設定找（部署新版本可能新增 bucket）
    slots: Vec<Arc<crate::app::Slot>>,
    /// R2 事件通知用
    queues: Option<Arc<crate::queues::Queues>>,
}

struct S3Err(StatusCode, &'static str, String);

type R<T> = Result<T, S3Err>;

impl From<anyhow::Error> for S3Err {
    fn from(e: anyhow::Error) -> Self {
        let msg = format!("{e:#}");
        // r2.rs 的錯誤訊息以 S3 錯誤碼開頭時沿用
        for code in ["NoSuchUpload", "InvalidPartOrder", "InvalidPart"] {
            if msg.starts_with(code) {
                return S3Err(StatusCode::BAD_REQUEST, code, msg);
            }
        }
        S3Err(StatusCode::INTERNAL_SERVER_ERROR, "InternalError", msg)
    }
}

impl IntoResponse for S3Err {
    fn into_response(self) -> axum::response::Response {
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{}</Code><Message>{}</Message></Error>",
            self.1,
            esc(&self.2)
        );
        (self.0, [(header::CONTENT_TYPE, "application/xml")], body).into_response()
    }
}

fn err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> S3Err {
    S3Err(status, code, msg.into())
}

impl S3 {
    pub fn new(cfg: S3Cfg, slots: Vec<Arc<crate::app::Slot>>, queues: Arc<crate::queues::Queues>) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            slots,
            queues: Some(queues),
        })
    }

    /// 物件變動後送 R2 事件通知
    async fn notify(&self, bucket: &str, action: &'static str, key: &str) {
        let (Some(app), Some(queues)) = (self.buckets().remove(bucket), self.queues.clone()) else {
            return;
        };
        let (b, k) = (bucket.to_string(), key.to_string());
        let _ = tokio::task::spawn_blocking(move || {
            let obj = if action == "DeleteObject" {
                None
            } else {
                app.r2().ok().and_then(|r| r.head(&b, &k).ok().flatten())
            };
            crate::r2::notify(&app, &queues, &b, action, &k, obj.as_ref());
        })
        .await;
    }

    /// bucket 名稱 → 存放它的應用（同名時第一個為準）
    fn buckets(&self) -> BTreeMap<String, Arc<App>> {
        let mut out = BTreeMap::new();
        for slot in &self.slots {
            let app = slot.get();
            for name in app.r2_buckets.values() {
                out.entry(name.clone()).or_insert_with(|| app.clone());
            }
        }
        out
    }

    fn store(&self, bucket: &str) -> R<Arc<R2>> {
        let app = self
            .buckets()
            .remove(bucket)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "NoSuchBucket", format!("找不到 bucket {bucket}")))?;
        Ok(app.r2()?)
    }
}

pub fn router(s3: Arc<S3>) -> Router {
    Router::new()
        .fallback(handle)
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(s3)
}

async fn handle(State(s3): State<Arc<S3>>, req: Request) -> axum::response::Response {
    match dispatch(&s3, req).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

// ---------- 小工具 ----------

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn unesc(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// SigV4 用的 URI 編碼：除了 A-Z a-z 0-9 - _ . ~ 以外全部編碼
pub(crate) fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> String {
    urlencoding::decode(&s.replace('+', "%20"))
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

fn parse_query(q: Option<&str>) -> Vec<(String, String)> {
    q.unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (decode(k), decode(v)),
            None => (decode(p), String::new()),
        })
        .collect()
}

pub(crate) fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC 可以用任何長度的金鑰");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn http_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

fn iso_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn xml(status: StatusCode, body: String) -> axum::response::Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/xml")],
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{body}"),
    )
        .into_response()
}

/// 抓出 <tag>…</tag> 的所有內容（S3 的請求 XML 都很單純，不需要完整的解析器）
fn tags<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

// ---------- SigV4 驗證 ----------

fn verify(s3: &S3, method: &Method, path: &str, query: &[(String, String)], headers: &HeaderMap) -> R<()> {
    let denied = |m: &str| err(StatusCode::FORBIDDEN, "AccessDenied", m);
    let mismatch = || err(StatusCode::FORBIDDEN, "SignatureDoesNotMatch", "簽章不符");
    let hv = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("");
    let qv = |k: &str| query.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());

    let (credential, signed, signature, amz_date, payload, presigned) = if let Some(auth) = headers.get(header::AUTHORIZATION) {
        let auth = auth.to_str().map_err(|_| denied("Authorization 格式不對"))?;
        let rest = auth
            .strip_prefix("AWS4-HMAC-SHA256")
            .ok_or_else(|| denied("只支援 AWS4-HMAC-SHA256"))?;
        let mut cred = "";
        let mut sh = "";
        let mut sig = "";
        for part in rest.split(',') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("Credential=") {
                cred = v;
            } else if let Some(v) = part.strip_prefix("SignedHeaders=") {
                sh = v;
            } else if let Some(v) = part.strip_prefix("Signature=") {
                sig = v;
            }
        }
        let payload = if hv("x-amz-content-sha256").is_empty() {
            "UNSIGNED-PAYLOAD"
        } else {
            hv("x-amz-content-sha256")
        };
        (
            cred.to_string(),
            sh.to_string(),
            sig.to_string(),
            hv("x-amz-date").to_string(),
            payload.to_string(),
            false,
        )
    } else if qv("X-Amz-Algorithm") == Some("AWS4-HMAC-SHA256") {
        (
            qv("X-Amz-Credential").unwrap_or("").to_string(),
            qv("X-Amz-SignedHeaders").unwrap_or("").to_string(),
            qv("X-Amz-Signature").unwrap_or("").to_string(),
            qv("X-Amz-Date").unwrap_or("").to_string(),
            "UNSIGNED-PAYLOAD".to_string(),
            true,
        )
    } else {
        return Err(denied("需要 AWS Signature V4 驗證"));
    };

    let scope: Vec<&str> = credential.split('/').collect();
    if scope.len() != 5 || scope[4] != "aws4_request" {
        return Err(denied("Credential 格式不對"));
    }
    if scope[0] != s3.cfg.access_key_id {
        return Err(err(StatusCode::FORBIDDEN, "InvalidAccessKeyId", "不認識的 access key"));
    }
    let when = chrono::NaiveDateTime::parse_from_str(&amz_date, "%Y%m%dT%H%M%SZ")
        .map_err(|_| denied("X-Amz-Date 格式不對"))?
        .and_utc();
    let now = chrono::Utc::now();
    if presigned {
        let expires: i64 = qv("X-Amz-Expires").and_then(|v| v.parse().ok()).unwrap_or(0);
        if now > when + chrono::Duration::seconds(expires) {
            return Err(denied("presigned URL 已過期"));
        }
    } else if (now - when).num_minutes().abs() > 15 {
        return Err(err(StatusCode::FORBIDDEN, "RequestTimeTooSkewed", "請求時間和伺服器差太多"));
    }

    let mut q: Vec<(String, String)> = query
        .iter()
        .filter(|(k, _)| k != "X-Amz-Signature")
        .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
        .collect();
    q.sort();
    let canonical_query = q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let mut canonical_headers = String::new();
    for h in signed.split(';') {
        let values: Vec<String> = headers
            .get_all(h)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(|v| v.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        canonical_headers.push_str(&format!("{h}:{}\n", values.join(",")));
    }
    let canonical = format!("{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed}\n{payload}");
    let scope_str = scope[1..].join("/");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope_str}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let mut key = hmac(format!("AWS4{}", s3.cfg.secret_access_key).as_bytes(), scope[1]);
    for part in &scope[2..] {
        key = hmac(&key, part);
    }
    let expected = hex::encode(hmac(&key, &to_sign));
    // 固定時間比較
    if expected.len() != signature.len() || expected.bytes().zip(signature.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) != 0 {
        tracing::debug!("S3 簽章不符，canonical request：\n{canonical}");
        return Err(mismatch());
    }
    Ok(())
}

// ---------- 分派 ----------

async fn dispatch(s3: &S3, req: Request) -> R<axum::response::Response> {
    let method = req.method().clone();
    let raw_path = req.uri().path().to_string();
    let query = parse_query(req.uri().query());
    verify(s3, &method, &raw_path, &query, req.headers())?;
    let has = |k: &str| query.iter().any(|(a, _)| a == k);
    let qv = |k: &str| query.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());

    // 虛擬主機風格：<bucket>.host
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let vhost = host
        .split('.')
        .next()
        .filter(|b| host.contains('.') && s3.buckets().contains_key(*b))
        .map(String::from);
    let path = decode(raw_path.trim_start_matches('/'));
    let (bucket, key) = match vhost {
        Some(b) => (b, path),
        None => match path.split_once('/') {
            Some((b, k)) => (b.to_string(), k.to_string()),
            None => (path, String::new()),
        },
    };

    if bucket.is_empty() {
        return Ok(list_buckets(s3));
    }
    let r2 = s3.store(&bucket)?;
    if key.is_empty() {
        return match method {
            Method::GET if has("location") => Ok(xml(
                StatusCode::OK,
                "<LocationConstraint xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">auto</LocationConstraint>".into(),
            )),
            Method::GET => list_objects(r2, &bucket, &query).await,
            Method::HEAD => Ok(StatusCode::OK.into_response()),
            Method::POST if has("delete") => {
                let (resp, keys) = delete_objects(r2, &bucket, req).await?;
                for k in keys {
                    s3.notify(&bucket, "DeleteObject", &k).await;
                }
                Ok(resp)
            }
            _ => Err(err(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed", "不支援的 bucket 操作")),
        };
    }
    match method {
        Method::GET | Method::HEAD => get_object(r2, &bucket, &key, method == Method::HEAD, req.headers()).await,
        Method::PUT if has("partNumber") && has("uploadId") => {
            let n: u32 = qv("partNumber")
                .and_then(|v| v.parse().ok())
                .filter(|n| (1..=10000).contains(n))
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "InvalidArgument", "partNumber 要在 1–10000"))?;
            upload_part(r2, &bucket, &qv("uploadId").unwrap_or_default(), n, req).await
        }
        Method::PUT if req.headers().contains_key("x-amz-copy-source") => {
            let r = copy_object(s3, r2, &bucket, &key, req.headers()).await?;
            s3.notify(&bucket, "CopyObject", &key).await;
            Ok(r)
        }
        Method::PUT => {
            let r = put_object(r2, &bucket, &key, req).await?;
            s3.notify(&bucket, "PutObject", &key).await;
            Ok(r)
        }
        Method::DELETE if has("uploadId") => {
            let id = qv("uploadId").unwrap_or_default();
            run(move || r2.abort_upload(&id)).await?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Method::DELETE => {
            let (b, k) = (bucket.clone(), key.clone());
            run(move || r2.delete(&b, &[k])).await?;
            s3.notify(&bucket, "DeleteObject", &key).await;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Method::POST if has("uploads") => {
            let (http, custom) = metadata_from(req.headers());
            let (b, k) = (bucket.clone(), key.clone());
            let id = run(move || r2.create_upload(&b, &k, &http, &custom)).await?;
            Ok(xml(
                StatusCode::OK,
                format!(
                    "<InitiateMultipartUploadResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Bucket>{}</Bucket><Key>{}</Key><UploadId>{id}</UploadId></InitiateMultipartUploadResult>",
                    esc(&bucket),
                    esc(&key)
                ),
            ))
        }
        Method::POST if has("uploadId") => {
            let r = complete_upload(r2, &bucket, &key, &qv("uploadId").unwrap_or_default(), req).await?;
            s3.notify(&bucket, "CompleteMultipartUpload", &key).await;
            Ok(r)
        }
        _ => Err(err(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed", "不支援的操作")),
    }
}

async fn run<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> R<T> {
    Ok(tokio::task::spawn_blocking(f).await.map_err(|e| anyhow::anyhow!(e))??)
}

fn list_buckets(s3: &S3) -> axum::response::Response {
    let mut out = String::from(
        "<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>rucloud</ID><DisplayName>rucloud</DisplayName></Owner><Buckets>",
    );
    for name in s3.buckets().keys() {
        out.push_str(&format!(
            "<Bucket><Name>{}</Name><CreationDate>{}</CreationDate></Bucket>",
            esc(name),
            iso_date(0)
        ));
    }
    out.push_str("</Buckets></ListAllMyBucketsResult>");
    xml(StatusCode::OK, out)
}

async fn list_objects(r2: Arc<R2>, bucket: &str, query: &[(String, String)]) -> R<axum::response::Response> {
    let qv = |k: &str| query.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
    let v2 = qv("list-type").as_deref() == Some("2");
    let url_enc = qv("encoding-type").as_deref() == Some("url");
    let enc = |s: &str| if url_enc { uri_encode(s, true) } else { esc(s) };
    let prefix = qv("prefix").unwrap_or_default();
    let delimiter = qv("delimiter").filter(|d| !d.is_empty());
    let max: usize = qv("max-keys").and_then(|v| v.parse().ok()).unwrap_or(1000).clamp(1, 1000);
    let cursor = if v2 {
        qv("continuation-token")
            .and_then(|t| base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, t).ok())
            .and_then(|b| String::from_utf8(b).ok())
            .or_else(|| qv("start-after"))
    } else {
        qv("marker")
    };
    let (b, p, d) = (bucket.to_string(), prefix.clone(), delimiter.clone());
    let page = run(move || r2.list(&b, &p, max, cursor.as_deref(), d.as_deref())).await?;
    let objects = page["objects"].as_array().cloned().unwrap_or_default();
    let prefixes = page["delimitedPrefixes"].as_array().cloned().unwrap_or_default();
    let truncated = page["truncated"].as_bool().unwrap_or(false);
    let root = "ListBucketResult";
    let mut out = format!(
        "<{root} xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{}</Name><Prefix>{}</Prefix><MaxKeys>{max}</MaxKeys><IsTruncated>{truncated}</IsTruncated>",
        esc(bucket),
        enc(&prefix)
    );
    if let Some(d) = &delimiter {
        out.push_str(&format!("<Delimiter>{}</Delimiter>", enc(d)));
    }
    if url_enc {
        out.push_str("<EncodingType>url</EncodingType>");
    }
    if v2 {
        out.push_str(&format!("<KeyCount>{}</KeyCount>", objects.len() + prefixes.len()));
        if truncated && let Some(c) = page["cursor"].as_str() {
            let t = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, c);
            out.push_str(&format!("<NextContinuationToken>{t}</NextContinuationToken>"));
        }
    } else if truncated && let Some(c) = page["cursor"].as_str() {
        out.push_str(&format!("<NextMarker>{}</NextMarker>", enc(c)));
    }
    for o in &objects {
        out.push_str(&format!(
            "<Contents><Key>{}</Key><LastModified>{}</LastModified><ETag>&quot;{}&quot;</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
            enc(o["key"].as_str().unwrap_or("")),
            iso_date(o["uploaded"].as_i64().unwrap_or(0)),
            esc(o["etag"].as_str().unwrap_or("")),
            o["size"].as_u64().unwrap_or(0)
        ));
    }
    for p in prefixes.iter().filter_map(|p| p.as_str()) {
        out.push_str(&format!("<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>", enc(p)));
    }
    out.push_str(&format!("</{root}>"));
    Ok(xml(StatusCode::OK, out))
}

/// 從請求標頭取出 R2 的 httpMetadata 與 customMetadata（x-amz-meta-*）
fn metadata_from(h: &HeaderMap) -> (Value, Value) {
    let mut http = serde_json::Map::new();
    for (name, field) in [
        ("content-type", "contentType"),
        ("content-language", "contentLanguage"),
        ("content-disposition", "contentDisposition"),
        ("cache-control", "cacheControl"),
    ] {
        if let Some(v) = h.get(name).and_then(|v| v.to_str().ok()) {
            http.insert(field.into(), json!(v));
        }
    }
    if let Some(v) = h.get("content-encoding").and_then(|v| v.to_str().ok()) {
        let v: Vec<&str> = v
            .split(',')
            .map(str::trim)
            .filter(|e| *e != "aws-chunked" && !e.is_empty())
            .collect();
        if !v.is_empty() {
            http.insert("contentEncoding".into(), json!(v.join(", ")));
        }
    }
    let mut custom = serde_json::Map::new();
    for (k, v) in h {
        if let Some(name) = k.as_str().strip_prefix("x-amz-meta-")
            && let Ok(v) = v.to_str()
        {
            custom.insert(name.into(), json!(v));
        }
    }
    (Value::Object(http), Value::Object(custom))
}

fn is_aws_chunked(h: &HeaderMap) -> bool {
    h.get("x-amz-content-sha256")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("STREAMING-"))
        || h.get("content-encoding")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("aws-chunked"))
}

/// 收內容到暫存檔；簽章帶的是內容的 SHA-256 時要核對
async fn receive(r2: &R2, req: Request) -> R<(std::path::PathBuf, crate::r2::Received)> {
    let chunked = is_aws_chunked(req.headers());
    let declared = req
        .headers()
        .get("x-amz-content-sha256")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 64)
        .map(String::from);
    let tmp = r2.tmp_path();
    let got = crate::r2::receive(req.into_body(), chunked, &tmp).await?;
    if let Some(d) = declared
        && d != got.sha256
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(err(
            StatusCode::BAD_REQUEST,
            "XAmzContentSHA256Mismatch",
            "內容和 x-amz-content-sha256 不符",
        ));
    }
    Ok((tmp, got))
}

async fn put_object(r2: Arc<R2>, bucket: &str, key: &str, req: Request) -> R<axum::response::Response> {
    let (http, custom) = metadata_from(req.headers());
    let (tmp, got) = receive(&r2, req).await?;
    let (b, k) = (bucket.to_string(), key.to_string());
    let etag = got.md5.clone();
    run(move || r2.commit(&b, &k, &tmp, got.size, &got.md5, &http, &custom)).await?;
    Ok((StatusCode::OK, [(header::ETAG, format!("\"{etag}\""))]).into_response())
}

async fn upload_part(r2: Arc<R2>, bucket: &str, upload_id: &str, n: u32, req: Request) -> R<axum::response::Response> {
    let (r, id) = (r2.clone(), upload_id.to_string());
    match run(move || r.upload(&id)).await? {
        Some((b, _)) if b == bucket => {}
        _ => return Err(err(StatusCode::NOT_FOUND, "NoSuchUpload", format!("找不到上傳 {upload_id}"))),
    }
    let (tmp, got) = receive(&r2, req).await?;
    let id = upload_id.to_string();
    let etag = got.md5.clone();
    run(move || r2.commit_part(&id, n, &tmp, got.size, &got.md5)).await?;
    Ok((StatusCode::OK, [(header::ETAG, format!("\"{etag}\""))]).into_response())
}

async fn complete_upload(r2: Arc<R2>, bucket: &str, key: &str, upload_id: &str, req: Request) -> R<axum::response::Response> {
    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, "MalformedXML", e.to_string()))?;
    let body = String::from_utf8_lossy(&body);
    let parts: Vec<(u32, String)> = tags(&body, "Part")
        .into_iter()
        .map(|p| {
            let n = tags(p, "PartNumber").first().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            let etag = tags(p, "ETag").first().map(|v| unesc(v.trim())).unwrap_or_default();
            (n, etag)
        })
        .collect();
    let id = upload_id.to_string();
    let obj = run(move || r2.complete_upload(&id, &parts)).await?;
    Ok(xml(
        StatusCode::OK,
        format!(
            "<CompleteMultipartUploadResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Location>/{}/{}</Location><Bucket>{}</Bucket><Key>{}</Key><ETag>&quot;{}&quot;</ETag></CompleteMultipartUploadResult>",
            esc(bucket),
            esc(key),
            esc(bucket),
            esc(key),
            esc(obj["etag"].as_str().unwrap_or(""))
        ),
    ))
}

async fn copy_object(s3: &S3, r2: Arc<R2>, bucket: &str, key: &str, h: &HeaderMap) -> R<axum::response::Response> {
    let src = h.get("x-amz-copy-source").and_then(|v| v.to_str().ok()).unwrap_or("");
    let src = decode(src.split('?').next().unwrap_or("").trim_start_matches('/'));
    let (sb, sk) = src
        .split_once('/')
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "InvalidArgument", "x-amz-copy-source 格式不對"))?;
    let src_store = s3.store(sb)?;
    if !Arc::ptr_eq(&src_store, &r2) {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "NotImplemented",
            "目前只能在同一個應用的 bucket 之間複製",
        ));
    }
    let replace = h.get("x-amz-metadata-directive").is_some_and(|v| v == "REPLACE");
    let meta = replace.then(|| metadata_from(h));
    let (sb, sk, b, k) = (sb.to_string(), sk.to_string(), bucket.to_string(), key.to_string());
    let obj = run(move || r2.copy(&sb, &sk, &b, &k, meta.as_ref().map(|(a, c)| (a, c))))
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "NoSuchKey", "來源物件不存在"))?;
    Ok(xml(
        StatusCode::OK,
        format!(
            "<CopyObjectResult><LastModified>{}</LastModified><ETag>&quot;{}&quot;</ETag></CopyObjectResult>",
            iso_date(obj["uploaded"].as_i64().unwrap_or(0)),
            esc(obj["etag"].as_str().unwrap_or(""))
        ),
    ))
}

async fn delete_objects(r2: Arc<R2>, bucket: &str, req: Request) -> R<(axum::response::Response, Vec<String>)> {
    let body = axum::body::to_bytes(req.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, "MalformedXML", e.to_string()))?;
    let body = String::from_utf8_lossy(&body);
    let quiet = tags(&body, "Quiet").first().is_some_and(|v| v.trim() == "true");
    let keys: Vec<String> = tags(&body, "Object")
        .into_iter()
        .filter_map(|o| tags(o, "Key").first().map(|k| unesc(k)))
        .collect();
    let (b, ks) = (bucket.to_string(), keys.clone());
    run(move || r2.delete(&b, &ks)).await?;
    let mut out = String::from("<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">");
    if !quiet {
        for k in &keys {
            out.push_str(&format!("<Deleted><Key>{}</Key></Deleted>", esc(k)));
        }
    }
    out.push_str("</DeleteResult>");
    Ok((xml(StatusCode::OK, out), keys))
}

async fn get_object(r2: Arc<R2>, bucket: &str, key: &str, head: bool, h: &HeaderMap) -> R<axum::response::Response> {
    let (r, b, k) = (r2.clone(), bucket.to_string(), key.to_string());
    let meta = run(move || r.head(&b, &k))
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "NoSuchKey", "物件不存在"))?;
    let size = meta["size"].as_u64().unwrap_or(0);
    let etag = format!("\"{}\"", meta["etag"].as_str().unwrap_or(""));
    if h.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    // Range: bytes=a-b / bytes=a- / bytes=-n
    let range = h
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| {
            let (a, b) = r.split_once('-')?;
            match (a.trim(), b.trim()) {
                ("", n) => {
                    let n: u64 = n.parse().ok()?;
                    Some((size.saturating_sub(n), size.saturating_sub(1)))
                }
                (a, "") => Some((a.parse().ok()?, size.saturating_sub(1))),
                (a, b) => Some((a.parse().ok()?, b.parse::<u64>().ok()?.min(size.saturating_sub(1)))),
            }
        });
    if let Some((a, b)) = range
        && (a > b || a >= size)
    {
        return Err(err(StatusCode::RANGE_NOT_SATISFIABLE, "InvalidRange", "Range 超出範圍"));
    }
    let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end - start + 1 };

    let http = &meta["httpMetadata"];
    let mut b = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(
            header::CONTENT_TYPE,
            http["contentType"].as_str().unwrap_or("application/octet-stream"),
        )
        .header(header::CONTENT_LENGTH, length)
        .header(header::ETAG, &etag)
        .header(header::LAST_MODIFIED, http_date(meta["uploaded"].as_i64().unwrap_or(0)))
        .header(header::ACCEPT_RANGES, "bytes");
    for (field, name) in [
        ("contentLanguage", "content-language"),
        ("contentDisposition", "content-disposition"),
        ("contentEncoding", "content-encoding"),
        ("cacheControl", "cache-control"),
    ] {
        if let Some(v) = http[field].as_str() {
            b = b.header(name, v);
        }
    }
    if let Some(custom) = meta["customMetadata"].as_object() {
        for (k, v) in custom {
            if let Some(v) = v.as_str() {
                b = b.header(format!("x-amz-meta-{k}"), v);
            }
        }
    }
    if range.is_some() {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    if head || length == 0 {
        return Ok(b.body(Body::empty()).map_err(|e| anyhow::anyhow!(e))?);
    }
    let mut f = tokio::fs::File::open(r2.file_path(bucket, key))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| anyhow::anyhow!(e))?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(f.take(length)));
    Ok(b.body(body).map_err(|e| anyhow::anyhow!(e))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS 文件的 SigV4 範例（GET Object，金鑰 AKIAIOSFODNN7EXAMPLE）
    #[test]
    fn sigv4_matches_aws_example() {
        let s3 = S3 {
            cfg: S3Cfg {
                port: 0,
                access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
                secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            },
            slots: vec![],
            queues: None,
        };
        let mut h = HeaderMap::new();
        h.insert("host", "examplebucket.s3.amazonaws.com".parse().unwrap());
        h.insert("range", "bytes=0-9".parse().unwrap());
        h.insert(
            "x-amz-content-sha256",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".parse().unwrap(),
        );
        h.insert("x-amz-date", "20130524T000000Z".parse().unwrap());
        h.insert(
            "authorization",
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
                .parse()
                .unwrap(),
        );
        // 時間檢查會擋掉 2013 年的請求：確認錯誤是 RequestTimeTooSkewed（代表格式解析都通過了）
        match verify(&s3, &Method::GET, "/test.txt", &[], &h) {
            Err(S3Err(_, code, _)) => assert_eq!(code, "RequestTimeTooSkewed"),
            Ok(_) => panic!("應該要因為時間被擋"),
        }
    }

    #[test]
    fn signing_key_and_signature() {
        // 直接用 AWS 範例驗證簽章演算法本身
        let canonical = "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n{}",
            hex::encode(Sha256::digest(canonical.as_bytes()))
        );
        let mut key = hmac(b"AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20130524");
        for p in ["us-east-1", "s3", "aws4_request"] {
            key = hmac(&key, p);
        }
        assert_eq!(
            hex::encode(hmac(&key, &to_sign)),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn xml_tags() {
        let x = "<Delete><Object><Key>a&amp;b</Key></Object><Object><Key>c</Key></Object></Delete>";
        let keys: Vec<String> = tags(x, "Object")
            .into_iter()
            .filter_map(|o| tags(o, "Key").first().map(|k| unesc(k)))
            .collect();
        assert_eq!(keys, vec!["a&b", "c"]);
    }
}
