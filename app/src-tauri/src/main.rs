// PlugHive tray app for macOS, Windows and Linux.
//
// A menu-bar / system-tray app that supervises the bundled daemon: the node
// binary shipped next to the app's executable (Tauri externalBin: node, or
// node.exe on Windows) running <resources>/daemon/app/launcher.mjs. The
// dashboard is the daemon's own web UI in a regular window; it gets no Tauri
// IPC (no capabilities).
//
// Per OS: on macOS the app has no Dock icon until the dashboard is open
// (activation policy) and tray images are template images. On Windows and
// Linux the tray shows a coloured icon. Some Linux desktops (appindicator)
// never deliver tray click events, so everything lives in the tray menu.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approvals;
mod clients;
mod config;
mod i18n;
mod logs;
mod supervisor;

#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clients::{Bridge, CLIENT_IDS};
use config::{AppConfig, AppPaths, Geometry};
use logs::RotatingLog;
use supervisor::{Snapshot, Status, Supervisor};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_clipboard_manager::ClipboardExt as _;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt as _;

use i18n::{tr, trf};
use tauri_plugin_opener::OpenerExt as _;

const WINDOW: &str = "dashboard";
const DEFAULT_W: f64 = 1280.0;
const DEFAULT_H: f64 = 820.0;
const MIN_W: f64 = 900.0;
const MIN_H: f64 = 600.0;

// macOS: template images (black + alpha) that the menu bar tints.
#[cfg(target_os = "macos")]
mod tray_icons {
    pub const RUNNING: &[u8] = include_bytes!("../icons/tray.png");
    pub const STARTING: &[u8] = include_bytes!("../icons/tray-starting.png");
    pub const ATTENTION: &[u8] = include_bytes!("../icons/tray-attention.png");
    pub const TEMPLATE: bool = true;
}
// Windows and Linux: coloured icons that read on light and dark task bars.
#[cfg(not(target_os = "macos"))]
mod tray_icons {
    pub const RUNNING: &[u8] = include_bytes!("../icons/tray-color.png");
    pub const STARTING: &[u8] = include_bytes!("../icons/tray-color-starting.png");
    pub const ATTENTION: &[u8] = include_bytes!("../icons/tray-color-attention.png");
    pub const TEMPLATE: bool = false;
}
use tray_icons::{ATTENTION as ICON_ATTENTION, RUNNING as ICON_RUNNING, STARTING as ICON_STARTING};

struct Items {
    status: MenuItem<Wry>,
    open: MenuItem<Wry>,
    copy: MenuItem<Wry>,
    approvals: MenuItem<Wry>,
    clients: Vec<(&'static str, CheckMenuItem<Wry>)>,
    autostart: CheckMenuItem<Wry>,
    connect: Submenu<Wry>,
    troubleshoot: Submenu<Wry>,
    restart: MenuItem<Wry>,
    logs: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

impl Items {
    /// Put every fixed label in the current language (after a language change).
    fn relabel(&self) {
        let _ = self.open.set_text(tr("menu.open"));
        let _ = self.copy.set_text(tr("menu.copy"));
        let _ = self.connect.set_text(tr("menu.connect"));
        let _ = self.autostart.set_text(tr("menu.autostart"));
        let _ = self.troubleshoot.set_text(tr("menu.troubleshoot"));
        let _ = self.restart.set_text(tr("menu.restart"));
        let _ = self.logs.set_text(tr("menu.logs"));
        let _ = self.quit.set_text(tr("menu.quit"));
    }
}

struct Shared {
    paths: AppPaths,
    config: Mutex<AppConfig>,
    sup: Arc<Supervisor>,
    bridge: Bridge,
    app_log: Arc<RotatingLog>,
    daemon_log: Arc<RotatingLog>,
    items: Items,
    /// Origin the dashboard window may navigate within.
    origin: Arc<Mutex<Option<Url>>>,
    open_when_ready: Mutex<bool>,
    last_client_refresh: Mutex<Option<Instant>>,
    last_status: Mutex<Option<Status>>,
    /// Approvals waiting, as of the last poll (shown in the menu and tooltip).
    pending: Mutex<usize>,
}

impl Shared {
    fn save_config(&self) {
        let cfg = self.config.lock().unwrap().clone();
        if let Err(e) = cfg.save(&self.paths.config_file()) {
            self.app_log.line("app", &format!("could not save app-config.json: {e}"));
        }
    }
    fn log(&self, msg: &str) {
        self.app_log.line("app", msg);
    }
}

fn shared(app: &AppHandle) -> tauri::State<'_, Arc<Shared>> {
    app.state::<Arc<Shared>>()
}

fn status_line(s: &Snapshot) -> String {
    match &s.status {
        Status::Starting => tr("status.starting"),
        Status::Running => tr("status.running"),
        Status::Attention(why) => trf("status.attention", &[("why", why)]),
        Status::Stopped => tr("status.stopped"),
    }
}

// ---------------------------------------------------------------- helpers

fn dialog(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title(title).kind(kind).buttons(MessageDialogButtons::Ok).blocking_show();
}

fn confirm(app: &AppHandle, title: &str, text: &str, ok: &str, cancel: &str) -> bool {
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()))
        .blocking_show()
}

