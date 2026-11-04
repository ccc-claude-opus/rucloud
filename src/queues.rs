//! Queues：全域的訊息佇列（跨應用：A 應用送、B 應用收）。
//! 訊息存在 SQLite，消費者依 max_batch_size / max_batch_timeout 分批送給 Worker 的 queue()。

use crate::app::App;
use crate::config::QueueConsumerCfg;
use crate::d1::open_sqlite;
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub struct Queues {
    conn: Mutex<Connection>,
    notify: Notify,
}

const LEASE_MS: i64 = 5 * 60 * 1000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Queues {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY, queue TEXT NOT NULL, body TEXT NOT NULL, content_type TEXT NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, visible_at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(queue, visible_at);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            notify: Notify::new(),
        })
    }

    /// messages: [{body, contentType, delaySeconds}]
    pub fn send(&self, queue: &str, messages: &[Value]) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let now = now_ms();
        for m in messages {
            let delay = m["delaySeconds"].as_i64().unwrap_or(0).max(0) * 1000;
            tx.execute(
                "INSERT INTO messages VALUES (?, ?, ?, ?, 0, ?, ?)",
                params![
                    format!("{:032x}", rand::random::<u128>()),
                    queue,
                    m["body"].as_str().unwrap_or("null"),
                    m["contentType"].as_str().unwrap_or("json"),
                    now,
                    now + delay
                ],
            )?;
        }
        tx.commit()?;
        drop(conn);
        self.notify.notify_waiters();
        Ok(messages.len())
    }

    /// 每個佇列的訊息數（含延遲中、處理中的），給 /metrics 用
    pub fn depth(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT queue, COUNT(*) FROM messages GROUP BY queue ORDER BY queue") else {
            return vec![];
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// (可取的訊息數, 最早可取的時間)
    fn ready(&self, queue: &str) -> Result<(i64, Option<i64>)> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*), MIN(visible_at) FROM messages WHERE queue = ? AND visible_at <= ?",
            params![queue, now_ms()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// 取出一批並設定租約（租約到期沒處理完會再被取出）
    fn lease(&self, queue: &str, n: usize) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let rows: Vec<Value> = conn
            .prepare("SELECT id, body, content_type, attempts, created FROM messages WHERE queue = ? AND visible_at <= ? ORDER BY visible_at, created LIMIT ?")?
            .query_map(params![queue, now, n as i64], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "body": r.get::<_, String>(1)?, "contentType": r.get::<_, String>(2)?,
                    "attempts": r.get::<_, i64>(3)? + 1, "timestamp": r.get::<_, i64>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        for m in &rows {
            conn.execute(
                "UPDATE messages SET attempts = attempts + 1, visible_at = ? WHERE id = ?",
                params![now + LEASE_MS, m["id"].as_str()],
            )?;
        }
        Ok(rows)
    }

    fn settle(&self, id: &str, retry: Option<i64>, cfg: &QueueConsumerCfg) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        match retry {
            None => {
                conn.execute("DELETE FROM messages WHERE id = ?", [id])?;
            }
            Some(delay) => {
                let attempts: i64 = conn
                    .query_row("SELECT attempts FROM messages WHERE id = ?", [id], |r| r.get(0))
                    .unwrap_or(0);
                if attempts > cfg.max_retries.unwrap_or(3) as i64 {
                    match &cfg.dead_letter_queue {
                        Some(dlq) => conn.execute(
                            "UPDATE messages SET queue = ?, attempts = 0, visible_at = ? WHERE id = ?",
                            params![dlq, now_ms(), id],
                        )?,
                        None => conn.execute("DELETE FROM messages WHERE id = ?", [id])?,
                    };
                    tracing::warn!(
                        "佇列 {} 的訊息 {id} 重試 {attempts} 次仍失敗，{}",
                        cfg.queue,
                        cfg.dead_letter_queue
                            .as_ref()
                            .map(|d| format!("移到 {d}"))
                            .unwrap_or_else(|| "丟棄".into())
                    );
                } else {
                    conn.execute(
                        "UPDATE messages SET visible_at = ? WHERE id = ?",
                        params![now_ms() + delay * 1000, id],
                    )?;
                }
            }
        }
        Ok(())
    }

    /// 一個消費者的主迴圈
    pub async fn consume(self: Arc<Self>, app: Arc<App>, cfg: QueueConsumerCfg) {
        let size = cfg.max_batch_size.unwrap_or(10).clamp(1, 100);
        let timeout_ms = (cfg.max_batch_timeout.unwrap_or(5.0) * 1000.0) as i64;
        loop {
            let notified = self.notify.notified();
            let (n, oldest) = self.ready(&cfg.queue).unwrap_or((0, None));
            let due = n as usize >= size || (n > 0 && oldest.is_some_and(|t| now_ms() - t >= timeout_ms));
            if !due {
                let _ = tokio::time::timeout(Duration::from_millis(250), notified).await;
                continue;
            }
            let batch = match self.lease(&cfg.queue, size) {
                Ok(b) if !b.is_empty() => b,
                _ => continue,
            };
            let ids: Vec<String> = batch.iter().map(|m| m["id"].as_str().unwrap_or_default().to_string()).collect();
            let default_delay = cfg.retry_delay.unwrap_or(0) as i64;
            match crate::gateway::invoke(&app, "queue", &json!({ "queue": cfg.queue, "messages": batch })).await {
                Ok(res) => {
                    for r in res["results"].as_array().into_iter().flatten() {
                        let id = r["id"].as_str().unwrap_or_default();
                        let retry = (r["action"] == "retry").then(|| r["delaySeconds"].as_i64().unwrap_or(default_delay));
                        let _ = self.settle(id, retry, &cfg);
                    }
                }
                Err(e) => {
                    tracing::error!("[{}] 佇列 {} 的批次處理失敗：{e:#}", app.name, cfg.queue);
                    for id in &ids {
                        let _ = self.settle(id, Some(default_delay), &cfg);
                    }
                }
            }
        }
    }
}
