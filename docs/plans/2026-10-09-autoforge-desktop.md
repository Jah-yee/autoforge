# autoforge desktop (slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 tray app in `apps/desktop` (macOS, Windows, Linux) that polls the user's own `autoforge serve` status endpoint every 5 seconds, shows the awaiting-approval count on the tray, and lists runs in a popover whose rows open the PR or Linear issue.

**Architecture:** Rust owns everything privileged: it reads `~/.autoforge/status.json`, checks the daemon pid, calls `GET /runs` over plain `std::net` HTTP/1.0 with the Bearer token, maps the result to an `AppState`, updates the tray and emits a `Snapshot` event. The webview is a small TypeScript app (pure `model.ts`, DOM `view.ts`, glue `main.ts`) that only listens to that event and calls six app commands; it has no network, file, shell or plugin permissions. The daemon gains `issueUrl` on `GET /runs` entries.

**Tech Stack:** Tauri 2.12.1 (Rust 1.99.0), plugins single-instance 2.5.2, autostart 2.7.0, opener 2.7.0; serde; Vite 8.3.4, TypeScript 5.9.3, Vitest 5.0.3 + jsdom 30.1.2, `@tauri-apps/api` 2.12.1.

**Spec:** `docs/specs/2026-10-09-autoforge-desktop-design.md` (binding). Product context: `PRODUCT.md`.

## Global Constraints

- Rust is not on PATH on the dev machine: prefix every cargo/rustup/tauri command with `PATH=/opt/homebrew/opt/rustup/bin:$PATH` (shown in each step). The toolchain is pinned to `1.99.0` by `apps/desktop/src-tauri/rust-toolchain.toml`.
- Node 22, pnpm 12.10.1 (`packageManager`). The desktop app is a standalone pnpm project with its own `apps/desktop/pnpm-lock.yaml`; there is no pnpm workspace.
- The npm package keeps zero runtime dependencies and `"files": ["dist"]`. Nothing under `apps/` ships in it. Root `tsconfig.json` already includes only `src`, `test`, `examples`; root ESLint, Prettier and Vitest are told about `apps/desktop` explicitly (Tasks 2 and 5).
- Exact versions, no ranges: Cargo `=` pins and npm exact versions as written. Do not upgrade while executing.
- Visual design is out of scope. The popover is unstyled semantic HTML (headings, lists, buttons, label, aria) with browser defaults only. No CSS file, no colours, fonts or spacing. Every visual change goes through `/impeccable` with the user's per-component approval (Task 9, not implemented here).
- The token is read and used only in Rust and never crosses into the webview. The webview capability grants only `core:event:allow-listen`, `core:event:allow-unlisten` and the six app commands. CSP: bundled assets only, `connect-src` limited to Tauri IPC.
- Links open only through the Rust `open_url` command, only when `urls::allowed` accepts them: `https`, host exactly `linear.app` or `github.com`, no userinfo, no port.
- Requests to the daemon carry `Authorization: Bearer <token>` and never an `Origin` header. v1 never calls `POST` routes.
- Tests never call real Linear or GitHub. Rust tests use a one-shot `std::net::TcpListener` server on 127.0.0.1.
- UI copy, comments and docs: no em dashes. Plain, technical voice. Product name is lowercase `autoforge`.
- Gates before every commit that touches them: root `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`; desktop `pnpm --dir apps/desktop typecheck`, `pnpm --dir apps/desktop test`; Rust `cargo fmt --check`, `cargo test`, and from Task 7 on `cargo clippy --all-targets -- -D warnings` (before Task 7 `main()` does not use the modules yet, so dead-code warnings are expected and clippy is not run).
- Commits: conventional prefix, then a blank line and `Co-Authored-By: <the model that wrote the commit> <noreply@anthropic.com>`, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The `-m` pairs below produce that blank line. Replace the model name with your own.

## Review Focus

1. A daemon from before this slice sends no `issueUrl` (and old state entries lack it until the next poll): rows must still render, stay keyboard reachable and do nothing on click rather than crash. Pinned in Task 6 ("keeps a row without any link focusable but inert") and Task 3 (missing optional fields deserialize).
2. The daemon restarts with a new token and port: one poll may say Unauthorized, the next must recover by re-reading `status.json`. Pinned in Task 3 (`poll_picks_up_a_new_token_after_the_daemon_restarts`).
3. The daemon crashed and left a stale `status.json`: the user should see "isn't running" with the start commands, not a vague network error. Pinned in Task 3 (dead pid, pid 0, malformed and forged-token files).
4. The 5 second refresh must not steal keyboard focus or make a screen reader re-announce the list. Pinned in Task 6 ("does not rebuild the list when only the poll time changes" and "puts focus back on the same run").
5. Issue identifiers and repo names are untrusted text, and URLs from the daemon are untrusted: markup must render as text, look-alike hosts must not open. Pinned in Task 6 ("renders issue text as text") and Task 2 (allowlist look-alikes).

---

### Task 1: Daemon: `issueUrl` on `GET /runs`

**Files:**

- Modify: `src/serve/linear.ts` (LinearIssue, RawIssue, ISSUE_FIELDS, toIssue)
- Modify: `src/serve/state.ts` (IssueEntry)
- Modify: `src/serve/daemon.ts` (RunSummary, runs(), handleIssue(), pickUp())
- Test: `test/serve/linear.test.ts`, `test/serve/status.test.ts`, `test/serve/fake-linear.ts`, `test/serve/prompt.test.ts`, `test/serve/route.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `LinearIssue.url: string`; `IssueEntry.issueUrl?: string`; `RunSummary.issueUrl?: string`, emitted on `GET /runs` entries when known. Task 3's Rust `Run` reads it as `issueUrl` (optional).

- [ ] **Step 1: Write the failing tests**

In `test/serve/linear.test.ts`, replace:

<!-- prettier-ignore -->
```ts
  identifier: "ENG-1",
  title: "T",
  description: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  assignee: { id: "u1" },
```

with:

<!-- prettier-ignore -->
```ts
  identifier: "ENG-1",
  title: "T",
  description: null,
  url: "https://linear.app/acme/issue/ENG-1/t",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assignee: { id: "u1" },
```

In `test/serve/linear.test.ts`, replace:

<!-- prettier-ignore -->
```ts
      identifier: "ENG-1",
      title: "T",
      description: null,
      updatedAt: "2026-10-09T12:00:00.000Z",
      assigneeId: "u1",
```

with:

<!-- prettier-ignore -->
```ts
      identifier: "ENG-1",
      title: "T",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1/t",
      updatedAt: "2026-10-09T12:00:00.000Z",
      assigneeId: "u1",
```

In `test/serve/linear.test.ts`, replace:

<!-- prettier-ignore -->
```ts
    expect(calls[1]?.variables.after).toBe("cursor-1");
```

with:

<!-- prettier-ignore -->
```ts
    expect(calls[1]?.variables.after).toBe("cursor-1");
    expect(calls[0]?.query).toMatch(/\burl\b/);
```

In `test/serve/fake-linear.ts`, replace:

<!-- prettier-ignore -->
```ts
  addIssue(fields: Partial<LinearIssue> & { id: string }): LinearIssue {
    const issue: LinearIssue = {
      identifier: `ENG-${this.issues.size + 1}`,
      title: "Fix the greeting",
      description: "Make it friendlier.",
```

with:

<!-- prettier-ignore -->
```ts
  addIssue(fields: Partial<LinearIssue> & { id: string }): LinearIssue {
    const identifier = fields.identifier ?? `ENG-${this.issues.size + 1}`;
    const issue: LinearIssue = {
      identifier,
      title: "Fix the greeting",
      description: "Make it friendlier.",
      url: `https://linear.app/acme/issue/${identifier}`,
```

In `test/serve/prompt.test.ts`, replace:

<!-- prettier-ignore -->
```ts
  description: "The redirect loops.",
```

with:

<!-- prettier-ignore -->
```ts
  description: "The redirect loops.",
  url: "https://linear.app/acme/issue/ENG-1/fix-login",
```

In `test/serve/route.test.ts`, replace:

<!-- prettier-ignore -->
```ts
  title: "T",
  description: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
```

with:

<!-- prettier-ignore -->
```ts
  title: "T",
  description: null,
  url: "https://linear.app/acme/issue/OPS-1/t",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
```

In `test/serve/status.test.ts`, replace:

<!-- prettier-ignore -->
```ts
        queuedAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
      },
    ]);
```

with:

<!-- prettier-ignore -->
```ts
        queuedAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    ]);
