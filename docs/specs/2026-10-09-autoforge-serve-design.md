# autoforge serve: design spec (slice 2, the Linear daemon)

Date: 2026-10-09
Status: draft, awaiting review
Builds on: slice 1 SDK (`docs/specs/2026-10-09-autoforge-design.md`), including the hardening
follow-ups in PR #2 (`Sandbox.create({ signal })`, `publishToGitHub({ signal })`).

## 1. Goal

`autoforge serve` is a local daemon that makes "assign a ticket, get a PR" work on the user's own
machine. It watches Linear for issues assigned to the user, runs each one through the slice 1 SDK
in a Docker sandbox, reports on the issue, waits for the user's approval in a Linear comment, and
then opens a draft PR and links it on the issue.

### Success criteria

- The user labels an issue `autoforge` (and it is assigned to them), walks away, and later finds a
  result comment with a patch excerpt on the issue.
- Replying `/publish` opens a draft PR and links it on the issue. `/retry <feedback>` reruns with
  the feedback. `/discard` closes the loop.
- Only the user's own comments act as commands.
- The daemon survives restarts without losing or duplicating work.
- No new runtime dependencies.

### Decisions already made

| Decision        | Choice                                                                                         |
| :-------------- | :--------------------------------------------------------------------------------------------- |
| Approval        | Commands in Linear comments: `/publish`, `/publish force`, `/discard`, `/retry <feedback>`     |
| Who may approve | Only the Linear user who owns the API key (`viewer`)                                           |
| Pickup          | Assigned to the user AND labelled `autoforge` (configurable to all assigned issues)            |
| Repo routing    | Label `repo:owner/name[@branch]`, then project rule, then team rule, then default repo         |
| Task text       | Config template over `{title}`, `{description}`, `{comments}`                                  |
| Iteration       | `/retry <feedback>` starts a fresh run with the original task plus the feedback                |
| Concurrency     | 1 run at a time (`maxConcurrent`), FIFO queue                                                  |
| Runtime         | Foreground CLI plus `autoforge service install` (launchd on macOS, systemd user unit on Linux) |
| State           | Atomic JSON file plus patch files under `~/.autoforge/`                                        |
| Menu-bar app    | Out of scope; slice 3, built on the local status endpoint defined here                         |

## 2. Components

All new code lives in `src/serve/`. Each unit has one job.

| Unit         | Job                                                                                               |
| :----------- | :------------------------------------------------------------------------------------------------ |
| `config.ts`  | Load and validate `~/.autoforge/config.json`; read secrets from the environment                   |
| `linear.ts`  | Thin Linear GraphQL client over `fetch` implementing the `LinearApi` interface                    |
| `route.ts`   | Pure: issue to `{ repo, ref, agent }` or "no match"                                               |
| `prompt.ts`  | Pure: render the task template from the issue                                                     |
| `state.ts`   | Atomic JSON state and patch files                                                                 |
| `daemon.ts`  | Poll loop, queue, worker, command handling; exposes `tick()`                                      |
| `status.ts`  | Localhost status endpoint for the future menu-bar app                                             |
| `service.ts` | Render and install the launchd plist or systemd user unit                                         |
| `cli.ts`     | `autoforge serve`, `autoforge status`, `autoforge service install`, `autoforge service uninstall` |

`package.json` gains `"bin": { "autoforge": "./dist/serve/cli.js" }`. Argument parsing uses
`node:util` `parseArgs`; the endpoint uses `node:http`.

### `LinearApi` interface

```ts
interface LinearApi {
  viewer(): Promise<{ id: string; name: string }>;
  // Issues assigned to the viewer and updated after `since`, PLUS the issues in `trackedIds`
  // whatever their assignee (so unassignment is visible), with labels, team, project, state,
  // assignee and comments created after `since`. Paginated internally.
  changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]>;
  // createdAt is Linear's clock; the command gate compares against it, never the local clock.
  comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }>;
  moveToStarted(issueId: string): Promise<void>; // first workflow state of type "started"
  attachUrl(issueId: string, url: string, title: string): Promise<void>;
}
```

The daemon only talks to `LinearApi`, so tests use an in-memory fake.

## 3. Configuration

`~/.autoforge/config.json`:

