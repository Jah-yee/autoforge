---
version: 1
slug: "apps-desktop-src-view-ts"
primary_target: "apps/desktop/src/view.ts"
related_targets: ["apps/desktop/index.html"]
---

Scope: autoforge desktop tray popover (apps/desktop), 360x480, Operate mode. Built one component per user approval: 1 shell + tokens + header character, 2 run rows, 3 group headings, 4 empty/unreachable states, 5 footer, 6 tray and app icons.

Audience/job: the engineer who owns the daemon glances at it many times a day; health and approvals weigh equally. Avoid: dashboard look, colourful status noise, terminal cosplay, generic SaaS.

## Direction contract

THESIS: a quiet panel with a character whose pose and face say the daemon's state before any text is read. Refuses the coloured-pill status list every agent tool ships.

OWN-WORLD: user-pinned from two reference images (seed rounds re-rolled twice, then pinned). Near-black rounded panels in dark, soft paper-grey panels in light; system UI sans; compact label/value rows, values right-aligned tabular. Two UI hues only: coral for "needs you" and failure, green for working and success; everything else ink and muted ink. The character (approved after five rounds) is a kawaii rubber-hose cube: big Looney Tunes eyes, pink cheeks, ink outlines, white gloves, orange shoes, a hammer; no background tile; a white sticker outline in dark mode. Seven moods (waiting, working, happy, idle, sad, asleep, lost) each own a pose, face and prop.

STORY: open, see the character's mood and one summary line, then the list of what needs you, what runs, what finished; act by opening the PR or issue.

FIRST VIEWPORT: header panel: 76px character left, "autoforge" and the summary line right. Below, a second panel holding the grouped runs; footer controls at the bottom edge.

FORM: user-pinned reference (not from the ordered list); seed key 726b9a60.

Progress: component 1 (shell, tokens, character) approved and committed 2026-10-11. Next: 2 run rows. DESIGN.md and the finish review come after the last component.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
