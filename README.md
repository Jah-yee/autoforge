# autoforge

Run any coding agent in a local sandbox and turn its work into a pull request.

autoforge is an open-source, local-first take on cloud agent platforms. You bring the agent
(Claude Code, Aider, OpenHands, a script) and your own API keys. autoforge clones the repo into
a Docker container, runs the agent, and hands you the diff. You decide whether it becomes a PR.

## Install

```bash
pnpm add autoforge
```

Requires Node 22+, git 2.31+ on the host, and Docker running locally (Docker Desktop, OrbStack
or Colima). The sandbox image needs git 2.31+ and `sh`.

## Use

```ts
import { run } from "autoforge";
import { DockerSandbox } from "autoforge/docker";
import { publishToGitHub } from "autoforge/github";

const result = await run({
  repo: { url: "https://github.com/me/app.git", ref: "main" },
  task: "Fix the login redirect",
  agent: { command: ["claude", "-p", "{task}"], env: { ANTHROPIC_API_KEY: key } },
  sandbox: new DockerSandbox({ image: "my-agent-image" }),
});

// result is plain JSON: store it, show the diff, ask a human.
if (result.status === "changed") {
  const { prUrl } = await publishToGitHub(result, { repo: "me/app", token });
}
```

`{task}` in the command is replaced by the task text as a single argument (no shell). The task
is also in `AUTOFORGE_TASK` and in the file named by `AUTOFORGE_TASK_FILE`.

See `examples/basic.ts` for a complete Claude Code example.

## Results

