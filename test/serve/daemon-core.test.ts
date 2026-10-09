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