/// Run `f` on a worker thread (dialogs block, node calls take a moment).
fn background(app: &AppHandle, f: impl FnOnce(AppHandle) + Send + 'static) {
    let h = app.clone();
    let _ = std::thread::Builder::new().name("app-worker".into()).spawn(move || f(h));
}

/// Open http(s) and mailto links in the default browser or mail app.
fn open_external(app: &AppHandle, url: &Url) {
    if is_external_link(url) {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            shared(app).log(&format!("could not open {}: {e}", url.scheme()));
        }
    }
}

/// Only web and mail links leave the dashboard window; file:, javascript:,
/// custom schemes and the like are dropped.
fn is_external_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Show the app's Dock icon while the dashboard is open (macOS only; the
/// window has its own task-bar entry on Windows and Linux).
fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

// ---------------------------------------------------------------- dashboard

fn dashboard_url(app: &AppHandle) -> Option<(Url, Url)> {
    dashboard_url_at(app, "/")
}

/// The dashboard origin and the signed-in link to `path` (a dashboard route).
fn dashboard_url_at(app: &AppHandle, path: &str) -> Option<(Url, Url)> {
    let st = shared(app);
    let base = st.sup.base_url()?;
    let token = st.sup.token()?;
    let origin: Url = format!("{base}/").parse().ok()?;
    let full: Url = format!("{base}{path}#token={token}").parse().ok()?;
    Some((origin, full))
}

fn geometry_visible(app: &AppHandle, g: &Geometry) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        g.x + 80.0 > p.x && g.x < p.x + s.width - 80.0 && g.y >= p.y - 10.0 && g.y < p.y + s.height - 80.0
    })
}

fn open_dashboard(app: &AppHandle) {
    open_dashboard_at(app, "/");
}

fn open_dashboard_at(app: &AppHandle, path: &str) {
    let Some((origin, full)) = dashboard_url_at(app, path) else {
        // Not running yet: open as soon as the daemon is healthy.
        *shared(app).open_when_ready.lock().unwrap() = true;
        return;
    };
    let st = shared(app);
    *st.origin.lock().unwrap() = Some(origin);
    set_dock_visible(app, true);
    if let Some(w) = app.get_webview_window(WINDOW) {
        if path != "/" {
            let _ = w.navigate(full);
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let nav_origin = Arc::clone(&st.origin);
    let nav_app = app.clone();
    let popup_app = app.clone();
    let mut b = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(full))
        .title("PlugHive")
        .inner_size(DEFAULT_W, DEFAULT_H)
        .min_inner_size(MIN_W, MIN_H)
        .resizable(true)
        .on_navigation(move |u| {
            let allowed = nav_origin.lock().unwrap().as_ref().map(|o| o.origin() == u.origin()).unwrap_or(false);
            if allowed || u.as_str() == "about:blank" {
                return true;
            }
            open_external(&nav_app, u);
            false
        })
        .on_new_window(move |u, _features| {
            open_external(&popup_app, &u);
            NewWindowResponse::Deny
        });
    let saved = st.config.lock().unwrap().window;
    match saved {
        Some(g) if g.width >= MIN_W && g.height >= MIN_H && geometry_visible(app, &g) => {
            b = b.inner_size(g.width, g.height).position(g.x, g.y);
        }
        Some(g) if g.width >= MIN_W && g.height >= MIN_H => b = b.inner_size(g.width, g.height).center(),
        _ => b = b.center(),
    }
    match b.build() {
        Ok(w) => {
            let _ = w.set_focus();
            let h = app.clone();
            w.on_window_event(move |e| match e {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember_geometry(&h, false),
                WindowEvent::CloseRequested { .. } => remember_geometry(&h, true),
                WindowEvent::Destroyed => set_dock_visible(&h, false),
                _ => {}
            });
        }
        Err(e) => st.log(&format!("could not open the dashboard window: {e}")),
    }
}

fn remember_geometry(app: &AppHandle, persist: bool) {
    let Some(w) = app.get_webview_window(WINDOW) else { return };
    if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(scale) = w.scale_factor() else { return };
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let st = shared(app);
    st.config.lock().unwrap().window = Some(Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height });
    if persist {
        st.save_config();
    }
}

