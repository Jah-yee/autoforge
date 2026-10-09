# autoforge serve (slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `autoforge serve`, a local daemon that watches Linear for issues assigned to the user, runs each through the slice 1 SDK in a sandbox, posts the result on the issue, and opens a draft PR when the user replies `/publish`.

**Architecture:** All new code lives in `src/serve/`, one job per file. The daemon only talks to a `LinearApi` interface and is driven by a deterministic `tick()` (poll, handle commands, schedule runs) plus fire-and-forget run and publish jobs that `idle()` can await. State is one atomic JSON file plus patch files in a state directory; a localhost status endpoint and a launchd/systemd unit wrap it for daily use.

**Tech Stack:** TypeScript 5 (ESM, NodeNext, strict, `noUncheckedIndexedAccess`), Node 22+ built-ins only (`node:http`, `node:util` `parseArgs`/`parseEnv`, `fetch`), Vitest, ESLint, Prettier, pnpm.

**Spec:** `docs/specs/2026-10-09-autoforge-serve-design.md` (binding). Slice 1 spec: `docs/specs/2026-10-09-autoforge-design.md`.

## Global Constraints

- Node `>=22`, ESM only, relative imports use `.js` extensions (NodeNext).
- No new runtime dependencies. `package.json` gains only `"bin": { "autoforge": "./dist/serve/cli.js" }`.
- Secrets come from the environment only: `LINEAR_API_KEY` (required), `GITHUB_TOKEN` (required), `CLONE_TOKEN` (optional), every name in `agent.envFrom`. Never from `config.json`, never written to `state.json`.
- `~/.autoforge/env` is refused when it is readable or writable by group or others (mode must be `600`).
- Patch files, `state.json` and `status.json` are written with mode `600`; the state directory with `700`.
- Every daemon comment starts with the line `<!-- autoforge -->`. Everything posted to Linear and every log line is masked with all secrets.
- Commands are accepted only when the comment author id equals the viewer id, the comment is newer than the issue's latest gating comment, its id was not handled before, and its trimmed body starts with `/publish`, `/publish force`, `/discard` or `/retry`.
- Config defaults: `pollSeconds` 30 (minimum 10), `maxConcurrent` 1, `dailyRunLimit` 20, `approvalExpiryDays` 14, `pickup` `"labelled"`, `label` `"autoforge"`, `comments` `"all"`, `rules` `[]`, agent `envFrom` `[]`, agent `timeoutMinutes` 30.
- Linear backoff: 5 s doubling, max 5 min, `Retry-After` honoured, cursor not advanced on failure.
- Status endpoint: `127.0.0.1` only, random port, 32-byte bearer token, `Origin` header gets 403.
- Child processes that run git get an explicit env (the SDK already does this; the daemon spawns no git itself).
- Tests never call real Linear, real GitHub or a real LLM. Daemon tests use the in-memory `FakeLinear`, an injected clock, the real `run()` with `TempDirSandbox`, local bare repos (`makeBareRepo`) and the real `publishToGitHub` with `gitUrl` = the bare repo and a stub `fetch`. State lives in a temp dir, never `~/.autoforge`.
- No em dashes in prose, comments or messages.
- Before every commit: `pnpm fix && pnpm lint && pnpm typecheck` must pass, then run the task's tests.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings on spec gaps (binding for this plan)

1. **`changedIssues(since, trackedIds)`.** The spec's `changedIssues(since)` filters on "assigned to the viewer", so it can never return an issue that was just unassigned. The method gains a second argument: every issue whose id is in `trackedIds` is returned too, whatever its assignee or `updatedAt`. The daemon tracks queued, running, awaiting-approval and publishing issues, plus finished runs (`no_changes`, `failed`, `timed_out`) for `approvalExpiryDays`.
2. **Comments per issue.** Each issue comes with up to 100 comments, sorted oldest first by the client. The daemon filters new ones itself (handled ids plus the gate time), so "comments created after `since`" is not needed.
3. **`comment()` returns `{ id, createdAt }`.** The gate time (`lastResultCommentAt`) must be Linear's clock, not the local one, to compare with comment `createdAt`.
4. **Gating comments.** "Queued" comments (first pickup and `/retry`) and result comments both move `lastResultCommentAt`. A new entry also marks every existing comment id as handled, so an old `/publish` on an issue never fires.
5. **Cursor.** The cursor advances to the largest `updatedAt` returned by a successful poll (Linear's clock, no skew). A fresh state starts one day back, so issues labelled shortly before the first start are picked up.
6. **"Running" comment and moving to started** happen on the run's `cloning` phase, after the sandbox exists. When Docker is down nothing says "Running", and the daily count is refunded.
7. **Routing happens at pickup and again at run start** (labels may change while queued). A label match uses the base `agent`; a rule match shallow-merges its `agent`.
8. **Pickup loss in other states.** Unassigned, label removed or closed: `queued` is dropped with a comment, `running` is aborted with a comment, `publishing` finishes. `awaiting_approval`, `no_changes`, `failed`, `timed_out`, `published` and `discarded` entries are forgotten silently (patch deleted) when the issue is unassigned or loses the label, which is how "remove and re-add the label starts over" works. Closed but still labelled and assigned: kept.
9. **Comment outbox.** A comment that fails to post is stored in `state.outbox` and retried at the start of each tick (dropped after 100 attempts), so a Linear blip never loses a result. State gains `noRoute` (labels at the "no repo" comment) and `outbox`; `IssueEntry` gains `queuedAt` (queue order) and `waiting` (dedupes the Docker and daily-limit comments).
10. **The env file is read by `autoforge serve` itself** (`util.parseEnv`, after the mode check), with the process environment taking precedence. The launchd plist therefore needs no shell wrapper and the systemd unit needs no `EnvironmentFile=`. Both units capture the installer's `PATH`, so `docker` and `git` resolve under launchd's minimal PATH.
11. **Status endpoint commands** return 202 on success, 409 on a wrong state (no Linear reply), 404 for an unknown issue. Only `publish` (not `publish force`) and `discard` are exposed, as the spec lists.
12. **Pickup label** compares case-insensitively. Unknown config keys are rejected (catches typos).
13. **Runs start only inside `tick()`**, so the next queued run starts on the next poll after a run finishes.

## Review Focus

1. **A secret ends up in the agent's patch or a failure message** (the agent writes `$ANTHROPIC_API_KEY` into a file): every Linear comment and log line shows `***` instead. Pinned in Task 5 ("masks secrets in the patch excerpt and the logs").
2. **Linear rejects the result comment** (network blip when a 30-minute run ends): the comment is posted on a later tick and `/publish` still works afterwards. Pinned in Task 5 ("retries comments that failed to post").
3. **The rendered task is empty** (template `{description}`, issue without a description): `run()` throws `TypeError`; the daemon must post "could not start the run" and keep going, not crash. Pinned in Task 5 ("reports a run that could not start").
4. **launchd or systemd starts the daemon with a minimal PATH**, so `docker` and `git` are not found: the unit must carry the installer's PATH, with paths containing spaces, `%`, `$` or `&` escaped. Pinned in Task 9.
5. **A status request names an issue id like `__proto__`** or one the daemon never saw: 404, never a crash or a prototype lookup. Pinned in Task 8.

---

## File map

| File                        | Responsibility                                                          |
| :-------------------------- | :---------------------------------------------------------------------- |
| `src/serve/config.ts`       | Parse and validate `config.json`; secrets from env; env file mode check |
| `src/serve/linear.ts`       | Linear types, the `LinearApi` interface, `LinearClient` over `fetch`    |
| `src/serve/route.ts`        | Pure: issue to `{ repo, ref, agent }` or `null`                         |
| `src/serve/prompt.ts`       | Pure: `MARKER`, `parseCommand`, `renderTask`                            |
| `src/serve/state.ts`        | State types, atomic load/save, corrupt-state handling, patch files      |
| `src/serve/daemon.ts`       | `Daemon`: poll, pickup, queue, runs, commands, lifecycle                |
| `src/serve/status.ts`       | Localhost status endpoint                                               |
| `src/serve/service.ts`      | launchd plist / systemd unit rendering, install, uninstall              |
| `src/serve/cli.ts`          | `autoforge serve`, `status`, `service install`, `service uninstall`     |
| `test/serve/fake-linear.ts` | In-memory `LinearApi` for daemon tests                                  |
| `test/serve/harness.ts`     | Daemon test setup: clock, bare repo, stub GitHub, temp state dir        |
| `test/serve/*.test.ts`      | One test file per unit; daemon split into core, commands, lifecycle     |

---

### Task 1: Configuration

**Files:**

- Create: `src/serve/config.ts`
- Test: `test/serve/config.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type AgentConfig = { image: string; command: string[]; envFrom: string[]; timeoutMinutes: number }`
  - `type Rule = { linearProject?: string; linearTeam?: string; repo: string; agent?: Partial<AgentConfig> }`
  - `type Config = { pollSeconds: number; maxConcurrent: number; dailyRunLimit: number; approvalExpiryDays: number; pickup: "labelled" | "all-assigned"; label: string; comments: "all" | "mine"; defaultRepo?: string; rules: Rule[]; agent: AgentConfig; template: string }`
  - `type Secrets = { linearApiKey: string; githubToken: string; cloneToken?: string; agentEnv: Record<string, string> }`
  - `class ConfigError extends Error`
  - `const DEFAULT_TEMPLATE: string`
  - `parseRepoSpec(spec: string): { repo: string; ref: string } | null`
  - `parseConfig(raw: unknown): Config` (throws `ConfigError` naming the field)
  - `loadConfig(dir: string): Promise<Config>` (reads `<dir>/config.json`)
  - `readSecrets(config: Config, env: Record<string, string | undefined>): Secrets`
  - `readEnvFile(dir: string): Promise<Record<string, string | undefined>>` (`{}` when `<dir>/env` is absent)

- [ ] **Step 1: Write the failing test**

`test/serve/config.test.ts`:

```ts
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_TEMPLATE,
  loadConfig,
  parseConfig,
  parseRepoSpec,
  readEnvFile,
  readSecrets,
} from "../../src/serve/config.js";

const minimal = { agent: { image: "autoforge-claude", command: ["claude", "-p", "{task}"] } };

describe("parseConfig", () => {
  it("fills in the defaults", () => {
    expect(parseConfig(minimal)).toEqual({
      pollSeconds: 30,
      maxConcurrent: 1,
      dailyRunLimit: 20,
      approvalExpiryDays: 14,
      pickup: "labelled",
      label: "autoforge",
      comments: "all",
      defaultRepo: undefined,
      rules: [],
      agent: {
        image: "autoforge-claude",
        command: ["claude", "-p", "{task}"],
        envFrom: [],
        timeoutMinutes: 30,
      },
      template: DEFAULT_TEMPLATE,
    });
  });

  it("accepts the full example from the spec", () => {
    const config = parseConfig({
      pollSeconds: 30,
      maxConcurrent: 1,
      dailyRunLimit: 20,
      approvalExpiryDays: 14,
      pickup: "labelled",
      label: "autoforge",
      comments: "all",
      defaultRepo: "me/app@main",
      rules: [
        { linearProject: "Docs", repo: "me/docs@main" },
        { linearTeam: "ENG", repo: "me/app@develop", agent: { image: "my-agent" } },
      ],
      agent: {
        image: "autoforge-claude",
        command: ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
        envFrom: ["ANTHROPIC_API_KEY"],
        timeoutMinutes: 30,
      },
      template: "{title}\n\n{description}",
    });
    expect(config.rules[1]).toEqual({
      linearTeam: "ENG",
      repo: "me/app@develop",
      agent: { image: "my-agent" },
    });
    expect(config.agent.envFrom).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it.each([
    ["not an object", [], "config.json must contain a JSON object"],
    ["unknown key", { ...minimal, pollSecond: 30 }, "config.pollSecond"],
    ["poll too fast", { ...minimal, pollSeconds: 5 }, "config.pollSeconds"],
    ["fractional limit", { ...minimal, dailyRunLimit: 1.5 }, "config.dailyRunLimit"],
    ["zero concurrency", { ...minimal, maxConcurrent: 0 }, "config.maxConcurrent"],
    ["bad pickup", { ...minimal, pickup: "everything" }, "config.pickup"],
    ["bad comments", { ...minimal, comments: "none" }, "config.comments"],
    ["empty label", { ...minimal, label: "" }, "config.label"],
    ["bad default repo", { ...minimal, defaultRepo: "not a repo" }, "config.defaultRepo"],
    ["default repo branch flag", { ...minimal, defaultRepo: "me/app@-x" }, "config.defaultRepo"],
    ["no agent", {}, "config.agent"],
    ["agent without image", { agent: { command: ["x"] } }, "config.agent.image"],
    ["empty command", { agent: { image: "i", command: [] } }, "config.agent.command"],
    [
      "bad env name",
      { agent: { image: "i", command: ["x"], envFrom: ["NOT-A-NAME"] } },
      "config.agent.envFrom",
    ],
    [
      "zero timeout",
      { agent: { ...minimal.agent, timeoutMinutes: 0 } },
      "config.agent.timeoutMinutes",
    ],
    ["rules not a list", { ...minimal, rules: {} }, "config.rules"],
    [
      "rule with both matchers",
      { ...minimal, rules: [{ linearProject: "A", linearTeam: "B", repo: "me/a" }] },
      "config.rules[0]",
    ],
    ["rule with no matcher", { ...minimal, rules: [{ repo: "me/a" }] }, "config.rules[0]"],
    [
      "rule with bad repo",
      { ...minimal, rules: [{ linearTeam: "ENG", repo: "nope" }] },
      "config.rules[0].repo",
    ],
    [
      "rule agent with unknown key",
      { ...minimal, rules: [{ linearTeam: "ENG", repo: "me/a", agent: { img: "x" } }] },
      "config.rules[0].agent.img",
    ],
    ["empty template", { ...minimal, template: "" }, "config.template"],
  ])("rejects %s and names the field", (_name, raw, field) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(field);
  });
});

describe("parseRepoSpec", () => {
  it.each([
    ["me/app", { repo: "me/app", ref: "main" }],
    ["me/app@develop", { repo: "me/app", ref: "develop" }],
    ["my-org/app.js@release/1.2", { repo: "my-org/app.js", ref: "release/1.2" }],
    ["me/app@", null],
    ["me/app@-rf", null],
    ["me/app@has space", null],
    ["me", null],
    ["me/app/extra", null],
  ])("%s", (spec, expected) => {
    expect(parseRepoSpec(spec)).toEqual(expected);
  });
});

describe("readSecrets", () => {
  const config = parseConfig({
    agent: { image: "i", command: ["x"], envFrom: ["ANTHROPIC_API_KEY"] },
    rules: [{ linearTeam: "ENG", repo: "me/a", agent: { envFrom: ["OPENAI_API_KEY"] } }],
  });
  const env = {
    LINEAR_API_KEY: "lin",
    GITHUB_TOKEN: "gh",
    ANTHROPIC_API_KEY: "ant",
    OPENAI_API_KEY: "oai",
  };

  it("reads the tokens and every agent env name, including the rules'", () => {
    expect(readSecrets(config, env)).toEqual({
      linearApiKey: "lin",
      githubToken: "gh",
      cloneToken: undefined,
      agentEnv: { ANTHROPIC_API_KEY: "ant", OPENAI_API_KEY: "oai" },
    });
    expect(readSecrets(config, { ...env, CLONE_TOKEN: "clone" }).cloneToken).toBe("clone");
  });

  it.each(["LINEAR_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY"])("requires %s", (name) => {
    expect(() => readSecrets(config, { ...env, [name]: undefined })).toThrow(
      new ConfigError(`${name} is not set. Put it in ~/.autoforge/env or the environment.`),
    );
  });
});

describe("files", () => {
  const dir = () => mkdtemp(join(tmpdir(), "autoforge-config-"));

  it("loads config.json from the directory", async () => {
    const d = await dir();
    await writeFile(join(d, "config.json"), JSON.stringify(minimal));
    expect((await loadConfig(d)).agent.image).toBe("autoforge-claude");
  });

  it("explains a missing or broken config.json", async () => {
    const d = await dir();
    await expect(loadConfig(d)).rejects.toThrow(`${join(d, "config.json")} not found`);
    await writeFile(join(d, "config.json"), "{ nope");
    await expect(loadConfig(d)).rejects.toThrow("is not valid JSON");
  });

  it("returns an empty env when there is no env file", async () => {
    expect(await readEnvFile(await dir())).toEqual({});
  });

  it("reads an env file with mode 600", async () => {
    const d = await dir();
    await writeFile(join(d, "env"), 'LINEAR_API_KEY=lin\n# comment\nGITHUB_TOKEN="gh"\n');
    await chmod(join(d, "env"), 0o600);
    expect(await readEnvFile(d)).toMatchObject({ LINEAR_API_KEY: "lin", GITHUB_TOKEN: "gh" });
  });

  it.each([0o644, 0o640, 0o602])("refuses an env file with mode %o", async (mode) => {
    const d = await dir();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=lin\n");
    await chmod(join(d, "env"), mode);
    await expect(readEnvFile(d)).rejects.toThrow(`Run: chmod 600 ${join(d, "env")}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/config.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/config.js" (the module does not exist).

- [ ] **Step 3: Write the implementation**

`src/serve/config.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type AgentConfig = {
  image: string;
  command: string[];
  /** Names of environment variables passed to the agent. */
  envFrom: string[];
  timeoutMinutes: number;
};

export type Rule = {
  linearProject?: string;
  linearTeam?: string;
  repo: string;
  /** Shallow-merged over the top-level agent. */
  agent?: Partial<AgentConfig>;
};

export type Config = {
  pollSeconds: number;
  maxConcurrent: number;
  dailyRunLimit: number;
  approvalExpiryDays: number;
  pickup: "labelled" | "all-assigned";
  label: string;
  comments: "all" | "mine";
  defaultRepo?: string;
  rules: Rule[];
  agent: AgentConfig;
  template: string;
};

export type Secrets = {
  linearApiKey: string;
  githubToken: string;
  cloneToken?: string;
  /** Values for every name in agent.envFrom and in the rules' agent.envFrom. */
  agentEnv: Record<string, string>;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_TEMPLATE =
  "{title}\n\n{description}\n\nDiscussion (from issue participants):\n{comments}";

const CONFIG_KEYS = [
  "pollSeconds",
  "maxConcurrent",
  "dailyRunLimit",
  "approvalExpiryDays",
  "pickup",
  "label",
  "comments",
  "defaultRepo",
  "rules",
  "agent",
  "template",
];
const AGENT_KEYS = ["image", "command", "envFrom", "timeoutMinutes"];
const RULE_KEYS = ["linearProject", "linearTeam", "repo", "agent"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_SPEC = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(?:@(.*))?$/;

type Obj = Record<string, unknown>;

function fail(message: string): never {
  throw new ConfigError(message);
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** "owner/name" or "owner/name@branch" (branch defaults to main), or null when invalid. */
export function parseRepoSpec(spec: string): { repo: string; ref: string } | null {
  const m = REPO_SPEC.exec(spec);
  if (!m?.[1]) return null;
  const ref = m[2] ?? "main";
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) return null;
  return { repo: m[1], ref };
}

function onlyKeys(o: Obj, allowed: string[], path: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not a known field`);
  }
}

