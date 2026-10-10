// Structure, names and keyboard. Styling lives in popover.css; keep the data-* hooks it and the
// tests rely on.
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
  const part = (name: string, text: string) => h("span", { "data-part": name }, text);
  const parts: Child[] = [
    part("identifier", r.identifier),
    part("repo", `${r.repo}@${r.ref}`),
    part("status", status),
    time(Date.parse(r.updatedAt), now, { "data-part": "time" }),
  ];
  if (r.prUrl) parts.push(part("pr", prLabel(r.prUrl)));
  if (r.status === "awaiting_approval") parts.push(part("hint", "Reply /publish on the issue"));
  const b = h("button", {
    type: "button",
    "data-row": "",
    "data-status": r.status,
    "data-key": `run:${r.issueId}`,
  });
  // The commas stay for screen readers and copy-paste; popover.css hides them visually.
  parts.forEach((p, i) => b.append(...(i ? [h("span", { class: "sep" }, ", "), p] : [p])));
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

/** The character's mood and the one-line summary beside it, most urgent first. */
function status({ snap, now }: View): [mood: string, summary: string] {
  const s = snap.state;
  if (s.kind === "daemonNotRunning") return ["asleep", "Not running"];
  if (s.kind !== "ok") return ["lost", "Disconnected"];
  const g = groupRuns(s.runs, now);
  if (g.awaiting.length) return ["waiting", `${g.awaiting.length} awaiting approval`];
  if (g.running[0]) return ["working", `Working on ${g.running[0].identifier}`];
  const last = g.recent[0];
  if (last && now - Date.parse(last.updatedAt) <= 3_600_000) {
    if (last.status === "published") return ["happy", `Published ${last.identifier}`];
    if (last.status === "failed" || last.status === "timed_out")
      return ["sad", `${last.identifier} ${STATUS_LABEL[last.status].toLowerCase()}`];
  }
  return ["idle", "Idle"];
}

/**
 * The character: every face part and accessory is drawn once, and popover.css shows the ones a
 * mood uses. A constant, so setting it as markup carries no run data.
 */