```

In `test/serve/status.test.ts`, replace:

<!-- prettier-ignore -->
```ts
  it("publishes like /publish, then refuses a discard in the wrong state", async () => {
```

with:

<!-- prettier-ignore -->
```ts
  it("keeps issueUrl current when the issue moves and its Linear URL changes", async () => {
    const h = await running();
    h.clock.advance(1000);
    h.linear.update("issue-1", { url: "https://linear.app/acme/issue/OPS-7" });
    await step(h.d);
    const runs = JSON.parse((await call(h.port, "/runs", { headers: h.auth })).body) as {
      issueUrl?: string;
    }[];
    expect(runs[0]?.issueUrl).toBe("https://linear.app/acme/issue/OPS-7");
  });

  it("publishes like /publish, then refuses a discard in the wrong state", async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/serve`
Expected: 3 failures: `pages through changed issues and maps them, comments oldest first` (no `url` in the mapped issue), `lists runs without patches or logs, and serves a patch` and `keeps issueUrl current when the issue moves and its Linear URL changes` (no `issueUrl`). `pnpm typecheck` also fails until Step 3 (`url` not on `LinearIssue`).

- [ ] **Step 3: Implement**

In `src/serve/linear.ts`, replace:

<!-- prettier-ignore -->
```ts
  title: string;
  description: string | null;
  updatedAt: string;
  assigneeId: string | null;
```

with:

<!-- prettier-ignore -->
```ts
  title: string;
  description: string | null;
  /** The issue's page in Linear, for example https://linear.app/acme/issue/ENG-123/title. */
  url: string;
  updatedAt: string;
  assigneeId: string | null;
```

In `src/serve/linear.ts`, replace:

<!-- prettier-ignore -->
```ts
  description: string | null;
  updatedAt: string;
  assignee: { id: string } | null;
```

with:

<!-- prettier-ignore -->
```ts
  description: string | null;
  url: string;
  updatedAt: string;
  assignee: { id: string } | null;
```

In `src/serve/linear.ts`, replace:

<!-- prettier-ignore -->
```ts
const ISSUE_FIELDS = `id identifier title description updatedAt
```

with:

<!-- prettier-ignore -->
```ts
const ISSUE_FIELDS = `id identifier title description url updatedAt
```

In `src/serve/linear.ts`, replace:

<!-- prettier-ignore -->
```ts
  description: r.description,
  updatedAt: r.updatedAt,
```

with:

<!-- prettier-ignore -->
```ts
  description: r.description,
  url: r.url,
  updatedAt: r.updatedAt,
```

In `src/serve/state.ts`, replace:

<!-- prettier-ignore -->
```ts
  /** For example "ENG-123". */
  identifier: string;
```

with:

<!-- prettier-ignore -->
```ts
  /** For example "ENG-123". */
  identifier: string;
  /** Linear page of the issue. Missing on entries written before slice 3 until the next poll. */
  issueUrl?: string;
```

In `src/serve/daemon.ts`, replace:

<!-- prettier-ignore -->
```ts
  updatedAt: string;
  prUrl?: string;
};

const VALID_WHEN
```

with:

<!-- prettier-ignore -->
```ts
  updatedAt: string;
  prUrl?: string;
  issueUrl?: string;
};

const VALID_WHEN
```

In `src/serve/daemon.ts`, replace:

<!-- prettier-ignore -->
```ts
      ...(e.prUrl ? { prUrl: e.prUrl } : {}),
    }));
```

with:

<!-- prettier-ignore -->
```ts
      ...(e.prUrl ? { prUrl: e.prUrl } : {}),
      ...(e.issueUrl ? { issueUrl: e.issueUrl } : {}),
    }));
```

In `src/serve/daemon.ts`, replace:

<!-- prettier-ignore -->
```ts
    const open = issue.stateType !== "completed" && issue.stateType !== "canceled";
    if (entry && picked && open)
```

with:

<!-- prettier-ignore -->
```ts
    const open = issue.stateType !== "completed" && issue.stateType !== "canceled";
    // Moving an issue to another team changes its URL; this also fills in pre-slice-3 entries.
    if (entry) entry.issueUrl = issue.url;
    if (entry && picked && open)