function num(o: Obj, key: string, path: string, def: number, min: number, integer = true): number {
  const v = o[key] ?? def;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < min ||
    (integer && !Number.isInteger(v))
  ) {
    fail(`${path}.${key} must be ${integer ? "an integer" : "a number"} of at least ${min}`);
  }
  return v;
}

function str(o: Obj, key: string, path: string, def?: string): string {
  const v = o[key] ?? def;
  if (typeof v !== "string" || !v) fail(`${path}.${key} must be a non-empty string`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[]): T {
  const v = o[key] ?? values[0];
  if (!values.includes(v as T)) fail(`${path}.${key} must be one of: ${values.join(", ")}`);
  return v as T;
}

function strings(
  o: Obj,
  key: string,
  path: string,
  what: string,
  minLength: number,
  pattern?: RegExp,
  def?: string[],
): string[] {
  const v = o[key] ?? def;
  const ok =
    Array.isArray(v) &&
    v.length >= minLength &&
    v.every((s) => typeof s === "string" && (!pattern || pattern.test(s)));
  if (!ok) fail(`${path}.${key} must be ${what}`);
  return v as string[];
}

function repoSpec(o: Obj, key: string, path: string): string {
  const v = str(o, key, path);
  if (!parseRepoSpec(v)) fail(`${path}.${key} must look like owner/name or owner/name@branch`);
  return v;
}

/** With `partial`, only the keys present are validated (a rule's agent override). */
function parseAgent(v: unknown, path: string, partial: boolean): Partial<AgentConfig> {
  if (!isObject(v)) fail(`${path} must be an object`);
  onlyKeys(v, AGENT_KEYS, path);
  const has = (key: string) => !partial || v[key] !== undefined;
  const out: Partial<AgentConfig> = {};
  if (has("image")) out.image = str(v, "image", path);
  if (has("command")) {
    out.command = strings(v, "command", path, "a list of at least one string", 1);
  }
  if (has("envFrom")) {
    out.envFrom = strings(
      v,
      "envFrom",
      path,
      "a list of environment variable names",
      0,
      ENV_NAME,
      [],
    );
  }
  if (has("timeoutMinutes")) out.timeoutMinutes = num(v, "timeoutMinutes", path, 30, 1, false);
  return out;
}

function parseRule(r: unknown, i: number): Rule {
  const path = `config.rules[${i}]`;
  if (!isObject(r)) fail(`${path} must be an object`);
  onlyKeys(r, RULE_KEYS, path);
  const hasProject = r.linearProject !== undefined;
  if (hasProject === (r.linearTeam !== undefined)) {
    fail(`${path} needs exactly one of linearProject or linearTeam`);
  }
  const rule: Rule = { repo: repoSpec(r, "repo", path) };
  if (hasProject) rule.linearProject = str(r, "linearProject", path);
  else rule.linearTeam = str(r, "linearTeam", path);
  if (r.agent !== undefined) rule.agent = parseAgent(r.agent, `${path}.agent`, true);
  return rule;
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) fail("config.json must contain a JSON object");
  onlyKeys(raw, CONFIG_KEYS, "config");
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules)) fail("config.rules must be a list");
  return {
    pollSeconds: num(raw, "pollSeconds", "config", 30, 10),
    maxConcurrent: num(raw, "maxConcurrent", "config", 1, 1),
    dailyRunLimit: num(raw, "dailyRunLimit", "config", 20, 1),
    approvalExpiryDays: num(raw, "approvalExpiryDays", "config", 14, 1),
    pickup: oneOf(raw, "pickup", "config", ["labelled", "all-assigned"] as const),
    label: str(raw, "label", "config", "autoforge"),
    comments: oneOf(raw, "comments", "config", ["all", "mine"] as const),
    defaultRepo: raw.defaultRepo === undefined ? undefined : repoSpec(raw, "defaultRepo", "config"),
    rules: rules.map(parseRule),
    agent: parseAgent(raw.agent, "config.agent", false) as AgentConfig,
    template: str(raw, "template", "config", DEFAULT_TEMPLATE),
  };
}

export async function loadConfig(dir: string): Promise<Config> {
  const path = join(dir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return fail(`${path} not found. Create it (see the README section "autoforge serve").`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(raw);
}

export function readSecrets(config: Config, env: Record<string, string | undefined>): Secrets {
  const need = (name: string): string =>
    env[name] || fail(`${name} is not set. Put it in ~/.autoforge/env or the environment.`);
  const names = new Set([
    ...config.agent.envFrom,
    ...config.rules.flatMap((r) => r.agent?.envFrom ?? []),
  ]);
  return {
    linearApiKey: need("LINEAR_API_KEY"),
    githubToken: need("GITHUB_TOKEN"),
    cloneToken: env.CLONE_TOKEN || undefined,
    agentEnv: Object.fromEntries([...names].map((n) => [n, need(n)])),
  };
}

/** Reads `<dir>/env` (KEY=value lines). Absent is fine; group or world access is refused. */
export async function readEnvFile(dir: string): Promise<Record<string, string | undefined>> {
  const path = join(dir, "env");
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (mode & 0o077)
    fail(`${path} must be readable and writable only by you. Run: chmod 600 ${path}`);
  return parseEnv(await readFile(path, "utf8"));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/config.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/config.ts test/serve/config.test.ts
git commit -F - <<'MSG'
feat(serve): config.json validation and secrets from the environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Linear types, routing and task text

**Files:**

- Create: `src/serve/linear.ts` (types and the `LinearApi` interface only; Task 4 adds the client)
- Create: `src/serve/route.ts`, `src/serve/prompt.ts`
- Test: `test/serve/route.test.ts`, `test/serve/prompt.test.ts`

**Interfaces:**

- Consumes (Task 1): `Config`, `AgentConfig`, `parseRepoSpec`, `parseConfig`.
- Produces:
  - `type LinearUser = { id: string; name: string }`
  - `type LinearComment = { id: string; body: string; createdAt: string; user: LinearUser | null }`
  - `type LinearIssue = { id: string; identifier: string; title: string; description: string | null; updatedAt: string; assigneeId: string | null; stateType: string; labels: string[]; team: { id: string; key: string; name: string }; project: { id: string; name: string } | null; comments: LinearComment[] }` (comments oldest first)
  - `interface LinearApi { viewer(): Promise<LinearUser>; changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]>; comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }>; moveToStarted(issueId: string): Promise<void>; attachUrl(issueId: string, url: string, title: string): Promise<void> }`
  - `type Route = { repo: string; ref: string; agent: AgentConfig }`
  - `routeIssue(issue: LinearIssue, config: Config): Route | null`
  - `const MARKER = "<!-- autoforge -->"`
  - `type Command = { kind: "publish"; force: boolean } | { kind: "discard" } | { kind: "retry"; feedback?: string }`
  - `parseCommand(body: string): Command | null`
  - `type RenderOptions = { template: string; comments: "all" | "mine"; viewerId: string; feedback?: string }`
  - `renderTask(issue: LinearIssue, o: RenderOptions): string`

- [ ] **Step 1: Write the failing tests**

`test/serve/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/serve/config.js";
import type { LinearIssue } from "../../src/serve/linear.js";
import { routeIssue } from "../../src/serve/route.js";

const issue = (fields: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "i1",
  identifier: "OPS-1",
  title: "T",
  description: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
  stateType: "unstarted",
  labels: [],
  team: { id: "t-ops", key: "OPS", name: "Operations" },
  project: null,
  comments: [],
  ...fields,
});

const config = parseConfig({
  defaultRepo: "me/app",
  rules: [
    { linearProject: "Docs", repo: "me/docs@main" },
    { linearProject: "proj-42", repo: "me/p42" },
    { linearTeam: "ENG", repo: "me/app@develop", agent: { image: "my-agent" } },
    { linearTeam: "Platform", repo: "me/platform" },
  ],
  agent: { image: "base", command: ["agent"] },
});

const docs = { id: "p-docs", name: "Docs" };
const eng = { id: "t-eng", key: "ENG", name: "Engineering" };

const cases: [string, Partial<LinearIssue>, string, string, string][] = [
  [
    "a repo label wins over rules",
    { labels: ["repo:me/label@feat/x"], project: docs, team: eng },
    "me/label",
    "feat/x",
    "base",
  ],
  [
    "a repo label without a branch uses main",
    { labels: ["repo:me/label"] },
    "me/label",
    "main",
    "base",
  ],
  [
    "an invalid repo label falls through",
    { labels: ["repo:not a repo"], team: eng },
    "me/app",
    "develop",
    "my-agent",
  ],
  [
    "a label branch starting with - falls through",
    { labels: ["repo:me/x@-rf"], team: eng },
    "me/app",
    "develop",
    "my-agent",
  ],
  ["project by name", { project: docs }, "me/docs", "main", "base"],
  ["project by id", { project: { id: "proj-42", name: "Forty two" } }, "me/p42", "main", "base"],
  ["a project rule beats a team rule", { project: docs, team: eng }, "me/docs", "main", "base"],
  ["team by key", { team: eng }, "me/app", "develop", "my-agent"],
  [
    "team by name",
    { team: { id: "t-p", key: "PLT", name: "Platform" } },
    "me/platform",
    "main",
    "base",
  ],
  ["default repo", {}, "me/app", "main", "base"],
];

describe("routeIssue", () => {
  it.each(cases)("%s", (_name, fields, repo, ref, image) => {
    expect(routeIssue(issue(fields), config)).toMatchObject({ repo, ref, agent: { image } });
  });

  it("shallow-merges a rule's agent over the base agent", () => {
    expect(routeIssue(issue({ team: eng }), config)?.agent).toEqual({
      image: "my-agent",
      command: ["agent"],
      envFrom: [],
      timeoutMinutes: 30,
    });
  });

  it("returns null when nothing matches and there is no default repo", () => {
    const bare = parseConfig({ agent: { image: "base", command: ["agent"] } });
    expect(routeIssue(issue(), bare)).toBeNull();
  });
});
```

`test/serve/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LinearComment, LinearIssue } from "../../src/serve/linear.js";
import { MARKER, parseCommand, renderTask } from "../../src/serve/prompt.js";

let seq = 0;
const comment = (body: string, user = { id: "me", name: "Mia" }): LinearComment => ({
  id: `c${++seq}`,
  body,
  createdAt: "2026-10-09T12:00:00.000Z",
  user,
});

const issue = (fields: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "i1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "The redirect loops.",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
  stateType: "unstarted",
  labels: [],
  team: { id: "t", key: "ENG", name: "Engineering" },
  project: null,
  comments: [],
  ...fields,
});

const opts = {
  template: "{title}\n\n{description}\n\n{comments}",
  comments: "all",
  viewerId: "me",
} as const;

describe("renderTask", () => {
  it("renders title, description and comments oldest first as author: body", () => {
    const text = renderTask(
      issue({ comments: [comment("first"), comment("second", { id: "bo", name: "Bo" })] }),
      opts,
    );
    expect(text).toBe("Fix login\n\nThe redirect loops.\n\nMia: first\nBo: second");
  });

  it("uses an empty string for a missing description and unknown for a missing author", () => {
    const c = { ...comment("hi"), user: null };
    expect(renderTask(issue({ description: null, comments: [c] }), opts)).toBe(
      "Fix login\n\n\n\nunknown: hi",
    );
  });

  it("leaves out daemon comments and command comments, keeps lookalikes", () => {
    const comments = [
      comment(`${MARKER}\nQueued for autoforge (position 1).`),
      comment("/publish"),
      comment("  /retry use tabs"),
      comment("/discard"),
      comment("/publishing is next week"),
    ];
    expect(renderTask(issue({ comments }), { ...opts, template: "{comments}" })).toBe(
      "Mia: /publishing is next week",
    );
  });

  it('keeps only the viewer\'s comments with comments: "mine"', () => {
    const comments = [comment("mine"), comment("theirs", { id: "bo", name: "Bo" })];
    expect(
      renderTask(issue({ comments }), { ...opts, template: "{comments}", comments: "mine" }),
    ).toBe("Mia: mine");
  });

  it("keeps $ sequences and placeholders inside issue text literal", () => {
    const text = renderTask(issue({ title: "Cost $& and $1 {description}", description: "$$" }), {
      ...opts,
      template: "{title}|{description}",
    });
    expect(text).toBe("Cost $& and $1 {description}|$$");
  });

  it("appends the reviewer's feedback for a retry", () => {
    expect(
      renderTask(issue(), { ...opts, template: "{title}", feedback: "Use tabs.\nAnd tests." }),
    ).toBe(
      "Fix login\n\nFeedback from the reviewer on the previous attempt:\nUse tabs.\nAnd tests.",
    );
  });
});

describe("parseCommand", () => {
  it.each([
    ["/publish", { kind: "publish", force: false }],
    ["  /publish force  ", { kind: "publish", force: true }],
    ["/publish\nforce", { kind: "publish", force: true }],
    ["/publish please", { kind: "publish", force: false }],
    ["/discard", { kind: "discard" }],
    ["/retry", { kind: "retry" }],
    ["/retry use tabs\nand add a test", { kind: "retry", feedback: "use tabs\nand add a test" }],
    ["/publishing", null],
    ["please /publish", null],
    [`${MARKER}\n/publish`, null],
    ["", null],
  ])("%j", (body, expected) => {
    expect(parseCommand(body)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/serve/route.test.ts test/serve/prompt.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/route.js" and "../../src/serve/prompt.js".

- [ ] **Step 3: Write the implementation**

`src/serve/linear.ts`:

```ts
export type LinearUser = { id: string; name: string };

export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  /** null for comments made by integrations. */
  user: LinearUser | null;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  assigneeId: string | null;
  /** Workflow state type: triage, backlog, unstarted, started, completed or canceled. */
  stateType: string;
  labels: string[];
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  /** Up to the 100 newest comments, oldest first. */
  comments: LinearComment[];
};

export interface LinearApi {
  viewer(): Promise<LinearUser>;
  /**
   * Issues assigned to the viewer and updated after `since`, plus every issue whose id is in
   * `trackedIds` whatever its assignee or update time. Paginated internally.
   */
  changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]>;
  comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }>;
  /** Moves the issue to its team's first workflow state of type "started". */
  moveToStarted(issueId: string): Promise<void>;
  attachUrl(issueId: string, url: string, title: string): Promise<void>;
}
```

`src/serve/route.ts`:

```ts
import { parseRepoSpec, type AgentConfig, type Config } from "./config.js";
import type { LinearIssue } from "./linear.js";

export type Route = { repo: string; ref: string; agent: AgentConfig };

/** Label `repo:owner/name[@branch]`, then project rule, then team rule, then defaultRepo. */
export function routeIssue(issue: LinearIssue, config: Config): Route | null {
  for (const label of issue.labels) {
    const spec = label.startsWith("repo:") ? parseRepoSpec(label.slice(5)) : null;
    if (spec) return { ...spec, agent: config.agent };
  }
  const { project, team } = issue;
  const rule =
    config.rules.find(
      (r) =>
        r.linearProject !== undefined &&
        project !== null &&
        (r.linearProject === project.name || r.linearProject === project.id),
    ) ??
    config.rules.find(
      (r) =>
        r.linearTeam !== undefined && (r.linearTeam === team.key || r.linearTeam === team.name),
    );
  const ruleSpec = rule ? parseRepoSpec(rule.repo) : null;
  if (rule && ruleSpec) return { ...ruleSpec, agent: { ...config.agent, ...rule.agent } };
  const fallback = config.defaultRepo ? parseRepoSpec(config.defaultRepo) : null;
  return fallback ? { ...fallback, agent: config.agent } : null;
}
```

`src/serve/prompt.ts`:

```ts
import type { LinearIssue } from "./linear.js";

/** First line of every comment the daemon posts. */
export const MARKER = "<!-- autoforge -->";

export type Command =
  { kind: "publish"; force: boolean } | { kind: "discard" } | { kind: "retry"; feedback?: string };

export function parseCommand(body: string): Command | null {
  const m = /^\/(publish|discard|retry)(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!m) return null;
  const arg = m[2]?.trim() ?? "";
  if (m[1] === "publish") return { kind: "publish", force: arg === "force" };
  if (m[1] === "discard") return { kind: "discard" };
  return arg ? { kind: "retry", feedback: arg } : { kind: "retry" };
}

export type RenderOptions = {
  template: string;
  comments: "all" | "mine";
  viewerId: string;
  feedback?: string;
};

