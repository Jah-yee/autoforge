# autoforge desktop: design spec (slice 3, the tray app)

Date: 2026-10-09
Status: draft, awaiting review
Builds on: slice 2 `autoforge serve` and its localhost status endpoint
(`docs/specs/2026-10-09-autoforge-serve-design.md`, section 7). Product context: `PRODUCT.md`.

## 1. Goal

A small, personal tray app for Windows, Linux and macOS that shows the state of the engineer's own
`autoforge serve` daemon at a glance: how many runs are waiting for approval, what is running and
queued, and what finished recently, with one click to the Linear issue or the pull request.

v1 is read-only. Approving, discarding and retrying stay in Linear (or the endpoint) for now.

### Success criteria

- The tray badge shows the number of runs awaiting approval within about 5 seconds of a change.
- The popover lists queued, running, awaiting and recent runs, and a click opens the PR or the
  Linear issue in the default browser.
- When the daemon is not running or not reachable, the app says so and how to fix it.
- The daemon's token never reaches the webview.
- Builds and runs on macOS (menu bar), Windows (system tray) and Linux (AppIndicator tray).

### Decisions already made

| Decision      | Choice                                                                                |
| :------------ | :------------------------------------------------------------------------------------ |
| Scope         | Personal view of the user's own daemon; team view later                               |
| Framework     | Tauri 2 (Rust shell, system webview, TypeScript UI)                                   |
| Location      | Same repo, `apps/desktop`                                                             |
| v1 features   | Tray icon with badge, popover run list with links                                     |
| Data source   | Rust side polls `GET /runs` every 5 seconds (approach A)                              |
| Visual design | Decided later through `/impeccable`, one component at a time with the user's approval |

## 2. Architecture

```
apps/desktop/
  src-tauri/
    src/main.rs      tray icon and badge, popover window toggle, single instance, autostart
    src/status.rs    read status.json, poll GET /runs, map to an AppState
    src/urls.rs      allowlist for opening links
    tauri.conf.json, capabilities/
  src/
    main.ts          render AppState received from Rust
    model.ts         grouping, sorting, limits, relative time (pure)
  package.json
```

### Data flow

1. `status.rs` reads `~/.autoforge/status.json` (`{ port, token, pid }`; the daemon writes it with
   mode 600). The path follows the daemon's state dir default (`~/.autoforge`).
2. No file, unparsable file, or a `pid` that is not alive gives `DaemonNotRunning`.
3. Otherwise it calls `GET http://127.0.0.1:<port>/runs` with `Authorization: Bearer <token>`, no
   `Origin` header (the endpoint rejects any request with one), and a 3 second timeout.
4. Result mapping:

   | Outcome                                   | AppState                                                                                       |
   | :---------------------------------------- | :--------------------------------------------------------------------------------------------- |
   | 200 with a JSON array                     | `Ok(runs)`                                                                                     |
   | 401                                       | `Unauthorized`; re-read `status.json` on the next poll (the daemon restarted with a new token) |
   | connection refused, timeout, other status | `Unreachable(reason)`                                                                          |
   | no or stale `status.json`                 | `DaemonNotRunning`                                                                             |

5. After every poll Rust updates the tray badge and tooltip and emits the `AppState` to the popover
   window as a Tauri event. The webview never performs network requests.
6. Clicking a row asks Rust to open a URL; Rust opens it only if it starts with
   `https://linear.app/` or `https://github.com/`.

Poll interval: 5 seconds while running. Polling continues while the popover is closed (the badge
needs it).

### Daemon change (part of this slice)

`GET /runs` entries gain `issueUrl: string`, taken from Linear's issue `url` field (added to the
issue fragment in `src/serve/linear.ts` and stored on the issue entry). Existing fields are
unchanged.

### Lifecycle

- Single instance (Tauri single-instance plugin): a second launch focuses the first.
- Tray only: no dock icon on macOS (`ActivationPolicy::Accessory`), no taskbar entry on Windows.
- Launch at login: Tauri autostart plugin, off by default, toggled from the footer menu.
- Quit from the footer menu.
- Linux: the tray needs AppIndicator support. GNOME without the AppIndicator extension shows no
  icon; the README says so.