// ---------------------------------------------------------------- status

fn on_status(app: &AppHandle, snap: Snapshot) {
    let st = shared(app);
    let _ = st.items.status.set_text(status_line(&snap));
    let running = snap.status == Status::Running;
    let _ = st.items.open.set_enabled(running);
    let _ = st.items.copy.set_enabled(running);
    let icon = match snap.status {
        Status::Running => ICON_RUNNING,
        Status::Starting | Status::Stopped => ICON_STARTING,
        Status::Attention(_) => ICON_ATTENTION,
    };
    let prev = st.last_status.lock().unwrap().replace(snap.status.clone());
    let changed_kind = prev.map(|p| std::mem::discriminant(&p) != std::mem::discriminant(&snap.status)).unwrap_or(true);
    if changed_kind {
        st.log(&format!(
            "status: {} (daemon pid {}, restarts {})",
            status_line(&snap),
            snap.pid.map(|p| p.to_string()).unwrap_or_else(|| "-".into()),
            snap.restarts
        ));
        if let (Some(tray), Ok(img)) = (app.tray_by_id("main"), Image::from_bytes(icon)) {
            let _ = tray.set_icon(Some(img));
            let _ = tray.set_icon_as_template(tray_icons::TEMPLATE);
        }
        set_tooltip(app, &snap);
    }
    if !running {
        return;
    }
    // Healthy (again): re-point an open dashboard (new port, or a restarted
    // daemon that no longer knows the browser session), honour pending opens.
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let st = shared(&h);
        if let (Some(w), Some((origin, full))) = (h.get_webview_window(WINDOW), dashboard_url(&h)) {
            *st.origin.lock().unwrap() = Some(origin);
            let _ = w.navigate(full);
        }
        let first_run = !st.config.lock().unwrap().first_run_done;
        let pending = std::mem::take(&mut *st.open_when_ready.lock().unwrap());
        if first_run || pending {
            open_dashboard(&h);
            if first_run {
                st.config.lock().unwrap().first_run_done = true;
                st.save_config();
            }
        }
    });
    refresh_clients(app, true);
}

fn set_tooltip(app: &AppHandle, snap: &Snapshot) {
    let pending = *shared(app).pending.lock().unwrap();
    let mut text = trf("status.tooltip", &[("status", &status_line(snap))]);
    if snap.status == Status::Running && pending > 0 {
        text.push_str(&format!(" · {}", approvals::menu_label(pending).trim_end_matches('…')));
    }
    let _ = app.tray_by_id("main").map(|t| t.set_tooltip(Some(text)));
}

// ---------------------------------------------------------------- approvals