export function renderTask(issue: LinearIssue, o: RenderOptions): string {
  const comments = issue.comments
    .filter(
      (c) =>
        !c.body.trimStart().startsWith(MARKER) &&
        !parseCommand(c.body) &&
        (o.comments === "all" || c.user?.id === o.viewerId),
    )
    .map((c) => `${c.user?.name ?? "unknown"}: ${c.body}`)
    .join("\n");
  const values: Record<string, string> = {
    title: issue.title,
    description: issue.description ?? "",
    comments,
  };
  // One pass with a replacer function: `$` sequences and placeholders inside issue text stay literal.
  const text = o.template.replace(
    /\{(title|description|comments)\}/g,
    (_, key: string) => values[key] ?? "",
  );
  return o.feedback
    ? `${text}\n\nFeedback from the reviewer on the previous attempt:\n${o.feedback}`
    : text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/serve/route.test.ts test/serve/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/linear.ts src/serve/route.ts src/serve/prompt.ts test/serve/route.test.ts test/serve/prompt.test.ts
git commit -F - <<'MSG'
feat(serve): repo routing, task template and command parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 3: State file and patches

**Files:**

- Create: `src/serve/state.ts`
- Test: `test/serve/state.test.ts`

**Interfaces:**

- Consumes: `RunResult` from `src/run.ts`.
- Produces:
  - `type IssueStatus = "queued" | "running" | "awaiting_approval" | "publishing" | "published" | "no_changes" | "failed" | "timed_out" | "discarded"`
  - `type IssueEntry = { identifier: string; status: IssueStatus; repo: string; ref: string; feedback?: string; interruptions: number; lastResultCommentAt?: string; handledCommentIds: string[]; run?: Omit<RunResult, "patch" | "logs">; prUrl?: string; queuedAt: string; waiting?: "docker" | "limit"; updatedAt: string }`
  - `type OutboxItem = { issueId: string; body: string; gate: boolean; attempts: number }`
  - `type State = { version: 1; viewerId: string; cursor: string; dailyRuns: { date: string; count: number }; issues: Record<string, IssueEntry>; noRoute: Record<string, string>; outbox: OutboxItem[] }`
  - `freshState(now: Date): State` (cursor one day before `now`)
  - `loadState(dir: string, now: Date): Promise<{ state: State; corruptPath?: string }>`
  - `saveState(dir: string, state: State): Promise<void>`
  - `writePatch(dir: string, runId: string, patch: string): Promise<void>`, `readPatch(dir: string, runId: string): Promise<string | null>`, `deletePatch(dir: string, runId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`test/serve/state.test.ts`:

```ts
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deletePatch,
  freshState,
  loadState,
  readPatch,
  saveState,
  writePatch,
  type State,
} from "../../src/serve/state.js";

const now = new Date("2026-10-09T12:00:00.000Z");
const dir = () => mkdtemp(join(tmpdir(), "autoforge-state-"));

const sample = (): State => ({
  ...freshState(now),
  viewerId: "me",
  issues: {
    "issue-1": {
      identifier: "ENG-1",
      status: "queued",
      repo: "o/r",
      ref: "main",
      interruptions: 0,
      handledCommentIds: ["c1"],
      queuedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  },
});

describe("state", () => {
  it("starts fresh with a cursor one day back when there is no file", async () => {
    const { state, corruptPath } = await loadState(await dir(), now);
    expect(corruptPath).toBeUndefined();
    expect(state).toEqual({
      version: 1,
      viewerId: "",
      cursor: "2026-10-08T12:00:00.000Z",
      dailyRuns: { date: "", count: 0 },
      issues: {},
      noRoute: {},
      outbox: [],
    });
  });

  it("saves atomically with mode 600 and loads the same state back", async () => {
    const d = await dir();
    await saveState(d, sample());
    await saveState(d, sample());
    expect(await readdir(d)).toEqual(["state.json"]);
    expect((await stat(join(d, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await loadState(d, now)).state).toEqual(sample());
  });

  it.each([
    ["not JSON", "{ not json"],
    ["the wrong version", JSON.stringify({ ...sample(), version: 2 })],
    ["an entry without its fields", JSON.stringify({ ...sample(), issues: { x: {} } })],
    ["no outbox", JSON.stringify({ ...sample(), outbox: undefined })],
  ])("moves a state file with %s aside and starts fresh", async (_name, text) => {
    const d = await dir();
    await writeFile(join(d, "state.json"), text);
    const { state, corruptPath } = await loadState(d, now);
    expect(state).toEqual(freshState(now));
    expect(corruptPath).toBe(join(d, "state.json.corrupt-2026-10-09T12-00-00-000Z"));
    expect(await readFile(corruptPath ?? "", "utf8")).toBe(text);
    expect(await readdir(d)).toEqual(["state.json.corrupt-2026-10-09T12-00-00-000Z"]);
  });

  it("stores patches with mode 600, reads and deletes them", async () => {
    const d = await dir();
    await writePatch(d, "run-1", "diff --git a/x b/x\n");
    const file = join(d, "patches", "run-1.patch");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readPatch(d, "run-1")).toBe("diff --git a/x b/x\n");
    await deletePatch(d, "run-1");
    expect(await readPatch(d, "run-1")).toBeNull();
    await deletePatch(d, "run-1");
  });

  it("refuses run ids that are not plain names", async () => {
    await expect(writePatch(await dir(), "../escape", "x")).rejects.toThrow("invalid run id");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/state.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/state.js".

- [ ] **Step 3: Write the implementation**

`src/serve/state.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../run.js";

export type IssueStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "publishing"
  | "published"
  | "no_changes"
  | "failed"
  | "timed_out"
  | "discarded";

export type IssueEntry = {
  /** For example "ENG-123". */
  identifier: string;
  status: IssueStatus;
  repo: string;
  ref: string;
  feedback?: string;
  interruptions: number;
  /** Linear time of the latest queued or result comment; commands must be newer. */
  lastResultCommentAt?: string;
  handledCommentIds: string[];
  /** From slice 1; the patch is stored separately. */
  run?: Omit<RunResult, "patch" | "logs">;
  prUrl?: string;
  /** When the issue last joined the queue. The queue runs oldest first. */
  queuedAt: string;
  /** A "waiting" comment was already posted for this queued issue. */
  waiting?: "docker" | "limit";
  updatedAt: string;
};

export type OutboxItem = { issueId: string; body: string; gate: boolean; attempts: number };

export type State = {
  version: 1;
  viewerId: string;
  /** Linear time; advanced only after a successful poll. */
  cursor: string;
  dailyRuns: { date: string; count: number };
  /** Keyed by Linear issue id. */
  issues: Record<string, IssueEntry>;
  /** Issue id to its sorted labels when the "no repo" comment was posted. */
  noRoute: Record<string, string>;
  /** Comments that failed to post, retried on the next tick. */
  outbox: OutboxItem[];
};

const DAY = 86_400_000;

export function freshState(now: Date): State {
  return {
    version: 1,
    viewerId: "",
    cursor: new Date(now.getTime() - DAY).toISOString(),
    dailyRuns: { date: "", count: 0 },
    issues: {},
    noRoute: {},
    outbox: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isState(s: unknown): s is State {
  return (
    isObject(s) &&
    s.version === 1 &&
    typeof s.viewerId === "string" &&
    typeof s.cursor === "string" &&
    isObject(s.dailyRuns) &&
    isObject(s.noRoute) &&
    Array.isArray(s.outbox) &&
    isObject(s.issues) &&
    Object.values(s.issues).every(
      (e) =>
        isObject(e) &&
        typeof e.status === "string" &&
        typeof e.queuedAt === "string" &&
        typeof e.updatedAt === "string" &&
        Array.isArray(e.handledCommentIds),
    )
  );
}

/** An unreadable or invalid state.json is renamed to state.json.corrupt-<time>. */
export async function loadState(
  dir: string,
  now: Date,
): Promise<{ state: State; corruptPath?: string }> {
  const path = join(dir, "state.json");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: freshState(now) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isState(parsed)) return { state: parsed };
  } catch {
    // handled below
  }
  const corruptPath = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  await rename(path, corruptPath);
  return { state: freshState(now), corruptPath };
}

/** Write to a temp file in the same directory, fsync, rename. */
export async function saveState(dir: string, state: State): Promise<void> {
  const path = join(dir, "state.json");
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(state, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function patchPath(dir: string, runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return join(dir, "patches", `${runId}.patch`);
}

export async function writePatch(dir: string, runId: string, patch: string): Promise<void> {
  const file = patchPath(dir, runId);
  await mkdir(join(dir, "patches"), { recursive: true, mode: 0o700 });
  await writeFile(file, patch, { mode: 0o600 });
}

export async function readPatch(dir: string, runId: string): Promise<string | null> {
  try {
    return await readFile(patchPath(dir, runId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function deletePatch(dir: string, runId: string): Promise<void> {
  await rm(patchPath(dir, runId), { force: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/state.ts test/serve/state.test.ts
git commit -F - <<'MSG'
feat(serve): atomic state file, corrupt-state recovery and patch files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Linear GraphQL client

**Files:**

- Modify: `src/serve/linear.ts` (append `LinearError` and `LinearClient` below the existing types)
- Test: `test/serve/linear.test.ts`

**Interfaces:**

- Consumes (Task 2): `LinearApi`, `LinearIssue`, `LinearComment`, `LinearUser`.
- Produces:
  - `class LinearError extends Error { readonly retryAfterMs?: number }` (constructor `(message: string, retryAfterMs?: number)`)
  - `type LinearClientOptions = { apiKey: string; url?: string; fetch?: typeof fetch }`
  - `class LinearClient implements LinearApi` (`new LinearClient(o: LinearClientOptions)`; default URL `https://api.linear.app/graphql`)

- [ ] **Step 1: Write the failing test**

`test/serve/linear.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LinearClient, LinearError } from "../../src/serve/linear.js";

type Call = { url: string; headers: Headers; query: string; variables: Record<string, unknown> };

function stub(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url: String(url), headers: new Headers(init.headers), ...body });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  const client = new LinearClient({
    apiKey: "lin_api_key",
    url: "https://linear.example.test/graphql",
    fetch,
  });
  return { client, calls };
}

const data = (d: unknown) => new Response(JSON.stringify({ data: d }), { status: 200 });

const rawIssue = (id: string, commentTimes: string[] = []) => ({
  id,
  identifier: "ENG-1",
  title: "T",
  description: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  assignee: { id: "u1" },
  state: { type: "unstarted" },
  team: { id: "t1", key: "ENG", name: "Engineering" },
  project: { id: "p1", name: "Docs" },
  labels: { nodes: [{ name: "autoforge" }] },
  comments: {
    nodes: commentTimes.map((createdAt, i) => ({
      id: `c${i}`,
      body: "hi",
      createdAt,
      user: { id: "u1", name: "Me" },
    })),
  },
});

const page = (nodes: unknown[], endCursor: string | null) =>
  data({ issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } });

describe("LinearClient", () => {
  it("sends the personal API key as is and returns the viewer", async () => {
    const { client, calls } = stub(data({ viewer: { id: "u1", name: "Me" } }));
    expect(await client.viewer()).toEqual({ id: "u1", name: "Me" });
    expect(calls[0]?.url).toBe("https://linear.example.test/graphql");
    expect(calls[0]?.headers.get("authorization")).toBe("lin_api_key");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("pages through changed issues and maps them, comments oldest first", async () => {
    const { client, calls } = stub(
      page([rawIssue("a", ["2026-10-09T12:00:02.000Z", "2026-10-09T12:00:01.000Z"])], "cursor-1"),
      page([rawIssue("b")], null),
    );
    const issues = await client.changedIssues("2026-10-09T00:00:00.000Z", []);
    expect(issues.map((i) => i.id)).toEqual(["a", "b"]);
    expect(issues[0]).toEqual({
      id: "a",
      identifier: "ENG-1",
      title: "T",
      description: null,
      updatedAt: "2026-10-09T12:00:00.000Z",
      assigneeId: "u1",
      stateType: "unstarted",
      labels: ["autoforge"],
      team: { id: "t1", key: "ENG", name: "Engineering" },
      project: { id: "p1", name: "Docs" },
      comments: [
        {
          id: "c1",
          body: "hi",
          createdAt: "2026-10-09T12:00:01.000Z",
          user: { id: "u1", name: "Me" },
        },
        {
          id: "c0",
          body: "hi",
          createdAt: "2026-10-09T12:00:02.000Z",
          user: { id: "u1", name: "Me" },
        },
      ],
    });
    expect(calls[0]?.variables).toEqual({
      after: null,
      filter: { assignee: { isMe: { eq: true } }, updatedAt: { gt: "2026-10-09T00:00:00.000Z" } },
    });
    expect(calls[1]?.variables.after).toBe("cursor-1");
  });

  it("also asks for tracked issues by id", async () => {
    const { client, calls } = stub(page([], null));
    await client.changedIssues("2026-10-09T00:00:00.000Z", ["x", "y"]);
    expect(calls[0]?.variables.filter).toEqual({
      or: [
        { assignee: { isMe: { eq: true } }, updatedAt: { gt: "2026-10-09T00:00:00.000Z" } },
        { id: { in: ["x", "y"] } },
      ],
    });
  });

  it("turns GraphQL errors into LinearError", async () => {
    const { client } = stub(
      new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), {
        status: 200,
      }),
    );
    await expect(client.viewer()).rejects.toThrow(
      new LinearError("Linear API error (status 200): Authentication required"),
    );
  });

  it("reads Retry-After from a rate-limited response", async () => {
    const { client } = stub(
      new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded" }] }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );
    const err = await client.viewer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearError);
    expect(err).toMatchObject({ retryAfterMs: 7000, message: expect.stringContaining("429") });
  });

  it("wraps network failures and non-JSON bodies", async () => {
    const { client } = stub(new Error("ECONNRESET"), new Response("<html>", { status: 502 }));
    await expect(client.viewer()).rejects.toThrow(
      new LinearError("Linear request failed: ECONNRESET"),
    );
    await expect(client.viewer()).rejects.toThrow("Linear API error (status 502): <html>");
  });

  it("creates a comment and returns its id and time", async () => {
    const { client, calls } = stub(
      data({
        commentCreate: {
          success: true,
          comment: { id: "c9", createdAt: "2026-10-09T12:00:00.000Z" },
        },
      }),
    );
    expect(await client.comment("issue-1", "hello")).toEqual({
      id: "c9",
      createdAt: "2026-10-09T12:00:00.000Z",
    });
    expect(calls[0]?.variables).toEqual({ input: { issueId: "issue-1", body: "hello" } });
  });

  it("moves the issue to the first started state by position", async () => {
    const { client, calls } = stub(
      data({
        issue: {
          team: {
            states: {
              nodes: [
                { id: "s-review", position: 3 },
                { id: "s-progress", position: 1 },
              ],
            },
          },
        },
      }),
      data({ issueUpdate: { success: true } }),
    );
    await client.moveToStarted("issue-1");
    expect(calls[1]?.variables).toEqual({ id: "issue-1", stateId: "s-progress" });
  });

  it("attaches a URL to the issue", async () => {
    const { client, calls } = stub(data({ attachmentCreate: { success: true } }));
    await client.attachUrl("issue-1", "https://github.com/o/r/pull/1", "Draft PR");
    expect(calls[0]?.variables).toEqual({
      input: { issueId: "issue-1", url: "https://github.com/o/r/pull/1", title: "Draft PR" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/linear.test.ts`
Expected: FAIL with "LinearClient is not a constructor" (or "does not provide an export named 'LinearClient'").

- [ ] **Step 3: Write the implementation**

Append to `src/serve/linear.ts` (below the `LinearApi` interface):

```ts
export class LinearError extends Error {
  override name = "LinearError";

  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type LinearClientOptions = { apiKey: string; url?: string; fetch?: typeof fetch };

type RawIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  assignee: { id: string } | null;
  state: { type: string };
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: LinearComment[] };
};

type IssuePage = {
  issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

// ponytail: 100 comments and 50 labels per issue; paginate them if real issues get longer.
const ISSUE_FIELDS = `id identifier title description updatedAt
  assignee { id } state { type } team { id key name } project { id name }
  labels(first: 50) { nodes { name } }
  comments(first: 100) { nodes { id body createdAt user { id name } } }`;

const toIssue = (r: RawIssue): LinearIssue => ({
  id: r.id,
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  updatedAt: r.updatedAt,
  assigneeId: r.assignee?.id ?? null,
  stateType: r.state.type,
  labels: r.labels.nodes.map((l) => l.name),
  team: r.team,
  project: r.project,
  comments: r.comments.nodes.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
});

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LinearClient implements LinearApi {
  private readonly url: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: LinearClientOptions) {
    this.url = o.url ?? "https://api.linear.app/graphql";
    this.doFetch = o.fetch ?? fetch;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(this.url, {
        method: "POST",
        // Personal API keys go in the header as is, without "Bearer".
        headers: { Authorization: this.o.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new LinearError(`Linear request failed: ${errorMessage(e)}`);
    }
    const text = await res.text().catch(() => "");
    let json: { data?: T; errors?: { message?: string }[] } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // reported below with the raw text
    }
    if (!res.ok || json.errors?.length || !json.data) {
      const detail = json.errors?.map((e) => e.message).join("; ") || text.slice(0, 200);
      throw new LinearError(
        `Linear API error (status ${res.status}): ${detail}`,
        retryAfter(res.headers.get("retry-after")),
      );
    }
    return json.data;
  }

  async viewer(): Promise<LinearUser> {
    const d = await this.gql<{ viewer: LinearUser }>("query { viewer { id name } }");
    return d.viewer;
  }

  async changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]> {
    const mine = { assignee: { isMe: { eq: true } }, updatedAt: { gt: since } };
    const filter = trackedIds.length ? { or: [mine, { id: { in: trackedIds } }] } : mine;
    const out: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const d: IssuePage = await this.gql<IssuePage>(
        `query($filter: IssueFilter!, $after: String) {
          issues(filter: $filter, first: 50, after: $after) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after },
      );
      out.push(...d.issues.nodes.map(toIssue));
      after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    const d = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; createdAt: string } | null };
    }>(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id createdAt } }
      }`,
      { input: { issueId, body } },
    );
    if (!d.commentCreate.comment) throw new LinearError("Linear did not create the comment");
    return d.commentCreate.comment;
  }

  async moveToStarted(issueId: string): Promise<void> {
    const d = await this.gql<{
      issue: { team: { states: { nodes: { id: string; position: number }[] } } };
    }>(
      `query($id: String!) {
        issue(id: $id) { team { states(filter: { type: { eq: "started" } }) { nodes { id position } } } }
      }`,
      { id: issueId },
    );
    const first = d.issue.team.states.nodes.toSorted((a, b) => a.position - b.position)[0];
    if (!first) return;
    await this.gql(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: first.id },
    );
  }

  async attachUrl(issueId: string, url: string, title: string): Promise<void> {
    await this.gql(
      `mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
      { input: { issueId, url, title } },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/linear.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/linear.ts test/serve/linear.test.ts
