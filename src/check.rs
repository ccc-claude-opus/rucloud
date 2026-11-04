//! `rucloud check [rucloud.toml | 應用資料夾]`：啟動前檢查設定。
//! 只讀檔案、不啟動任何東西；有錯誤時回傳 false（指令以 1 結束）。

use crate::config::{self, AppEntry, ServeConfig};
use std::collections::HashMap;
use std::path::Path;

#[derive(Default)]
struct Report {
    errors: usize,
    warnings: usize,
}

impl Report {
    fn ok(&self, msg: &str) {
        println!("  ✓ {msg}");
    }
    fn warn(&mut self, msg: &str) {
        self.warnings += 1;
        println!("  ⚠ {msg}");
    }
    fn err(&mut self, msg: &str) {
        self.errors += 1;
        println!("  ✗ {msg}");
    }
}

pub fn run(target: &Path) -> anyhow::Result<bool> {
    let mut r = Report::default();
    let cfg = if target.is_dir() {
        println!("應用 {}", target.display());
        single(target)
    } else {
        println!("設定檔 {}", target.display());
        match config::load_serve_config(target) {
            Ok(c) => {
                r.ok("格式正確");
                c
            }
            Err(e) => {
                r.err(&format!("{e:#}"));
                return finish(&r);
            }
        }
    };

    check_node(&mut r);
    check_ports(&cfg, &mut r);

    let mut names: HashMap<String, usize> = HashMap::new();
    let mut hosts: HashMap<String, String> = HashMap::new();
    let mut services = Vec::new();
    let mut known_apps = Vec::new();
    for entry in &cfg.apps {
        let name = crate::app::app_name(entry).unwrap_or_else(|_| entry.path.display().to_string());
        println!("\n應用 {name}（{}）", entry.path.display());
        *names.entry(name.clone()).or_default() += 1;
        for h in &entry.hosts {
            if let Some(other) = hosts.insert(h.clone(), name.clone()) {
                r.err(&format!("host {h} 同時給了 {other} 和 {name}"));
            }
        }
        if let Some(svcs) = check_app(entry, &mut r) {
            for s in svcs {
                services.push((name.clone(), s));
            }
        }
        known_apps.push(name);
    }
    for (name, n) in names {
        if n > 1 {
            r.err(&format!("應用名稱 {name} 重複了 {n} 次（用 name = \"…\" 區分）"));
        }
    }
    for (from, target) in services {
        if !known_apps.contains(&target) {
            r.err(&format!("{from} 的 service binding 指向 {target}，但沒有這個應用"));
        }
    }
    finish(&r)
}

fn finish(r: &Report) -> anyhow::Result<bool> {
    println!("\n{} 個錯誤、{} 個警告", r.errors, r.warnings);
    Ok(r.errors == 0)
}

/// 單一應用資料夾：用 rucloud dev 的預設值檢查
fn single(dir: &Path) -> ServeConfig {
    toml::from_str::<ServeConfig>(&format!("[[app]]\npath = {:?}\n", dir.display().to_string())).expect("預設設定一定讀得起來")
}

fn check_node(r: &mut Report) {
    match std::process::Command::new("node").arg("--version").output() {
        Ok(out) => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let parts: Vec<u32> = v.trim_start_matches('v').split('.').filter_map(|x| x.parse().ok()).collect();
            let ok = matches!(parts.as_slice(), [major, minor, ..] if *major > 22 || (*major == 22 && *minor >= 15));
            if ok {
                r.ok(&format!("Node.js {v}"));
            } else {
                r.err(&format!("Node.js {v} 太舊，需要 22.15 以上（建議 24）"));
            }
        }
        Err(_) => r.err("找不到 node（需要 Node.js 22.15 以上）"),
    }
}

