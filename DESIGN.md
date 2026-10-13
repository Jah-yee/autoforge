---
name: autoforge
description: A small smith's tempering chart in the tray. Every run is a piece of steel, and its temper colour is its state.
colors:
  straw: "#dcb04e"
  straw-dark: "#e8c46a"
  bronze: "#b06a2a"
  bronze-dark: "#d58b47"
  purple: "#6b3d8c"
  purple-dark: "#a27ac9"
  blue: "#2b579c"
  blue-dark: "#6e9be0"
  scale: "#868d95"
  scale-dark: "#9aa1a8"
  hot: "#6b3d8c"
  hot-dark: "#5d3580"
  on-hot: "#fbf8f2"
  ground: "#f3eee5"
  ground-dark: "#1e1a17"
  well: "#e8e1d5"
  well-dark: "#2b2622"
  ink: "#221e1a"
  ink-dark: "#f1ebe1"
  muted: "#675f55"
  muted-dark: "#ada294"
  faint: "#a99f92"
  faint-dark: "#6e655b"
  rule: "#dcd3c5"
  rule-dark: "#39322c"
  m-ink: "#1d1916"
  mascot-blush: "#ff8a8a"
  mascot-lens: "#cfe0ea"
  mascot-sweat: "#9cc0ee"
typography:
  display:
    fontFamily: "Big Shoulders, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Big Shoulders, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: "24px"
    letterSpacing: "0.01em"
  label:
    fontFamily: "Big Shoulders, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 700
    lineHeight: "16px"
    letterSpacing: "0.06em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Ubuntu, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Ubuntu, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tnum"
  body-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Ubuntu, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "tnum"
  meta:
    fontFamily: "system-ui, -apple-system, Segoe UI, Ubuntu, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11.5px"
    fontWeight: 400
rounded:
  bar: "2px"
  code: "5px"
  item: "8px"
  row: "9px"
  field: "12px"
  panel: "16px"
  round: "999px"
spacing:
  half: "4px"
  cell: "8px"
  double: "16px"
  row-indent: "40px"
  row: "48px"
  row-hint: "64px"
  mascot: "112px"
  panel-width: "400px"
  list-max: "392px"
components:
  panel:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.panel}"
    width: "{spacing.panel-width}"
  hot-bar:
    backgroundColor: "{colors.hot}"
    textColor: "{colors.on-hot}"
    rounded: "{rounded.field}"
    padding: "8px 0"
  run-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.row}"
    padding: "4px 8px 4px 40px"
    height: "{spacing.row}"
  run-row-hover:
    backgroundColor: "{colors.well}"
  run-row-hint:
    height: "{spacing.row-hint}"
  run-identifier:
    typography: "{typography.headline}"
  section-heading:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
  temper-bar:
    rounded: "{rounded.bar}"
    width: "18px"
    height: "7px"
  menu:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    width: "180px"
  menu-item:
    rounded: "{rounded.item}"
    padding: "6px 8px"
  menu-item-hover:
    backgroundColor: "{colors.well}"
  command-button:
    textColor: "{colors.ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.round}"
  command-button-hover:
    backgroundColor: "{colors.well}"
  code:
    backgroundColor: "{colors.well}"
    typography: "{typography.mono}"
    rounded: "{rounded.code}"
    padding: "2px 6px"
---

# Design System: autoforge

## Overview

**Creative North Star: "The Smith's Tempering Chart"**

Every run is a piece of steel at a small smith's anvil, and its temper colour is its state. The tray panel reads like a workshop chart pinned above the bench: chalk ground, soot ink, and the oxide colours steel takes as it heats (straw, bronze, purple, blue) as the only hues. Cold steel grey is the colour of failure and age. Light mode is chalk on workshop paper; dark mode is soot with chalk ink. Neither glows.

