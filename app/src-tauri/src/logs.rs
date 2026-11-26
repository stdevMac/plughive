//! Size-rotated log files with secret redaction.
//!
//! The daemon's stdout/stderr are piped through here instead of being
//! attached to a file directly, so every line passes the redactor: the admin
//! token (once known) is replaced, and `token=...`, `"token": "..."`,
//! `x-api-key: ...`, `Bearer ...` and `Authorization: Basic ...` values are
//! masked whatever their source. A line longer than `MAX_LINE` is cut there,
//! so a child that never prints a newline cannot grow the app's memory.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: u32 = 3;
const MASK: &str = "[redacted]";
/// Longest line kept (bytes); the rest of a longer line is dropped.
const MAX_LINE: usize = 64 * 1024;
const CUT: &str = " [line cut]";

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
            // Never write through a symlink planted at the log path.
            opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let Ok(f) = opts.open(&self.path) else { return };
        let Ok(meta) = f.metadata() else { return };
        if !meta.is_file() {
            return;
        }
        // A log left by an older version may be group or world readable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if f.set_permissions(fs::Permissions::from_mode(0o600)).is_err() {
                return;
            }
        }
        st.size = meta.len();
        st.file = Some(f);
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
        let mut clean = redact(text.trim_end_matches(['\r', '\n']), &self.secrets.lock().unwrap());
        if clean.len() > MAX_LINE {
            let keep = cut(&clean, MAX_LINE).len();
            clean.truncate(keep);
            clean.push_str(CUT);
        }
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
                match read_line_capped(&mut r, &mut buf, MAX_LINE) {
                    Ok(None) | Err(_) => break,
                    Ok(Some(false)) => me.line(tag, &String::from_utf8_lossy(&buf)),
                    Ok(Some(true)) => {
                        let text = String::from_utf8_lossy(&buf);
                        me.line(tag, &format!("{}{CUT}", cut(&text, MAX_LINE)));
                    }
                }
            }
        });
    }
}

/// Reads one line into `buf` (cleared first), keeping at most `max` bytes and
/// skipping the rest of a longer line. `None` at end of input; otherwise
/// whether the line was longer than `max`.
fn read_line_capped(r: &mut impl BufRead, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut read_any = false;
    let mut longer = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(read_any.then_some(longer));
        }
        read_any = true;
        let (take, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        let room = max.saturating_sub(buf.len());
        if take - usize::from(done) > room {
            longer = true;
        }
        buf.extend_from_slice(&chunk[..take.min(room)]);
        r.consume(take);
        if done {
            return Ok(Some(longer));
        }
    }
}

/// `s` cut to at most `max` bytes, back to the last whitespace when there is
/// one near the end, so a secret split by the cut does not leave its first
/// half in the log (secrets hold no whitespace).
fn cut(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let head = &s[..end];
    let mut floor = end.saturating_sub(512);
    while !head.is_char_boundary(floor) {
        floor += 1;
    }
    match head[floor..].rfind(char::is_whitespace) {
        Some(i) => &head[..floor + i],
        None => &head[..floor],
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
    for key in ["token", "api-key", "api_key", "apikey", "access-key", "access_key"] {
        s = mask_after(&s, key, Sep::Assign);
    }
    s = mask_after(&s, "bearer", Sep::Space);
    mask_after(&s, "basic", Sep::BasicAuth)
}

/// What has to come between a key and its value.
#[derive(Clone, Copy)]
enum Sep {
    /// `key=v`, `key: v`, `key:v`, `"key": "v"` (no space after `=`, so
    /// prose like "token= nothing" stays).
    Assign,
    /// `Bearer v`, `Bearer  "v"`.
    Space,
    /// `Basic v`, only right after an `Authorization:` / `"authorization":`.
    BasicAuth,
}

/// Length of the separator after a key in `tail`, or None when `tail` does
/// not continue as a key/value pair.
fn separator(tail: &str, sep: Sep) -> Option<usize> {
    let b = tail.as_bytes();
    let mut i = 0;
    let blanks = |i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t') {
            *i += 1;
        }
    };
    match sep {
        Sep::Assign => {
            if i < b.len() && matches!(b[i], b'"' | b'\'') {
                i += 1;
            }
            blanks(&mut i);
            match b.get(i) {
                Some(b'=') => i += 1,
                Some(b':') => {
                    i += 1;
                    blanks(&mut i);
                }
                _ => return None,
            }
        }
        Sep::Space | Sep::BasicAuth => {
            blanks(&mut i);
            if i == 0 {
                return None;
            }
        }
    }
    if i < b.len() && matches!(b[i], b'"' | b'\'') {
        i += 1;
    }
    Some(i)
}

/// True when `before` ends with `authorization:` or `"authorization": "`.
fn after_authorization(before: &str) -> bool {
    let t = before.trim_end_matches([' ', '\t', '"', '\'']);
    let Some(t) = t.strip_suffix([':', '=']) else { return false };
    t.trim_end_matches([' ', '\t', '"', '\'']).to_ascii_lowercase().ends_with("authorization")
}

