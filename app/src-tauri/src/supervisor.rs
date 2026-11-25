//! Daemon supervisor: runs the bundled node + daemon payload, health-checks it
//! over HTTP, restarts it with exponential backoff and stops it on quit.
//!
//! Orphan protection, in layers:
//!   1. graceful: `shutdown()` closes the daemon's stdin pipe (app/launcher.mjs
//!      then runs the daemon's own shutdown) and, on macOS and Linux, also
//!      sends SIGTERM to its process group. After 8 s the whole tree is killed:
//!      SIGKILL to the group, or TerminateJobObject on Windows.
//!   2. app crash or kill: the daemon's stdin is a pipe whose write end only
//!      this process holds. The OS closes it when the app dies and
//!      app/launcher.mjs shuts the daemon down on EOF (plus a ppid poll). On
//!      Windows the daemon also sits in a Job Object with KILL_ON_JOB_CLOSE,
//!      so the OS ends the whole tree when the app's handle goes away.
//!   3. the daemon runs in its own process group (Job Object on Windows), so
//!      its children (stdio MCP mounts, Chromium, installed tools) end with it.
//!
//! Port: the daemon gets a stable loopback port saved in app-config.json. When
//! that port is taken by something else at start, a new free port is picked and
//! `on_port` reports (old, new) so the app can tell the user.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::logs::RotatingLog;

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Starting,
    Running,
    Attention(String),
    Stopped,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub status: Status,
    pub port: u16,
    pub pid: Option<u32>,
    pub restarts: u32,
}

pub struct Config {
    pub node: PathBuf,
    pub daemon_dir: PathBuf,
    pub daemon_root: PathBuf,
    pub port: u16,
    /// Extra environment for the daemon (on top of the fixed minimal set).
    pub extra_env: Vec<(String, String)>,
    pub daemon_log: Arc<RotatingLog>,
    pub app_log: Arc<RotatingLog>,
    pub secrets: Arc<Mutex<Vec<String>>>,
}

