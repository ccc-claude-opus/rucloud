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
}

pub struct Pool {
    slots: Vec<AtomicU16>,
    rr: AtomicUsize,
    ready: Notify,
    restart: watch::Sender<u64>,
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
        });
        let spec = Arc::new(spec);
        for i in 0..n {
            tokio::spawn(supervise(pool.clone(), spec.clone(), i));
        }
        pool
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
        (0..n).map(|k| self.slots[(start + k) % n].load(Ordering::Acquire)).find(|p| *p != 0)
    }

    pub fn restart(&self) {
        self.restart.send_modify(|g| *g += 1);
    }
}

async fn supervise(pool: Arc<Pool>, spec: Arc<WorkerSpec>, i: usize) {
    let mut restart = pool.restart.subscribe();
    let tag = if pool.len() > 1 { format!("{}#{i}", spec.app) } else { spec.app.clone() };
    let mut backoff = Duration::from_millis(200);
    loop {
        let started = Instant::now();
        let child = Command::new(&spec.node)
            .args([
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
                "--disable-warning=ExperimentalWarning",
            ])
            .arg(&spec.host_js)
            .current_dir(&spec.cwd)
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
            let (pool, tag) = (pool.clone(), tag.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(p) = line.strip_prefix("RUCLOUD_READY ") {
                        pool.slots[i].store(p.trim().parse().unwrap_or(0), Ordering::Release);
                        pool.ready.notify_waiters();
                    } else {
                        println!("[{tag}] {line}");
                    }
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let tag = tag.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[{tag}] {line}");
                }
            });
        }
        let restarted = tokio::select! {
            st = child.wait() => {
                tracing::warn!("[{tag}] Worker 程序結束（{}），重新啟動", st.map(|s| s.to_string()).unwrap_or_default());
                false
            }
            _ = restart.changed() => {
                tracing::info!("[{tag}] 程式碼有變動，重新載入");
                let _ = child.kill().await;
                true
            }
        };
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