git commit -F - <<'MSG'
feat(serve): Linear GraphQL client with pagination and Retry-After

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Daemon core (pickup, queue, run, result comment, backoff)

**Files:**

- Create: `src/serve/daemon.ts`
- Create: `test/serve/fake-linear.ts`, `test/serve/harness.ts`
- Test: `test/serve/daemon-core.test.ts`

**Interfaces:**

- Consumes:
  - Task 1: `Config`, `AgentConfig`, `Secrets`, `readSecrets(config, env)`, `parseConfig(raw)`.
  - Task 2: `LinearApi`, `LinearIssue`, `LinearUser`, `LinearComment`, `routeIssue(issue, config)`, `MARKER`, `renderTask(issue, o)`.
  - Task 3: `State`, `IssueEntry`, `IssueStatus`, `loadState(dir, now)`, `saveState(dir, state)`, `writePatch(dir, runId, patch)`.
  - Task 4: `LinearError` (`retryAfterMs`).
  - SDK: `run(options: RunOptions): Promise<RunResult>`, `RunResult`, `Sandbox`, `makeRedactor(secrets)`.
  - Test harness: `makeBareRepo()`, `TempDirSandbox`, `fakeAgent(mode)`.
- Produces:
  - `type LogEntry = { level: "info" | "warn" | "error"; event: string; message: string; issue?: string }`
  - `type DaemonOptions = { config: Config; linear: LinearApi; stateDir: string; env: Record<string, string | undefined>; sandbox: (agent: AgentConfig) => Sandbox; now?: () => Date; repoUrl?: (repo: string) => string; github?: { apiUrl?: string; fetch?: typeof fetch }; log?: (entry: LogEntry) => void }`
  - `class Daemon` with `constructor(o: DaemonOptions)` (throws `ConfigError` for missing secrets), `start(): Promise<void>`, `tick(): Promise<void>` (never throws), `idle(): Promise<void>`, `stop(): Promise<void>`, `nextDelayMs(): number`.
  - Test helpers: `FakeLinear` (`addIssue`, `update`, `userComment`, `said`, `posted`, `started`, `attached`, `failWith`, `failComments`), `ME`, `OTHER`, `setup(o?)`, `step(d)`, `readState(dir)`, `ENV`, `stubGitHub()`.

- [ ] **Step 1: Write the test helpers**

`test/serve/fake-linear.ts`:

```ts
import type { LinearApi, LinearComment, LinearIssue, LinearUser } from "../../src/serve/linear.js";

export const ME: LinearUser = { id: "user-me", name: "Mia" };
export const OTHER: LinearUser = { id: "user-other", name: "Bo" };

/** In-memory Linear. Daemon comments are authored by ME, as with a real personal API key. */
export class FakeLinear implements LinearApi {
  readonly issues = new Map<string, LinearIssue>();
  readonly posted: { issueId: string; body: string }[] = [];
  readonly started: string[] = [];
  readonly attached: { issueId: string; url: string; title: string }[] = [];
  /** Every call throws this while set. */
  failWith: Error | null = null;
  /** comment() throws while set. */
  failComments = false;
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  addIssue(fields: Partial<LinearIssue> & { id: string }): LinearIssue {
    const issue: LinearIssue = {
      identifier: `ENG-${this.issues.size + 1}`,
      title: "Fix the greeting",
      description: "Make it friendlier.",
      updatedAt: this.now().toISOString(),
      assigneeId: ME.id,
      stateType: "unstarted",
      labels: ["autoforge"],
      team: { id: "team-eng", key: "ENG", name: "Engineering" },
      project: null,
      comments: [],
      ...fields,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  /** A person edits the issue in Linear. */
  update(id: string, fields: Partial<LinearIssue>): void {
    Object.assign(this.get(id), fields, { updatedAt: this.now().toISOString() });
  }

  userComment(id: string, body: string, user: LinearUser = ME): LinearComment {
    const c: LinearComment = {
      id: `comment-${++this.seq}`,
      body,
      createdAt: this.now().toISOString(),
      user,
    };
    const issue = this.get(id);
    issue.comments.push(c);
    issue.updatedAt = c.createdAt;
    return c;
  }

  /** What the daemon posted on an issue, without the marker line. */
  said(id: string): string[] {
    return this.posted
      .filter((p) => p.issueId === id)
      .map((p) => p.body.replace(/^<!-- autoforge -->\n/, ""));
  }

  async viewer(): Promise<LinearUser> {
    this.check();
    return ME;
  }

  async changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]> {
    this.check();
    return [...this.issues.values()]
      .filter(
        (i) =>
          (i.assigneeId === ME.id && Date.parse(i.updatedAt) > Date.parse(since)) ||
          trackedIds.includes(i.id),
      )
      .map((i) => structuredClone(i));
  }

  async comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    this.check();
    if (this.failComments) throw new Error("Linear is having a moment");
    this.posted.push({ issueId, body });
    const c = this.userComment(issueId, body);
    return { id: c.id, createdAt: c.createdAt };
  }

  async moveToStarted(issueId: string): Promise<void> {
    this.check();
    this.started.push(issueId);
    this.get(issueId).stateType = "started";
  }

  async attachUrl(issueId: string, url: string, title: string): Promise<void> {
    this.check();
    this.attached.push({ issueId, url, title });
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  private get(id: string): LinearIssue {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
}
```

`test/serve/harness.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/serve/config.js";
import { Daemon, type DaemonOptions, type LogEntry } from "../../src/serve/daemon.js";
import type { LinearUser } from "../../src/serve/linear.js";
import type { State } from "../../src/serve/state.js";
import { fakeAgent } from "../fake-agent.js";
import { makeBareRepo } from "../helpers.js";
import { TempDirSandbox } from "../temp-dir-sandbox.js";
import { FakeLinear, ME } from "./fake-linear.js";

export const ENV = { LINEAR_API_KEY: "lin_api_secret_0001", GITHUB_TOKEN: "ghp_secret_0002" };

export type GitHubStub = {
  /** HTTP status the next pull request call returns. */
  status: number;
  pulls: { url: string; body: Record<string, unknown> }[];
  fetch: typeof fetch;
};

export function stubGitHub(): GitHubStub {
  const gh: GitHubStub = {
    status: 201,
    pulls: [],
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      gh.pulls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const ok = gh.status < 300;
      const body = ok
        ? { html_url: `https://github.com/o/r/pull/${gh.pulls.length}` }
        : { message: "nope" };
      return new Response(JSON.stringify(body), { status: gh.status });
    }) as typeof globalThis.fetch,
  };
  return gh;
}

/** A daemon world: fake Linear, a frozen clock, a local bare repo and a temp state dir. */
export async function setup(o: { config?: Record<string, unknown>; agent?: string[] } = {}) {
  let t = Date.parse("2026-10-09T12:00:00.000Z");
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const linear = new FakeLinear(clock.now);
  const repo = await makeBareRepo();
  const dir = await mkdtemp(join(tmpdir(), "autoforge-serve-"));
  const github = stubGitHub();
  const logs: LogEntry[] = [];
  const config = parseConfig({
    defaultRepo: "o/r@main",
    agent: { image: "unused", command: o.agent ?? fakeAgent("edit") },
    ...o.config,
  });
  const sandbox = new TempDirSandbox();
  const make = (extra: Partial<DaemonOptions> = {}) =>
    new Daemon({
      config,
      linear,
      stateDir: dir,
      env: ENV,
      sandbox: () => sandbox,
      now: clock.now,
      repoUrl: () => repo.bare,
      github: { apiUrl: "https://api.example.test", fetch: github.fetch },
      log: (e) => logs.push(e),
      ...extra,
    });
  /** The user (or someone else) comments one second later. */
  const reply = (issueId: string, body: string, user: LinearUser = ME) => {
    clock.advance(1000);
    return linear.userComment(issueId, body, user);
  };
  return { clock, linear, repo, dir, github, logs, config, make, reply };
}

/** One poll, then wait for every run and publish it started. */
export async function step(d: Daemon): Promise<void> {
  await d.tick();
  await d.idle();
}

export async function readState(dir: string): Promise<State> {
  return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State;
}
```

- [ ] **Step 2: Write the failing test**

`test/serve/daemon-core.test.ts`:

`````ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LinearError } from "../../src/serve/linear.js";
import { fakeAgent } from "../fake-agent.js";
import { OTHER } from "./fake-linear.js";
import { ENV, readState, setup, step } from "./harness.js";

const RETRY = "Reply `/retry <feedback>` to run it again with your feedback.";

describe("daemon core", () => {
  it("picks up a labelled issue, runs it and posts the result with a patch excerpt", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await d.tick();
    expect(h.linear.said("issue-1")[0]).toBe("Queued for autoforge (position 1).");
    await d.idle();

    const said = h.linear.said("issue-1");
    expect(said).toHaveLength(3);
    expect(said[1]).toBe("Running on `o/r@main` in a sandbox.");
    expect(said[2]).toContain("autoforge finished on `o/r@main`: 1 file(s) changed, +1 -0.");
    expect(said[2]).toContain("- hello.txt");
    expect(said[2]).toContain("```diff\n");
    expect(said[2]).toContain("+changed");
    expect(said[2]).toContain("Reply `/publish` to open a draft PR");
    expect(h.linear.posted.every((p) => p.body.startsWith("<!-- autoforge -->\n"))).toBe(true);
    expect(h.linear.started).toEqual(["issue-1"]);

    const state = await readState(h.dir);
    const entry = state.issues["issue-1"];
    expect(entry).toMatchObject({
      identifier: "ENG-1",
      status: "awaiting_approval",
      repo: "o/r",
      ref: "main",
      interruptions: 0,
    });
    expect(entry?.run).toMatchObject({ status: "changed", filesChanged: ["hello.txt"] });
    expect(entry?.run).not.toHaveProperty("patch");
    expect(entry?.run).not.toHaveProperty("logs");
    expect(state.cursor).toBe("2026-10-09T12:00:00.000Z");
    expect(state.dailyRuns.count).toBe(1);

    const patchFile = join(h.dir, "patches", `${entry?.run?.id}.patch`);
    expect(await readFile(patchFile, "utf8")).toContain("+changed");
    expect((await stat(patchFile)).mode & 0o777).toBe(0o600);
  });

  it("only picks up open issues assigned to the viewer that carry the label", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "no-label", labels: ["bug"] });
    h.linear.addIssue({ id: "theirs", assigneeId: OTHER.id });
    h.linear.addIssue({ id: "done", stateType: "completed" });
    h.linear.addIssue({ id: "canceled", stateType: "canceled" });
    h.linear.addIssue({ id: "upper", labels: ["AutoForge"] });
    const d = h.make();
    await d.start();
    await step(d);
    expect(new Set(h.linear.posted.map((p) => p.issueId))).toEqual(new Set(["upper"]));
    expect(Object.keys((await readState(h.dir)).issues)).toEqual(["upper"]);
  });

  it('picks up unlabelled issues with pickup "all-assigned"', async () => {
    const h = await setup({ config: { pickup: "all-assigned" } });
    h.linear.addIssue({ id: "issue-1", labels: [] });
    const d = h.make();
    await d.start();
    await step(d);
    expect(h.linear.said("issue-1")[0]).toBe("Queued for autoforge (position 1).");
  });

  it("says once that no repo is configured, and again only when the labels change", async () => {
    const h = await setup({ config: { defaultRepo: undefined } });
    const msg =
      "No repo configured for this issue. Add a `repo:owner/name` label or a rule in config.";
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    h.clock.advance(1000);
    h.linear.update("issue-1", { title: "Edited" });
    await step(d);
    expect(h.linear.said("issue-1")).toEqual([msg]);

    h.clock.advance(1000);
    h.linear.update("issue-1", { labels: ["autoforge", "bug"] });
    await step(d);
    expect(h.linear.said("issue-1")).toEqual([msg, msg]);

    h.clock.advance(1000);
    h.linear.update("issue-1", { labels: ["autoforge", "repo:o/r"] });
    await step(d);
    expect(h.linear.said("issue-1")[2]).toBe("Queued for autoforge (position 1).");
  });

  it("runs queued issues one at a time, oldest first", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    h.linear.addIssue({ id: "issue-2" });
    const d = h.make();
    await d.start();
    await step(d);
    expect(h.linear.said("issue-2")).toEqual(["Queued for autoforge (position 2)."]);
    let state = await readState(h.dir);
    expect(state.issues["issue-1"]?.status).toBe("awaiting_approval");
    expect(state.issues["issue-2"]?.status).toBe("queued");

    await step(d);
    state = await readState(h.dir);
    expect(state.issues["issue-2"]?.status).toBe("awaiting_approval");
  });

  it("reports a run without changes and offers /retry", async () => {
    const h = await setup({ agent: fakeAgent("noop") });
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    expect(h.linear.said("issue-1")[2]).toBe(
      `autoforge finished on \`o/r@main\` without changing any files.\n\n${RETRY}`,
    );
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("no_changes");
    await expect(readdir(join(h.dir, "patches"))).rejects.toThrow();
  });

  it("backs off on Linear errors, honours Retry-After and keeps the cursor", async () => {
    const h = await setup();
    const d = h.make();
    await d.start();
    expect(d.nextDelayMs()).toBe(30_000);

    h.linear.failWith = new Error("socket hang up");
    await d.tick();
    expect(d.nextDelayMs()).toBe(5_000);
    await d.tick();
    expect(d.nextDelayMs()).toBe(10_000);
    h.linear.failWith = new LinearError("rate limited", 60_000);
    await d.tick();
    expect(d.nextDelayMs()).toBe(60_000);
    expect((await readState(h.dir)).cursor).toBe("2026-10-08T12:00:00.000Z");
    expect(h.logs.filter((l) => l.event === "poll_failed")).toHaveLength(3);

    h.linear.failWith = null;
    h.linear.addIssue({ id: "issue-1" });
    await step(d);
    expect(d.nextDelayMs()).toBe(30_000);
    expect((await readState(h.dir)).cursor).toBe("2026-10-09T12:00:00.000Z");
  });

  it("caps the backoff at five minutes", async () => {
    const h = await setup();
    const d = h.make();
    await d.start();
    h.linear.failWith = new Error("down");
    for (let i = 0; i < 10; i++) await d.tick();
    expect(d.nextDelayMs()).toBe(300_000);
  });

  // Review Focus 1
  it("masks secrets in the patch excerpt and the logs", async () => {
    const secret = "sk-live-0123456789";
    const h = await setup({
      config: {
        agent: {
          image: "unused",
          command: ["sh", "-c", 'echo "key $SECRET_KEY"; echo "$SECRET_KEY" > leak.txt'],
          envFrom: ["SECRET_KEY"],
        },
      },
    });
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make({ env: { ...ENV, SECRET_KEY: secret } });
    await d.start();
    await step(d);
    expect(h.linear.said("issue-1")[2]).toContain("+***");
    for (const p of h.linear.posted) expect(p.body).not.toContain(secret);
    expect(h.logs).toContainEqual({
      level: "info",
      event: "agent",
      message: "key ***",
      issue: "ENG-1",
    });
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    expect(await readFile(join(h.dir, "state.json"), "utf8")).not.toContain(secret);
  });

  // Review Focus 2
  it("retries comments that failed to post, in order, and keeps the command gate", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    h.linear.failComments = true;
    await step(d);
    expect(h.linear.said("issue-1")).toEqual([]);
    let state = await readState(h.dir);
    expect(state.outbox).toHaveLength(3);
    expect(state.issues["issue-1"]?.lastResultCommentAt).toBeUndefined();

    h.linear.failComments = false;
    h.clock.advance(1000);
    await step(d);
    const said = h.linear.said("issue-1");
    expect(said[0]).toBe("Queued for autoforge (position 1).");
    expect(said[1]).toBe("Running on `o/r@main` in a sandbox.");
    expect(said[2]).toContain("autoforge finished on `o/r@main`");
    state = await readState(h.dir);
    expect(state.outbox).toEqual([]);
    expect(state.issues["issue-1"]?.lastResultCommentAt).toBe("2026-10-09T12:00:01.000Z");
  });

  // Review Focus 3
  it("reports a run that could not start (empty task) and keeps going", async () => {
    const h = await setup({ config: { template: "{description}" } });
    h.linear.addIssue({ id: "issue-1", description: null });
    h.linear.addIssue({ id: "issue-2", description: "Do the thing." });
    const d = h.make();
    await d.start();
    await step(d);
    expect(h.linear.said("issue-1")).toEqual([
      "Queued for autoforge (position 1).",
      `autoforge could not start the run: task must be a non-empty string\n\n${RETRY}`,
    ]);
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("failed");
    await step(d);
    expect((await readState(h.dir)).issues["issue-2"]?.status).toBe("awaiting_approval");
  });

  it("fences a patch that contains backticks with a longer fence", async () => {
    const h = await setup({ agent: ["sh", "-c", "printf '%s\\n' '```' 'not code' > fence.md"] });
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    const result = h.linear.said("issue-1")[2] ?? "";
    expect(result).toContain("\n````diff\n");
    expect(result).toContain("\n+```\n");
    expect(result).toContain("\n````\n");
  });
});
`````

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/daemon-core.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/daemon.js".

- [ ] **Step 4: Write the implementation**

`src/serve/daemon.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { makeRedactor } from "../redact.js";
import { run, type RunResult } from "../run.js";
import type { Sandbox } from "../sandbox.js";
import { readSecrets, type AgentConfig, type Config, type Secrets } from "./config.js";
import { LinearError, type LinearApi, type LinearIssue } from "./linear.js";
import { MARKER, renderTask } from "./prompt.js";
import { routeIssue } from "./route.js";
import {
  loadState,
  saveState,
  writePatch,
  type IssueEntry,
  type IssueStatus,
  type State,
} from "./state.js";

export type LogEntry = {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  issue?: string;
};

export type DaemonOptions = {
  config: Config;
  linear: LinearApi;
  /** Holds state.json, patches/ and status.json. */
  stateDir: string;
  /** LINEAR_API_KEY, GITHUB_TOKEN, CLONE_TOKEN and the agent envFrom names are read from here. */
  env: Record<string, string | undefined>;
  /** Builds the sandbox for one run, for example a DockerSandbox for agent.image. */
  sandbox: (agent: AgentConfig) => Sandbox;
  now?: () => Date;
  /** Clone and push URL for "owner/name". Defaults to https://github.com/<repo>.git */
  repoUrl?: (repo: string) => string;
  /** Passed through to publishToGitHub. */
  github?: { apiUrl?: string; fetch?: typeof fetch };
  /** One call per log line. Defaults to a JSON line on stdout. */
  log?: (entry: LogEntry) => void;
};

