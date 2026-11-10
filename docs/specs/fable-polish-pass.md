# Atlas polish pass: the brief for Fable

Paste everything below the line into a fresh Fable session opened in
`C:\Users\Will\Documents\Desktop Apps\Atlas`.

---

You are doing the final polish pass on **Atlas**, a Tauri 2 + React/TypeScript desktop app
that is a Christmas gift for Will's dad, a lifelong Apple fan and a heavy Claude Code
user. He will open it, look at it for two seconds, and either understand what he sees or
not. Your job is to make sure he always does.

## The one rule: enhance, do not redesign

Will likes how Atlas looks now. Keep the identity exactly: the Trail Map direction, the
terracotta accent, the Recursive display figures, the system body font, the layered
surfaces, the summit spark, the terrain charts, the topo lines, and the three themes
(Light, Dark, Silver). Do not change the palette, the type families, the navigation (Dashboard,
Now, Sessions, Toolkit with Your setup / Library / Team, History, Settings, Wrapped), or the
overall layout of any page.

What you *may* change: spacing, alignment, sizes inside the ramp, ordering, grouping,
truncation, wrapping, empty and loading states, icons, small graphics, chart labels and
legends, micro-motion, copy that is hard to read, and the layout *inside* a card or a
toolbar when it does not work at some window size. Each change must make the page easier
to read at a glance, or feel more crafted. Change nothing just to change it.

Anything bigger than that (moving a section to another page, a new view, a new chart
type, removing a feature, a new dependency) is a **suggestion**, not a fix: write it in
the report for Will and do not build it.

## Read first (in this order, do not skip)

1. `CLAUDE.md` (project rules, Design Identity, safety invariants, commands).
2. `docs/specs/fun-pass/DIRECTION.md` (the Trail Map direction; it wins over CLAUDE.md
   where they differ) and `docs/specs/wrapped-redesign/DIRECTIONS.md` (Wrapped = Summit).
3. `src/styles/tokens.css` (every colour, radius, shadow, easing and type size lives here;
   never hard-code a value that a token covers; add a token only when nothing fits) and
   `src/styles/tokens.test.ts` (contrast guards: text 4.5:1, graphics 3:1).
4. `MEMORY.md`: grep it for each page before you touch it (never read it whole); read the
   newest entry.
5. `src/lib/ipc.ts` + `src/lib/mock.ts`: the UI talks to Rust only through `ipc.ts`; in a
   plain browser the in-memory MockBackend feeds every page.

## How to see the app

- `npm run dev` serves the UI with the MockBackend (a plain browser shows every page with
  fixture data). Add `?update=0.2.0` to the URL to see the update offer in the sidebar.
- The real app: `npx tauri build --debug --no-bundle`, then
  `target/debug/atlas.exe --config-dir fixtures/claude-basic --data-dir <a scratch folder>`.
  Never point it at the real `~/.claude` (see Safety).
