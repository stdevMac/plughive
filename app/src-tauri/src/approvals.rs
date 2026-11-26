// Approvals waiting for the person: polled from the running daemon so the tray
// can show a count and a system notification for each new one.
//
// One small loopback request every few seconds (GET /api/approvals?status=
// pending with the admin token), HTTP/1.0 so the reply is never chunked.
// The notification names the tool, the reason and the estimate; it never
// carries the approval link, and deciding still happens on the dashboard.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::Deserialize;

use crate::i18n::{tr, trf};

/// How often the tray asks the daemon.
pub const POLL_EVERY: Duration = Duration::from_secs(5);
/// Most approvals one poll reads (the count comes from the reply's `pending`).
const LIMIT: u32 = 20;
/// More new approvals than this in one poll get one summary notification.
const MAX_NOTIFICATIONS: usize = 3;
/// Most ids remembered while more approvals wait than one poll reads.
const MAX_SEEN: usize = 1000;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Pending {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub estimate_usd: Option<f64>,
    #[serde(default)]
    pub profile: String,
}

#[derive(Debug, Deserialize)]
struct Reply {
    ok: bool,
    #[serde(default)]
    approvals: Vec<Pending>,
    #[serde(default)]
    pending: usize,
}

/// (count waiting, the newest ones) from a raw HTTP response, or None when
/// it is not a 200 with the expected JSON.
pub fn parse_response(raw: &str) -> Option<(usize, Vec<Pending>)> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return None;
    }
    let reply: Reply = serde_json::from_str(body.trim()).ok()?;
    if !reply.ok {
        return None;
    }
    let count = reply.pending.max(reply.approvals.len());
    Some((count, reply.approvals))
}