/// Masks the value after each case-insensitive `key` (ASCII lowercase keys:
/// lowercasing keeps byte offsets, so indices into `lower` are valid in `s`).
fn mask_after(s: &str, key: &str, sep: Sep) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    while let Some(i) = lower[at..].find(key) {
        let after_key = at + i + key.len();
        let gap = match sep {
            Sep::BasicAuth if !after_authorization(&s[..at + i]) => None,
            _ => separator(&s[after_key..], sep),
        };
        let Some(gap) = gap else {
            out.push_str(&s[at..after_key]);
            at = after_key;
            continue;
        };
        let start = after_key + gap;
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
    use super::{format_utc, read_line_capped, redact, RotatingLog, MAX_LINE};
    use std::io::{BufReader, Read};
    use std::sync::{Arc, Mutex};

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

    #[test]
    fn masks_quoted_json_spaced_and_basic_secrets() {
        let r = |s: &str| redact(s, &[]);
        assert_eq!(r("token=\"abc\""), "token=\"[redacted]\"");
        assert_eq!(r("{\"token\":\"abc\",\"a\":1}"), "{\"token\":\"[redacted]\",\"a\":1}");
        assert_eq!(r("{\"access_token\": \"abc\"}"), "{\"access_token\": \"[redacted]\"}");
        assert_eq!(r("Bearer  qqq"), "Bearer  [redacted]");
        assert_eq!(r("Bearer \"qqq\""), "Bearer \"[redacted]\"");
        assert_eq!(r("x-api-key:kkk"), "x-api-key:[redacted]");
        assert_eq!(r("{\"x-api-key\":\"kkk\"}"), "{\"x-api-key\":\"[redacted]\"}");
        assert_eq!(r("PLUGHIVE_ACCESS_KEY=kkk"), "PLUGHIVE_ACCESS_KEY=[redacted]");
        assert_eq!(r("Authorization: Basic dXNlcjpwYXNz"), "Authorization: Basic [redacted]");
        assert_eq!(r("{\"authorization\":\"Basic dXNlcjpwYXNz\"}"), "{\"authorization\":\"Basic [redacted]\"}");
        // Ordinary words stay.
        assert_eq!(r("a basic setup"), "a basic setup");
        assert_eq!(r("max_tokens: 100, token count 3"), "max_tokens: 100, token count 3");
        assert_eq!(r("admin token file missing"), "admin token file missing");
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("plughive-logs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A reader that yields `n` bytes of `x` and never a newline.
    struct Endless(usize);
    impl Read for Endless {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let k = out.len().min(self.0);
            out[..k].fill(b'x');
            self.0 -= k;
            Ok(k)
        }
    }

    #[test]
    fn a_line_without_newline_is_read_in_bounded_memory() {
        let mut r = BufReader::new(Endless(20 * 1024 * 1024));
        let mut buf = Vec::new();
        assert_eq!(read_line_capped(&mut r, &mut buf, MAX_LINE).unwrap(), Some(true));
        assert_eq!(buf.len(), MAX_LINE);
        assert_eq!(read_line_capped(&mut r, &mut buf, MAX_LINE).unwrap(), None);

        let mut r = BufReader::new(&b"one\ntwo"[..]);
        assert_eq!(read_line_capped(&mut r, &mut buf, 8).unwrap(), Some(false));
        assert_eq!(buf, b"one\n");
        assert_eq!(read_line_capped(&mut r, &mut buf, 8).unwrap(), Some(false));
        assert_eq!(buf, b"two");
        let mut r = BufReader::new(&b"12345678\nabc"[..]);
        assert_eq!(read_line_capped(&mut r, &mut buf, 8).unwrap(), Some(false));
        let mut r = BufReader::new(&b"123456789\nabc\n"[..]);
        assert_eq!(read_line_capped(&mut r, &mut buf, 8).unwrap(), Some(true));
        assert_eq!(buf, b"12345678");
        assert_eq!(read_line_capped(&mut r, &mut buf, 8).unwrap(), Some(false));
        assert_eq!(buf, b"abc\n");
    }

    #[test]
    fn a_huge_line_is_cut_in_the_file() {
        let dir = temp_dir("huge");
        let log = RotatingLog::new(dir.join("d.log"), Arc::new(Mutex::new(Vec::new())));
        log.line("t", &format!("{} secret-tail", "y ".repeat(4 * 1024 * 1024)));
        let len = std::fs::metadata(dir.join("d.log")).unwrap().len() as usize;
        assert!(len <= MAX_LINE + 100, "{len} bytes written");
        assert!(std::fs::read_to_string(dir.join("d.log")).unwrap().ends_with(" [line cut]\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pump_keeps_each_line_bounded() {
        let dir = temp_dir("pump");
        let log = RotatingLog::new(dir.join("d.log"), Arc::new(Mutex::new(Vec::new())));
        let mut input = vec![b'z'; 3 * 1024 * 1024];
        input.extend_from_slice(b"\nnext line\n");
        log.pump("t", std::io::Cursor::new(input));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let text = loop {
            let t = std::fs::read_to_string(dir.join("d.log")).unwrap_or_default();
            if t.contains("next line") || std::time::Instant::now() > deadline {
                break t;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{} bytes", text.len());
        assert!(lines[0].len() <= MAX_LINE + 100 && lines[0].ends_with(" [line cut]"));
        assert!(lines[1].ends_with("[t] next line"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_symlink_and_tightens_old_logs() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("link");
        let victim = dir.join("victim");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("d.log")).unwrap();
        let log = RotatingLog::new(dir.join("d.log"), Arc::new(Mutex::new(Vec::new())));
        log.line("t", "hello");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");

        let old = dir.join("old.log");
        std::fs::write(&old, "x\n").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        RotatingLog::new(old.clone(), Arc::new(Mutex::new(Vec::new()))).line("t", "hello");
        assert_eq!(std::fs::metadata(&old).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
