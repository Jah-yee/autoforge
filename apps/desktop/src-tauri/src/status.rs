use serde::{Deserialize, Serialize};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

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

// ponytail: the timeout applies per read, so a server that trickles bytes can take longer.
fn get_runs(port: u16, token: &str, timeout: Duration) -> io::Result<(u16, Vec<u8>)> {
    let mut conn = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout)?;
    conn.set_read_timeout(Some(timeout))?;
    conn.set_write_timeout(Some(timeout))?;
    // HTTP/1.0: the reply is not chunked and ends when the server closes the connection.
    // No Origin header: the daemon refuses every request that has one.
    write!(
        conn,
        "GET /runs HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n"
    )?;
    let mut reply = Vec::new();
    (&conn).take(MAX_REPLY_BYTES + 1).read_to_end(&mut reply)?;
    if reply.len() as u64 > MAX_REPLY_BYTES {
        return Err(io::Error::other("reply too large"));
    }
    let malformed = || io::Error::other("malformed HTTP reply");
    let end = reply
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = std::str::from_utf8(&reply[..end]).map_err(|_| malformed())?;
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(malformed)?;
    Ok((status, reply[end + 4..].to_vec()))
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