/// Poll the daemon for approvals waiting: keep the menu line and tooltip
/// current and show one system notification per new approval.
fn watch_approvals(app: &AppHandle) {
    let h = app.clone();
    let _ = std::thread::Builder::new().name("approvals".into()).spawn(move || {
        let mut tracker = approvals::Tracker::default();
        loop {
            std::thread::sleep(approvals::POLL_EVERY);
            let st = shared(&h);
            let snap = st.sup.snapshot();
            // The dashboard saves the language in preferences.json; follow it.
            if i18n::set_locale(i18n::resolve(&st.paths.daemon_root())) {
                st.log(&format!("language: {}", i18n::locale()));
                st.items.relabel();
                let _ = st.items.status.set_text(status_line(&snap));
                let _ = st.items.approvals.set_text(approvals::menu_label(*st.pending.lock().unwrap()));
                set_tooltip(&h, &snap);
                refresh_clients(&h, true);
            }
            let polled = match (snap.status == Status::Running, st.sup.token()) {
                (true, Some(token)) => approvals::fetch(snap.port, &token),
                _ => None,
            };
            let Some((count, list)) = polled else { continue };
            for p in tracker.new_ones(&list) {
                let (title, body) = approvals::notification_text(&p);
                if let Err(e) = h.notification().builder().title(title).body(body).show() {
                    st.log(&format!("could not show a notification: {e}"));
                }
            }
            let changed = {
                let mut prev = st.pending.lock().unwrap();
                std::mem::replace(&mut *prev, count) != count
            };
            if changed {
                let _ = st.items.approvals.set_text(approvals::menu_label(count));
                let _ = st.items.approvals.set_enabled(count > 0);
                set_tooltip(&h, &snap);
            }
        }
    });
}

