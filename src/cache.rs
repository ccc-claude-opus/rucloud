//! 記憶體快取：
//!   * edge：閘道依 Cache-Control 快取 Worker 的回應（應用設定 `cache_mb` 開啟，預設關）
//!   * api：Worker 的 `caches.default` / `caches.open()`，所有 Worker 程序共用
//!
//! 容量用完時從最早放進來的開始丟。

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode, header};
use bytes::Bytes;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Entry {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    stored: Instant,
    ttl: Duration,
}

struct Inner {
    map: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
}

pub struct Store {
    max_bytes: usize,
    inner: Mutex<Inner>,
}

impl Store {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
            }),
        }
    }

    /// 單筆最大：總容量的 1/8，最多 8 MB
    pub fn max_entry(&self) -> usize {
        (self.max_bytes / 8).min(8 * 1024 * 1024)
    }

    /// 回傳 (內容, 已經存了幾秒)
    pub fn get(&self, key: &str) -> Option<(Entry, u64)> {
        let mut g = self.inner.lock().unwrap();
        let e = g.map.get(key)?;
        let age = e.stored.elapsed();
        if age >= e.ttl {
            let size = e.body.len();
            g.map.remove(key);
            g.bytes -= size;
            return None;
        }
        Some((e.clone(), age.as_secs()))
    }

    pub fn put(&self, key: String, status: u16, headers: Vec<(String, String)>, body: Bytes, ttl: Duration) {
        if body.len() > self.max_entry() || ttl.is_zero() {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        if let Some(old) = g.map.remove(&key) {
            g.bytes -= old.body.len();
            g.order.retain(|k| k != &key);
        }
        g.bytes += body.len();
        g.order.push_back(key.clone());
        g.map.insert(
            key,
            Entry {
                status,
                headers,
                body,
                stored: Instant::now(),
                ttl,
            },
        );
        while g.bytes > self.max_bytes {
            let Some(k) = g.order.pop_front() else { break };
            if let Some(e) = g.map.remove(&k) {
                g.bytes -= e.body.len();
            }
        }
    }

    pub fn delete(&self, key: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        match g.map.remove(key) {
            Some(e) => {
                g.bytes -= e.body.len();
                g.order.retain(|k| k != key);
                true
            }
            None => false,
        }
    }

    /// 清掉 key 以 prefix 開頭的（空字串 = 全部），回傳清掉幾筆
    pub fn purge(&self, prefix: &str) -> usize {
        let mut g = self.inner.lock().unwrap();
        let keys: Vec<String> = g.map.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        for k in &keys {
            if let Some(e) = g.map.remove(k) {
                g.bytes -= e.body.len();
            }
        }
        g.order.retain(|k| !k.starts_with(prefix));
        keys.len()
    }

    pub fn stats(&self) -> (usize, usize) {
        let g = self.inner.lock().unwrap();
        (g.map.len(), g.bytes)
    }
}

/// 一個應用的快取
pub struct Caches {
    pub edge: Option<Store>,
    pub api: Store,
    pub hits: std::sync::atomic::AtomicU64,
    pub misses: std::sync::atomic::AtomicU64,
}

impl Caches {
    pub fn new(edge_mb: Option<usize>) -> Self {
        Self {
            edge: edge_mb.filter(|m| *m > 0).map(|m| Store::new(m * 1024 * 1024)),
            api: Store::new(edge_mb.unwrap_or(16).max(16) * 1024 * 1024),
            hits: Default::default(),
            misses: Default::default(),
        }
    }

    /// 部署新版本時清掉閘道快取（Cache API 的內容由程式自己管理，保留）
    pub fn clear_edge(&self) {
        if let Some(e) = &self.edge {
            e.purge("");
        }
    }
}

