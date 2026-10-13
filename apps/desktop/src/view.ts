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

/** A piece of bar stock in a status's temper colour (popover.css). */
const bar = (status: string) =>
  h("span", { class: "bar", "data-temper": status, "aria-hidden": "true" });

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
  b.append(bar(r.status));
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
 * The character: a soft ember with forge goggles. Its body takes the mood's temper colour, and
 * the goggles come down while it works. Every face part and prop is drawn once and popover.css
 * shows the ones a mood uses. A constant, so setting it as markup carries no run data.
 */
const CHARACTER = `<svg viewBox="0 0 100 92">
<ellipse class="ground" cx="50" cy="87.5" rx="24" ry="3.5"/>
<g class="figure">
<g class="feet"><ellipse class="tone" cx="40" cy="83" rx="7.5" ry="4.5"/><ellipse class="tone" cx="60" cy="83" rx="7.5" ry="4.5"/></g>
<path class="body" d="M50 8C60 20 84 28 84 56C84 74 69 85 50 85C31 85 16 74 16 56C16 28 40 20 50 8Z"/>
<path class="shade" d="M20 64C26 77 38 82 50 82C63 82 74 76 80 64C74 73 63 78 50 78C37 78 26 73 20 64Z"/>
<path class="sheen" d="M27 44C29 33 37 25 45 20"/>
<ellipse class="tone arm-l" cx="17" cy="61" rx="5.5" ry="7.5"/>
<ellipse class="tone arm-r" cx="83" cy="61" rx="5.5" ry="7.5"/>
<g class="cheeks"><ellipse cx="31" cy="64" rx="4.6" ry="2.6"/><ellipse cx="69" cy="64" rx="4.6" ry="2.6"/></g>
<g class="v eyes"><g class="eye"><ellipse class="socket" cx="41" cy="55" rx="4.5" ry="5.5"/><g class="pupil"><ellipse class="dark" cx="41" cy="55" rx="3.4" ry="4.4"/><circle class="glint" cx="40" cy="53.2" r="1.3"/></g></g><g class="eye"><ellipse class="socket" cx="59" cy="55" rx="4.5" ry="5.5"/><g class="pupil"><ellipse class="dark" cx="59" cy="55" rx="3.4" ry="4.4"/><circle class="glint" cx="58" cy="53.2" r="1.3"/></g></g></g>
<g class="v line brows-up"><path d="M36 46q4.5-3 9-1"/><path d="M55 45q4.5-2 9 1"/></g>
<g class="v line brows-sad"><path d="M36 48.5L45 45.5"/><path d="M55 45.5L64 48.5"/></g>
<g class="v line eyes-happy"><path d="M36 57q5-6.5 10 0"/><path d="M54 57q5-6.5 10 0"/></g>
<g class="v line eyes-closed"><path d="M36 55q5 4 10 0"/><path d="M54 55q5 4 10 0"/></g>
<path class="v line m-smile" d="M46 65q4 3.5 8 0"/>
<g class="v m-grin"><path class="dark" d="M44.5 64h11q-1 7-5.5 7t-5.5-7z"/><path class="tongue" d="M47 69q3-2 6 0q-1.2 2-3 2t-3-2z"/></g>
<ellipse class="v dark m-o" cx="50" cy="67" rx="2.8" ry="3.4"/>
<ellipse class="v dark m-small" cx="50" cy="66.5" rx="1.8" ry="2"/>
<path class="v line m-frown" d="M46 68.5q4-3.5 8 0"/>
<path class="v line m-wavy" d="M44.5 66.5q1.4-1.6 2.8 0t2.8 0t2.8 0t2.8 0"/>
<g class="goggles"><path class="strap" d="M17 38Q50 26 83 38"/><circle class="lens" cx="41" cy="33" r="7"/><circle class="lens" cx="59" cy="33" r="7"/><path class="lens-glint" d="M37 31q1.5-2.2 4.2-2.4M55 31q1.5-2.2 4.2-2.4"/></g>
</g>
<g class="v sparks"><path d="M10 30l-6-3M11 41l-7 1M90 30l6-3M89 41l7 1"/></g>
<g class="v sparkles"><path class="star" d="M14 10l1.6 4l4 1.6l-4 1.6l-1.6 4l-1.6-4l-4-1.6l4-1.6z"/><path class="star" d="M86 18l1.1 2.7l2.7 1.1l-2.7 1.1l-1.1 2.7l-1.1-2.7l-2.7-1.1l2.7-1.1z"/></g>
<g class="v alert"><path class="line" stroke-width="3.6" d="M86 5v11"/><circle class="dark" cx="86" cy="21.5" r="2.2"/></g>
<g class="v line zz"><path d="M74 14h6l-6 7h6"/><path d="M84 4h4.5l-4.5 5h4.5"/></g>
<g class="v question"><path class="line" stroke-width="3" d="M79 9q0-6 6-6t6 5q0 3.5-5 5v3"/><circle class="dark" cx="86" cy="21" r="1.9"/></g>
<path class="v sweat" d="M75 36q2.8 3.8 2.8 5.8a2.8 2.8 0 0 1-5.6 0q0-2 2.8-5.8z"/>
</svg>`;

/** Small line icons, drawn once (constants, so setting them as markup carries no run data). */
const ICON = {
  settings: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/></svg>`,
};

function icon(name: keyof typeof ICON): HTMLElement {
  const e = h("span", { class: "icon", "aria-hidden": "true" });
  e.innerHTML = ICON[name];
  return e;
}

/** Footer bar: whether the daemon is connected, and the settings menu. */
function footer({ snap, now, autostart }: View, act: Actions): HTMLElement {
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
    "footer",
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
  const stat = (status: string, label: string, n: number) =>
    h("div", { "data-stat": status }, h("dt", {}, bar(status), label), h("dd", {}, String(n)));
  return h(
    "div",
    { class: "hero" },
    character,
    h(
      "div",
      {},
      h("div", { class: "title" }, h("h1", {}, "autoforge"), strip),
      h("p", { "data-summary": "" }, summary),
      ...(g
        ? [
            h(
              "dl",
              {},
              stat("awaiting_approval", "Awaiting approval", g.awaiting.length),
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
      hero(view),
      h("div", { class: "runs" }, ...body(view, act)),
      footer(view, act),
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
