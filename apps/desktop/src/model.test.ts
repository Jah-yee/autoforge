import { describe, expect, it } from "vitest";
import { groupRuns, prLabel, relativeTime, type Run } from "./model";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const run = (id: string, fields: Partial<Run> = {}): Run => ({
  issueId: id,
  identifier: id.toUpperCase(),
  status: "queued",
  repo: "o/r",
  ref: "main",
  queuedAt: ago(10 * MIN),
  updatedAt: ago(10 * MIN),
  ...fields,
});

describe("groupRuns", () => {
  it("puts each status in its group, publishing counting as running", () => {
    const g = groupRuns(
      [
        run("a", { status: "awaiting_approval" }),
        run("r", { status: "running" }),
        run("p", { status: "publishing" }),
        run("q", { status: "queued" }),
        run("d", { status: "published" }),
      ],
      NOW,
    );
    expect(g.awaiting.map((r) => r.issueId)).toEqual(["a"]);
    expect(g.running.map((r) => r.issueId).sort()).toEqual(["p", "r"]);
    expect(g.queued.map((r) => r.issueId)).toEqual(["q"]);
    expect(g.recent.map((r) => r.issueId)).toEqual(["d"]);
  });

  it("orders the queue by queuedAt, oldest first, and the other groups newest first", () => {
    const g = groupRuns(
      [
        run("q2", { queuedAt: ago(1 * MIN) }),
        run("q1", { queuedAt: ago(5 * MIN) }),
        run("a-old", { status: "awaiting_approval", updatedAt: ago(9 * MIN) }),
        run("a-new", { status: "awaiting_approval", updatedAt: ago(2 * MIN) }),
      ],
      NOW,
    );
    expect(g.queued.map((r) => r.issueId)).toEqual(["q1", "q2"]);
    expect(g.awaiting.map((r) => r.issueId)).toEqual(["a-new", "a-old"]);
  });

  it("keeps finished runs from the last 7 days only, newest first, at most 20", () => {
    const finished = Array.from({ length: 25 }, (_, i) =>
      run(`f${i}`, { status: "failed", updatedAt: ago(i * MIN) }),
    );
    const old = run("old", { status: "discarded", updatedAt: ago(7 * DAY + 1) });
    const edge = run("edge", { status: "no_changes", updatedAt: ago(7 * DAY) });
    const g = groupRuns([old, edge, ...finished], NOW);
    expect(g.recent).toHaveLength(20);
    expect(g.recent[0]?.issueId).toBe("f0");
    expect(g.recent.map((r) => r.issueId)).not.toContain("old");
    expect(groupRuns([old, edge], NOW).recent.map((r) => r.issueId)).toEqual(["edge"]);
  });

  it("drops statuses it does not know and finished runs with an unreadable time", () => {
    const g = groupRuns(
      [
        run("future", { status: "paused" as Run["status"] }),
        run("bad", { status: "timed_out", updatedAt: "yesterday-ish" }),
      ],
      NOW,
    );
    expect(Object.values(g).flat()).toEqual([]);
  });
});

describe("relativeTime", () => {
  it("counts seconds, minutes, hours and days", () => {
    expect(relativeTime(0)).toBe("just now");
    expect(relativeTime(4_999)).toBe("just now");
    expect(relativeTime(5_000)).toBe("5 s ago");
    expect(relativeTime(59_999)).toBe("59 s ago");
    expect(relativeTime(3 * MIN)).toBe("3 min ago");
    expect(relativeTime(2 * 60 * MIN)).toBe("2 h ago");
    expect(relativeTime(3 * DAY)).toBe("3 d ago");
  });

  it("says just now for a clock in the future or an unreadable time", () => {
    expect(relativeTime(-90_000)).toBe("just now");
    expect(relativeTime(Number.NaN)).toBe("just now");
  });
});

describe("prLabel", () => {
  it("reads the pull request number from a GitHub URL", () => {
    expect(prLabel("https://github.com/o/r/pull/42")).toBe("PR #42");
    expect(prLabel("https://github.com/o/r/pull/42/files")).toBe("PR #42");
    expect(prLabel("https://github.com/o/r/compare/x")).toBe("PR");
  });
});
