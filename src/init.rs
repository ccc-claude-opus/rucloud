//! `rucloud init`：從內建的範本建立新專案。範本放在 repo 的 templates/，編譯時嵌進執行檔。

use anyhow::{Context, Result, bail};
use std::path::Path;

pub struct Template {
    pub name: &'static str,
    pub description: &'static str,
    files: &'static [(&'static str, &'static str)],
}

pub const TEMPLATES: &[Template] = &[
    Template {
        name: "hello",
        description: "最小的 Worker + 靜態檔案（JavaScript）",
        files: &[
            ("public/index.html", include_str!("../templates/hello/public/index.html")),
            ("src/worker.js", include_str!("../templates/hello/src/worker.js")),
            ("wrangler.jsonc", include_str!("../templates/hello/wrangler.jsonc")),
        ],
    },
    Template {
        name: "typescript",
        description: "TypeScript Worker + KV，附 tsconfig 與 rucloud types",
        files: &[
            ("package.json", include_str!("../templates/typescript/package.json")),
            ("src/index.ts", include_str!("../templates/typescript/src/index.ts")),
            ("src/lib.ts", include_str!("../templates/typescript/src/lib.ts")),
            ("tsconfig.json", include_str!("../templates/typescript/tsconfig.json")),
            ("wrangler.jsonc", include_str!("../templates/typescript/wrangler.jsonc")),
        ],
    },
    Template {
        name: "d1",
        description: "D1 待辦清單：API + migrations + 前端",
        files: &[
            ("migrations/0001_init.sql", include_str!("../templates/d1/migrations/0001_init.sql")),
            ("public/index.html", include_str!("../templates/d1/public/index.html")),
            ("src/worker.js", include_str!("../templates/d1/src/worker.js")),
            ("wrangler.jsonc", include_str!("../templates/d1/wrangler.jsonc")),
        ],
    },
    Template {
        name: "durable-object",
        description: "SQLite 型 Durable Object 的強一致計數器",
        files: &[
            ("src/worker.js", include_str!("../templates/durable-object/src/worker.js")),
            ("wrangler.jsonc", include_str!("../templates/durable-object/wrangler.jsonc")),
        ],
    },
];

const GITIGNORE: &str = "node_modules/\n.rucloud/\n.wrangler/\n.dev.vars\n.dev.vars.*\n.env\n";

pub fn list() {
    for t in TEMPLATES {
        println!("{:<16} {}", t.name, t.description);
    }
}

pub fn create(dir: &Path, template: &str, name: Option<&str>, force: bool) -> Result<()> {
    let t = TEMPLATES
        .iter()
        .find(|t| t.name == template)
        .with_context(|| format!("沒有叫 {template} 的範本（rucloud init --list 看全部）"))?;
    if dir.exists() && std::fs::read_dir(dir)?.next().is_some() && !force {
        bail!("{} 不是空的；要寫進去請加 --force", dir.display());
    }
    let name = match name {
        Some(n) => n.to_string(),
        None => dir
            .canonicalize()
            .ok()
            .or_else(|| std::env::current_dir().ok().map(|c| c.join(dir)))
            .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "my-worker".into()),
    };
    // wrangler 的 name 只能是小寫英數字與 -
    let name: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let name = name.trim_matches('-').to_string();
    for (rel, content) in t.files {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, content.replace("{{name}}", &name))?;
    }
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        std::fs::write(gi, GITIGNORE)?;
    }
    println!("已用 {} 範本建立 {}（{}）", t.name, name, dir.display());
    println!();
    if t.name == "typescript" {
        println!("  npm install && rucloud types {}", dir.display());
    }
    let migrate = if t.files.iter().any(|(p, _)| p.starts_with("migrations/")) {
        " --d1-migrate"
    } else {
        ""
    };
    println!("  rucloud dev {}{migrate}", dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_have_valid_wrangler_config() {
        for t in TEMPLATES {
            let dir = std::env::temp_dir().join(format!("rucloud-init-{}-{}", t.name, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            create(&dir, t.name, Some("My App"), false).unwrap();
            let w = crate::config::load_wrangler(&dir, None).unwrap();
            assert_eq!(w.name.as_deref(), Some("my-app"), "{}", t.name);
            assert!(dir.join(w.main.unwrap()).is_file(), "{}", t.name);
            assert!(create(&dir, t.name, None, false).is_err(), "不是空的資料夾要拒絕");
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
