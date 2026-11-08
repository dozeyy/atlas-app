# Atlas fun pass: "Trail Map"

**What it is:** the decided visual direction that takes Atlas from tidy-and-calm to warm and
playful, without losing the tool. One direction, no options (Will: "you decide").
**Status:** decided 2026-11-08. Builder applies it after `phase2-usage` and `setup-write` merge.
**Mockup:** `mockup/dashboard.html`, `mockup/setup.html` (open through any local server, e.g.
`python -m http.server` in `mockup/`; `?theme=dark`, `?still=1` skips first-paint motion,
`?pin=bar-24,tile-3,btn-new` forces hover states). Screenshots, 1280x800:
`dashboard-light.png`, `dashboard-light-hover.png`, `dashboard-dark-hover.png`,
`setup-light-hover.png`, `setup-dark.png`.

## The idea in one line

Your Claude use is a landscape you have walked: busy days are terrain, streaks are a dotted
trail, and the clay spark is the flag planted on every peak, record and finish line.

- **Kept:** palette, the spark logo, the launch intro, Phosphor icons, system body type,
  the topo-contour thread, every safety and performance rule.
- **Changed:** a bundled display face for numbers and titles, a real chart language
  (terrain, trail, flag), rounder shapes, springy hover/press, icon micro-motions, friendly
  copy, three rationed celebrations.
- **Removed:** the "Live" chip on Setup (banned in every app); replace with a quiet
  `Updated just now` caption.

## References (what to take, and why)

| Reference | Take this | Why it fits Atlas |
|---|---|---|
| GitHub contribution graph | The heat-grid grammar: weeks as columns, 5 quantile bands, today outlined, tooltip per cell | Everyone reads it instantly; we swap green for clay elevation bands |
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
| USGS topographic maps | Elevation bands, dotted trails, summit markers | The "atlas" thread made into the chart language |

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
--display-axes: "CASL" 1;           /* Recursive Casual; weight comes from font-weight */
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
- Why Recursive: OFL, variable, made by Arrow Type. Its Casual axis (`CASL 1`) reads like a
  cartographer's hand lettering, which is the atlas thread in type. Its digits are tabular by
  default (measured: every digit is the same 0.6 em advance), so count-ups never jitter.
  Not used by any sibling app (checked: Inter, Onest, Outfit, Space Grotesk, Instrument,
  Source Sans and Geist are taken elsewhere).
- Install: `npm i @fontsource-variable/recursive` and `import "@fontsource-variable/recursive/casl.css";`
  in `main.tsx` (wght 300-1000 + CASL axes; latin file is 108 KB; Vite bundles it, no CDN).
  In `main.tsx`, `await Promise.race([document.fonts.load('800 1em "Recursive Variable"'), sleep(150)])`
  before handing off from the launch splash, so the first frame never swaps fonts.

| Role | Face | Size / line | Weight | Extra | Use |
|---|---|---|---|---|---|
| hero | Recursive CASL 1 | 56 / 56 | 820 | -0.02 em | The one hero number per page |
| title | Recursive CASL 1 | 32 / 38 | 780 | -0.01 em | Page greeting / page title |
| stat | Recursive CASL 1 | 28 / 32 | 800 | -0.01 em | Card stats (streak days, totals) |
| tile | Recursive CASL 1 | 24 / 26 | 800 | | Setup tile counts |
| figure | Recursive CASL 1 | 20 / 24 | 760 | | Ring centers, section headings ("Skills") |
| small | Recursive CASL 1 | 15 / 20 | 740 | | Inline figures (412k, 62 %), "All set." |
| tooltip value | Recursive CASL 1 | 17 / 22 | 760 | | Tooltip line 2 |
| lead | system | 15 / 22 | 400 | | Page sub line |
| body | system | 14 / 20 | 400 / 500 / 600 | | Everything else |
| caption | system | 12 / 16 | 400 / 600 | | Labels, axis, legend |
| code | SF Mono / Cascadia | 12 | 400 | | Paths, code viewer (unchanged) |

