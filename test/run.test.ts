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
