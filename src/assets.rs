//! Static Assets：比對到檔案就直接由 Rust 回應，不進 Worker。
//! 小檔案快取在記憶體（依修改時間失效），支援 ETag / 304。

use crate::config::AssetsCfg;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Response, StatusCode, header};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const CACHE_MAX_FILE: u64 = 2 * 1024 * 1024;

pub struct Assets {
    pub dir: PathBuf,
    worker_first_all: bool,
    worker_first: Vec<String>,
    not_found: NotFound,
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

#[derive(PartialEq)]
enum NotFound {
    None,
    Spa,
    Page404,
}

#[derive(Clone)]
struct Cached {
    mtime: SystemTime,
    len: u64,
    data: Bytes,
    etag: String,
}

impl Assets {
    pub fn new(app_dir: &Path, cfg: &AssetsCfg) -> Self {
        let dir = app_dir.join(cfg.directory.as_deref().unwrap_or("./public"));
        let (worker_first_all, worker_first) = match &cfg.run_worker_first {
            serde_json::Value::Bool(b) => (*b, vec![]),
            serde_json::Value::Array(a) => (false, a.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
            _ => (false, vec![]),
        };
        let not_found = match cfg.not_found_handling.as_deref() {
            Some("single-page-application") => NotFound::Spa,
            Some("404-page") => NotFound::Page404,
            _ => NotFound::None,
        };
        Self { dir, worker_first_all, worker_first, not_found, cache: Mutex::new(HashMap::new()) }
    }

    /// 這個路徑要不要先進 Worker（run_worker_first，可用 ! 排除）
    pub fn worker_first(&self, path: &str) -> bool {
        if self.worker_first_all {
            return true;
        }
        let pos = self.worker_first.iter().filter(|p| !p.starts_with('!')).any(|p| glob(p, path));
        pos && !self.worker_first.iter().filter_map(|p| p.strip_prefix('!')).any(|p| glob(p, path))
    }

    /// 找對應的檔案：/a → a、a.html、a/index.html；/a/ → a/index.html
    pub fn resolve(&self, url_path: &str) -> Option<PathBuf> {
        let decoded = urlencoding::decode(url_path).ok()?;
        let rel = decoded.trim_start_matches('/');
        let rel_path = Path::new(rel);
        if rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        let base = self.dir.join(rel_path);
        let candidates: Vec<PathBuf> = if rel.is_empty() || rel.ends_with('/') {
            vec![base.join("index.html")]
        } else {
            vec![base.clone(), PathBuf::from(format!("{}.html", base.display())), base.join("index.html")]
        };
        candidates.into_iter().find(|p| p.is_file())
    }

    /// 比對不到時的處理：SPA 回 index.html；404-page 回最近的 404.html
    pub fn not_found_file(&self, url_path: &str, headers: &HeaderMap) -> Option<(PathBuf, StatusCode)> {
        match self.not_found {
            NotFound::Spa => {
                let navigate = headers.get("sec-fetch-mode").is_some_and(|v| v == "navigate")
                    || headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"));
                navigate.then(|| (self.dir.join("index.html"), StatusCode::OK)).filter(|(p, _)| p.is_file())
            }
            NotFound::Page404 => {
                let mut dir = PathBuf::from(url_path.trim_start_matches('/'));
                loop {
                    let p = self.dir.join(&dir).join("404.html");
                    if p.is_file() {
                        return Some((p, StatusCode::NOT_FOUND));
                    }
                    if !dir.pop() {
                        return None;
                    }
                }
            }
            NotFound::None => None,
        }
    }

    /// 完整的靜態檔案處理（含 not_found_handling）；找不到回 None。
    pub async fn serve(&self, method: &Method, path: &str, headers: &HeaderMap) -> Option<Response<Body>> {
        if method != Method::GET && method != Method::HEAD {
            return None;
        }
        let (file, status) = match self.resolve(path) {
            Some(f) => (f, StatusCode::OK),
            None => self.not_found_file(path, headers)?,
        };
        self.file_response(&file, status, method == Method::HEAD, headers).await
    }

    async fn file_response(&self, file: &Path, status: StatusCode, head: bool, headers: &HeaderMap) -> Option<Response<Body>> {
        let meta = tokio::fs::metadata(file).await.ok()?;
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let len = meta.len();
        let mime = mime_guess::from_path(file).first_or_octet_stream();
        let ctype = if mime.type_() == "text" || mime.subtype() == "javascript" || mime.subtype() == "json" {
            format!("{mime}; charset=utf-8")
        } else {
            mime.to_string()
        };
        let cached = self.cache.lock().unwrap().get(file).filter(|c| c.mtime == mtime && c.len == len).cloned();
        let (etag, body) = match cached {
            Some(c) => (c.etag, Some(c.data)),
            None if len <= CACHE_MAX_FILE => {
                let data = Bytes::from(tokio::fs::read(file).await.ok()?);
                let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&data))[..32]);
                self.cache.lock().unwrap().insert(file.to_path_buf(), Cached { mtime, len, data: data.clone(), etag: etag.clone() });
                (etag, Some(data))
            }
            None => {
                let secs = mtime.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                (format!("\"{secs:x}-{len:x}\""), None)
            }
        };
        let mut b = Response::builder()
            .header(header::CONTENT_TYPE, ctype)
            .header(header::ETAG, &etag)
            .header(header::CACHE_CONTROL, "public, max-age=0, must-revalidate");
        if status == StatusCode::OK && headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
            return b.status(StatusCode::NOT_MODIFIED).body(Body::empty()).ok();
        }
        b = b.status(status).header(header::CONTENT_LENGTH, HeaderValue::from(len));
        if head {
            return b.body(Body::empty()).ok();
        }
        let body = match body {
            Some(data) => Body::from(data),
            None => {
                let f = tokio::fs::File::open(file).await.ok()?;
                Body::from_stream(tokio_util::io::ReaderStream::new(f))
            }
        };
        b.body(body).ok()
    }
}

/// 只支援 * 萬用字元（可跨越 /），這也是 run_worker_first 的語意。
fn glob(pattern: &str, s: &str) -> bool {
    let (p, s) = (pattern.as_bytes(), s.as_bytes());
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if pi < p.len() && p[pi] == s[si] {
            pi += 1;
            si += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_worker_first_patterns() {
        assert!(glob("/api/*", "/api/x/y"));
        assert!(glob("/api/*", "/api/"));
        assert!(!glob("/api/*", "/apix"));
        assert!(glob("*.json", "/a/b.json"));
        let a = Assets::new(Path::new("."), &AssetsCfg {
            run_worker_first: serde_json::json!(["/api/*", "!/api/docs/*"]),
            ..Default::default()
        });
        assert!(a.worker_first("/api/chat"));
        assert!(!a.worker_first("/api/docs/x"));
        assert!(!a.worker_first("/index.html"));
    }

    #[test]
    fn resolve_rejects_traversal() {
        let a = Assets::new(Path::new(env!("CARGO_MANIFEST_DIR")), &AssetsCfg { directory: Some("src".into()), ..Default::default() });
        assert!(a.resolve("/main.rs").is_some());
        assert!(a.resolve("/main").is_none());
        assert!(a.resolve("/../Cargo.toml").is_none());
        assert!(a.resolve("/%2e%2e/Cargo.toml").is_none());
    }
}