```json
{
  "pollSeconds": 30,
  "maxConcurrent": 1,
  "dailyRunLimit": 20,
  "approvalExpiryDays": 14,
  "pickup": "labelled",
  "label": "autoforge",
  "comments": "all",
  "defaultRepo": "me/app@main",
  "rules": [
    { "linearProject": "Docs", "repo": "me/docs@main" },
    { "linearTeam": "ENG", "repo": "me/app@develop", "agent": { "image": "my-agent" } }
  ],
  "agent": {
    "image": "autoforge-claude",
    "command": ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
    "envFrom": ["ANTHROPIC_API_KEY"],
    "timeoutMinutes": 30
  },
  "template": "{title}\n\n{description}\n\nDiscussion (from issue participants):\n{comments}"
}
```

| Field                | Default       | Notes                                                                                                                     |
| :------------------- | :------------ | :------------------------------------------------------------------------------------------------------------------------ |
| `pollSeconds`        | 30            | minimum 10                                                                                                                |
| `maxConcurrent`      | 1             |                                                                                                                           |
| `dailyRunLimit`      | 20            | runs started per local calendar day                                                                                       |
| `approvalExpiryDays` | 14            |                                                                                                                           |
| `pickup`             | `"labelled"`  | or `"all-assigned"`                                                                                                       |
| `label`              | `"autoforge"` | pickup label name                                                                                                         |
| `comments`           | `"all"`       | or `"mine"`: which comments enter `{comments}`                                                                            |
| `defaultRepo`        | none          | `owner/name@branch`; `@branch` optional, default `main`                                                                   |
| `rules`              | `[]`          | each has exactly one of `linearProject` / `linearTeam` (name or key), a `repo`, optional `agent` override (shallow merge) |
| `agent`              | required      | `image`, `command`, `envFrom` (env var names passed to the agent), `timeoutMinutes`                                       |
| `template`           | as above      | placeholders `{title}`, `{description}`, `{comments}`                                                                     |

Invalid config stops the daemon at start with a message naming the field.

### Secrets

Read from the environment only, never from `config.json`:

- `LINEAR_API_KEY` (required): personal API key.
- `GITHUB_TOKEN` (required): push token, used only by `publishToGitHub` on the host.
- `CLONE_TOKEN` (optional): read-only token for cloning private repos inside the sandbox.
- Every name in `agent.envFrom` (for example `ANTHROPIC_API_KEY`). `envFrom` may not name
  `LINEAR_API_KEY`, `GITHUB_TOKEN` or `CLONE_TOKEN`; config validation refuses them, so they never
  reach the sandbox.

`autoforge serve` reads `~/.autoforge/env` (`KEY=value` lines) itself with `util.parseEnv`, after
checking its mode; values already in the process environment win. The file is never executed by a
shell. The daemon refuses to start if that file exists and is readable or writable by group or
others (mode must be `600`).

## 4. Routing and task text

### Routing (`route.ts`)

Applied in order; first match wins:

1. A label on the issue named `repo:owner/name` or `repo:owner/name@branch`.
2. A rule whose `linearProject` matches the issue's project (by name or id).
3. A rule whose `linearTeam` matches the issue's team (by key or name).
4. `defaultRepo`.
5. No match: the daemon comments "No repo configured for this issue. Add a `repo:owner/name`
   label or a rule in config." and does not queue it. It does not comment again unless the issue's
   labels change.

`owner/name` must match `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`; the branch must not start with `-`.
Invalid labels are treated as no match.

### Task text (`prompt.ts`)

The template is rendered with:

- `{title}`, `{description}` (empty string if none).
- `{comments}`: the issue's comments oldest first, each as `<author>: <body>`, excluding comments
  posted by the daemon (identified by a marker, see section 5) and command comments (body starting
  with `/publish`, `/discard`, `/retry`). With `"comments": "mine"`, only the viewer's comments.
- For `/retry <feedback>`, the rendered template is followed by
  `\n\nFeedback from the reviewer on the previous attempt:\n<feedback>`.

Placeholder substitution uses function replacement, so `$` sequences in issue text stay literal.

## 5. Lifecycle

### States (per issue)

```
queued -> running -> awaiting_approval -> publishing -> published
                  -> no_changes | failed | timed_out
awaiting_approval -> discarded            (/discard or expiry)
awaiting_approval | no_changes | failed | timed_out --/retry--> queued
```

