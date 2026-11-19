//! Worker 程序池：每個應用開 N 個 Node 程序跑 Worker 程式碼。
//! 程序掛掉自動重開；開發模式下程式碼改了就全部重開。

use anyhow::{Result, bail};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Notify, watch};

pub struct WorkerSpec {
    pub app: String,
    /// rucloud 與 Worker 之間的 Unix socket 放在這裡（每個程序一個 w<編號>-<i>.sock）
    pub sock_dir: PathBuf,
    pub node: String,
    pub host_js: PathBuf,
    pub cwd: PathBuf,
    pub spec_json: String,
    /// 沙箱、記憶體上限等額外的 node 參數
    pub node_args: Vec<String>,
    /// 事件迴圈卡住超過這麼久就砍掉程序重開（無窮迴圈保護）
    pub max_block: Option<Duration>,
    pub token: String,
    pub logs: Arc<crate::observe::Logs>,
}

/// 一個 Worker 程序：它的 Unix socket，和連到那個 socket 的 HTTP client
#[derive(Clone)]
pub struct Endpoint {
    pub client: reqwest::Client,
    pub sock: Arc<PathBuf>,
}

impl Endpoint {
    fn new(sock: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .unix_socket(sock.clone())
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(256)
            .build()
            .expect("Unix socket 的 HTTP client");
        Self { client, sock: Arc::new(sock) }
    }

    /// 請求這個程序的網址（主機名稱沒有意義，連線走 socket）
    pub fn url(&self, path_and_query: &str) -> String {
        format!("http://worker{path_and_query}")
    }
}

/// 每個程序池的編號（socket 的檔名要短：macOS 的 Unix socket 路徑上限是 104 bytes）
static NEXT_POOL: AtomicUsize = AtomicUsize::new(0);

/// Worker 程序只拿到這些環境變數；rucloud 自己的環境（金鑰等）不會漏進去
const PASS_ENV: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "SYSTEMROOT", "TMPDIR"];

pub struct Pool {
    /// 1：程序已經在聽它的 socket
    slots: Vec<AtomicU16>,
    endpoints: Vec<Endpoint>,
    rr: AtomicUsize,
    ready: Notify,
    restart: watch::Sender<u64>,
    stop: tokio_util::sync::CancellationToken,
    restarts: std::sync::atomic::AtomicU64,
}

/// 啟動失敗的原因：spawn 只回「No such file or directory」，不說是哪個檔案不見了。
/// 最常見的其實不是 Node，而是應用資料夾被移動或刪除了（工作目錄不存在）
fn spawn_error(spec: &WorkerSpec, e: &std::io::Error) -> String {
    if !spec.cwd.is_dir() {
        format!("找不到應用資料夾 {}（被移動或刪除了？改好設定後重開 rucloud）", spec.cwd.display())
    } else if !spec.host_js.is_file() {
        format!("找不到 rucloud 的執行環境 {}", spec.host_js.display())
    } else if e.kind() == std::io::ErrorKind::NotFound {
        format!("找不到 Node.js：{}（rucloud.toml 的 node 設定）", spec.node)
    } else {
        format!("無法啟動 Node.js（{}）：{e}", spec.node)
    }
}

impl Pool {
    pub fn start(spec: WorkerSpec, n: usize) -> Arc<Pool> {
        let n = n.max(1);
        let (restart, _) = watch::channel(0);
        let id = NEXT_POOL.fetch_add(1, Ordering::Relaxed);
        let endpoints = (0..n).map(|i| Endpoint::new(spec.sock_dir.join(format!("w{id}-{i}.sock")))).collect();
        let pool = Arc::new(Pool {
            endpoints,
            slots: (0..n).map(|_| AtomicU16::new(0)).collect(),
            rr: AtomicUsize::new(0),
            ready: Notify::new(),
            restart,
            stop: tokio_util::sync::CancellationToken::new(),
            restarts: std::sync::atomic::AtomicU64::new(0),
        });
        let spec = Arc::new(spec);
        for i in 0..n {
            tokio::spawn(supervise(pool.clone(), spec.clone(), i));
        }
        pool
    }

    /// 關閉：砍掉所有 Worker 程序，不再重開
    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn ready_count(&self) -> usize {
        self.slots.iter().filter(|p| p.load(Ordering::Acquire) != 0).count()
    }

