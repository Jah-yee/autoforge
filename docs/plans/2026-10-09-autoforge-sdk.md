# autoforge SDK (slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `autoforge` TypeScript SDK: `run()` drives a bring-your-own coding agent inside a sandbox and returns a serializable patch; `publishToGitHub()` turns that patch into a draft PR from the host.

**Architecture:** A zero-dependency ESM package. `run()` talks to a small `Sandbox` interface; `DockerSandbox` implements it through the `docker` CLI. All process spawning goes through one helper (`src/proc.ts`). Publishing happens on the host in a temp git repo, so push credentials never reach the sandbox.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Node 22+, pnpm, Vitest, ESLint (typescript-eslint), Prettier, Docker CLI, git CLI.

**Spec:** `docs/specs/2026-10-09-autoforge-design.md`

## Global Constraints

- Node `>=22`, ESM only (`"type": "module"`), imports use `.js` extensions (NodeNext).
- Zero runtime dependencies. Dev dependencies only.
- Never spawn through a shell with untrusted text. Every command is an argv array passed to `proc()`.
- Child git processes get an explicit env (never the parent's `GIT_*` vars). Pre-push hooks set `GIT_DIR`, which would otherwise leak into test repos.
- `run()` returns expected failures in the result; it only rejects with `TypeError` for invalid options.
- Defaults: `timeoutMs` 30 min, `maxLogBytes` 1 000 000, `maxPatchBytes` 10 000 000; Docker `cpus` 2, `memory` "4g", `network` "bridge", `user` "1000:1000", workdir `/workspace`.
- Secrets shorter than 4 characters are not redacted.
- No em dashes in prose (README, docs, messages).
- Nothing is pushed to GitHub or published to npm. The repo stays local.

## Review Focus

1. `repo.url` or `repo.ref` starting with `-` (git option injection, e.g. `--upload-pack=...`): must reject with `TypeError` before anything runs. Pinned in Task 3.
2. The agent breaks the repo (deletes `.git`): must return `failed` / `sandbox_error`, not crash or hang. Pinned in Task 3.
3. Multi-line and non-ASCII task text: must reach the agent byte-for-byte as one argument. Pinned in Task 3.
4. A secret split across two output chunks: must still be masked. Pinned in Task 1.
5. PR creation fails after the branch was pushed: a retry with `force: true` must succeed. Pinned in Task 6.

---

## File map

| File                                            | Responsibility                                                            |
| :---------------------------------------------- | :------------------------------------------------------------------------ |
| `src/proc.ts`                                   | Spawn a command without a shell; stream or collect output; abort kills it |
| `src/redact.ts`                                 | `makeRedactor(secrets)`                                                   |
| `src/logs.ts`                                   | `LineSplitter`, `TailBuffer`                                              |
| `src/sandbox.ts`                                | `Sandbox`, `SandboxSession`, `ExecOptions`, `SandboxUnavailableError`     |
| `src/run.ts`                                    | `run()` and its types                                                     |
| `src/index.ts`                                  | Public exports for `autoforge`                                            |
| `src/docker.ts`                                 | `DockerSandbox` (`autoforge/docker`)                                      |
| `src/github.ts`                                 | `publishToGitHub`, `PublishError` (`autoforge/github`)                    |
| `test/helpers.ts`                               | `git()`, `makeBareRepo()`, `advanceMain()`                                |
| `test/temp-dir-sandbox.ts`                      | Test-only host sandbox (never exported)                                   |
| `test/fake-agent.ts`                            | Scriptable stand-in agent                                                 |
| `test/scenarios.ts`, `test/safety-scenarios.ts` | Run scenarios shared by the temp-dir and Docker suites                    |

---

### Task 1: Project scaffold and core utilities

**Files:**

- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`
- Create: `src/proc.ts`, `src/redact.ts`, `src/logs.ts`
- Test: `test/proc.test.ts`, `test/redact.test.ts`, `test/logs.test.ts`

**Interfaces:**

- Produces:
  - `proc(cmd: string, args: string[], o?: ProcOptions): Promise<ProcResult>` where `ProcOptions = { cwd?, env?: NodeJS.ProcessEnv, input?: string, signal?: AbortSignal, onStdout?, onStderr?, killGroup?: boolean }` and `ProcResult = { exitCode: number | null; stdout: string; stderr: string }`. Never rejects. `stdout`/`stderr` are only collected when no callback is given.
  - `makeRedactor(secrets: Iterable<string | undefined>): (text: string) => string`
  - `class LineSplitter { constructor(onLine: (line: string) => void); push(chunk: string): void; flush(): void }`
  - `class TailBuffer { constructor(maxBytes: number); push(line: string): void; toString(): string }`

- [ ] **Step 1: Scaffold the project**

`package.json`:

```json
{
  "name": "autoforge",
  "version": "0.0.0",
  "description": "Run any coding agent in a local sandbox and turn its work into a pull request.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./docker": { "types": "./dist/docker.d.ts", "default": "./dist/docker.js" },
    "./github": { "types": "./dist/github.d.ts", "default": "./dist/github.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint .",
    "format": "prettier --check .",
    "fix": "prettier --write . && eslint --fix ."
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true,
    "paths": {
      "autoforge": ["./src/index.ts"],
      "autoforge/docker": ["./src/docker.ts"],
      "autoforge/github": ["./src/github.ts"]
    }
  },
  "include": ["src", "test", "examples", "vitest.config.ts"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist", "paths": {} },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 30_000 } });
```

`eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`.prettierrc`: `{ "printWidth": 100 }`
`.prettierignore`: `dist`, `pnpm-lock.yaml` (one per line)
`.gitignore`: `node_modules`, `dist` (one per line)

Run:

```bash
cd ~/dev/autoforge
pnpm add -D typescript@5 vitest @types/node@22 eslint @eslint/js typescript-eslint prettier
npm pkg set packageManager="pnpm@$(pnpm --version)"
```

`typescript@5` is pinned because typescript-eslint has lagged TypeScript major releases before. If `pnpm lint` later complains about an unsupported TypeScript version, that pin is the reason.

- [ ] **Step 2: Write the failing tests**

`test/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/redact.js";

describe("makeRedactor", () => {
  it("masks every secret of 4 or more characters", () => {
    expect(makeRedactor(["sk-abc123", "tok"])("sk-abc123 and tok")).toBe("*** and tok");
  });

  it("masks the longest secret first so overlaps are fully hidden", () => {
    expect(makeRedactor(["abcd", "abcdefgh"])("x abcdefgh y")).toBe("x *** y");
  });

  it("ignores undefined and empty values", () => {
    expect(makeRedactor([undefined, ""])("nothing to hide")).toBe("nothing to hide");
  });
});
```

`test/logs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LineSplitter, TailBuffer } from "../src/logs.js";
import { makeRedactor } from "../src/redact.js";

describe("LineSplitter", () => {
  it("joins chunks into lines, strips \\r, and flushes the remainder", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push("one\r\ntw");
    s.push("o\nthree");
    expect(lines).toEqual(["one", "two"]);
    s.flush();
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("masks a secret split across two chunks", () => {
    const redact = makeRedactor(["sk-abc123"]);
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(redact(l)));
    s.push("key=sk-ab");
    s.push("c123\n");
    expect(lines).toEqual(["key=***"]);
  });
});

describe("TailBuffer", () => {
  it("keeps everything under the limit with no marker", () => {
    const b = new TailBuffer(100);
    b.push("a");
    b.push("b");
    expect(b.toString()).toBe("a\nb");
  });

  it("drops the oldest lines past the limit and marks the output", () => {
    const b = new TailBuffer(10);
    for (const l of ["11111", "22222", "33333"]) b.push(l);
    expect(b.toString()).toBe("[truncated]\n33333");
  });
});
```

`test/proc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { proc } from "../src/proc.js";

describe("proc", () => {
  it("passes arguments without a shell", async () => {
    const r = await proc("printf", ["%s", "a; echo b"]);
    expect(r).toMatchObject({ exitCode: 0, stdout: "a; echo b" });
  });

  it("pipes input to stdin", async () => {
    expect((await proc("cat", [], { input: "hi" })).stdout).toBe("hi");
  });

  it("streams to callbacks instead of collecting", async () => {
    const chunks: string[] = [];
    const r = await proc("printf", ["x"], { onStdout: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("x");
    expect(r.stdout).toBe("");
  });

  it("returns 127 for a missing command", async () => {
    expect((await proc("autoforge-no-such-command", [])).exitCode).toBe(127);
  });

  it("kills the whole process group on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t = Date.now();
    const r = await proc("sh", ["-c", "sleep 30"], { signal: ac.signal, killGroup: true });
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL, "Failed to load url ../src/redact.js" (and the same for logs and proc).

- [ ] **Step 4: Implement**

`src/proc.ts`:

```ts
import { spawn } from "node:child_process";

export type ProcOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Spawn detached and kill the whole process group on abort. */
  killGroup?: boolean;
};

export type ProcResult = { exitCode: number | null; stdout: string; stderr: string };

/**
 * Runs a command without a shell. Never rejects: a command that cannot start returns 127.
 * Output goes to the callbacks when given, otherwise it is collected into the result.
 */
export function proc(cmd: string, args: string[], o: ProcOptions = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ exitCode: null, stdout: "", stderr: "" });
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      detached: o.killGroup,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      if (o.onStdout) o.onStdout(c);
      else stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      if (o.onStderr) o.onStderr(c);
      else stderr += c;
    });
    if (child.stdin) {
      child.stdin.on("error", () => {}); // the child may exit before reading everything
      child.stdin.end(o.input);
    }
    const onAbort = () => {
      try {
        if (o.killGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (exitCode: number | null) => {
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr });
    };
    child.on("error", (err) => {
      if (o.onStderr) o.onStderr(String(err));
      else stderr += String(err);
      done(127);
    });
    child.on("close", (code) => done(code));
  });
}
```

`src/redact.ts`:

```ts
/** Returns a function that replaces each secret (4+ characters) with "***", longest first. */
export function makeRedactor(secrets: Iterable<string | undefined>): (text: string) => string {
  const list = [...new Set(secrets)]
    .filter((s): s is string => !!s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) => list.reduce((t, s) => t.replaceAll(s, "***"), text);
}
```

`src/logs.ts`:

```ts
/** Turns a stream of chunks into whole lines. Call flush() when the stream ends. */
export class LineSplitter {
  private rest = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.onLine(p.endsWith("\r") ? p.slice(0, -1) : p);
  }

  flush(): void {
    if (this.rest) this.onLine(this.rest);
    this.rest = "";
  }
}

