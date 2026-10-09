use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SHORT: Duration = Duration::from_millis(300);

/// A one-shot HTTP server on 127.0.0.1. Returns its port and, once joined, the request it got.
fn serve_once(reply: &'static str) -> (u16, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 1024];
        while !request.ends_with(b"\r\n\r\n") {
            let n = conn.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        let _ = conn.write_all(reply.as_bytes());
        String::from_utf8(request).unwrap()
    });
    (port, handle)
}

const RUN: &str = r#"{"issueId":"i1","identifier":"ENG-1","status":"awaiting_approval","repo":"o/r","ref":"main","queuedAt":"2026-10-09T12:00:00.000Z","updatedAt":"2026-10-09T12:00:00.000Z","issueUrl":"https://linear.app/acme/issue/ENG-1","extra":1}"#;

fn ok_reply() -> &'static str {
    Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n[{RUN}]"
        )
        .into_boxed_str(),
    )
}

#[test]
fn maps_200_to_ok_and_sends_the_token_without_an_origin() {
    let (port, server) = serve_once(ok_reply());
    let state = fetch_runs(port, "abc123", SHORT);
    let request = server.join().unwrap();
    assert!(request.starts_with("GET /runs HTTP/1.0\r\n"), "{request}");
    assert!(
        request.contains("\r\nAuthorization: Bearer abc123\r\n"),
        "{request}"
    );
    assert!(
        !request.to_ascii_lowercase().contains("origin:"),
        "{request}"
    );
    let AppState::Ok { runs } = state else {
        panic!("expected Ok, got {state:?}")
    };
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].identifier, "ENG-1");
    assert_eq!(
        runs[0].issue_url.as_deref(),
        Some("https://linear.app/acme/issue/ENG-1")
    );
    assert_eq!(runs[0].pr_url, None);
}

#[test]
fn maps_401_to_unauthorized() {
    let (port, _server) = serve_once("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n{}");
    assert_eq!(fetch_runs(port, "t", SHORT), AppState::Unauthorized);
}

#[test]
fn maps_other_statuses_to_unreachable() {
    let (port, _server) = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n{}");
    assert_eq!(
        fetch_runs(port, "t", SHORT),
        AppState::Unreachable {
            reason: "HTTP 500".into()
        }
    );
}

#[test]
fn maps_bad_json_and_non_arrays_to_unreachable() {
    for body in ["not json", r#"{"error":"x"}"#, r#"[{"issueId":1}]"#] {
        let reply: &'static str =
            Box::leak(format!("HTTP/1.1 200 OK\r\n\r\n{body}").into_boxed_str());
        let (port, _server) = serve_once(reply);
        let state = fetch_runs(port, "t", SHORT);
        assert!(
            matches!(&state, AppState::Unreachable { reason } if reason.starts_with("bad response")),
            "{body}: {state:?}"
        );
    }
}

#[test]
fn maps_a_silent_server_to_a_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // Accepts (via the backlog) but never answers.
    assert_eq!(
        fetch_runs(port, "t", SHORT),
        AppState::Unreachable {
            reason: "timed out".into()
        }
    );
    drop(listener);
}

#[test]
fn maps_a_closed_port_to_connection_refused() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let AppState::Unreachable { reason } = fetch_runs(port, "t", SHORT) else {
        panic!("expected Unreachable")
    };
    // Windows retries a refused localhost connect for about 2 s, so there it may time out first.
    assert!(
        reason == "connection refused" || (cfg!(windows) && reason == "timed out"),
        "{reason}"
    );
}