fn on_port_change(app: &AppHandle, old: u16, new: u16) {
    let st = shared(app);
    st.config.lock().unwrap().port = new;
    st.save_config();
    if old == 0 {
        st.log(&format!("first start: daemon port {new}"));
        return;
    }
    st.log(&format!("port {old} is taken; daemon moved to {new}"));
    background(app, move |app| {
        let st = shared(&app);
        let from = format!("http://127.0.0.1:{old}/mcp");
        let to = format!("http://127.0.0.1:{new}/mcp");
        let affected: Vec<String> = st
            .bridge
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.connected && c.url.as_deref() == Some(from.as_str()))
            .map(|c| c.name)
            .collect();
        let msg = trf("port.moved", &[("old", &old.to_string()), ("new", &new.to_string())]);
        if affected.is_empty() {
            dialog(&app, &tr("port.title"), &format!("{msg}\n\n{}", tr("port.noClients")), MessageDialogKind::Info);
            return;
        }
        let ask = format!("{msg}\n\n{}", trf("port.ask", &[("clients", &affected.join(", ")), ("to", &to)]));
        if !confirm(&app, &tr("port.title"), &ask, &tr("port.update"), &tr("port.notNow")) {
            return;
        }
        let text = match st.bridge.retarget(&from, &to) {
            Ok(rs) => rs
                .iter()
                .map(|r| match &r.error {
                    Some(e) => trf("port.notUpdated", &[("name", &r.name), ("error", e)]),
                    None => format!(
                        "{}: {} {}\n{}",
                        r.name,
                        if r.changed { tr("port.updated") } else { tr("port.upToDate") },
                        r.path,
                        r.restart_hint.clone().unwrap_or_default()
                    ),
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
            Err(e) => trf("port.failed", &[("error", &e)]),
        };
        dialog(&app, &tr("port.doneTitle"), &text, MessageDialogKind::Info);
        refresh_clients(&app, true);
    });
}

// ---------------------------------------------------------------- clients

fn refresh_clients(app: &AppHandle, force: bool) {
    {
        let st = shared(app);
        let mut last = st.last_client_refresh.lock().unwrap();
        if !force && last.map(|t| t.elapsed() < Duration::from_secs(3)).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
    }
    background(app, |app| {
        let st = shared(&app);
        match st.bridge.list() {
            Ok(list) => {
                for (id, item) in &st.items.clients {
                    let Some(c) = list.iter().find(|c| c.id == *id) else { continue };
                    let label = if c.error.is_some() {
                        trf("menu.clientUnreadable", &[("name", &c.name)])
                    } else if !c.installed && !c.connected {
                        trf("menu.clientNotFound", &[("name", &c.name)])
                    } else {
                        c.name.clone()
                    };
                    let _ = item.set_text(label);
                    let _ = item.set_checked(c.connected);
                }
            }
            Err(e) => st.log(&format!("client list failed: {e}")),
        }
    });
}

fn client_clicked(app: &AppHandle, id: &'static str) {
    background(app, move |app| {
        let st = shared(&app);
        let info = st.bridge.list().ok().and_then(|l| l.into_iter().find(|c| c.id == id));
        let Some(info) = info else {
            dialog(&app, &tr("client.listTitle"), &tr("client.listFailed"), MessageDialogKind::Error);
            return;
        };
        let name = info.name.as_str();
        if let Some(e) = &info.error {
            dialog(
                &app,
                &trf("client.notChangedTitle", &[("name", name)]),
                &trf("client.notChanged", &[("path", &info.config_path), ("error", e)]),
                MessageDialogKind::Error,
            );
            refresh_clients(&app, true);
            return;
        }
        if info.connected {
            let ask = trf("client.disconnectAsk", &[("name", name), ("path", &info.config_path)]);
            let title = trf("client.disconnectTitle", &[("name", name)]);
            if confirm(&app, &title, &ask, &tr("client.disconnect"), &tr("client.cancel")) {
                match st.bridge.disconnect(id) {
                    Ok(r) => dialog(
                        &app,
                        &trf("client.disconnectedTitle", &[("name", name)]),
                        &format!(
                            "{}{}\n\n{}",
                            trf("client.removed", &[("path", &r.path)]),
                            r.backup_path.map(|b| format!("\n\n{}", trf("client.backup", &[("path", &b)]))).unwrap_or_default(),
                            r.restart_hint.unwrap_or_default()
                        ),
                        MessageDialogKind::Info,
                    ),
                    Err(e) => dialog(&app, &tr("client.disconnectFailed"), &e, MessageDialogKind::Error),
                }
            }
            refresh_clients(&app, true);
            return;
        }
        let Some(base) = st.sup.base_url() else {
            dialog(&app, &tr("client.notRunningTitle"), &tr("client.notRunning"), MessageDialogKind::Warning);
            refresh_clients(&app, true);
            return;
        };
        match st.bridge.connect(id, &format!("{base}/mcp")) {
            Ok(r) => {
                let key = if r.changed { "client.connected" } else { "client.alreadyConnected" };
                let mut text = trf(key, &[("name", name), ("path", &r.path)]);
                if let Some(b) = r.backup_path {
                    text.push_str(&format!("\n\n{}", trf("client.backup", &[("path", &b)])));
                }
                if let Some(n) = r.note {
                    text.push_str(&format!("\n\n{n}"));
                }
                if let Some(h) = r.restart_hint {
                    text.push_str(&format!("\n\n{h}"));
                }
                st.log(&format!("connected client {id} ({})", r.path));
                dialog(&app, &trf("client.connectedTitle", &[("name", name)]), &text, MessageDialogKind::Info);
            }
            Err(e) => dialog(&app, &trf("client.connectFailed", &[("name", name)]), &e, MessageDialogKind::Error),
        }
        refresh_clients(&app, true);
    });
}

// ---------------------------------------------------------------- menu

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "open" => open_dashboard(app),
        "approvals" => open_dashboard_at(app, "/approvals"),
        "copy" => {
            let st = shared(app);
            if let Some(base) = st.sup.base_url() {
                if let Err(e) = app.clipboard().write_text(format!("{base}/mcp")) {
                    st.log(&format!("copy failed: {e}"));
                }
            }
        }
        "restart" => shared(app).sup.request_restart(),
        "logs" => {
            let st = shared(app);
            let log = st.daemon_log.path().to_path_buf();
            let target: PathBuf = if log.exists() { log } else { st.paths.log_dir.clone() };
            let res = if target.is_file() {
                tauri_plugin_opener::reveal_item_in_dir(&target)
            } else {
                app.opener().open_path(target.to_string_lossy(), None::<&str>)
            };
            if let Err(e) = res {
                st.log(&format!("could not show the logs: {e}"));
            }
        }
        "autostart" => {
            let st = shared(app);
            let al = app.autolaunch();
            let now = al.is_enabled().unwrap_or(false);
            let res = if now { al.disable() } else { al.enable() };
            if let Err(e) = res {
                st.log(&format!("start at login: {e}"));
            }
            let _ = st.items.autostart.set_checked(al.is_enabled().unwrap_or(false));
        }
        "quit" => app.exit(0),
        other => {
            if let Some(cid) = other.strip_prefix("client:") {
                if let Some(id) = CLIENT_IDS.iter().find(|c| **c == cid) {
                    client_clicked(app, id);
                }
            }
        }
    }
}

