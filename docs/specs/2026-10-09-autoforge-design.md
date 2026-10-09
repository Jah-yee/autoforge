# autoforge: design spec (slice 1, the SDK)

Date: 2026-10-09
Status: draft, awaiting review

## 1. Goal

autoforge is an open-source, local-first take on what Factory (factory.com) does in the cloud:
hand a coding task to an agent, let it work in an isolated sandbox, and get back a reviewable
pull request. Everything runs on the user's own machine with their own agent and their own
model API keys. There is no autoforge server or account.

The project ships in slices. Each slice gets its own spec, plan and implementation.

| Slice | What it is                                                                                                                                                                                                   | Status          |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------- |
| 1     | `autoforge` TypeScript SDK: run an agent in a local sandbox, return a diff, optionally publish it as a GitHub PR                                                                                             | this spec       |
| 2     | `autoforge serve`: a local CLI daemon built on the SDK. Polls Linear for issues assigned to the user, runs them, posts progress back, opens the PR (optional terminal approval first), links it on the issue | next spec       |
| later | Jira poller, persistent sandboxes, menu-bar UI, multi-step missions, GitLab                                                                                                                                  | not planned yet |

### Success criteria for slice 1

- A developer can `pnpm add autoforge`, call `run()` with a repo, a task and an agent command,
  and get back a result object containing the patch, without writing any sandbox or git code.
- Calling `publishToGitHub(result, ...)` turns that result into a draft PR.
- The push token never enters the sandbox.
- Works on macOS and Linux with Docker running locally (Docker Desktop, OrbStack or Colima).

### Decisions already made

| Decision | Choice                                                                                                              |
| :------- | :------------------------------------------------------------------------------------------------------------------ |
| Form     | Embeddable library (SDK) that any dev tool can import                                                               |
| Language | TypeScript, ESM only, Node 22+                                                                                      |
| Sandbox  | Pluggable `Sandbox` interface; Docker implementation ships first                                                    |
| Agent    | Bring your own: the host supplies a command. No agent adapters ship                                                 |
| Output   | Plain serializable result; separate opt-in GitHub publisher                                                         |
| Approval | Two stateless calls. Approval is the host deciding whether to call `publishToGitHub`                                |
| Licence  | MIT                                                                                                                 |
| Hosting  | Local repo at `~/dev/autoforge`; GitHub remote on the owner's personal account, created only when the owner says so |

## 2. Package layout and public API

One npm package with subpath exports:

```
autoforge            run(), types
autoforge/docker     DockerSandbox
autoforge/github     publishToGitHub(), PublishError
```

If the unscoped `autoforge` name cannot be claimed on npm, fall back to a scoped name
(`@<owner>/autoforge`). The API does not change.

### `run(options): Promise<RunResult>`

```ts
const result = await run({
  repo:    { url, ref, token? },     // token only used for the clone
  task:    "Fix the login redirect",
  agent:   { command: ["claude", "-p", "{task}"], env: { ANTHROPIC_API_KEY } },
  sandbox: new DockerSandbox({ image: "node:22" }),
  timeoutMs: 30 * 60_000,            // default 30 minutes
  maxLogBytes: 1_000_000,            // default 1 MB, keeps the tail
  maxPatchBytes: 10_000_000,         // default 10 MB
  signal,                            // optional AbortSignal
  onEvent: (e) => {},                // optional
});
```

### `RunResult`

Plain JSON. Safe to store in any database or file.

```ts
type RunResult = {
  id: string; // random, used for branch names
  status: "changed" | "no_changes" | "failed" | "timed_out";
  reason?:
    | "aborted"
    | "clone_failed"
    | "sandbox_unavailable"
    | "sandbox_error"
    | "patch_too_large"
    | "unsupported_encoding";
  message?: string; // human-readable detail when failed
  repo: { url: string; ref: string }; // never contains the token
  task: string;
  baseSha?: string; // absent if the clone failed
  patch: string; // the diff; also kept on "timed_out" for inspection; empty otherwise
  filesChanged: string[];
  logs: string; // redacted, tail-truncated
  exitCode: number | null; // null if the agent never ran or was killed
  startedAt: string; // ISO 8601
  durationMs: number;
};
```