fn status_file(text: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "autoforge-desktop-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("status.json");
    std::fs::write(&path, text).unwrap();
    path
}
static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// A pid that existed and has exited: a child we spawned and waited for.
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
        .args(if cfg!(windows) {
            &["/C", "exit"][..]
        } else {
            &[][..]
        })
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[test]
fn reads_a_valid_status_file_of_a_live_daemon() {
    let me = std::process::id();
    let path = status_file(&format!(r#"{{"port":4321,"token":"ab12","pid":{me}}}"#));
    let info = read_status(&path).expect("valid");
    assert_eq!(
        (info.port, info.token.as_str(), info.pid),
        (4321, "ab12", me)
    );
}

#[test]
fn treats_missing_malformed_dead_or_odd_status_files_as_not_running() {
    let me = std::process::id();
    let missing = std::env::temp_dir().join("autoforge-desktop-no-such-dir/status.json");
    assert!(read_status(&missing).is_none());
    for text in [
        "not json".to_string(),
        r#"{"port":4321}"#.to_string(),
        format!(r#"{{"port":4321,"token":"ab12","pid":{}}}"#, dead_pid()),
        format!(r#"{{"port":4321,"token":"ab\r\nOrigin: x","pid":{me}}}"#),
        format!(r#"{{"port":4321,"token":"","pid":{me}}}"#),
        r#"{"port":4321,"token":"ab12","pid":0}"#.to_string(),
    ] {
        assert!(read_status(&status_file(&text)).is_none(), "{text}");
    }
}

#[test]
fn treats_an_oversized_status_file_as_not_running() {
    let me = std::process::id();
    let padding = " ".repeat(5000);
    let text = format!(r#"{{"port":4321,"token":"ab12","pid":{me}{padding}}}"#);
    assert!(read_status(&status_file(&text)).is_none());
}

#[test]
fn maps_an_oversized_reply_to_unreachable() {
    let reply: &'static str = Box::leak(
        format!("HTTP/1.1 200 OK\r\n\r\n[{}]", " ".repeat(5 * 1024 * 1024)).into_boxed_str(),
    );
    let (port, _server) = serve_once(reply);
    assert_eq!(
        fetch_runs(port, "t", Duration::from_secs(5)),
        AppState::Unreachable {
            reason: "reply too large".into()
        }
    );
}

#[test]
fn poll_reports_not_running_without_a_status_file() {
    let missing = std::env::temp_dir().join("autoforge-desktop-no-such-dir/status.json");
    assert_eq!(poll(&missing), AppState::DaemonNotRunning);
}

#[test]
fn poll_reads_the_status_file_and_fetches_runs() {
    let (port, server) = serve_once(ok_reply());
    let path = status_file(&format!(
        r#"{{"port":{port},"token":"tok","pid":{}}}"#,
        std::process::id()
    ));
    assert!(matches!(poll(&path), AppState::Ok { .. }));
    assert!(server.join().unwrap().contains("Bearer tok"));
}

#[test]
fn poll_picks_up_a_new_token_after_the_daemon_restarts() {
    let me = std::process::id();
    let (old_port, _old) = serve_once("HTTP/1.1 401 Unauthorized\r\n\r\n{}");
    let path = status_file(&format!(
        r#"{{"port":{old_port},"token":"old","pid":{me}}}"#
    ));
    assert_eq!(poll(&path), AppState::Unauthorized);
    let (new_port, new) = serve_once(ok_reply());
    std::fs::write(
        &path,
        format!(r#"{{"port":{new_port},"token":"new","pid":{me}}}"#),
    )
    .unwrap();
    assert!(matches!(poll(&path), AppState::Ok { .. }));
    assert!(new.join().unwrap().contains("Bearer new"));
}

#[test]
fn serialises_for_the_webview_in_camel_case() {
    let (port, _server) = serve_once(ok_reply());
    let snap = Snapshot {
        state: fetch_runs(port, "t", SHORT),
        last_ok_at: Some(5),
    };
    let json = serde_json::to_value(&snap).unwrap();
    assert_eq!(json["lastOkAt"], 5);
    assert_eq!(json["state"]["kind"], "ok");
    let run = &json["state"]["runs"][0];
    assert_eq!(run["issueId"], "i1");
    assert_eq!(run["ref"], "main");
    assert_eq!(run["issueUrl"], "https://linear.app/acme/issue/ENG-1");
    assert!(run.get("prUrl").is_none());
    assert!(run.get("extra").is_none());
    assert_eq!(
        serde_json::to_value(AppState::DaemonNotRunning).unwrap(),
        serde_json::json!({ "kind": "daemonNotRunning" })
    );
}

#[test]
fn the_timeout_bounds_the_whole_request_not_each_read() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // Answers with one byte per second, forever (until the client hangs up).
    thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        while conn.write_all(b"x").is_ok() {
            thread::sleep(Duration::from_secs(1));
        }
    });
    let started = std::time::Instant::now();
    let state = fetch_runs(port, "t", Duration::from_secs(2));
    assert_eq!(
        state,
        AppState::Unreachable {
            reason: "timed out".into()
        }
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn the_connect_is_inside_the_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // A zero budget is spent before the connect starts, so even a listening port times out.
    assert_eq!(
        fetch_runs(port, "t", Duration::ZERO),
        AppState::Unreachable {
            reason: "timed out".into()
        }
    );
    drop(listener);
}

#[test]
fn accepts_a_status_line_without_a_reason_phrase() {
    let (port, _server) = serve_once("HTTP/1.1 200\r\n\r\n[]");
    assert_eq!(
        fetch_runs(port, "t", Duration::from_secs(5)),
        AppState::Ok { runs: vec![] }
    );
}

#[test]
fn reads_the_status_code_from_the_first_line_of_an_http_reply_only() {
    for reply in ["NOPE 200 OK\r\n\r\n[]", "HTTP/1.1\r\nX-A: 200 b\r\n\r\n[]"] {
        let (port, _server) = serve_once(reply);
        assert_eq!(
            fetch_runs(port, "t", Duration::from_secs(5)),
            AppState::Unreachable {
                reason: "malformed HTTP reply".into()
            },
            "{reply:?}"
        );
    }
}

fn run_with(status: &str) -> Run {
    Run {
        issue_id: format!("id-{status}"),
        identifier: "ENG-1".into(),
        status: status.into(),
        repo: "o/r".into(),
        git_ref: "main".into(),
        queued_at: "2026-10-09T12:00:00.000Z".into(),
        updated_at: "2026-10-09T12:00:00.000Z".into(),
        pr_url: None,
        issue_url: None,
    }
}

fn ok(statuses: &[&str]) -> Snapshot {
    Snapshot {
        state: AppState::Ok {
            runs: statuses.iter().map(|s| run_with(s)).collect(),
        },
        last_ok_at: Some(1),
    }
}

#[test]
fn badge_counts_runs_awaiting_approval_and_hides_at_zero() {
    let snap = ok(&[
        "awaiting_approval",
        "awaiting_approval",
        "running",
        "published",
    ]);
    assert_eq!(snap.badge().as_deref(), Some("2"));
    assert_eq!(ok(&["running", "queued"]).badge(), None);
    assert_eq!(ok(&[]).badge(), None);
}

#[test]
fn badge_warns_only_after_the_daemon_was_reachable_once() {
    for state in [
        AppState::DaemonNotRunning,
        AppState::Unauthorized,
        AppState::Unreachable {
            reason: "timed out".into(),
        },
    ] {
        let fresh = Snapshot {
            state: state.clone(),
            last_ok_at: None,
        };
        assert_eq!(fresh.badge(), None, "{state:?}");
        let lost = Snapshot {
            state: state.clone(),
            last_ok_at: Some(1),
        };
        assert_eq!(lost.badge().as_deref(), Some("!"), "{state:?}");
    }
}

#[test]
fn tooltip_summarises_the_state() {
    let busy = ok(&[
        "awaiting_approval",
        "awaiting_approval",
        "running",
        "publishing",
        "queued",
    ]);
    assert_eq!(
        busy.tooltip(),
        "autoforge: 2 awaiting approval, 2 running, 1 queued"
    );
    assert_eq!(ok(&["published"]).tooltip(), "autoforge: nothing waiting");
    let down = Snapshot {
        state: AppState::DaemonNotRunning,
        last_ok_at: None,
    };
    assert_eq!(down.tooltip(), "autoforge: serve isn't running");
    let lost = Snapshot {
        state: AppState::Unauthorized,
        last_ok_at: None,
    };
    assert_eq!(lost.tooltip(), "autoforge: can't reach the daemon");
}