type Job = { abort: AbortController; dropped: boolean; done: Promise<void> };

const DAY = 86_400_000;
const ACTIVE: IssueStatus[] = ["queued", "running", "awaiting_approval", "publishing"];
const RETRYABLE: IssueStatus[] = ["awaiting_approval", "no_changes", "failed", "timed_out"];
const RETRY_HINT = "Reply `/retry <feedback>` to run it again with your feedback.";

export class Daemon {
  private state!: State;
  private readonly secrets: Secrets;
  private readonly mask: (text: string) => string;
  private readonly now: () => Date;
  private readonly repoUrl: (repo: string) => string;
  private readonly jobs = new Map<string, Job>();
  /** The latest copy of each issue seen by a poll. */
  private readonly latest = new Map<string, LinearIssue>();
  private readonly stopping = new AbortController();
  private saving: Promise<void> = Promise.resolve();
  private failures = 0;
  private retryAfterMs: number | undefined;

  constructor(private readonly o: DaemonOptions) {
    this.secrets = readSecrets(o.config, o.env);
    this.mask = makeRedactor([
      this.secrets.linearApiKey,
      this.secrets.githubToken,
      this.secrets.cloneToken,
      ...Object.values(this.secrets.agentEnv),
    ]);
    this.now = o.now ?? (() => new Date());
    this.repoUrl = o.repoUrl ?? ((repo) => `https://github.com/${repo}.git`);
  }

  async start(): Promise<void> {
    await mkdir(this.o.stateDir, { recursive: true, mode: 0o700 });
    const { state } = await loadState(this.o.stateDir, this.now());
    this.state = state;
    this.state.viewerId = (await this.o.linear.viewer()).id;
    await this.save();
  }

  /** How long to wait before the next tick: the poll interval, or the backoff after errors. */
  nextDelayMs(): number {
    if (!this.failures) return this.o.config.pollSeconds * 1000;
    const backoff = Math.min(5000 * 2 ** (this.failures - 1), 300_000);
    return Math.max(backoff, this.retryAfterMs ?? 0);
  }

  /** One poll: post pending comments, read Linear, handle each issue, start runs. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.flushOutbox();
      const tracked = Object.entries(this.state.issues)
        .filter(([, e]) => this.tracked(e))
        .map(([id]) => id);
      let issues: LinearIssue[];
      try {
        issues = await this.o.linear.changedIssues(this.state.cursor, tracked);
      } catch (e) {
        this.failures++;
        this.retryAfterMs = e instanceof LinearError ? e.retryAfterMs : undefined;
        this.log(
          "warn",
          "poll_failed",
          `${errorMessage(e)}; next try in ${this.nextDelayMs() / 1000} s`,
        );
        return;
      }
      this.failures = 0;
      this.retryAfterMs = undefined;
      let cursor = this.state.cursor;
      for (const issue of issues) {
        this.latest.set(issue.id, issue);
        await this.handleIssue(issue);
        if (Date.parse(issue.updatedAt) > Date.parse(cursor)) cursor = issue.updatedAt;
      }
      this.state.cursor = cursor;
      await this.schedule();
    } catch (e) {
      this.log("error", "tick_failed", errorMessage(e));
    } finally {
      await this.save();
    }
  }

  /** Resolves once no run is in flight. */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.values()].map((j) => j.done));
    await this.saving;
  }

  /** Aborts runs in flight and leaves them "running" in state, so the next start re-queues them. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.idle();
    await this.save();
  }

  private tracked(e: IssueEntry): boolean {
    if (ACTIVE.includes(e.status)) return true;
    // ponytail: finished runs stay tracked for approvalExpiryDays so a late /retry is seen;
    // after that only an edit to the issue brings them back into a poll.
    return RETRYABLE.includes(e.status) && this.age(e) < this.o.config.approvalExpiryDays * DAY;
  }

  private age(e: IssueEntry): number {
    return this.now().getTime() - Date.parse(e.updatedAt);
  }

  private async handleIssue(issue: LinearIssue): Promise<void> {
    const { pickup, label } = this.o.config;
    const entry = this.state.issues[issue.id];
    const picked =
      issue.assigneeId === this.state.viewerId &&
      (pickup === "all-assigned" ||
        issue.labels.some((l) => l.toLowerCase() === label.toLowerCase()));
    const open = issue.stateType !== "completed" && issue.stateType !== "canceled";
    if (entry) return; // an issue already in state is never picked up twice
    if (picked && open) await this.pickUp(issue);
  }

  private async pickUp(issue: LinearIssue): Promise<void> {
    const route = routeIssue(issue, this.o.config);
    if (!route) {
      const labels = issue.labels.toSorted().join("\n");
      if (this.state.noRoute[issue.id] === labels) return;
      this.state.noRoute[issue.id] = labels;
      await this.post(
        issue.id,
        "No repo configured for this issue. Add a `repo:owner/name` label or a rule in config.",
      );
      return;
    }
    delete this.state.noRoute[issue.id];
    const now = this.now().toISOString();
    this.state.issues[issue.id] = {
      identifier: issue.identifier,
      status: "queued",
      repo: route.repo,
      ref: route.ref,
      interruptions: 0,
      // Commands written before pickup never fire.
      handledCommentIds: issue.comments.map((c) => c.id),
      queuedAt: now,
      updatedAt: now,
    };
    this.log("info", "queued", `queued for ${route.repo}@${route.ref}`, issue.identifier);
    await this.post(issue.id, `Queued for autoforge (position ${this.position(issue.id)}).`, true);
  }

  /** Queued entries, oldest first. */
  private queue(): [string, IssueEntry][] {
    return Object.entries(this.state.issues)
      .filter(([, e]) => e.status === "queued")
      .sort(([, a], [, b]) => a.queuedAt.localeCompare(b.queuedAt));
  }

  private position(issueId: string): number {
    return this.queue().findIndex(([id]) => id === issueId) + 1;
  }

  private async schedule(): Promise<void> {
    const today = localDate(this.now());
    if (this.state.dailyRuns.date !== today) this.state.dailyRuns = { date: today, count: 0 };
    for (const [id, e] of this.queue()) {
      if (this.jobs.has(id)) continue; // an aborted run for this issue is still winding down
      if (this.jobs.size >= this.o.config.maxConcurrent) return;
      this.startRun(id, e);
    }
  }

  private startRun(id: string, entry: IssueEntry): void {
    const issue = this.latest.get(id);
    if (!issue) return;
    const { config } = this.o;
    // Labels may have changed while queued, so route again.
    const route = routeIssue(issue, config) ?? {
      repo: entry.repo,
      ref: entry.ref,
      agent: config.agent,
    };
    this.set(entry, { status: "running", repo: route.repo, ref: route.ref });
    this.state.dailyRuns.count++;
    const task = renderTask(issue, {
      template: config.template,
      comments: config.comments,
      viewerId: this.state.viewerId,
      feedback: entry.feedback,
    });
    const abort = new AbortController();
    const job: Job = { abort, dropped: false, done: Promise.resolve() };
    let announced: Promise<void> | undefined;
    job.done = (async () => {
      let result: RunResult | Error;
      try {
        result = await run({
          repo: { url: this.repoUrl(route.repo), ref: route.ref, token: this.secrets.cloneToken },
          task,
          agent: {
            command: route.agent.command,
            env: pick(this.secrets.agentEnv, route.agent.envFrom),
          },
          sandbox: this.o.sandbox(route.agent),
          timeoutMs: route.agent.timeoutMinutes * 60_000,
          signal: AbortSignal.any([abort.signal, this.stopping.signal]),
          onEvent: (ev) => {
            if (ev.type === "log") this.log("info", "agent", ev.line, entry.identifier);
            else if (ev.phase === "cloning")
              announced ??= this.announce(id, entry, route.repo, route.ref);
          },
        });
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
      }
      await announced;
      await this.finishRun(id, entry, job, result);
      await this.save();
    })()
      .catch((e) => this.log("error", "run_handler_failed", errorMessage(e), entry.identifier))
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
  }

  /** Called once the sandbox exists and the clone starts. */
  private async announce(id: string, entry: IssueEntry, repo: string, ref: string): Promise<void> {
    await this.o.linear
      .moveToStarted(id)
      .catch((e) => this.log("warn", "move_failed", errorMessage(e), entry.identifier));
    await this.post(id, `Running on \`${repo}@${ref}\` in a sandbox.`);
  }

  private async finishRun(
    id: string,
    entry: IssueEntry,
    job: Job,
    result: RunResult | Error,
  ): Promise<void> {
    if (this.stopping.signal.aborted || job.dropped) return;
    if (result instanceof Error) {
      this.set(entry, { status: "failed", interruptions: 0 });
      await this.post(
        id,
        `autoforge could not start the run: ${result.message}\n\n${RETRY_HINT}`,
        true,
      );
      return;
    }
    if (result.status === "changed") await writePatch(this.o.stateDir, result.id, result.patch);
    this.set(entry, {
      status: result.status === "changed" ? "awaiting_approval" : result.status,
      run: withoutOutput(result),
      interruptions: 0,
    });
    this.log(
      "info",
      "run_finished",
      result.reason ? `${result.status} (${result.reason})` : result.status,
      entry.identifier,
    );
    await this.post(id, resultComment(result, entry), true);
  }

  /** Posts a daemon comment. A failure goes to the outbox. `gate` moves the command window. */
  private async post(issueId: string, text: string, gate = false): Promise<void> {
    const body = `${MARKER}\n${this.mask(text)}`;
    try {
      const c = await this.o.linear.comment(issueId, body);
      if (gate) this.gate(issueId, c.createdAt);
    } catch (e) {
      this.state.outbox.push({ issueId, body, gate, attempts: 1 });
      this.log(
        "warn",
        "comment_failed",
        `${errorMessage(e)}; will retry`,
        this.state.issues[issueId]?.identifier,
      );
    }
  }

  private async flushOutbox(): Promise<void> {
    const pending = this.state.outbox;
    this.state.outbox = [];
    for (const item of pending) {
      try {
        const c = await this.o.linear.comment(item.issueId, item.body);
        if (item.gate) this.gate(item.issueId, c.createdAt);
      } catch {
        item.attempts++;
        if (item.attempts <= 100) this.state.outbox.push(item);
        else this.log("error", "comment_dropped", "gave up on a comment after 100 attempts");
      }
    }
  }

  private gate(issueId: string, at: string): void {
    const entry = this.state.issues[issueId];
    if (entry) entry.lastResultCommentAt = at;
  }

  private set(entry: IssueEntry, fields: Partial<IssueEntry>): void {
    Object.assign(entry, fields, { updatedAt: this.now().toISOString() });
  }

  /** Saves are chained so an older snapshot can never land after a newer one. */
  private save(): Promise<void> {
    this.saving = this.saving
      .then(() => saveState(this.o.stateDir, this.state))
      .catch((e) => this.log("error", "state_save_failed", errorMessage(e)));
    return this.saving;
  }

  private log(level: LogEntry["level"], event: string, message: string, issue?: string): void {
    (this.o.log ?? defaultLog)({
      level,
      event,
      message: this.mask(message),
      ...(issue ? { issue } : {}),
    });
  }
}

function resultComment(r: RunResult, entry: IssueEntry): string {
  const where = `\`${entry.repo}@${entry.ref}\``;
  if (r.status === "no_changes") {
    return `autoforge finished on ${where} without changing any files.\n\n${RETRY_HINT}`;
  }
  if (r.status === "timed_out") {
    return `autoforge stopped on ${where}: ${r.message ?? "the run hit its timeout"}\n\n${RETRY_HINT}`;
  }
  if (r.status === "failed") {
    return `autoforge failed on ${where} (\`${r.reason ?? "error"}\`): ${r.message ?? "unknown error"}\n\n${RETRY_HINT}`;
  }
  const lines = r.patch.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, 80).join("\n");
  // A fence longer than any backtick run in the patch, so the patch cannot close it.
  const fence = "`".repeat(Math.max(3, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const { added, removed } = diffstat(r.patch);
  const files = r.filesChanged.slice(0, 20).map((f) => `- ${f}`);
  if (r.filesChanged.length > 20) files.push(`- and ${r.filesChanged.length - 20} more`);
  return [
    `autoforge finished on ${where}: ${r.filesChanged.length} file(s) changed, +${added} -${removed}.`,
    "",
    ...files,
    "",
    `${fence}diff`,
    shown,
    fence,
    ...(lines.length > 80 ? [`(first 80 of ${lines.length} lines)`] : []),
    "",
    "Reply `/publish` to open a draft PR (`/publish force` overwrites an existing branch), `/retry <feedback>` to run again with your feedback, or `/discard` to drop it.",
  ].join("\n");
}

function diffstat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed };
}

function withoutOutput(r: RunResult): Omit<RunResult, "patch" | "logs"> {
  const copy: Partial<RunResult> = { ...r };
  delete copy.patch;
  delete copy.logs;
  return copy as Omit<RunResult, "patch" | "logs">;
}

function pick(env: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultLog = (e: LogEntry) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...e }));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/daemon-core.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm fix && chop pnpm lint && chop pnpm typecheck
git add src/serve/daemon.ts test/serve/fake-linear.ts test/serve/harness.ts test/serve/daemon-core.test.ts
git commit -F - <<'MSG'
feat(serve): daemon pickup, queue, runs and result comments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Commands (`/publish`, `/publish force`, `/discard`, `/retry`) and wrong-state replies

**Files:**

- Modify: `src/serve/daemon.ts`
- Test: `test/serve/daemon-commands.test.ts`

**Interfaces:**

- Consumes:
  - Task 2: `parseCommand(body): Command | null`, `Command`.
  - Task 3: `readPatch(dir, runId)`, `deletePatch(dir, runId)`.
  - Task 5: `Daemon` internals (`post`, `set`, `save`, `position`, `queue`, `jobs`, `stopping`, `secrets`, `repoUrl`, `RETRYABLE`), test helpers `setup`, `step`, `readState`, `OTHER`.
  - SDK: `publishToGitHub(result, { repo, token, base, force, gitUrl, apiUrl, fetch, signal })`, `PublishError` (`code`).
- Produces:
  - `type CommandOutcome = { ok: boolean; message: string }` (exported from `daemon.ts`)
  - private `apply(issueId: string, command: Command, reply: boolean): Promise<CommandOutcome | null>` (null when the issue is unknown; Task 8 wraps it)
  - private `entryOf(issueId: string): IssueEntry | undefined` (own keys only; Task 8 uses it)
  - `idle()` now also waits for publishes.

- [ ] **Step 1: Write the failing test**

`test/serve/daemon-commands.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent } from "../fake-agent.js";
import { git } from "../helpers.js";
import { OTHER } from "./fake-linear.js";
import { readState, setup, step } from "./harness.js";

/** An issue that has run once and is waiting for approval (with the edit agent). */
async function awaiting(o: Parameters<typeof setup>[0] = {}) {
  const h = await setup(o);
  h.linear.addIssue({ id: "issue-1" });
  const d = h.make();
  await d.start();
  await step(d);
  const runId = (await readState(h.dir)).issues["issue-1"]?.run?.id;
  return { ...h, d, patchFile: join(h.dir, "patches", `${runId}.patch`) };
}

const status = async (dir: string) => (await readState(dir)).issues["issue-1"]?.status;

describe("daemon commands", () => {
  it("/publish opens a draft PR, links it on the issue and deletes the patch", async () => {
    const h = await awaiting();
    h.reply("issue-1", "/publish");
    await step(h.d);

    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");
    expect(h.linear.attached).toEqual([
      { issueId: "issue-1", url: "https://github.com/o/r/pull/1", title: "Draft PR (autoforge)" },
    ]);
    const pr = h.github.pulls[0];
    expect(pr?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(pr?.body).toMatchObject({ base: "main", draft: true, title: "Fix the greeting" });
    expect(await git(h.repo.bare, "show", `${String(pr?.body.head)}:hello.txt`)).toBe(
      "hello\nchanged",
    );
    expect((await readState(h.dir)).issues["issue-1"]).toMatchObject({
      status: "published",
      prUrl: "https://github.com/o/r/pull/1",
    });
    expect(existsSync(h.patchFile)).toBe(false);

    h.reply("issue-1", "/retry again please");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toBe(
      "`/retry` did nothing: it only works after a run, before it is published or discarded (current status: published).",
    );
  });

  it("keeps the result when publishing fails; branch_exists suggests /publish force, which works", async () => {
    const h = await awaiting();
    h.github.status = 422;
    h.reply("issue-1", "/publish");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toMatch(
      /^Publishing failed \(`github_api_error`\): .*422.*\n\nReply `\/publish` to try again\.$/s,
    );
    expect(await status(h.dir)).toBe("awaiting_approval");

    h.github.status = 201;
    h.reply("issue-1", "/publish");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toMatch(
      /^Publishing failed \(`branch_exists`\): .*\n\nReply `\/publish force` to overwrite the branch\.$/s,
    );
    expect(await status(h.dir)).toBe("awaiting_approval");

    h.reply("issue-1", "/publish force");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/2");
    expect(await status(h.dir)).toBe("published");
  });

  it("/discard drops the result and deletes the patch", async () => {
    const h = await awaiting();
    h.reply("issue-1", "/discard");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toBe("Discarded. Nothing was published.");
    expect(await status(h.dir)).toBe("discarded");
    expect(existsSync(h.patchFile)).toBe(false);
    expect(h.github.pulls).toEqual([]);
  });

  it("handles a command only once when the issue is polled again", async () => {
    const h = await awaiting();
    h.reply("issue-1", "/discard");
    await step(h.d);
    const count = h.linear.posted.length;
    h.clock.advance(1000);
    h.linear.update("issue-1", { title: "Edited" });
    await step(h.d);
    expect(h.linear.posted).toHaveLength(count);
  });

  it("/retry reruns with the reviewer's feedback appended to the task", async () => {
    const h = await awaiting({ agent: fakeAgent("noop") });
    const firstRun = (await readState(h.dir)).issues["issue-1"]?.run?.id;
    h.reply("issue-1", "/retry Use a capital letter.\nAnd keep it short.");
    await step(h.d);

    const said = h.linear.said("issue-1");
    expect(said).toContain("Queued for autoforge again with your feedback (position 1).");
    expect(said.at(-1)).toContain("without changing any files");
    const entry = (await readState(h.dir)).issues["issue-1"];
    expect(entry?.feedback).toBe("Use a capital letter.\nAnd keep it short.");
    expect(entry?.run?.id).not.toBe(firstRun);
    expect(entry?.run?.task).toMatch(
      /\n\nFeedback from the reviewer on the previous attempt:\nUse a capital letter\.\nAnd keep it short\.$/,
    );
    expect(entry?.run?.task).not.toContain("/retry");
    expect(entry?.run?.task).not.toContain("Queued for autoforge");
  });

  it("/retry from a waiting result deletes the old patch and runs again", async () => {
    const h = await awaiting();
    h.reply("issue-1", "/retry");
    await step(h.d);
    expect(h.linear.said("issue-1")).toContain("Queued for autoforge again (position 1).");
    expect(existsSync(h.patchFile)).toBe(false);
    expect(await status(h.dir)).toBe("awaiting_approval");
  });

  it("ignores commands from other people", async () => {
    const h = await awaiting();
    h.reply("issue-1", "/discard", OTHER);
    await step(h.d);
    expect(h.linear.said("issue-1")).toHaveLength(3);
    expect(await status(h.dir)).toBe("awaiting_approval");
  });

  it("never fires a command written before the issue was picked up", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    h.linear.userComment("issue-1", "/discard");
    const d = h.make();
    await d.start();
    await step(d);
    h.clock.advance(1000);
    h.linear.update("issue-1", { title: "Edited" });
    await step(d);
    expect(h.linear.said("issue-1")).toHaveLength(3);
    expect(await status(h.dir)).toBe("awaiting_approval");
  });

  it("replies once, in one line, to a valid command in the wrong state", async () => {
    const h = await awaiting({ agent: fakeAgent("noop") });
    h.reply("issue-1", "/publish");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toBe(
      "`/publish` did nothing: it only works while a result is waiting for approval (current status: no changes).",
    );
    h.reply("issue-1", "/discard");
    await step(h.d);
    expect(h.linear.said("issue-1").at(-1)).toBe(
      "`/discard` did nothing: it only works while a result is waiting for approval (current status: no changes).",
    );
    expect(h.linear.said("issue-1")).toHaveLength(5);
    expect(await status(h.dir)).toBe("no_changes");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/daemon-commands.test.ts`
