import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

  it("rejects, and does not move the file aside, when state.json cannot be read", async () => {
    const d = await dir();
    await mkdir(join(d, "state.json"));
    await expect(loadState(d, now)).rejects.toThrow();
    expect(await readdir(d)).toEqual(["state.json"]);
  });

  it("leaves only the final patch file in the patches directory", async () => {
    const d = await dir();
    await writePatch(d, "run-2", "diff --git a/y b/y\n");
    expect(await readdir(join(d, "patches"))).toEqual(["run-2.patch"]);
    expect(await readPatch(d, "run-2")).toBe("diff --git a/y b/y\n");
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
