# Atlas fun pass: "Trail Map"

**What it is:** the decided visual direction that takes Atlas from tidy-and-calm to warm and
playful, without losing the tool. One direction, no options (Will: "you decide").
**Status:** decided 2026-11-08; revised the same day after Will's review (display type toned
down, hovered-bar gap fixed, streak trail replaced by ringed cells, Setup on his new layout,
a section per screen). Builder applies it after `phase2-usage` and `setup-write` merge.
**Mockup:** `mockup/dashboard.html`, `mockup/setup.html` (open through any local server, e.g.
`python -m http.server` in `mockup/`; `?theme=dark`, `?still=1` skips first-paint motion,
`?pin=bar-24,tile-3,btn-new` forces hover states, `?pin=confirm-1` shows a delete confirm,
Setup `?done=0..4` sets the checklist). Screenshots, 1280x800:
`dashboard-light.png`, `dashboard-light-hover.png`, `dashboard-dark-hover.png`,
`setup-light-hover.png`, `setup-dark.png`; `font-tone.png` compares the display tones.

## The idea in one line

Your Claude use is a landscape you have walked: busy days are terrain, streak days are
ringed in clay, and the clay spark is the flag planted on every peak, record and finish line.

- **Kept:** palette, the spark logo, the launch intro, Phosphor icons, system body type,
  the topo-contour thread, every safety and performance rule.
- **Changed:** a bundled display face for numbers and titles, a real chart language
  (terrain, ringed streak, flag), rounder shapes, springy hover/press, icon micro-motions, friendly
  copy, three rationed celebrations.
