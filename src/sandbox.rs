//! 作業系統層級的隔離（`[isolation]`，只在 Linux）：不可信的應用（[install]、[dynamic]）的 Worker 程序
//! 放進 bubblewrap 的籠子——自己的 mount、pid、ipc、uts、network namespace，只看得到執行環境、自己的
//! 程式碼與 Durable Object 資料夾；網路只有 Unix socket（綁定 API、出口代理）。rucloud 是 root 時先換成
//! 沒有權限的使用者；有 cgroup v2 時每個應用限制記憶體、CPU 與程序數。Node 的權限模型照樣開著，
//! 這是第二道防線。
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct IsolationCfg {
    /// auto（預設：Linux 上有 bubblewrap 就用；`rucloud dev` 不用）、on（用不了就不啟動）、off
    #[serde(default = "auto")]
    pub mode: String,
    /// rucloud 是 root 時，Worker 換成這個使用者（要先建好，例如 useradd -r rucloud-worker）
    #[serde(default = "worker_user")]
    pub user: String,
    /// 每個應用最多用幾顆 CPU（cgroup 的 cpu.max）
    #[serde(default = "half")]
    pub cpu: f64,
    /// 每個 Worker 程序最多幾個程序／執行緒（pids.max）
    #[serde(default = "pids")]
    pub pids: u32,
    /// 籠子裡的 /tmp（MB）
    #[serde(default = "tmp_mb")]
    pub tmp_mb: u32,
}

fn auto() -> String {
    "auto".into()
}
fn worker_user() -> String {
    "rucloud-worker".into()
}
fn half() -> f64 {
    0.5
}
fn pids() -> u32 {
    64
}
fn tmp_mb() -> u32 {
    64
}

impl Default for IsolationCfg {
    fn default() -> Self {
        Self { mode: auto(), user: worker_user(), cpu: half(), pids: pids(), tmp_mb: tmp_mb() }
    }
}

pub struct Sandbox {
    bwrap: PathBuf,
    /// rucloud 是 root 時換成的使用者（uid, gid）
    pub user: Option<(u32, u32)>,
    /// cgroup v2：每個應用一個子 cgroup 的上層資料夾
    cgroups: Option<PathBuf>,
    /// seccomp 的 BPF 程式檔（bwrap --seccomp 讀它）
    seccomp: Option<CString>,
    cfg: IsolationCfg,
}

/// seccomp：Worker 用不到、又常被拿來攻擊核心的系統呼叫一律回 EPERM，其他照常（黑名單）。
/// 建立新的 namespace 另由 bwrap 的 --disable-userns 擋（clone3 的參數 seccomp 看不到）。
/// io_uring 也擋：libuv 用不了就改用一般的檔案 I/O
#[cfg(target_os = "linux")]
fn seccomp_program() -> Vec<u8> {
    use libc::*;
    #[allow(unused_mut)]
    let mut deny: Vec<c_long> = vec![
        SYS_ptrace, SYS_process_vm_readv, SYS_process_vm_writev, SYS_mount, SYS_umount2, SYS_pivot_root, SYS_setns,
        SYS_keyctl, SYS_add_key, SYS_request_key, SYS_bpf, SYS_userfaultfd, SYS_perf_event_open, SYS_kexec_load,
        SYS_kexec_file_load, SYS_init_module, SYS_finit_module, SYS_delete_module, SYS_swapon, SYS_swapoff, SYS_reboot,
        SYS_acct, SYS_quotactl, SYS_open_by_handle_at, SYS_name_to_handle_at, SYS_syslog, SYS_io_uring_setup,
        SYS_io_uring_enter, SYS_io_uring_register, SYS_fanotify_init, SYS_move_mount, SYS_open_tree, SYS_fsopen,
        SYS_fsconfig, SYS_fsmount, SYS_fspick,
    ];
    #[cfg(target_arch = "x86_64")]
    deny.extend([SYS_iopl, SYS_ioperm, SYS_modify_ldt, SYS_uselib]);
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xC000_003E; // AUDIT_ARCH_X86_64
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xC000_00B7; // AUDIT_ARCH_AARCH64
    const LD_W_ABS: u16 = 0x20;
    const JEQ_K: u16 = 0x15;
    const JGE_K: u16 = 0x35;
    const RET_K: u16 = 0x06;
    const ALLOW: u32 = 0x7fff_0000;
    const KILL: u32 = 0x8000_0000;
    const EPERM_: u32 = 0x0005_0000 | libc::EPERM as u32;
    let mut p: Vec<(u16, u8, u8, u32)> = vec![
        (LD_W_ABS, 0, 0, 4), // seccomp_data.arch
        (JEQ_K, 1, 0, ARCH),
        (RET_K, 0, 0, KILL),
        (LD_W_ABS, 0, 0, 0), // seccomp_data.nr
    ];
    let n = deny.len();
    // x86_64 的 x32 系統呼叫（nr 有 0x40000000）也拒絕
    if cfg!(target_arch = "x86_64") {
        p.push((JGE_K, (n + 1) as u8, 0, 0x4000_0000));
    }
    for (i, nr) in deny.iter().enumerate() {
        p.push((JEQ_K, (n - i) as u8, 0, *nr as u32));
    }
    p.push((RET_K, 0, 0, ALLOW));
    p.push((RET_K, 0, 0, EPERM_));
    p.iter().flat_map(|(code, jt, jf, k)| [&code.to_le_bytes()[..], &[*jt, *jf], &k.to_le_bytes()].concat()).collect()
}