```

In `src/serve/daemon.ts`, replace:

<!-- prettier-ignore -->
```ts
    this.state.issues[issue.id] = {
      identifier: issue.identifier,
      status: "queued",
```

with:

<!-- prettier-ignore -->
```ts
    this.state.issues[issue.id] = {
      identifier: issue.identifier,
      issueUrl: issue.url,
      status: "queued",
```

- [ ] **Step 4: Run the gates**

Run: `pnpm vitest run test/serve && pnpm typecheck && pnpm lint && pnpm format && pnpm build`
Expected: all serve tests pass, no type, lint or format errors.

- [ ] **Step 5: Commit**

```bash
git add src/serve test/serve
git commit -m "feat(serve): issueUrl on GET /runs entries for the desktop app" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Desktop crate scaffold and the URL allowlist

**Files:**

- Create: `apps/desktop/package.json`, `apps/desktop/app-icon.png` (generated), `apps/desktop/src-tauri/icons/*` (generated)
- Create: `apps/desktop/src-tauri/Cargo.toml`, `rust-toolchain.toml`, `build.rs`, `.gitignore`, `tauri.conf.json`
- Create: `apps/desktop/src-tauri/src/main.rs` (stub until Task 7), `src/urls.rs`
- Test: `apps/desktop/src-tauri/src/urls_tests.rs`
- Modify: `.prettierignore`, `eslint.config.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `urls::allowed(raw: &str) -> Option<String>`: the normalised URL when it is an allowed link, otherwise `None`. Task 7's `open_url` command calls it.

- [ ] **Step 1: Create the desktop package and install it**

Create `apps/desktop/package.json`:

```json
{
  "name": "autoforge-desktop",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "2.12.1"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.12.1",
    "jsdom": "30.1.2",
    "typescript": "5.9.3",
    "vite": "8.3.4",
    "vitest": "5.0.3"
  },
  "packageManager": "pnpm@12.10.1"
}
```

Run: `pnpm --dir apps/desktop install`
Expected: creates `apps/desktop/pnpm-lock.yaml` and `apps/desktop/node_modules`; the root lockfile is unchanged (`git status` shows no change to `pnpm-lock.yaml`).

- [ ] **Step 2: Generate a placeholder icon set**

The tray and the bundle need icons. This is a placeholder (a black disc; macOS draws it as a template icon); `/impeccable` replaces it later.

Run from `apps/desktop`:

```bash
node --input-type=module <<'EOF'
// Placeholder: a black disc on transparent, 1024 px. /impeccable replaces it later.
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
const n = 1024;
const raw = Buffer.alloc((n * 4 + 1) * n);
for (let y = 0; y < n; y++)
  for (let x = 0; x < n; x++)
    if ((x - n / 2) ** 2 + (y - n / 2) ** 2 < (n * 0.4) ** 2)
      raw[y * (n * 4 + 1) + 1 + x * 4 + 3] = 255;
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(n, 0);
ihdr.writeUInt32BE(n, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
writeFileSync(
  "app-icon.png",
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
EOF
pnpm tauri icon app-icon.png -o src-tauri/icons
rm -rf src-tauri/icons/android src-tauri/icons/ios
```

Expected: `src-tauri/icons` contains `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png` and the `Square*Logo.png` / `StoreLogo.png` set.

- [ ] **Step 3: Create the Rust crate**

Create `apps/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "autoforge-desktop"
version = "0.0.0"
description = "Tray app for the autoforge serve daemon"
license = "MIT"
edition = "2021"
rust-version = "1.90"

[build-dependencies]
tauri-build = { version = "=2.7.1", features = [] }

[dependencies]
tauri = { version = "=2.12.1", features = ["tray-icon"] }
tauri-plugin-autostart = "=2.7.0"
tauri-plugin-opener = "=2.7.0"
tauri-plugin-single-instance = "=2.5.2"
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"

[target.'cfg(unix)'.dependencies]
libc = "=0.2.190"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_System_Threading"] }
```

Create `apps/desktop/src-tauri/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.99.0"
components = ["clippy", "rustfmt"]
```

Create `apps/desktop/src-tauri/build.rs` (Task 7 replaces it to list the app's commands):

```rust
fn main() {
    tauri_build::build()
}
```

Create `apps/desktop/src-tauri/.gitignore`:

```
/target/
/gen/schemas
/permissions/autogenerated
```

Create `apps/desktop/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "autoforge",
  "version": "0.0.0",
  "identifier": "dev.autoforge.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "popover",
        "title": "autoforge",
        "width": 360,
        "height": 480,
        "visible": false,
        "decorations": false,
        "resizable": false,
        "skipTaskbar": true,
        "alwaysOnTop": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ipc: http://ipc.localhost",
      "devCsp": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ipc: http://ipc.localhost ws://localhost:1420"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

Create `apps/desktop/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod urls;

fn main() {}
```

In `.prettierignore`, replace:

```
.superpowers/
```

with:

```
.superpowers/
apps/desktop/src-tauri/target
apps/desktop/src-tauri/gen
```

In `eslint.config.js`, replace:

<!-- prettier-ignore -->
```js
  { ignores: ["dist", "node_modules"] },
```

with:

<!-- prettier-ignore -->
```js
  { ignores: ["dist", "node_modules", "apps/desktop/dist", "apps/desktop/src-tauri"] },
```

(`target/` holds generated JavaScript that ESLint would otherwise lint.)

- [ ] **Step 4: Write the failing allowlist tests**

Create `apps/desktop/src-tauri/src/urls_tests.rs`:

```rust
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
```

Create `apps/desktop/src-tauri/src/urls.rs` with only the test module for now:

```rust
#[cfg(test)]
#[path = "urls_tests.rs"]
mod tests;
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`
Expected: the first run downloads the 1.99.0 toolchain if missing and compiles Tauri (about 3 minutes), then fails with ``error[E0432]: unresolved import `super::allowed` ``.

- [ ] **Step 6: Implement the allowlist**

Replace the whole of `apps/desktop/src-tauri/src/urls.rs` with:

```rust
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
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --check`
Expected: `test result: ok. 3 passed` (a dead-code warning for `allowed` is expected until Task 7). Then from the repo root: `pnpm lint && pnpm format` pass.

- [ ] **Step 8: Commit**

```bash
git add .prettierignore eslint.config.js apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/app-icon.png apps/desktop/src-tauri
git commit -m "feat(desktop): Tauri crate scaffold and the link allowlist" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Check `git status` afterwards: `target/` and `gen/schemas` must not be staged.

---

### Task 3: Status file, `GET /runs` poll and `AppState`

**Files:**

- Create: `apps/desktop/src-tauri/src/status.rs`
- Test: `apps/desktop/src-tauri/src/status_tests.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs` (declare the module)

**Interfaces:**

- Consumes: the daemon's `status.json` `{port, token, pid}` and `GET /runs` (Task 1 adds `issueUrl`).
- Produces (all `pub` in `status`):
  - `struct Run { issue_id, identifier, status: String, repo, git_ref (JSON "ref"), queued_at, updated_at, pr_url: Option<String>, issue_url: Option<String> }`, serde camelCase.
  - `enum AppState { DaemonNotRunning, Unreachable { reason: String }, Unauthorized, Ok { runs: Vec<Run> } }`, serialised as `{"kind": "daemonNotRunning" | "unreachable" | "unauthorized" | "ok", ...}`.
  - `struct Snapshot { state: AppState, last_ok_at: Option<u64> }`, serialised as `{state, lastOkAt}`.
  - `fn read_status(path: &Path) -> Option<StatusInfo>`, `fn poll(status_path: &Path) -> AppState`, `fn fetch_runs(port: u16, token: &str, timeout: Duration) -> AppState`, `const TIMEOUT: Duration` (3 s).
  - Task 5's `model.ts` mirrors `AppState`, `Run` and `Snapshot`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src-tauri/src/status_tests.rs`:

```rust
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
            let n = conn.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        conn.write_all(reply.as_bytes()).unwrap();
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
```

Create `apps/desktop/src-tauri/src/status.rs` with only the test module for now:

```rust
#[cfg(test)]
#[path = "status_tests.rs"]
mod tests;
```

In `apps/desktop/src-tauri/src/main.rs`, replace:

<!-- prettier-ignore -->
```rust
mod urls;
```

with:

<!-- prettier-ignore -->
```rust
mod status;
mod urls;
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`
Expected: compile errors such as ``cannot find function `fetch_runs` in this scope`` and ``cannot find type `AppState` in this scope``.

- [ ] **Step 3: Implement**

Replace the whole of `apps/desktop/src-tauri/src/status.rs` with:

```rust
use serde::{Deserialize, Serialize};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

/// How long one GET /runs may take.
pub const TIMEOUT: Duration = Duration::from_secs(3);

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
    let info: StatusInfo = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
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
    conn.read_to_end(&mut reply)?;
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
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --check`
Expected: `test result: ok. 15 passed` (12 status, 3 urls). Dead-code warnings are expected until Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat(desktop): read status.json and poll GET /runs into an AppState" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Tray badge and tooltip

**Files:**

- Modify: `apps/desktop/src-tauri/src/status.rs` (add `impl Snapshot`)
- Test: `apps/desktop/src-tauri/src/status_tests.rs` (append)

**Interfaces:**

- Consumes: `Snapshot`, `AppState`, `Run` from Task 3.
- Produces: `Snapshot::badge(&self) -> Option<String>` (awaiting count, hidden at 0; `"!"` when the daemon is lost after having been reachable since the app started) and `Snapshot::tooltip(&self) -> String` (for example `"autoforge: 2 awaiting approval, 1 running"`). Task 7 feeds them to `tray.set_title` and `tray.set_tooltip`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src-tauri/src/status_tests.rs`:

<!-- prettier-ignore -->
```rust
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`
Expected: ``error[E0599]: no method named `badge` found for struct `status::Snapshot` ``.

- [ ] **Step 3: Implement**

In `apps/desktop/src-tauri/src/status.rs`, replace:

<!-- prettier-ignore -->
```rust
/// `<state dir>/status.json`, written by `autoforge serve` with mode 600.
```

with:

<!-- prettier-ignore -->
```rust
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
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --check`
Expected: `test result: ok. 18 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat(desktop): tray badge and tooltip from the latest snapshot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend scaffold and the run model

**Files:**

- Create: `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, `apps/desktop/src/model.ts`
- Test: `apps/desktop/src/model.test.ts`
- Modify: `vitest.config.ts` (root: exclude `apps/**`)

**Interfaces:**

- Consumes: the JSON shape of Task 3's `Snapshot`.
- Produces (from `src/model.ts`): types `RunStatus`, `Run`, `AppState`, `Snapshot`, `Groups`; `STATUS_LABEL: Record<RunStatus, string>`; `groupRuns(runs: Run[], now: number): Groups` (awaiting and running newest first, `publishing` counts as running, queued by `queuedAt` oldest first, recent = finished statuses within 7 days, newest first, at most 20, unknown statuses dropped); `relativeTime(ms: number): string`; `prLabel(prUrl: string): string`.

- [ ] **Step 1: Add the TypeScript and Vitest config**

Create `apps/desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `apps/desktop/vite.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Tauri loads the dev server from this fixed port (tauri.conf.json devUrl).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
  test: { environment: "jsdom" },
});
```

Replace the whole of `vitest.config.ts` (repo root) with:

```ts
import { configDefaults, defineConfig } from "vitest/config";

// apps/desktop has its own Vitest setup (jsdom) and runs its tests itself.
export default defineConfig({
  test: { testTimeout: 30_000, exclude: [...configDefaults.exclude, "apps/**"] },
});
```

Without this the root `pnpm test` would pick up the desktop tests and run them without jsdom.

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupRuns, prLabel, relativeTime, type Run } from "./model";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const run = (id: string, fields: Partial<Run> = {}): Run => ({
  issueId: id,
  identifier: id.toUpperCase(),
  status: "queued",
  repo: "o/r",
  ref: "main",
  queuedAt: ago(10 * MIN),
  updatedAt: ago(10 * MIN),
  ...fields,
});

describe("groupRuns", () => {
  it("puts each status in its group, publishing counting as running", () => {
    const g = groupRuns(
      [
        run("a", { status: "awaiting_approval" }),
        run("r", { status: "running" }),
        run("p", { status: "publishing" }),
        run("q", { status: "queued" }),
        run("d", { status: "published" }),
      ],
      NOW,
    );
    expect(g.awaiting.map((r) => r.issueId)).toEqual(["a"]);
    expect(g.running.map((r) => r.issueId).sort()).toEqual(["p", "r"]);
    expect(g.queued.map((r) => r.issueId)).toEqual(["q"]);
    expect(g.recent.map((r) => r.issueId)).toEqual(["d"]);
  });

  it("orders the queue by queuedAt, oldest first, and the other groups newest first", () => {
    const g = groupRuns(
      [
        run("q2", { queuedAt: ago(1 * MIN) }),
        run("q1", { queuedAt: ago(5 * MIN) }),
        run("a-old", { status: "awaiting_approval", updatedAt: ago(9 * MIN) }),
        run("a-new", { status: "awaiting_approval", updatedAt: ago(2 * MIN) }),
      ],
      NOW,
    );
    expect(g.queued.map((r) => r.issueId)).toEqual(["q1", "q2"]);
    expect(g.awaiting.map((r) => r.issueId)).toEqual(["a-new", "a-old"]);
  });

  it("keeps finished runs from the last 7 days only, newest first, at most 20", () => {
    const finished = Array.from({ length: 25 }, (_, i) =>
      run(`f${i}`, { status: "failed", updatedAt: ago(i * MIN) }),
    );
    const old = run("old", { status: "discarded", updatedAt: ago(7 * DAY + 1) });
    const edge = run("edge", { status: "no_changes", updatedAt: ago(7 * DAY) });
    const g = groupRuns([old, edge, ...finished], NOW);
    expect(g.recent).toHaveLength(20);
    expect(g.recent[0]?.issueId).toBe("f0");
    expect(g.recent.map((r) => r.issueId)).not.toContain("old");
    expect(groupRuns([old, edge], NOW).recent.map((r) => r.issueId)).toEqual(["edge"]);
  });

  it("drops statuses it does not know and finished runs with an unreadable time", () => {
    const g = groupRuns(
      [
        run("future", { status: "paused" as Run["status"] }),
        run("bad", { status: "timed_out", updatedAt: "yesterday-ish" }),
      ],
      NOW,
    );
    expect(Object.values(g).flat()).toEqual([]);
  });
});

describe("relativeTime", () => {
  it("counts seconds, minutes, hours and days", () => {
    expect(relativeTime(0)).toBe("just now");
    expect(relativeTime(4_999)).toBe("just now");
    expect(relativeTime(5_000)).toBe("5 s ago");
    expect(relativeTime(59_999)).toBe("59 s ago");
    expect(relativeTime(3 * MIN)).toBe("3 min ago");
    expect(relativeTime(2 * 60 * MIN)).toBe("2 h ago");
    expect(relativeTime(3 * DAY)).toBe("3 d ago");
  });

  it("says just now for a clock in the future or an unreadable time", () => {
    expect(relativeTime(-90_000)).toBe("just now");
    expect(relativeTime(Number.NaN)).toBe("just now");
  });
});

describe("prLabel", () => {
  it("reads the pull request number from a GitHub URL", () => {
    expect(prLabel("https://github.com/o/r/pull/42")).toBe("PR #42");
    expect(prLabel("https://github.com/o/r/pull/42/files")).toBe("PR #42");
    expect(prLabel("https://github.com/o/r/compare/x")).toBe("PR");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --dir apps/desktop test`
Expected: FAIL `Failed to resolve import "./model" from "src/model.test.ts"`.

- [ ] **Step 4: Implement**

Create `apps/desktop/src/model.ts`:

```ts
/** Mirrors the daemon's IssueStatus (src/serve/state.ts). */
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "publishing"
  | "published"
  | "no_changes"
  | "failed"
  | "timed_out"
  | "discarded";

/** One entry of the daemon's GET /runs, as passed on by the Rust side. */
export type Run = {
  issueId: string;
  identifier: string;
  status: RunStatus;
  repo: string;
  ref: string;
  queuedAt: string;
  updatedAt: string;
  prUrl?: string;
  issueUrl?: string;
};

/** Serialised by src-tauri/src/status.rs (AppState). */
export type AppState =
  | { kind: "daemonNotRunning" }
  | { kind: "unreachable"; reason: string }
  | { kind: "unauthorized" }
  | { kind: "ok"; runs: Run[] };

/** Serialised by src-tauri/src/status.rs (Snapshot). lastOkAt is epoch ms of the last good poll. */
export type Snapshot = { state: AppState; lastOkAt: number | null };

export type Groups = { awaiting: Run[]; running: Run[]; queued: Run[]; recent: Run[] };

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  publishing: "Publishing",
  published: "Published",
  no_changes: "No changes",
  failed: "Failed",
  timed_out: "Timed out",
  discarded: "Discarded",
};

const FINISHED: RunStatus[] = ["published", "no_changes", "failed", "timed_out", "discarded"];
const WEEK = 7 * 86_400_000;
const RECENT_LIMIT = 20;

const newestFirst = (a: Run, b: Run) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** The popover's groups. Statuses this app does not know (a newer daemon) are left out. */
export function groupRuns(runs: Run[], now: number): Groups {
  const having = (...statuses: RunStatus[]) => runs.filter((r) => statuses.includes(r.status));
  return {
    awaiting: having("awaiting_approval").sort(newestFirst),
    running: having("running", "publishing").sort(newestFirst),
    // ISO timestamps sort as strings; the daemon orders its queue the same way.
    queued: having("queued").sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
    recent: having(...FINISHED)
      .filter((r) => now - Date.parse(r.updatedAt) <= WEEK)
      .sort(newestFirst)
      .slice(0, RECENT_LIMIT),
  };
}

export function relativeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (!(s >= 5)) return "just now"; // also NaN and a clock behind the daemon's
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function prLabel(prUrl: string): string {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  return n ? `PR #${n}` : "PR";
}
```

- [ ] **Step 5: Run the gates**

Run: `pnpm --dir apps/desktop test && pnpm --dir apps/desktop typecheck`, then from the root `pnpm test && pnpm lint && pnpm format`
Expected: desktop `7 passed`; the root suite does not list any `apps/desktop` file; lint and format clean (root ESLint and Prettier do cover `apps/desktop/src`).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts apps/desktop/tsconfig.json apps/desktop/vite.config.ts apps/desktop/src
git commit -m "feat(desktop): run grouping, ordering and relative time for the popover" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Popover view (unstyled): states, rows, keyboard, focus

**Files:**

- Create: `apps/desktop/src/view.ts`, `apps/desktop/src/main.ts`, `apps/desktop/index.html`
- Test: `apps/desktop/src/view.test.ts`

**Interfaces:**

- Consumes: everything exported by `src/model.ts` (Task 5). The Rust commands of Task 7 by name: `current_state`, `autostart_enabled`, `set_autostart {enabled}`, `open_url {url}`, `hide_popover`, `quit`; the event `snapshot` carrying a `Snapshot`.
- Produces (from `src/view.ts`): `type Actions = { open(url), copy(text), hide(), setAutostart(on), quit() }`; `type View = { snap: Snapshot; now: number; autostart: boolean }`; `update(root, view, act)` (rebuilds only when the state, the autostart flag or "has ever been ok" changes; restores focus by `data-key`); `tick(root, now)`; `installKeys(root, act)`; `README_URL`.

The markup is deliberately plain: `h1`, `section[aria-labelledby]` + `h2` per group, `ul > li > button` per run (the button text is its accessible name), `p`/`code`/`button` for the empty and error states, a `footer` with "Updated ...", a labelled checkbox and two buttons. All text goes in through text nodes, never `innerHTML`. No CSS.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/view.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Run, Snapshot } from "./model";
import { installKeys, README_URL, tick, update, type Actions } from "./view";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const run = (id: string, fields: Partial<Run> = {}): Run => ({
  issueId: id,
  identifier: id.toUpperCase(),
  status: "queued",
  repo: "o/r",
  ref: "main",
  queuedAt: ago(10 * MIN),
  updatedAt: ago(3 * MIN),
  issueUrl: `https://linear.app/acme/issue/${id.toUpperCase()}`,
  ...fields,
});

