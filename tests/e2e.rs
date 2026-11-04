//! 整合測試：用 Node 內建的 test runner 跑 tests/e2e/*.test.mjs（需要 Node.js 22.15 以上）。
//! 每個測試檔自己起一個 rucloud（這個 crate 剛編好的執行檔）。

use std::process::Command;

#[test]
fn e2e() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("找不到 node，略過整合測試");
        return;
    }
    let status = Command::new("node")
        .args(["--test", "--test-concurrency=1", "tests/e2e/*.test.mjs"])
        .env("RUCLOUD_BIN", env!("CARGO_BIN_EXE_rucloud"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("無法執行 node --test");
    assert!(status.success(), "整合測試失敗");
}
