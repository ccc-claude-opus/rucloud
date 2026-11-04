//! Workflows：持久化的多步驟工作。
//!
//! 執行方式是「重播」：每次喚醒都從頭呼叫 `run(event, step)`，已完成的 `step.do` 直接回傳存好的結果；
//! 遇到還沒到時間的 `step.sleep`、還沒收到事件的 `step.waitForEvent` 就暫停，由這裡的排程器到時間再喚醒。
//! 狀態全部存在 `<state>/<應用>/workflows.sqlite`，rucloud 重啟後會接著跑。

use crate::app::Slot;
use crate::d1::open_sqlite;
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub struct Workflows {
    conn: Mutex<Connection>,
    pub wake: Notify,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Workflows {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS instances (
               wf TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL,
               output TEXT, error TEXT, wake_at INTEGER, waiting_for TEXT,
               created INTEGER NOT NULL, updated INTEGER NOT NULL,
               PRIMARY KEY (wf, id)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS steps (
               wf TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, result TEXT NOT NULL,
               PRIMARY KEY (wf, id, name)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS events (
               seq INTEGER PRIMARY KEY AUTOINCREMENT, wf TEXT NOT NULL, id TEXT NOT NULL,
               type TEXT NOT NULL, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
             -- 重啟時還在 running 的改回 queued，重新跑（已完成的步驟會被重播跳過）
             UPDATE instances SET status = 'queued' WHERE status = 'running';",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            wake: Notify::new(),
        })
    }

    /// Worker 端的 API：{op: create|status|pause|resume|terminate|restart|sendEvent|step}
    pub fn op(&self, wf: &str, req: &Value) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let id = req["id"].as_str().unwrap_or("").to_string();
        let out = match req["op"].as_str().unwrap_or("") {
            "create" => {
                let id = if id.is_empty() {
                    format!("{:032x}", rand::random::<u128>())
                } else {
                    id
                };
                let exists: Option<String> = conn
                    .query_row("SELECT status FROM instances WHERE wf = ? AND id = ?", params![wf, id], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if exists.is_some() {
                    bail!("Workflow 實例 {id} 已經存在");
                }
                conn.execute(
                    "INSERT INTO instances (wf, id, status, params, created, updated) VALUES (?, ?, 'queued', ?, ?, ?)",
                    params![wf, id, req["params"].to_string(), now_ms(), now_ms()],
                )?;
                self.wake.notify_one();
                json!({ "id": id })
            }
            "status" => {
                let row = conn
                    .query_row(
                        "SELECT status, output, error FROM instances WHERE wf = ? AND id = ?",
                        params![wf, id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, Option<String>>(1)?,
                                r.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((status, output, error)) = row else {
                    bail!("找不到 Workflow 實例 {id}")
                };
                // Cloudflare 把 sleep / waitForEvent 中的狀態叫 waiting
                let status = if status == "sleeping" { "waiting".to_string() } else { status };
                let mut o = json!({ "status": status });
                if let Some(v) = output.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                    o["output"] = v;
                }
                if let Some(e) = error {
                    o["error"] = json!({ "name": "Error", "message": e });
                }
                o
            }
            "exists" => {
                let n: i64 = conn.query_row("SELECT COUNT(*) FROM instances WHERE wf = ? AND id = ?", params![wf, id], |r| {
                    r.get(0)
                })?;
                json!({ "exists": n > 0 })
            }
            "pause" => {
                conn.execute(
                    "UPDATE instances SET status = 'paused', updated = ? WHERE wf = ? AND id = ? AND status IN ('queued', 'sleeping', 'waiting', 'running')",
                    params![now_ms(), wf, id],
                )?;
                json!({})
            }
            "resume" => {
                conn.execute(
                    "UPDATE instances SET status = 'queued', updated = ? WHERE wf = ? AND id = ? AND status = 'paused'",
                    params![now_ms(), wf, id],
                )?;
                self.wake.notify_one();
                json!({})
            }
            "terminate" => {
                conn.execute(
                    "UPDATE instances SET status = 'terminated', updated = ? WHERE wf = ? AND id = ? AND status NOT IN ('complete', 'errored')",
                    params![now_ms(), wf, id],
                )?;
                json!({})
            }
            "restart" => {
                conn.execute("DELETE FROM steps WHERE wf = ? AND id = ?", params![wf, id])?;
                conn.execute("DELETE FROM events WHERE wf = ? AND id = ?", params![wf, id])?;
                conn.execute(
                    "UPDATE instances SET status = 'queued', output = NULL, error = NULL, wake_at = NULL, waiting_for = NULL, updated = ? WHERE wf = ? AND id = ?",
                    params![now_ms(), wf, id],
                )?;
                self.wake.notify_one();
                json!({})
            }
            "sendEvent" => {
                conn.execute(
                    "INSERT INTO events (wf, id, type, payload) VALUES (?, ?, ?, ?)",
                    params![wf, id, req["type"].as_str().unwrap_or(""), req["payload"].to_string()],
                )?;
                // 正在等這種事件的實例改回可執行
                conn.execute(
                    "UPDATE instances SET status = 'queued', updated = ? WHERE wf = ? AND id = ? AND status = 'waiting' AND waiting_for = ?",
                    params![now_ms(), wf, id, req["type"].as_str().unwrap_or("")],
                )?;
                self.wake.notify_one();
                json!({})
            }
            // 執行中的 run() 存一個完成的步驟
            "step" => {
                conn.execute(
                    "INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?)",
                    params![wf, id, req["name"].as_str().unwrap_or(""), req["result"].to_string()],
                )?;
                json!({})
            }
            other => bail!("不支援的 Workflow 操作 {other}"),
        };
        Ok(out)
    }

    /// 取出該跑的實例並標成 running：queued、或 sleep / 等事件逾時已到
    fn take_runnable(&self, limit: usize) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT wf, id FROM instances
                 WHERE status = 'queued' OR (status IN ('sleeping', 'waiting') AND wake_at IS NOT NULL AND wake_at <= ?)
                 ORDER BY updated LIMIT ?",
            )?
            .query_map(params![now_ms(), limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (wf, id) in &rows {
            conn.execute(
                "UPDATE instances SET status = 'running', updated = ? WHERE wf = ? AND id = ?",
                params![now_ms(), wf, id],
            )?;
        }
        Ok(rows)
    }

    /// 給 run() 重播用的資料：參數、已完成的步驟、收到的事件
    fn snapshot(&self, wf: &str, id: &str) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let (params_s, created): (String, i64) = conn.query_row(
            "SELECT params, created FROM instances WHERE wf = ? AND id = ?",
            params![wf, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let steps: serde_json::Map<String, Value> = conn
            .prepare("SELECT name, result FROM steps WHERE wf = ? AND id = ?")?
            .query_map(params![wf, id], |r| {
                let s: String = r.get(1)?;
                Ok((r.get::<_, String>(0)?, serde_json::from_str(&s).unwrap_or(Value::Null)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let events: Vec<Value> = conn
            .prepare("SELECT type, payload FROM events WHERE wf = ? AND id = ? ORDER BY seq")?
            .query_map(params![wf, id], |r| {
                let p: String = r.get(1)?;
                Ok(json!({ "type": r.get::<_, String>(0)?, "payload": serde_json::from_str::<Value>(&p).unwrap_or(Value::Null) }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(json!({
            "workflow": wf, "id": id, "params": serde_json::from_str::<Value>(&params_s).unwrap_or(Value::Null),
            "timestamp": created, "steps": steps, "events": events, "now": now_ms(),
        }))
    }

    /// 依 run() 的結果更新狀態（執行期間被 pause / terminate 的不覆蓋）
    fn finish(&self, wf: &str, id: &str, result: Result<Value>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let cur: String = conn.query_row("SELECT status FROM instances WHERE wf = ? AND id = ?", params![wf, id], |r| {
            r.get(0)
        })?;
        if cur != "running" {
            return Ok(());
        }
        let now = now_ms();
        match result {
            Ok(r) => match r["status"].as_str().unwrap_or("") {
                "complete" => conn.execute(
                    "UPDATE instances SET status = 'complete', output = ?, wake_at = NULL, waiting_for = NULL, updated = ? WHERE wf = ? AND id = ?",
                    params![r["output"].to_string(), now, wf, id],
                )?,
                "sleeping" => conn.execute(
                    "UPDATE instances SET status = 'sleeping', wake_at = ?, waiting_for = NULL, updated = ? WHERE wf = ? AND id = ?",
                    params![r["wakeAt"].as_i64(), now, wf, id],
                )?,
                "waiting" => conn.execute(
                    "UPDATE instances SET status = 'waiting', wake_at = ?, waiting_for = ?, updated = ? WHERE wf = ? AND id = ?",
                    params![r["wakeAt"].as_i64(), r["eventType"].as_str(), now, wf, id],
                )?,
                _ => conn.execute(
                    "UPDATE instances SET status = 'errored', error = ?, updated = ? WHERE wf = ? AND id = ?",
                    params![r["error"].as_str().unwrap_or("未知的錯誤"), now, wf, id],
                )?,
            },
            // 呼叫 Worker 失敗（程序重開中等）：稍後重試
            Err(e) => {
                tracing::warn!("Workflow {wf}/{id} 執行失敗，2 秒後重試：{e:#}");
                conn.execute(
                    "UPDATE instances SET status = 'sleeping', wake_at = ?, updated = ? WHERE wf = ? AND id = ?",
                    params![now + 2000, now, wf, id],
                )?
            }
        };
        Ok(())
    }
}

/// 排程器：一直找該跑的實例交給 Worker（最多同時 16 個）
pub async fn run_loop(slot: Arc<Slot>, wfs: Arc<Workflows>) {
    let limit = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        let notified = wfs.wake.notified();
        let ready = tokio::task::block_in_place(|| wfs.take_runnable(16)).unwrap_or_default();
        if ready.is_empty() {
            let _ = tokio::time::timeout(Duration::from_millis(250), notified).await;
            continue;
        }
        for (wf, id) in ready {
            let permit = limit.clone().acquire_owned().await;
            let (slot, wfs) = (slot.clone(), wfs.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let app = slot.get();
                let res = match wfs.snapshot(&wf, &id) {
                    Ok(snap) => {
                        let class = app
                            .cfg
                            .workflows
                            .iter()
                            .find(|w| w.binding == wf || w.name == wf)
                            .map(|w| w.class_name.clone());
                        let mut body = snap;
                        body["className"] = json!(class);
                        crate::gateway::invoke(&app, "workflow", &body).await
                    }
                    Err(e) => Err(e),
                };
                if let Err(e) = wfs.finish(&wf, &id, res) {
                    tracing::error!("Workflow {wf}/{id} 狀態更新失敗：{e:#}");
                }
                wfs.wake.notify_one();
            });
        }
    }
}