const CHARACTER = `<svg viewBox="0 -10 80 80">
<g class="leg"><path class="ink" fill="none" stroke-width="3.6" d="M34 46q0 3-3 5"/><ellipse class="ink" fill="#f08a24" cx="28" cy="53" rx="6" ry="3.6"/></g>
<g class="leg"><path class="ink" fill="none" stroke-width="3.6" d="M46 46q1 3 4 4.5"/><ellipse class="ink" fill="#f08a24" cx="53" cy="52" rx="6" ry="3.6"/></g>
<g class="arm-l"><path class="ink" fill="none" stroke-width="3.6" d="M16 28q-6 2-7 8"/><circle class="ink" fill="#fff" cx="8.5" cy="38" r="4.8"/></g>
<g class="arm-r"><path class="ink" fill="none" stroke-width="3.6" d="M62 24q6-2 7-9"/><path class="ink" fill="#b07a45" d="M68.5 15l6-15l2.6 1l-6 15z"/><rect class="ink" fill="#9aa0a8" x="69" y="-6.5" width="12.5" height="6" rx="2" transform="rotate(22 75.25 -3.5)"/><circle class="ink" fill="#fff" cx="69" cy="15" r="4.8"/></g>
<path class="ink" fill="#c4c5cb" d="M60 4q6 1 7 7v28q-1 6-7 7z"/>
<rect class="ink" fill="#ececef" x="16" y="2" width="46" height="44" rx="12"/>
<g class="v eyes"><g class="eye"><ellipse class="ink" stroke-width="2.2" fill="#fff" cx="33.5" cy="21" rx="6" ry="9"/><g class="pupil"><ellipse fill="#141416" cx="35.5" cy="23" rx="3" ry="4.4"/><circle fill="#fff" cx="34.6" cy="21.3" r="1.2"/></g></g><g class="eye"><ellipse class="ink" stroke-width="2.2" fill="#fff" cx="45.5" cy="21" rx="6" ry="9"/><g class="pupil"><ellipse fill="#141416" cx="47.5" cy="23" rx="3" ry="4.4"/><circle fill="#fff" cx="46.6" cy="21.3" r="1.2"/></g></g></g>
<g class="v lids"><path fill="#ececef" d="M26.5 10h13v6.8l-13 3.4z"/><path fill="#ececef" d="M39.5 10h13v10.2l-13-3.4z"/><path class="ink" fill="none" stroke-width="2.2" d="M27.6 19.9l11.9-3.1M39.5 16.8l11.9 3.1"/></g>
<g class="v ink eyes-happy" fill="none" stroke-width="3"><path d="M28 24q5.5-7 11 0"/><path d="M40 24q5.5-7 11 0"/></g>
<g class="v ink eyes-closed" fill="none" stroke-width="3"><path d="M28 22q5.5 4.5 11 0"/><path d="M40 22q5.5 4.5 11 0"/></g>
<g class="cheeks" fill="#ff9fb0"><ellipse cx="23.5" cy="33" rx="3.6" ry="2.1"/><ellipse cx="55.5" cy="33" rx="3.6" ry="2.1"/></g>
<g class="v m-grin"><path class="ink" stroke-width="2.2" fill="#3a1216" d="M34 34q5.5 1.6 11 0q-1 6-5.5 6t-5.5-6z"/><path fill="#ef5350" d="M36.6 38q2.9-1.7 5.8 0q-1.2 1.8-2.9 1.8t-2.9-1.8z"/></g>
<ellipse class="v ink m-o" stroke-width="2.2" fill="#3a1216" cx="39.5" cy="37" rx="2.8" ry="3.4"/>
<ellipse class="v ink m-small" stroke-width="2" fill="#3a1216" cx="39.5" cy="37" rx="1.7" ry="2"/>
<path class="v ink m-frown" fill="none" stroke-width="2.6" d="M35.5 39q4-3.6 8 0"/>
<path class="v ink m-wavy" fill="none" stroke-width="2.2" d="M34.7 37.5q1.2-1.6 2.4 0t2.4 0t2.4 0t2.4 0"/>
<g class="v ink zz" fill="none" stroke-width="2"><path d="M66-2h5l-5 6h5"/><path d="M73-10h3.5l-3.5 4h3.5"/></g>
<g class="v question"><path class="ink" fill="none" stroke-width="2.6" d="M66-6q0-5 5-5t5 4q0 3-4 4.4v2.6"/><circle fill="#141416" cx="72" cy="4" r="1.5"/></g>
<g class="v sparkles"><path class="ink spark" stroke-width="1.2" fill="#f4b400" d="M8-8l1.4 3.6l3.6 1.4l-3.6 1.4l-1.4 3.6l-1.4-3.6l-3.6-1.4l3.6-1.4z"/><path class="ink spark" stroke-width="1.2" fill="#f4b400" d="M3 9l1 2.5l2.5 1l-2.5 1l-1 2.5l-1-2.5l-2.5-1l2.5-1z"/></g>
<path class="v ink sweat" stroke-width="1.4" fill="#8ecbff" d="M67 8q2.6 3.6 2.6 5.4a2.6 2.6 0 0 1-5.2 0q0-1.8 2.6-5.4z"/>
</svg>`;

