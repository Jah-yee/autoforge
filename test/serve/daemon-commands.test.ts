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