| status       | meaning                                                                                                                                                            |
| :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`    | The agent changed files. `patch` holds the diff against `baseSha`.                                                                                                 |
| `no_changes` | The agent finished without changing anything.                                                                                                                      |
| `timed_out`  | The timeout (default 30 minutes) stopped the agent. Any partial patch is kept for inspection.                                                                      |
| `failed`     | See `reason`: `aborted`, `clone_failed`, `sandbox_unavailable`, `sandbox_error`, `patch_too_large`, `unsupported_encoding` (the patch has text that is not UTF-8). |

`run()` never throws for these. It only throws `TypeError` for invalid options.

## Cancellation

Pass `signal` (an `AbortSignal`) to `run()` to stop it at any phase, including sandbox creation
and image pulls. An abort returns `failed` with reason `aborted`; the timeout returns
`timed_out`. Pass `signal` to `publishToGitHub()` to stop its git commands and the API request.

## Publish errors

`publishToGitHub()` throws `PublishError` with a `code`: `nothing_to_publish` (the run is not
`changed`), `invalid_result` (the result fails validation, such as a `baseSha` that is not a
commit sha), `fetch_failed`, `apply_failed`, `branch_exists` (pass `force: true` to overwrite),
`push_failed`, `github_api_error` (the branch was already pushed) or `aborted`.

## Security model

- **The push token never enters the sandbox.** `publishToGitHub` runs on your machine and
  applies the patch there.
- **The clone token** is passed to git through environment variables, never on a command line
  or written to disk in the sandbox. Use a read-only, fine-grained token for private repos.
- **publishToGitHub treats the run result as untrusted input from the sandbox:** it validates
  `baseSha` and applies the patch with git on your machine.
- **Sandbox defaults:** no host folders mounted, non-root user, 2 CPUs, 4 GB memory, at most
  4096 processes, all Linux capabilities dropped and `no-new-privileges`, network on (agents
  need their model API). Only `CAP_CHOWN` stays in the bounding set, for the root step that
  hands `/workspace` to the agent user; the agent, as the default non-root user, has no
  effective capabilities.
- **Network:** the default bridge network can reach your host (`host.docker.internal` on Docker
  Desktop), your LAN and cloud metadata endpoints. Use `network: "none"` when the agent does not
  need the internet.
- **Known limit:** the agent can read the env values you pass it (such as model API keys) and
  has network access, so a malicious task could try to send them somewhere. The sandbox protects
  your machine and your repo credentials, not the model key. Use scoped or spend-limited keys.
- **Review the patch before calling publishToGitHub.** Pushing a branch can trigger `on: push`
  CI with repo secrets on agent-written code before anyone reviews a PR. A push token without
  the `workflows` permission cannot push `.github/workflows` changes.
- Env values (4+ characters) and tokens are masked as `***` in events and logs.

## autoforge serve: assign a Linear issue, get a PR

`autoforge serve` is a local daemon. It watches Linear for issues assigned to you and labelled
`autoforge`, runs each one in the Docker sandbox, posts the result on the issue, and opens a
draft PR when you reply `/publish`.

### Set up

Until autoforge is on npm, get the `autoforge` command from a clone of this repo:
`pnpm install && pnpm build && npm link`.

1. Build an agent image, for example `docker build -t autoforge-claude examples`.
2. Create `~/.autoforge/config.json`:

   ```json
   {
     "defaultRepo": "me/app@main",
     "rules": [{ "linearTeam": "DOCS", "repo": "me/docs" }],
     "agent": {
       "image": "autoforge-claude",
       "command": ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
       "envFrom": ["ANTHROPIC_API_KEY"]
     }
   }
   ```

   Other fields and their defaults: `pollSeconds` 30 (minimum 10), `maxConcurrent` 1,
   `dailyRunLimit` 20, `approvalExpiryDays` 14, `pickup` `"labelled"` (or `"all-assigned"`),
   `label` `"autoforge"`, `comments` `"all"` (or `"mine"`), `agent.timeoutMinutes` 30 and
   `template` (placeholders `{title}`, `{description}`, `{comments}`). Rules take one of
   `linearProject` or `linearTeam`, a `repo`, and an optional `agent` override.

3. Put secrets in `~/.autoforge/env` and run `chmod 600 ~/.autoforge/env`:

   ```
   LINEAR_API_KEY=lin_api_...
   GITHUB_TOKEN=github_pat_...
   ANTHROPIC_API_KEY=sk-ant-...
   ```

   `GITHUB_TOKEN` only pushes from your machine and needs contents and pull requests write.
   `CLONE_TOKEN` (optional, read-only) clones private repos inside the sandbox.
   `agent.envFrom` cannot name `LINEAR_API_KEY`, `GITHUB_TOKEN` or `CLONE_TOKEN`.

4. Run `autoforge serve` in a terminal, or `autoforge service install` to start it at login
   (launchd on macOS, a systemd user unit on Linux; logs go to `~/.autoforge/daemon.log`).
   `autoforge service uninstall` removes the service and leaves `~/.autoforge` alone.
   The service pins the path of the Node binary you installed it with, so run
   `autoforge service install` again after upgrading or switching Node (for example with nvm).

Only one daemon runs per state directory: a second `autoforge serve` on the same `--dir` exits
with "autoforge serve is already running (pid N)." A lock left by a crashed daemon is taken over
automatically. If a daemon ever finds its lock taken by another instance, it logs
"lost serve.lock; another instance took over" and exits. After a reboot a reused pid can make an
old lock look live: if no daemon is running, delete `<dir>/serve.lock`.

### Use

Assign an issue to yourself and add the `autoforge` label. autoforge comments "Queued", moves
the issue to your team's first started state, runs it, and posts a result with the first 80
lines of the patch. Then reply on the issue:

| Reply               | Effect                                               |
| :------------------ | :--------------------------------------------------- |
| `/publish`          | Opens a draft PR and links it on the issue           |
| `/publish force`    | Same, overwriting an existing branch                 |
| `/discard`          | Drops the result                                     |
| `/retry <feedback>` | Runs again with the original task plus your feedback |

Only your own comments count as commands. Results nobody answers are discarded after
`approvalExpiryDays`. To start an issue over, remove the label, wait for the next poll
(`pollSeconds`), then add it again; removing and re-adding it between two polls changes nothing.

The repo comes from a `repo:owner/name` or `repo:owner/name@branch` label, then a project
rule, then a team rule, then `defaultRepo`. Anyone in your workspace can set a `repo:` label,
so treat routing as untrusted: it picks what gets cloned, but publishing still needs your
`/publish`.

`autoforge status` lists the issues the daemon knows about. It talks to a status endpoint on
`127.0.0.1` that needs the token in `~/.autoforge/status.json` and refuses browser requests.

### Security

- Issue text and comments are untrusted: anyone in your workspace can edit them to steer the
  agent. The agent only runs in the sandbox without your push token, and nothing is pushed
  until you reply `/publish`. Use `"comments": "mine"` to keep other people's comments out of
  the task.
- Secrets stay in the environment and `~/.autoforge/env` (refused unless mode `600`). Comments
  and logs mask them as `***`. Patches are stored with mode `600` in `~/.autoforge/patches`.
- `dailyRunLimit` bounds how many runs start per day.
- `/publish` pushes a branch, which can trigger `on: push` CI before anyone reviews the PR.
- The PR title and body contain only the issue identifier and title, never the description,
  comments or `/retry` feedback. A patch that contains one of your secrets is flagged in the
  result comment and cannot be published.

## Custom sandboxes

Implement `Sandbox` from `autoforge` to run sessions somewhere else (E2B, Daytona, a VM).
Throw `SandboxUnavailableError` from `create()` when the backend is not running. `create()`
receives `{ signal }`: stop and clean up when it aborts.

## Roadmap

Next: a menu-bar app on top of the `autoforge serve` status endpoint.

## Licence

MIT