`published` and `discarded` are terminal for that issue until the label is removed and added
again, which starts over.

### Pickup

Each poll fetches issues assigned to the viewer updated since the cursor. An issue is eligible when
it is assigned to the viewer, matches `pickup`, is not in a completed or canceled workflow state,
and has no active entry in state. Eligible issues are routed; routed issues are queued.

### Comments the daemon posts

Every daemon comment starts with a hidden marker line `<!-- autoforge -->` so it can be filtered
from `{comments}` and never mistaken for a command.

1. Queued: "Queued for autoforge (position N)." The issue moves to its team's first "started" state
   when its run starts.
2. Running: "Running on `owner/name@branch` in a sandbox."
3. Result:
   - changed: status, files changed, diffstat, the first 80 lines of the patch in a code block
     (masked with the run's secrets), and the available commands. If the patch contains one of the
     user's secrets, the comment adds "Warning: this patch contains one of your secrets and cannot
     be published."
   - no_changes / failed / timed_out: the reason and `/retry <feedback>`.
4. Published: "Draft PR opened: <url>", plus the PR attached to the issue as a link.
5. Discarded / expired / dropped / aborted: one line saying so.

### Commands

A comment is a command only when all hold:

- its author id (from the API) equals the viewer id,
- it was created after the latest daemon comment that carries the command gate: the Queued
  comment (including "Queued for autoforge again") and the result comment. Other daemon comments
  do not move the gate,
- its id has not been handled before (handled ids are kept in state),
- its body, trimmed, starts with `/publish`, `/publish force`, `/discard` or `/retry`.

| Command             | Valid in                                                 | Effect                                                                       |
| :------------------ | :------------------------------------------------------- | :--------------------------------------------------------------------------- |
| `/publish`          | `awaiting_approval`                                      | `publishToGitHub(result, { repo, token: GITHUB_TOKEN, base, body, signal })` |
| `/publish force`    | `awaiting_approval`                                      | same with `force: true`                                                      |
| `/discard`          | `awaiting_approval`                                      | state `discarded`, patch file deleted                                        |
| `/retry <feedback>` | `awaiting_approval`, `no_changes`, `failed`, `timed_out` | new run queued with feedback                                                 |

A valid command in the wrong state gets a one-line reply explaining why it did nothing.

Publishing rules:

- The PR title is the first line of the task (the issue title with the default template). The PR
  body is only `<identifier>: <title>`, a blank line and "Opened by autoforge from Linear issue
  <identifier>."; the description, comments and `/retry` feedback never leave Linear.
- A patch that contains one of the user's secrets (the values the daemon masks) is never published:
  `/publish` fails with `invalid_result` and suggests `/retry` or `/discard`; nothing is pushed.
- A publish that takes longer than 5 minutes is aborted and reported like any publish failure.
- After `github_api_error` (the branch was pushed) or an aborted publish, the reply says to check
  GitHub for an existing branch or pull request first, then `/publish force`. A missing patch
  (`invalid_result`) suggests `/retry` or `/discard`.

### Changes under the daemon

- Unassigned, or (in `labelled` mode) label removed, while `queued`: removed from the queue,
  comment.
- Same while `running`: the run is aborted through its `AbortSignal`, comment.
- `awaiting_approval` older than `approvalExpiryDays`: `discarded`, comment.

### Restarts

On start, any issue in `running` or `publishing` is handled:

- `running`: re-queued once with a comment. A second interruption marks it `failed`. A clean stop
  (Ctrl-C, `service uninstall`, logout) while a run is in flight counts as an interruption too,
  unless the run had already finished: a finished run keeps its result.
- `publishing`: back to `awaiting_approval` with a comment saying the pull request may or may not
  have been opened, asking the user to check GitHub for an existing branch or pull request first and
  then reply `/publish force`.

If saving a finished run fails (for example the patch cannot be written), the issue becomes
`failed` with a comment and `/retry`, never stuck in `running`.

### Single instance

Only one daemon may use a state directory. Before the daemon starts, `autoforge serve` writes its
pid to a temp file in the state directory and hard-links it to `<dir>/serve.lock`, so a lock made
this way is never empty. If the lock exists:

- empty, unreadable or a dangling symlink (hand-written, or left by a version before the link-based
  create): retry every 50 ms, and after 40 tries exit asking the user to delete it if no daemon is
  running.
- a live pid other than its own: exit with "autoforge serve is already running (pid N)."
- a dead pid, or its own pid (reused from a dead daemon): stale. Rename it aside (only one starter
  can), check the moved file still holds that pid, delete it and retry. If it holds another pid, a
  racer's fresh lock was moved: link it back and retry, which then refuses.

After taking the lock, serve waits 250 ms and reads it again before touching any state; if it no
longer holds its pid (a racer displaced it), it exits with the "already running" message, or with
"autoforge serve could not keep serve.lock (another instance started at the same time)." if the
lock is gone. A signal during that wait exits cleanly and releases the lock. Each loop
iteration checks the lock again before polling; if it no longer holds the daemon's pid, the daemon
logs "lost serve.lock; another instance took over", stops the status server and the daemon, and
exits 1. On shutdown the lock is removed only if it still holds the daemon's pid, and `status.json`
only if its `pid` is the daemon's. A pid reused after a reboot by another process makes a dead
daemon's lock look live; delete `serve.lock` by hand.

## 6. State

`~/.autoforge/state.json`, written atomically (write to a temp file in the same directory, `fsync`,
rename). Shape:

```ts
type State = {
  version: 1;
  viewerId: string;
  cursor: string; // ISO time; advanced only after a successful poll
  dailyRuns: { date: string; count: number };
  issues: Record<string, IssueEntry>; // keyed by Linear issue id
  noRoute: Record<string, string>; // issue id -> sorted labels when "No repo configured" was posted
  outbox: { issueId: string; body: string; gate: boolean; attempts: number }[]; // pending comments
};

type IssueEntry = {
  identifier: string; // e.g. "ENG-123"
  status:
    | "queued"
    | "running"
    | "awaiting_approval"
    | "publishing"
    | "published"
    | "no_changes"
    | "failed"
    | "timed_out"
    | "discarded";
  repo: string;
  ref: string;
  feedback?: string;
  interruptions: number;
  lastResultCommentAt?: string;
  handledCommentIds: string[];
  run?: Omit<RunResult, "patch" | "logs">; // from slice 1; patch stored separately
  prUrl?: string;
  queuedAt: string; // when the issue last joined the queue; the queue runs oldest first
  waiting?: "docker" | "limit"; // a "waiting" comment was already posted while queued
  updatedAt: string;
};
```

- Every daemon comment goes through the outbox: it is saved in state before the HTTP call, sent in
  order per issue, and dropped (logged with the issue identifier) after 100 failed attempts.
- `run.message` is masked before it is stored.

- Patches: `~/.autoforge/patches/<runId>.patch`, mode `600`. Logs: tail kept only in memory and in
  the daemon log.
- `state.json` contains no secrets.
- Invalid state (unparseable or wrong shape): renamed to `state.json.corrupt-<timestamp>`, a
  fresh state is started, and an error is logged. Any other read error stops the daemon, and the
  service manager restarts it. Re-picked issues do not re-run commands, because commands are
  only accepted after the latest daemon result comment, and a fresh run posts a new one.

## 7. Status endpoint (`status.ts`)

For the future menu-bar app and `autoforge status`.

- Listens on `127.0.0.1` only, on a random free port written to `~/.autoforge/status.json` together
  with a random 32-byte token (file mode `600`).
- Every request needs `Authorization: Bearer <token>`; otherwise 401.
- Any request carrying an `Origin` header gets 403 (blocks browser pages, CSRF).
- `GET /runs`: issues in state with status, repo, timestamps, PR url (no patch, no logs).
- `GET /runs/:issueId/patch`: the stored patch as text.
- `POST /runs/:issueId/publish` and `POST /runs/:issueId/discard`: same effect as the Linear
  commands, same state checks; the daemon also posts the matching comment on the issue.

## 8. Security model

- **Trusted:** config, the env file, Linear API metadata about authors.
- **Untrusted:** issue title, description and comments. Anyone in the workspace can edit them, so
  they can steer the agent (prompt injection). Mitigations: the agent only runs inside the slice 1
  sandbox with no push token; nothing is published without the user's command; the default template
  labels comments as coming from participants; `"comments": "mine"` limits them to the user's own.
- **Commands** are accepted only from the viewer's API author id. Command text inside descriptions
  or other people's comments does nothing.
- **Secrets** stay in the environment; the env file must be mode `600`; nothing posted to Linear
  contains them (masked like slice 1 logs).
- **Routing** is untrusted: anyone in the workspace can add a `repo:` label, so they can choose
  which configured-token repo a run clones. Publishing still needs the user's own `/publish`.
- **What reaches GitHub:** the patch, a PR title from the task's first line and a body with only the
  issue identifier and title. A patch containing a secret is refused.
- **Spend:** `dailyRunLimit` bounds runs per day; over the limit, issues stay queued with a comment.
- The CI-on-push caveat from slice 1 applies: `/publish` pushes a branch, which can trigger
  `on: push` workflows.

## 9. Failure handling

| Failure                                     | Behaviour                                                                                                    |
| :------------------------------------------ | :----------------------------------------------------------------------------------------------------------- |
| Linear API error, network error, rate limit | Exponential backoff (5 s doubling, max 5 min), honour `Retry-After`; cursor not advanced                     |
| Docker unavailable (`sandbox_unavailable`)  | Queue paused; one "waiting for Docker" comment per affected issue; retried every poll; resumes automatically |
| Run fails / times out / no changes          | Result comment with reason; `/retry` available                                                               |
| Publish fails                               | Comment with the `PublishError` code and message; back to `awaiting_approval`; hints as in section 5         |
| Daemon crash                                | launchd / systemd restarts it; restart rules in section 5                                                    |
| Corrupt state                               | Section 6                                                                                                    |
| Invalid config or env file permissions      | Refuse to start with a clear message                                                                         |

Logs are one JSON object per line on stdout (`time`, `level`, `issue`, `event`, `message`), masked.
The service unit redirects them to `~/.autoforge/daemon.log`.

## 10. Service install (`service.ts`)

- macOS: writes `~/Library/LaunchAgents/dev.autoforge.serve.plist` (`RunAtLoad`, `KeepAlive`,
  stdout and stderr to `~/.autoforge/daemon.log`, `PATH` captured from the installing shell so
  `docker` and `git` resolve), then `launchctl bootstrap gui/<uid>`. Secrets are not in the plist;
  `autoforge serve` reads `~/.autoforge/env` itself.
- Linux: writes `~/.config/systemd/user/autoforge.service` (`Environment=PATH=<installer PATH>`,
  `Restart=on-failure`; no `EnvironmentFile`, the daemon reads `~/.autoforge/env` itself), then `systemctl --user daemon-reload` and `enable --now`.
- `uninstall` stops and removes the unit. Neither command touches `~/.autoforge` data.
- The unit text is produced by pure functions so it can be tested without installing.

## 11. Testing

Tests first; no real Linear, no real LLM.

- `route.ts`, `prompt.ts`: table tests (precedence, invalid labels, template rendering, comment
  filtering, `$` sequences, feedback suffix).
- `linear.ts`: stubbed `fetch` with recorded GraphQL responses (pagination, errors, `Retry-After`).
- `daemon.ts`: in-memory fake `LinearApi`; deterministic `tick()` and an injected clock; the real
  slice 1 `run()` with the test-only temp-dir sandbox and a local bare repo; the real
  `publishToGitHub` with a stubbed GitHub API. Scenarios: happy path; `/retry` with feedback;
  `/discard`; command from another user ignored; duplicate command handled once; wrong-state command
  reply; unassigned while queued and while running; expiry; daily limit; Docker unavailable pause
  and resume; publish failure keeps `awaiting_approval`; restart in `running` (once, then failed)
  and in `publishing`; corrupt state; secret in the patch refused; PR body content; publish
  timeout; a run finished during stop keeps its result; a failed result save marks the run failed.
- `cli.ts`: a second instance refused by a live lock; a stale lock replaced.
- `status.ts`: real server on a random localhost port: 401 without token, 403 with `Origin`,
  `GET /runs`, publish and discard.
- `service.ts`: rendered plist and unit text.
- `config.ts`: validation errors; refusal when `~/.autoforge/env` is not mode `600`.
- Manual before merge: a real Linear test team and a throwaway repo through the whole flow, with
  `docs/serve-manual-checklist.md` in the PR.

## 12. Out of scope

The menu-bar app (slice 3), Jira, GitLab, Linear webhooks, several users sharing one daemon, issue
attachments and images, and `/retry` that builds on the previous patch.