- **Removed:** the "Live" chip (banned in every app), and on Setup the "Read only" chip, the
  "Updated" caption and the "Where it all lives" summary card (Will's Setup layout).

## References (what to take, and why)

| Reference | Take this | Why it fits Atlas |
|---|---|---|
| GitHub contribution graph | The heat-grid grammar: 7-day columns, 5 quantile bands, today in a fixed corner, tooltip per cell | Everyone reads it instantly; we swap green for clay elevation bands |
| Apple Fitness rings | Ring vs a personal baseline ("of a usual day"), round caps, a second lap past 100 % | Dad is an Apple fan; a ring says "how am I doing" with no axis to read |
| Duolingo | Streak as the friendly hook; celebrate only milestones; chunky friendly numerals | Fun from progress, not decoration. We take the restraint, not the mascot |
| Spotify Wrapped | One huge number with one plain sentence under it | The hero card and the page greeting work the same way |
| Things 3 | The satisfying check fill, whitespace, one accent | The Setup checklist completion moment |
| Linear | Fast tooltips, sliding segmented thumbs, crisp dark mode | Keeps "fun" feeling precise, not toy-like |
| Raycast | Tinted icon blobs on tiles, instant feedback | The Setup type tiles |
| Arc | Icons that react on hover (wiggle, tilt), springy sidebar | Cheap, CSS-only delight on things you can click |
| Stripe dashboard | Sparkline per row, "+18 % vs last week" deltas, exact tooltip numbers | Data stays exact while looking friendly |
| Cron / Notion Calendar | Time-of-day greeting, today emphasis | "Good evening." as the page title |
| Headspace | Rounded warmth, playful empty states | The topo-blob empty states and softer radii |
| USGS topographic maps | Elevation bands, summit markers | The "atlas" thread made into the chart language |

## Anti-references (must NOT look like)

- Grafana / admin panels: a dozen same-size charts, gridlines everywhere, tiny grey labels.
- A Claude / Anthropic product: no Anthropic or Claude marks, no imitation of their type or layout.
- Duolingo cartoon: no mascot, no confetti, no sound, no "Great job!" toasts.
- Neon or glass dashboards: no glow, no gradients on cards, no glassmorphism.
- The generic AI look: cream page + serif display + terracotta. Atlas has the warm page and
  the clay, so the display face must stay a casual sans, never a serif.

## Tokens: additions to `src/styles/tokens.css`

Core colors stay exactly as they are. Add the following (light in `:root`, dark in BOTH dark
blocks; `tokens.test.ts` checks the two dark copies match).

```css
/* :root (light) */
--font-display: "Recursive Variable", var(--font-ui);
--display-axes: "CASL" 0.4;         /* Recursive, a little Casual; weight comes from font-weight */
--heat-0: #f0ebe4;  --heat-1: #f2d9c6;  --heat-2: #e9b394;
--heat-3: #dc8a63;  --heat-4: #c96442;  --heat-5: #9c4524;
--chart-1: #c96442; /* accent */   --chart-2: #5b7083; /* slate */
--chart-3: #a8875f; /* sand */     --chart-4: #8e877d; /* everything else */
--bar-rest: #d07a55;                /* 3.18:1 on surface */
--shadow-lift: 0 10px 24px -10px rgb(31 29 26 / 0.22), 0 2px 6px -2px rgb(31 29 26 / 0.08);
--shadow-accent: inset 0 1px 0 rgb(255 255 255 / 0.22), 0 1px 2px rgb(31 29 26 / 0.12),
  0 6px 14px -6px rgb(180 83 47 / 0.6);
--shadow-accent-hover: inset 0 1px 0 rgb(255 255 255 / 0.22), 0 2px 4px rgb(31 29 26 / 0.1),
  0 10px 20px -8px rgb(180 83 47 / 0.7);
--accent-solid-hover: #bf5c37;
--tip-bg: #1f1d1a;  --tip-ink: #faf8f5;

/* dark (both copies) */
--heat-0: #2b2724;  --heat-1: #4a3226;  --heat-2: #7a4630;
--heat-3: #b35e3d;  --heat-4: #e07a55;  --heat-5: #f4ad8a;
--chart-1: #e07a55; --chart-2: #8fa3b5; --chart-3: #c9a678; --chart-4: #7d766d;
--bar-rest: #a35b3d;                /* 3.10:1 on surface */
--shadow-lift: 0 12px 28px -10px rgb(0 0 0 / 0.7), 0 2px 6px -2px rgb(0 0 0 / 0.5);
--shadow-accent: inset 0 1px 0 rgb(255 255 255 / 0.25), 0 1px 2px rgb(0 0 0 / 0.4),
  0 6px 16px -6px rgb(224 122 85 / 0.55);
--shadow-accent-hover: inset 0 1px 0 rgb(255 255 255 / 0.25), 0 2px 4px rgb(0 0 0 / 0.4),
  0 10px 22px -8px rgb(224 122 85 / 0.7);
--accent-solid-hover: #e8896a;
--tip-bg: #ede8e1;  --tip-ink: #1c1a17;

/* not theme-dependent: CHANGED values */
--r-control: 8px;  --r-card: 14px;  --r-sheet: 18px;  --r-pill: 999px;   /* was 6 / 10 / 14 */
--dur-press: 90ms; --dur-hover: 220ms; --dur-spring: 320ms;
--dur-count: 700ms; --dur-draw: 800ms; --stagger: 30ms; --lift: -2px;
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);   /* ~10 % overshoot */
--ease-expo: cubic-bezier(0.16, 1, 0.3, 1);
/* reduced motion block: also set --lift: 0px */
```

Tailwind names (`@theme inline`): `--color-heat-0..5`, `--color-chart-1..4`,
`--color-bar-rest`, `--color-tip`, `--color-tip-ink`, `--font-display`,
`--shadow-lift`, `--shadow-accent`, `--radius-pill`.

Contrast test (`tokens.test.ts`): add `chart-1..4` and `bar-rest` to the graphic checks
(>= 3:1 on surface, both themes; all pass, values measured 2026-11-08). The heat bands are
exempt on purpose (heat-1/2 are under 3:1 by design): the grid always has a legend, a
tooltip per cell and the existing Table view, so color is never the only carrier.

## Type

**Decision: keep the system font for body; add Recursive (Casual) for display and numbers.**

- Why not change the body: SF Pro on the Mac is what an Apple fan expects, it costs nothing at
  first paint, and Segoe UI Variable is fine on Windows. The spreadsheet feel came from
  uniform cards, thin bars and grey labels, not from the body face.
- Why Recursive: OFL, variable, made by Arrow Type. Its Casual axis warms the letterforms
  like a cartographer's hand lettering, which is the atlas thread in type.
- **Tone (Will, 2026-11-08: "a little too playful, tone it down"):** `CASL 0.4`, not 1, and
  weights eased by about 40 (hero 760, title 720). Compared side by side in
  `mockup/font-tone.png` (CASL 1 / 0.5 / 0.4 / 0.3 / 0 at hero and title size): 0.4 keeps
  the soft terminals and the friendly `a`, `g` and `y` while reading as a confident sans;
  0 loses the warmth (plain Linear). Its digits are tabular by
  default (measured: every digit is the same 0.6 em advance), so count-ups never jitter.
  Not used by any sibling app (checked: Inter, Onest, Outfit, Space Grotesk, Instrument,
  Source Sans and Geist are taken elsewhere).
- Install: `npm i @fontsource-variable/recursive` and `import "@fontsource-variable/recursive/casl.css";`
  in `main.tsx` (wght 300-1000 + CASL axes; latin file is 108 KB; Vite bundles it, no CDN).
  In `main.tsx`, `await Promise.race([document.fonts.load('760 1em "Recursive Variable"'), sleep(150)])`
  before handing off from the launch splash, so the first frame never swaps fonts.

| Role | Face | Size / line | Weight | Extra | Use |
|---|---|---|---|---|---|
| hero | Recursive CASL 0.4 | 56 / 56 | 760 | -0.02 em | The one hero number per page |
| title | Recursive CASL 0.4 | 32 / 38 | 720 | -0.01 em | Page greeting / page title |
| stat | Recursive CASL 0.4 | 28 / 32 | 760 | -0.01 em | Card stats (streak days, totals) |
| tile | Recursive CASL 0.4 | 24 / 26 | 760 | | Setup tile counts |
| figure | Recursive CASL 0.4 | 20 / 24 | 720 | | Ring centers, section headings ("Skills") |
| small | Recursive CASL 0.4 | 15 / 20 | 700 | | Inline figures (412k, 62 %) |
| tooltip value | Recursive CASL 0.4 | 17 / 22 | 720 | | Tooltip line 2 |
| lead | system | 15 / 22 | 400 | | Page sub line |
| body | system | 14 / 20 | 400 / 500 / 600 | | Everything else |
| caption | system | 12 / 16 | 400 / 600 | | Labels, axis, legend |
| code | SF Mono / Cascadia | 12 | 400 | | Paths, code viewer (unchanged) |

Never Recursive for body copy, buttons, nav, inputs, tables or code. Display weights stay in
700-760 and CASL stays 0.4 everywhere; nothing else.

## Hero numbers

- `useCountUp(value)`: requestAnimationFrame, 700 ms, easeOutExpo (`1 - 2^(-10t)`), from the
  previously shown value (0 only on the first paint of a launch). Format every frame with
  `Intl.NumberFormat`. Skip the animation (show the value) when the change is < 1 %, on
  reduced motion, and after the first view of a page in this launch.
- No layout shift: stack an invisible copy of the final string under the animating one
  (CSS grid `grid-area: 1/1`), so width is fixed from frame one.
- Units sit beside the number in body 16/600 `ink-2` ("tokens"); estimates always say
  "estimated" or "est.".
- Deltas: pill `accent-tint` / `accent-text`, 12/700, arrow icon rotated 45 deg ("18 % vs last
  week"). Usage up or down is neither good nor bad, so never green or red.

## Charts

**Approach: hand-written SVG React components, no chart library.** Recharts (listed in the old
stack line) is dropped: it brings d3 modules and its own animation layer for five chart types
we can draw in a few hundred lines, and its default look is the one we are leaving. Files:
`src/components/charts/{Bars,Ridge,Sparkline,Ring,HeatGrid,StackBar,ChartTooltip}.tsx`, plus
`src/lib/chartPaths.ts` (monotone cubic path, rounded-top bar path, quantile bands). Paths
come from `useMemo` on data; motion is CSS classes only; hover is one transparent hit rect
per datum; keyboard: the chart group is focusable, Left/Right moves the active datum and shows
its tooltip; each chart has an `aria-label` summary and the existing Table toggle stays.

**First paint (all charts):** animate once per chart per app launch (a module-level `Set`
of seen chart ids); later visits render complete. Entry keyframes use
`animation-fill-mode: backwards`, never `both`: a filled `scale` or `opacity` keeps
overriding the element afterwards and silently kills its hover transition. `html.reduced` or OS reduced motion: no
draw, no grow, values appear with a 120 ms fade.

### Activity bars (30 days / 7 days)
- Bar width 62 % of the slot, min 4 px; top corners radius `min(6, w/2)`, flat bottom.
- Fill `--bar-rest`; today `--accent`; zero days a 3 px nub in `--heat-0` (the axis never
  looks broken).
- Y: no axis line; two dashed gridlines (`--line`, dash 2 4) at 50 % and 100 % of a nice max,
  labels right-aligned 11 px `ink-2` ("250k", "500k"). X: 4-5 ticks, last one "Today".
- Hover/focus: the **whole** bar fills `--accent-text` and its top rises 4 px while its
  bottom stays on the baseline: `scale: 1 var(--hs)` with `transform-origin` at the bottom
  edge (`transform-box: fill-box`), `--hs = (h + 4) / h` per bar, `--dur-hover`
  `--ease-spring`. No gap at the baseline, no shadow under it, then the tooltip.
  (Bug fixed 2026-11-08: the first mockup lifted the bar with `translate: 0 -4px`, which
  moved its bottom too and left a 4 px empty strip above the axis, and a 10 % ellipse
  "shadow" sat in that strip; Will saw the bottom of the hovered bar as empty.)
- Busiest bar in the range: the spark (18 px) floats 12 px above it; its tooltip line 1 adds
  "busiest day". The spark fades out while any bar's tooltip is open, so it never pokes
  out above the tooltip.
- First paint: each bar `scale: 1 0 -> 1 1` from the bottom, 560 ms `--ease-spring`,
  stagger 14 ms per bar.

### Ridge (the hero card's week, 7 points)
- Monotone cubic line, 2.5 px `--accent`, round caps; area under it a vertical gradient
  `--accent` 30 % -> 0 %.
- The summit: on the peak a 4.5 px dot (surface fill, 2 px accent ring), a dashed pole
  (1.25 px, dash 2 3) and the 22 px spark above it. Today: a 3.5 px dot at the end.
- Day initials under the points, 11 px; the peak's initial in `accent-text` 700.
- First paint: stroke draws (`stroke-dashoffset`) 800 ms ease-out, area fades in at 650 ms,
  summit springs up (scale .6 -> 1, rise 8 px) at 760 ms.

### Sparklines (one per project row)
- 64 x 20, 1.75 px `--accent`, round caps, no fill, 2.5 px end dot. No axis, no tooltip; the
  row itself is the hover target (`raised` background, 120 ms).

### Ring meter (Today; Setup checklist)
- Today: 104 px, stroke 11; Setup: 72 px, stroke 8. Track `--raised`; arc `--accent`, round
  cap, starts at 12 o'clock.
- Today is measured against a usual day (median of active days in the last 30), not a goal.
  Past 100 %, a second lap draws on top in `--accent-text`.
- Center: figure-size number + caption ("182k / tokens"); the completed Setup ring holds
  the 26 px spark instead of a number.
- First paint: arc from empty, 900 ms `--ease-expo`, 120 ms delay.

### Activity heat grid ("On a roll", 12 weeks)
- **Today is always the bottom-right cell.** Columns are rolling weeks: each column is 7
  consecutive days, top to bottom, the last column ends today, so the oldest day is
  top-left. (Rows are not weekdays; the tooltip carries the date.) With a range that is not
  a multiple of 7, the empty slots are at the top-left, never at the end.
- Cell 13 px, gap 4, radius 3.5. A small "Today" label (11 px, 600, `accent-text`) sits
  6 px right of the bottom-right cell, vertically centred on it.
- Color: `--heat-0` for no activity, else `--heat-1..5` by quantile of active days in view
  (cuts at 20 / 45 / 70 / 90 %).
- **Streak days get a clay ring** (Will: "just have the border of the square highlighted for
  every day that you're on"): a rect 1 px outside the cell, radius 4.5, 1.5 px `--accent`
  stroke, no fill; today's ring is 2 px `--accent-text`. Nothing connects the cells: no
  trail, no line, no dots. The streak length is counted from the data (consecutive active
  days ending today, or ending yesterday while today is still empty), so the ringed cells
  always match the "N days in a row" stat.
- Header: "On a roll", the stat ("9 days in a row"); the pill "Longest yet" only when the
  current streak is the longest on record. Footer: "Last 12 weeks" and a Less-More legend.
- Hover/focus a cell: `scale: 1.35` with `--ease-spring`, tooltip (date, tokens, sessions;
  the last cell says "Today, Sun, Nov 8").
- First paint: cells pop in by column (scale .4 -> 1, 300 ms spring, 18 ms per column), the
  rings and the Today label fade in at 700 ms.
- No streak (today inactive and yesterday inactive): no rings, header becomes "Last 12
  weeks", no pill. The Today label always shows.

### Model share (stacked bar)
- 14 px tall, 3 px gaps, inner segment radius 4, outer ends pill. Colors `--chart-1..4` in
  order of share (Opus, Sonnet, Haiku, other); tiny segments keep a 6 px minimum width.
- Legend rows under it: 10 px rounded-square dot, name 600, tokens `ink-2`, percent in
  display `small`, right-aligned; row hover `raised`.
- Hover a segment or its legend row: that segment grows to 22 px (`--ease-spring`), the others
  drop to 35 % opacity, the legend row highlights.
- First paint: segments grow from the left, 520 ms `--ease-expo`, 80 ms apart.

### Tooltip (all charts)
- Background `--tip-bg`, text `--tip-ink` (inverted against the page), radius 10, padding
  8 12 9, `--shadow-pop`, a 10 px rotated-square caret, `white-space: nowrap`.
- Three lines: caption 12 at 72 % ("Wed, Nov 4 · busiest day"), value in display 17/760
  ("412,860 tokens"), caption 12 at 72 % ("$13.95 est. · 6 sessions" / "A day off").
- Charts show it with no delay: opacity and a 4 px rise over 120 ms; it snaps to the datum,
  never follows the cursor. Keep it inside the card: if there is no room above, place it
  to the right of the datum. Plain (non-chart) tooltips keep Radix with a 400 ms delay.

## Buttons, cards and controls

All transforms and opacity only; press feedback starts on `pointerdown` in the same frame.

| Component | Rest | Hover | Press | Focus |
|---|---|---|---|---|
| Primary button | 34 px tall, radius 8, `accent-solid`, `--shadow-accent`, 14/600 | `accent-solid-hover`, `--shadow-accent-hover`, `translateY(-1px)`, 220 ms spring | `scale(.96)`, 90 ms | 2 px `accent-text` ring, offset 2 |
| Secondary button | `surface`, 1 px `line-strong` | `raised`, `translateY(-1px)` | `scale(.96)` | same ring |
| Icon button | 32 px square, radius 8 | `raised`, icon motion | `scale(.92)` | same ring |
| Segmented control | track `raised` radius 10, pad 3; thumb `surface` + 1 px line + small shadow | label to `ink` | thumb slides `transform` + `width`, 320 ms `--ease-spring` | ring on the group |
| Nav item | 36 px, radius 10 | `raised` 80 % | `scale(.97)` | ring |
| Nav active | one shared `accent-tint` pill slides between items, 320 ms spring; icon switches to Phosphor `fill` in `accent-text`, label 600 | | | |
| Clickable card | `surface`, 1 px `line`, radius 14 | `translateY(-2px)`, `--shadow-lift`, `line-strong`, 220 ms spring | `scale(.985)`, 90 ms | ring |
| Static card | same rest, never lifts | none | none | n/a |
| Setup type tile | equal size (72 px tall, 5 per row), icon blob 40 px radius 12 `accent-tint` / `accent-text`, count in display `tile`, label caption | clickable-card lift, blob fills `--accent` with `on-accent` icon, icon swaps to duotone + its motion, a caret slides in from the right (4 px, spring) | `scale(.985)` | ring |
| Setup tile, open | filled blob, 1 px `--accent` border, `accent-tint` wash at 60 %, caret stays in `accent-text`, `aria-pressed="true"` | | | |
| Delete (X) button | 28 px, radius 8, Phosphor `X` 16 px in `ink-2`, top-right of the card | `danger-tint` background, `danger` icon, the X turns 90 deg (220 ms spring) | `scale(.92)` | ring |
| Delete confirm | the card swaps in place: border `--danger`, `danger-tint` wash, "Delete <name>?" 600 + caption, Cancel (secondary) + Delete (`--danger` fill, `--bg` text) | Delete brightens 8 %, never lifts or wiggles | plain press scale | focus starts on Cancel |

No 3D tilt and no cursor spotlight on working screens; tilt is allowed only in Wrapped.

### Icon micro-motions (Phosphor; CSS keyframes, play once on hover-in or focus)

Implement as `<IconMotion motion="zap"><Lightning/></IconMotion>`: the wrapper renders the
regular and duotone weights stacked and crossfades them (120 ms) on hover, then plays the
keyframe on the icon. 360-520 ms, `--ease-out` unless noted; never loops.

| Motion | Keyframes | Used on |
|---|---|---|
| zap | scale 1 -> 1.22 (opacity .6) -> .94 -> 1 | Skills (Lightning) |
| tilt | rotate 0 -> -12 -> 6 -> 0 deg | Agents (Robot) |
| nudge | translateX 0 -> 3 px -> 0 | Commands, arrows, Open folder, carets, project chips |
| plug | translate (-2, 2) -> (1, -1) -> 0 | MCP servers (Plugs) |
| swing | rotate 0 -> 16 -> -9 -> 3 -> 0 deg, origin top center, 520 ms | Hooks (Anchor) |
| wiggle | rotate 0 -> -14 -> 10 -> -5 -> 0 deg | Plugins, Setup nav (Wrench), Wrapped (Sparkle) |
| bob | translateY 0 -> -3 px -> 0 | Instructions (BookOpen), Sessions nav |
| pop | scale 1 -> 1.2 -> .95 -> 1 | Rules, Permissions, Memory, Dashboard nav, checks |
| spin | rotate 0 -> 180 deg, 480 ms `--ease-spring` | Refresh, History nav, Settings nav, New (Plus) |

## Personality

### Copy rules
- Talk to "you"; numbers first, plain verbs, sentence case, no exclamation marks anywhere
  (celebrations end in a full stop too: "All set.").
- One warm line per page, under the title: the greeting on the Dashboard ("Good evening." +
  "You and Claude got through 1.2M tokens this week, most of it in recipe-box."), a count on
  Setup ("Claude has 24 skills, 9 agents and 5 MCP servers to work with.").
- Greeting by local time: morning 5-12, afternoon 12-17, evening 17-5. No name.
- Everything else stays plain tool language. Errors never joke, never apologize: say what
  happened and the next step. Never "Oops", "Uh-oh", "Awesome", emoji, or "Live".
- Freshness: a caption, "Updated just now" / "Updated 3 min ago". No dots that pulse.

### Celebrations (only these three, each at most once per launch)
1. **Setup checklist complete** (first time ever; persist `celebrated.setupComplete` in
   settings): the ring closes, the spark springs into its center (520 ms) and 8 clay rays
   burst out once (620 ms, `--ease-expo`); text "All set. Claude has everything it needs."
   Afterwards the card shows the calm complete state (ring + spark, no rays).
2. **Streak milestones** (3, 7, 14, 30, 100 days; persist the last one shown): on the first
   Dashboard view that day the streak stat pops once (scale 1 -> 1.15 -> 1) and the "Longest
   yet" pill appears if it is.
3. **New busiest day**: the spark lands on that bar with the summit spring; tooltip line 1
   says "busiest day". Shown once per new record.

No confetti, no sound, no modal, no toast for any of them. Nothing celebrates a routine
click, save or setting.

### Empty states
Topo contour background (existing `Topo`), the 40 px spark, one line that says what will
appear and one action. E.g. Sessions: "No sessions yet. Start Claude Code in any folder and
it shows up here." Dashboard before the first index: the cards render with flat
`--heat-0` bars and rings at 0 and the line "Reading your history. This runs once." (never
a spinner over the whole page).

### The spark and clay thread
- The spark marks only meaning: the peak (ridge, bars), completion, the sidebar streak
  pill, empty states, Wrapped. Max one spark per card. Never a bullet,
  divider or decoration.
- Clay (`--accent`) is the only expressive color. Slate and sand appear only inside charts.

## Motion

- **Page change:** the new page swaps in at once, its content fades from 0 and rises 8 px
  over 260 ms ease-out; direct children stagger 30 ms (cap 8 items, so <= 470 ms total).
  Leaving pages never animate. The sidebar pill slides at the same time (320 ms spring).
- **Lists** (sessions, setup cards): stagger only on first render of the page, 20 ms per
  item, capped at 12; filtering and search results update without motion.
- **Sheets** (Setup detail): keep `sheet-in`, 250 ms, no spring.
- **Instant input:** every hover and press state is CSS on the element itself (no React
  state round-trip); press starts on pointerdown; animations are interruptible (transitions,
  not keyframes, for hover/press).
- **Reduced motion** (OS setting or `ATLAS_REDUCE_MOTION`): `--travel`, `--lift` 0, press
  scale 1, no keyframes (icon motions, draws, grows, bursts, count-ups off), color and
  opacity fades only (120 ms).
- **Budget:** no animation runs while idle; nothing loops except the existing skeleton
  pulse while loading. Charts with > 200 marks (heat grid at a full year) skip the
  per-cell stagger and fade as one group.

## Screens: how the style lands on each page

Every screen gets the same type, cards, controls and motion; each has at most one loud zone
and the rest stays calm (Guardrails below). One hero number and one display title per page.

### Dashboard
As `mockup/dashboard.html`: greeting title, hero card (number + ridge), Today ring,
Activity bars, On a roll heat grid, Models stack, Projects with sparklines. The loud zone
is the hero card; everything below it is charts with hover only.

### Setup (Will's layout, 2026-11-08; `mockup/setup.html`)
- Header: display title "Setup" + the count line; Open folder (secondary) and New skill
  (primary) on the right. No path chip, no "Read only" chip, no "Updated" caption.
- **Setup checklist first**, full width: the 72 px ring (fraction done, "3/4" in display
  `figure`; the spark once complete), the card title + "3 of 4" pill, four steps in a row.
  A done step is a `raised` box with a filled clay tick, its name 600 and one fact
  ("24 skills found"). An open step has a dashed `line-strong` border, an empty tick ring
  and a small secondary "Set up" button. Completing the last step plays celebration 1 once.
- **Type tiles**, 10 equal tiles, 5 x 2, same size whatever the count. Clicking a tile opens
  that type below it: the section title, search placeholder and scope filter follow the
  open type (Skills by default). The open tile keeps its filled state (table above).
- **Item cards**, 2 columns: icon blob, name 600, two-line description, and an X in the
  corner instead of the old "On" chip. X never deletes on the first click: it swaps the card
  into the inline confirm; Esc or Cancel puts it back. After Delete the card collapses
  (height + opacity, 200 ms ease-out, no spring) and the tile count updates. The confirm
  copy comes from the `setup-write` spec (the mockup's "Claude stops using it." is a
  placeholder).
- The Setup detail sheet and code viewer stay calm.

### Sessions (with nested helpers; the built screens are in `docs/shots/phase2/`)
The layout stays as built (list, session detail, helper cards, helper detail); the style
goes on top. Subagents are "helpers" in the UI, as built.
- **List:** display title "Sessions" + the existing sub line; filters as built (dropdowns
  get the segmented-control hover and press). Rows stay a list, not cards: hover `raised`,
  no lift. Cost and tokens right-aligned with cost in display `small`; model chips keep
  their `--chart-1..4` dots in the Dashboard stack order. The "5 helpers" pill becomes
  `accent-tint` / `accent-text` with the Robot icon (its motion is `tilt` on row hover).
- **Session detail:** the cost is the page's one hero number (display `hero`, count-up on
  the first view); the split bar ("You and Claude" vs helpers) is the Dashboard stacked
  bar component (slate for you and Claude, clay for helpers) with its hover; "Spend as it
  ran" is the ridge component (no summit spark unless the run has a clear peak). Stat
  tiles (Tokens, Messages, Tool calls, Helpers) use display `stat`, static cards, no lift.
- **Helper cards** (2 columns, as built): clickable cards with the lift; the share bar
  ("6% of the session") is a 4 px rounded clay bar on a `--heat-0` track that grows from
  the left on first paint (520 ms `--ease-expo`, 40 ms stagger, cap 12). A helper started
  by another helper keeps the "Started by ..." line with the return-arrow icon, and the
  Started order indents it 20 px under its starter, hung off a 1.5 px `--line-strong`
  rail with a short elbow, so the nesting reads as a tree. The Started / Spend toggle is
  the segmented control (sliding thumb).
- **Through the session** bars are the Activity bars component, same hover (whole bar
  fills, top rises 4 px, baseline fixed) and tooltip.
- **Helper detail:** same hero treatment for its cost, "What it was asked" stays a calm
  quote box, "Through its run" uses the bars. Back links get the `nudge` motion.
- Transcript text and any code are calm zones: no springs, no count-ups.

### History
- Mostly calm. Header: display title "History" and one figure ("214 files kept").
- Timeline by day: caption 600 day headers; each event hangs off the same 1.5 px rail used
  for nested helpers, with an 8 px dot: `--accent` added or changed, `--chart-3` sand for
  "dated" (before Atlas), `ink-2` removed or renamed. Row: kind icon (Plus,
  ArrowsClockwise, X, ArrowRight), item name, the event summary, time. Row hover `raised`.
- The diff viewer, restore and anything destructive are calm zones: code font, no motion,
  the inline confirm pattern from Setup for restore or delete.

### Wrapped
- The one loud screen. Slides, each one huge number and one plain sentence (Spotify
  Wrapped): display at 96 / 96, weight 760, the same CASL 0.4; the sentence in body 20.
- Charts are the Dashboard components at slide size: busiest day = bars with the spark;
  streak = the heat grid for the year, clay rings on the longest streak, the last day
  bottom-right (labelled "Today" while the year is running, its date once it is over);
  longest session = the ridge.
- Slide change: slide + fade, 320 ms `--ease-spring`; Left / Right keys. Card tilt (max
  4 deg) is allowed here and nowhere else. The cover and the closing slide carry the spark.
- The honest coverage line (from the screens spec) sits under the cover in caption size;
  never extrapolate. Reduced motion: crossfade only.

### Settings
- Entirely calm. Section rail with the same sliding pill as the sidebar; sections stay
  cards of rows (label, hint, control). The "Atlas on this computer" hero card uses the app
  icon and body type, no display number, no count-up.
- Controls keep their normal hover and press. "Rebuild from scratch" uses the inline
  confirm pattern from Setup's delete; destructive buttons never lift.

## Guardrails (what stays calm)

- Settings, the Setup detail sheet and code viewer, History diffs, the Pending Changes queue,
  tables, errors, and anything destructive: no springs, no count-ups, no icon motion, no spark.
- Destructive buttons never lift or wiggle; they keep the plain press scale.
- One hero number per page. One display title per page. One celebration per launch.
- Hover effects only on things that respond to a click (chart marks count, because they
  open a tooltip).
- If a motion ever delays input or drops a frame on Will's machine, it goes, not the
  input path.

## Builder checklist

1. Tokens + Tailwind names + contrast test additions above; radius change in one place.
2. `@fontsource-variable/recursive` + the font-ready wait in `main.tsx`; a `.font-display`
   utility (`font-family: var(--font-display); font-variation-settings: var(--display-axes)`).
3. `useCountUp`, `IconMotion`, `ChartTooltip`, the six chart components, `chartPaths.ts`.
4. Dashboard: greeting header, hero (number + ridge), Today ring, Activity bars, On a roll
   heat grid, Models stack, Projects with sparklines. Matches `mockup/dashboard.html`.
5. Setup on Will's layout: header + actions (no chips), the setup checklist first, equal
   type tiles that open each type, item cards with X + inline confirm. Matches
   `mockup/setup.html`.
6. Sessions, History, Wrapped and Settings per "Screens" above.
7. Sidebar: sliding pill, fill-weight active icon, icon motions, streak pill in the footer.
8. Verify: screenshots light + dark at 1280x800 and at the 900x600 minimum, reduced motion
   on, keyboard through every chart; `npm test` green.