/// 回應可以快取多久；不能快取回 None。規則接近 Cloudflare 的 CDN：
/// 要有 s-maxage 或 max-age，不能是 private / no-store / no-cache，不能有 Set-Cookie，Vary 只接受 Accept-Encoding
pub fn ttl_of(status: StatusCode, headers: &HeaderMap) -> Option<Duration> {
    if !matches!(status.as_u16(), 200 | 203 | 204 | 300 | 301 | 404 | 410) || headers.contains_key(header::SET_COOKIE) {
        return None;
    }
    if let Some(v) = headers.get(header::VARY).and_then(|v| v.to_str().ok())
        && v.split(',').any(|x| !x.trim().eq_ignore_ascii_case("accept-encoding"))
    {
        return None;
    }
    let cc = headers.get(header::CACHE_CONTROL)?.to_str().ok()?.to_ascii_lowercase();
    let mut max_age = None;
    let mut s_maxage = None;
    for d in cc.split(',').map(str::trim) {
        if matches!(d, "private" | "no-store" | "no-cache") {
            return None;
        }
        if let Some(v) = d.strip_prefix("s-maxage=") {
            s_maxage = v.parse::<u64>().ok();
        } else if let Some(v) = d.strip_prefix("max-age=") {
            max_age = v.parse::<u64>().ok();
        }
    }
    s_maxage.or(max_age).filter(|s| *s > 0).map(Duration::from_secs)
}

/// 把要存的標頭挑出來（連線相關的不存）
pub fn keep_headers(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .filter(|(k, _)| {
            !matches!(
                k.as_str(),
                "connection" | "transfer-encoding" | "content-length" | "age" | "cf-cache-status"
            )
        })
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect()
}

pub fn response(e: Entry, age: u64, status_header: &str) -> Response<Body> {
    let mut b = Response::builder().status(e.status);
    for (k, v) in &e.headers {
        b = b.header(k, v);
    }
    let mut r = b.header(header::AGE, age).body(Body::from(e.body)).unwrap_or_default();
    r.headers_mut()
        .insert("cf-cache-status", HeaderValue::from_str(status_header).unwrap());
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_rules() {
        let h = |cc: &str| {
            let mut m = HeaderMap::new();
            m.insert(header::CACHE_CONTROL, cc.parse().unwrap());
            m
        };
        assert_eq!(ttl_of(StatusCode::OK, &h("public, max-age=60")), Some(Duration::from_secs(60)));
        assert_eq!(
            ttl_of(StatusCode::OK, &h("max-age=60, s-maxage=600")),
            Some(Duration::from_secs(600))
        );
        assert_eq!(ttl_of(StatusCode::OK, &h("private, max-age=60")), None);
        assert_eq!(ttl_of(StatusCode::OK, &h("no-store")), None);
        assert_eq!(ttl_of(StatusCode::INTERNAL_SERVER_ERROR, &h("max-age=60")), None);
        let mut c = h("max-age=60");
        c.insert(header::SET_COOKIE, "a=b".parse().unwrap());
        assert_eq!(ttl_of(StatusCode::OK, &c), None);
        assert_eq!(ttl_of(StatusCode::OK, &HeaderMap::new()), None);
    }

    #[test]
    fn evicts_oldest_when_full() {
        let s = Store::new(80);
        for i in 0..5 {
            s.put(format!("k{i}"), 200, vec![], Bytes::from(vec![0u8; 10]), Duration::from_secs(60));
        }
        s.put("big".into(), 200, vec![], Bytes::from(vec![0u8; 50]), Duration::from_secs(60));
        assert!(s.get("big").is_none(), "超過單筆上限（容量的 1/8）不存");
        for i in 5..10 {
            s.put(format!("k{i}"), 200, vec![], Bytes::from(vec![0u8; 10]), Duration::from_secs(60));
        }
        assert!(s.get("k0").is_none());
        assert!(s.get("k9").is_some());
        assert!(s.stats().1 <= 80);
        assert!(s.purge("k") > 0);
        assert_eq!(s.stats(), (0, 0));
    }
}
