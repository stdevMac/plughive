//! Where the app keeps its files, and the small app-config.json.
//!
//! Normal run (data and logs come from Tauri's per-OS app folders):
//!   data     macOS   ~/Library/Application Support/<bundle id>/
//!            Windows %APPDATA%\<bundle id>\
//!            Linux   $XDG_DATA_HOME/<bundle id>/ (~/.local/share/...)
//!            app-config.json   port, first-run flag, window geometry
//!            daemon/           PLUGHIVE_ROOT (admin-token, db, artifacts, ...)
//!   logs     macOS ~/Library/Logs/<bundle id>/; Windows and Linux a logs
//!            folder under the local app data folder (app.log, daemon.log, rotated)
//!   clients  the user's home (Claude, Cursor, Codex, Hermes configs)
//!
//! Test run (`PLUGHIVE_APP_HOME=<dir>` in the app's environment): data goes to
//! <dir>/data, logs to <dir>/logs and client configs are written under
//! <dir>/home, so a test never touches the real home or the real app data.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    /// Home directory whose client configs "Connect a client" edits.
    pub clients_home: PathBuf,
    /// Set when PLUGHIVE_APP_HOME redirected everything (test run).
    pub test_home: Option<PathBuf>,
}

impl AppPaths {
    pub fn resolve(default_data: PathBuf, default_logs: PathBuf) -> Self {
        match std::env::var("PLUGHIVE_APP_HOME") {
            Ok(v) if !v.trim().is_empty() && Path::new(&v).is_absolute() => {
                let base = PathBuf::from(v);
                Self {
                    data_dir: base.join("data"),
                    log_dir: base.join("logs"),
                    clients_home: base.join("home"),
                    test_home: Some(base),
                }
            }
            _ => Self {
                data_dir: default_data,
                log_dir: default_logs,
                clients_home: dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
                test_home: None,
            },
        }
    }

    pub fn daemon_root(&self) -> PathBuf {
        self.data_dir.join("daemon")
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("app-config.json")
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// Loopback port the daemon listens on. 0 until the first start picks one.
    pub port: u16,
    pub first_run_done: bool,
    pub window: Option<Geometry>,
}

impl AppConfig {
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Atomic write (temp file + rename), mode 0600 on macOS and Linux. On
    /// Windows the file inherits the per-user ACL of the app data folder.
    /// The temp file has an unguessable name and is created new, so nothing
    /// planted in the folder (a symlink, another file) is ever written to.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
        fs::create_dir_all(dir)?;
        let body = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        let (tmp, mut f) = create_temp(dir)?;
        let written = f.write_all(&body).and_then(|()| f.write_all(b"\n")).and_then(|()| f.sync_all());
        drop(f);
        if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        Ok(())
    }
}

/// A new, owner-only temp file in `dir` with a random name.
fn create_temp(dir: &Path) -> std::io::Result<(PathBuf, fs::File)> {
    use std::hash::{BuildHasher, Hasher};
    let mut last = None;
    for attempt in 0u32..8 {
        // RandomState is seeded from the OS's random source.
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u32(std::process::id());
        h.write_u32(attempt);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        let tmp = dir.join(format!(".app-config.{:016x}.tmp", h.finish()));
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("could not create a temp file")))
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[cfg(unix)]
    #[test]
    fn save_never_writes_through_a_planted_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("plughive-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, "keep").unwrap();
        // The name older versions used: pid-based, so guessable.
        std::os::unix::fs::symlink(&victim, dir.join(format!(".app-config.{}.tmp", std::process::id()))).unwrap();
        let path = dir.join("app-config.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let cfg = AppConfig { port: 4242, ..Default::default() };
        cfg.save(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(AppConfig::load(&path).port, 4242);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file() && !e.path().is_symlink() && e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "temp files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
