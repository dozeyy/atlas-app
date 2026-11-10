# Polish pass: Toolkit > Library and Toolkit > Team

Area `library-team`. Law: `docs/specs/fable-polish-pass.md`. Pictures are local only
(`docs/shots/` is gitignored); paths below are relative to `docs/shots/fable-pass/`.
Mock data only. "Stress" = the run with 60-80 character names without spaces, long
repository and marketplace names, long descriptions, CJK, and 5-digit counts.

Marks: **FIX** (done in this pass), **SUGGEST** (for Will, not built), **LEAVE** (with why).

## Stops

`library`, `library-sheet` and `team` each land where the name says. Added:
`library-loading`, `library-sheet-file`, `library-flagged` (the 2-click path), `library-search`,
`library-nomatch`, `library-github`, `library-github-flagged`, `library-github-market`,
`library-github-error`, `library-installed`, `library-installed-confirm`,
`library-installed-filter`, `team-review`, `team-review-open`, `team-agent`,
`team-agent-bottom`, `team-review-loading`, `team-rule`, `team-nomatch`, `team-error`,
`team-empty`.

## Library

### Order (the strict rule)

- **L1 FIX. The list was A to Z.** `library/before-dark-900x600.png`: agent-sdk-dev first.
  The page has no popularity number (no installs, no stars: `CatalogEntry` is id, name,
  description, marketplace, version). It does carry one real signal: the order the
  marketplace itself lists its plugins in, which Atlas already saves and sends
  (`library_catalog_all`), and which the page threw away by sorting by name. In the captured
  catalog (`fixtures/library/catalog-available.json.gz`, 3,602 directory plugins) that order
  is ranked, not alphabetical: superpowers, frontend-design, design, small-business,
  marketing, engineering, vercel, data, feature-dev ... Now, with nothing typed, the list is
  the catalog's own order, the Claude plugin directory before marketplaces the user added.
  Typed words still rank by match, as before. Nothing is invented.
- **L1a LEAVE. Installed plugins are not floated to the top of All.** A row that jumps to
  the top the moment you install it disappears from under the pointer, and the list resets
  its scroll. "Installed" is one click away in the rail with its count.
- **L1b FIX. Installed list:** rows that need a second look ("Changed since you checked it")
  come first, then A to Z.
- **L1c LEAVE, reported. "Updatable" does not exist in the data.** `InstalledRow` has
  `changed` (the files differ from what was checked) but no "a newer version exists" field,
  so there is no updatable state to draw or to sort by. Backend work.
- **L1d reported (backend). First page.** The real backend answers first with 60 rows sorted
  by name, then the whole catalog. With the new order those 60 rows are replaced a moment
  later (once per app start). The cure is one line in Rust (`view()` in
  `crates/app/src/library.rs`: take the first page in catalog order, directory first, instead
  of sorting by name). Not done here: UI only. The mock sends everything at once, so the
  pictures do not show it.
- **True popularity, for later:** Claude Code's own
  `<config>/plugins/plugin-catalog-cache.json` has `unique_installs` per plugin. Atlas does
  not read it today; sorting by it needs a new backend field.

### List and rows

- **L2 FIX (bug). The uninstall question ran over the row.**
  `library-installed-filter/before-dark-1180x780-stress.png`: "Uninstall
  the-plugin-with-an-exceptionally-long-name...?" is drawn on top of the name and the
  description. The words had no width limit. Now the question is one line, cut with a
  tooltip, and the row always keeps the room it needs.
- **L3 FIX. Cut text had no tooltip** (audit `CUT-NO-TIP`, same picture and
  `library/before-dark-1180x780-stress.png`): row name, description, source, version, and the
  rail's marketplace name. One rule now: one line, ellipsis, the full text on hover.
- **L4 FIX. Widths were read from the window, not the list.** The source column, the
  uninstall question and the rail switched on window width (`min-[760px]`, `min-[900px]`,
  `matchMedia 1100`), so opening the sidebar squeezed the rows without the layout noticing.
  The list is now its own container and the rows ask it. The rail's 1100 px switch stays on
  the window (LEAVE: it only decides rail or dropdown, and both are complete).
- **L5 FIX. A changed row at 900 px** (`library-installed-filter/before-dark-900x600-stress.png`)
  kept the source column while the name had 170 px. The column now gives way first on rows
  that carry the "Changed" chip and "Check again".
