# autoforge

Run any coding agent in a local sandbox and turn its work into a pull request.

autoforge is an open-source, local-first take on cloud agent platforms. You bring the agent
(Claude Code, Aider, OpenHands, a script) and your own API keys. autoforge clones the repo into
a Docker container, runs the agent, and hands you the diff. You decide whether it becomes a PR.

## Install

```bash
pnpm add autoforge
```

Requires Node 22+, git, and Docker running locally (Docker Desktop, OrbStack or Colima).

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

| status       | meaning                                                                                             |
| :----------- | :-------------------------------------------------------------------------------------------------- |
| `changed`    | The agent changed files. `patch` holds the diff against `baseSha`.                                  |
| `no_changes` | The agent finished without changing anything.                                                       |
| `timed_out`  | The timeout (default 30 minutes) stopped the agent. Any partial patch is kept for inspection.       |
| `failed`     | See `reason`: `aborted`, `clone_failed`, `sandbox_unavailable`, `sandbox_error`, `patch_too_large`. |

`run()` never throws for these. It only throws `TypeError` for invalid options.

## Security model

- **The push token never enters the sandbox.** `publishToGitHub` runs on your machine and
  applies the patch there.
- **The clone token** is passed to git through environment variables, never on a command line
  or written to disk in the sandbox. Use a read-only, fine-grained token for private repos.
- **publishToGitHub treats the run result as untrusted input from the sandbox:** it validates
  `baseSha` and applies the patch with git on your machine.
- **Sandbox defaults:** no host folders mounted, non-root user, 2 CPUs and 4 GB memory, network
  on (agents need their model API). Use `network: "none"` for offline agents.
- **Known limit:** the agent can read the env values you pass it (such as model API keys) and
  has network access, so a malicious task could try to send them somewhere. The sandbox protects
  your machine and your repo credentials, not the model key. Use scoped or spend-limited keys,
  and review every PR before merging.
- Env values (4+ characters) and tokens are masked as `***` in events and logs.

## Custom sandboxes

Implement `Sandbox` from `autoforge` to run sessions somewhere else (E2B, Daytona, a VM).
Throw `SandboxUnavailableError` from `create()` when the backend is not running.

## Roadmap

Next: `autoforge serve`, a local daemon that picks up Linear issues assigned to you, runs them,
and links the PR back on the issue.

## Licence

MIT
