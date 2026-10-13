---
version: 1
slug: "apps-desktop-src-view-ts"
primary_target: "apps/desktop/src/view.ts"
related_targets: ["apps/desktop/index.html","apps/desktop/src/popover.css"]
---

Scope: autoforge desktop tray popover (apps/desktop), Operate mode. Redesign (2026-10-13): the previous near-black kawaii-cube world is replaced; treat it as evidence only. Panel is 400 px wide with adaptive height: short when idle, growing with the run list up to a cap, then scrolling.

Audience/job: the engineer who owns the daemon glances at it many times a day; health and approvals weigh equally. User asked for a mascot that is livelier than the old cube. Avoid: terminal cosplay (user's explicit "feels wrong"), dashboard look, coloured-pill status lists, generic SaaS.

Keep: accessible names, data-key/data-row/data-at/data-part hooks the view tests rely on, the CSP (same-origin stylesheet only, inline SVG ok), prefers-color-scheme and prefers-reduced-motion support.

## Direction contract

THESIS: every run is a piece of steel at a small smith's anvil, and its temper colour is its state. Refuses the coloured-pill status list and the dark panel with an orange glow.

OWN-WORLD: the steel tempering chart as the only hues: straw (queued), bronze (running), purple (awaiting you), blue (published), plus soot ink, chalk ground and cold steel grey for failed or old. Light mode is chalk-on-workshop paper, dark mode is soot with chalk ink; neither glows. The mascot (user-pinned after the anvil draft was rejected): a plush, blobby ember with dot eyes, blush, nub arms and feet and forge goggles, in the style of OpenAI's dots; its body takes the mood's temper colour, goggles come down while working. Everything snaps to one 8 px cell; rows are whole cells (raise from Crouwel grid). The issue identifier is each row's headline, status is carried by a temper-colour bar, not a pill (raise from Saville catalog). No hue outside the set (raise from Ikeda).

STORY: open, read the smith's mood and one summary line; a run awaiting you sits at the top as the hot bar until you act (raise from feed); below, running, queued, recent; click a row to open its PR or issue.

FIRST VIEWPORT: 400 px wide. Top: smith at 88 px left on the anvil line, wordmark, summary and the connection line right. Then the hot bar (only when something awaits approval). Then the temper list. Footer: connection line and settings menu (opens upward).

FORM: assigned grounded candidate 7 of 7 (the forge, the name's literal reading); seed key c66b0967. Code-led, no comp.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
