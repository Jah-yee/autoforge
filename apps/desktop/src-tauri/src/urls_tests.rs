use super::allowed;

#[test]
fn accepts_linear_and_github_https_links() {
    for url in [
        "https://linear.app/acme/issue/ENG-123/fix-login",
        "https://github.com/o/r/pull/7",
        "https://github.com/amanjr09-glitch/autoforge#readme",
    ] {
        assert_eq!(allowed(url).as_deref(), Some(url), "{url}");
    }
}

#[test]
fn rejects_other_schemes_hosts_and_look_alikes() {
    for url in [
        "http://github.com/o/r/pull/7",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://linear.app.evil.com/x",
        "https://evil.com/https://linear.app/",
        "https://github.com@evil.com/o/r",
        "https://user:pw@github.com/o/r",
        "https://github.com:8443/o/r",
        "https://gist.github.com/o/1",
        "https://GITHUB.COM.evil.com/",
        "data:text/html,x",
        "JAVASCRIPT:alert(1)",
        "https://github.com./o",
        "https://xn--gthub-n4a.com/",
        "not a url",
        "",
    ] {
        assert_eq!(allowed(url), None, "{url}");
    }
}

#[test]
fn normalises_host_case() {
    assert_eq!(
        allowed("https://GitHub.com/o/r").as_deref(),
        Some("https://github.com/o/r")
    );
}

#[test]
fn a_backslash_before_the_at_sign_stays_in_the_path() {
    // WHATWG parsing reads a backslash as "/" in https URLs, so "@evil.com" is a path.
    assert_eq!(
        allowed("https://github.com\\@evil.com").as_deref(),
        Some("https://github.com/@evil.com")
    );
}