/** Keeps roughly the last maxBytes of text, whole lines only. */
export class TailBuffer {
  private lines: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    // ponytail: Array.shift is O(n); swap for a ring buffer if logs ever reach millions of lines
    while (this.bytes > this.maxBytes && this.lines.length > 0) {
      this.bytes -= Buffer.byteLength(this.lines.shift() ?? "") + 1;
      this.truncated = true;
    }
  }

  toString(): string {
    const body = this.lines.join("\n");
    return this.truncated ? `[truncated]\n${body}` : body;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS, 3 files, 12 tests.

- [ ] **Step 6: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "chore: scaffold autoforge with proc, redaction and log utilities"
```

---

### Task 2: Sandbox interface and test harness

**Files:**

- Create: `src/sandbox.ts`
- Create: `test/temp-dir-sandbox.ts`, `test/helpers.ts`, `test/fake-agent.ts`
- Test: `test/harness.test.ts`

**Interfaces:**

- Consumes: `proc` (Task 1).
- Produces:
  - `type ExecOptions = { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }`
  - `interface SandboxSession { readonly workdir: string; exec(cmd: string[], opts?: ExecOptions): Promise<{ exitCode: number | null }>; writeFile(path: string, content: string): Promise<void>; destroy(): Promise<void> }`
  - `interface Sandbox { create(): Promise<SandboxSession> }`
  - `class SandboxUnavailableError extends Error`
  - Test-only: `class TempDirSandbox implements Sandbox { destroyed: number }`, `git(cwd, ...args): Promise<string>`, `makeBareRepo(): Promise<BareRepo>` with `BareRepo = { bare: string; mainSha: string; featureSha: string }`, `advanceMain(bare): Promise<void>`, `FAKE_AGENT: string`, `fakeAgent(mode: string, ...args: string[]): string[]`

- [ ] **Step 1: Write the failing test**

`test/harness.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent } from "./fake-agent.js";
import { git, makeBareRepo } from "./helpers.js";
import { TempDirSandbox } from "./temp-dir-sandbox.js";

describe("TempDirSandbox", () => {
  it("runs commands with only the env it is given", async () => {
    const sb = new TempDirSandbox();
    const s = await sb.create();
    let out = "";
    const r = await s.exec(["sh", "-c", 'echo "[$GIT_DIR][$FOO]"'], {
      env: { FOO: "bar" },
      onStdout: (c) => (out += c),
    });
    expect(r.exitCode).toBe(0);
    expect(out.trim()).toBe("[][bar]");
    await s.destroy();
  });

  it("writes files, creating folders, and removes everything on destroy", async () => {
    const sb = new TempDirSandbox();
    const s = await sb.create();
    expect(existsSync(s.workdir)).toBe(false);
    await s.writeFile(join(s.workdir, "a/b.txt"), "hi");
    expect(existsSync(join(s.workdir, "a/b.txt"))).toBe(true);
    await s.destroy();
    expect(existsSync(s.workdir)).toBe(false);
    expect(sb.destroyed).toBe(1);
  });
});

describe("makeBareRepo", () => {
  it("has main and feature branches", async () => {
    const r = await makeBareRepo();
    expect(await git(r.bare, "rev-parse", "main")).toBe(r.mainSha);
    expect(await git(r.bare, "rev-parse", "feature")).toBe(r.featureSha);
  });
});