- **L6 FIX. Copied items said their repository twice** (same picture, third row: "Skill
  copied from an-organisation..." and the same name again at the right). The right column is
  empty for those rows now.
- **L7 FIX. Loading drew one grey block**, not the list. It is row-shaped now (tile, two
  lines, button), so nothing shifts when the rows land (`library-loading/after-dark-900x600.png`).
- **L8 FIX. "Nothing matches" told you to "pick All on the left"**
  (`library-nomatch/before-dark-900x600.png`): at this width there is no left rail, and All
  is already picked. The line now fits what is on screen: "Try fewer words." with All picked,
  and the way to All only when another source is picked. A marketplace with no plugins says
  so instead of "Try fewer words".
- **L9 LEAVE. Rows overlap their Install button** (audit `OVERLAP`): by design, the row is
  the click target and the button sits on it. Checked with 80-character names without
  spaces and CJK: name and description stop before the button in every state
  (`library/after-*-stress.png`, `library-installed-filter/after-*-stress.png`). The audit's
  `COVERED` lines for the "Changed" chip and the uninstall question are the same thing: they
  sit on the row, in the room the row keeps for them.
- **L10 LEAVE. Installed rows keep their source column a little left of the others**
  (`library-installed/before-dark-900x600.png`): the room goes to the chip, switch and X.
- **L11 BUILT as redesign R1. Without Claude Code's command every row repeated the same
  amber sentence** (`library/before-nocli-dark-900x600.png`) and lost its description; the
  note above the list already said it. See Redesigns.

### The install sheet (calm zone: layout and words only)

- **L12 FIX. Cut item names and the evidence file path had no tooltip**
  (`library-flagged/before-dark-900x600-stress.png`).
- **L13 LEAVE.** Safety check, its order, the 1-click / 2-click rule and focus: untouched.
  Long flag sentences wrap, long evidence lines break, the footer never moves.

### Add from GitHub

- **L14 FIX (bug). Long names pushed the dialog sideways**
  (`library-github/before-dark-900x600-stress.png`, audit `HSCROLL +181`): the name, the
  repository chip, item names, "You already have one called ..." and the hook path all ran
  past the edge, and the link field with them. Root cause: one-column grids whose column
  grew to its longest word. The columns may shrink now; names are one line with a tooltip,
  the sentence and the path wrap, and nothing scrolls sideways
  (`library-github/after-dark-900x600-stress.png`). The same one-line fix is on the sheet's
  own lists.
- **L15 FIX (bug). Marketplace plugins ran past the edge**
  (`library-github-market/before-dark-900x600-stress.png`, `HSCROLL +131`). Same rule.
- **L16 LEAVE.** The offline sentence ("press Refresh") inside this dialog is the mock's
  own message; the real one comes from the backend.

## Team

- **T1 FIX (bug). A long theme name ran under "Make this a rule"** and the pane scrolled
  sideways (`team-review-open/before-dark-900x600-stress.png`, audit `HSCROLL +50/+60`). It
  wraps inside its own column now.
- **T2 FIX (bug). The rule sheet's subtitle was cut by the sheet edge**
  (`team-rule/before-dark-900x600-stress.png`). It wraps.
- **T3 FIX. "Found in work by" wrapped to two lines** in the detail block
  (`team-review-open/before-dark-900x600.png`). The label column is wide enough now.
- **T4 FIX. The search hint was cut**: "Find a helper, press / to jun"
  (`team/before-light-1180x780.png`). It says "Find a helper"; "/" still jumps there, as on
  the other lists, which do not print it either.
- **T5 FIX. One thing, two names.** The filter said "Started from: interactive" while the
  sheet says "from a chat". The filter says "a chat" too.
- **T6 FIX. Numbers.** "12,345 runs" next to "1234 headless"
  (`team/before-dark-900x600-stress.png`); the sheet's meters printed raw counts in a 40 px
  column. All counts use the app's one number format now and the column fits five digits.
- **T7 FIX. No match was a bare grey line** (`team-nomatch/before-dark-900x600.png`) while
  the Library shows a full empty state for the same thing. Same pattern and words now.
- **T8 FIX. Cut text without a tooltip**: the card's model, the sheet's project and model
  names, a run row's project (audit `CUT-NO-TIP`, `team-agent`).
- **T9 FIX. Loading for "Caught in review" was one block**; it is row-shaped now
  (`team-review-loading/after-dark-900x600.png`).
- **T14 FIX (bug). The Team pane scrolled 3 px sideways** at every size, with plain data
  (audit `HSCROLL +3` on `team`). Cause: a card's invisible hit ring (3 px, there so presses
  at a card's edge still count) reached past the pane's right edge, and a pane that scrolls
  down also scrolls sideways when anything pokes out. The pane no longer scrolls sideways.
- **T10 LEAVE. Toolbar at 900 px** wraps the search to its own line
  (`team/before-dark-900x600.png`): it stays above the cards and never scrolls away.
- **T11 LEAVE. Cards sit 10 px short of the toolbar's right edge when the pane scrolls**:
  that is the scrollbar's own lane.
- **T12 LEAVE, reported. "Ui builder" vs "UI builder"**: the mock capitalises by hand; the
  real backend and the page both write "Ui builder" (`humanize_type`). Backend if wanted.
- **T13 SUGGEST. Words:** "headless", "reviewer" and the row label "Work" are short but not
  plain. See Suggestions.

## Checked and fine

Light, Dark and Silver; 900x600, 1180x780, 1600x1000; sidebar open and closed; reduced
motion. Sheets and the safety check stay calm (no spring, no count-up). No "Live" tag, no
emoji, ASCII strings, one icon family.

## Suggestions for Will (ranked)

1. **Real popularity.** Read `unique_installs` from Claude Code's own plugin cache in the
   backend and sort by it; show "12k installs" on the row. Until then the list is in the
   marketplace's own order.
2. **Send the first page in catalog order** (one line in Rust) so the first 60 rows do not
   get replaced on the first open.
3. **"Update available."** The data has no such state; with a version check the Installed
   rail could carry a small dot and the row an "Update" button.
4. **Plain words on Team:** built in round two (R6). Left for the backend: "Ui builder"
   -> "UI builder" (a short list of known acronyms).
5. **A clear X in Team's "Find a helper" box**, like the Library's search box has (the
   shared `SearchField` belongs to another page's owner).

## Redesigns (after Will widened the scope, 2026-11-09)

Each is its own commit. Pictures are in `docs/shots/fable-pass/<stop>/`, before and after
framed the same, Dark and Light, 900x600 and 1180x780.

- **R1 (`2c2270f`). No Claude Code command: said once, rows keep their descriptions.**
  Before, all 19 rows swapped their description for the same amber sentence, so the list
  said one thing 19 times and nothing about any plugin. Now one warning-tint notice with
  its icon sits above the list, each row says what the plugin is, and the greyed Install
  button gives the reason on hover. Principle: hierarchy and scanning order (one message,
  once; the row's job is to describe the row). Install stays disabled exactly as before.
  `library/rbefore-nocli-*.png` -> `library/r1-after-nocli-*.png`.
- **R2 (`994df54`). A search that finds nothing offers "Clear search" in the empty state**,
  on Library and on Team (Team's box has no clear X at all). Principle: affordance and
  feedback (the next step is offered at the dead end, not back up in the toolbar).
  `library-nomatch/rbefore-*.png` -> `library-nomatch/r2-after-*.png`,
  `team-nomatch/rbefore-*.png` -> `team-nomatch/r2-after-*.png`.
- **R3 (`d16b9b9`). The Installed source says "1 changed"** in the warning colour when an
  installed plugin changed since it was checked (the whole sentence on hover; the narrow
  window's source list reads "Installed (4, 1 changed)"). Before, only the row itself
  said so, and in All that row can be far down. Principle: visibility of state. Words,
  not a bare dot, so it reads without colour; contrast on the selected, resting and
  hovered rail row is 5.1 to 8.5 in the three themes (computed).
  `library/rbefore-*-stress.png` -> `library/r3-after-*-stress.png` (the rail shows at
  1180x780; at 900x600 it is the dropdown).

## Redesigns, round two (2026-11-09)

Round one left five things as they were (the Package tile, the source caption, the
scorecards, the install sheet, the row layout). Side by side the pages looked the same
before and after, so all five were taken up again as design problems. Each is its own
commit. "After" pictures are `r4-*` in every stop; Library "before" is `after-*` /
`final-*` / `r3-after-*-stress`, Team "before" is `b2-*`.

- **R4 (`cda15c3`). Library list: what you have first, tiles that show state, the source
  only where it says something.**
  - Before, 16 of 19 rows ended in the same "Claude plugin directory" and "1.0.0". The
    source is now a section heading ("Installed", then each marketplace, the directory
    first) under All with nothing typed, and is back on the row only where plugins from
    several places mix (a search under All, the Installed source). The version moved to
    the sheet and the name's tooltip.
  - The freed width goes to the description. **Rows do not say what is inside**: the
    list data (`CatalogEntry`) has no contents, only the sheet does after it inspects the
    plugin, and nothing is invented. See Shared requests.
  - The tile says a true thing: a green check when installed, a grey check when installed
    but switched off, an amber warning when it changed since it was checked, and a quiet
    grey package when it is not installed (so the names lead). An installed row is
    recognisable from the tile, not only from the button.
  - Installing lifts the row under "Installed"; the selection follows it.
  - Headings carry no counts (the rail already has them).
  - Principle: scanning order and proximity (group by the fact, say it once), and
    visibility of state.
  - `library/after-*.png` -> `library/r4-*.png`, stress `library/r3-after-*-stress.png`
    -> `library/r4-*-stress.png`, `library-search/`, `library-installed/` likewise.
- **R5 (`7f733fb`). Install sheet: what it is, what is inside, is it safe, Install.**
  The verdict is a tinted band with a 22 px icon and the sentence in the lead size, the
  strongest thing after the name, and it sits directly above the Install button. The
  commit id is a quiet aside ("Version 1.0.0, commit a1b2c3d", the whole id on hover).
  Items inside carry their kind icon and a caret. Findings clamp to two lines until
  opened. No motion added (calm zone). The check itself and the 1-click / 2-click rule
  are untouched. Principle: hierarchy and reading order.
  `library-sheet/final-*.png` -> `library-sheet/r4-*.png`, `library-flagged/` likewise.
- **R6 (`528a958`). Team scorecards: one figure, one result, two quiet lines.**
  - The card leads with the helper's avatar (the same one as on Now and Sessions, from
    `helperKit`) and its run count as a Recursive figure, beside twelve labelled weekly
    bars ("Per week, last 12 weeks", exact counts on hover, the latest week in clay).
  - Then the one result: "Its work in review" (or "Verdicts it gave" for a reviewer),
    with the meter only when there is a rate.
  - "Too few runs for a typical time yet" is said once for the card, not on three rows.
  - Plain words: "headless" is "outside a chat" (the Claude Code word is in the hover),
    reviewers read "Reviews other helpers' work", the "Work" and "Ended" row labels are
    gone ("Usually 9 min and 38 tool calls", "86% finished").
  - The agent sheet carries the avatar in its header. Its run rows do not: every row is
    the helper already pictured above them.
  - Principle: hierarchy (one lead figure) and consistency (one avatar per helper kind).
  - `team/b2-*.png` -> `team/r4-*.png`, `team-agent/` likewise.
- **R7 (`f9a01bc`). Caught in review: helpers as avatars, every line short.** A theme
  shows who it was found in as avatars on the closed row and as avatar + name + count
  when open; long theme names, projects and examples clamp to two lines with the whole
  text on hover; the rule sheet clamps its subtitle and truncates paths with a hover.
  Principle: scanning order (who, at a glance) and density.
  `team-review-open/b2-*.png` -> `team-review-open/r4-*.png`, `team-rule/` likewise.

Still left, with the reason:

- **The Install button on the right of the row:** the conventional place, aligned in one
  column.
- **The toast over a list row at 900x600:** the shell's.

Clips (1180x780, Dark), in `docs/shots/fable-pass/for-will/`: `library-install-dark.mp4`
(search, a clean plugin's sheet, Install, Undo, then a flagged one and its second click)
and `team-walk-dark.mp4` (scorecards, one helper's sheet, Caught in review, Make this a
rule).

## Shared requests

- **Backend: what is inside, per catalog entry** (counts by kind), so a list row can lead
  with "3 skills, 1 command". Today only the sheet knows.
- **helperKit: General purpose and UI builder get the same avatar.** The mapping belongs
  to the Sessions pages; Team only imports it.
- **Backend: "Ui builder"** (`humanize_type`) should read "UI builder".
- **Shared `SearchField`: a clear X**, so Team's "Find a helper" box matches the
  Library's.