#[cfg(not(target_os = "linux"))]
fn seccomp_program() -> Vec<u8> {
    Vec::new()
}

/// 一個應用的籠子
pub struct Cage {
    pub app: String,
    /// 唯讀：執行環境、程式碼、allow_read
    pub ro: Vec<PathBuf>,
    /// 可寫：Durable Object 的資料夾、allow_write
    pub rw: Vec<PathBuf>,
    /// 可以經過出口代理連到網際網路
    pub egress: bool,
    /// 出口代理另外放行的本機服務（host, port）
    pub allow_connect: Vec<(String, u16)>,
    pub memory_mb: Option<u32>,
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .chain(["/usr/bin".into(), "/bin".into()])
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

fn lookup_user(name: &str) -> Option<(u32, u32)> {
    let c = CString::new(name).ok()?;
    // SAFETY：getpwnam 回傳靜態的結構，在下一次呼叫前讀完
    unsafe {
        let pw = libc::getpwnam(c.as_ptr());
        (!pw.is_null()).then(|| ((*pw).pw_uid, (*pw).pw_gid))
    }
}

fn write(path: &Path, value: &str) -> std::io::Result<()> {
    std::fs::write(path, value)
}

/// cgroup v2：在 rucloud 自己的 cgroup 底下開 workers/，每個應用一個子 cgroup。
/// 有程序的 cgroup 不能開子樹的控制器，所以先把 rucloud 移到 rucloud/ 這個葉子。
fn setup_cgroups() -> Option<PathBuf> {
    let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let rel = text.lines().find_map(|l| l.strip_prefix("0::"))?;
    let own = Path::new("/sys/fs/cgroup").join(rel.trim_start_matches('/'));
    let have = std::fs::read_to_string(own.join("cgroup.controllers")).ok()?;
    let want: Vec<&str> = ["memory", "pids", "cpu"].into_iter().filter(|c| have.split_whitespace().any(|h| h == *c)).collect();
    if want.is_empty() {
        return None;
    }
    let enable = |dir: &Path| want.iter().all(|c| write(&dir.join("cgroup.subtree_control"), &format!("+{c}")).is_ok());
    if !enable(&own) {
        let leaf = own.join("rucloud");
        std::fs::create_dir_all(&leaf).ok()?;
        for pid in std::fs::read_to_string(own.join("cgroup.procs")).ok()?.lines() {
            let _ = write(&leaf.join("cgroup.procs"), pid);
        }
        if !enable(&own) {
            return None;
        }
    }
    let workers = own.join("workers");
    std::fs::create_dir_all(&workers).ok()?;
    enable(&workers).then_some(workers)
}

impl Sandbox {
    /// 依設定決定要不要隔離；用不了時 auto 回 None（並說明），on 回錯誤
    pub fn detect(cfg: Option<&crate::sandbox::IsolationCfg>, dev: bool, sock_dir: &Path) -> Result<Option<Arc<Sandbox>>> {
        let cfg = cfg.cloned().unwrap_or_default();
        match cfg.mode.as_str() {
            "off" => return Ok(None),
            "auto" if dev => return Ok(None),
            "auto" | "on" => {}
            m => bail!("[isolation] mode 要是 auto、on 或 off（{m}）"),
        }
        let strict = cfg.mode == "on";
        let fail = |why: String| -> Result<Option<Arc<Sandbox>>> {
            if strict {
                bail!("[isolation] mode = \"on\"，但{why}");
            }
            tracing::warn!("不可信的應用沒有作業系統層級的隔離：{why}（只有 Node 的權限模型）");
            Ok(None)
        };
        if !cfg!(target_os = "linux") {
            return fail("只有 Linux 支援".into());
        }
        let Some(bwrap) = find_in_path("bwrap") else {
            return fail("找不到 bubblewrap（bwrap；Debian：apt install bubblewrap）".into());
        };
        // SAFETY：geteuid 沒有副作用
        let root = unsafe { libc::geteuid() } == 0;
        let user = if root {
            match lookup_user(&cfg.user) {
                Some(u) => Some(u),
                None => {
                    if strict {
                        bail!("[isolation] 的使用者 {} 不存在（useradd -r {}）", cfg.user, cfg.user);
                    }
                    tracing::warn!("[isolation] 的使用者 {} 不存在：Worker 會以 root 進籠子", cfg.user);
                    None
                }
            }
        } else {
            None
        };
        let bpf = seccomp_program();
        let seccomp = if bpf.is_empty() {
            None
        } else {
            let path = sock_dir.join("seccomp.bpf");
            std::fs::write(&path, &bpf)?;
            Some(CString::new(path.as_os_str().as_bytes())?)
        };
        let sb = Sandbox {
            bwrap,
            user,
            cgroups: if root || Path::new("/sys/fs/cgroup/cgroup.controllers").exists() { setup_cgroups() } else { None },
            seccomp,
            cfg,
        };
        // 真的開一個籠子試試（user namespace 可能被核心或 AppArmor 擋掉）
        let mut probe = std::process::Command::new(&sb.bwrap);
        probe.args(["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--ro-bind", "/", "/", "true"]);
        if let Some((uid, gid)) = sb.user {
            use std::os::unix::process::CommandExt;
            probe.uid(uid).gid(gid);
        }
        match probe.output() {
            Ok(o) if o.status.success() => {}
            Ok(o) => return fail(format!("bubblewrap 開不了籠子：{}", String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => return fail(format!("bubblewrap 跑不起來：{e}")),
        }
        tracing::info!(
            "不可信的應用放進 bubblewrap 的籠子{}{}",
            sb.user.map(|(u, _)| format!("，使用者 uid {u}")).unwrap_or_default(),
            if sb.cgroups.is_some() { "，cgroup 限制資源" } else { "（沒有 cgroup v2：不限資源）" }
        );
        Ok(Some(Arc::new(sb)))
    }

    /// 換了使用者的 Worker 要進得了 rucloud 的資料夾（state_dir 與它的每一層上層都要讓其他使用者通過，例如 755）
    pub fn check_reachable(&self, state_root: &Path) {
        use std::os::unix::fs::PermissionsExt;
        if self.user.is_none() {
            return;
        }
        for dir in state_root.ancestors() {
            if let Ok(m) = std::fs::metadata(dir)
                && m.permissions().mode() & 0o001 == 0
            {
                tracing::error!(
                    "[isolation] Worker 換成沒有權限的使用者，但進不了 {}（權限 {:o}）：籠子裡的應用會起不來。請改成 755",
                    dir.display(),
                    m.permissions().mode() & 0o777
                );
                return;
            }
        }
    }

    /// 程序池開始時：應用的 cgroup 與上限、socket 資料夾的擁有者
    pub fn prepare(&self, cage: &Cage, sock_dir: &Path, instances: usize) -> Result<Option<CString>> {
        if let Some((uid, gid)) = self.user {
            std::os::unix::fs::chown(sock_dir, Some(uid), Some(gid))?;
            for d in &cage.rw {
                std::fs::create_dir_all(d)?;
                chown_tree(d, uid, gid)?;
            }
        }
        let Some(root) = &self.cgroups else { return Ok(None) };
        let name: String = cage.app.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        let dir = root.join(name);
        std::fs::create_dir_all(&dir)?;
        let n = instances.max(1) as u64;
        let mem = cage.memory_mb.map(|m| format!("{}", (m as u64 + 128) * n * 1024 * 1024)).unwrap_or_else(|| "max".into());
        let _ = write(&dir.join("memory.max"), &mem);
        let _ = write(&dir.join("pids.max"), &(self.cfg.pids as u64 * n).to_string());
        let _ = write(&dir.join("cpu.max"), &format!("{} 100000", ((self.cfg.cpu * 100_000.0) as u64).max(1000)));
        Ok(Some(CString::new(dir.join("cgroup.procs").as_os_str().as_bytes())?))
    }

    /// 把 node 指令包成 bwrap 的指令
    pub fn command(&self, cage: &Cage, node: &str, sock_dir: &Path, bindings: &Path, cwd: &Path) -> Result<tokio::process::Command> {
        let mut a: Vec<String> = vec![
            "--die-with-parent".into(),
            "--new-session".into(),
            "--unshare-all".into(),
            // 籠子裡不能再建 user namespace（也就建不了其他 namespace）
            "--unshare-user".into(),
            "--disable-userns".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--hostname".into(),
            "worker".into(),
        ];
        let s = |p: &Path| p.to_string_lossy().into_owned();
        // 系統：Node 與它的函式庫（/bin、/lib 在 merged-usr 的系統上是連結）
        for d in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc/ssl", "/etc/ca-certificates"] {
            let p = Path::new(d);
            match std::fs::read_link(p) {
                Ok(target) => a.extend(["--symlink".into(), s(&target), d.into()]),
                Err(_) if p.exists() => a.extend(["--ro-bind".into(), d.into(), d.into()]),
                Err(_) => {}
            }
        }
        // Node 不在 /usr 底下時（例如 /opt/node/bin/node），整個安裝資料夾唯讀放進來
        let node_path = if node.contains('/') { PathBuf::from(node) } else { find_in_path(node).context("找不到 node")? };
        let node_path = node_path.canonicalize().unwrap_or(node_path);
        if !node_path.starts_with("/usr") {
            let root = node_path.parent().and_then(|b| if b.ends_with("bin") { b.parent() } else { Some(b) }).unwrap_or(&node_path);
            a.extend(["--ro-bind".into(), s(root), s(root)]);
        }
        a.extend(["--proc".into(), "/proc".into(), "--dev".into(), "/dev".into()]);
        a.extend(["--size".into(), (self.cfg.tmp_mb as u64 * 1024 * 1024).to_string(), "--tmpfs".into(), "/tmp".into()]);
        for p in &cage.ro {
            if p.exists() {
                a.extend(["--ro-bind".into(), s(p), s(p)]);
            }
        }
        for p in &cage.rw {
            a.extend(["--bind".into(), s(p), s(p)]);
        }
        a.extend(["--bind".into(), s(sock_dir), s(sock_dir), "--bind".into(), s(bindings), s(bindings)]);
        if self.seccomp.is_some() {
            a.extend(["--seccomp".into(), SECCOMP_FD.to_string()]);
        }
        a.extend(["--chdir".into(), s(cwd), "--".into(), s(&node_path)]);
        let mut cmd = tokio::process::Command::new(&self.bwrap);
        cmd.args(a);
        Ok(cmd)
    }

    /// 在 exec bwrap 之前（子程序裡）：進應用的 cgroup，再換成沒有權限的使用者
    pub fn pre_exec(&self, cmd: &mut tokio::process::Command, cgroup_procs: Option<CString>) {
        let user = self.user;
        let seccomp = self.seccomp.clone();
        // SAFETY：只呼叫 async-signal-safe 的 open、write、close、dup2、setgroups、setgid、setuid
        unsafe {
            cmd.pre_exec(move || {
                // seccomp 的程式檔在固定的 fd 上交給 bwrap（--seccomp）
                if let Some(p) = &seccomp {
                    let fd = libc::open(p.as_ptr(), libc::O_RDONLY);
                    if fd < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if fd != SECCOMP_FD {
                        if libc::dup2(fd, SECCOMP_FD) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        libc::close(fd);
                    }
                }
                if let Some(p) = &cgroup_procs {
                    let fd = libc::open(p.as_ptr(), libc::O_WRONLY);
                    if fd >= 0 {
                        libc::write(fd, b"0".as_ptr().cast(), 1);
                        libc::close(fd);
                    }
                }
                if let Some((uid, gid)) = user
                    && (libc::setgroups(0, std::ptr::null()) != 0 || libc::setgid(gid) != 0 || libc::setuid(uid) != 0)
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

/// bwrap 從這個 fd 讀 seccomp 的程式
const SECCOMP_FD: i32 = 10;

fn chown_tree(p: &Path, uid: u32, gid: u32) -> Result<()> {
    std::os::unix::fs::chown(p, Some(uid), Some(gid))?;
    if p.is_dir() {
        for e in std::fs::read_dir(p)? {
            chown_tree(&e?.path(), uid, gid)?;
        }
    }
    Ok(())
}
