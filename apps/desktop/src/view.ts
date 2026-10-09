// Structure, names and keyboard only. Visual design comes later through /impeccable.
import { groupRuns, prLabel, relativeTime, STATUS_LABEL, type Run, type Snapshot } from "./model";

export type Actions = {
  open(url: string): void;
  copy(text: string): void;
  hide(): void;
  setAutostart(on: boolean): void;
  quit(): void;
};

export type View = { snap: Snapshot; now: number; autostart: boolean };

export const README_URL = "https://github.com/amanjr09-glitch/autoforge#readme";

type Child = Node | string;

/** Builds an element. Text always goes in as text nodes: run data is untrusted. */
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function button(label: string, attrs: Record<string, string>, onClick: () => void): HTMLElement {
  const b = h("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** A relative time that tick() keeps current. */
const time = (at: number, now: number, attrs: Record<string, string> = {}) =>
  h("span", { "data-at": String(at), ...attrs }, relativeTime(now - at));

function command(text: string, act: Actions): HTMLElement {
  return h(
    "p",
    {},
    h("code", {}, text),
    " ",
    button("Copy", { "aria-label": `Copy ${text}`, "data-key": `copy:${text}` }, () =>
      act.copy(text),
    ),
  );
}

function row(r: Run, status: string, now: number, act: Actions): HTMLElement {
  const parts: Child[] = [
    r.identifier,
    `${r.repo}@${r.ref}`,
    status,
    time(Date.parse(r.updatedAt), now),
  ];
  if (r.prUrl) parts.push(prLabel(r.prUrl));
  if (r.status === "awaiting_approval") parts.push("Reply /publish on the issue");
  const b = h("button", { type: "button", "data-row": "", "data-key": `run:${r.issueId}` });
  parts.forEach((p, i) => b.append(...(i ? [", ", p] : [p])));
  const url = r.prUrl ?? r.issueUrl;
  if (url) b.addEventListener("click", () => act.open(url));
  else b.setAttribute("aria-disabled", "true");
  return b;
}

function section(
  id: string,
  title: string,
  runs: Run[],
  status: (r: Run, i: number) => string,
  now: number,
  act: Actions,
): HTMLElement[] {
  if (!runs.length) return [];
  return [
    h(
      "section",
      { "aria-labelledby": id },
      h("h2", { id }, `${title} (${runs.length})`),
      h("ul", {}, ...runs.map((r, i) => h("li", {}, row(r, status(r, i), now, act)))),
    ),
  ];
}

function body({ snap, now }: View, act: Actions): HTMLElement[] {
  const s = snap.state;
  switch (s.kind) {
    case "daemonNotRunning":
      return [
        h("p", {}, "autoforge serve isn't running."),
        h("p", {}, "Start it in a terminal, or install it as a login service:"),
        command("autoforge serve", act),
        command("autoforge service install", act),
      ];
    case "unreachable":
    case "unauthorized":
      return [
        h("p", {}, "Can't reach the daemon."),
        h(
          "p",
          {},
          s.kind === "unauthorized"
            ? "It refused the token in status.json (it may have just restarted)."
            : s.reason,
        ),
        h("p", {}, "Retrying every 5 s."),
      ];
    case "ok": {
      if (!s.runs.length)
        return [
          h(
            "p",
            {},
            "No runs yet. Label a Linear issue ",
            h("code", {}, "autoforge"),
            " and assign it to yourself.",
          ),
        ];
      const g = groupRuns(s.runs, now);
      // groupRuns drops statuses missing from STATUS_LABEL (a newer daemon), so this lookup is total.
      const label = (r: Run) => STATUS_LABEL[r.status];
      const list = [
        ...section("awaiting", "Awaiting approval", g.awaiting, label, now, act),
        ...section("running", "Running", g.running, label, now, act),
        ...section("queued", "Queued", g.queued, (_, i) => `Queued, position ${i + 1}`, now, act),
        ...section("recent", "Recent", g.recent, label, now, act),
      ];
      return list.length ? list : [h("p", {}, "Nothing in the last 7 days.")];
    }
  }
}

function footer({ snap, now, autostart }: View, act: Actions): HTMLElement {
  const toggle = h("input", { type: "checkbox", "data-key": "autostart" }) as HTMLInputElement;
  toggle.checked = autostart;
  toggle.addEventListener("change", () => act.setAutostart(toggle.checked));
  return h(
    "footer",
    {},
    ...(snap.lastOkAt === null
      ? []
      : [h("p", {}, "Updated ", time(snap.lastOkAt, now, { "data-updated": "" }))]),
    h("label", {}, toggle, " Launch at login"),
    button("Open README", { "data-key": "readme" }, () => act.open(README_URL)),
    button("Quit", { "data-key": "quit" }, () => act.quit()),
  );
}

const shown = new WeakMap<HTMLElement, string>();

/**
 * Shows a snapshot. The DOM is rebuilt only when what it shows changes, not on every poll, so
 * focus and screen-reader position survive the 5 second refresh.
 */
export function update(root: HTMLElement, view: View, act: Actions): void {
  const { snap } = view;
  const key = JSON.stringify([snap.state, view.autostart, snap.lastOkAt === null]);
  if (shown.get(root) !== key) {
    const focused = document.activeElement?.getAttribute("data-key");
    root.replaceChildren(h("h1", {}, "autoforge"), ...body(view, act), footer(view, act));
    shown.set(root, key);
    if (focused)
      [...root.querySelectorAll<HTMLElement>("[data-key]")]
        .find((e) => e.dataset.key === focused)
        ?.focus();
  } else {
    // A toggle that did not take effect leaves the checkbox flipped; show the real state.
    const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (box) box.checked = view.autostart;
    if (snap.lastOkAt !== null)
      root.querySelector("[data-updated]")?.setAttribute("data-at", String(snap.lastOkAt));
  }
  tick(root, view.now);
}

/** Moves every relative time on to `now`. */
export function tick(root: HTMLElement, now: number): void {
  for (const e of root.querySelectorAll<HTMLElement>("[data-at]")) {
    const text = relativeTime(now - Number(e.dataset.at));
    if (e.textContent !== text) e.textContent = text; // untouched text is not re-announced
  }
}

const installed = new WeakMap<Document, (e: KeyboardEvent) => void>();

/** Arrow keys move between rows, Enter opens (native button), Esc closes the popover. */
export function installKeys(root: HTMLElement, act: Actions): void {
  const doc = root.ownerDocument;
  const previous = installed.get(doc);
  if (previous) doc.removeEventListener("keydown", previous); // one handler per document
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return act.hide();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-row]")];
    if (!rows.length) return;
    const down = e.key === "ArrowDown";
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = i === -1 ? (down ? 0 : rows.length - 1) : down ? i + 1 : i - 1;
    rows[Math.max(0, Math.min(next, rows.length - 1))]?.focus();
    e.preventDefault();
  };
  installed.set(doc, onKey);
  doc.addEventListener("keydown", onKey);
}