The panel is dense and quiet. It is 400px wide with its height following the content, and everything snaps to one 8px cell. A plush ember mascot stands on a heavy bench line at the top and carries the mood of the whole forge; below it, the list of runs reads as a rack of labelled bar stock. The issue identifier is each row's headline, set in a condensed industrial display face. Status is a short bar of tempered steel, never a coloured pill.

What waits on the user rises to the top as the hot bar: a purple field that holds the runs awaiting approval until the user acts. It is the one loud surface; the rest of the panel stays in chalk and ink.

**Key Characteristics:**

- Four temper hues plus cold steel, each bound to exactly one run state.
- Chalk and soot grounds, switched by `prefers-color-scheme`, with no glow in either.
- One 8px cell; rows are whole cells (48px, 64px with the approval hint).
- Big Shoulders for the wordmark, identifiers and section headings; system UI for everything else.
- A plush ember mascot whose body takes the mood's temper colour, with seven moods that each read still.
- Failure is drawn hollow, so state never rests on colour alone.

## Colors

A tempering chart on chalk: four oxide hues and cold steel carry run state, and everything else is ink, chalk and soot.

### Primary

The temper set. Each hue means one run state and nothing else. Every hue has a lighter dark-mode value so it holds contrast on soot.

- **Straw** (`straw` / `straw-dark`): queued. Also the mascot's resting body colour.
- **Bronze** (`bronze` / `bronze-dark`): running and publishing. A running bar slowly heats toward straw and back.
- **Temper Purple** (`purple` / `purple-dark`): awaiting approval. Also the colour of the one-line summary while something waits on the user.
- **Tempered Blue** (`blue` / `blue-dark`): published.
- **Cold Steel** (`scale` / `scale-dark`): failed and timed out, always drawn as a hollow outline rather than a fill. Also the disconnected footer dot and the sad, lost and asleep mascot.

### Secondary

- **Hot Bar Purple** (`hot` / `hot-dark`): the awaiting-approval field. It matches temper purple in light mode and drops to a deeper purple on soot so chalk text holds contrast.
- **Hot Chalk** (`on-hot`): text and bars inside the hot bar. Muted, faint and well tones inside the field are mixed from it and the field colour, never borrowed from the chalk ground.

### Neutral

- **Chalk Ground** (`ground`) / **Soot Ground** (`ground-dark`): the panel surface.
- **Well** (`well` / `well-dark`): hover fills, inline code and the open settings button. A recess in the ground, never a raised card.
- **Ink** (`ink` / `ink-dark`): primary text, the 3px bench line, and the connected dot.
- **Muted** (`muted` / `muted-dark`): secondary text: repo, status, time, section headings, legend labels, dimmed zero counts.
- **Faint** (`faint` / `faint-dark`): separator dots and the neutral bar for a run with no temper.
- **Rule** (`rule` / `rule-dark`): the panel border, footer rule, menu border and scrollbar.

### Character colours (mascot only)

- **Mascot Ink** (`m-ink`): the mascot's line work, eyes and goggle strap. On soot, props that float off the body (alert, sleep marks, question mark) switch to chalk ink.
- **Blush** (`mascot-blush`), **Lens** (`mascot-lens`), **Sweat** (`mascot-sweat`): user-pinned character colours. They exist inside the mascot drawing only and are not UI hues.

### Named Rules

**The Temper Rule.** A temper hue means a run state and nothing else. Queued is straw, running and publishing are bronze, awaiting approval is purple, published is blue, failed and timed out are cold steel. No hue outside this set enters the UI.

**The Hollow Failure Rule.** Failed and timed-out steel is drawn as a 1.5px cold-steel outline with no fill, in the bar, the activity rack and the disconnected dot. State never rests on colour alone.

**The Ink Indicator Rule.** An indicator that is not a run state uses ink, not a temper hue. The connected dot is solid ink.

## Typography

**Display Font:** Big Shoulders (variable 100 to 900, self-hosted woff2, SIL OFL), with system-ui fallback
**Body Font:** system-ui (with -apple-system, Segoe UI, Ubuntu, sans-serif)
**Label/Mono Font:** ui-monospace (with SF Mono, Menlo, Consolas), for shell commands only