/// The macOS menu bar while the dashboard is focused (Edit gives the web view
/// copy/paste shortcuts). Windows and Linux windows get no menu bar.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // Built before setup(), so this is where the language is first picked.
    pick_locale(app);
    let quit = MenuItem::with_id(app, "quit", tr("menu.quit"), true, Some("CmdOrCtrl+Q"))?;
    let app_sub = Submenu::with_items(
        app,
        "PlugHive",
        true,
        &[
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        tr("menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        tr("menu.window"),
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, Some(&tr("menu.closeWindow")))?],
    )?;
    Menu::with_items(app, &[&app_sub, &edit, &window])
}

/// Use the language saved from the dashboard, else the system's.
fn pick_locale(app: &AppHandle) {
    if let (Ok(data), Ok(logs)) = (app.path().app_data_dir(), app.path().app_log_dir()) {
        i18n::set_locale(i18n::resolve(&AppPaths::resolve(data, logs).daemon_root()));
    }
}

// ---------------------------------------------------------------- main

#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "dev.plughive.desktop";
/// Socket path used by tauri-plugin-single-instance 2.5.5 on macOS for this identifier.
#[cfg(target_os = "macos")]
const SINGLE_INSTANCE_SOCKET: &str = "/tmp/dev_plughive_desktop_si.sock";

/// The plugin's socket handshake races when two copies start within a few
/// milliseconds of each other (both see no socket and both carry on). An
/// exclusive flock on the data directory closes that gap: the loser asks the
/// winner to show its dashboard and exits before starting anything.
/// Creates `dir` and makes it owner-only (0700 on Unix), whatever the umask:
/// it holds the daemon's data, the admin token and logs with prompts in them.
fn private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// On Windows (named mutex) and Linux (D-Bus name) the plugin's own claim is
/// atomic, so this is macOS only.
#[cfg(target_os = "macos")]
fn claim_instance() -> Option<std::fs::File> {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"));
    let paths = AppPaths::resolve(home.join("Library/Application Support").join(BUNDLE_ID), PathBuf::new());
    std::fs::create_dir_all(&paths.data_dir).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.data_dir.join("app.lock"))
        .ok()?;
    match file.try_lock() {
        Ok(()) => Some(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            // The running copy may still be binding its socket; give it a few seconds.
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(mut s) = std::os::unix::net::UnixStream::connect(SINGLE_INSTANCE_SOCKET) {
                    let _ = s.write_all(b"\0\0");
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            std::process::exit(0);
        }
        Err(_) => None,
    }
}

