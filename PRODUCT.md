# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The only planned UI (slice 3) is a desktop tray app for Windows, Linux and macOS. A
cross-platform shell renders a web UI, so the design language is web, not native per OS.

## Stack

Undecided framework for the slice 3 desktop app. Confirmed requirement: one app for Windows,
Linux and macOS with a tray / menu-bar presence. Tauri is the leading candidate (native shell,
web UI, small binaries); not yet chosen. The app is a client of the daemon's localhost status
endpoint (`GET /runs`, `GET /runs/:id/patch`, `POST /runs/:id/publish|discard`, Bearer token from
`~/.autoforge/status.json`).

The core product is a zero-dependency TypeScript package (`autoforge`) and CLI
(`autoforge serve`, `status`, `service install|uninstall`).

## Users

Engineering teams at companies who want a self-hosted, open-source alternative to cloud agent
platforms such as Factory: hand a Linear ticket to a coding agent and get back a reviewable pull
request, with the agent, the model keys and the code staying on their own machines.

Individual engineers on those teams operate it day to day: they label and assign issues, read
results on the Linear issue or in the tray app, and approve or reject publishing.

Decided: one person per daemon. Each engineer runs their own daemon on their own machine, and
only the owner of the Linear API key can approve. Team-wide features (shared visibility of runs,
several approvers, central governance) are out of scope; teams adopt autoforge one engineer at a
time.

## Product Purpose

Run any coding agent in an isolated local sandbox against a real repository, return the change
as a plain patch, and turn it into a draft pull request only after a human approves. Success is
"assign an issue, walk away, come back to a draft PR you chose to publish", with no cloud
service, account or vendor in between.

## Positioning

- Local-first and open source (MIT): runs on the user's machine with their own agent and keys.
- Bring your own agent: any command (Claude Code, Aider, OpenHands, a script); autoforge ships no
  agent of its own.
- The push token never enters the sandbox: the agent produces a patch; publishing happens on the
  host, and only after explicit human approval.
- Zero runtime dependencies.

## Operating Context

- Linear for issues (pickup by label `autoforge` + assignment; approval by `/publish`,
  `/publish force`, `/discard`, `/retry <feedback>` comments from the user).
- GitHub for pull requests (draft by default).
- Docker (Docker Desktop, OrbStack or Colima) as the sandbox on the user's machine.
- Runs as a foreground CLI or a launchd / systemd user service; state in `~/.autoforge/`.
- Results and progress are posted as Linear comments; the local status endpoint exposes the same
  state for a desktop client.

## Capabilities and Constraints

- SDK: `run()` (clone, run agent, collect patch), `DockerSandbox`, `publishToGitHub()`.
- Daemon: FIFO queue, one run at a time by default, daily run limit, Docker pause, approval
  expiry, restart recovery, one daemon per state dir.
- Security constraints that future work must preserve: secrets never in comments, logs, state,
  the PR body or the agent env (unless explicitly listed); a patch containing a known secret is
  never published; commands only from the API key owner; the status endpoint is localhost-only,
  token-gated and rejects browser `Origin` requests.
- Not yet supported: Jira, GitLab, webhooks, several users per daemon, issue attachments.
- Terminology: "run", "patch", "publish", "discard", "retry", "awaiting approval", "sandbox".

## Brand Commitments

Name: **autoforge** (lowercase). No logo, colours, typography or other visual identity exist yet.
Voice in existing docs is plain and technical.

## Evidence on Hand

- Code, tests (279+ including Docker), README and specs in this repository.
- No users, customers, testimonials, benchmarks or production deployments yet. Do not fabricate
  any. Not yet published to npm; the GitHub repo is private.

## Product Principles

1. The human decides what gets published. Automation stops at a reviewable result.
2. Nothing secret leaves the machine by accident: assume every agent output and issue text is
   untrusted.
3. Bring your own agent and keys; never lock users into a vendor.
4. Small, auditable surface: zero runtime dependencies, plain files, readable state.
5. Fail loudly and recoverably: no silent data loss, no double runs, no double publishes.
