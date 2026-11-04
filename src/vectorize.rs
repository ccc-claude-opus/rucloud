//! Vectorize：向量存在 SQLite，查詢時整個索引載入記憶體做暴力搜尋。
//! 小型索引（數萬筆以內）夠快；寫入時讓快取失效。

use crate::d1::open_sqlite;
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

struct Item {
    id: String,
    namespace: Option<String>,
    values: Vec<f32>,
    norm: f32,
    metadata: Value,
}

pub struct VectorStore {
    conn: Mutex<Connection>,
    cache: Mutex<HashMap<String, Arc<Vec<Item>>>>,
}

impl VectorStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vectors (
               idx TEXT NOT NULL, id TEXT NOT NULL, namespace TEXT, vals BLOB NOT NULL, metadata TEXT NOT NULL,
               PRIMARY KEY (idx, id)) WITHOUT ROWID;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn op(&self, index: &str, metric: &str, op: &str, req: &Value) -> Result<Value> {
        match op {
            "insert" | "upsert" => {
                let vectors = req["vectors"].as_array().cloned().unwrap_or_default();
                let mut conn = self.conn.lock().unwrap();
                let tx = conn.transaction()?;
                let mut ids = Vec::new();
                for v in &vectors {
                    let id = v["id"].as_str().unwrap_or_default().to_string();
                    let vals: Vec<u8> = v["values"]
                        .as_array()
                        .map(|a| a.iter().flat_map(|x| (x.as_f64().unwrap_or(0.0) as f32).to_le_bytes()).collect())
                        .unwrap_or_default();
                    let sql = if op == "insert" {
                        "INSERT OR IGNORE INTO vectors VALUES (?, ?, ?, ?, ?)"
                    } else {
                        "INSERT OR REPLACE INTO vectors VALUES (?, ?, ?, ?, ?)"
                    };
                    let meta = if v["metadata"].is_object() {
                        v["metadata"].to_string()
                    } else {
                        "{}".into()
                    };
                    tx.execute(sql, params![index, id, v["namespace"].as_str(), vals, meta])?;
                    ids.push(id);
                }
                tx.commit()?;
                self.cache.lock().unwrap().remove(index);
                Ok(json!({ "ids": ids, "count": ids.len(), "mutationId": format!("{:016x}", rand::random::<u64>()) }))
            }
            "deleteByIds" => {
                let conn = self.conn.lock().unwrap();
                let mut n = 0;
                for id in req["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
                    n += conn.execute("DELETE FROM vectors WHERE idx = ? AND id = ?", params![index, id])?;
                }
                self.cache.lock().unwrap().remove(index);
                Ok(json!({ "count": n, "ids": req["ids"], "mutationId": format!("{:016x}", rand::random::<u64>()) }))
            }
            "getByIds" => {
                let items = self.items(index)?;
                let want: Vec<&str> = req["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
                Ok(Value::Array(
                    items
                        .iter()
                        .filter(|i| want.contains(&i.id.as_str()))
                        .map(|i| item_json(i, None, true, true))
                        .collect(),
                ))
            }
            "describe" => {
                let items = self.items(index)?;
                let dims = items.first().map(|i| i.values.len()).unwrap_or(0);
                Ok(json!({ "vectorCount": items.len(), "dimensions": dims, "config": { "metric": metric, "dimensions": dims } }))
            }
            "query" => {
                let q: Vec<f32> = req["vector"]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect())
                    .unwrap_or_default();
                let opts = &req["options"];
                let top_k = opts["topK"].as_u64().unwrap_or(5).clamp(1, 100) as usize;
                let rv = opts["returnValues"].as_bool().unwrap_or(false);
                let rm = !matches!(opts["returnMetadata"].as_str(), None | Some("none")) || opts["returnMetadata"] == json!(true);
                let ns = opts["namespace"].as_str();
                let filter = &opts["filter"];
                let qn = norm(&q);
                let items = self.items(index)?;
                let filter_empty = filter.as_object().is_none_or(|f| f.is_empty());
                // 精確搜尋：多執行緒掃描，每條執行緒只留自己的前 topK 名，最後合併
                let best = best_k(&items, top_k, |i: &Item| {
                    if i.values.len() != q.len()
                        || (ns.is_some() && i.namespace.as_deref() != ns)
                        || (!filter_empty && !matches_filter(&i.metadata, filter))
                    {
                        return None;
                    }
                    let s = score(metric, &q, qn, i);
                    // euclidean 越小越近，其他越大越近；排名一律用「越大越好」
                    Some(if metric == "euclidean" { -s } else { s })
                });
                let matches: Vec<Value> = best
                    .into_iter()
                    .map(|(s, i)| item_json(&items[i], Some(if metric == "euclidean" { -s } else { s }), rv, rm))
                    .collect();
                Ok(json!({ "count": matches.len(), "matches": matches }))
            }
            other => bail!("不支援的 Vectorize 操作 {other}"),
        }
    }

    fn items(&self, index: &str) -> Result<Arc<Vec<Item>>> {
        if let Some(c) = self.cache.lock().unwrap().get(index) {
            return Ok(c.clone());
        }
        let conn = self.conn.lock().unwrap();
        let items: Vec<Item> = conn
            .prepare("SELECT id, namespace, vals, metadata FROM vectors WHERE idx = ?")?
            .query_map([index], |r| {
                let raw: Vec<u8> = r.get(2)?;
                let values: Vec<f32> = raw.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
                let meta: String = r.get(3)?;
                Ok(Item {
                    id: r.get(0)?,
                    namespace: r.get(1)?,
                    norm: norm(&values),
                    values,
                    metadata: serde_json::from_str(&meta).unwrap_or(json!({})),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let items = Arc::new(items);
        self.cache.lock().unwrap().insert(index.to_string(), items.clone());
        Ok(items)
    }
}

/// 依 rank（越大越好）取前 k 名，回傳 (rank, 索引)，由好到壞
fn best_k(items: &[Item], k: usize, rank: impl Fn(&Item) -> Option<f32> + Sync) -> Vec<(f32, usize)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    // 用 total_cmp 比大小（NaN 也有固定順序），四個比較 trait 要一致
    struct R(f32);
    impl PartialEq for R {
        fn eq(&self, o: &Self) -> bool {
            self.0.total_cmp(&o.0).is_eq()
        }
    }
    impl Eq for R {}
    impl PartialOrd for R {
        fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for R {
        fn cmp(&self, o: &Self) -> std::cmp::Ordering {
            self.0.total_cmp(&o.0)
        }
    }
    let scan = |lo: usize, hi: usize| {
        // 小頂堆：堆頂是目前留下來最差的
        let mut heap: BinaryHeap<Reverse<(R, usize)>> = BinaryHeap::with_capacity(k + 1);
        for (j, item) in items[lo..hi].iter().enumerate() {
            let Some(r) = rank(item) else { continue };
            if heap.len() < k {
                heap.push(Reverse((R(r), lo + j)));
            } else if heap.peek().is_some_and(|Reverse((w, _))| r > w.0) {
                heap.pop();
                heap.push(Reverse((R(r), lo + j)));
            }
        }
        heap.into_iter().map(|Reverse((r, i))| (r.0, i)).collect::<Vec<_>>()
    };
    let threads = if items.len() < 4096 {
        1
    } else {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8)
    };
    let chunk = items.len().div_ceil(threads.max(1)).max(1);
    let mut all: Vec<(f32, usize)> = if threads == 1 {
        scan(0, items.len())
    } else {
        std::thread::scope(|s| {
            let handles: Vec<_> = (0..items.len())
                .step_by(chunk)
                .map(|lo| s.spawn(move || scan(lo, (lo + chunk).min(items.len()))))
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    };
    all.sort_by(|a, b| b.0.total_cmp(&a.0));
    all.truncate(k);
    all
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

fn score(metric: &str, q: &[f32], qn: f32, i: &Item) -> f32 {
    let dot: f32 = q.iter().zip(&i.values).map(|(a, b)| a * b).sum();
    match metric {
        "dot-product" => dot,
        "euclidean" => q.iter().zip(&i.values).map(|(a, b)| (a - b) * (a - b)).sum::<f32>().sqrt(),
        _ => {
            if qn == 0.0 || i.norm == 0.0 {
                0.0
            } else {
                dot / (qn * i.norm)
            }
        }
    }
}

/// 支援 {k: v}、{k: {$eq|$ne|$in|$nin|$lt|$lte|$gt|$gte: ...}}
fn matches_filter(meta: &Value, filter: &Value) -> bool {
    let Some(f) = filter.as_object() else { return true };
    f.iter().all(|(k, cond)| {
        let v = &meta[k.as_str()];
        match cond.as_object() {
            Some(ops) => ops.iter().all(|(op, x)| match op.as_str() {
                "$eq" => v == x,
                "$ne" => v != x,
                "$in" => x.as_array().is_some_and(|a| a.contains(v)),
                "$nin" => !x.as_array().is_some_and(|a| a.contains(v)),
                "$lt" | "$lte" | "$gt" | "$gte" => match (v.as_f64(), x.as_f64()) {
                    (Some(a), Some(b)) => match op.as_str() {
                        "$lt" => a < b,
                        "$lte" => a <= b,
                        "$gt" => a > b,
                        _ => a >= b,
                    },
                    _ => false,
                },
                _ => true,
            }),
            None => v == cond,
        }
    })
}

fn item_json(i: &Item, score: Option<f32>, values: bool, metadata: bool) -> Value {
    let mut o = json!({ "id": i.id });
    if let Some(s) = score {
        o["score"] = json!(s);
    }
    if values {
        o["values"] = json!(i.values);
    }
    if metadata {
        o["metadata"] = i.metadata.clone();
    }
    if let Some(ns) = &i.namespace {
        o["namespace"] = json!(ns);
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_query_with_filter() {
        let dir = std::env::temp_dir().join(format!("rucloud-vec-{}", std::process::id()));
        let s = VectorStore::open(&dir.join("v.sqlite")).unwrap();
        s.op(
            "i",
            "cosine",
            "upsert",
            &json!({ "vectors": [
                { "id": "a", "values": [1, 0], "metadata": { "lang": "zh" } },
                { "id": "b", "values": [0, 1], "metadata": { "lang": "en" } },
                { "id": "c", "values": [0.9, 0.1], "metadata": { "lang": "en" } },
            ]}),
        )
        .unwrap();
        let r = s
            .op("i", "cosine", "query", &json!({ "vector": [1, 0], "options": { "topK": 2 } }))
            .unwrap();
        assert_eq!(r["matches"][0]["id"], "a");
        assert_eq!(r["matches"][1]["id"], "c");
        let r = s
            .op(
                "i",
                "cosine",
                "query",
                &json!({ "vector": [1, 0], "options": { "filter": { "lang": "en" } } }),
            )
            .unwrap();
        assert_eq!(r["matches"][0]["id"], "c");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod topk_tests {
    use super::*;

    #[test]
    fn parallel_top_k_matches_full_sort() {
        let mut seed = 7u64;
        let items: Vec<Item> = (0..20_000)
            .map(|i| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let v = vec![(seed >> 40) as f32, i as f32 % 13.0];
                Item {
                    id: i.to_string(),
                    namespace: None,
                    norm: norm(&v),
                    values: v,
                    metadata: json!({}),
                }
            })
            .collect();
        let rank = |i: &Item| {
            if i.id.ends_with('7') {
                None
            } else {
                Some(i.values[0] - i.values[1])
            }
        };
        let got: Vec<usize> = best_k(&items, 25, rank).into_iter().map(|(_, i)| i).collect();
        let mut all: Vec<(f32, usize)> = items.iter().enumerate().filter_map(|(j, i)| rank(i).map(|r| (r, j))).collect();
        all.sort_by(|a, b| b.0.total_cmp(&a.0));
        let want: Vec<f32> = all.iter().take(25).map(|x| x.0).collect();
        let got_scores: Vec<f32> = got.iter().map(|&j| rank(&items[j]).unwrap()).collect();
        assert_eq!(got_scores, want);
        assert!(got.iter().all(|&j| !items[j].id.ends_with('7')), "過濾掉的不能出現");
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// cargo test --release vectorize::bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn query_100k_768() {
        let dir = std::env::temp_dir().join(format!("rucloud-vbench-{}", std::process::id()));
        let s = VectorStore::open(&dir.join("v.sqlite")).unwrap();
        let mut seed = 1u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        for batch in 0..100 {
            let vectors: Vec<Value> = (0..1000)
                .map(|i| json!({ "id": format!("v{}", batch * 1000 + i), "values": (0..768).map(|_| rnd()).collect::<Vec<_>>() }))
                .collect();
            s.op("i", "cosine", "upsert", &json!({ "vectors": vectors })).unwrap();
        }
        let q: Vec<f64> = (0..768).map(|_| rnd()).collect();
        s.op("i", "cosine", "query", &json!({ "vector": q, "options": { "topK": 10 } }))
            .unwrap(); // 載入快取
        let t = std::time::Instant::now();
        for _ in 0..10 {
            s.op("i", "cosine", "query", &json!({ "vector": q, "options": { "topK": 10 } }))
                .unwrap();
        }
        println!("100k x 768 查詢平均 {:.1} ms", t.elapsed().as_secs_f64() * 100.0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