describe("fakeAgent", () => {
  it("builds an sh -c argv", () => {
    expect(fakeAgent("argv", "{task}").slice(3)).toEqual(["fake", "argv", "{task}"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test test/harness.test.ts`
Expected: FAIL, "Failed to load url ./fake-agent.js".

- [ ] **Step 3: Implement**

`src/sandbox.ts`:

```ts
export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export interface SandboxSession {
  /** Absolute path inside the sandbox where the repo is cloned. Must not exist yet, or be empty. */
  readonly workdir: string;
  /** Runs an argv array (never a shell string). Aborting the signal must stop the process. */
  exec(cmd: string[], opts?: ExecOptions): Promise<{ exitCode: number | null }>;
  writeFile(path: string, content: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface Sandbox {
  create(): Promise<SandboxSession>;
}

/** Throw from create() when the sandbox backend is not running (for example Docker is stopped). */
export class SandboxUnavailableError extends Error {
  override name = "SandboxUnavailableError";
}
```

`test/temp-dir-sandbox.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { proc } from "../src/proc.js";
import type { ExecOptions, Sandbox, SandboxSession } from "../src/sandbox.js";

/** Test-only: runs commands on the host in a temp folder. Not isolated. Never export from src. */
export class TempDirSandbox implements Sandbox {
  destroyed = 0;

  async create(): Promise<SandboxSession> {
    const root = await mkdtemp(join(tmpdir(), "autoforge-test-"));
    const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
    return {
      workdir: join(root, "workspace"),
      exec: async (cmd: string[], o: ExecOptions = {}) => {
        const [bin = "", ...args] = cmd;
        const r = await proc(bin, args, {
          cwd: o.cwd ?? root,
          env: { ...base, ...o.env },
          signal: o.signal,
          onStdout: o.onStdout ?? (() => {}),
          onStderr: o.onStderr ?? (() => {}),
          killGroup: true,
        });
        return { exitCode: r.exitCode };
      },
      writeFile: async (path: string, content: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      destroy: async () => {
        this.destroyed++;
        await rm(root, { recursive: true, force: true });
      },
    };
  }
}
```

`test/helpers.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proc } from "../src/proc.js";

/** Runs git with a clean env (no inherited GIT_DIR from hooks) and throws on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" };
  const r = await proc("git", args, { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const commit = (cwd: string, msg: string) =>
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);

export type BareRepo = { bare: string; mainSha: string; featureSha: string };

/** A bare repo with hello.txt on main, plus a feature branch adding feature.txt. */
export async function makeBareRepo(): Promise<BareRepo> {
  const root = await mkdtemp(join(tmpdir(), "autoforge-repo-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  await mkdir(work);
  await git(work, "init", "-q", "-b", "main");
  await writeFile(join(work, "hello.txt"), "hello\n");
  await git(work, "add", "-A");
  await commit(work, "init");
  const mainSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "-qb", "feature");
  await writeFile(join(work, "feature.txt"), "feature\n");
  await git(work, "add", "-A");
  await commit(work, "feature");
  const featureSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "-q", "main");
  await git(root, "clone", "-q", "--bare", work, bare);
  await git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  return { bare, mainSha, featureSha };
}

/** Adds a commit to main in the bare repo, as if a teammate pushed. */
export async function advanceMain(bare: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "autoforge-advance-"));
  await git(root, "clone", "-q", bare, "w");
  const w = join(root, "w");
  await writeFile(join(w, "other.txt"), "other\n");
  await git(w, "add", "-A");
  await commit(w, "other");
  await git(w, "push", "-q", "origin", "main");
}
```

`test/fake-agent.ts`:

```ts
/** A scriptable stand-in for a coding agent: `sh -c FAKE_AGENT fake <mode> [arg]`. */
export const FAKE_AGENT = `
set -e
target="\${TARGET_FILE:-hello.txt}"
case "$1" in
  edit) echo changed >> "$target" ;;
  add) echo new > added.txt ;;
  commit) echo c > committed.txt; git add -A; git -c user.name=f -c user.email=f@f commit -qm c ;;
  noop) true ;;
  fail-after-edit) echo changed >> "$target"; echo boom >&2; exit 3 ;;
  sleep) echo x >> "$target"; sleep 30 ;;
  flood) i=0; while [ $i -lt 5000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done ;;
  echo-env) echo "key=$SECRET_KEY"; echo "task=$AUTOFORGE_TASK"; cat "$AUTOFORGE_TASK_FILE"; echo ;;
  argv) printf '%s\\n' "$2" > argv.txt; echo "argc=$#" ;;
  read-git-config) cat .git/config ;;
  nuke-git) rm -rf .git ;;
  id) id -u ;;
  *) echo "unknown mode $1" >&2; exit 64 ;;
esac
`;

export const fakeAgent = (mode: string, ...args: string[]): string[] => [
  "sh",
  "-c",
  FAKE_AGENT,
  "fake",
  mode,
  ...args,
];
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test test/harness.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "feat: sandbox interface and test harness"
```

---

### Task 3: `run()` core flow

**Files:**

- Create: `src/run.ts`, `src/index.ts`, `test/scenarios.ts`
- Test: `test/run.test.ts`

**Interfaces:**

- Consumes: `Sandbox`, `SandboxSession`, `ExecOptions` (Task 2); `LineSplitter` (Task 1); test harness (Task 2).
- Produces (types are final here; Task 4 only changes the implementation):
  - `run(options: RunOptions): Promise<RunResult>`
  - `RunOptions`, `RunResult`, `RunEvent`, `RunStatus`, `FailureReason`, `Phase` exactly as in the code below
  - `test/scenarios.ts`: `type ScenarioContext = { sandbox: () => Sandbox; repo: () => { url: string; ref: string }; target: string; timeoutMs: number }`, `options(ctx, mode, extra?): RunOptions`, `runScenarios(ctx): void`

- [ ] **Step 1: Write the failing tests**

`test/scenarios.ts`:

```ts
import { expect, it } from "vitest";
import { run, type RunEvent, type RunOptions } from "../src/index.js";
import type { Sandbox } from "../src/sandbox.js";
import { fakeAgent } from "./fake-agent.js";

export type ScenarioContext = {
  sandbox: () => Sandbox;
  repo: () => { url: string; ref: string };
  /** A file that exists in the repo, for the agent to edit. */
  target: string;
  /** Longer than the clone takes, shorter than the fake agent's 30 s sleep. */
  timeoutMs: number;
};

export function options(
  ctx: ScenarioContext,
  mode: string,
  extra: Partial<RunOptions> = {},
): RunOptions {
  return {
    repo: ctx.repo(),
    task: "Fix the thing",
    agent: { command: fakeAgent(mode), env: { TARGET_FILE: ctx.target } },
    sandbox: ctx.sandbox(),
    ...extra,
  };
}

/** Behaviour every sandbox must support. Shared by the temp-dir and Docker suites. */
export function runScenarios(ctx: ScenarioContext): void {
  it("returns the agent's edit as a patch", async () => {
    const r = await run(options(ctx, "edit"));
    expect(r.status).toBe("changed");
    expect(r.filesChanged).toEqual([ctx.target]);
    expect(r.patch).toContain("+changed");
    expect(r.exitCode).toBe(0);
    expect(r.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.repo).toEqual(ctx.repo());
  });

  it("reports no_changes when the agent changes nothing", async () => {
    const r = await run(options(ctx, "noop"));
    expect(r).toMatchObject({ status: "no_changes", patch: "", filesChanged: [] });
  });

  it("captures work the agent committed itself", async () => {
    const r = await run(options(ctx, "commit"));
    expect(r.status).toBe("changed");
    expect(r.filesChanged).toEqual(["committed.txt"]);
  });

  it("keeps the patch when the agent exits non-zero", async () => {
    const r = await run(options(ctx, "fail-after-edit"));
    expect(r.status).toBe("changed");
    expect(r.exitCode).toBe(3);
    expect(r.logs).toContain("boom");
  });

  it("gives the agent the task by env and file, and keeps the file out of the diff", async () => {
    const r = await run(options(ctx, "echo-env"));
    expect(r.status).toBe("no_changes");
    expect(r.logs).toContain("task=Fix the thing");
  });

  it("passes {task} as one literal argument, never through a shell", async () => {
    const task = "; rm -rf / #\nsecond line ü";
    const agent = { command: fakeAgent("argv", "{task}"), env: { TARGET_FILE: ctx.target } };
    const r = await run(options(ctx, "argv", { task, agent }));
    expect(r.status).toBe("changed");
    expect(r.logs).toContain("argc=2");
    expect(r.patch).toContain("+; rm -rf / #");
    expect(r.patch).toContain("+second line ü");
  });

  it("emits phases in order and streams log lines", async () => {
    const events: RunEvent[] = [];
    await run(options(ctx, "echo-env", { onEvent: (e) => events.push(e) }));
    const phases = events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));
    expect(phases).toEqual(["creating_sandbox", "cloning", "running", "collecting", "done"]);
    expect(events).toContainEqual({ type: "log", stream: "stdout", line: "task=Fix the thing" });
  });

  it("fails cleanly when the agent breaks the repo", async () => {
    const r = await run(options(ctx, "nuke-git"));
    expect(r).toMatchObject({ status: "failed", reason: "sandbox_error", patch: "" });
  });
}
```

`test/run.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeAgent } from "./fake-agent.js";
import { makeBareRepo, type BareRepo } from "./helpers.js";
import { runScenarios } from "./scenarios.js";
import { TempDirSandbox } from "./temp-dir-sandbox.js";

let repo: BareRepo;
beforeAll(async () => {
  repo = await makeBareRepo();
});

const base = () => ({
  repo: { url: repo.bare, ref: "main" },
  task: "Fix the thing",
  agent: { command: fakeAgent("noop") },
  sandbox: new TempDirSandbox(),
});

describe("run() with TempDirSandbox", () => {
  runScenarios({
    sandbox: () => new TempDirSandbox(),
    repo: () => ({ url: repo.bare, ref: "main" }),
    target: "hello.txt",
    timeoutMs: 3_000,
  });
});

describe("refs and clone", () => {
  it("checks out a non-default branch", async () => {
    const r = await run({ ...base(), repo: { url: repo.bare, ref: "feature" } });
    expect(r.baseSha).toBe(repo.featureSha);
  });

  it("checks out a commit sha", async () => {
    const r = await run({ ...base(), repo: { url: repo.bare, ref: repo.mainSha } });
    expect(r.baseSha).toBe(repo.mainSha);
  });

  it("returns clone_failed for a missing repo and still destroys the sandbox", async () => {
    const sandbox = new TempDirSandbox();
    const r = await run({
      ...base(),
      sandbox,
      repo: { url: "/nonexistent/repo.git", ref: "main" },
    });
    expect(r).toMatchObject({ status: "failed", reason: "clone_failed" });
    expect(r.baseSha).toBeUndefined();
    expect(sandbox.destroyed).toBe(1);
  });

  it("returns clone_failed for an unknown ref", async () => {
    const r = await run({ ...base(), repo: { url: repo.bare, ref: "no-such-branch" } });
    expect(r).toMatchObject({ status: "failed", reason: "clone_failed" });
  });
});

describe("validation", () => {
  it.each([
    ["an empty task", { task: "  " }],
    ["an empty command", { agent: { command: [] } }],
    ["a ref that looks like a flag", { repo: { url: "/x", ref: "-x" } }],
    [
      "a url that looks like a flag",
      { repo: { url: "--upload-pack=touch /tmp/pwned", ref: "main" } },
    ],
    ["a zero timeout", { timeoutMs: 0 }],
  ])("rejects %s", async (_name, patch) => {
    await expect(run({ ...base(), ...patch })).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/run.test.ts`
Expected: FAIL, "Failed to load url ../src/index.js".

- [ ] **Step 3: Implement**

`src/index.ts`:

```ts
export { run } from "./run.js";
export type { FailureReason, Phase, RunEvent, RunOptions, RunResult, RunStatus } from "./run.js";
export { SandboxUnavailableError } from "./sandbox.js";
export type { ExecOptions, Sandbox, SandboxSession } from "./sandbox.js";
```

`src/run.ts` (core flow; Task 4 replaces this file with the full version):

```ts
import { randomUUID } from "node:crypto";
import { LineSplitter } from "./logs.js";
import type { ExecOptions, Sandbox, SandboxSession } from "./sandbox.js";

export type RunStatus = "changed" | "no_changes" | "failed" | "timed_out";
export type FailureReason =
  "aborted" | "clone_failed" | "sandbox_unavailable" | "sandbox_error" | "patch_too_large";
export type Phase = "creating_sandbox" | "cloning" | "running" | "collecting" | "done";
export type RunEvent =
  { type: "phase"; phase: Phase } | { type: "log"; stream: "stdout" | "stderr"; line: string };

export type RunOptions = {
  repo: { url: string; ref: string; token?: string };
  task: string;
  agent: { command: string[]; env?: Record<string, string> };
  sandbox: Sandbox;
  timeoutMs?: number;
  maxLogBytes?: number;
  maxPatchBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
};

export type RunResult = {
  id: string;
  status: RunStatus;
  reason?: FailureReason;
  message?: string;
  repo: { url: string; ref: string };
  task: string;
  baseSha?: string;
  patch: string;
  filesChanged: string[];
  logs: string;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
};

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

export async function run(options: RunOptions): Promise<RunResult> {
  validate(options);
  const { repo, task, agent, sandbox } = options;
  const emit = options.onEvent ?? (() => {});
  const lines: string[] = [];
  const logLine = (stream: "stdout" | "stderr") => (line: string) => {
    lines.push(line);
    emit({ type: "log", stream, line });
  };
  const stdout = new LineSplitter(logLine("stdout"));
  const stderr = new LineSplitter(logLine("stderr"));

  const started = Date.now();
  const result: RunResult = {
    id: randomUUID(),
    status: "failed",
    repo: { url: repo.url, ref: repo.ref },
    task,
    patch: "",
    filesChanged: [],
    logs: "",
    exitCode: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const finish = (fields: Partial<RunResult>): RunResult => {
    emit({ type: "phase", phase: "done" });
    return Object.assign(result, fields, {
      logs: lines.join("\n"),
      durationMs: Date.now() - started,
    });
  };
  const fail = (reason: FailureReason, message: string) =>
    finish({ status: "failed", reason, message });

  const inSession = async (s: SandboxSession): Promise<RunResult> => {
    const w = s.workdir;
    const exec = async (cmd: string[], opts: ExecOptions) => {
      try {
        return await s.exec(cmd, {
          onStdout: (c) => stdout.push(c),
          onStderr: (c) => stderr.push(c),
          ...opts,
        });
      } finally {
        stdout.flush();
        stderr.flush();
      }
    };
    // Collects stdout instead of logging it.
    const capture = async (cmd: string[]) => {
      let text = "";
      const r = await exec(cmd, { cwd: w, env: GIT_ENV, onStdout: (c) => (text += c) });
      return { ok: r.exitCode === 0, text };
    };

    emit({ type: "phase", phase: "cloning" });
    const clone = await exec(["git", "clone", "--quiet", "--", repo.url, w], { env: GIT_ENV });
    if (clone.exitCode !== 0)
      return fail("clone_failed", `git clone exited with code ${clone.exitCode}`);

    let baseSha = "";
    for (const rev of [`origin/${repo.ref}^{commit}`, `${repo.ref}^{commit}`]) {
      const r = await capture(["git", "rev-parse", "--verify", "--quiet", rev]);
      if (r.ok) {
        baseSha = r.text.trim();
        break;
      }
    }
    if (!baseSha) return fail("clone_failed", `ref not found: ${repo.ref}`);
    const checkout = await exec(["git", "checkout", "--quiet", "--detach", baseSha], {
      cwd: w,
      env: GIT_ENV,
    });
    if (checkout.exitCode !== 0) return fail("clone_failed", `could not check out ${repo.ref}`);
    result.baseSha = baseSha;

    const taskFile = `${w}/.autoforge/task.md`;
    await s.writeFile(taskFile, task);
    // The default exclude file only holds comments, so overwriting it is safe.
    await s.writeFile(`${w}/.git/info/exclude`, ".autoforge/\n");

    emit({ type: "phase", phase: "running" });
    const command = agent.command.map((arg) => arg.replaceAll("{task}", task));
    const agentRun = await exec(command, {
      cwd: w,
      env: { ...agent.env, AUTOFORGE_TASK: task, AUTOFORGE_TASK_FILE: taskFile },
    });
    result.exitCode = agentRun.exitCode;

    emit({ type: "phase", phase: "collecting" });
    const add = await capture(["git", "add", "-A"]);
    const diff = await capture(["git", "diff", "--cached", "--binary", baseSha]);
    if (!add.ok || !diff.ok)
      return fail("sandbox_error", "could not collect the agent's changes with git");
    const names = await capture(["git", "diff", "--cached", "--name-only", baseSha]);
    return finish({
      status: diff.text ? "changed" : "no_changes",
      patch: diff.text,
      filesChanged: names.text.split("\n").filter(Boolean),
    });
  };

  emit({ type: "phase", phase: "creating_sandbox" });
  const session = await sandbox.create();
  try {
    return await inSession(session);
  } finally {
    await session.destroy().catch(() => {});
  }
}

function validate(o: RunOptions): void {
  if (typeof o.task !== "string" || !o.task.trim())
    throw new TypeError("task must be a non-empty string");
  if (!o.repo?.url || !o.repo.ref) throw new TypeError("repo.url and repo.ref are required");
  if (o.repo.url.startsWith("-") || o.repo.ref.startsWith("-")) {
    throw new TypeError("repo.url and repo.ref must not start with '-'");
  }
  if (!o.agent?.command?.length) throw new TypeError("agent.command needs at least one entry");
  if (!o.sandbox) throw new TypeError("sandbox is required");
  for (const key of ["timeoutMs", "maxLogBytes", "maxPatchBytes"] as const) {
    const v = o[key];
    if (v !== undefined && !(v > 0)) throw new TypeError(`${key} must be a positive number`);
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test test/run.test.ts`
Expected: PASS, 17 tests (8 scenarios, 4 ref/clone, 5 validation).

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "feat: run() clones, runs the agent and returns its patch"
```

---

### Task 4: Timeouts, abort, redaction, limits and sandbox failures

**Files:**

- Modify: `src/run.ts` (full replacement below)
- Create: `test/safety-scenarios.ts`
- Modify: `test/run.test.ts` (append)

**Interfaces:**

- Consumes: everything from Task 3; `makeRedactor`, `TailBuffer` (Task 1); `SandboxUnavailableError` (Task 2).
- Produces: `runSafetyScenarios(ctx: ScenarioContext): void` in `test/safety-scenarios.ts`. No public type changes.

- [ ] **Step 1: Write the failing tests**

`test/safety-scenarios.ts`:

```ts
import { expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeAgent } from "./fake-agent.js";
import { options, type ScenarioContext } from "./scenarios.js";

export function runSafetyScenarios(ctx: ScenarioContext): void {
  it("stops at the timeout and keeps the partial patch", async () => {
    const r = await run(options(ctx, "sleep", { timeoutMs: ctx.timeoutMs }));
    expect(r.status).toBe("timed_out");
    expect(r.exitCode).toBeNull();
    expect(r.patch).toContain("+x");
    expect(r.durationMs).toBeLessThan(ctx.timeoutMs + 15_000);
  });

  it("stops on abort and returns no patch", async () => {
    const ac = new AbortController();
    const r = await run(
      options(ctx, "sleep", {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === "phase" && e.phase === "running") setTimeout(() => ac.abort(), 500);
        },
      }),
    );
    expect(r).toMatchObject({ status: "failed", reason: "aborted", patch: "" });
  });

  it("masks secrets in events and logs", async () => {
    const secret = "sk-test-abcdef123";
    const lines: string[] = [];
    const r = await run(
      options(ctx, "echo-env", {
        agent: { command: fakeAgent("echo-env"), env: { SECRET_KEY: secret } },
        onEvent: (e) => {
          if (e.type === "log") lines.push(e.line);
        },
      }),
    );
    expect(lines).toContain("key=***");
    expect(JSON.stringify(r) + lines.join("\n")).not.toContain(secret);
  });

  it("keeps only the tail of long logs", async () => {
    const r = await run(options(ctx, "flood", { maxLogBytes: 2_000 }));
    expect(r.logs.startsWith("[truncated]\n")).toBe(true);
    expect(r.logs).toContain("line 4999");
    expect(r.logs).not.toContain("line 0 ");
    expect(r.logs.length).toBeLessThanOrEqual(2_100);
  });

  it("refuses a patch over the size limit", async () => {
    const r = await run(options(ctx, "add", { maxPatchBytes: 10 }));
    expect(r).toMatchObject({ status: "failed", reason: "patch_too_large", patch: "" });
  });
}
```

Append to `test/run.test.ts` (and add the new imports at the top: `import { SandboxUnavailableError, type Sandbox } from "../src/index.js";` merged into the existing `../src/index.js` import, and `import { runSafetyScenarios } from "./safety-scenarios.js";`):

```ts
describe("run() safety with TempDirSandbox", () => {
  runSafetyScenarios({
    sandbox: () => new TempDirSandbox(),
    repo: () => ({ url: repo.bare, ref: "main" }),
    target: "hello.txt",
    timeoutMs: 3_000,
  });
});

describe("tokens", () => {
  // Regression guard: passes in Task 3 too, because Task 3 ignores the token entirely.
  it("never writes the clone token into .git/config", async () => {
    const r = await run({
      ...base(),
      repo: { url: repo.bare, ref: "main", token: "ghp_secrettoken123" },
      agent: { command: fakeAgent("read-git-config") },
    });
    expect(r.logs).toContain('[remote "origin"]');
    expect(r.logs).not.toContain("***");
    expect(r.logs).not.toContain("Authorization");
  });
});

describe("sandbox failures", () => {
  const throwing = (err: Error): Sandbox => ({
    create: async () => {
      throw err;
    },
  });

  it("maps SandboxUnavailableError to sandbox_unavailable", async () => {
    const r = await run({
      ...base(),
      sandbox: throwing(new SandboxUnavailableError("Docker is not running")),
    });
    expect(r).toMatchObject({
      status: "failed",
      reason: "sandbox_unavailable",
      message: "Docker is not running",
    });
  });

  it("maps other create errors to sandbox_error", async () => {
    const r = await run({ ...base(), sandbox: throwing(new Error("boom")) });
    expect(r).toMatchObject({ status: "failed", reason: "sandbox_error", message: "boom" });
  });

  it("returns sandbox_error when the session dies mid-run, and still destroys it", async () => {
    let destroyed = false;
    const sandbox: Sandbox = {
      create: async () => ({
        workdir: "/w",
        exec: async () => {
          throw new Error("lost connection");
        },
        writeFile: async () => {},
        destroy: async () => {
          destroyed = true;
        },
      }),
    };
    const r = await run({ ...base(), sandbox });
    expect(r).toMatchObject({
      status: "failed",
      reason: "sandbox_error",
      message: "lost connection",
    });
    expect(destroyed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/run.test.ts`
Expected: FAIL. The timeout and abort tests time out at 30 s, the redaction, truncation and size-limit tests fail their assertions, and the three sandbox-failure tests reject instead of returning a result. The token test passes (regression guard, see its comment).

- [ ] **Step 3: Replace `src/run.ts` with the full version**

```ts
import { randomUUID } from "node:crypto";
import { LineSplitter, TailBuffer } from "./logs.js";
import { makeRedactor } from "./redact.js";
import {
  SandboxUnavailableError,
  type ExecOptions,
  type Sandbox,
  type SandboxSession,
} from "./sandbox.js";

export type RunStatus = "changed" | "no_changes" | "failed" | "timed_out";
export type FailureReason =
  "aborted" | "clone_failed" | "sandbox_unavailable" | "sandbox_error" | "patch_too_large";
export type Phase = "creating_sandbox" | "cloning" | "running" | "collecting" | "done";
export type RunEvent =
  { type: "phase"; phase: Phase } | { type: "log"; stream: "stdout" | "stderr"; line: string };

export type RunOptions = {
  repo: { url: string; ref: string; token?: string };
  task: string;
  agent: { command: string[]; env?: Record<string, string> };
  sandbox: Sandbox;
  timeoutMs?: number;
  maxLogBytes?: number;
  maxPatchBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
};

export type RunResult = {
  id: string;
  status: RunStatus;
  reason?: FailureReason;
  message?: string;
  repo: { url: string; ref: string };
  task: string;
  baseSha?: string;
  patch: string;
  filesChanged: string[];
  logs: string;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
};

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

export async function run(options: RunOptions): Promise<RunResult> {
  validate(options);
  const { repo, task, agent, sandbox } = options;
  const maxPatchBytes = options.maxPatchBytes ?? 10_000_000;
  const emit = options.onEvent ?? (() => {});

  // The token reaches git as a one-off header on the clone command, never as config on disk.
  const authHeader = repo.token
    ? `Authorization: Basic ${Buffer.from(`x-access-token:${repo.token}`).toString("base64")}`
    : undefined;
  const redact = makeRedactor([...Object.values(agent.env ?? {}), repo.token, authHeader]);
  const logs = new TailBuffer(options.maxLogBytes ?? 1_000_000);
  const logLine = (stream: "stdout" | "stderr") => (raw: string) => {
    const line = redact(raw);
    logs.push(line);
    emit({ type: "log", stream, line });
  };
  const stdout = new LineSplitter(logLine("stdout"));
  const stderr = new LineSplitter(logLine("stderr"));

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  const started = Date.now();
  const result: RunResult = {
    id: randomUUID(),
    status: "failed",
    repo: { url: repo.url, ref: repo.ref },
    task,
    patch: "",
    filesChanged: [],
    logs: "",
    exitCode: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const finish = (fields: Partial<RunResult>): RunResult => {
    emit({ type: "phase", phase: "done" });
    return Object.assign(result, fields, {
      logs: logs.toString(),
      durationMs: Date.now() - started,
    });
  };
  const fail = (reason: FailureReason, message: string) =>
    finish({ status: "failed", reason, message: redact(message) });
  const stopped = () =>
    options.signal?.aborted
      ? fail("aborted", "the run was aborted")
      : finish({ status: "timed_out", message: "the run hit its timeout" });

  const inSession = async (s: SandboxSession): Promise<RunResult> => {
    const w = s.workdir;
    const exec = async (cmd: string[], opts: ExecOptions) => {
      try {
        return await s.exec(cmd, {
          onStdout: (c) => stdout.push(c),
          onStderr: (c) => stderr.push(c),
          ...opts,
        });
      } finally {
        stdout.flush();
        stderr.flush();
      }
    };
    // Collects stdout instead of logging it, up to `limit` bytes.
    const capture = async (cmd: string[], limit = Infinity) => {
      let text = "";
      let bytes = 0;
      const r = await exec(cmd, {
        cwd: w,
        env: GIT_ENV,
        onStdout: (c) => {
          bytes += Buffer.byteLength(c);
          if (bytes <= limit) text += c;
        },
      });
      return { ok: r.exitCode === 0, text, overflow: bytes > limit };
    };

    emit({ type: "phase", phase: "cloning" });
    const auth = authHeader ? ["-c", `http.extraHeader=${authHeader}`] : [];
    const clone = await exec(["git", ...auth, "clone", "--quiet", "--", repo.url, w], {
      env: GIT_ENV,
      signal,
    });
    if (signal.aborted) return stopped();
    if (clone.exitCode !== 0)
      return fail("clone_failed", `git clone exited with code ${clone.exitCode}`);

    let baseSha = "";
    for (const rev of [`origin/${repo.ref}^{commit}`, `${repo.ref}^{commit}`]) {
      const r = await capture(["git", "rev-parse", "--verify", "--quiet", rev]);
      if (r.ok) {
        baseSha = r.text.trim();
        break;
      }
    }
    if (!baseSha) return fail("clone_failed", `ref not found: ${repo.ref}`);
    const checkout = await exec(["git", "checkout", "--quiet", "--detach", baseSha], {
      cwd: w,
      env: GIT_ENV,
    });
    if (checkout.exitCode !== 0) return fail("clone_failed", `could not check out ${repo.ref}`);
    result.baseSha = baseSha;

    const taskFile = `${w}/.autoforge/task.md`;
    await s.writeFile(taskFile, task);
    // The default exclude file only holds comments, so overwriting it is safe.
    await s.writeFile(`${w}/.git/info/exclude`, ".autoforge/\n");

    emit({ type: "phase", phase: "running" });
    const command = agent.command.map((arg) => arg.replaceAll("{task}", task));
    const agentRun = await exec(command, {
      cwd: w,
      env: { ...agent.env, AUTOFORGE_TASK: task, AUTOFORGE_TASK_FILE: taskFile },
      signal,
    });
    result.exitCode = agentRun.exitCode;
    if (options.signal?.aborted) return stopped();

    emit({ type: "phase", phase: "collecting" });
    const add = await capture(["git", "add", "-A"]);
    const diff = await capture(["git", "diff", "--cached", "--binary", baseSha], maxPatchBytes);
    if (!add.ok || !diff.ok)
      return fail("sandbox_error", "could not collect the agent's changes with git");
    if (diff.overflow)
      return fail("patch_too_large", `the patch is larger than ${maxPatchBytes} bytes`);
    const names = await capture(["git", "diff", "--cached", "--name-only", baseSha]);
    const status: RunStatus = timeout.aborted ? "timed_out" : diff.text ? "changed" : "no_changes";
    return finish({
      status,
      patch: diff.text,
      filesChanged: names.text.split("\n").filter(Boolean),
    });
  };

  emit({ type: "phase", phase: "creating_sandbox" });
  let session: SandboxSession;
  try {
    session = await sandbox.create();
  } catch (e) {
    const reason = e instanceof SandboxUnavailableError ? "sandbox_unavailable" : "sandbox_error";
    return fail(reason, errorMessage(e));
  }
  try {
    return await inSession(session);
  } catch (e) {
    return fail("sandbox_error", errorMessage(e));
  } finally {
    await session.destroy().catch(() => {});
  }
}

function validate(o: RunOptions): void {
  if (typeof o.task !== "string" || !o.task.trim())
    throw new TypeError("task must be a non-empty string");
  if (!o.repo?.url || !o.repo.ref) throw new TypeError("repo.url and repo.ref are required");
  if (o.repo.url.startsWith("-") || o.repo.ref.startsWith("-")) {
    throw new TypeError("repo.url and repo.ref must not start with '-'");
  }
  if (!o.agent?.command?.length) throw new TypeError("agent.command needs at least one entry");
  if (!o.sandbox) throw new TypeError("sandbox is required");
  for (const key of ["timeoutMs", "maxLogBytes", "maxPatchBytes"] as const) {
    const v = o[key];
    if (v !== undefined && !(v > 0)) throw new TypeError(`${key} must be a positive number`);
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test`
Expected: PASS, all files. `test/run.test.ts` has 26 tests.

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "feat: run() timeouts, abort, secret masking, log and patch limits"
```

---

### Task 5: `DockerSandbox`

**Files:**

- Create: `src/docker.ts`
- Test: `test/docker.test.ts`

**Interfaces:**

- Consumes: `proc` (Task 1); `Sandbox`, `SandboxSession`, `ExecOptions`, `SandboxUnavailableError` (Task 2); `run` (Task 4); `runScenarios`, `runSafetyScenarios`, `options` (Tasks 3 and 4).
- Produces: `class DockerSandbox implements Sandbox { constructor(options: DockerSandboxOptions) }`, `type DockerSandboxOptions = { image: string; cpus?: number; memory?: string; network?: "bridge" | "none"; user?: string }`.

Docker tests clone `https://github.com/octocat/Hello-World.git` (branch `master`, file `README`) because a container cannot see the host's temp-dir bare repo. They need network access and pull `node:22` (which ships git) on first run.

- [ ] **Step 1: Write the failing test**

`test/docker.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../src/docker.js";
import { run } from "../src/index.js";
import { proc } from "../src/proc.js";
import { fakeAgent } from "./fake-agent.js";
import { runSafetyScenarios } from "./safety-scenarios.js";
import { options, runScenarios, type ScenarioContext } from "./scenarios.js";

const dockerUp = (await proc("docker", ["info"])).exitCode === 0;
const IMAGE = "node:22";

const ctx: ScenarioContext = {
  sandbox: () => new DockerSandbox({ image: IMAGE }),
  repo: () => ({ url: "https://github.com/octocat/Hello-World.git", ref: "master" }),
  target: "README",
  timeoutMs: 20_000,
};

const containers = async () =>
  (await proc("docker", ["ps", "-aq", "--filter", "label=autoforge=1"])).stdout.trim();

describe.skipIf(!dockerUp && !process.env.AUTOFORGE_REQUIRE_DOCKER)(
  "DockerSandbox",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      await proc("docker", ["pull", "-q", IMAGE]);
    }, 600_000);

    runScenarios(ctx);
    runSafetyScenarios(ctx);

    it("uses /workspace and round-trips files", async () => {
      const s = await ctx.sandbox().create();
      try {
        expect(s.workdir).toBe("/workspace");
        await s.writeFile("/workspace/a/b.txt", "hi");
        let out = "";
        await s.exec(["cat", "/workspace/a/b.txt"], { onStdout: (c) => (out += c) });
        expect(out).toBe("hi");
      } finally {
        await s.destroy();
      }
    });

    it("runs the agent as a non-root user", async () => {
      const r = await run(options(ctx, "id"));
      expect(r.logs.split("\n")).toContain("1000");
    });

    it("removes its container after the run", async () => {
      const before = await containers();
      await run(options(ctx, "noop"));
      expect(await containers()).toBe(before);
    });

    it("has no network with network: none", async () => {
      const r = await run(
        options(ctx, "noop", { sandbox: new DockerSandbox({ image: IMAGE, network: "none" }) }),
      );
      expect(r).toMatchObject({ status: "failed", reason: "clone_failed" });
    });

    it("passes env values without putting them on the docker command line", async () => {
      const r = await run(
        options(ctx, "echo-env", {
          agent: { command: fakeAgent("echo-env"), env: { SECRET_KEY: "sk-docker-123456" } },
        }),
      );
      expect(r.logs).toContain("key=***");
    });
  },
);
```

- [ ] **Step 2: Run to verify it fails**

Start Docker (Docker Desktop, OrbStack or Colima), then run: `pnpm test test/docker.test.ts`
Expected: FAIL, "Failed to load url ../src/docker.js".

- [ ] **Step 3: Implement**

`src/docker.ts`:

```ts
import { proc } from "./proc.js";
import {
  SandboxUnavailableError,
  type ExecOptions,
  type Sandbox,
  type SandboxSession,
} from "./sandbox.js";

export type DockerSandboxOptions = {
  /** Image to run. Must contain git and sh. */
  image: string;
  cpus?: number;
  memory?: string;
  network?: "bridge" | "none";
  /** uid:gid inside the container. Defaults to a non-root user. */
  user?: string;
};

const WORKDIR = "/workspace";

/** One container per session, driven through the docker CLI. No host folders are mounted. */
export class DockerSandbox implements Sandbox {
  constructor(private readonly options: DockerSandboxOptions) {}

  async create(): Promise<SandboxSession> {
    const { image, cpus = 2, memory = "4g", network = "bridge", user = "1000:1000" } = this.options;
    if ((await proc("docker", ["info", "--format", "{{.ServerVersion}}"])).exitCode !== 0) {
      throw new SandboxUnavailableError(
        "Docker is not running. Start Docker Desktop, OrbStack or Colima and try again.",
      );
    }
    const started = await proc("docker", [
      "run",
      "-d",
      "--label",
      "autoforge=1",
      "--cpus",
      String(cpus),
      "--memory",
      memory,
      "--network",
      network,
      "--user",
      user,
      "-e",
      "HOME=/tmp",
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    ]);
    if (started.exitCode !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
    const id = started.stdout.trim();
    const destroy = async () => {
      await proc("docker", ["rm", "-f", id]);
    };

    const prep = await proc("docker", [
      "exec",
      "-u",
      "0",
      id,
      "sh",
      "-c",
      'mkdir -p "$1" && chown "$2" "$1"',
      "sh",
      WORKDIR,
      user,
    ]);
    if (prep.exitCode !== 0) {
      await destroy();
      throw new Error(`could not prepare ${WORKDIR}: ${prep.stderr.trim()}`);
    }

    return {
      workdir: WORKDIR,
      async exec(cmd: string[], o: ExecOptions = {}) {
        const env = o.env ?? {};
        const r = await proc(
          "docker",
          [
            "exec",
            "-u",
            user,
            ...(o.cwd ? ["-w", o.cwd] : []),
            ...Object.keys(env).flatMap((k) => ["-e", k]),
            id,
            ...cmd,
          ],
          {
            // `-e NAME` makes docker read the value from its own env, so secrets never show in `ps`.
            env: { ...process.env, ...env },
            signal: o.signal,
            onStdout: o.onStdout ?? (() => {}),
            onStderr: o.onStderr ?? (() => {}),
          },
        );
        // Killing the docker client leaves the process running in the container. PID 1 (sleep)
        // ignores SIGKILL from inside its namespace, so this stops everything else.
        if (o.signal?.aborted) {
          await proc("docker", [
            "exec",
            "-u",
            user,
            id,
            "sh",
            "-c",
            "kill -9 -1 2>/dev/null; true",
          ]);
        }
        return { exitCode: r.exitCode };
      },
      async writeFile(path: string, content: string) {
        const r = await proc(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            user,
            id,
            "sh",
            "-c",
            'mkdir -p "$(dirname "$1")" && cat > "$1"',
            "sh",
            path,
          ],
          { input: content },
        );
        if (r.exitCode !== 0) throw new Error(`writeFile ${path} failed: ${r.stderr.trim()}`);
      },
      destroy,
    };
  }
}
```

Prettier will reflow the argv arrays one item per line. That is fine.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test test/docker.test.ts`
Expected: PASS, 18 tests (8 core scenarios, 5 safety scenarios, 5 Docker-specific). First run is slow because it pulls `node:22`.

Then run the whole suite: `pnpm test`. Expected: PASS.

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "feat: DockerSandbox"
```

---

### Task 6: `publishToGitHub`

**Files:**

- Create: `src/github.ts`
- Test: `test/github.test.ts`

**Interfaces:**

- Consumes: `proc` (Task 1); `RunResult` (Task 3); `run` and test harness for building a real result.
- Produces:
  - `publishToGitHub(result: RunResult, o: PublishOptions): Promise<{ prUrl: string; branch: string; commitSha: string }>`
  - `type PublishOptions = { repo: string; token: string; base?: string; branch?: string; title?: string; body?: string; draft?: boolean; author?: { name: string; email: string }; force?: boolean; gitUrl?: string; apiUrl?: string; fetch?: typeof fetch }`
  - `class PublishError extends Error { readonly code: PublishErrorCode }` with `PublishErrorCode = "nothing_to_publish" | "fetch_failed" | "apply_failed" | "branch_exists" | "push_failed" | "github_api_error"`

- [ ] **Step 1: Write the failing test**

`test/github.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { publishToGitHub, type PublishOptions } from "../src/github.js";
import { run, type RunResult } from "../src/index.js";
import { fakeAgent } from "./fake-agent.js";
import { advanceMain, git, makeBareRepo, type BareRepo } from "./helpers.js";
import { TempDirSandbox } from "./temp-dir-sandbox.js";

let repo: BareRepo;
let changed: RunResult;

beforeAll(async () => {
  repo = await makeBareRepo();
  changed = await run({
    repo: { url: repo.bare, ref: "main" },
    task: "Fix the greeting\n\nMore detail here.",
    agent: { command: fakeAgent("edit") },
    sandbox: new TempDirSandbox(),
  });
});

function stubFetch(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = status < 300 ? { html_url: "https://github.com/o/r/pull/1" } : { message: "nope" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const opts = (extra: Partial<PublishOptions> = {}): PublishOptions => ({
  repo: "o/r",
  token: "tkn-123456",
  gitUrl: repo.bare,
  apiUrl: "https://api.example.test",
  fetch: stubFetch().fetch,
  ...extra,
});

describe("publishToGitHub", () => {
  it("pushes a branch with the patch and opens a draft PR", async () => {
    const { fetch, calls } = stubFetch();
    const out = await publishToGitHub(changed, opts({ fetch }));

    expect(out.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(out.branch).toMatch(/^autoforge\/fix-the-greeting-[0-9a-f]{8}$/);
    expect(await git(repo.bare, "show", `${out.branch}:hello.txt`)).toBe("hello\nchanged");
    expect(await git(repo.bare, "rev-parse", out.branch)).toBe(out.commitSha);
    expect(await git(repo.bare, "log", "-1", "--format=%an <%ae>", out.branch)).toBe(
      "autoforge <autoforge@users.noreply.github.com>",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer tkn-123456");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      title: "Fix the greeting",
      head: out.branch,
      base: "main",
      draft: true,
    });
    expect(body.body).toContain("More detail here.");
  });

  it("refuses to overwrite an existing branch unless forced", async () => {
    await publishToGitHub(changed, opts({ branch: "autoforge/fixed" }));
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/fixed" })),
    ).rejects.toMatchObject({
      name: "PublishError",
      code: "branch_exists",
    });
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/fixed", force: true })),
    ).resolves.toMatchObject({ branch: "autoforge/fixed" });
  });

  it("refuses results that are not 'changed' without touching GitHub", async () => {
    const { fetch, calls } = stubFetch();
    await expect(
      publishToGitHub({ ...changed, status: "no_changes", patch: "" }, opts({ fetch })),
    ).rejects.toMatchObject({ code: "nothing_to_publish" });
    expect(calls).toHaveLength(0);
  });

  it("reports API errors, and a forced retry succeeds after the branch was pushed", async () => {
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/retry", fetch: stubFetch(422).fetch })),
    ).rejects.toMatchObject({ code: "github_api_error", message: expect.stringContaining("422") });
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/retry", force: true })),
    ).resolves.toMatchObject({ branch: "autoforge/retry" });
  });

  it("still applies after main has moved on", async () => {
    const moving = await makeBareRepo();
    const result = await run({
      repo: { url: moving.bare, ref: "main" },
      task: "Edit hello",
      agent: { command: fakeAgent("edit") },
      sandbox: new TempDirSandbox(),
    });
    await advanceMain(moving.bare);
    const out = await publishToGitHub(result, opts({ gitUrl: moving.bare }));
    expect(await git(moving.bare, "rev-parse", `${out.branch}~1`)).toBe(moving.mainSha);
  });

  it("rejects a branch name that looks like a flag", async () => {
    await expect(publishToGitHub(changed, opts({ branch: "-x" }))).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test test/github.test.ts`
Expected: FAIL, "Failed to load url ../src/github.js".

- [ ] **Step 3: Implement**

`src/github.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proc } from "./proc.js";
import type { RunResult } from "./run.js";

export type PublishErrorCode =
  | "nothing_to_publish"
  | "fetch_failed"
  | "apply_failed"
  | "branch_exists"
  | "push_failed"
  | "github_api_error";

export class PublishError extends Error {
  override name = "PublishError";

  constructor(
    readonly code: PublishErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type PublishOptions = {
  /** "owner/name" */
  repo: string;
  /** Needs contents:write and pull_requests:write. Only used on the host. */
  token: string;
  base?: string;
  branch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  author?: { name: string; email: string };
  force?: boolean;
  /** Defaults to https://github.com/<repo>.git */
  gitUrl?: string;
  /** Defaults to https://api.github.com */
  apiUrl?: string;
  fetch?: typeof fetch;
};

/** Applies a run's patch onto its base commit, pushes a branch and opens a pull request. */
export async function publishToGitHub(
  result: RunResult,
  o: PublishOptions,
): Promise<{ prUrl: string; branch: string; commitSha: string }> {
  if (result.status !== "changed" || !result.patch || !result.baseSha) {
    throw new PublishError(
      "nothing_to_publish",
      `run status is "${result.status}"; only "changed" runs can be published`,
    );
  }
  const firstLine = result.task.split("\n")[0]?.trim() ?? "";
  const branch = o.branch ?? `autoforge/${slug(firstLine)}-${result.id.slice(0, 8)}`;
  if (branch.startsWith("-") || !/^[\w./-]+$/.test(branch)) {
    throw new TypeError(`invalid branch name: ${branch}`);
  }
  const title = o.title ?? firstLine.slice(0, 72);
  const body = o.body ?? `${result.task}\n\n---\nOpened by autoforge.`;
  const author = o.author ?? { name: "autoforge", email: "autoforge@users.noreply.github.com" };
  const base = o.base ?? result.repo.ref;
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const doFetch = o.fetch ?? fetch;
  const header = `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString("base64")}`;

  const dir = await mkdtemp(join(tmpdir(), "autoforge-publish-"));
  const cwd = join(dir, "repo");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (code: PublishErrorCode, ...args: string[]) => {
    const r = await proc("git", ["-c", header, ...args], { cwd, env });
    if (r.exitCode !== 0) {
      throw new PublishError(code, `git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  };

  try {
    await mkdir(cwd);
    await git("fetch_failed", "init", "-q");
    await git(
      "fetch_failed",
      "remote",
      "add",
      "origin",
      o.gitUrl ?? `https://github.com/${o.repo}.git`,
    );
    await git("fetch_failed", "fetch", "-q", "--depth", "1", "origin", result.baseSha);
    await git("fetch_failed", "checkout", "-q", "--detach", "FETCH_HEAD");

    const patchFile = join(dir, "change.patch");
    await writeFile(patchFile, result.patch);
    await git("apply_failed", "apply", "--binary", "--index", patchFile);
    await git(
      "apply_failed",
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-q",
      "-m",
      title,
    );
    const commitSha = await git("apply_failed", "rev-parse", "HEAD");

    const existing = await git(
      "push_failed",
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    );
    if (existing && !o.force) {
      throw new PublishError(
        "branch_exists",
        `branch ${branch} already exists; pass force: true to overwrite it`,
      );
    }
    await git(
      "push_failed",
      "push",
      "-q",
      ...(o.force ? ["--force"] : []),
      "origin",
      `HEAD:refs/heads/${branch}`,
    );

    const res = await doFetch(`${apiUrl}/repos/${o.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, head: branch, base, body, draft: o.draft ?? true }),
    });
    if (!res.ok) {
      throw new PublishError(
        "github_api_error",
        `GitHub API returned ${res.status} (branch ${branch} was pushed): ${await res.text()}`,
      );
    }
    const pr = (await res.json()) as { html_url: string };
    return { prUrl: pr.html_url, branch, commitSha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "task";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test test/github.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
pnpm fix && pnpm lint && pnpm typecheck
git add -A
git commit -m "feat: publishToGitHub applies the patch on the host and opens a draft PR"
```

---

### Task 7: Package exports, docs, example and CI

**Files:**

- Create: `README.md`, `CONTRIBUTING.md`, `LICENSE`, `examples/basic.ts`, `examples/Dockerfile`, `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: the public API from Tasks 3 to 6.
- Produces: a buildable package whose three entry points resolve.

- [ ] **Step 1: Write the failing check**

Run:

```bash
pnpm build && node --input-type=module -e "
const a = await import('autoforge');
const d = await import('autoforge/docker');
const g = await import('autoforge/github');
console.log(typeof a.run, typeof d.DockerSandbox, typeof g.publishToGitHub);
"
```

Expected: PASS already for the imports (`function function function`), since `package.json` exports were set in Task 1. This step is the guard. Next, confirm the example does not exist yet: `pnpm typecheck` succeeds, then after Step 2 it must still succeed with `examples/basic.ts` included.

- [ ] **Step 2: Write the example**

Before writing, run `claude --help | grep -i -- "--dangerously-skip-permissions"` to confirm the flag name in the installed Claude Code. If it changed, use the current equivalent.

`examples/Dockerfile`:

```dockerfile
FROM node:22
RUN npm install -g @anthropic-ai/claude-code
```

`examples/basic.ts`:

```ts
// Usage:
//   docker build -t autoforge-claude examples
//   REPO=owner/name GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node examples/basic.ts "Fix the typo in README"
// Node 23.6+ runs .ts directly; on Node 22 add --experimental-strip-types.
import { run } from "autoforge";
import { DockerSandbox } from "autoforge/docker";
import { publishToGitHub } from "autoforge/github";

const repo = process.env.REPO;
const token = process.env.GITHUB_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!repo || !token || !apiKey) throw new Error("set REPO, GITHUB_TOKEN and ANTHROPIC_API_KEY");

const result = await run({
  repo: { url: `https://github.com/${repo}.git`, ref: "main", token },
  task: process.argv[2] ?? "Fix any typos in README.md",
  // Skipping Claude Code's permission prompts is acceptable here because it runs in the sandbox.
  agent: {
    command: ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
    env: { ANTHROPIC_API_KEY: apiKey },
  },
  sandbox: new DockerSandbox({ image: "autoforge-claude" }),
  onEvent: (e) => console.log(e.type === "log" ? e.line : `== ${e.phase}`),
});

console.log(`status: ${result.status}, files: ${result.filesChanged.join(", ") || "none"}`);
if (result.status === "changed") {
  const pr = await publishToGitHub(result, { repo, token });
  console.log(`draft PR: ${pr.prUrl}`);
}
```

The example uses one token for both clone and publish to stay short. The README recommends a read-only token for the clone.

- [ ] **Step 3: Write the docs and CI**

`LICENSE`: the standard MIT licence text with `Copyright (c) 2026 autoforge contributors`.

`README.md`:

````markdown
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
- **The clone token** is passed to git as a one-off header and never written to disk in the
  sandbox. Use a read-only, fine-grained token for private repos.
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
````

`CONTRIBUTING.md`:

```markdown
# Contributing

1. `pnpm install`
2. `pnpm test` runs everything. Docker tests are skipped when Docker is not running; set
   `AUTOFORGE_REQUIRE_DOCKER=1` to make them fail instead.
3. Before a PR: `pnpm fix && pnpm lint && pnpm typecheck && pnpm test`.

Write the failing test first. Tests never call a real LLM; use `test/fake-agent.ts`.
Runtime dependencies are not accepted. Use Node built-ins.
```

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
        env:
          AUTOFORGE_REQUIRE_DOCKER: "1"
```

- [ ] **Step 4: Verify everything**

```bash
pnpm fix && pnpm lint && pnpm format && pnpm typecheck && pnpm build && pnpm test
grep -rn "—" README.md CONTRIBUTING.md examples src || echo "no em dashes"
```

Expected: all pass; Docker tests run (Docker is up locally); `no em dashes`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README, contributing guide, Claude Code example and CI"
```

---

## Not in this plan

- Creating the GitHub repo, pushing, or publishing to npm (owner decides later).
- Checking that the `autoforge` npm name is claimable (do it right before the first publish).
- Slice 2 (`autoforge serve`), which gets its own spec.
