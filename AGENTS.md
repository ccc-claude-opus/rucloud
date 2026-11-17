# AGENTS.md

## What this repo is

Self-hostable Cloudflare-Workers-like platform. **Rust core (this crate, axum gateway + all data bindings in SQLite) runs Worker JS/TS via Node.js subprocesses.** Node runtime shim lives in `runtime/*.mjs` (shipped in the crate via `Cargo.toml` `include`). Single binary `rucloud`, entrypoint `src/main.rs`, CLI in `src/cli.rs`, one module per binding (d1.rs, kv.rs, r2.rs, queues.rs, durable.rs, vectorize.rs, workflows.rs, …).

## Commands

CI order (`.github/workflows/ci.yml`): `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test` → `cargo publish --dry-run`. Keep clippy warning-free.

- Test: `cargo test` — runs Rust unit tests **and** the e2e integration suite (`tests/e2e.rs` shells out to `node --test --test-concurrency=1 tests/e2e/*.test.mjs`). Requires **Node ≥ 22.15** (CI uses 24); e2e is silently skipped if `node` is missing, so a green run with no node ≠ passing e2e.
- Single e2e test file: `RUCLOUD_BIN=target/release/rucloud node --test tests/e2e/d1.test.mjs` (build with `cargo build` first).
- ACME tests need Pebble binary; CI sets `PEBBLE_BIN=/tmp/pebble` (see ci.yml for the download snippet).
- Run a local server: `./run.sh` = `cargo run --release -- serve examples/rucloud.toml`.
- `apps/` contains real sample worker apps (wrangler-style projects), `examples/` has serve configs — useful for manual testing.

## Updating the live site (rucloud.cc on Linode)

The production server is a Linode running rucloud as the passwordless `service` account (SSH key auth only — the private key is in the user's `~/.ssh/`, **never commit or print it**). To ship changes to `sites/`:

1. Commit + push to GitHub `main` (local SSH key has no GitHub access; push via `gh` token over HTTPS: `git -c credential.helper='!f() { echo username=ccckmit; echo password=$(gh auth token); }; f' push https://github.com/ccc-claude-opus/rucloud.git <branch>:main`).
2. Pull and deploy on the server (admin API is localhost-only; token in `~/state/admin-token`):

   ```bash
   ssh service@139.162.90.34
   cd ~/rucloud && git pull --ff-only
   rucloud deploy sites/ccc --admin http://127.0.0.1:8799 --token "$(cat ~/state/admin-token)" -m "更新"
   ```

Deployed apps are copied into the server's state dir — re-deploy after editing `sites/`. Server logs: `journalctl -u rucloud -f`; restart: `sudo systemctl restart rucloud`.

## Conventions

- rustfmt `max_width = 140`.
- Comments, doc comments, CLI strings, and README are largely in Traditional Chinese — match that in user-facing text; code identifiers in English.
- Release flow: push tag `v*` → GitHub Actions builds musl/macOS binaries; `publish.sh` = `git push --follow-tags && cargo publish`. Update `CHANGELOG.md`.
- `Cargo.toml` `include` lists exactly `/src`, `/runtime`, `/templates` — anything the runtime needs at install time must live there.
