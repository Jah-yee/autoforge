import { existsSync } from "node:fs";
import { chmod, readdir, writeFile } from "node:fs/promises";
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
  it("keeps an entry published when cleanup after a successful publish fails", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    h.linear.attachUrl = async () => {
      throw new Error("attach down");
    };
    await chmod(join(h.dir, "patches"), 0o500); // the patch can be read but not deleted
    try {
      h.reply("issue-1", "/publish");
      await step(d);
    } finally {
      await chmod(join(h.dir, "patches"), 0o700);
    }
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("published");
    expect(h.linear.said("issue-1").some((s) => s.startsWith("Publishing failed"))).toBe(false);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "cleanup_failed" }));
  });

  it("does not accept a command whose createdAt does not parse", async () => {
    const h = await setup();
    h.linear.addIssue({ id: "issue-1" });
    const d = h.make();
    await d.start();
    await step(d);
    h.reply("issue-1", "/discard").createdAt = "not-a-date";
    await step(d);
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("awaiting_approval");
  });
});
