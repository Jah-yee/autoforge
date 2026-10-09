import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Run, Snapshot } from "./model";
import { installKeys, README_URL, tick, update, type Actions } from "./view";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const run = (id: string, fields: Partial<Run> = {}): Run => ({
  issueId: id,
  identifier: id.toUpperCase(),
  status: "queued",
  repo: "o/r",
  ref: "main",
  queuedAt: ago(10 * MIN),
  updatedAt: ago(3 * MIN),
  issueUrl: `https://linear.app/acme/issue/${id.toUpperCase()}`,
  ...fields,
});

let root: HTMLElement;
let act: { [K in keyof Actions]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.getElementById("app")!;
  act = { open: vi.fn(), copy: vi.fn(), hide: vi.fn(), setAutostart: vi.fn(), quit: vi.fn() };
});

const snap = (state: AppState, lastOkAt: number | null = NOW - 5_000): Snapshot => ({
  state,
  lastOkAt,
});
const show = (s: Snapshot, o: { now?: number; autostart?: boolean } = {}) =>
  update(root, { snap: s, now: o.now ?? NOW, autostart: o.autostart ?? false }, act as Actions);
const text = () => root.textContent?.replace(/\s+/g, " ") ?? "";
const rows = () => [...root.querySelectorAll<HTMLButtonElement>("[data-row]")];
const button = (name: string) =>
  [...root.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  )!;

describe("states", () => {
  it("explains how to start a daemon that is not running, with copy buttons", () => {
    show(snap({ kind: "daemonNotRunning" }, null));
    expect(text()).toContain("autoforge serve isn't running");
    expect(text()).toContain("autoforge service install");
    button("Copy autoforge serve").click();
    button("Copy autoforge service install").click();
    expect(act.copy.mock.calls).toEqual([["autoforge serve"], ["autoforge service install"]]);
  });

  it("shows the reason when the daemon cannot be reached, and that it retries", () => {
    show(snap({ kind: "unreachable", reason: "connection refused" }));
    expect(text()).toContain("Can't reach the daemon");
    expect(text()).toContain("connection refused");
    expect(text()).toContain("Retrying every 5 s");
  });

  it("treats a refused token as unreachable", () => {
    show(snap({ kind: "unauthorized" }));
    expect(text()).toContain("Can't reach the daemon");
    expect(text()).toContain("refused the token");
  });

  it("tells a new user how to start their first run", () => {
    show(snap({ kind: "ok", runs: [] }));
    expect(text()).toContain(
      "No runs yet. Label a Linear issue autoforge and assign it to yourself.",
    );
  });

  it("says so when every run is older than the recent window", () => {
    show(
      snap({
        kind: "ok",
        runs: [run("old", { status: "failed", updatedAt: ago(8 * 1440 * MIN) })],
      }),
    );
    expect(text()).toContain("Nothing in the last 7 days.");
    expect(rows()).toHaveLength(0);
  });
});

