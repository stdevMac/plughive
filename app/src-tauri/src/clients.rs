//! "Connect a client": runs the bundled node on app/clients.mjs (a thin bridge
//! over dist/src/clients) with a JSON request on stdin. The request goes over
//! stdin so nothing sensitive appears in the process list.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(windows)]
const CLIENT_ENV: &[&str] = &["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
#[cfg(not(windows))]
const CLIENT_ENV: &[&str] = &["TMPDIR", "LANG", "XDG_CONFIG_HOME"];

pub const CLIENT_IDS: [&str; 5] = ["claude-desktop", "claude-code", "cursor", "codex", "hermes"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    pub name: String,
    pub config_path: String,
    pub installed: bool,
    pub connected: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub changed: bool,
    pub note: Option<String>,
    pub restart_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetargetResult {
    pub name: String,
    pub path: String,
    pub changed: bool,
    pub restart_hint: Option<String>,
    pub error: Option<String>,
}

pub struct Bridge {
    pub node: PathBuf,
    pub daemon_dir: PathBuf,
    pub home: PathBuf,
}

impl Bridge {
    fn call(&self, mut req: Value) -> Result<Value, String> {
        req["home"] = json!(self.home.to_string_lossy());
        let mut cmd = Command::new(&self.node);
        cmd.arg("app/clients.mjs").current_dir(&self.daemon_dir).env_clear().env("HOME", &self.home);
        // Only what node needs to start and the client configs need to be
        // found: APPDATA (Claude Desktop on Windows), XDG_CONFIG_HOME (Linux).
        for k in CLIENT_ENV {
            if let Ok(v) = std::env::var(k) {
                cmd.env(k, v);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            cmd.env("PATH", format!(r"{root}\System32;{root}"));
        }
        #[cfg(not(windows))]
        cmd.env("PATH", "/usr/bin:/bin");
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run the bundled node: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(req.to_string().as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let v: Value = serde_json::from_str(text.trim())
            .map_err(|_| format!("unexpected output from clients.mjs (exit {})", out.status))?;
        if v["ok"] == json!(true) {
            Ok(v["result"].clone())
        } else {
            Err(v["error"].as_str().unwrap_or("unknown error").to_string())
        }
    }

    pub fn list(&self) -> Result<Vec<ClientInfo>, String> {
        serde_json::from_value(self.call(json!({"op": "list"}))?).map_err(|e| e.to_string())
    }

    pub fn connect(&self, id: &str, url: &str) -> Result<WriteResult, String> {
        serde_json::from_value(self.call(json!({"op": "connect", "id": id, "url": url}))?).map_err(|e| e.to_string())
    }

    pub fn disconnect(&self, id: &str) -> Result<WriteResult, String> {
        serde_json::from_value(self.call(json!({"op": "disconnect", "id": id}))?).map_err(|e| e.to_string())
    }

    pub fn retarget(&self, from: &str, url: &str) -> Result<Vec<RetargetResult>, String> {
        serde_json::from_value(self.call(json!({"op": "retarget", "from": from, "url": url}))?)
            .map_err(|e| e.to_string())
    }
}