**Character:** a condensed industrial face, like stamped stock tags, set against the platform's own UI font. The display face names things (the forge, the issue, the section); the system face says everything else. Numbers are tabular throughout.

### Hierarchy

- **Display** (800, 30px, 0.9): the lowercase wordmark only.
- **Headline** (700, 16px, 24px line): the issue identifier, the headline of every run row.
- **Title** (650, 15px, 1.25): the one-line summary under the wordmark.
- **Body** (400, 13px, 1.4): base text and empty-state sentences. The first sentence of a multi-line empty state is 650 in ink; a lone sentence stays regular.
- **Body Small** (400, 12px, 16px line): run row details and the temper legend. Counts are 700 in ink; zero counts drop to regular weight in muted.
- **Label** (700, 12.5px, 16px line, 0.06em, uppercase): section headings with their counts, in the display face, muted.
- **Meta** (400, 11.5px): relative time, the footer line and command buttons.
- **Mono** (400, 11.5px): inline shell commands in a well-coloured chip.

### Named Rules

**The Stamped Tag Rule.** Big Shoulders is reserved for the wordmark, identifiers and section headings. Sentences, statuses and controls are never set in it.

## Layout

A fixed 400px panel whose height follows its content; the host fits the window to it. Every spacing value snaps to the 8px cell: 4px half steps inside rows, 8px gaps between rows and sections, 16px panel gutters.

- **Header:** a two-column grid, the 112px mascot column and the text column with a 16px gap, bottom-aligned on a 3px ink bench line. The mascot's feet sit on that line. Beside it: the wordmark with the activity rack (the last ten runs, oldest first, as 4 by 14px bar ends) pushed to the right, then the summary, then the temper legend with counts.
- **List:** the hot bar first (only when something awaits approval), then Running, Queued and Recent. Rows are 48px, or 64px with the approval hint line. Row content is indented 40px (five cells) so identifiers align past the temper bar, which sits 12px in from the row edge. The list scrolls past 392px, and its last 16px fade out so a cut row reads as more below.
- **Row anatomy:** line one is identifier and time (time pushed right); line two is repo, status and PR joined by faint middle dots; an optional third line carries the approval hint in 650 weight.
- **Footer:** the connection line on the left and the settings button on the right, above a 1px rule. The settings menu opens upward.

### Named Rules

**The One Cell Rule.** Spacing, row heights and indents are whole or half 8px cells. A value off that grid is a defect, not a variant.

## Elevation & Depth

Flat. Depth is tonal: the well is a recess in the ground, the bench line is a heavy rule, and the hot bar is a coloured field rather than a lifted card. Two small inset shadows give bar stock its edge, and the only lifted surface is the settings menu.

### Shadow Vocabulary