Never Recursive for body copy, buttons, nav, inputs, tables or code. Display weights stay in
740-820; nothing else.

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
of seen chart ids); later visits render complete. `html.reduced` or OS reduced motion: no
draw, no grow, values appear with a 120 ms fade.

### Activity bars (30 days / 7 days)
- Bar width 62 % of the slot, min 4 px; top corners radius `min(6, w/2)`, flat bottom.
- Fill `--bar-rest`; today `--accent`; zero days a 3 px nub in `--heat-0` (the axis never
  looks broken).
- Y: no axis line; two dashed gridlines (`--line`, dash 2 4) at 50 % and 100 % of a nice max,
  labels right-aligned 11 px `ink-2` ("250k", "500k"). X: 4-5 ticks, last one "Today".
- Hover/focus: fill `--accent-text`, `translate: 0 -4px` with `--dur-hover` `--ease-spring`, a
  2 px ellipse shadow under the bar at 10 % ink, tooltip.
- Busiest bar in the range: the spark (18 px) floats 12 px above it; its tooltip line 1 adds
  "busiest day".
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
- Weeks as columns, Monday first (Sunday first when the OS locale says so); cell 15 px,
  gap 4, radius 4.
- Color: `--heat-0` for no activity, else `--heat-1..5` by quantile of active days in view
  (cuts at 20 / 45 / 70 / 90 %). Today: 1.5 px `--ink` outline.
- The streak trail: a polyline through the centers of the streak days, `--ink` at 70 %,
  3 px, `stroke-dasharray: 0 7` with round caps (it renders as dots, a hiking route).
  The spark (18 px) sits just right of today's cell.
- Header: "On a roll", the stat ("9 days in a row"); the pill "Longest yet" only when the
  current streak is the longest on record. Footer: "Last 12 weeks" and a Less-More legend.
- Hover/focus a cell: `scale: 1.35` with `--ease-spring`, tooltip (date, tokens, sessions).
- First paint: cells pop in by column (scale .4 -> 1, 300 ms spring, 18 ms per column), the
  trail fades in at 700 ms.
- No streak (today inactive and yesterday inactive): no trail, header becomes "Last 12
  weeks", no pill.

### Model share (stacked bar)
- 14 px tall, 3 px gaps, inner segment radius 4, outer ends pill. Colors `--chart-1..4` in
  order of share (Opus, Sonnet, Haiku, other); tiny segments keep a 6 px minimum width.
- Legend rows under it: 10 px rounded-square dot, name 600, tokens `ink-2`, percent in
  display `small`, right-aligned; row hover `raised`.
- Hover a segment or its legend row: that segment grows to 22 px (`--ease-spring`), the others
  drop to 35 % opacity, the legend row highlights. The same component draws Setup's
  "Where it all lives" (Global / Projects / Plugins / claude.ai).
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
| Setup type tile | icon blob 40 px radius 12 `accent-tint` / `accent-text`, count in display `tile` | clickable-card lift, blob fills `--accent` with `on-accent` icon, icon swaps to duotone + its motion | `scale(.985)` | ring |
| Project chip | 30 px pill, `raised`, count in display 780 `accent-text` | `accent-tint`, `translateY(-1px)`, icon nudge | `scale(.96)` | ring |

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
- The spark marks only meaning: the peak (ridge, bars), the streak head, completion, the
  sidebar streak pill, empty states, Wrapped. Max one spark per card. Never a bullet,
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
5. Setup: remove the Live chip, header + actions, Where it all lives (stack + project
   chips), Getting set up checklist, tiles with icon motions. Matches `mockup/setup.html`.
6. Sidebar: sliding pill, fill-weight active icon, icon motions, streak pill in the footer.
7. Verify: screenshots light + dark at 1280x800 and at the 900x600 minimum, reduced motion
   on, keyboard through every chart; `npm test` green.