## 3. Popover content and behaviour

Visual design is out of scope here; this fixes content, states and interaction.

### States

| State                          | Content                                                                                                                      |
| :----------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `DaemonNotRunning`             | "autoforge serve isn't running", the commands to start it (`autoforge serve`, or `autoforge service install`), a Copy button |
| `Unreachable` / `Unauthorized` | "Can't reach the daemon", the reason, "retrying every 5 s"                                                                   |
| `Ok([])`                       | "No runs yet. Label a Linear issue `autoforge` and assign it to yourself."                                                   |
| `Ok(runs)`                     | the run list                                                                                                                 |

### Run list

Groups, in order:

1. Awaiting approval.
2. Running.
3. Queued, with queue position (order of `queuedAt`).
4. Recent: `published`, `no_changes`, `failed`, `timed_out`, `discarded` updated in the last 7
   days, newest first, at most 20.

Each row: issue identifier (for example ENG-123), `owner/name@branch`, status, relative time since
the last update ("3 min ago"), and "PR #N" when `prUrl` exists. Awaiting rows add the hint
"Reply /publish on the issue". Click or Enter opens the PR if present, otherwise the issue.

### Badge and tooltip

- Badge: count of awaiting-approval runs; hidden at 0.
- Warning indicator when the daemon is not running or unreachable, but only after it was reachable
  at least once since the app started (no warnings on a fresh install).
- Tooltip: a short summary, for example "2 awaiting approval, 1 running".

### Footer

"Updated 5 s ago", and a menu: Launch at login (toggle), Open README, Quit.

### Size and accessibility

About 360 x 480 logical pixels, list scrolls. Arrow keys move between rows, Enter opens, Esc
closes. Every row and the badge have accessible names. Respects the OS light/dark setting and
reduced-motion.

## 4. Security

- The token is read and used only in Rust; it is never sent to the webview.
- Tauri capabilities: the event channel to the popover window, the URL opener (with the allowlist
  above), autostart, single instance. No file-system, shell or HTTP permissions for the webview.
- Content security policy: bundled assets only, no remote scripts, no `connect-src`.
- v1 never calls the endpoint's `POST` routes.
- URLs from the daemon are treated as untrusted and checked against the allowlist before opening.

## 5. Testing

Tests first, as in slices 1 and 2.

- Rust unit tests: status-file parsing (missing, malformed, dead pid, valid); response-to-state
  mapping against a fake HTTP server on 127.0.0.1 (200, 401, 500, timeout, refused, bad JSON);
  that requests carry the Bearer token and no `Origin`; badge count; URL allowlist (accepts
  linear.app and github.com https URLs, rejects others, `javascript:`, `file:`, look-alike hosts).
- TypeScript (Vitest + jsdom): rendering of each state; grouping, ordering, the 7-day and 20-item
  limits; relative time; keyboard navigation; accessible names.
- Daemon: `GET /runs` includes `issueUrl`.
- Manual per OS, before merge: tray icon and badge on macOS, Windows, Linux (KDE, and GNOME with
  the AppIndicator extension); single instance; launch at login; behaviour when the daemon stops
  and starts again.

## 6. Packaging and CI

- Root scripts: `pnpm desktop:dev`, `pnpm desktop:build`.
- The npm package's `files` stays `["dist"]`; the desktop app never ships in the npm package, and
  the SDK keeps zero runtime dependencies.
- CI: a new job builds and tests the desktop app on `macos-latest`, `windows-latest` and
  `ubuntu-latest` (with the WebKitGTK and AppIndicator system packages).
- Installers (dmg, msi, AppImage or deb) are built locally and unsigned in v1. Code signing,
  notarisation and release automation are later.

## 7. Out of scope for v1

Diff viewer; Publish, Discard or Retry from the app; desktop notifications; team view; code
signing and auto-update; configuring the daemon from the app.