- **Bar edge** (`box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.16)`): the hairline edge on every filled temper bar.
- **Hollow steel** (`box-shadow: inset 0 0 0 1.5px var(--scale)`): the outline that replaces the fill for failed, timed out and disconnected.
- **Menu lift** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.2)`): the settings menu only, because it overlays the list.

### Named Rules

**The No Glow Rule.** Nothing glows. The dark panel is soot, not a lit forge: no coloured halos, no gradients behind content, no orange bloom.

## Shapes

Softly rounded rectangles in a strict size order: the panel (16px) holds the hot bar and menu (12px), which hold rows (9px) and menu items (8px). Bar stock is a 2px-rounded slug, inline code is 5px, the settings button is a 24px circle and command buttons are full pills. Borders are 1px rule lines except the 3px ink bench line under the header. The mascot is the one organic form: a soft flame-shaped blob with nub arms and feet.

## Components

### Run Row

Quiet, typographic, headed by the identifier.

- **Shape:** gently rounded (9px), full width, 48px or 64px tall.
- **Content:** the temper bar absolutely placed at the left, identifier in the headline face, muted details below.
- **Hover:** a well fill. Disabled rows drop to 70% opacity and do not hover.
- **Focus:** a 2px current-colour outline offset 2px, shared by every focusable element. Arrow keys move between rows.

### Temper Bar

A short piece of bar stock (18 by 7px, 2px corners) filled with the row's temper and edged by a 16% black hairline. Running and publishing bars heat toward straw and back on a 1.6s alternate cycle. Failed and timed out are hollow. In the legend, a zero count dims its bar to 40%.

### Hot Bar

The awaiting-approval section, drawn as one purple field (12px corners, 8px vertical padding) with chalk text and chalk bars. It re-derives muted, faint and well from chalk mixed into the field colour.

- **Hover:** inside the field a row never paints a fill. The identifier takes a 2px underline offset 3px instead, so no card appears inside the field.

### Section Heading

Uppercase display-face label with its count in parentheses, muted, 8px in from the row edge.

### Settings Menu

- **Trigger:** a 24px round button holding a two-slider line glyph (16px, 1.4 stroke, current colour). Hover and open fill it with well and turn it ink.
- **Menu:** a ground-coloured panel (12px corners, 1px rule border, menu lift shadow, 180px minimum) that opens upward from the footer. Items are 8px-rounded rows with a well hover.

### Connection Line

Meta-size muted text with a 7px dot before it: solid ink when connected, hollow cold steel when disconnected, faint while unknown.

### Command Button and Code

Empty states show shell commands as mono chips on the well, each with a pill-shaped Copy button (1px rule border, meta size, well on hover).

### The Ember (signature)

A plush, blobby ember with dot eyes, blush, nub arms and feet and forge goggles, drawn as inline SVG at 112px and standing on the bench line. Its body takes the mood's temper colour; a darker tone (14% black mix) shapes feet and arms; a soft shade, white sheen and ground shadow give it volume. Seven moods, each carried by colour, face and pose so it reads with motion off:

- **Idle:** straw, open eyes, small smile, slow breath and blink.
- **Waiting:** purple, brows up, open mouth, waving arm, alert mark.
- **Working:** bronze, goggles down over the eyes, straw sparks, squash and stretch.
- **Happy:** blue, closed happy eyes, grin, both arms up, straw sparkles, hopping.
- **Sad:** cold steel, sad brows, frown, sweat drop, slumped.
- **Asleep:** cold steel faded toward the ground, closed eyes, drifting sleep marks.
- **Lost:** cold steel, wavy mouth, question mark, eyes looking side to side.

## Do's and Don'ts

### Do:

- **Do** bind every temper hue to its run state through the `data-status` or `data-temper` hook, so one rule colours the bar, the rack and the legend; the mascot takes the same hue through its mood.
- **Do** draw failed and timed-out steel hollow (1.5px cold-steel inset outline, no fill).
- **Do** snap every spacing value to the 8px cell and keep rows at 48px, or 64px with the approval hint.
- **Do** set the wordmark, identifiers and section headings in Big Shoulders and everything else in system UI with tabular numbers.
- **Do** use ink for indicators that are not run states, such as the connected dot.
- **Do** make every mascot mood readable with motion off: `prefers-reduced-motion` stops all animation.
- **Do** put all styling in the linked same-origin stylesheet. The CSP allows no inline styles; SVG is inline markup built from constants.
- **Do** keep the `data-*` hooks stable. Tests use them as contracts.

### Don't:

- **Don't** add a hue outside the temper set to the UI. Blush, lens and sweat live inside the mascot only.
- **Don't** use a temper hue for anything that is not a run state: connection, links, toggles, selection or success messages.
- **Don't** show status as a coloured pill. Status is a temper bar plus a muted word.
- **Don't** let the dark panel glow: no orange halo, no coloured shadow, no gradient behind content.
- **Don't** paint a hover card inside the hot bar or nest a card inside any field. Underline the identifier instead.
- **Don't** set sentences or controls in the display face, or make a whole empty state bold.
- **Don't** set style attributes or inject stylesheets at runtime.
