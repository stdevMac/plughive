//! Size-rotated log files with secret redaction.
//!
//! The daemon's stdout/stderr are piped through here instead of being
//! attached to a file directly, so every line passes the redactor: the admin
//! token (once known) is replaced, and `token=...`, `#token=...` and
//! `Bearer ...` values are masked whatever their source.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: u32 = 3;
const MASK: &str = "[redacted]";

struct State {
    file: Option<File>,
    size: u64,
}

pub struct RotatingLog {
    path: PathBuf,
    state: Mutex<State>,
    secrets: Arc<Mutex<Vec<String>>>,
}

impl RotatingLog {
    pub fn new(path: PathBuf, secrets: Arc<Mutex<Vec<String>>>) -> Arc<Self> {
        Arc::new(Self { path, state: Mutex::new(State { file: None, size: 0 }), secrets })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn open(&self, st: &mut State) {
        if st.file.is_some() {
            return;
        }
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let mut opts = OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        if let Ok(f) = opts.open(&self.path) {
            st.size = f.metadata().map(|m| m.len()).unwrap_or(0);
            st.file = Some(f);
        }
    }

    fn rotate(&self, st: &mut State) {
        st.file = None;
        for i in (1..KEEP).rev() {
            let _ = fs::rename(numbered(&self.path, i), numbered(&self.path, i + 1));
        }
        let _ = fs::rename(&self.path, numbered(&self.path, 1));
        st.size = 0;
    }

    /// Append one line (redacted, timestamped with a `[tag]`).
    pub fn line(&self, tag: &str, text: &str) {
        let clean = redact(text.trim_end_matches(['\r', '\n']), &self.secrets.lock().unwrap());
        let out = format!("{} [{tag}] {clean}\n", timestamp());
        let mut st = self.state.lock().unwrap();
        self.open(&mut st);
        if st.size + out.len() as u64 > MAX_BYTES {
            self.rotate(&mut st);
            self.open(&mut st);
        }
        if let Some(f) = st.file.as_mut() {
            if f.write_all(out.as_bytes()).is_ok() {
                st.size += out.len() as u64;
            }
        }
    }

    /// Copy a child's pipe into the log, line by line, on a thread.
    pub fn pump(self: &Arc<Self>, tag: &'static str, pipe: impl Read + Send + 'static) {
        let me = Arc::clone(self);
        let _ = std::thread::Builder::new().name(format!("log-{tag}")).spawn(move || {
            let mut r = BufReader::new(pipe);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => me.line(tag, &String::from_utf8_lossy(&buf)),
                }
            }
        });
    }
}

fn numbered(p: &Path, i: u32) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(format!(".{i}"));
    PathBuf::from(s)
}

fn timestamp() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format_utc(d.as_secs(), d.subsec_millis())
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a Unix time, without libc (same on every OS).
fn format_utc(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Days since 1970-01-01 to a proleptic Gregorian (year, month, day).
/// Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Mask known secrets and anything that looks like a token value.
pub fn redact(line: &str, secrets: &[String]) -> String {
    let mut s = line.to_string();
    for sec in secrets {
        if sec.len() >= 8 {
            s = s.replace(sec.as_str(), MASK);
        }
    }
    for key in ["token=", "bearer ", "x-api-key: "] {
        s = mask_after(&s, key);
    }
    s
}

/// Masks the value after each case-insensitive `key` (ASCII lowercase keys:
/// lowercasing keeps byte offsets, so indices into `lower` are valid in `s`).
fn mask_after(s: &str, key: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    while let Some(i) = lower[at..].find(key) {
        let start = at + i + key.len();
        out.push_str(&s[at..start]);
        let tail = &s[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '&' | ',' | ';' | '}' | ')'))
            .unwrap_or(tail.len());
        if end > 0 && !tail[..end].starts_with(MASK) {
            out.push_str(MASK);
        } else {
            out.push_str(&tail[..end]);
        }
        at = start + end;
    }
    out.push_str(&s[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::{format_utc, redact};

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc(951_782_400, 7), "2000-02-29T00:00:00.007Z");
        assert_eq!(format_utc(1_795_998_896, 123), "2026-11-30T00:34:56.123Z");
        assert_eq!(format_utc(4_102_444_799, 999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn masks_tokens() {
        let secrets = vec!["abcdef0123456789".to_string()];
        assert_eq!(redact("x abcdef0123456789 y", &secrets), "x [redacted] y");
        assert_eq!(redact("GET /#token=zzz&a=1", &[]), "GET /#token=[redacted]&a=1");
        assert_eq!(redact("Authorization: Bearer qqq", &[]), "Authorization: Bearer [redacted]");
        assert_eq!(redact("token= nothing", &[]), "token= nothing");
        assert_eq!(redact("\"token=[redacted]\"", &[]), "\"token=[redacted]\"");
        assert_eq!(redact("authorization: BEARER qqq", &[]), "authorization: BEARER [redacted]");
        assert_eq!(redact("GET /?Token=zzz", &[]), "GET /?Token=[redacted]");
        assert_eq!(redact("X-Api-Key: kkk", &[]), "X-Api-Key: [redacted]");
        assert_eq!(redact("é token=a é", &[]), "é token=[redacted] é");
    }
}