/** Small line icons, drawn once (constants, so setting them as markup carries no run data). */
const ICON = {
  awaiting: `<svg viewBox="0 0 16 16"><path d="M4.5 2h7M4.5 14h7M5 2c0 3.5 6 4 6 6s-6 2.5-6 6M11 2c0 3.5-6 4-6 6s6 2.5 6 6"/></svg>`,
  running: `<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z"/></svg>`,
  queued: `<svg viewBox="0 0 16 16"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>`,
  settings: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/></svg>`,
};

function icon(name: keyof typeof ICON): HTMLElement {
  const e = h("span", { class: "icon", "aria-hidden": "true" });
  e.innerHTML = ICON[name];
  return e;
}

/** Top bar: whether the daemon is connected, and the settings menu. */
function topbar({ snap, now, autostart }: View, act: Actions): HTMLElement {
  const s = snap.state;
  const [tone, label] =
    s.kind === "ok"
      ? ["ok", "Connected"]
      : s.kind === "daemonNotRunning"
        ? ["off", "Not running"]
        : ["bad", "Disconnected"];
  const pill = h("p", { "data-pill": "", "data-tone": tone }, label);
  if (snap.lastOkAt !== null)
    pill.append(" · Updated ", time(snap.lastOkAt, now, { "data-updated": "" }));

  const toggle = h("input", { type: "checkbox", "data-key": "autostart" }) as HTMLInputElement;
  toggle.checked = autostart;
  toggle.addEventListener("change", () => act.setAutostart(toggle.checked));
  const summary = h(
    "summary",
    { "aria-label": "Settings", "data-key": "settings" },
    icon("settings"),
  );
  return h(
    "nav",
    {},
    pill,
    h(
      "details",
      { class: "menu" },
      summary,
      h(
        "div",
        {},
        h("label", {}, toggle, " Launch at login"),
        button("Open README", { "data-key": "readme" }, () => act.open(README_URL)),
        button("Quit", { "data-key": "quit" }, () => act.quit()),
      ),
    ),
  );
}

/** Hero card: the character, its summary, recent activity and the counts that matter. */
function hero(view: View): HTMLElement {
  const [mood, summary] = status(view);
  const character = h("div", { class: "mascot", "data-mood": mood, "aria-hidden": "true" });
  character.innerHTML = CHARACTER;
  const s = view.snap.state;
  const g = s.kind === "ok" ? groupRuns(s.runs, view.now) : null;
  const strip = h("div", { "data-activity": "", "aria-hidden": "true" });
  for (const r of (g?.recent ?? []).slice(0, 10).reverse())
    strip.append(h("span", { "data-status": r.status }));
  const stat = (name: keyof typeof ICON, label: string, n: number) =>
    h("div", { "data-stat": name }, h("dt", {}, icon(name), label), h("dd", {}, String(n)));
  return h(
    "div",
    { class: "hero" },
    character,
    h(
      "div",
      {},
      h(
        "div",
        { class: "title" },
        h("span", { class: "dot", "data-mood": mood, "aria-hidden": "true" }),
        h("h1", {}, "autoforge"),
        strip,
      ),
      h("p", { "data-summary": "" }, summary),
      ...(g
        ? [
            h(
              "dl",
              {},
              stat("awaiting", "Awaiting approval", g.awaiting.length),
              stat("running", "Running", g.running.length),
              stat("queued", "Queued", g.queued.length),
            ),
          ]
        : []),
    ),
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
    const menuOpen = root.querySelector("details")?.open ?? false;
    root.replaceChildren(
      topbar(view, act),
      hero(view),
      h("div", { class: "runs" }, ...body(view, act)),
    );
    if (menuOpen) root.querySelector("details")!.open = true; // a toggle must not close the menu
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

/** Pupil offset (SVG units) for a cursor dx/dy px away: towards it, at most 2.5 so it stays in the eye. */
export function gaze(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (!len) return [0, 0];
  const k = Math.min(2.5, len / 8) / len;
  return [dx * k, dy * k];
}

/**
 * The character's pupils follow the cursor while it is over the popover (the webview sees no
 * mouse events outside it) and go back to the mood's own gaze when it leaves.
 */
export function installGaze(root: HTMLElement): void {
  const doc = root.ownerDocument;
  let frame = 0;
  doc.addEventListener("mousemove", (e) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const pupil of root.querySelectorAll<SVGGElement>(".pupil")) {
        const eye = pupil.parentElement!.firstElementChild!.getBoundingClientRect();
        const [x, y] = gaze(
          e.clientX - (eye.left + eye.width / 2),
          e.clientY - (eye.top + eye.height / 2),
        );
        pupil.style.translate = `${x}px ${y}px`; // CSSOM, which the CSP allows
      }
    });
  });
  doc.documentElement.addEventListener("mouseleave", () => {
    cancelAnimationFrame(frame);
    for (const pupil of root.querySelectorAll<SVGGElement>(".pupil")) pupil.style.translate = "";
  });
}
