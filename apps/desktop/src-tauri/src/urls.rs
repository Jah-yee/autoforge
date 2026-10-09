use tauri::Url;

/// The URL to open if it is an https link to linear.app or github.com, otherwise None.
/// Links come from the daemon and so from Linear and GitHub data: treat them as untrusted.
pub fn allowed(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let host_ok = matches!(url.host_str(), Some("linear.app" | "github.com"));
    let plain = url.username().is_empty() && url.password().is_none() && url.port().is_none();
    (url.scheme() == "https" && host_ok && plain).then(|| url.to_string())
}

#[cfg(test)]
#[path = "urls_tests.rs"]
mod tests;