Expected: FAIL. The "/publish opens a draft PR" test fails with `expected 'autoforge finished on ...' to be 'Draft PR opened: ...'` (commands are not handled yet).

- [ ] **Step 3: Implement commands in `src/serve/daemon.ts`**

3a. Replace the import block at the top of the file with:

```ts
import { mkdir } from "node:fs/promises";
import { publishToGitHub, PublishError } from "../github.js";
import { makeRedactor } from "../redact.js";
import { run, type RunResult } from "../run.js";
import type { Sandbox } from "../sandbox.js";
import { readSecrets, type AgentConfig, type Config, type Secrets } from "./config.js";
import { LinearError, type LinearApi, type LinearIssue } from "./linear.js";
import { MARKER, parseCommand, renderTask, type Command } from "./prompt.js";
import { routeIssue } from "./route.js";
import {
  deletePatch,
  loadState,
  readPatch,
  saveState,
  writePatch,
  type IssueEntry,
  type IssueStatus,
  type State,
} from "./state.js";
```

3b. Directly below the line `const RETRY_HINT = "Reply \`/retry <feedback>\` to run it again with your feedback.";` add:

```ts
export type CommandOutcome = { ok: boolean; message: string };

const VALID_WHEN: Record<Command["kind"], string> = {
  publish: "while a result is waiting for approval",
  discard: "while a result is waiting for approval",
  retry: "after a run, before it is published or discarded",
};
```

3c. Directly below the field `private readonly jobs = new Map<string, Job>();` add:

```ts
  private readonly publishes = new Set<Promise<void>>();
```

3d. Replace the whole `idle()` method with:

```ts
  /** Resolves once no run or publish is in flight. */
  async idle(): Promise<void> {
    while (this.jobs.size || this.publishes.size) {
      await Promise.all([...[...this.jobs.values()].map((j) => j.done), ...this.publishes]);
    }
    await this.saving;
  }
```

3e. In `handleIssue`, replace the line

```ts
if (entry) return; // an issue already in state is never picked up twice
```

with

```ts
if (entry && picked && open) return this.handleComments(issue, entry);
if (entry) return; // an issue already in state is never picked up twice
```

3f. Insert these methods directly above the comment line `  /** Posts a daemon comment. A failure goes to the outbox. \`gate\` moves the command window. */`:

```ts
  private async handleComments(issue: LinearIssue, entry: IssueEntry): Promise<void> {
    for (const c of issue.comments) {
      if (entry.handledCommentIds.includes(c.id) || c.user?.id !== this.state.viewerId) continue;
      const gate = entry.lastResultCommentAt;
      if (!gate || Date.parse(c.createdAt) <= Date.parse(gate)) continue;
      const command = parseCommand(c.body);
      if (!command) continue;
      entry.handledCommentIds.push(c.id);
      this.log("info", "command", `/${command.kind}`, issue.identifier);
      await this.apply(issue.id, command, true);
    }
  }

  private entryOf(issueId: string): IssueEntry | undefined {
    return Object.hasOwn(this.state.issues, issueId) ? this.state.issues[issueId] : undefined;
  }

  /** Same checks for Linear comments and the status endpoint. `reply` comments on a wrong state. */
  private async apply(
    issueId: string,
    command: Command,
    reply: boolean,
  ): Promise<CommandOutcome | null> {
    const entry = this.entryOf(issueId);
    if (!entry) return null;
    const valid =
      command.kind === "retry"
        ? RETRYABLE.includes(entry.status)
        : entry.status === "awaiting_approval";
    if (!valid) {
      const message = `\`/${command.kind}\` did nothing: it only works ${VALID_WHEN[command.kind]} (current status: ${entry.status.replaceAll("_", " ")}).`;
      if (reply) await this.post(issueId, message);
      return { ok: false, message };
    }
    if (command.kind === "publish") {
      this.startPublish(issueId, entry, command.force);
      return { ok: true, message: "publishing" };
    }
    if (entry.status === "awaiting_approval" && entry.run) {
      await deletePatch(this.o.stateDir, entry.run.id);
    }
    if (command.kind === "discard") {
      this.set(entry, { status: "discarded" });
      await this.post(issueId, "Discarded. Nothing was published.");
      return { ok: true, message: "discarded" };
    }
    const now = this.now().toISOString();
    this.set(entry, {
      status: "queued",
      feedback: command.feedback,
      interruptions: 0,
      queuedAt: now,
      waiting: undefined,
    });
    const why = command.feedback ? " with your feedback" : "";
    await this.post(
      issueId,
      `Queued for autoforge again${why} (position ${this.position(issueId)}).`,
      true,
    );
    return { ok: true, message: "queued" };
  }

  private startPublish(id: string, entry: IssueEntry, force: boolean): void {
    this.set(entry, { status: "publishing" });
    const done = (async () => {
      await this.save();
      try {
        const patch = entry.run ? await readPatch(this.o.stateDir, entry.run.id) : null;
        if (!entry.run || patch === null) {
          throw new PublishError("invalid_result", "the stored patch is missing");
        }
        const out = await publishToGitHub(
          { ...entry.run, patch, logs: "" },
          {
            repo: entry.repo,
            token: this.secrets.githubToken,
            base: entry.ref,
            force,
            gitUrl: this.repoUrl(entry.repo),
            apiUrl: this.o.github?.apiUrl,
            fetch: this.o.github?.fetch,
            signal: this.stopping.signal,
          },
        );
        await deletePatch(this.o.stateDir, entry.run.id);
        this.set(entry, { status: "published", prUrl: out.prUrl });
        this.log("info", "published", out.prUrl, entry.identifier);
        await this.post(id, `Draft PR opened: ${out.prUrl}`);
        await this.o.linear
          .attachUrl(id, out.prUrl, "Draft PR (autoforge)")
          .catch((e) => this.log("warn", "attach_failed", errorMessage(e), entry.identifier));
      } catch (e) {
        if (this.stopping.signal.aborted) return; // stays "publishing"; the next start hands it back
        const code = e instanceof PublishError ? e.code : "error";
        const hint =
          code === "branch_exists"
            ? "Reply `/publish force` to overwrite the branch."
            : "Reply `/publish` to try again.";
        this.set(entry, { status: "awaiting_approval" });
        this.log("warn", "publish_failed", `${code}: ${errorMessage(e)}`, entry.identifier);
        await this.post(id, `Publishing failed (\`${code}\`): ${errorMessage(e)}\n\n${hint}`);
      }
      await this.save();
    })()
      .catch((e) => this.log("error", "publish_handler_failed", errorMessage(e), entry.identifier))
      .finally(() => this.publishes.delete(done));
    this.publishes.add(done);
  }

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/serve/daemon-commands.test.ts test/serve/daemon-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && chop pnpm lint && chop pnpm typecheck
git add src/serve/daemon.ts test/serve/daemon-commands.test.ts
git commit -F - <<'MSG'
feat(serve): /publish, /discard and /retry commands from the viewer's comments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Lifecycle edge cases (unassign, abort, expiry, daily limit, Docker pause, restarts, corrupt state)

**Files:**

- Modify: `src/serve/daemon.ts`
- Test: `test/serve/daemon-lifecycle.test.ts`

**Interfaces:**

- Consumes: Task 3 `loadState` (`corruptPath`), `saveState`, `deletePatch`; Task 5 and 6 `Daemon` internals; SDK `SandboxUnavailableError`, `Sandbox`, `SandboxSession`; test helpers.
- Produces (all private to `Daemon`): `recover()`, `release(id, entry, picked)`, `expire()`, the field `dockerDown`, and a `schedule()` that applies `dailyRunLimit` and the Docker pause. No public interface changes.

- [ ] **Step 1: Write the failing test**

`test/serve/daemon-lifecycle.test.ts`:

```ts
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxUnavailableError, type Sandbox, type SandboxSession } from "../../src/sandbox.js";
import { saveState } from "../../src/serve/state.js";
import { fakeAgent } from "../fake-agent.js";
import { TempDirSandbox } from "../temp-dir-sandbox.js";
import { ME, OTHER } from "./fake-linear.js";
import { readState, setup, step } from "./harness.js";

const DAY = 86_400_000;
const RETRY = "Reply `/retry <feedback>` to run it again with your feedback.";
const WHY = "the issue was unassigned, lost its pickup label or was closed";

class FlakySandbox implements Sandbox {
  down = true;
  private readonly inner = new TempDirSandbox();

  async create(): Promise<SandboxSession> {
    if (this.down) throw new SandboxUnavailableError("Docker is not running.");
    return this.inner.create();
  }
}

describe("daemon lifecycle", () => {
  it("drops a queued issue that gets unassigned", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    h.linear.addIssue({ id: "issue-2" });
    const d = h.make();
    await d.start();
    await step(d);
    h.clock.advance(1000);
    h.linear.update("issue-2", { assigneeId: OTHER.id });
    await step(d);
    expect(h.linear.said("issue-2")).toEqual([
      "Queued for autoforge (position 2).",
      `Removed from the autoforge queue: ${WHY}.`,
    ]);
    expect((await readState(h.dir)).issues["issue-2"]).toBeUndefined();
  });

  it("aborts a running issue that gets unassigned, and starts over when reassigned", async () => {
    const h = await setup({ agent: fakeAgent("sleep") });
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await d.tick();
    h.clock.advance(1000);
    h.linear.update("issue-1", { assigneeId: OTHER.id });
    await step(d);
    const said = h.linear.said("issue-1");
    expect(said).toContain(`autoforge stopped the run: ${WHY}.`);
    expect(said.some((s) => /^autoforge (finished|failed|stopped on)/.test(s))).toBe(false);
    expect((await readState(h.dir)).issues["issue-1"]).toBeUndefined();

    h.clock.advance(1000);
    h.linear.update("issue-1", { assigneeId: ME.id });
    await d.tick();
    expect(
      h.linear.said("issue-1").filter((s) => s === "Queued for autoforge (position 1)."),
    ).toHaveLength(2);
    await d.stop();
  });

  it("forgets a discarded issue when its label is removed, and starts over when it is added again", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    h.reply("issue-1", "/discard");
    await step(d);
    h.clock.advance(1000);
    h.linear.update("issue-1", { labels: [] });
    await step(d);
    expect((await readState(h.dir)).issues["issue-1"]).toBeUndefined();

    h.clock.advance(1000);
    h.linear.update("issue-1", { labels: ["autoforge"] });
    await step(d);
    expect(
      h.linear.said("issue-1").filter((s) => s === "Queued for autoforge (position 1)."),
    ).toHaveLength(2);
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("awaiting_approval");
  });

  it("discards a result nobody answered within approvalExpiryDays", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    const runId = (await readState(h.dir)).issues["issue-1"]?.run?.id;

    h.clock.advance(14 * DAY);
    await step(d);
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("awaiting_approval");

    h.clock.advance(1000);
    await step(d);
    expect(h.linear.said("issue-1").at(-1)).toBe("Discarded: no reply within 14 days.");
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("discarded");
    expect(existsSync(join(h.dir, "patches", `${runId}.patch`))).toBe(false);
  });

  it("keeps issues queued over the daily limit, says so once, and runs them the next day", async () => {
    const h = await setup({ config: { dailyRunLimit: 1 } });
    h.linear.addIssue({ id: "issue-1" });
    h.linear.addIssue({ id: "issue-2" });
    const d = h.make();
    await d.start();
    await step(d);
    await step(d);
    const limit =
      "The daily run limit (1) is reached. This issue stays queued and starts tomorrow.";
    expect(h.linear.said("issue-2")).toEqual(["Queued for autoforge (position 2).", limit]);
    await step(d);
    expect(h.linear.said("issue-2")).toHaveLength(2);
    expect((await readState(h.dir)).issues["issue-2"]?.status).toBe("queued");

    h.clock.advance(DAY);
    await step(d);
    const state = await readState(h.dir);
    expect(state.issues["issue-2"]?.status).toBe("awaiting_approval");
    expect(state.dailyRuns.count).toBe(1);
  });

  it("pauses the queue while Docker is down, says so once per issue, and resumes", async () => {
    const h = await setup();
    const sandbox = new FlakySandbox();
    h.linear.addIssue({ id: "issue-1" });
    h.linear.addIssue({ id: "issue-2" });
    const d = h.make({ sandbox: () => sandbox });
    await d.start();
    await step(d);
    const waiting =
      "Waiting for Docker: it is not running. The run starts by itself once Docker is back.";
    expect(h.linear.said("issue-1")).toEqual(["Queued for autoforge (position 1).", waiting]);
    expect(h.linear.said("issue-2")).toEqual(["Queued for autoforge (position 2).", waiting]);
    let state = await readState(h.dir);
    expect(state.issues["issue-1"]?.status).toBe("queued");
    expect(state.dailyRuns.count).toBe(0);
    expect(h.linear.started).toEqual([]);

    await step(d);
    expect(h.linear.posted).toHaveLength(4);

    sandbox.down = false;
    await step(d);
    expect(h.linear.said("issue-1")[2]).toBe("Running on `o/r@main` in a sandbox.");
    state = await readState(h.dir);
    expect(state.issues["issue-1"]?.status).toBe("awaiting_approval");
    expect(state.dailyRuns.count).toBe(1);
  });

  it("re-queues a run interrupted by a restart once, then marks it failed", async () => {
    const h = await setup({ agent: fakeAgent("sleep") });
    h.linear.addIssue({ id: "issue-1" });
    const d1 = h.make();
    await d1.start();
    await d1.tick();
    await d1.stop();
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("running");

    const d2 = h.make();
    await d2.start();
    expect(h.linear.said("issue-1").at(-1)).toBe(
      "autoforge restarted during the run, so the issue is queued again.",
    );
    expect((await readState(h.dir)).issues["issue-1"]).toMatchObject({
      status: "queued",
      interruptions: 1,
    });
    await d2.tick();
    await d2.stop();

    const d3 = h.make();
    await d3.start();
    expect(h.linear.said("issue-1").at(-1)).toBe(
      `autoforge was interrupted twice while running this issue and stopped trying.\n\n${RETRY}`,
    );
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("failed");
  });

  it("hands an interrupted publish back for another /publish", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d1 = h.make();
    await d1.start();
    await step(d1);
    await d1.stop();
    const state = await readState(h.dir);
    const entry = state.issues["issue-1"];
    if (!entry) throw new Error("no entry");
    await saveState(h.dir, { ...state, issues: { "issue-1": { ...entry, status: "publishing" } } });

    const d2 = h.make();
    await d2.start();
    expect(h.linear.said("issue-1").at(-1)).toBe(
      "autoforge restarted while publishing, so the pull request may or may not have been opened. Reply `/publish` to try again; if the branch already exists the reply says so, and `/publish force` overwrites it.",
    );
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("awaiting_approval");

    h.reply("issue-1", "/publish");
    await step(d2);
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");
  });

  it("moves a corrupt state file aside, logs it and starts fresh", async () => {
    const h = await setup();
    await writeFile(join(h.dir, "state.json"), "{ not json");
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: "error", event: "state_corrupt" }),
    );
    expect((await readdir(h.dir)).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    await step(d);
    const state = await readState(h.dir);
    expect(state.viewerId).toBe(ME.id);
    expect(state.issues["issue-1"]?.status).toBe("awaiting_approval");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/daemon-lifecycle.test.ts`
Expected: FAIL. Every test fails on its first lifecycle assertion, for example `expected [ 'Queued for autoforge (position 2).' ] to deeply equal [ ..., 'Removed from the autoforge queue: ...' ]`.

- [ ] **Step 3: Implement the lifecycle in `src/serve/daemon.ts`**

3a. Directly below the field `private retryAfterMs: number | undefined;` add:

```ts
  private dockerDown = false;
```

3b. In `start()`, replace

