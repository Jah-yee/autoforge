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

  it("keeps $ sequences in the task literal in {task}", async () => {
    const task = "price $$5 and $& and $' end";
    const agent = { command: fakeAgent("argv", "{task}"), env: { TARGET_FILE: ctx.target } };
    const r = await run(options(ctx, "argv", { task, agent }));
    expect(r.patch).toContain("+price $$5 and $& and $' end");
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

  it("refuses a patch whose text is not UTF-8", async () => {
    const r = await run(options(ctx, "latin1"));
    expect(r).toMatchObject({ status: "failed", reason: "unsupported_encoding", patch: "" });
  });

  it("ignores diff.external and core.fsmonitor the agent set in .git/config", async () => {
    const r = await run(options(ctx, "hang-collect", { timeoutMs: ctx.timeoutMs }));
    expect(r.status).toBe("changed");
    expect(r.patch).toContain("+changed");
  });

  it("writes a/ and b/ prefixes without color even when the agent set diff.noprefix", async () => {
    const r = await run(options(ctx, "noprefix"));
    expect(r.status).toBe("changed");
    // Exact lines and no ANSI escapes (color.diff=always), so `git apply` on the host accepts it.
    expect(r.patch).not.toContain("\u001b");
    const lines = r.patch.split("\n");
    expect(lines).toContain(`--- a/${ctx.target}`);
    expect(lines).toContain(`+++ b/${ctx.target}`);
  });

  it("lists file names exactly, without git's quoting", async () => {
    const r = await run(options(ctx, "unicode-name"));
    expect(r.filesChanged).toEqual(["naïve file.txt"]);
  });
}