fn check_ports(cfg: &ServeConfig, r: &mut Report) {
    let mut ports: HashMap<u16, Vec<String>> = HashMap::new();
    let mut add = |p: u16, who: String| ports.entry(p).or_default().push(who);
    if let Some(e) = &cfg.edge {
        add(e.port, "edge".into());
    }
    if let Some(a) = &cfg.admin {
        add(a.port, "admin".into());
        if a.bind != "127.0.0.1" && a.bind != "localhost" && a.token.is_none() {
            r.warn(&format!("管理埠聽在 {} 但沒有設定 token，任何連得到的人都能部署、看 log", a.bind));
        }
    }
    if let Some(t) = &cfg.tls {
        add(t.port, "tls".into());
        let has_static = t.cert.is_some() || t.key.is_some();
        if has_static == t.acme.is_some() || t.cert.is_some() != t.key.is_some() {
            r.err("[tls] 要設定 cert + key，或 acme（二選一）");
        }
        for p in [&t.cert, &t.key].into_iter().flatten() {
            if !p.exists() {
                r.err(&format!("找不到 {}", p.display()));
            }
        }
        if t.redirect_http && cfg.edge.is_none() {
            r.warn("[tls] redirect_http 需要 [edge] 的 HTTP 埠");
        }
    }
    if let Some(s) = &cfg.s3 {
        add(s.port, "s3".into());
        if s.secret_access_key.len() < 16 {
            r.warn("[s3] secret_access_key 太短");
        }
    }
    if let Some(g) = &cfg.ai_gateway {
        add(g.port, "ai_gateway".into());
    }
    for a in &cfg.apps {
        if let Some(p) = a.port {
            add(p, format!("應用 {}", a.path.display()));
        }
    }
    for (p, who) in ports {
        if who.len() > 1 {
            r.err(&format!("埠 {p} 重複：{}", who.join("、")));
        }
    }
}

/// 回傳這個應用的 service binding 目標
fn check_app(entry: &AppEntry, r: &mut Report) -> Option<Vec<String>> {
    let dir = match entry.path.canonicalize() {
        Ok(d) => d,
        Err(_) => {
            r.err("找不到應用資料夾");
            return None;
        }
    };
    let w = match config::load_wrangler(&dir, entry.env.as_deref()) {
        Ok(w) => {
            r.ok("wrangler 設定讀得起來");
            w
        }
        Err(e) => {
            r.err(&format!("{e:#}"));
            return None;
        }
    };
    for (key, why) in config::unsupported_keys(&dir, entry.env.as_deref()) {
        r.warn(&format!("wrangler 設定的 {key}：{why}"));
    }
    match &w.main {
        Some(m) if !dir.join(m).is_file() => r.err(&format!("找不到 main {m}")),
        Some(m) => r.ok(&format!("main {m}")),
        None if w.assets.is_none() => r.err("沒有 main 也沒有 assets，沒有東西可以跑"),
        None => r.ok("只有靜態檔案"),
    }
    if let Some(a) = &w.assets {
        let d = dir.join(a.directory.as_deref().unwrap_or("./public"));
        if d.is_dir() {
            r.ok(&format!("靜態檔案 {}", d.display()));
        } else {
            r.err(&format!("找不到靜態檔案資料夾 {}", d.display()));
        }
    }
    for (binding, file) in &entry.d1_init {
        if !w.d1_databases.iter().any(|d| &d.binding == binding) {
            r.err(&format!("d1_init 的 {binding} 不是 D1 綁定"));
        }
        let f = if file.is_relative() { dir.join(file) } else { file.clone() };
        if !f.is_file() {
            r.err(&format!("找不到 d1_init 的 {}", f.display()));
        }
    }
    if let Some(f) = &entry.env_file
        && !f.is_file()
    {
        r.err(&format!("找不到 env_file {}", f.display()));
    }
    for p in entry.allow_read.iter().chain(&entry.allow_write) {
        if !p.exists() {
            r.warn(&format!("沙箱允許的路徑不存在：{}", p.display()));
        }
    }
    if !entry.sandbox {
        r.warn("sandbox = false：Worker 可以讀寫任何檔案、開子程序");
    }
    for h in &w.hyperdrive {
        let var = format!("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{}", h.binding);
        let in_vars = config::load_dev_vars(&dir, entry.env.as_deref()).contains_key(&var);
        if h.local_connection_string.is_none() && !in_vars && std::env::var(&var).is_err() {
            r.warn(&format!("Hyperdrive {} 沒有連線字串（localConnectionString 或 {var}）", h.binding));
        }
    }
    let classes: Vec<&str> = w.durable_objects.bindings.iter().map(|d| d.class_name.as_str()).collect();
    if !classes.is_empty() {
        r.ok(&format!("Durable Objects：{}", classes.join("、")));
    }
    Some(w.services.iter().map(|s| s.service.clone()).collect())
}