    pub fn restarts(&self) -> u64 {
        self.restarts.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    /// 取一個可用的程序。affinity 指定時固定用那一個（Durable Objects 用）。
    pub async fn endpoint(&self, affinity: Option<usize>) -> Result<Endpoint> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let notified = self.ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(i) = self.try_slot(affinity) {
                return Ok(self.endpoints[i].clone());
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                bail!("Worker 程序 30 秒內沒有啟動完成");
            }
        }
    }

    fn try_slot(&self, affinity: Option<usize>) -> Option<usize> {
        let n = self.slots.len();
        if let Some(i) = affinity {
            return Some(i % n).filter(|&i| self.slots[i].load(Ordering::Acquire) != 0);
        }
        let start = self.rr.fetch_add(1, Ordering::Relaxed);
        (0..n).map(|k| (start + k) % n).find(|&i| self.slots[i].load(Ordering::Acquire) != 0)
    }

    pub fn restart(&self) {
        self.restart.send_modify(|g| *g += 1);
    }
}

async fn supervise(pool: Arc<Pool>, spec: Arc<WorkerSpec>, i: usize) {
    let mut restart = pool.restart.subscribe();
    let tag = if pool.len() > 1 {
        format!("{}#{i}", spec.app)
    } else {
        spec.app.clone()
    };
    let mut backoff = Duration::from_millis(200);
    loop {
        let started = Instant::now();
        // 上一個程序留下的 socket 檔
        let sock = pool.endpoints[i].sock.clone();
        let _ = std::fs::remove_file(&*sock);
        let mut cmd = Command::new(&spec.node);
        // --experimental-transform-types：TypeScript 的 enum、namespace 等也能直接跑
        cmd.args([
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            // 自己打包、附 .map 的 JS，錯誤的 stack trace 也能對回原始碼
            "--enable-source-maps",
        ])
        .args(&spec.node_args)
        .arg(&spec.host_js)
        .current_dir(&spec.cwd)
        .env_clear();
        for k in PASS_ENV {
            if let Ok(v) = std::env::var(k) {
                cmd.env(k, v);
            }
        }
        let child = cmd
            .env("RUCLOUD_SPEC", &spec.spec_json)
            .env("RUCLOUD_INSTANCE", i.to_string())
            .env("RUCLOUD_SOCKET", &*sock)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let msg = spawn_error(&spec, &e);
                tracing::error!("[{tag}] {msg}");
                spec.logs.push("error", &msg, false);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        // stdin 保持開著：rucloud 結束時管線關閉，Node 端就會自己結束
        let stdin = child.stdin.take();
        if let Some(out) = child.stdout.take() {
            let (pool, logs) = (pool.clone(), spec.logs.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.starts_with("RUCLOUD_READY") {
                        pool.slots[i].store(1, Ordering::Release);
                        pool.ready.notify_waiters();
                    } else {
                        logs.push("console", &line, true);
                    }
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let logs = spec.logs.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    logs.push("error", &line, true);
                }
            });
        }
        let restarted = tokio::select! {
            st = child.wait() => {
                tracing::warn!("[{tag}] Worker 程序結束（{}），重新啟動", st.map(|s| s.to_string()).unwrap_or_default());
                false
            }
            limit = watchdog(&pool, &spec, i) => {
                tracing::error!("[{tag}] Worker 程序超過 {:.0} 秒沒有回應（可能是無窮迴圈），強制重開", limit.as_secs_f64());
                let _ = child.kill().await;
                false
            }
            _ = restart.changed() => {
                tracing::info!("[{tag}] 程式碼有變動，重新載入");
                let _ = child.kill().await;
                true
            }
            _ = pool.stop.cancelled() => {
                pool.slots[i].store(0, Ordering::Release);
                let _ = child.kill().await;
                return;
            }
        };
        pool.restarts.fetch_add(1, Ordering::Relaxed);
        pool.slots[i].store(0, Ordering::Release);
        drop(stdin);
        if restarted || started.elapsed() > Duration::from_secs(10) {
            backoff = Duration::from_millis(200);
        } else {
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
        if !restarted {
            tokio::time::sleep(backoff).await;
        }
    }
}

/// 每秒對 Worker 程序送一次 ping；一次 ping 等超過 max_block 就回傳（呼叫端會砍掉程序）
async fn watchdog(pool: &Pool, spec: &WorkerSpec, i: usize) -> Duration {
    let Some(limit) = spec.max_block else {
        return std::future::pending().await;
    };
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if pool.slots[i].load(Ordering::Acquire) == 0 {
            continue;
        }
        let ep = &pool.endpoints[i];
        let ping = ep
            .client
            .get(ep.url("/__rucloud/ping"))
            .header("x-rucloud-kind", "ping")
            .header("x-rucloud-token", &spec.token)
            .send();
        match tokio::time::timeout(limit, ping).await {
            Ok(_) => {}
            Err(_) => return limit,
        }
    }
}