- Look at every page at **900 x 600** (the window's minimum), **1180 x 780** (the default)
  and **1600 x 1000**, with the sidebar both expanded and collapsed, in Light, Dark and
  Silver, and once with "Reduce motion" on. Use screenshots, not memory, for every claim.

## What to fix: the brief from Will, in his words, made concrete

### 1. Readable at a glance (the biggest one)

"Just being able to see what you need to at a first glance." For every page, ask: what is
the one thing someone opens this page to learn, and can they see it in two seconds
without reading a sentence? Then:

- Lead with the answer: the biggest figure or the most recent item first, details after.
- One visual hierarchy per card: one hero element, everything else visibly quieter
  (`text-ink-2`, caption size). No two things competing at the same weight.
- Numbers: compact and consistent everywhere (`1.9M`, `77k`, `9 min`), tabular digits,
  units always present, the same figure formatted the same way on every page.
- Labels: plain words a non-developer understands. No raw ids, file paths as the main
  label, model ids (`claude-sonnet-4-5-20250929`), or internal jargon on the surface; keep
  the exact value in a tooltip or the detail sheet.
- Anything you have to stare at for a few seconds to decode is a bug. Fix it with
  wording, grouping, an icon, or spacing, not with more text.

### 2. Long names

"In certain texts, the names go too long." Chat titles, project names, skill and plugin
names, file paths and helper names can be very long.

- Every name in a row or card gets one deliberate rule: single-line ellipsis with the full
  text in a `title` tooltip, or a two-line clamp where the name is the main content. Never
  let a name push a number, button or icon out of place or off the card.
- Paths: show the meaningful tail (`atlas/CLAUDE.md`), middle-truncate if needed, full
  path on hover and in the detail sheet.
- Check with the longest real-looking names you can make in the mock (60+ characters, no
  spaces, CJK text, emoji in a chat title).

### 3. Order: the thing you want is at the top

"Stacked super far down can be annoying." Lists must put what people want first, and
search must find it fast.

- Sessions: most recent first by default (keep the sort menu). The search box filters as
  you type and the best match is visible without scrolling.
- Library (plugins and skills): most popular first, then down from there. Only use a real
  popularity signal the data already has (marketplace order, install counts, GitHub stars
  if the backend already fetches them). **Never invent a number.** If no real signal
  exists, order by: installed and updatable first, then the official marketplace's own
  order, and write in the report what data source would give true popularity.
- History: newest first (already), with the filter chips and the project picker always
  visible.
- Setup, Team and any other list: decide the order a person would expect (most used,
  most recent, or alphabetical for lookup lists) and make it consistent.
- Long pages: if a page needs a lot of scrolling before the useful part, move the useful
  part up (inside the page's existing structure), collapse rarely used detail behind a
  "Show more" or a disclosure, or make the list scroll inside its card so the controls
  stay put. Toolbars and filters must never scroll away from the list they control.

### 4. Small windows

Will found filter chips hidden behind the project picker on History at a small window.
That one is fixed; find the rest.

- At 900 x 600 nothing may overlap, clip, or hide behind another control; nothing may
  scroll sideways. Toolbars wrap onto a second line, or put secondary controls into an
  overflow menu, instead of overlapping.
- Charts keep readable axis labels at every width (fewer ticks, not smaller text).
- Use container queries (`@container`, already used across the app) over viewport media
  queries, so a card behaves the same whether the sidebar is open or not.

### 5. Animations, graphics and icons

Enhance, within the motion rules in DIRECTION.md: hover 220 ms spring lift, press 90 ms
scale, one-shot Phosphor icon micro-motions, charts animate once per launch, three rationed
celebrations, calm zones stay calm (Settings, detail sheets, code viewer, History, Pending
Changes, errors, anything destructive), and "Reduce motion" swaps everything for fades.

- Look for state changes that currently snap (a list filtering, a card expanding, a value
  updating, a tab switching) and give them a short, purposeful transition.
- Icons: every icon from the same Phosphor family and weight, sized on the 16/20/24 grid,
  optically centred with its text. Replace any icon that does not say what the thing is.
- Empty, loading and error states: each says what happened and what to do next, with the
  topo-line backdrop where the identity calls for it. Skeletons match the real layout's
  shape so nothing jumps when data lands.
- No new chart library and no animation library: hand-written SVG and CSS/WAAPI, as now.

### 6. Formatting and suggestions

Clean up formatting everywhere (dates, durations, pluralisation, sentence case, punctuation,
consistent separators). Then, as you go, collect **suggestions** for Will: ideas that would
make Atlas clearer or more delightful but are bigger than a polish fix. For each give what
you saw, what you propose, and why it helps at a glance. Rank them. Do not build them.

## Never

- Never write the real `~/.claude`, `~/.claude.json` or `$CLAUDE_CONFIG_DIR`. Tests use
  fixture dirs; manual runs use `--config-dir fixtures/...` or Sandbox Mode.
- Never index, display or log `.credentials.json`, `sessions/*.key`, OAuth or Admin keys.
- Never change the Rust write path, backups, atomic writes, the MCP server, the updater,
  the installer, or the release workflow. This pass is UI only. If a UI fix truly needs a
  backend change (for example a popularity field), stop and put it in the report.
- No "Live" tag, pill, chip or badge anywhere. No emoji in the UI. No confetti or sound.
  UI string literals stay ASCII.
- No Anthropic or Claude logos or trademarks.
- Never Recursive for body text, buttons, nav, inputs, tables or code.
- Do not retune the accent or semantic colours; `tokens.test.ts` must stay green.
- No new npm or cargo dependency without asking Will.
- Never `--no-verify`; never commit `crates/setup/gen/schemas/*.json` or `verify-bin/`;
  never force-push.
- The source repo (`dozeyy/atlas-app`) is **public**. Nothing personal goes into a committed
  file: no real usage data, real chat titles, real project names or real paths from this PC.
  Screenshots stay on this PC: `docs/shots/` is in `.gitignore`, never force-add it. Use the
  fixtures and the MockBackend for anything that gets committed.

## How to work

1. **Audit first.** Go page by page (Dashboard, Now, Sessions + Session detail, Toolkit:
   Your setup, Library + its sheet, Team + Agent detail, History, Settings, Wrapped, the
   first-launch intro, the update offer, the command palette, dialogs and toasts). For
   each, take screenshots at the sizes and themes above and write a short findings list:
   what is hard to read, what is out of order, what clips or overlaps, what feels flat.
   Save the list as `docs/specs/fable-polish-findings.md`.
2. **Fix page by page**, smallest safe change first. Keep changes local to the page's
   components and its CSS; shared primitives (`controls.tsx`, `tokens.css`) only when the
   same problem appears on several pages, and then check every page that uses them.
3. **Prove each page.** Before/after screenshots at 900 x 600 and 1180 x 780 in Dark and
   Light, saved under `docs/shots/fable-pass/<page>/` (local only, gitignored). Then:
   - `npx tsc --noEmit`
   - `npx vitest run` (all green; update a test only when the behaviour it checks
     intentionally changed, never to make a failure go away)
   - `cargo clippy --workspace --exclude atlas-setup --all-targets -- -D warnings` only if
     you touched Rust (you should not need to)
4. **Commit per page** with a plain message ("History: filters wrap instead of hiding at
   small windows"), ending with your Co-Authored-By line. Do not push.
5. **Report** at the end, short and plain:
   - what changed, one line per page, with the screenshot folder;
   - anything you could not verify;
   - the ranked suggestions list for Will;
   - a dated entry appended to `MEMORY.md` with the outcomes and anything that failed.

Done means: every page passes the 900 x 600 check with nothing hidden or overlapping, every
list leads with what people want, no name breaks a layout, all checks are green, and the
screenshots prove it.
