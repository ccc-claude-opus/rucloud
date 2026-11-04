//! 觀測：每個應用的計數器（Prometheus 格式輸出）與 log（記憶體裡的最近紀錄、即時串流、每日檔案）。

use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use tokio::sync::broadcast;

/// 請求延遲的直方圖邊界（秒）
const BUCKETS: [f64; 10] = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0];

#[derive(Default)]
pub struct Metrics {
    /// (route, 狀態碼類別) → 次數；route 是 asset 或 worker
    requests: Mutex<BTreeMap<(&'static str, u16), u64>>,
    buckets: [AtomicU64; BUCKETS.len()],
    duration_count: AtomicU64,
    duration_sum_us: AtomicU64,
    pub inflight: AtomicI64,
    pub websockets: AtomicI64,
    bindings: Mutex<BTreeMap<String, u64>>,
}

impl Metrics {
    pub fn request(&self, route: &'static str, status: u16, secs: f64) {
        *self.requests.lock().unwrap().entry((route, status / 100)).or_default() += 1;
        for (i, b) in BUCKETS.iter().enumerate() {
            if secs <= *b {
                self.buckets[i].fetch_add(1, Ordering::Relaxed);
            }
        }
        self.duration_count.fetch_add(1, Ordering::Relaxed);
        self.duration_sum_us.fetch_add((secs * 1e6) as u64, Ordering::Relaxed);
    }

    pub fn binding(&self, kind: &str) {
        *self.bindings.lock().unwrap().entry(kind.to_string()).or_default() += 1;
    }

    /// 把這個應用的數字寫成 Prometheus 文字格式
    pub fn render(&self, app: &str, restarts: u64, out: &mut String) {
        let a = app.replace('"', "");
        for ((route, class), n) in self.requests.lock().unwrap().iter() {
            out.push_str(&format!(
                "rucloud_requests_total{{app=\"{a}\",route=\"{route}\",status=\"{class}xx\"}} {n}\n"
            ));
        }
        for (i, b) in BUCKETS.iter().enumerate() {
            out.push_str(&format!(
                "rucloud_request_duration_seconds_bucket{{app=\"{a}\",le=\"{b}\"}} {}\n",
                self.buckets[i].load(Ordering::Relaxed)
            ));
        }
        let count = self.duration_count.load(Ordering::Relaxed);
        out.push_str(&format!(
            "rucloud_request_duration_seconds_bucket{{app=\"{a}\",le=\"+Inf\"}} {count}\n"
        ));
        out.push_str(&format!(
            "rucloud_request_duration_seconds_sum{{app=\"{a}\"}} {}\n",
            self.duration_sum_us.load(Ordering::Relaxed) as f64 / 1e6
        ));
        out.push_str(&format!("rucloud_request_duration_seconds_count{{app=\"{a}\"}} {count}\n"));
        out.push_str(&format!(
            "rucloud_requests_inflight{{app=\"{a}\"}} {}\n",
            self.inflight.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "rucloud_websockets_open{{app=\"{a}\"}} {}\n",
            self.websockets.load(Ordering::Relaxed)
        ));
        out.push_str(&format!("rucloud_worker_restarts_total{{app=\"{a}\"}} {restarts}\n"));
        for (kind, n) in self.bindings.lock().unwrap().iter() {
            out.push_str(&format!("rucloud_binding_calls_total{{app=\"{a}\",binding=\"{kind}\"}} {n}\n"));
        }
    }
}

pub const METRIC_HELP: &str = "\
# HELP rucloud_requests_total 請求數（route：asset 或 worker）
# TYPE rucloud_requests_total counter
# HELP rucloud_request_duration_seconds 請求處理時間（到回應標頭送出）
# TYPE rucloud_request_duration_seconds histogram
# HELP rucloud_requests_inflight 處理中的請求
# TYPE rucloud_requests_inflight gauge
# HELP rucloud_websockets_open 開著的 WebSocket 連線
# TYPE rucloud_websockets_open gauge
# HELP rucloud_worker_restarts_total Worker 程序重開的次數
# TYPE rucloud_worker_restarts_total counter
# HELP rucloud_binding_calls_total Worker 呼叫綁定的次數
# TYPE rucloud_binding_calls_total counter
";

const RING: usize = 1000;

/// 一個應用的 log：Worker 的 console 輸出與請求紀錄
pub struct Logs {
    app: String,
    recent: Mutex<VecDeque<Value>>,
    live: broadcast::Sender<Value>,
    file: Mutex<Option<LogFile>>,
}

struct LogFile {
    dir: PathBuf,
    day: String,
    out: std::io::BufWriter<std::fs::File>,
}

impl Logs {
    /// dir 給了就每天寫一個 `YYYY-MM-DD.log`（JSON lines）
    pub fn new(app: &str, dir: Option<PathBuf>) -> Self {
        let (live, _) = broadcast::channel(1024);
        let file = dir.and_then(|d| {
            std::fs::create_dir_all(&d).ok()?;
            Some(LogFile {
                dir: d,
                day: String::new(),
                out: std::io::BufWriter::new(tempfile_sink()),
            })
        });
        Self {
            app: app.to_string(),
            recent: Mutex::new(VecDeque::with_capacity(RING)),
            live,
            file: Mutex::new(file),
        }
    }

    /// kind：console（Worker 的 stdout）、error（stderr）、request、system
    pub fn push(&self, kind: &str, message: &str, echo: bool) {
        let now = chrono::Utc::now();
        let entry =
            json!({ "ts": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "app": self.app, "kind": kind, "message": message });
        if echo {
            match kind {
                "error" => eprintln!("[{}] {message}", self.app),
                _ => println!("[{}] {message}", self.app),
            }
        }
        {
            let mut r = self.recent.lock().unwrap();
            if r.len() == RING {
                r.pop_front();
            }
            r.push_back(entry.clone());
        }
        if let Some(f) = self.file.lock().unwrap().as_mut() {
            let day = now.format("%Y-%m-%d").to_string();
            if f.day != day
                && let Ok(file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(f.dir.join(format!("{day}.log")))
            {
                let _ = f.out.flush();
                f.out = std::io::BufWriter::new(file);
                f.day = day;
            }
            let _ = writeln!(f.out, "{entry}");
            // console 的輸出量小，直接 flush，掛掉也不會掉紀錄
            if kind != "request" {
                let _ = f.out.flush();
            }
        }
        let _ = self.live.send(entry);
    }

    pub fn recent(&self, n: usize) -> Vec<Value> {
        let r = self.recent.lock().unwrap();
        r.iter().skip(r.len().saturating_sub(n)).cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.live.subscribe()
    }

    pub fn flush(&self) {
        if let Some(f) = self.file.lock().unwrap().as_mut() {
            let _ = f.out.flush();
        }
    }
}

/// 第一筆 log 進來之前的佔位檔
fn tempfile_sink() -> std::fs::File {
    std::fs::OpenOptions::new()
        .write(true)
        .open(if cfg!(windows) { "NUL" } else { "/dev/null" })
        .expect("開不了 null 裝置")
}
