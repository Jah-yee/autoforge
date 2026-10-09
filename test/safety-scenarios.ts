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