/// A running daemon: the node process plus, on Windows, the Job Object that
/// holds it and everything it starts.
struct Daemon {
    child: Child,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl Daemon {
    fn id(&self) -> u32 {
        self.child.id()
    }
}

struct Inner {
    child: Option<Daemon>,
    _stdin: Option<ChildStdin>, // held, never written: closing it tells the daemon to exit
    port: u16,
    status: Status,
    restarts: u32,
    stopping: bool,
    restart_requested: bool,
    token: Option<String>,
    /// Fresh per spawn; the daemon echoes it on /health (PLUGHIVE_INSTANCE_ID).
    instance: String,
}

type ChangeFn = Box<dyn Fn(Snapshot) + Send + Sync>;
type PortFn = Box<dyn Fn(u16, u16) + Send + Sync>;

pub struct Supervisor {
    cfg: Config,
    inner: Mutex<Inner>,
    wake: Condvar,
    on_change: ChangeFn,
    on_port: PortFn,
}

const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_EVERY: Duration = Duration::from_secs(5);
const STABLE_AFTER: Duration = Duration::from_secs(60);
const MAX_BACKOFF: u64 = 30;
const TERM_GRACE: Duration = Duration::from_secs(8);

impl Supervisor {
    pub fn new(
        cfg: Config,
        on_change: impl Fn(Snapshot) + Send + Sync + 'static,
        on_port: impl Fn(u16, u16) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let port = cfg.port;
        Arc::new(Self {
            cfg,
            inner: Mutex::new(Inner {
                child: None,
                _stdin: None,
                port,
                status: Status::Starting,
                restarts: 0,
                stopping: false,
                restart_requested: false,
                token: None,
                instance: String::new(),
            }),
            wake: Condvar::new(),
            on_change: Box::new(on_change),
            on_port: Box::new(on_port),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        let g = self.inner.lock().unwrap();
        Snapshot { status: g.status.clone(), port: g.port, pid: g.child.as_ref().map(|c| c.id()), restarts: g.restarts }
    }

    /// `http://127.0.0.1:<port>` while the daemon is healthy.
    pub fn base_url(&self) -> Option<String> {
        let s = self.snapshot();
        (s.status == Status::Running).then(|| format!("http://127.0.0.1:{}", s.port))
    }

    /// The admin token the running daemon accepts (read from its root).
    pub fn token(&self) -> Option<String> {
        self.inner.lock().unwrap().token.clone()
    }

    fn set_status(&self, status: Status) {
        {
            let mut g = self.inner.lock().unwrap();
            if g.status == status {
                return;
            }
            g.status = status;
        }
        (self.on_change)(self.snapshot());
    }

    fn log(&self, line: &str) {
        self.cfg.app_log.line("supervisor", line);
    }

    pub fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("daemon-supervisor".into())
            .spawn(move || me.run())
            .expect("spawn supervisor thread");
    }

    pub fn request_restart(&self) {
        let mut g = self.inner.lock().unwrap();
        g.restart_requested = true;
        self.wake.notify_all();
    }

    /// Stop supervising and terminate the daemon. Blocks up to ~8 s.
    pub fn shutdown(&self) {
        let child = {
            let mut g = self.inner.lock().unwrap();
            if g.stopping && g.child.is_none() {
                return;
            }
            g.stopping = true;
            g._stdin = None;
            self.wake.notify_all();
            g.child.take()
        };
        if let Some(c) = child {
            self.log(&format!("shutdown: terminating pid {}", c.id()));
            terminate(c);
            self.log("shutdown: daemon stopped");
        }
        self.set_status(Status::Stopped);
    }

    /// Sleep up to `d`, waking early on restart or stop requests.
    fn nap(&self, d: Duration) -> bool {
        let g = self.inner.lock().unwrap();
        if g.stopping || g.restart_requested {
            return true;
        }
        let (g, _) = self.wake.wait_timeout(g, d).unwrap();
        g.stopping || g.restart_requested
    }

    fn choose_port(&self) -> std::io::Result<u16> {
        let saved = self.inner.lock().unwrap().port;
        if saved != 0 {
            // Our own previous daemon may still be letting go of it.
            for _ in 0..12 {
                if port_free(saved) {
                    return Ok(saved);
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        let fresh = free_port()?;
        if saved == 0 {
            self.log(&format!("picked free port {fresh}"));
        } else {
            self.log(&format!("port {saved} unavailable, using {fresh}"));
        }
        (self.on_port)(saved, fresh);
        Ok(fresh)
    }

    fn spawn_daemon(&self) -> std::io::Result<u32> {
        let port = self.choose_port()?;
        std::fs::create_dir_all(&self.cfg.daemon_root)?;

        let mut cmd = Command::new(&self.cfg.node);
        cmd.arg("app/launcher.mjs")
            .current_dir(&self.cfg.daemon_dir)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        own_process_group(&mut cmd);
        // Minimal, explicit environment: the variables this OS needs to run
        // programs at all, a PATH where installed tools are found, and the
        // daemon settings. Nothing else from the app's environment leaks in.
        for k in PASS_ENV {
            if let Ok(v) = std::env::var(k) {
                cmd.env(k, v);
            }
        }
        cmd.env("PATH", daemon_path())
            .env("PLUGHIVE_NO_DOTENV", "1")
            .env("PLUGHIVE_PARENT_WATCH", "1")
            .env("PLUGHIVE_LOG_PRETTY", "0")
            .env("PLUGHIVE_BIND_HOST", "127.0.0.1")
            .env("PLUGHIVE_PORT", port.to_string())
            .env("PLUGHIVE_ROOT", &self.cfg.daemon_root);
        let instance = instance_id();
        cmd.env("PLUGHIVE_INSTANCE_ID", &instance);
        // macOS: the login Keychain. Windows and Linux: the daemon picks the
        // OS keyring (Credential Manager, Secret Service) or its own file.
        if cfg!(target_os = "macos") {
            cmd.env("PLUGHIVE_SECRETS", "keychain");
        }
        for (k, v) in &self.cfg.extra_env {
            cmd.env(k, v);
        }

        // A token kept from an earlier run is masked in the daemon's log from
        // its first line, not only once /health has passed.
        let _ = self.read_token();
        let mut g = self.inner.lock().unwrap();
        if g.stopping {
            return Err(std::io::Error::other("stopping"));
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        #[cfg(windows)]
        let job = match win::Job::for_child(&child) {
            Ok(j) => Some(j),
            Err(e) => {
                self.log(&format!("could not put pid {pid} in a job object: {e}"));
                None
            }
        };
        if let Some(out) = child.stdout.take() {
            self.cfg.daemon_log.pump("daemon", out);
        }
        if let Some(err) = child.stderr.take() {
            self.cfg.daemon_log.pump("daemon", err);
        }
        g._stdin = child.stdin.take();
        g.child = Some(Daemon {
            child,
            #[cfg(windows)]
            job,
        });
        g.port = port;
        g.token = None;
        g.instance = instance;
        drop(g);
        self.log(&format!("spawned pid {pid} on 127.0.0.1:{port}"));
        Ok(pid)
    }

    fn read_token(&self) -> Option<String> {
        let path = self.cfg.daemon_root.join("admin-token");
        let token = std::fs::read_to_string(&path).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if let Some(t) = &token {
            let mut s = self.cfg.secrets.lock().unwrap();
            if !s.contains(t) {
                s.push(t.clone());
            }
        }
        token
    }

    fn load_token(&self) {
        let token = self.read_token();
        if token.is_none() {
            self.log("admin token file missing or empty");
        }
        self.inner.lock().unwrap().token = token;
    }

    fn run(self: Arc<Self>) {
        let mut backoff: u64 = 1;
        loop {
            if self.inner.lock().unwrap().stopping {
                return;
            }
            self.set_status(Status::Starting);
            let pid = match self.spawn_daemon() {
                Ok(pid) => pid,
                Err(e) => {
                    if self.inner.lock().unwrap().stopping {
                        return;
                    }
                    self.log(&format!("spawn failed: {e}"));
                    self.set_status(Status::Attention(format!("could not start the daemon ({e})")));
                    self.nap(Duration::from_secs(backoff));
                    self.inner.lock().unwrap().restart_requested = false;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            };
            let started = Instant::now();
            let mut healthy_since: Option<Instant> = None;
            let mut last_check = Instant::now();
            let mut fails = 0u32;
            let reason: String;
            loop {
                let woke = self.nap(Duration::from_millis(250));
                let port;
                let instance;
                {
                    let mut g = self.inner.lock().unwrap();
                    if g.stopping {
                        return; // shutdown() owns termination
                    }
                    port = g.port;
                    instance = g.instance.clone();
                    if woke && g.restart_requested {
                        g.restart_requested = false;
                        let child = g.child.take();
                        g._stdin = None;
                        drop(g);
                        if let Some(c) = child {
                            terminate(c);
                        }
                        reason = "restart requested".into();
                        backoff = 1;
                        break;
                    }
                    if let Some(c) = g.child.as_mut() {
                        if let Ok(Some(st)) = c.child.try_wait() {
                            g.child = None;
                            g._stdin = None;
                            reason = format!("daemon exited ({st})");
                            break;
                        }
                    }
                }
                if healthy_since.is_none() {
                    if health(port, &instance) {
                        healthy_since = Some(Instant::now());
                        last_check = Instant::now();
                        self.load_token();
                        self.log(&format!("pid {pid} healthy after {} ms", started.elapsed().as_millis()));
                        self.set_status(Status::Running);
                    } else if started.elapsed() > HEALTH_TIMEOUT {
                        reason = format!("no answer on /health within {} s", HEALTH_TIMEOUT.as_secs());
                        self.kill_current();
                        break;
                    }
                } else if last_check.elapsed() >= HEALTH_EVERY {
                    last_check = Instant::now();
                    if health(port, &instance) {
                        fails = 0;
                    } else {
                        fails += 1;
                        self.log(&format!("health check failed ({fails}/3)"));
                        if fails >= 3 {
                            reason = "3 failed health checks".into();
                            self.kill_current();
                            break;
                        }
                    }
                }
            }
            if healthy_since.map(|t| t.elapsed() >= STABLE_AFTER).unwrap_or(false) {
                backoff = 1;
            }
            let wait = if reason == "restart requested" { 0 } else { backoff };
            self.inner.lock().unwrap().restarts += 1;
            self.log(&format!("pid {pid}: {reason}; restarting in {wait} s"));
            if wait > 0 {
                self.set_status(Status::Attention(format!("{reason}, restarting in {wait} s")));
                self.nap(Duration::from_secs(wait));
                self.inner.lock().unwrap().restart_requested = false;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }

    fn kill_current(&self) {
        let child = {
            let mut g = self.inner.lock().unwrap();
            g._stdin = None;
            g.child.take()
        };
        if let Some(c) = child {
            terminate(c);
        }
    }
}

/// Ask the daemon to stop, wait up to TERM_GRACE, then kill its whole tree.
/// Callers drop the stdin pipe first, which is the graceful signal on every
/// OS; macOS and Linux also get a SIGTERM to the process group.
fn terminate(mut d: Daemon) {
    #[cfg(unix)]
    let pgid = d.child.id() as i32;
    #[cfg(unix)]
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    let deadline = Instant::now() + TERM_GRACE;
    let mut exited = false;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = d.child.try_wait() {
            exited = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Reap stragglers in the group (mounts, browsers) too.
    #[cfg(unix)]
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    #[cfg(windows)]
    match d.job.take() {
        Some(job) => job.terminate(),
        None if !exited => {
            let _ = d.child.kill();
        }
        None => {}
    }
    if !exited {
        let _ = d.child.wait();
    }
}

/// Environment variables passed through to the daemon, per OS.
#[cfg(target_os = "macos")]
const PASS_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PLAYWRIGHT_BROWSERS_PATH"];
#[cfg(all(unix, not(target_os = "macos")))]
const PASS_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "PLAYWRIGHT_BROWSERS_PATH",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    // The Secret Service (GNOME Keyring, KWallet) is reached over the session bus.
    "DBUS_SESSION_BUS_ADDRESS",
];
#[cfg(windows)]
const PASS_ENV: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PLAYWRIGHT_BROWSERS_PATH",
];

/// PATH for the daemon. GUI apps on macOS and some Linux desktops start with
/// a bare PATH, so the usual package-manager folders are added; Windows apps
/// get the user's full PATH from Explorer, which is kept.
fn daemon_path() -> String {
    #[cfg(target_os = "macos")]
    {
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut dirs: Vec<String> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local/bin").to_string_lossy().into_owned());
        }
        for d in ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/snap/bin"] {
            dirs.push(d.to_string());
        }
        if let Ok(p) = std::env::var("PATH") {
            for d in p.split(':') {
                if !d.is_empty() && d.starts_with('/') && !dirs.iter().any(|x| x == d) {
                    dirs.push(d.to_string());
                }
            }
        }
        dirs.join(":")
    }
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let system = format!(r"{root}\System32;{root};{root}\System32\Wbem");
        match std::env::var("PATH") {
            Ok(p) if !p.trim().is_empty() => p,
            _ => system,
        }
    }
}

/// Put the daemon in its own process group (POSIX) or hide its console and
/// give it its own Ctrl+Break group (Windows).
fn own_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

#[cfg(windows)]
mod win {
    //! A Job Object with KILL_ON_JOB_CLOSE: every process the daemon starts
    //! joins it, and closing the handle (or the app dying) ends them all.
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // The handle is only used through the owning Daemon, behind a mutex.
    unsafe impl Send for Job {}

    impl Job {
        pub fn for_child(child: &Child) -> std::io::Result<Self> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        /// End every process in the job now.
        pub fn terminate(self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// A per-launch id that only this process and its daemon know. Two
/// SipHash states seeded by the OS's random keys, mixed with the time and pid:
/// no extra crate, and not guessable by another local process.
fn instance_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = String::with_capacity(32);
    for salt in 0u8..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u32(std::process::id());
        h.write_u8(salt);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Minimal HTTP/1.0 GET /health; true on 200 with `"ok":true` and our
/// daemon's instance id. Anything else on the port (a process that bound it
/// before our daemon could) is not trusted, so it never gets the admin token.
pub fn health(port: u16, instance: &str) -> bool {
    if port == 0 || instance.is_empty() {
        return false;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.take(64 * 1024).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    health_body_ok(&text, instance)
}

fn health_body_ok(text: &str, instance: &str) -> bool {
    (text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200"))
        && text.contains("\"ok\":true")
        && text.contains(&format!("\"instance\":\"{instance}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_no_credentials_to_the_daemon() {
        for k in PASS_ENV {
            let up = k.to_ascii_uppercase();
            let secret_like = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].iter().any(|w| up.contains(w));
            assert!(!secret_like, "{k} must not be passed through");
        }
    }

    #[test]
    fn health_needs_our_instance_id() {
        let ok = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"version\":\"1\",\"instance\":\"abc123abc123abc123\"}";
        assert!(health_body_ok(ok, "abc123abc123abc123"));
        assert!(!health_body_ok(ok, "someoneelse0000000"));
        assert!(!health_body_ok("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}", "abc123abc123abc123"));
        let a = instance_id();
        assert_eq!(a.len(), 32);
        assert_ne!(a, instance_id());
    }

    #[test]
    fn daemon_path_has_the_system_folders() {
        let path = daemon_path();
        #[cfg(unix)]
        assert!(path.split(':').any(|d| d == "/usr/bin"), "{path}");
        #[cfg(windows)]
        assert!(path.to_ascii_lowercase().contains("system32"), "{path}");
    }
}