let root: HTMLElement;
let act: { [K in keyof Actions]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.getElementById("app")!;
  act = { open: vi.fn(), copy: vi.fn(), hide: vi.fn(), setAutostart: vi.fn(), quit: vi.fn() };
});

const snap = (state: AppState, lastOkAt: number | null = NOW - 5_000): Snapshot => ({
  state,
  lastOkAt,
});
const show = (s: Snapshot, o: { now?: number; autostart?: boolean } = {}) =>
  update(root, { snap: s, now: o.now ?? NOW, autostart: o.autostart ?? false }, act as Actions);
const text = () => root.textContent?.replace(/\s+/g, " ") ?? "";
const rows = () => [...root.querySelectorAll<HTMLButtonElement>("[data-row]")];
const button = (name: string) =>
  [...root.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  )!;

describe("states", () => {
  it("explains how to start a daemon that is not running, with copy buttons", () => {
    show(snap({ kind: "daemonNotRunning" }, null));
    expect(text()).toContain("autoforge serve isn't running");
    expect(text()).toContain("autoforge service install");
    button("Copy autoforge serve").click();
    button("Copy autoforge service install").click();
    expect(act.copy.mock.calls).toEqual([["autoforge serve"], ["autoforge service install"]]);
  });

  it("shows the reason when the daemon cannot be reached, and that it retries", () => {
    show(snap({ kind: "unreachable", reason: "connection refused" }));
    expect(text()).toContain("Can't reach the daemon");
    expect(text()).toContain("connection refused");
    expect(text()).toContain("Retrying every 5 s");
  });

  it("treats a refused token as unreachable", () => {
    show(snap({ kind: "unauthorized" }));
    expect(text()).toContain("Can't reach the daemon");
    expect(text()).toContain("refused the token");
  });

  it("tells a new user how to start their first run", () => {
    show(snap({ kind: "ok", runs: [] }));
    expect(text()).toContain(
      "No runs yet. Label a Linear issue autoforge and assign it to yourself.",
    );
  });

  it("says so when every run is older than the recent window", () => {
    show(
      snap({
        kind: "ok",
        runs: [run("old", { status: "failed", updatedAt: ago(8 * 1440 * MIN) })],
      }),
    );
    expect(text()).toContain("Nothing in the last 7 days.");
    expect(rows()).toHaveLength(0);
  });
});