```ts
const { state } = await loadState(this.o.stateDir, this.now());
this.state = state;
this.state.viewerId = (await this.o.linear.viewer()).id;
await this.save();
```

with

```ts
const { state, corruptPath } = await loadState(this.o.stateDir, this.now());
this.state = state;
if (corruptPath) {
  this.log(
    "error",
    "state_corrupt",
    `state.json was unreadable; moved it to ${corruptPath} and started fresh`,
  );
}
this.state.viewerId = (await this.o.linear.viewer()).id;
await this.recover();
await this.save();
```

3c. In `tick()`, replace the line `      await this.schedule();` with:

```ts
await this.expire();
await this.schedule();
```

3d. In `handleIssue`, replace the line

```ts
if (entry) return; // an issue already in state is never picked up twice
```

with

```ts
if (entry) return this.release(issue.id, entry, picked);
```

3e. Insert these methods directly above the comment line `  /** Queued entries, oldest first. */`:

```ts
  /** After a restart: re-queue an interrupted run once, and hand an interrupted publish back. */
  private async recover(): Promise<void> {
    for (const [id, e] of Object.entries(this.state.issues)) {
      if (e.status === "running" && e.interruptions >= 1) {
        this.set(e, { status: "failed" });
        await this.post(
          id,
          `autoforge was interrupted twice while running this issue and stopped trying.\n\n${RETRY_HINT}`,
          true,
        );
      } else if (e.status === "running") {
        this.set(e, { status: "queued", interruptions: e.interruptions + 1 });
        await this.post(id, "autoforge restarted during the run, so the issue is queued again.");
      } else if (e.status === "publishing") {
        this.set(e, { status: "awaiting_approval" });
        await this.post(
          id,
          "autoforge restarted while publishing, so the pull request may or may not have been opened. Reply `/publish` to try again; if the branch already exists the reply says so, and `/publish force` overwrites it.",
        );
      }
    }
  }

  /** The issue no longer matches pickup (unassigned, label removed) or was closed. */
  private async release(id: string, entry: IssueEntry, picked: boolean): Promise<void> {
    const why = "the issue was unassigned, lost its pickup label or was closed";
    if (entry.status === "queued") {
      delete this.state.issues[id];
      await this.post(id, `Removed from the autoforge queue: ${why}.`);
    } else if (entry.status === "running") {
      const job = this.jobs.get(id);
      if (job) {
        job.dropped = true;
        job.abort.abort();
      }
      delete this.state.issues[id];
      await this.post(id, `autoforge stopped the run: ${why}.`);
    } else if (!picked && entry.status !== "publishing") {
      // Forgetting the entry is what lets "remove the label, add it again" start over.
      delete this.state.issues[id];
      if (entry.run) await deletePatch(this.o.stateDir, entry.run.id);
    }
  }

  private async expire(): Promise<void> {
    const days = this.o.config.approvalExpiryDays;
    for (const [id, e] of Object.entries(this.state.issues)) {
      if (e.status !== "awaiting_approval" || this.age(e) <= days * DAY) continue;
      if (e.run) await deletePatch(this.o.stateDir, e.run.id);
      this.set(e, { status: "discarded" });
      await this.post(id, `Discarded: no reply within ${days} days.`);
    }
  }

```

3f. Replace the whole `schedule()` method with:

```ts
  private async schedule(): Promise<void> {
    const { maxConcurrent, dailyRunLimit } = this.o.config;
    const today = localDate(this.now());
    if (this.state.dailyRuns.date !== today) this.state.dailyRuns = { date: today, count: 0 };
    for (const [id, e] of this.queue()) {
      if (this.jobs.has(id)) continue; // an aborted run for this issue is still winding down
      // While Docker is down, a single run at a time probes it.
      if (this.jobs.size >= maxConcurrent || (this.dockerDown && this.jobs.size > 0)) return;
      if (this.state.dailyRuns.count >= dailyRunLimit) {
        if (e.waiting !== "limit") {
          e.waiting = "limit";
          await this.post(
            id,
            `The daily run limit (${dailyRunLimit}) is reached. This issue stays queued and starts tomorrow.`,
          );
        }
        continue;
      }
      this.startRun(id, e);
    }
  }
```

3g. At the top of `announce()`, before the `moveToStarted` call, add:

```ts
this.dockerDown = false;
entry.waiting = undefined;
```

3h. In `finishRun()`, directly after the closing brace of the `if (result instanceof Error) { ... }` block, add:

```ts
if (result.reason === "sandbox_unavailable") {
  this.dockerDown = true;
  this.state.dailyRuns.count = Math.max(0, this.state.dailyRuns.count - 1);
  this.set(entry, { status: "queued" });
  this.log("warn", "docker_unavailable", result.message ?? "", entry.identifier);
  for (const [qid, q] of this.queue()) {
    if (q.waiting === "docker") continue;
    q.waiting = "docker";
    await this.post(
      qid,
      "Waiting for Docker: it is not running. The run starts by itself once Docker is back.",
    );
  }
  return;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/serve/`
Expected: PASS (all serve tests, including Tasks 5 and 6).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/daemon.ts test/serve/daemon-lifecycle.test.ts
git commit -F - <<'MSG'
feat(serve): unassign and abort, expiry, daily limit, Docker pause and restart recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 8: Status endpoint

**Files:**

- Create: `src/serve/status.ts`
- Modify: `src/serve/daemon.ts` (add `RunSummary`, `runs()`, `patch()`, `command()`)
- Test: `test/serve/status.test.ts`

**Interfaces:**

- Consumes: Task 6 `apply`, `entryOf`, `CommandOutcome`; Task 3 `readPatch`; Task 2 `Command`; test helpers.
- Produces:
  - `type RunSummary = { issueId: string; identifier: string; status: IssueStatus; repo: string; ref: string; queuedAt: string; updatedAt: string; prUrl?: string }` (from `daemon.ts`)
  - `Daemon.runs(): RunSummary[]`, `Daemon.patch(issueId: string): Promise<string | null>`, `Daemon.command(issueId: string, command: Command): Promise<CommandOutcome | null>`
  - `type StatusSource = Pick<Daemon, "runs" | "patch" | "command">`
  - `type StatusServer = { port: number; token: string; close(): Promise<void> }`
  - `startStatusServer(daemon: StatusSource, stateDir: string): Promise<StatusServer>` (writes `<stateDir>/status.json` `{ port, token, pid }` with mode 600; `close()` removes it)

- [ ] **Step 1: Write the failing test**

`test/serve/status.test.ts`:

```ts
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStatusServer, type StatusServer } from "../../src/serve/status.js";
import { readState, setup, step } from "./harness.js";

type Reply = { status: number; body: string };

function call(
  port: number,
  path: string,
  o: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server: StatusServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A daemon with one issue waiting for approval, and its status server. */
async function running() {
  const h = await setup();
  h.linear.addIssue({ id: "issue-1" });
  const d = h.make();
  await d.start();
  await step(d);
  server = await startStatusServer(d, h.dir);
  const auth = { Authorization: `Bearer ${server.token}` };
  return { ...h, d, port: server.port, auth };
}

describe("status endpoint", () => {
  it("writes status.json with mode 600 and removes it on close", async () => {
    const h = await running();
    const file = join(h.dir, "status.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const info = JSON.parse(await readFile(file, "utf8")) as { port: number; token: string };
    expect(info.port).toBe(h.port);
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    await server?.close();
    server = undefined;
    expect(existsSync(file)).toBe(false);
  });

  it("answers 401 without the right token and 403 to any request with an Origin", async () => {
    const h = await running();
    expect((await call(h.port, "/runs")).status).toBe(401);
    expect(
      (await call(h.port, "/runs", { headers: { Authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await call(h.port, "/runs", { headers: { ...h.auth, Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
  });

  it("lists runs without patches or logs, and serves a patch", async () => {
    const h = await running();
    const list = await call(h.port, "/runs", { headers: h.auth });
    expect(list.status).toBe(200);
    const runs = JSON.parse(list.body) as Record<string, unknown>[];
    expect(runs).toEqual([
      {
        issueId: "issue-1",
        identifier: "ENG-1",
        status: "awaiting_approval",
        repo: "o/r",
        ref: "main",
        queuedAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
      },
    ]);
    const patch = await call(h.port, "/runs/issue-1/patch", { headers: h.auth });
    expect(patch.status).toBe(200);
    expect(patch.body).toContain("+changed");
  });

  it("publishes like /publish, then refuses a discard in the wrong state", async () => {
    const h = await running();
    const res = await call(h.port, "/runs/issue-1/publish", { method: "POST", headers: h.auth });
    expect(res.status).toBe(202);
    await h.d.idle();
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");

    const discard = await call(h.port, "/runs/issue-1/discard", {
      method: "POST",
      headers: h.auth,
    });
    expect(discard.status).toBe(409);
    expect(JSON.parse(discard.body)).toEqual({
      ok: false,
      message:
        "`/discard` did nothing: it only works while a result is waiting for approval (current status: published).",
    });
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");
  });

  it("discards like /discard and posts the comment", async () => {
    const h = await running();
    const res = await call(h.port, "/runs/issue-1/discard", { method: "POST", headers: h.auth });
    expect(res.status).toBe(202);
    expect(h.linear.said("issue-1").at(-1)).toBe("Discarded. Nothing was published.");
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("discarded");
  });

  // Review Focus 5
  it.each([
    ["POST", "/runs/__proto__/publish", 404],
    ["POST", "/runs/constructor/discard", 404],
    ["POST", "/runs/unknown/publish", 404],
    ["GET", "/runs/__proto__/patch", 404],
    ["GET", "/runs/unknown/patch", 404],
    ["GET", "/runs/issue-1/publish", 405],
    ["POST", "/runs", 405],
    ["GET", "/nope", 404],
  ])("%s %s answers %i", async (method, path, expected) => {
    const h = await running();
    expect((await call(h.port, path, { method, headers: h.auth })).status).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/status.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/status.js".

- [ ] **Step 3: Add the daemon methods**

In `src/serve/daemon.ts`, directly below the `CommandOutcome` type add:

```ts
export type RunSummary = {
  issueId: string;
  identifier: string;
  status: IssueStatus;
  repo: string;
  ref: string;
  queuedAt: string;
  updatedAt: string;
  prUrl?: string;
};
```

Insert these methods directly above the line `  private tracked(e: IssueEntry): boolean {`:

```ts
  /** Issues in state, for the status endpoint. No patches, no logs. */
  runs(): RunSummary[] {
    return Object.entries(this.state.issues).map(([issueId, e]) => ({
      issueId,
      identifier: e.identifier,
      status: e.status,
      repo: e.repo,
      ref: e.ref,
      queuedAt: e.queuedAt,
      updatedAt: e.updatedAt,
      ...(e.prUrl ? { prUrl: e.prUrl } : {}),
    }));
  }

  async patch(issueId: string): Promise<string | null> {
    const run = this.entryOf(issueId)?.run;
    return run ? readPatch(this.o.stateDir, run.id) : null;
  }

  /** A command from the status endpoint: the same checks as a Linear comment, no reply comment. */
  async command(issueId: string, command: Command): Promise<CommandOutcome | null> {
    const outcome = await this.apply(issueId, command, false);
    await this.save();
    return outcome;
  }

```

- [ ] **Step 4: Write the status server**

`src/serve/status.ts`:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Daemon } from "./daemon.js";

export type StatusSource = Pick<Daemon, "runs" | "patch" | "command">;
export type StatusServer = { port: number; token: string; close(): Promise<void> };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Localhost-only API for `autoforge status` and the future menu-bar app. */
export async function startStatusServer(
  daemon: StatusSource,
  stateDir: string,
): Promise<StatusServer> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Browsers always send Origin on cross-site requests; nothing legitimate here does.
    if (req.headers.origin !== undefined)
      return send(res, 403, { error: "browser requests are refused" });
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return send(res, 401, { error: "missing or wrong token (see status.json)" });
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const m = /^\/runs(?:\/([^/]+)\/(patch|publish|discard))?$/.exec(path);
    if (!m) return send(res, 404, { error: "not found" });
    const [, rawId, action] = m;
    if (!rawId || !action) {
      return req.method === "GET"
        ? send(res, 200, daemon.runs())
        : send(res, 405, { error: "use GET" });
    }
    const issueId = decodeURIComponent(rawId);
    if (action === "patch") {
      if (req.method !== "GET") return send(res, 405, { error: "use GET" });
      const patch = await daemon.patch(issueId);
      if (patch === null) return send(res, 404, { error: "no patch for this issue" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(patch);
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "use POST" });
    const outcome = await daemon.command(
      issueId,
      action === "publish" ? { kind: "publish", force: false } : { kind: "discard" },
    );
    if (!outcome) return send(res, 404, { error: "unknown issue" });
    send(res, outcome.ok ? 202 : 409, outcome);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) =>
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const file = join(stateDir, "status.json");
  await rm(file, { force: true }); // so the mode below applies to a new file
  await writeFile(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  return {
    port,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(file, { force: true });
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/serve/status.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm fix && chop pnpm lint && chop pnpm typecheck
git add src/serve/status.ts src/serve/daemon.ts test/serve/status.test.ts
git commit -F - <<'MSG'
feat(serve): localhost status endpoint with token auth

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 9: Service install (launchd and systemd)

**Files:**

- Create: `src/serve/service.ts`
- Test: `test/serve/service.test.ts`

**Interfaces:**

- Consumes: SDK `proc(cmd, args, o)` and `ProcResult` from `src/proc.ts`.
- Produces:
  - `type ServiceTarget = { node: string; cli: string; home: string; path: string }`
  - `type Runner = (cmd: string, args: string[]) => Promise<ProcResult>`
  - `type ServiceOptions = ServiceTarget & { platform: NodeJS.Platform; uid: number; run?: Runner }`
  - `launchdPlist(t: ServiceTarget): string`, `systemdUnit(t: ServiceTarget): string`
  - `unitPath(o: { platform: NodeJS.Platform; home: string }): string`
  - `installService(o: ServiceOptions): Promise<string>` and `uninstallService(o: ServiceOptions): Promise<string>` (return the unit file path)

- [ ] **Step 1: Write the failing test**

`test/serve/service.test.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installService,
  launchdPlist,
  systemdUnit,
  uninstallService,
  type Runner,
} from "../../src/serve/service.js";

const mac = {
  node: "/opt/node 22/bin/node",
  cli: "/Users/a&b/lib/autoforge/dist/serve/cli.js",
  home: "/Users/a&b",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
};

const linux = {
  node: "/home/u/.nvm/versions/node/v22/bin/node",
  cli: "/home/u/my $apps/50%/cli.js",
  home: "/home/u",
  path: "/home/u/50%/bin:/usr/bin",
};