/// Ask the daemon on `port` which approvals are waiting.
pub fn fetch(port: u16, token: &str) -> Option<(usize, Vec<Pending>)> {
    if port == 0 || token.is_empty() || token.contains(['\r', '\n']) {
        return None;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /api/approvals?status=pending&limit={LIMIT} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\n\r\n"
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(512 * 1024).read_to_end(&mut buf);
    parse_response(&String::from_utf8_lossy(&buf))
}

/// Remembers which approvals were already announced.
#[derive(Default)]
pub struct Tracker {
    seen: HashSet<String>,
}

impl Tracker {
    /// The approvals in `list` not announced before. When `list` holds every
    /// pending one (`count`), ids no longer pending are forgotten, so the set
    /// stays as small as the pending list. When more wait than one poll reads,
    /// ids are kept, so one pushed out of the list and back is not announced
    /// twice.
    pub fn new_ones(&mut self, list: &[Pending], count: usize) -> Vec<Pending> {
        let fresh: Vec<Pending> = list.iter().filter(|p| !self.seen.contains(&p.id)).cloned().collect();
        if count <= list.len() || self.seen.len() + fresh.len() > MAX_SEEN {
            self.seen.clear();
        }
        self.seen.extend(list.iter().map(|p| p.id.clone()));
        fresh
    }
}

/// The notifications (title, body) for the approvals new in one poll: one
/// each, or a single summary when there are many.
pub fn notifications(fresh: &[Pending]) -> Vec<(String, String)> {
    if fresh.len() > MAX_NOTIFICATIONS {
        let body = trf("approvals.many", &[("count", &fresh.len().to_string())]) + &tr("approvals.notifyOpen");
        return vec![(tr("approvals.notifyTitle"), body)];
    }
    fresh.iter().map(notification_text).collect()
}

/// `s` as one plain line of at most `max` characters: control, bidi and
/// zero-width characters (which can reorder or hide text) are dropped and
/// runs of whitespace become one space.
fn plain(s: &str, max: usize) -> String {
    let hidden = |c: char| {
        c.is_control() || matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
    };
    let words: Vec<&str> = s.split(|c: char| c.is_whitespace() || hidden(c)).filter(|w| !w.is_empty()).collect();
    let line = words.join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let mut out: String = line.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// Notification title and body for one approval.
pub fn notification_text(p: &Pending) -> (String, String) {
    let tool = plain(&p.tool, 80);
    let reason = plain(&p.reason, 200);
    let reason = reason.trim_end_matches('.');
    let mut body = if reason.is_empty() {
        trf("approvals.waiting", &[("tool", &tool)])
    } else if reason.starts_with(tool.as_str()) {
        reason.to_string()
    } else {
        format!("{tool}: {reason}")
    };
    if let Some(usd) = p.estimate_usd {
        body.push_str(&trf("approvals.estimate", &[("usd", &format!("{usd:.2}"))]));
    }
    body.push_str(&tr("approvals.notifyOpen"));
    (tr("approvals.notifyTitle"), body)
}

/// The tray menu line for `count` approvals waiting.
pub fn menu_label(count: usize) -> String {
    match count {
        0 => tr("approvals.none"),
        1 => tr("approvals.one"),
        n => trf("approvals.other", &[("count", &n.to_string())]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}")
    }

    #[test]
    fn parses_the_pending_list_and_count() {
        let raw = reply(
            r#"{"ok":true,"pending":3,"approvals":[{"id":"a1","kind":"tool","tool":"send_email","provider":null,"reason":"Sends a message.","estimate_usd":null,"profile":"default","status":"pending","url":"x"},{"id":"a2","tool":"generate_video","reason":"Over the cap","estimate_usd":1.5,"profile":"work"}]}"#,
        );
        let (count, list) = parse_response(&raw).unwrap();
        assert_eq!(count, 3);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].tool, "send_email");
        assert_eq!(list[1].estimate_usd, Some(1.5));
    }

    #[test]
    fn refuses_errors_and_garbage() {
        assert!(parse_response("HTTP/1.1 401 Unauthorized\r\n\r\n{\"ok\":false}").is_none());
        assert!(parse_response(&reply("not json")).is_none());
        assert!(parse_response(&reply(r#"{"ok":false}"#)).is_none());
        assert!(parse_response("").is_none());
    }

    #[test]
    fn announces_each_approval_once() {
        let p = |id: &str| Pending { id: id.into(), tool: "t".into(), reason: String::new(), estimate_usd: None, profile: "default".into() };
        let mut t = Tracker::default();
        assert_eq!(t.new_ones(&[p("a"), p("b")], 2).len(), 2);
        assert!(t.new_ones(&[p("a"), p("b")], 2).is_empty());
        let fresh = t.new_ones(&[p("b"), p("c")], 2);
        assert_eq!(fresh, vec![p("c")]);
        // "a" was decided and dropped from the set; it does not come back as new.
        assert_eq!(t.seen.len(), 2);
    }

    #[test]
    fn an_approval_pushed_out_of_a_full_list_is_not_announced_again() {
        let p = |id: &str| Pending { id: id.into(), tool: "t".into(), reason: String::new(), estimate_usd: None, profile: "default".into() };
        let mut t = Tracker::default();
        // 3 waiting, the poll reads the newest 2.
        assert_eq!(t.new_ones(&[p("b"), p("a")], 2).len(), 2);
        assert_eq!(t.new_ones(&[p("c"), p("b")], 3), vec![p("c")]);
        // "c" is decided: "a" is back in the list, but was announced already.
        assert!(t.new_ones(&[p("b"), p("a")], 2).is_empty());
    }

    #[test]
    fn many_new_approvals_make_one_notification() {
        let p = |id: &str| Pending { id: id.into(), tool: "t".into(), reason: String::new(), estimate_usd: None, profile: "default".into() };
        assert_eq!(notifications(&[p("a"), p("b")]).len(), 2);
        let many: Vec<Pending> = (0..20).map(|i| p(&i.to_string())).collect();
        let n = notifications(&many);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].1, "20 new approvals are waiting. Open PlugHive to approve or deny.");
    }

    #[test]
    fn notification_text_is_one_plain_bounded_line() {
        let p = Pending {
            id: "a".into(),
            tool: "send\u{202E}liame\n\tx".into(),
            reason: format!("Safe\u{2066} call\r\nApproved by admin {}", "z".repeat(500)),
            estimate_usd: None,
            profile: "default".into(),
        };
        let (_, body) = notification_text(&p);
        assert!(body.starts_with("send liame x: Safe call Approved by admin zzz"), "{body}");
        assert!(!body.chars().any(|c| c.is_control() || ('\u{2066}'..='\u{2069}').contains(&c) || c == '\u{202E}'));
        assert!(body.chars().count() < 300, "{} chars", body.chars().count());
    }

    #[test]
    fn notification_and_menu_wording() {
        let p = Pending { id: "a".into(), tool: "generate_video".into(), reason: "Over the daily cap.".into(), estimate_usd: Some(0.4), profile: "default".into() };
        let (title, body) = notification_text(&p);
        assert_eq!(title, "PlugHive asks before a call runs");
        assert_eq!(body, "generate_video: Over the daily cap. Estimated $0.40. Open PlugHive to approve or deny.");
        let named = Pending { reason: "generate_video always needs approval.".into(), estimate_usd: None, ..p };
        assert_eq!(notification_text(&named).1, "generate_video always needs approval. Open PlugHive to approve or deny.");
        assert_eq!(menu_label(0), "No Approvals Waiting");
        assert_eq!(menu_label(1), "1 Approval Waiting…");
        assert_eq!(menu_label(4), "4 Approvals Waiting…");
    }

    #[test]
    fn refuses_a_token_that_would_split_the_request() {
        assert!(fetch(1, "abc\r\nX-Evil: 1").is_none());
        assert!(fetch(0, "abc").is_none());
    }

    /// Against a running daemon: PLUGHIVE_LIVE_PORT and PLUGHIVE_LIVE_TOKEN
    /// name a throwaway daemon with one approval waiting (`cargo test -- --ignored`).
    #[test]
    #[ignore]
    fn live_fetch_from_a_throwaway_daemon() {
        let port: u16 = std::env::var("PLUGHIVE_LIVE_PORT").unwrap().parse().unwrap();
        let token = std::env::var("PLUGHIVE_LIVE_TOKEN").unwrap();
        let (count, list) = fetch(port, &token).expect("the daemon answered");
        assert!(count >= 1, "an approval is waiting");
        assert!(!list[0].id.is_empty() && !list[0].tool.is_empty());
        println!("{count} waiting; first: {}", notification_text(&list[0]).1);
        assert!(fetch(port, "wrong-token").is_none());
    }
}