describe("run list", () => {
  const runs = [
    run("eng-4", { status: "published", prUrl: "https://github.com/o/r/pull/4" }),
    run("eng-3", { queuedAt: ago(1 * MIN) }),
    run("eng-2", { queuedAt: ago(9 * MIN) }),
    run("eng-1", { status: "awaiting_approval", prUrl: undefined }),
    run("eng-5", { status: "running", repo: "o/api", ref: "dev" }),
  ];

  it("groups runs under headings in order, with counts", () => {
    show(snap({ kind: "ok", runs }));
    expect([...root.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Awaiting approval (1)",
      "Running (1)",
      "Queued (2)",
      "Recent (1)",
    ]);
    for (const section of root.querySelectorAll("section")) {
      const heading = section.querySelector("h2")!;
      expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    }
  });

  it("names each row with identifier, repo, status, time, PR and the approval hint", () => {
    show(snap({ kind: "ok", runs }));
    expect(rows().map((r) => r.textContent)).toEqual([
      "ENG-1, o/r@main, Awaiting approval, 3 min ago, Reply /publish on the issue",
      "ENG-5, o/api@dev, Running, 3 min ago",
      "ENG-2, o/r@main, Queued, position 1, 3 min ago",
      "ENG-3, o/r@main, Queued, position 2, 3 min ago",
      "ENG-4, o/r@main, Published, 3 min ago, PR #4",
    ]);
  });

  it("opens the PR when there is one, otherwise the issue", () => {
    show(snap({ kind: "ok", runs }));
    rows()[4]!.click();
    rows()[0]!.click();
    expect(act.open.mock.calls).toEqual([
      ["https://github.com/o/r/pull/4"],
      ["https://linear.app/acme/issue/ENG-1"],
    ]);
  });

  it("keeps a row without any link focusable but inert (an older daemon sends no issueUrl)", () => {
    show(snap({ kind: "ok", runs: [run("eng-9", { issueUrl: undefined })] }));
    const row = rows()[0]!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    row.click();
    expect(act.open).not.toHaveBeenCalled();
  });

  it("renders issue text as text, never as markup", () => {
    show(snap({ kind: "ok", runs: [run("x", { identifier: '<img src=x onerror="alert(1)">' })] }));
    expect(root.querySelector("img")).toBeNull();
    expect(rows()[0]!.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("keyboard", () => {
  beforeEach(() => installKeys(root, act as Actions));
  const press = (key: string) =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );

  it("moves between rows with the arrow keys and stops at the ends", () => {
    show(snap({ kind: "ok", runs: [run("a"), run("b", { queuedAt: ago(1 * MIN) })] }));
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    press("ArrowUp");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("closes the popover on Escape from anywhere", () => {
    show(snap({ kind: "daemonNotRunning" }, null));
    press("Escape");
    expect(act.hide).toHaveBeenCalledOnce();
  });
});

describe("footer", () => {
  it("shows when the data was last updated, and nothing before the first good poll", () => {
    show(snap({ kind: "ok", runs: [] }, NOW - 5_000));
    expect(text()).toContain("Updated 5 s ago");
    show(snap({ kind: "daemonNotRunning" }, null));
    expect(text()).not.toContain("Updated");
  });

  it("toggles launch at login, opens the README and quits", () => {
    show(snap({ kind: "ok", runs: [] }), { autostart: true });
    const toggle = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    expect(toggle.labels?.[0]?.textContent).toContain("Launch at login");
    toggle.click();
    expect(act.setAutostart).toHaveBeenCalledWith(false);
    button("Open README").click();
    expect(act.open).toHaveBeenCalledWith(README_URL);
    button("Quit").click();
    expect(act.quit).toHaveBeenCalledOnce();
  });
});

describe("updates", () => {
  it("does not rebuild the list when only the poll time changes, so focus stays put", () => {
    show(snap({ kind: "ok", runs: [run("a")] }, NOW - 5_000));
    rows()[0]!.focus();
    const focused = document.activeElement;
    show(snap({ kind: "ok", runs: [run("a")] }, NOW), { now: NOW + 7_000 });
    expect(document.activeElement).toBe(focused);
    expect(text()).toContain("Updated 7 s ago");
  });

  it("puts focus back on the same run after the list changes", () => {
    show(snap({ kind: "ok", runs: [run("a"), run("b", { queuedAt: ago(1 * MIN) })] }));
    rows()[1]!.focus();
    show(
      snap({
        kind: "ok",
        runs: [
          run("z", { queuedAt: ago(20 * MIN) }),
          run("a"),
          run("b", { queuedAt: ago(1 * MIN) }),
        ],
      }),
    );
    expect(document.activeElement?.textContent).toMatch(/^B,/);
  });

  it("ticks relative times forward without new data", () => {
    show(snap({ kind: "ok", runs: [run("a")] }, NOW));
    tick(root, NOW + 2 * MIN);
    expect(rows()[0]!.textContent).toContain("5 min ago");
    expect(text()).toContain("Updated 2 min ago");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --dir apps/desktop test`
Expected: FAIL `Failed to resolve import "./view" from "src/view.test.ts"`.

- [ ] **Step 3: Implement the view**

Create `apps/desktop/src/view.ts`:

```ts
// Structure, names and keyboard only. Visual design comes later through /impeccable.
import { groupRuns, prLabel, relativeTime, STATUS_LABEL, type Run, type Snapshot } from "./model";

export type Actions = {
  open(url: string): void;
  copy(text: string): void;
  hide(): void;
  setAutostart(on: boolean): void;
  quit(): void;
};

export type View = { snap: Snapshot; now: number; autostart: boolean };

export const README_URL = "https://github.com/amanjr09-glitch/autoforge#readme";

type Child = Node | string;

/** Builds an element. Text always goes in as text nodes: run data is untrusted. */
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function button(label: string, attrs: Record<string, string>, onClick: () => void): HTMLElement {
  const b = h("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** A relative time that tick() keeps current. */
const time = (at: number, now: number, attrs: Record<string, string> = {}) =>
  h("span", { "data-at": String(at), ...attrs }, relativeTime(now - at));

function command(text: string, act: Actions): HTMLElement {
  return h(
    "p",
    {},
    h("code", {}, text),
    " ",
    button("Copy", { "aria-label": `Copy ${text}`, "data-key": `copy:${text}` }, () =>
      act.copy(text),
    ),
  );
}

function row(r: Run, status: string, now: number, act: Actions): HTMLElement {
  const parts: Child[] = [
    r.identifier,
    `${r.repo}@${r.ref}`,
    status,
    time(Date.parse(r.updatedAt), now),
  ];
  if (r.prUrl) parts.push(prLabel(r.prUrl));
  if (r.status === "awaiting_approval") parts.push("Reply /publish on the issue");
  const b = h("button", { type: "button", "data-row": "", "data-key": `run:${r.issueId}` });
  parts.forEach((p, i) => b.append(...(i ? [", ", p] : [p])));
  const url = r.prUrl ?? r.issueUrl;
  if (url) b.addEventListener("click", () => act.open(url));
  else b.setAttribute("aria-disabled", "true");
  return b;
}

function section(
  id: string,
  title: string,
  runs: Run[],
  status: (r: Run, i: number) => string,
  now: number,
  act: Actions,
): HTMLElement[] {
  if (!runs.length) return [];
  return [
    h(
      "section",
      { "aria-labelledby": id },
      h("h2", { id }, `${title} (${runs.length})`),
      h("ul", {}, ...runs.map((r, i) => h("li", {}, row(r, status(r, i), now, act)))),
    ),
  ];
}

function body({ snap, now }: View, act: Actions): HTMLElement[] {
  const s = snap.state;
  switch (s.kind) {
    case "daemonNotRunning":
      return [
        h("p", {}, "autoforge serve isn't running."),
        h("p", {}, "Start it in a terminal, or install it as a login service:"),
        command("autoforge serve", act),
        command("autoforge service install", act),
      ];
    case "unreachable":
    case "unauthorized":
      return [
        h("p", {}, "Can't reach the daemon."),
        h(
          "p",
          {},
          s.kind === "unauthorized"
            ? "It refused the token in status.json (it may have just restarted)."
            : s.reason,
        ),
        h("p", {}, "Retrying every 5 s."),
      ];
    case "ok": {
      if (!s.runs.length)
        return [
          h(
            "p",
            {},
            "No runs yet. Label a Linear issue ",
            h("code", {}, "autoforge"),
            " and assign it to yourself.",
          ),
        ];
      const g = groupRuns(s.runs, now);
      const label = (r: Run) => STATUS_LABEL[r.status] ?? r.status;
      const list = [
        ...section("awaiting", "Awaiting approval", g.awaiting, label, now, act),
        ...section("running", "Running", g.running, label, now, act),
        ...section("queued", "Queued", g.queued, (_, i) => `Queued, position ${i + 1}`, now, act),
        ...section("recent", "Recent", g.recent, label, now, act),
      ];
      return list.length ? list : [h("p", {}, "Nothing in the last 7 days.")];
    }
  }
}

function footer({ snap, now, autostart }: View, act: Actions): HTMLElement {
  const toggle = h("input", { type: "checkbox", "data-key": "autostart" }) as HTMLInputElement;
  toggle.checked = autostart;
  toggle.addEventListener("change", () => act.setAutostart(toggle.checked));
  return h(
    "footer",
    {},
    ...(snap.lastOkAt === null
      ? []
      : [h("p", {}, "Updated ", time(snap.lastOkAt, now, { "data-updated": "" }))]),
    h("label", {}, toggle, " Launch at login"),
    button("Open README", { "data-key": "readme" }, () => act.open(README_URL)),
    button("Quit", { "data-key": "quit" }, () => act.quit()),
  );
}

const shown = new WeakMap<HTMLElement, string>();

/**
 * Shows a snapshot. The DOM is rebuilt only when what it shows changes, not on every poll, so
 * focus and screen-reader position survive the 5 second refresh.
 */
export function update(root: HTMLElement, view: View, act: Actions): void {
  const { snap } = view;
  const key = JSON.stringify([snap.state, view.autostart, snap.lastOkAt === null]);
  if (shown.get(root) !== key) {
    const focused = document.activeElement?.getAttribute("data-key");
    root.replaceChildren(h("h1", {}, "autoforge"), ...body(view, act), footer(view, act));
    shown.set(root, key);
    if (focused)
      [...root.querySelectorAll<HTMLElement>("[data-key]")]
        .find((e) => e.dataset.key === focused)
        ?.focus();
  } else if (snap.lastOkAt !== null) {
    root.querySelector("[data-updated]")?.setAttribute("data-at", String(snap.lastOkAt));
  }
  tick(root, view.now);
}

/** Moves every relative time on to `now`. */
export function tick(root: HTMLElement, now: number): void {
  for (const e of root.querySelectorAll<HTMLElement>("[data-at]"))
    e.textContent = relativeTime(now - Number(e.dataset.at));
}

/** Arrow keys move between rows, Enter opens (native button), Esc closes the popover. */
export function installKeys(root: HTMLElement, act: Actions): void {
  root.ownerDocument.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return act.hide();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-row]")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = i === -1 ? 0 : e.key === "ArrowDown" ? i + 1 : i - 1;
    rows[Math.max(0, Math.min(next, rows.length - 1))]?.focus();
    e.preventDefault();
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir apps/desktop test`
Expected: `24 passed` (7 model, 17 view).

- [ ] **Step 5: Add the page and the glue**

`main.ts` is thin glue around `@tauri-apps/api` and is checked by `tsc` and by running the app (Task 7), not by unit tests.

Create `apps/desktop/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>autoforge</title>
    <script type="module" src="/src/main.ts"></script>
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
```

Create `apps/desktop/src/main.ts`:

```ts
// Glue between the Tauri side and the view. All network and file access happens in Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./model";
import { installKeys, tick, update, type Actions } from "./view";

const root = document.getElementById("app")!;
let snap = await invoke<Snapshot>("current_state");
let autostart = await invoke<boolean>("autostart_enabled");

const draw = () => update(root, { snap, now: Date.now(), autostart }, act);

const act: Actions = {
  open: (url) => void invoke("open_url", { url }),
  copy: (text) => void navigator.clipboard.writeText(text),
  hide: () => void invoke("hide_popover"),
  setAutostart: (on) =>
    void invoke("set_autostart", { enabled: on })
      .catch(() => undefined)
      .then(async () => {
        autostart = await invoke<boolean>("autostart_enabled");
        draw();
      }),
  quit: () => void invoke("quit"),
};

installKeys(root, act);
draw();
await listen<Snapshot>("snapshot", (e) => {
  snap = e.payload;
  draw();
});
setInterval(() => tick(root, Date.now()), 1000);
```

- [ ] **Step 6: Build and run the gates**

Run: `pnpm --dir apps/desktop build`, then from the root `pnpm lint && pnpm format`
Expected: `tsc --noEmit` passes and Vite writes `apps/desktop/dist/index.html` plus one `assets/index-*.js`; lint and format clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/index.html apps/desktop/src
git commit -m "feat(desktop): unstyled popover view with keyboard navigation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tauri app: tray, popover window, polling, commands, capabilities

**Files:**

- Modify: `apps/desktop/src-tauri/src/main.rs` (replace the stub)
- Modify: `apps/desktop/src-tauri/build.rs` (app manifest listing the commands)
- Create: `apps/desktop/src-tauri/capabilities/popover.json`

**Interfaces:**

- Consumes: `urls::allowed` (Task 2), `status::{poll, AppState, Snapshot, badge, tooltip}` (Tasks 3, 4), the command and event names Task 6's `main.ts` uses.
- Produces: commands `current_state() -> Snapshot`, `open_url(url: String) -> Result<(), String>`, `hide_popover()`, `autostart_enabled() -> bool`, `set_autostart(enabled: bool) -> Result<(), String>`, `quit()`; event `snapshot` (payload `Snapshot`) emitted to the `popover` window after every poll; `fn popover_origin(click, size, monitor) -> (f64, f64)`.

Behaviour fixed here: tray id `main`; left click (macOS, Windows) toggles the popover placed next to the click; right click (and every click on Linux, where tray clicks are not reported) opens a native menu with "Open autoforge" and "Quit"; the popover hides when it loses focus, and a tray click within 300 ms of that does not reopen it; a second launch shows the popover; no Dock icon on macOS (`ActivationPolicy::Accessory`), no taskbar entry (`skipTaskbar`); polling runs on its own thread every 5 seconds whether or not the popover is open.

- [ ] **Step 1: Write the failing placement tests**

Append to `apps/desktop/src-tauri/src/main.rs`:

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::popover_origin;

    const SIZE: (f64, f64) = (360.0, 480.0);
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn opens_below_a_menu_bar_click_centred_on_it() {
        assert_eq!(popover_origin((1000.0, 12.0), SIZE, SCREEN), (820.0, 12.0));
    }

    #[test]
    fn opens_above_a_taskbar_click_and_stays_on_screen_at_the_right_edge() {
        assert_eq!(
            popover_origin((1900.0, 1060.0), SIZE, SCREEN),
            (1560.0, 580.0)
        );
    }

    #[test]
    fn stays_on_screen_at_the_left_edge_and_on_a_second_monitor() {
        assert_eq!(popover_origin((5.0, 12.0), SIZE, SCREEN), (0.0, 12.0));
        let right = (1920.0, 0.0, 1280.0, 800.0);
        assert_eq!(
            popover_origin((1925.0, 790.0), SIZE, right),
            (1920.0, 310.0)
        );
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`
Expected: ``error[E0432]: unresolved import `super::popover_origin` ``.

- [ ] **Step 3: Grant the webview only the app's commands**

Replace the whole of `apps/desktop/src-tauri/build.rs` with:

```rust
fn main() {
    // Listing the app's commands makes Tauri generate one permission per command, so the
    // capability file has to grant each one explicitly.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "current_state",
        "open_url",
        "hide_popover",
        "autostart_enabled",
        "set_autostart",
        "quit",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
```

Create `apps/desktop/src-tauri/capabilities/popover.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "popover",
  "description": "The popover: receive state events and call the app's own commands. No file system, shell, HTTP or plugin access.",
  "windows": ["popover"],
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-current-state",
    "allow-open-url",
    "allow-hide-popover",
    "allow-autostart-enabled",
    "allow-set-autostart",
    "allow-quit"
  ]
}
```

The build regenerates `permissions/autogenerated/*.toml` from the list in `build.rs` (ignored by git) and fails if the capability names a permission that does not exist.

- [ ] **Step 4: Implement the app**

Replace the whole of `apps/desktop/src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod status;
mod urls;

use status::{AppState, Snapshot};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const POLL_EVERY: Duration = Duration::from_secs(5);
const POPOVER: &str = "popover";
const TRAY: &str = "main";

struct Shared {
    snapshot: Mutex<Snapshot>,
    /// When losing focus last hid the popover: the tray click that caused it must not reopen it.
    hidden_at: Mutex<Option<Instant>>,
}

#[tauri::command]
fn current_state(shared: tauri::State<Shared>) -> Snapshot {
    shared.snapshot.lock().unwrap().clone()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = urls::allowed(&url).ok_or("only https links to linear.app and github.com open")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_popover(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Top-left corner for a popover of `size` near a tray click, kept inside the monitor
/// `(x, y, width, height)`. A menu bar at the top opens it below the click, a taskbar at the
/// bottom above it. All values are physical pixels.
fn popover_origin(
    click: (f64, f64),
    size: (f64, f64),
    monitor: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let fit = |v: f64, start: f64, len: f64, span: f64| v.min(start + span - len).max(start);
    let y = if click.1 < my + mh / 2.0 {
        click.1
    } else {
        click.1 - size.1
    };
    (
        fit(click.0 - size.0 / 2.0, mx, size.0, mw),
        fit(y, my, size.1, mh),
    )
}

/// Shows the popover near `near` (a tray click), or centred when there is no click position
/// (the tray menu, a second launch, Linux where tray clicks are not reported).
fn show_popover(app: &AppHandle, near: Option<PhysicalPosition<f64>>) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let placed = near.and_then(|p| {
        let monitor = app.monitor_from_point(p.x, p.y).ok()??;
        let size = window.outer_size().ok()?;
        let (pos, area) = (monitor.position(), monitor.size());
        let (x, y) = popover_origin(
            (p.x, p.y),
            (size.width.into(), size.height.into()),
            (
                pos.x.into(),
                pos.y.into(),
                area.width.into(),
                area.height.into(),
            ),
        );
        window.set_position(PhysicalPosition::new(x, y)).ok()
    });
    if placed.is_none() {
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_popover(app: &AppHandle, click: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let hidden_at = *app.state::<Shared>().hidden_at.lock().unwrap();
    let just_hidden = hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if !just_hidden {
        show_popover(app, Some(click));
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Polls the daemon every 5 seconds, popover open or not: the badge needs it.
fn start_polling(app: AppHandle) {
    let status_path = app
        .path()
        .home_dir()
        .map(|home| home.join(".autoforge").join("status.json"));
    std::thread::spawn(move || loop {
        let state = match &status_path {
            Ok(path) => status::poll(path),
            Err(_) => AppState::DaemonNotRunning,
        };
        let snapshot = {
            let shared = app.state::<Shared>();
            let mut current = shared.snapshot.lock().unwrap();
            let ok = matches!(state, AppState::Ok { .. });
            let last_ok_at = if ok {
                Some(now_ms())
            } else {
                current.last_ok_at
            };
            *current = Snapshot { state, last_ok_at };
            current.clone()
        };
        if let Some(tray) = app.tray_by_id(TRAY) {
            // The title shows next to the icon on macOS and Linux; Windows only has the tooltip.
            let _ = tray.set_title(snapshot.badge());
            let _ = tray.set_tooltip(Some(snapshot.tooltip()));
        }
        let _ = app.emit_to(POPOVER, "snapshot", &snapshot);
        std::thread::sleep(POLL_EVERY);
    });
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_popover(app, None)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .manage(Shared {
            snapshot: Mutex::new(Snapshot {
                state: AppState::DaemonNotRunning,
                last_ok_at: None,
            }),
            hidden_at: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            current_state,
            open_url,
            hide_popover,
            autostart_enabled,
            set_autostart,
            quit
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
                *window.state::<Shared>().hidden_at.lock().unwrap() = Some(Instant::now());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let open = MenuItem::with_id(app, "open", "Open autoforge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::with_id(TRAY)
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .icon_as_template(true)
                .tooltip("autoforge")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_popover(app, None),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle(), position);
                    }
                })
                .build(app)?;
            start_polling(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running autoforge desktop");
}

#[cfg(test)]
mod tests {
    use super::popover_origin;

    const SIZE: (f64, f64) = (360.0, 480.0);
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn opens_below_a_menu_bar_click_centred_on_it() {
        assert_eq!(popover_origin((1000.0, 12.0), SIZE, SCREEN), (820.0, 12.0));
    }

    #[test]
    fn opens_above_a_taskbar_click_and_stays_on_screen_at_the_right_edge() {
        assert_eq!(
            popover_origin((1900.0, 1060.0), SIZE, SCREEN),
            (1560.0, 580.0)
        );
    }

    #[test]
    fn stays_on_screen_at_the_left_edge_and_on_a_second_monitor() {
        assert_eq!(popover_origin((5.0, 12.0), SIZE, SCREEN), (0.0, 12.0));
        let right = (1920.0, 0.0, 1280.0, 800.0);
        assert_eq!(
            popover_origin((1925.0, 790.0), SIZE, right),
            (1920.0, 310.0)
        );
    }
}
```

- [ ] **Step 5: Run the Rust gates**

Run (in `apps/desktop/src-tauri`): `PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --check && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo clippy --all-targets -- -D warnings && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`
Expected: no warnings; `test result: ok. 21 passed`. (`pnpm --dir apps/desktop build` must have run once so `../dist` exists for `generate_context!`.)

- [ ] **Step 6: Check it against a real status server**

This proves the HTTP/1.0 request, the Bearer token and the absence of `Origin` against the daemon's real `startStatusServer`, without Linear. From the repo root, after `pnpm build` (the script imports `dist/` and must sit in the repo root for that relative import):

```bash
S=$(mktemp -d) && mkdir -p "$S/home/.autoforge"
cat > integ.tmp.mjs <<'EOF'
import { startStatusServer } from "./dist/serve/status.js";
let calls = 0;
const daemon = {
  runs() {
    calls++;
    return [];
  },
  patch: async () => null,
  command: async () => null,
};
const s = await startStatusServer(daemon, process.argv[2]);
setTimeout(async () => {
  await s.close();
  console.log(`runs() answered ${calls} authorised requests`);
  process.exit(0);
}, 13000);
EOF
(cd apps/desktop/src-tauri && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo build)
(node integ.tmp.mjs "$S/home/.autoforge" > "$S/integ.log" &)
perl -e 'select(undef,undef,undef,1)'
HOME="$S/home" perl -e 'alarm 12; exec @ARGV' apps/desktop/src-tauri/target/debug/autoforge-desktop; true
perl -e 'select(undef,undef,undef,2)'; cat "$S/integ.log"; rm integ.tmp.mjs
```

Expected: `runs() answered 2 authorised requests` or 3 (one poll every 5 seconds; `runs()` is only reached after the token check and the `Origin` check pass). The app must not panic in those 12 seconds. A tray icon appears briefly in the menu bar.

- [ ] **Step 7: Run it for real (manual, macOS)**

Run: `pnpm desktop:dev` is added in Task 8; for now `cd apps/desktop && PATH=/opt/homebrew/opt/rustup/bin:$PATH pnpm tauri dev`.
Expected with no daemon running: tray icon without a title; click shows the popover with "autoforge serve isn't running." and two Copy buttons; Esc and clicking elsewhere hide it. Start `autoforge serve` and within about 5 s the popover switches to the run list or the empty state. Stop the daemon: the tray title shows `!`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/capabilities apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(desktop): tray, popover window, 5 s polling and locked-down commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`Cargo.lock` is committed because this is an application. If Task 2 already committed it, `git add` is a no-op.)

---

### Task 8: CI job, root scripts and README

**Files:**

- Modify: `.github/workflows/ci.yml` (append the `desktop` job)
- Modify: `package.json` (root scripts `desktop:dev`, `desktop:build`)
- Modify: `README.md` (Desktop app section, roadmap)

**Interfaces:**

- Consumes: the desktop scripts `typecheck`, `test`, `build`, `tauri` (Task 2's `package.json`).
- Produces: `pnpm desktop:dev`, `pnpm desktop:build`; a CI job `desktop` on `macos-latest`, `windows-latest`, `ubuntu-latest`.

- [ ] **Step 1: Add the root scripts**

In `package.json`, replace:

<!-- prettier-ignore -->
```json
    "fix": "prettier --write . && eslint --fix ."
```

with:

<!-- prettier-ignore -->
```json
    "fix": "prettier --write . && eslint --fix .",
    "desktop:dev": "pnpm --dir apps/desktop tauri dev",
    "desktop:build": "pnpm --dir apps/desktop tauri build"
```

Run: `pnpm --dir apps/desktop tauri --version`
Expected: `tauri-cli 2.12.1`. `git diff package.json` shows only the script lines; `"files": ["dist"]` and the (absent) runtime `dependencies` are untouched.

- [ ] **Step 2: Add the CI job**

Append to `.github/workflows/ci.yml`:

<!-- prettier-ignore -->
```yaml
  desktop:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: apps/desktop
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - name: Install WebKitGTK and AppIndicator
        if: runner.os == 'Linux'
        run: >-
          sudo apt-get update && sudo apt-get install -y build-essential libwebkit2gtk-4.1-dev
          libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: apps/desktop/pnpm-lock.yaml
      - name: Install the Rust toolchain from rust-toolchain.toml
        run: rustup toolchain install
        working-directory: apps/desktop/src-tauri
      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        with:
          workspaces: apps/desktop/src-tauri
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: cargo fmt --check
        working-directory: apps/desktop/src-tauri
      - run: cargo clippy --all-targets -- -D warnings
        working-directory: apps/desktop/src-tauri
      - run: cargo test
        working-directory: apps/desktop/src-tauri
```

Notes: the actions are pinned to commit SHAs like the existing job (the new one, `Swatinem/rust-cache`, is `v2.9.2` = `6323deb102c322ba6fcbdcafc7e3dddab59af2b6`); the workflow-level `permissions: contents: read` covers this job; `rustup toolchain install` with no argument installs the toolchain and components named in `rust-toolchain.toml`; the frontend build runs before cargo because `generate_context!` embeds `../dist`. A full `tauri build` is not run in CI: `cargo clippy` type-checks the whole app and `cargo test` builds it, and bundling stays a local step in v1.

Run: `pnpm format`
Expected: Prettier accepts the YAML (it also proves the file parses).

- [ ] **Step 3: Document it**

In `README.md`, replace:

<!-- prettier-ignore -->
```md
## Custom sandboxes
```

with:

<!-- prettier-ignore -->
````md
## Desktop app

A tray app for macOS (menu bar), Windows (system tray) and Linux (AppIndicator) that shows your
own `autoforge serve`: a badge with the number of runs awaiting approval, and a list of running,
queued and recent runs that opens the pull request or the Linear issue. It reads
`~/.autoforge/status.json` (the default `--dir`) and polls the status endpoint every 5 seconds.
The token stays in the app's Rust side; the window gets no network, file or shell access, and
only `https://linear.app/` and `https://github.com/` links open.

There are no published installers yet. Build it from this repository with Rust (the version in
`apps/desktop/src-tauri/rust-toolchain.toml`) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS:

```sh
pnpm --dir apps/desktop install
pnpm desktop:dev     # run it
pnpm desktop:build   # unsigned installers in apps/desktop/src-tauri/target/release/bundle
```

- Click the tray icon to open the list, or use its menu (right click; on Linux, any click).
- On Windows the count is in the tooltip; the icon itself does not change yet.
- On Linux, KDE shows the tray icon; GNOME shows it only with the AppIndicator extension.
- Launch at login is off until you turn it on in the app.

## Custom sandboxes
````

In `README.md`, replace:

<!-- prettier-ignore -->
```md
Next: a menu-bar app on top of the `autoforge serve` status endpoint.
```

with:

<!-- prettier-ignore -->
```md
Next: the desktop app's visual design, then Publish and Discard from the app, desktop
notifications and signed installers.
```

- [ ] **Step 4: Run every gate once more**

Run from the root: `pnpm lint && pnpm format && pnpm typecheck && pnpm build && pnpm test`, then `pnpm --dir apps/desktop typecheck && pnpm --dir apps/desktop test && pnpm --dir apps/desktop build`, then in `apps/desktop/src-tauri`: `PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --check && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo clippy --all-targets -- -D warnings && PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test`.
Expected: all green. `npm pack --dry-run` lists only `dist/`, `package.json`, `README.md`, `LICENSE`.

- [ ] **Step 5: Optional local installer check (macOS)**

Run: `PATH=/opt/homebrew/opt/rustup/bin:$PATH pnpm desktop:build`
Expected (about 3 minutes): `apps/desktop/src-tauri/target/release/bundle/macos/autoforge.app` and `bundle/dmg/autoforge_0.0.0_aarch64.dmg`, unsigned.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml package.json README.md
git commit -m "ci: build and test the desktop app on macOS, Windows and Linux" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

After pushing, confirm all three `desktop` matrix jobs pass. The Windows job is the first place `pid_alive` (Windows branch) and the tests run on Windows.

---

### Task 9: Visual design (follow-up, not implemented in this plan)

Visual design: run `/impeccable` new-work for the popover, one component at a time with the user's approval. Candidates, each its own approval: the popover shell and light/dark tokens (respecting `prefers-color-scheme` and `prefers-reduced-motion`), run rows, group headings, the not-running / unreachable / empty states, the footer menu (the spec's "menu" is plain inline controls here), the tray icon (macOS template, Windows icon with a drawn count since Windows trays have no title text, Linux), and the app icon replacing `app-icon.png`. Keep the structure, accessible names and `data-key` / `data-row` / `data-at` hooks that `view.test.ts` relies on.

---

## Manual checklist before merge (not covered by automated tests)

- [ ] macOS: menu-bar icon renders as a template icon; title shows the awaiting count and hides at 0; `!` appears only after the daemon was reachable and then stopped; no Dock icon; popover opens under the icon and stays on screen near the right edge.
- [ ] Windows: tray icon present, tooltip summary correct, popover opens above the taskbar, no taskbar button; a refused connection reads "connection refused" or "timed out" (Windows retries refused localhost connects).
- [ ] Linux KDE, and GNOME with the AppIndicator extension: icon visible, the label shows the count, the menu's "Open autoforge" shows the popover centred. GNOME without the extension: no icon (documented).
- [ ] Single instance: launching a second copy shows the existing popover and exits.
- [ ] Launch at login: the checkbox turns it on and off; after a logout/login the app starts (macOS LaunchAgent, Windows registry, Linux `~/.config/autostart`).
- [ ] Daemon stops and starts again (new token and port): the popover recovers within one or two polls without restarting the app.
- [ ] Links: a PR row opens GitHub, an awaiting row opens the Linear issue, in the default browser.
- [ ] Copy buttons put the command on the clipboard in each OS webview (WKWebView, WebView2, WebKitGTK).
- [ ] Keyboard: arrows move between rows, Enter opens, Esc hides; VoiceOver / Narrator / Orca read each row's text and are not interrupted every 5 seconds.
- [ ] Production CSP: in a `pnpm desktop:build` build the popover loads and receives events (no CSP errors in the web inspector of a debug build: `pnpm tauri build --debug`).

## Self-review notes

- Spec coverage: data flow 1-6 (Tasks 3, 4, 7), daemon change (Task 1), lifecycle (Task 7), popover states, groups, rows, badge, tooltip, footer, keyboard (Tasks 4, 5, 6, 7), security (Tasks 2, 3, 7), testing (all tasks plus the manual checklist), packaging and CI (Tasks 2, 8). Visual design and the out-of-scope list stay out.
- Deviations from the spec, deliberate: the webview gets no opener or autostart plugin permission at all; Rust opens links and toggles autostart through the app's own commands, which is stricter than "the URL opener with the allowlist" as a webview capability. `connect-src` is limited to Tauri IPC (`ipc: http://ipc.localhost`), which Tauri needs on Windows and Linux; there is still no network origin. The allowlist parses the URL and compares the host instead of a string prefix (same intent, also rejects `https://github.com@evil.com` and ports). Windows shows the count only in the tooltip until the icon design lands. The tray also gets a native menu ("Open autoforge", "Quit") because Linux trays do not report clicks.
- Rulings on spec gaps: `publishing` runs are shown under Running; the awaiting and running groups are newest first; queue position follows `queuedAt`; a runs list where nothing falls in the groups says "Nothing in the last 7 days."; a row with neither `prUrl` nor `issueUrl` stays focusable but inert; times under 5 s and future or unreadable times read "just now"; `issueUrl` is optional on `GET /runs` because entries from before this slice have none until their issue is polled again; a status file whose token is not alphanumeric is treated as not running (it would otherwise be written into a header); "Updated N ago" counts from the last successful poll; a custom daemon `--dir` is not supported in v1 (always `~/.autoforge`).