### `RunEvent`

```ts
type RunEvent =
  | { type: "phase"; phase: "creating_sandbox" | "cloning" | "running" | "collecting" | "done" }
  | { type: "log"; stream: "stdout" | "stderr"; line: string }; // redacted
```

### `Sandbox` interface

Hosts can implement this to use E2B, Daytona, a VM, or anything else.

```ts
interface Sandbox {
  create(opts?: { signal?: AbortSignal }): Promise<SandboxSession>;
}

interface SandboxSession {
  readonly workdir: string; // where the repo is cloned; "/workspace" for Docker
  exec(
    cmd: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): Promise<{ exitCode: number | null }>;
  writeFile(path: string, content: string): Promise<void>;
  destroy(): Promise<void>;
}
```

`exec` takes an argv array, never a shell string. `workdir` lets a sandbox choose where the
repo lives (Docker uses `/workspace`; the test-only temp-dir sandbox uses a host temp path).
Throw `SandboxUnavailableError` (exported) from `create()` when the backend is not running.
`run()` passes its combined signal (timeout plus caller signal) to `create()`; a sandbox should
stop creating, clean up anything half made, and reject when it fires.

### `DockerSandbox` options

```ts
new DockerSandbox({
  image: "node:22", // must contain git
  cpus: 2, // default 2
  memory: "4g", // default 4g
  network: "bridge", // or "none"
  user: "1000:1000", // default non-root
});
```

Driven through the `docker` CLI via `child_process`. No runtime dependencies.
One container per run: `docker run -d` with `sleep infinity`, `docker exec` for each command,
`docker rm -f` on destroy. No host folders are mounted. Every container also gets these fixed
flags (not options):

- `--pids-limit 4096`, so a fork bomb cannot exhaust the host.
- `--security-opt no-new-privileges` and `--cap-drop ALL --cap-add CHOWN`. The one root step,
  `docker exec -u 0` that creates `/workspace` and chowns it to `user`, needs `CAP_CHOWN`.
  Everything else runs as `user`; as the default non-root user it has no effective
  capabilities, and no-new-privileges means setuid binaries and file capabilities cannot raise
  them. A root `user` would keep `CAP_CHOWN`.
- `--pull never` and `--name autoforge-<uuid>`, so cleanup after an abort can always find the
  container by name.

`create()` passes its signal to `docker info`, `docker image inspect` and, when the image is
missing, `docker pull`. Those are the slow, abortable steps. `docker run --pull never` is a
fast local step and runs without the signal, so a killed client cannot leave the daemon
creating a container after cleanup. If the signal fired meanwhile, `create()` runs
`docker rm -f` on the name and rejects.

### Agent

The agent is a command plus environment variables. The SDK ships no agent adapters.
`examples/basic.ts` shows Claude Code in headless mode as the agent.

## 3. How a run works

`run()` performs these steps in order. The sandbox is destroyed in `finally` on every path.

1. **Create the sandbox.** If Docker is not available, return `failed` / `sandbox_unavailable`
   with a message telling the user to start Docker. Creation gets the run's signal; if
   `create()` rejects after the signal fired, the run returns `timed_out` or `failed` /
   `aborted` like any other stop, not `sandbox_error`.
2. **Clone and check out.** Clone `repo.url` into `/workspace`, check out `repo.ref`, record
   `baseSha = git rev-parse HEAD`. If `repo.token` is set, the auth header is passed to git
   through the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment variables
   on the clone command only, so it never appears in a process list, is never written to
   `.git/config`, and is never visible to the agent. Clone failure returns
   `failed` / `clone_failed`.
3. **Write the task.** Write the task to `/workspace/.autoforge/task.md` and add `.autoforge/`
   to `/workspace/.git/info/exclude` so it never appears in the diff.