function recorder(fail?: string) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return line.startsWith(fail ?? "\0")
      ? { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("service units", () => {
  // Review Focus 4
  it("renders a launchd plist with the installer's PATH and escaped paths", () => {
    expect(launchdPlist(mac)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.autoforge.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node 22/bin/node</string>
    <string>/Users/a&amp;b/lib/autoforge/dist/serve/cli.js</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/a&amp;b/.autoforge/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/a&amp;b/.autoforge/daemon.log</string>
</dict>
</plist>
`);
  });

  // Review Focus 4
  it("renders a systemd user unit with the installer's PATH and escaped paths", () => {
    expect(systemdUnit(linux)).toBe(`[Unit]
Description=autoforge serve (Linear issues to pull requests)
After=network-online.target

[Service]
ExecStart="/home/u/.nvm/versions/node/v22/bin/node" "/home/u/my $$apps/50%%/cli.js" serve
Environment="PATH=/home/u/50%%/bin:/usr/bin"
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/.autoforge/daemon.log
StandardError=append:%h/.autoforge/daemon.log

[Install]
WantedBy=default.target
`);
  });
});

describe("installService", () => {
  it("installs on macOS: writes the plist, boots out any old copy, bootstraps", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { calls, run } = recorder("launchctl bootout");
    const file = await installService({ ...mac, home, platform: "darwin", uid: 501, run });
    expect(file).toBe(join(home, "Library", "LaunchAgents", "dev.autoforge.serve.plist"));
    expect(await readFile(file, "utf8")).toBe(launchdPlist({ ...mac, home }));
    expect(calls).toEqual([
      `launchctl bootout gui/501 ${file}`,
      `launchctl bootstrap gui/501 ${file}`,
    ]);
    expect((await stat(join(home, ".autoforge"))).isDirectory()).toBe(true);
  });

  it("fails with launchctl's message when bootstrap fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { run } = recorder("launchctl bootstrap");
    await expect(
      installService({ ...mac, home, platform: "darwin", uid: 501, run }),
    ).rejects.toThrow("Bootstrap failed: 5: Input/output error");
  });

  it("installs on Linux with systemctl --user", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { calls, run } = recorder();
    const file = await installService({ ...linux, home, platform: "linux", uid: 1000, run });
    expect(file).toBe(join(home, ".config", "systemd", "user", "autoforge.service"));
    expect(await readFile(file, "utf8")).toBe(systemdUnit({ ...linux, home }));
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now autoforge.service",
    ]);
  });

  it.each(["darwin", "linux"] as const)(
    "uninstalls on %s without touching ~/.autoforge data",
    async (platform) => {
      const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
      await mkdir(join(home, ".autoforge"));
      await writeFile(join(home, ".autoforge", "state.json"), "{}");
      const { calls, run } = recorder();
      const o = { ...linux, home, platform, uid: 1000, run };
      const file = await installService(o);
      expect(await uninstallService(o)).toBe(file);
      expect(existsSync(file)).toBe(false);
      expect(await readFile(join(home, ".autoforge", "state.json"), "utf8")).toBe("{}");
      expect(calls.at(-1)).toBe(
        platform === "darwin"
          ? `launchctl bootout gui/1000 ${file}`
          : "systemctl --user daemon-reload",
      );
    },
  );

  it("refuses other platforms", async () => {
    const { run } = recorder();
    await expect(installService({ ...linux, platform: "win32", uid: 0, run })).rejects.toThrow(
      "autoforge service supports macOS and Linux, not win32",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/service.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/service.js".

- [ ] **Step 3: Write the implementation**

`src/serve/service.ts`:

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { proc, type ProcResult } from "../proc.js";

export type ServiceTarget = {
  /** Absolute path of the node binary (process.execPath). */
  node: string;
  /** Absolute path of dist/serve/cli.js. */
  cli: string;
  home: string;
  /** The installer's PATH, so docker and git resolve under launchd and systemd. */
  path: string;
};

export type Runner = (cmd: string, args: string[]) => Promise<ProcResult>;

export type ServiceOptions = ServiceTarget & {
  platform: NodeJS.Platform;
  uid: number;
  run?: Runner;
};

const LABEL = "dev.autoforge.serve";
const UNIT = "autoforge.service";

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A double-quoted systemd value: backslash and quote escaped, `%` specifiers doubled. */
const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
/** ExecStart also expands `$VAR`, so `$` is doubled there. */
const execArg = (s: string) => quoted(s).replace(/\$/g, () => "$$");

export function launchdPlist(t: ServiceTarget): string {
  const log = xml(join(t.home, ".autoforge", "daemon.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(t.node)}</string>
    <string>${xml(t.cli)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(t.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnit(t: ServiceTarget): string {
  return `[Unit]
Description=autoforge serve (Linear issues to pull requests)
After=network-online.target

[Service]
ExecStart=${execArg(t.node)} ${execArg(t.cli)} serve
Environment=${quoted(`PATH=${t.path}`)}
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/.autoforge/daemon.log
StandardError=append:%h/.autoforge/daemon.log

[Install]
WantedBy=default.target
`;
}

export function unitPath(o: { platform: NodeJS.Platform; home: string }): string {
  if (o.platform === "darwin") return join(o.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (o.platform === "linux") return join(o.home, ".config", "systemd", "user", UNIT);
  throw new Error(`autoforge service supports macOS and Linux, not ${o.platform}`);
}

const defaultRun: Runner = (cmd, args) => proc(cmd, args, { env: process.env });

async function must(run: Runner, cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args);
  if (r.exitCode !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

/** Writes the unit and starts it. Re-running replaces a previous install. */
export async function installService(o: ServiceOptions): Promise<string> {
  const run = o.run ?? defaultRun;
  const file = unitPath(o);
  await mkdir(dirname(file), { recursive: true });
  // launchd and systemd open daemon.log here but do not create the folder.
  await mkdir(join(o.home, ".autoforge"), { recursive: true, mode: 0o700 });
  if (o.platform === "darwin") {
    await writeFile(file, launchdPlist(o));
    await run("launchctl", ["bootout", `gui/${o.uid}`, file]); // fails when not loaded; fine
    await must(run, "launchctl", ["bootstrap", `gui/${o.uid}`, file]);
  } else {
    await writeFile(file, systemdUnit(o));
    await must(run, "systemctl", ["--user", "daemon-reload"]);
    await must(run, "systemctl", ["--user", "enable", "--now", UNIT]);
  }
  return file;
}

/** Stops the daemon and removes the unit. ~/.autoforge is left alone. */
export async function uninstallService(o: ServiceOptions): Promise<string> {
  const run = o.run ?? defaultRun;
  const file = unitPath(o);
  if (o.platform === "darwin") {
    await run("launchctl", ["bootout", `gui/${o.uid}`, file]);
    await rm(file, { force: true });
  } else {
    await run("systemctl", ["--user", "disable", "--now", UNIT]);
    await rm(file, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  return file;
}
```

Note: in the uninstall test on darwin the last recorded call is the bootout from `uninstallService`; on Linux it is the final `daemon-reload`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add src/serve/service.ts test/serve/service.test.ts
git commit -F - <<'MSG'
feat(serve): launchd and systemd user service install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 10: CLI, `bin`, README and the manual end-to-end checklist

**Files:**

- Create: `src/serve/cli.ts`
- Modify: `package.json` (add `bin`)
- Modify: `README.md` (new section before `## Custom sandboxes`; Roadmap text)
- Test: `test/serve/cli.test.ts`

**Interfaces:**

- Consumes: Task 1 `loadConfig`, `readEnvFile`, `readSecrets`, `ConfigError`; Task 4 `LinearClient`; Task 5 `Daemon`; Task 8 `startStatusServer`, `RunSummary`; Task 9 `installService`, `uninstallService`; SDK `DockerSandbox` from `src/docker.ts`.
- Produces:
  - `type CliIo = { out: (line: string) => void; err: (line: string) => void; env: Record<string, string | undefined>; signal?: AbortSignal; fetch?: typeof fetch }`
  - `main(argv: string[], io: CliIo): Promise<number>` (exit code: 0 ok, 1 runtime or config error, 2 usage)
  - the `autoforge` executable (`dist/serve/cli.js`)

- [ ] **Step 1: Write the failing test**

`test/serve/cli.test.ts`:

```ts
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/serve/cli.js";
import { startStatusServer } from "../../src/serve/status.js";

function capture(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, ...extra };
  return { out, err, io };
}

const tempDir = () => mkdtemp(join(tmpdir(), "autoforge-cli-"));
const config = { defaultRepo: "o/r", agent: { image: "autoforge-claude", command: ["true"] } };

async function withConfig(raw: unknown = config): Promise<string> {
  const d = await tempDir();
  await writeFile(join(d, "config.json"), JSON.stringify(raw));
  return d;
}

const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("autoforge cli", () => {
  it("prints usage for --help, unknown commands and unknown flags", async () => {
    const help = capture();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out[0]).toContain("autoforge serve [--dir <path>]");
    const unknown = capture();
    expect(await main(["fly"], unknown.io)).toBe(2);
    expect(unknown.err[0]).toContain("Usage:");
    const flag = capture();
    expect(await main(["serve", "--nope"], flag.io)).toBe(2);
  });

  it("serve explains a missing config.json", async () => {
    const d = await tempDir();
    const t = capture();
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toContain(`${join(d, "config.json")} not found`);
  });

  it("serve names the invalid config field", async () => {
    const d = await withConfig({ ...config, pollSeconds: 1 });
    const t = capture({ env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err).toEqual(["config.pollSeconds must be an integer of at least 10"]);
  });

  it("serve refuses an env file that others can read", async () => {
    const d = await withConfig();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=k\n");
    await chmod(join(d, "env"), 0o644);
    const t = capture();
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toContain(`Run: chmod 600 ${join(d, "env")}`);
  });

  it("serve requires LINEAR_API_KEY", async () => {
    const d = await withConfig();
    const t = capture({ env: { GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toBe(
      "LINEAR_API_KEY is not set. Put it in ~/.autoforge/env or the environment.",
    );
  });

  it("serve reads the env file, polls Linear, serves status and shuts down on abort", async () => {
    const d = await withConfig();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=lin_key\nGITHUB_TOKEN=gh_key\n", {
      mode: 0o600,
    });
    const stop = new AbortController();
    const auth: string[] = [];
    let statusDuringPoll = false;
    const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      auth.push(new Headers(init.headers).get("authorization") ?? "");
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("viewer")) return gql({ viewer: { id: "u1", name: "Me" } });
      statusDuringPoll = existsSync(join(d, "status.json"));
      stop.abort();
      return gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    }) as typeof globalThis.fetch;
    const t = capture({ signal: stop.signal, fetch });

    expect(await main(["serve", "--dir", d], t.io)).toBe(0);
    expect(auth).toEqual(["lin_key", "lin_key"]);
    expect(statusDuringPoll).toBe(true);
    expect(existsSync(join(d, "status.json"))).toBe(false);
    const state = JSON.parse(await readFile(join(d, "state.json"), "utf8")) as { viewerId: string };
    expect(state.viewerId).toBe("u1");
    expect(t.out.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      "started",
      "stopped",
    ]);
  });

  it("status says when the daemon is not running", async () => {
    const t = capture();
    expect(await main(["status", "--dir", await tempDir()], t.io)).toBe(1);
    expect(t.err).toEqual(["autoforge serve is not running (no status.json)."]);
  });

  it("status prints one line per issue", async () => {
    const d = await tempDir();
    const server = await startStatusServer(
      {
        runs: () => [
          {
            issueId: "i1",
            identifier: "ENG-1",
            status: "awaiting_approval",
            repo: "o/r",
            ref: "main",
            queuedAt: "2026-10-09T12:00:00.000Z",
            updatedAt: "2026-10-09T12:00:00.000Z",
          },
          {
            issueId: "i2",
            identifier: "ENG-2",
            status: "published",
            repo: "o/r",
            ref: "main",
            queuedAt: "2026-10-09T12:00:00.000Z",
            updatedAt: "2026-10-09T12:00:00.000Z",
            prUrl: "https://github.com/o/r/pull/1",
          },
        ],
        patch: async () => null,
        command: async () => null,
      },
      d,
    );
    try {
      const t = capture();
      expect(await main(["status", "--dir", d], t.io)).toBe(0);
      expect(t.out).toEqual([
        "ENG-1  awaiting_approval  o/r@main",
        "ENG-2  published  o/r@main  https://github.com/o/r/pull/1",
      ]);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/serve/cli.test.ts`
Expected: FAIL with "Failed to load url ../../src/serve/cli.js".

- [ ] **Step 3: Write the CLI**

`src/serve/cli.ts`:

```ts
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DockerSandbox } from "../docker.js";
import { ConfigError, loadConfig, readEnvFile, readSecrets } from "./config.js";
import { Daemon, type RunSummary } from "./daemon.js";
import { LinearClient } from "./linear.js";
import { installService, uninstallService } from "./service.js";
import { startStatusServer } from "./status.js";

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Stops `serve`, like SIGINT and SIGTERM do. */
  signal?: AbortSignal;
  /** Used for Linear and for `status`. */
  fetch?: typeof fetch;
};

const USAGE = `Usage:
  autoforge serve [--dir <path>]     run the Linear daemon in the foreground
  autoforge status [--dir <path>]    list the issues the daemon knows about
  autoforge service install          run the daemon at login (launchd or systemd)
  autoforge service uninstall        stop the daemon and remove the service

--dir defaults to ~/.autoforge (config.json, env, state).`;

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
  });

export async function main(argv: string[], io: CliIo): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    io.err(`${errorMessage(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    io.out(USAGE);
    return 0;
  }
  const dir = args.values.dir ?? join(homedir(), ".autoforge");
  const command = args.positionals.join(" ");
  try {
    if (command === "serve") return await serve(dir, io);
    if (command === "status") return await status(dir, io);
    if (command === "service install") return await service(false, io);
    if (command === "service uninstall") return await service(true, io);
  } catch (e) {
    io.err(e instanceof ConfigError ? e.message : `autoforge: ${errorMessage(e)}`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}

async function serve(dir: string, io: CliIo): Promise<number> {
  // The process environment wins over the env file.
  const env = { ...(await readEnvFile(dir)), ...io.env };
  const config = await loadConfig(dir);
  const { linearApiKey } = readSecrets(config, env);
  const log = (entry: object) =>
    io.out(JSON.stringify({ time: new Date().toISOString(), ...entry }));
  const daemon = new Daemon({
    config,
    env,
    stateDir: dir,
    linear: new LinearClient({ apiKey: linearApiKey, fetch: io.fetch }),
    sandbox: (agent) => new DockerSandbox({ image: agent.image }),
    log,
  });
  await daemon.start();
  const server = await startStatusServer(daemon, dir);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  io.signal?.addEventListener("abort", onSignal, { once: true });
  log({
    level: "info",
    event: "started",
    message: `polling Linear every ${config.pollSeconds} s; status on 127.0.0.1:${server.port}`,
  });
  try {
    while (!stop.signal.aborted) {
      await daemon.tick();
      await sleep(daemon.nextDelayMs(), undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await daemon.stop();
    await server.close();
  }
  log({ level: "info", event: "stopped", message: "autoforge serve stopped" });
  return 0;
}

async function status(dir: string, io: CliIo): Promise<number> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as typeof info;
  } catch {
    io.err("autoforge serve is not running (no status.json).");
    return 1;
  }
  let runs: RunSummary[];
  try {
    const res = await (io.fetch ?? fetch)(`http://127.0.0.1:${info.port}/runs`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    runs = (await res.json()) as RunSummary[];
  } catch (e) {
    io.err(`autoforge serve is not reachable: ${errorMessage(e)}`);
    return 1;
  }
  if (!runs.length) io.out("No issues yet.");
  for (const r of runs) {
    io.out([r.identifier, r.status, `${r.repo}@${r.ref}`, r.prUrl ?? ""].join("  ").trimEnd());
  }
  return 0;
}

async function service(uninstall: boolean, io: CliIo): Promise<number> {
  const home = homedir();
  const o = {
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
    home,
    path: io.env.PATH ?? "/usr/bin:/bin",
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
  };
  if (uninstall) {
    io.out(`Removed ${await uninstallService(o)}. ~/.autoforge was left alone.`);
    return 0;
  }
  io.out(`Installed and started ${await installService(o)}.`);
  io.out(
    `Secrets go in ${join(home, ".autoforge", "env")} (chmod 600). Logs: ${join(home, ".autoforge", "daemon.log")}.`,
  );
  return 0;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/serve/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `bin` entry**

In `package.json`, replace

```json
  "files": [
    "dist"
  ],
```

with

```json
  "files": [
    "dist"
  ],
  "bin": {
    "autoforge": "./dist/serve/cli.js"
  },
```

Run: `pnpm build && chop node dist/serve/cli.js --help; echo "exit $?"; node dist/serve/cli.js status --dir "$(mktemp -d)"; echo "exit $?"`
Expected: the usage text and `exit 0`, then `autoforge serve is not running (no status.json).` and `exit 1`. `head -1 dist/serve/cli.js` prints `#!/usr/bin/env node`.

- [ ] **Step 6: Document `autoforge serve` in the README**

In `README.md`, insert this section directly above `## Custom sandboxes`:

````markdown
## autoforge serve: assign a Linear issue, get a PR

`autoforge serve` is a local daemon. It watches Linear for issues assigned to you and labelled
`autoforge`, runs each one in the Docker sandbox, posts the result on the issue, and opens a
draft PR when you reply `/publish`.

### Set up

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

4. Run `autoforge serve` in a terminal, or `autoforge service install` to start it at login
   (launchd on macOS, a systemd user unit on Linux; logs go to `~/.autoforge/daemon.log`).
   `autoforge service uninstall` removes the service and leaves `~/.autoforge` alone.

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
`approvalExpiryDays`. To start an issue over, remove the label and add it again.

The repo comes from a `repo:owner/name` or `repo:owner/name@branch` label, then a project
rule, then a team rule, then `defaultRepo`.

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
````

Then replace the Roadmap paragraph

```markdown
Next: `autoforge serve`, a local daemon that picks up Linear issues assigned to you, runs them,
and links the PR back on the issue.
```

with

```markdown
Next: a menu-bar app on top of the `autoforge serve` status endpoint.
```

- [ ] **Step 7: Full verification**

Run: `pnpm fix && chop pnpm lint && chop pnpm format && chop pnpm typecheck && chop pnpm build && chop pnpm test`
Expected: all pass. The serve tests never touch the network (Linear and GitHub are stubbed; the status tests use 127.0.0.1 only).

- [ ] **Step 8: Commit**

```bash
git add src/serve/cli.ts test/serve/cli.test.ts package.json README.md
git commit -F - <<'MSG'
feat(serve): autoforge CLI (serve, status, service) and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

- [ ] **Step 9: Hand the manual end-to-end checklist to the controller**

Do not create a file for it. The controller pastes this into the PR description and runs it
against a real Linear test team and a throwaway repo before merge:

```markdown
## Manual end-to-end checklist (real Linear test team, throwaway repo)

Setup

- [ ] Throwaway repo `<you>/autoforge-e2e` with a README; `docker build -t autoforge-claude examples`
- [ ] `~/.autoforge/config.json` with `defaultRepo` = the throwaway repo, `pollSeconds` 10
- [ ] `~/.autoforge/env` with LINEAR_API_KEY, GITHUB_TOKEN (fine-grained, this repo only), ANTHROPIC_API_KEY
- [ ] `chmod 644 ~/.autoforge/env`: `autoforge serve` refuses with the chmod hint; back to 600

Happy path

- [ ] `autoforge serve` logs `started`
- [ ] New issue "Fix a typo in README", assigned to me, label `autoforge`: "Queued (position 1)", issue moves to the first started state, "Running on ...", result with the patch excerpt
- [ ] Issue with a `repo:<you>/autoforge-e2e@main` label routes there
- [ ] A second Linear user comments `/publish`: nothing happens
- [ ] I reply `/retry make it shorter`: queued again, new result, the run's task ends with the feedback
- [ ] I reply `/publish`: draft PR in the repo, "Draft PR opened" comment, PR attached on the issue
- [ ] I reply `/publish` again: one-line wrong-state reply

Linear API assumptions (unverified by unit tests)

- [ ] The `or` filter with `id: { in: [...] }` is accepted, and an issue unassigned while queued is dropped with a comment
- [ ] A new comment is seen within one poll on an issue with more than a few comments (`comments(first: 100)` order)
- [ ] `attachmentCreate` shows the PR link on the issue

Lifecycle

- [ ] New issue, `/discard`: "Discarded"; remove and re-add the label: starts over
- [ ] Unassign an issue while it runs: "stopped the run", no result comment
- [ ] Quit Docker, label an issue: one "Waiting for Docker" comment; start Docker: it runs
- [ ] Ctrl-C the daemon mid-run, start it again: "restarted during the run", runs again
- [ ] `dailyRunLimit` 1 with two issues: the second waits with one comment

Status and service

- [ ] `autoforge status` lists the issues
- [ ] `curl http://127.0.0.1:<port>/runs` without the token: 401; with `-H "Origin: x"`: 403
- [ ] `autoforge service install`: daemon runs under launchd (or `systemctl --user status autoforge`), `daemon.log` fills, docker is found
- [ ] Log out and in (or reboot): still running; `autoforge service uninstall`: gone, `~/.autoforge` intact
- [ ] `grep` daemon.log and the issue comments for each secret: no hits
```

---

## Execution notes

- Tasks run in order; each one's tests stay green afterwards (`pnpm vitest run test/serve/`).
- Tasks 5 to 8 edit `src/serve/daemon.ts` in place. Each edit names an exact anchor line; if an
  anchor is missing, re-read the file rather than guessing, since an earlier step was skipped.
- Daemon tests spawn real git and `sh` processes through `TempDirSandbox`; they need git 2.31+
  on the host, like the slice 1 tests.
