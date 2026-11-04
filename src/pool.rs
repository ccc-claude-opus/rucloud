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
    pub node: String,
    pub host_js: PathBuf,
    pub cwd: PathBuf,
    pub spec_json: String,
    /// 沙箱、記憶體上限等額外的 node 參數
    pub node_args: Vec<String>,
    /// 事件迴圈卡住超過這麼久就砍掉程序重開（無窮迴圈保護）
    pub max_block: Option<Duration>,
    pub http: reqwest::Client,
    pub token: String,
    pub logs: Arc<crate::observe::Logs>,
}

/// Worker 程序只拿到這些環境變數；rucloud 自己的環境（金鑰等）不會漏進去
const PASS_ENV: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "SYSTEMROOT", "TMPDIR"];

pub struct Pool {
    slots: Vec<AtomicU16>,
    rr: AtomicUsize,
    ready: Notify,
    restart: watch::Sender<u64>,
    stop: tokio_util::sync::CancellationToken,
    restarts: std::sync::atomic::AtomicU64,
}

impl Pool {
    pub fn start(spec: WorkerSpec, n: usize) -> Arc<Pool> {
        let n = n.max(1);
        let (restart, _) = watch::channel(0);
        let pool = Arc::new(Pool {
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

    /// 取一個可用程序的埠號。affinity 指定時固定用那一個（Durable Objects 用）。
    pub async fn port(&self, affinity: Option<usize>) -> Result<u16> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let notified = self.ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(p) = self.try_port(affinity) {
                return Ok(p);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                bail!("Worker 程序 30 秒內沒有啟動完成");
            }
        }
    }

    fn try_port(&self, affinity: Option<usize>) -> Option<u16> {
        let n = self.slots.len();
        if let Some(i) = affinity {
            return Some(self.slots[i % n].load(Ordering::Acquire)).filter(|p| *p != 0);
        }
        let start = self.rr.fetch_add(1, Ordering::Relaxed);
        (0..n)
            .map(|k| self.slots[(start + k) % n].load(Ordering::Acquire))
            .find(|p| *p != 0)
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
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("[{tag}] 無法啟動 {}：{e}", spec.node);
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
                    if let Some(p) = line.strip_prefix("RUCLOUD_READY ") {
                        pool.slots[i].store(p.trim().parse().unwrap_or(0), Ordering::Release);
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
        let port = pool.slots[i].load(Ordering::Acquire);
        if port == 0 {
            continue;
        }
        let ping = spec
            .http
            .get(format!("http://127.0.0.1:{port}/__rucloud/ping"))
            .header("x-rucloud-kind", "ping")
            .header("x-rucloud-token", &spec.token)
            .send();
        match tokio::time::timeout(limit, ping).await {
            Ok(_) => {}
            Err(_) => return limit,
        }
    }
}