4. **Run the agent.** Execute `agent.command` in `/workspace`.
   - Every argv entry equal to `{task}` is replaced by the task text as a single argument.
     No shell is involved, so task text cannot inject commands. `{task}` inside a larger
     string is also replaced, still as part of that one argument.
   - The environment is `agent.env` plus `AUTOFORGE_TASK` (the task text) and
     `AUTOFORGE_TASK_FILE` (`/workspace/.autoforge/task.md`).
   - stdout and stderr are split into lines, redacted, emitted as `log` events, and appended
     to the log buffer.
5. **Collect.** Run `git add -A` then `git diff --cached --binary --no-ext-diff --no-textconv
--src-prefix=a/ --dst-prefix=b/ --no-relative <baseSha>` inside the sandbox. This captures
   the agent's work whether it committed or not.
   - The agent owns `.git/config`, so every collect command runs as
     `git -c core.fsmonitor=false -c core.hooksPath=/dev/null ...` and both diffs pass
     `--no-ext-diff --no-textconv`; nothing in the repo config can run a command.
   - Both diffs also pin `--src-prefix=a/ --dst-prefix=b/ --no-relative`, so `diff.noprefix`,
     `diff.mnemonicPrefix` or `diff.relative` in the agent's config cannot change the patch
     format that `git apply` on the host expects.
   - Collect has its own deadline: the time left on the run, capped at 5 minutes, at least
     the smaller of the run timeout and 30 seconds. If it fires: `failed` / `sandbox_error` ("collecting the changes timed out").
   - Empty diff: `no_changes`.
   - Non-empty diff: `changed`, even if the agent exited non-zero. `exitCode` lets the host judge.
   - Diff larger than `maxPatchBytes`: `failed` / `patch_too_large`, patch emptied.
   - Diff containing U+FFFD (text that was not UTF-8): `failed` / `unsupported_encoding`, patch
     emptied. A file that really contains U+FFFD is a known false positive.
   - `filesChanged` comes from `git diff --cached --name-only -z <baseSha>` (same flags as
     above), split on NUL.
6. **Destroy the sandbox.**

### Early termination

| Cause                  | Result                                                                                                                    |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `timeoutMs` reached    | Agent process killed, `timed_out`. Patch is still collected for inspection, but `publishToGitHub` only accepts `changed`. |
| `signal` aborted       | Agent process (or sandbox creation) stopped, `failed` / `aborted`. No patch.                                              |
| Sandbox or clone error | `failed` with a reason and message                                                                                        |

Expected failures are returned in the result, never thrown. `run()` only throws on programmer
errors (invalid options), so hosts can store every run the same way. `repo.url` and `repo.ref`
starting with `-` are rejected as invalid options, because git would read them as flags.

### Redaction and limits

- Every non-empty value in `agent.env` and `repo.token` is replaced by `***` in log events
  and in `result.logs`. Values shorter than 4 characters are not redacted (too many false hits).
- `result.logs` keeps the last `maxLogBytes` bytes, prefixed with a `[truncated]` marker.

## 4. Publishing and security

### `publishToGitHub(result, options): Promise<{ prUrl, branch, commitSha }>`

```ts
await publishToGitHub(result, {
  repo: "owner/name",
  token, // needs contents:write and pull_requests:write
  base, // default result.repo.ref
  branch, // default `autoforge/<task-slug>-<result.id first 8 chars>`
  title, // default first line of the task, max 72 chars
  body, // default task text plus a short autoforge footer
  draft: true, // default true
  author: { name, email }, // default "autoforge" <autoforge@users.noreply.github.com>
  force: false, // overwrite an existing branch
  gitUrl, // default https://github.com/<repo>.git (GitHub Enterprise, tests)
  apiUrl, // default https://api.github.com
  fetch, // optional, injectable for tests
  signal, // optional AbortSignal: stops git commands and the API request
});
```

Runs on the host, not in the sandbox:

1. Refuse unless `result.status === "changed"` (throws `PublishError` code `nothing_to_publish`).
   1b. Reject a `baseSha` that is not a 40 or 64 character hex sha (the result comes from the
   sandbox and is untrusted): `PublishError` code `invalid_result`.
2. Create a temp dir, `git init`, fetch `result.baseSha` from the repo with the token passed to
   git through the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment
   variables, check it out.
