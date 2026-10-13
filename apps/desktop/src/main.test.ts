import { beforeEach, expect, it, vi } from "vitest";

const calls: string[] = [];
const heights: unknown[] = [];
const state = { kind: "ok", runs: [] as unknown[] };
const autostart = false;
const failSet = true;
let failRead = false;
let failState = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { height?: number }) => {
    calls.push(cmd);
    if (cmd === "fit_popover") heights.push(args?.height);
    if (cmd === "current_state") {
      if (failState) throw new Error("down");
      return { state, lastOkAt: null };
    }
    if (cmd === "autostart_enabled") {
      if (failRead && calls.filter((c) => c === "autostart_enabled").length > 1)
        throw new Error("x");
      return autostart;
    }
    if (cmd === "set_autostart" && failSet) throw new Error("denied");
    return undefined;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

beforeEach(() => {
  calls.length = 0;
  failRead = false;
  failState = false;
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const box = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

it("shows the real autostart state after a rejected toggle", async () => {
  await import("./main");
  box().click();
  expect(box().checked).toBe(true);
  await flush();
  expect(box().checked).toBe(false);
});

it("keeps the previous state when the read-back also fails, without an unhandled rejection", async () => {
  failRead = true;
  await import("./main");
  box().click();
  await flush();
  expect(box().checked).toBe(false);
});

it("draws the unreachable state when current_state rejects", async () => {
  failState = true;
  await import("./main");
  expect(document.body.textContent).toContain("Can't reach the daemon");
});

it("fits the window to the panel's height whenever the panel resizes", async () => {
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
    },
  );
  heights.length = 0;
  await import("./main");
  Object.defineProperty(document.getElementById("app"), "offsetHeight", { value: 312 });
  resized();
  expect(heights).toEqual([312]);
  vi.unstubAllGlobals();
});
