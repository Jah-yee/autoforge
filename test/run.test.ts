import { beforeAll, describe, expect, it } from "vitest";
import { SandboxUnavailableError, run, type Sandbox } from "../src/index.js";
import { fakeAgent } from "./fake-agent.js";
import { makeBareRepo, type BareRepo } from "./helpers.js";
import { runSafetyScenarios } from "./safety-scenarios.js";
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

  it("keeps the token out of every exec argv (it travels in env)", async () => {
    const token = "ghp_secrettoken123";
    const argvs: string[][] = [];
    const inner = new TempDirSandbox();
    const sandbox: Sandbox = {
      create: async () => {
        const s = await inner.create();
        return {
          ...s,
          exec: (cmd, o) => {
            argvs.push(cmd);
            return s.exec(cmd, o);
          },
        };
      },
    };
    const r = await run({ ...base(), sandbox, repo: { url: repo.bare, ref: "main", token } });
    expect(r.status).toBe("no_changes");
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    const flat = argvs.flat();
    expect(argvs.length).toBeGreaterThan(0);
    expect(flat.some((a) => a.includes(token) || a.includes(b64))).toBe(false);
  });
});

describe("onEvent", () => {
  it("ignores a callback that throws", async () => {
    const r = await run({
      ...base(),
      onEvent: () => {
        throw new Error("host bug");
      },
    });
    expect(r.status).toBe("no_changes");
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

  it("gives up on a collect command that hangs, at the collect deadline", async () => {
    const inner = new TempDirSandbox();
    const sandbox: Sandbox = {
      create: async () => {
        const s = await inner.create();
        return {
          ...s,
          exec: (cmd, o) =>
            cmd.includes("add")
              ? new Promise((resolve) =>
                  o?.signal?.addEventListener("abort", () => resolve({ exitCode: null })),
                )
              : s.exec(cmd, o),
        };
      },
    };
    const r = await run({ ...base(), sandbox, timeoutMs: 2_000 });
    expect(r).toMatchObject({
      status: "failed",
      reason: "sandbox_error",
      message: "collecting the changes timed out",
    });
  });

  it("keeps the partial patch when collect is slow after a timeout", async () => {
    const inner = new TempDirSandbox();
    const sandbox: Sandbox = {
      create: async () => {
        const s = await inner.create();
        return {
          ...s,
          exec: async (cmd, o) => {
            if (cmd.includes("git") && cmd.includes("add"))
              await new Promise((r) => setTimeout(r, 1_200));
            return s.exec(cmd, o);
          },
        };
      },
    };
    const r = await run({
      ...base(),
      sandbox,
      agent: { command: fakeAgent("sleep") },
      timeoutMs: 1_500,
    });
    expect(r.status).toBe("timed_out");
    expect(r.patch).toContain("+x");
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