describe("run list", () => {
  const runs = [
    run("eng-4", { status: "published", prUrl: "https://github.com/o/r/pull/4" }),
    run("eng-3", { queuedAt: ago(1 * MIN) }),
    run("eng-2", { queuedAt: ago(9 * MIN) }),
    run("eng-1", { status: "awaiting_approval", prUrl: undefined }),
    run("eng-5", { status: "running", repo: "o/api", ref: "dev" }),
  ];

  it("groups runs under headings in order, with counts", () => {
    show(snap({ kind: "ok", runs }));
    expect([...root.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Awaiting approval (1)",
      "Running (1)",
      "Queued (2)",
      "Recent (1)",
    ]);
    for (const section of root.querySelectorAll("section")) {
      const heading = section.querySelector("h2")!;
      expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    }
  });

  it("names each row with identifier, repo, status, time, PR and the approval hint", () => {
    show(snap({ kind: "ok", runs }));
    expect(rows().map((r) => r.textContent)).toEqual([
      "ENG-1, o/r@main, Awaiting approval, 3 min ago, Reply /publish on the issue",
      "ENG-5, o/api@dev, Running, 3 min ago",
      "ENG-2, o/r@main, Queued, position 1, 3 min ago",
      "ENG-3, o/r@main, Queued, position 2, 3 min ago",
      "ENG-4, o/r@main, Published, 3 min ago, PR #4",
    ]);
  });

  it("opens the PR when there is one, otherwise the issue", () => {
    show(snap({ kind: "ok", runs }));
    rows()[4]!.click();
    rows()[0]!.click();
    expect(act.open.mock.calls).toEqual([
      ["https://github.com/o/r/pull/4"],
      ["https://linear.app/acme/issue/ENG-1"],
    ]);
  });

  it("keeps a row without any link focusable but inert (an older daemon sends no issueUrl)", () => {
    show(snap({ kind: "ok", runs: [run("eng-9", { issueUrl: undefined })] }));
    const row = rows()[0]!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    row.click();
    expect(act.open).not.toHaveBeenCalled();
  });

  it("renders issue text as text, never as markup", () => {
    show(snap({ kind: "ok", runs: [run("x", { identifier: '<img src=x onerror="alert(1)">' })] }));
    expect(root.querySelector("img")).toBeNull();
    expect(rows()[0]!.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("keyboard", () => {
  beforeEach(() => installKeys(root, act as Actions));
  const press = (key: string) =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );

  it("moves between rows with the arrow keys and stops at the ends", () => {
    show(snap({ kind: "ok", runs: [run("a"), run("b", { queuedAt: ago(1 * MIN) })] }));
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    press("ArrowUp");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("does nothing on arrow keys when there are no rows", () => {
    show(snap({ kind: "ok", runs: [] }));
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("goes to the last row on ArrowUp from outside the list, and leaves other focus alone", () => {
    show(snap({ kind: "ok", runs: [run("a"), run("b", { queuedAt: ago(1 * MIN) })] }));
    button("Quit").focus();
    press("ArrowUp");
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("does not swallow arrow keys when focus is in the footer and no row is entered", () => {
    show(snap({ kind: "ok", runs: [run("a")] }));
    const check = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    check.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    check.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("closes the popover on Escape from anywhere", () => {
    show(snap({ kind: "daemonNotRunning" }, null));
    press("Escape");
    expect(act.hide).toHaveBeenCalledOnce();
  });
});

describe("footer", () => {
  it("shows when the data was last updated, and nothing before the first good poll", () => {
    show(snap({ kind: "ok", runs: [] }, NOW - 5_000));
    expect(text()).toContain("Updated 5 s ago");
    show(snap({ kind: "daemonNotRunning" }, null));
    expect(text()).not.toContain("Updated");
  });

  it("toggles launch at login, opens the README and quits", () => {
    show(snap({ kind: "ok", runs: [] }), { autostart: true });
    const toggle = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    expect(toggle.labels?.[0]?.textContent).toContain("Launch at login");
    toggle.click();
    expect(act.setAutostart).toHaveBeenCalledWith(false);
    button("Open README").click();
    expect(act.open).toHaveBeenCalledWith(README_URL);
    button("Quit").click();
    expect(act.quit).toHaveBeenCalledOnce();
  });
});

describe("unknown status", () => {
  it("does not crash or print undefined for a status from a newer daemon", () => {
    show(
      snap({
        kind: "ok",
        runs: [run("n", { status: "paused" as Run["status"] }), run("k", { status: "running" })],
      }),
    );
    expect(text()).not.toContain("undefined");
    expect(rows().map((r) => r.textContent)).toEqual(["K, o/r@main, Running, 3 min ago"]);
  });
});

describe("updates", () => {
  it("puts the checkbox back to the real state when a toggle did not take effect", () => {
    show(snap({ kind: "ok", runs: [] }), { autostart: false });
    const toggle = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.click();
    expect(toggle.checked).toBe(true);
    show(snap({ kind: "ok", runs: [] }), { autostart: false });
    expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  });

  it("does not touch a relative time whose text is unchanged", () => {
    show(snap({ kind: "ok", runs: [run("a")] }, NOW));
    const node = rows()[0]!.querySelector("[data-at]")!.firstChild;
    tick(root, NOW + 10_000);
    expect(rows()[0]!.querySelector("[data-at]")!.firstChild).toBe(node);
  });

  it("does not rebuild the list when only the poll time changes, so focus stays put", () => {
    show(snap({ kind: "ok", runs: [run("a")] }, NOW - 5_000));
    rows()[0]!.focus();
    const focused = document.activeElement;
    show(snap({ kind: "ok", runs: [run("a")] }, NOW), { now: NOW + 7_000 });
    expect(document.activeElement).toBe(focused);
    expect(text()).toContain("Updated 7 s ago");
  });

  it("puts focus back on the same run after the list changes", () => {
    show(snap({ kind: "ok", runs: [run("a"), run("b", { queuedAt: ago(1 * MIN) })] }));
    rows()[1]!.focus();
    show(
      snap({
        kind: "ok",
        runs: [
          run("z", { queuedAt: ago(20 * MIN) }),
          run("a"),
          run("b", { queuedAt: ago(1 * MIN) }),
        ],
      }),
    );
    expect(document.activeElement?.textContent).toMatch(/^B,/);
  });

  it("ticks relative times forward without new data", () => {
    show(snap({ kind: "ok", runs: [run("a")] }, NOW));
    tick(root, NOW + 2 * MIN);
    expect(rows()[0]!.textContent).toContain("5 min ago");
    expect(text()).toContain("Updated 2 min ago");
  });
});