3. `git apply --binary` the patch, commit as `author`.
4. Push to `branch`. If the branch exists and `force` is false, throw `PublishError` code
   `branch_exists`.
5. Open the PR with `POST /repos/{owner}/{repo}/pulls` using `fetch`.
6. Delete the temp dir in `finally`.

Because the patch is applied to the exact commit the agent started from, it always applies.
If `base` has moved on, GitHub shows any conflicts on the PR as usual.

`PublishError` has a `code`: `nothing_to_publish`, `invalid_result`, `fetch_failed`,
`apply_failed`, `branch_exists`, `push_failed`, `github_api_error`, `aborted`. Publishing throws
because it is a single host-triggered action. `signal` is passed to every git command and to
`fetch`; once it fires, publishing throws code `aborted` (the message says so if the branch was
already pushed).

### Security model (also written into the README)

- **The push token never enters the sandbox.** Only the host process holds it. This is the main
  difference from Factory, where the agent itself opens the PR.
- **The clone token** is never written to disk inside the sandbox. For private repos, recommend
  a read-only fine-grained token.
- **Sandbox defaults:** no host mounts, non-root user, 2 CPU, 4 GB memory, 4096 processes,
  all capabilities dropped except `CAP_CHOWN` in the bounding set (the agent, as the default
  non-root user, has none effective), `no-new-privileges`, network on (agents need their model API), `network: "none"` available. The bridge network
  can reach the host (`host.docker.internal` on Docker Desktop), the LAN and cloud metadata
  endpoints; recommend `network: "none"` when the agent does not need the internet.
- **Known limit:** the agent sees the API keys passed in `agent.env` and has network access, so
  a malicious task could try to exfiltrate them. The sandbox protects the user's machine and
  repo credentials, not the model key. Guidance: use scoped or spend-limited keys.
- **Review the patch before publishing.** Pushing a branch can trigger `on: push` CI with repo
  secrets on agent-written code before anyone reviews a PR. A push token without the
  `workflows` permission cannot push `.github/workflows` changes. The decision to publish is
  the main safety gate.

## 5. Testing

Tests are written before the implementation and must fail first. No real LLM in any test.

- **Unit tests** use a test-only `TempDirSandbox` (runs commands in a temp dir on the host).
  It is not exported.
- **Fake agent:** a shell script driven by arguments that can edit, add and delete files,
  commit, sleep, exit non-zero, or flood output. It covers every status, timeout, abort,
  log truncation, patch size limit and redaction.
- **Clone tests** use a local bare git repo. No network.
- **Docker integration tests** run the same scenarios through `DockerSandbox`. Skipped locally
  when Docker is not running; always run in CI.
- **Publish tests** use a local bare repo as the push remote and an injected `fetch` that
  records the PR request.
- **Security tests:** token absent from `/workspace/.git/config` after clone; `{task}` set to
  `; rm -rf /` arrives as one literal argument; secrets never appear in events or `logs`.

## 6. Repository setup

```
~/dev/autoforge
  src/
    index.ts        run(), types
    run.ts
    sandbox.ts      Sandbox interfaces
    docker.ts       DockerSandbox
    github.ts       publishToGitHub, PublishError
    redact.ts
  test/
    fixtures/fake-agent.sh
    ...
  examples/basic.ts
  docs/specs/
  README.md  CONTRIBUTING.md  LICENSE (MIT)
  .github/workflows/ci.yml
```

- pnpm, Vitest, plain `tsc` build, ESLint and Prettier.
- Zero runtime dependencies.
- CI: lint, typecheck, unit and Docker tests on Linux. The workflow has top-level
  `permissions: contents: read`, and every action is pinned to a full commit SHA with a
  `# vX.Y.Z` comment.
- Stays local: no GitHub remote and no npm publish until the owner asks.

## 7. Out of scope for slice 1

Ticket connectors (Linear, Jira), the `autoforge serve` daemon (slice 2), GitLab and Bitbucket
publishing, persistent or reusable sandboxes, queues and retries, a run store, and any UI.
