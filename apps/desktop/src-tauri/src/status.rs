use serde::{Deserialize, Serialize};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long one GET /runs may take.
pub const TIMEOUT: Duration = Duration::from_secs(3);

/// Upper bounds on untrusted input: the status file and the daemon's reply.
const MAX_STATUS_BYTES: u64 = 4096;
const MAX_REPLY_BYTES: u64 = 4 * 1024 * 1024;

/// One entry of the daemon's GET /runs. Unknown fields are dropped.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub issue_id: String,
    pub identifier: String,
    pub status: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub queued_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_url: Option<String>,
}

/// What the popover shows. Serialised as {"kind": "...", ...} for src/model.ts.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppState {
    DaemonNotRunning,
    Unreachable { reason: String },
    Unauthorized,
    Ok { runs: Vec<Run> },
}

/// The latest poll, plus when one last succeeded (epoch ms), for the tray and the popover.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: AppState,
    pub last_ok_at: Option<u64>,
}

impl Snapshot {
    /// Tray badge: the number of runs awaiting approval, hidden at 0. "!" when the daemon is gone,
    /// but only after it was reachable once since the app started (no warning on a fresh install).
    pub fn badge(&self) -> Option<String> {
        match &self.state {
            AppState::Ok { runs } => {
                let n = runs
                    .iter()
                    .filter(|r| r.status == "awaiting_approval")
                    .count();
                (n > 0).then(|| n.to_string())
            }
            _ => self.last_ok_at.map(|_| "!".into()),
        }
    }

    /// Tray tooltip, also the tray's accessible name, for example "autoforge: 2 awaiting approval".
    pub fn tooltip(&self) -> String {
        let summary = match &self.state {
            AppState::DaemonNotRunning => "serve isn't running".into(),
            AppState::Unreachable { .. } | AppState::Unauthorized => {
                "can't reach the daemon".into()
            }
            AppState::Ok { runs } => {
                let count = |statuses: &[&str]| {
                    runs.iter()
                        .filter(|r| statuses.contains(&r.status.as_str()))
                        .count()
                };
                let parts: Vec<String> = [
                    (count(&["awaiting_approval"]), "awaiting approval"),
                    (count(&["running", "publishing"]), "running"),
                    (count(&["queued"]), "queued"),
                ]
                .into_iter()
                .filter(|(n, _)| *n > 0)
                .map(|(n, label)| format!("{n} {label}"))
                .collect();
                if parts.is_empty() {
                    "nothing waiting".into()
                } else {
                    parts.join(", ")
                }
            }
        };
        format!("autoforge: {summary}")
    }
}

/// `<state dir>/status.json`, written by `autoforge serve` with mode 600.
#[derive(Deserialize)]
pub struct StatusInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// The status file of a live daemon, or None when it is missing, unreadable or stale.
pub fn read_status(path: &Path) -> Option<StatusInfo> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_STATUS_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_STATUS_BYTES {
        return None;
    }
    let info: StatusInfo = serde_json::from_slice(&bytes).ok()?;
    // The token goes into a header: anything but the daemon's hex would be a forged file.
    let token_ok = !info.token.is_empty() && info.token.bytes().all(|b| b.is_ascii_alphanumeric());
    (token_ok && pid_alive(info.pid)).then_some(info)
}

/// One poll. The status file is read every time, so a restarted daemon's new token is picked up.
pub fn poll(status_path: &Path) -> AppState {
    match read_status(status_path) {
        None => AppState::DaemonNotRunning,
        Some(info) => fetch_runs(info.port, &info.token, TIMEOUT),
    }
}

pub fn fetch_runs(port: u16, token: &str, timeout: Duration) -> AppState {
    match get_runs(port, token, timeout) {
        Err(e) => AppState::Unreachable { reason: reason(&e) },
        Ok((401, _)) => AppState::Unauthorized,
        Ok((200, body)) => match serde_json::from_slice(&body) {
            Ok(runs) => AppState::Ok { runs },
            Err(e) => AppState::Unreachable {
                reason: format!("bad response: {e}"),
            },
        },
        Ok((status, _)) => AppState::Unreachable {
            reason: format!("HTTP {status}"),
        },
    }
}

fn get_runs(port: u16, token: &str, timeout: Duration) -> io::Result<(u16, Vec<u8>)> {
    // The timeout bounds the whole request: the connect, each write and each read get what is
    // left of it.
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut conn = TcpStream::connect_timeout(&addr, remaining(deadline)?)?;
    conn.set_write_timeout(Some(remaining(deadline)?))?;
    // HTTP/1.0: the reply is not chunked and ends when the server closes the connection.
    // No Origin header: the daemon refuses every request that has one.
    write!(
        conn,
        "GET /runs HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n"
    )?;
    let mut reply = Vec::new();
    let mut chunk = [0u8; 8192];
    while (reply.len() as u64) <= MAX_REPLY_BYTES {
        conn.set_read_timeout(Some(remaining(deadline)?))?;
        match conn.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => reply.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    if reply.len() as u64 > MAX_REPLY_BYTES {
        return Err(io::Error::other("reply too large"));
    }
    let malformed = || io::Error::other("malformed HTTP reply");
    let end = reply
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = std::str::from_utf8(&reply[..end]).map_err(|_| malformed())?;
    // Only the first line counts: "HTTP/1.x <code>[ <reason>]".
    let status = head
        .lines()
        .next()
        .filter(|line| line.starts_with("HTTP/"))
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(malformed)?;
    Ok((status, reply[end + 4..].to_vec()))
}

/// Time left before `deadline`, or a timeout error (a zero socket timeout is itself an error).
fn remaining(deadline: Instant) -> io::Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(ErrorKind::TimedOut.into());
    }
    Ok(left)
}

fn reason(e: &io::Error) -> String {
    match e.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => "timed out".into(),
        ErrorKind::ConnectionRefused => "connection refused".into(),
        _ => e.to_string(),
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 only checks; EPERM means the process exists but belongs to another user.
    // pid 0 would address our own process group.
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(test)]
#[path = "status_tests.rs"]
mod tests;
