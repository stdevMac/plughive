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
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".app-config.{}.tmp", std::process::id()));
        {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
            f.write_all(b"\n")?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)
    }
}