fn main() {
    // Held for the life of the process; the kernel releases it on exit or crash.
    #[cfg(target_os = "macos")]
    let _instance_lock = claim_instance();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| open_dashboard(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    let app = builder
        .on_menu_event(on_menu)
        .setup(|app| {
            set_dock_visible(app.handle(), false);
            let handle = app.handle().clone();

            let paths = AppPaths::resolve(app.path().app_data_dir()?, app.path().app_log_dir()?);
            private_dir(&paths.data_dir)?;
            private_dir(&paths.log_dir)?;
            let secrets = Arc::new(Mutex::new(Vec::new()));
            let app_log = RotatingLog::new(paths.log_dir.join("app.log"), Arc::clone(&secrets));
            let daemon_log = RotatingLog::new(paths.log_dir.join("daemon.log"), Arc::clone(&secrets));
            let cfg = AppConfig::load(&paths.config_file());
            app_log.line(
                "app",
                &format!(
                    "PlugHive {} starting; data {}; logs {}{}",
                    app.package_info().version,
                    paths.data_dir.display(),
                    paths.log_dir.display(),
                    paths.test_home.as_ref().map(|t| format!("; test home {}", t.display())).unwrap_or_default()
                ),
            );

            let exe_dir: PathBuf = std::env::current_exe()?.parent().map(PathBuf::from).ok_or("no exe dir")?;
            let node = exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            let daemon_dir = app.path().resource_dir()?.join("daemon");

            let mut extra_env = Vec::new();
            if let Some(t) = &paths.test_home {
                // A test run behaves like a machine without Playwright browsers.
                extra_env.push(("PLAYWRIGHT_BROWSERS_PATH".to_string(), t.join("ms-playwright").to_string_lossy().into_owned()));
            }

            let h1 = handle.clone();
            let h2 = handle.clone();
            let sup = Supervisor::new(
                supervisor::Config {
                    node: node.clone(),
                    daemon_dir: daemon_dir.clone(),
                    daemon_root: paths.daemon_root(),
                    port: cfg.port,
                    extra_env,
                    daemon_log: Arc::clone(&daemon_log),
                    app_log: Arc::clone(&app_log),
                    secrets,
                },
                move |snap| on_status(&h1, snap),
                move |old, new| on_port_change(&h2, old, new),
            );

            i18n::set_locale(i18n::resolve(&paths.daemon_root()));
            app_log.line("app", &format!("language: {}", i18n::locale()));
            let status = MenuItem::with_id(app, "status", tr("status.starting"), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", tr("menu.open"), false, None::<&str>)?;
            let copy = MenuItem::with_id(app, "copy", tr("menu.copy"), false, None::<&str>)?;
            let approvals_item = MenuItem::with_id(app, "approvals", approvals::menu_label(0), false, None::<&str>)?;
            let names = ["Claude Desktop", "Claude Code", "Cursor", "Codex", "Hermes"];
            let mut client_items = Vec::new();
            for (id, name) in CLIENT_IDS.iter().zip(names) {
                client_items.push((*id, CheckMenuItem::with_id(app, format!("client:{id}"), name, true, false, None::<&str>)?));
            }
            let client_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
                client_items.iter().map(|(_, i)| i as &dyn tauri::menu::IsMenuItem<Wry>).collect();
            let connect = Submenu::with_items(app, tr("menu.connect"), true, &client_refs)?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(app, "autostart", tr("menu.autostart"), true, autostart_on, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", tr("menu.restart"), true, None::<&str>)?;
            let logs_item = MenuItem::with_id(app, "logs", tr("menu.logs"), true, None::<&str>)?;
            // Rarely needed: kept one level down so the top level stays status, open, copy, connect, login, quit.
            let troubleshoot = Submenu::with_items(app, tr("menu.troubleshoot"), true, &[&restart, &logs_item])?;
            let quit = MenuItem::with_id(app, "quit", tr("menu.quit"), true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &PredefinedMenuItem::separator(app)?,
                    &open,
                    &approvals_item,
                    &copy,
                    &connect,
                    &PredefinedMenuItem::separator(app)?,
                    &autostart,
                    &troubleshoot,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            let st = Arc::new(Shared {
                bridge: Bridge { node, daemon_dir, home: paths.clients_home.clone() },
                paths,
                config: Mutex::new(cfg),
                sup: Arc::clone(&sup),
                app_log,
                daemon_log,
                items: Items {
                    status,
                    open,
                    copy,
                    approvals: approvals_item,
                    clients: client_items,
                    autostart,
                    connect,
                    troubleshoot,
                    restart,
                    logs: logs_item,
                    quit,
                },
                origin: Arc::new(Mutex::new(None)),
                open_when_ready: Mutex::new(false),
                last_client_refresh: Mutex::new(None),
                last_status: Mutex::new(None),
                pending: Mutex::new(0),
            });
            app.manage(Arc::clone(&st));

            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(ICON_STARTING)?)
                .icon_as_template(tray_icons::TEMPLATE)
                .tooltip("PlugHive")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_tray_icon_event(|tray, event| {
                    // Hover on macOS and Windows, click where hover is not
                    // reported. Linux appindicator sends neither; the menu
                    // is refreshed on status changes there.
                    if matches!(event, TrayIconEvent::Enter { .. } | TrayIconEvent::Click { .. }) {
                        refresh_clients(tray.app_handle(), false);
                    }
                })
                .build(app)?;

            refresh_clients(&handle, true);
            sup.start();
            watch_approvals(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the PlugHive app");

    app.run(|app, event| match event {
        // Closing the dashboard window must not quit the menu-bar app.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(st) = app.try_state::<Arc<Shared>>() {
                remember_geometry(app, false);
                st.save_config();
                st.log("quitting");
                st.sup.shutdown();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail_links_leave_the_app() {
        for ok in ["https://example.com/x", "http://example.com", "mailto:a@example.com"] {
            assert!(is_external_link(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "ms-settings:privacy"] {
            assert!(!is_external_link(&Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
