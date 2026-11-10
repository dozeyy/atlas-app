# Polish pass: Dashboard and Now

Area `dashboard-now`. Every finding comes from a picture or a measurement taken in this pass
(mock data only). Pictures are local, under `docs/shots/fable-pass/<stop>/` (gitignored); a
name like `dashboard/before-dark-900x600` is `<stop>/<label>-<theme>-<size>.png`.
Marks: FIX (polish, done in this pass), SUGGEST (for Will), LEAVE (why).

## The three things from the first look

| Claim | Verdict | Evidence |
|---|---|---|
| About 800 px of scrolling at 900x600 | Confirmed: the page scrolled 795 px, one column in the order hero, Activity, Models and Projects, Today, On a roll, Recent. Today sat about 560 px down. | `dashboard/before-dark-900x600` (+ `-bottom`), audit `page-scroll 795` |
| Axis labels readable at every width | Size is fine (11 px, fewer ticks when narrow), but the labels counted from the left, so the accent "today" bar had no label under it. | `dashboard/before-dark-900x600`, `dashboard/before-light-1180x780` |
| Model names plain | Confirmed fine: "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"; the raw id is only in the hover. An id Atlas cannot parse falls back to the raw id (stress run). | `dashboard/before-dark-1180x780`, `dashboard/before-stress-dark-1180x780-stress` |

## Dashboard

1. FIX. Small window order. Below the two-column width the page was one long column and Today
   was far down. Now: hero and Today share the first row, Activity and On a roll the second,
   Models and Projects the third, Recent sessions last (full width). Very narrow (sidebar open
   at 900): one column in the same reading order. `dashboard/before-dark-900x600`.
   Note: in the two-row layout the picture order differs from the Tab order, which stays
   hero, Activity, Models, Projects, Today, On a roll, Recent.
2. FIX. The default window (1180x780) scrolled by 10 px and cut the third Recent row. The
   Less/More legend of the streak grid moves into the grid's label row. `dashboard/before-dark-1180x780`,
   audit `page-scroll 10`.
3. FIX. Activity axis: labels are counted back from the newest bar, and the newest one reads
   "Today" (30 days) or "This week" (12 weeks). `dashboard/before-dark-900x600`.
4. FIX. Activity, Today view: the code gave the accent to the last slot (23:00), not the
   current hour. Read in the code, not seen: the mock has nothing in either hour, so the
   before and after pictures are the same. `dash-today/before-dark-1180x780`.
5. FIX. Models and Projects were listed in cost order while the numbers shown are tokens
   (Opus 28% above Sonnet 45%; projects 2.7M, 1.7M, 2.8M, 2M). Both lists now run biggest
   first by the number shown. `dashboard/before-dark-1180x780`.
6. FIX. Bar and ridge hovers split the number from its unit ("415k" then "tokens, $3.05
   estimated, ..."). Now "415k tokens" then "$3.05 estimated, 2 sessions started", the same
   as the streak grid. `dash-tip/before-dark-1180x780`.
7. FIX. Engine error: the banner and a second block said the same sentence with two "Try
   again" buttons. While the banner is up, the second block is not drawn. `dash-error/before-dark-1180x780`.
8. FIX. First read: the skeleton was one row of two cards in other proportions than the page
   it stands in for. It now uses the page's own grid. In one column only the first two
   cards are drawn, so the "Reading your history" line stays on the first screen.
   `dash-indexing/before-dark-1180x780`.
9. LEAVE. First read says "Reading your sessions ... This happens once." in the banner and
   "Reading your history. This runs once." under the skeleton. The second line is the one
   `DIRECTION.md` asks for; the banner is not this area's file. See SUGGEST 2.
10. LEAVE. Empty state, options menu, table view, tooltip placement at the first bar, the
    last bar and a streak cell: all read well. `dash-empty`, `dash-menu`, `dash-table`,
    `dash-tip-first`, `dash-heat-tip`.
11. LEAVE (not this area's file). Recent sessions in the 330 px column: the project name
    collapses to nothing on a row with a helper count, the model is cut to "Op..." and the
    cut title and project have no hover. Shared request for `SessionList.tsx`.
    `dashboard/before-dark-1180x780`, `dashboard/before-stress-dark-1180x780-stress`.
12. LEAVE. A model id Atlas cannot parse shows as the raw id, cut ("some-ven..."), with the
    whole id in the hover. Rare, and the hover covers it.

## Now

1. FIX. Helper rows lost their names at some window widths: with the list 781 to 808 px wide
   (window about 930 wide, or 1050 with the sidebar open) the name column fell to 96 px, the
   model line took all of it ("Verifier" had 8 px, "Explore" 0) and the row was 9 px wider
   than its card. Measured with `probe-ht` at 930x600 and 1050x700. The narrow layout now
   runs up to 900 px and the trail gives room back to the name up to 1000 px. Measured after:
   every name whole at 900, 930, 1050 and 1180 wide; at 900 with the sidebar open the longest
   name is still cut (83 of 91 px), with its hover.
2. FIX. A cut helper name had no hover. `now-run1/before-light-1180x780` ("Code revi...").
3. FIX. "No progress for 7 min" was cut to "No progress for 7..." at 900x600, the one status
   that matters most. `now-run1/before-dark-900x600`.
4. FIX. Chips in the Waiting and Finished rows were 24 px tall in a 22 px line, so every
   chip lost its bottom 2 px. Measured with `probe-rows` (chip 122 to 146, line 122 to 144).
   `now-waiting/before-light-900x600`. The line is 24 px now, and the status words beside
   the chips take the same height, so a chip that wrapped out of sight leaves no sliver.
5. FIX. A long folder name: its chip was sliced at the card edge with no ellipsis and no
   hover, and pushed the model chip out. `now-run1/before-stress-dark-1180x780-stress`.
   Also: the action word on a chat card ("Reading 3 files") could be cut with no hover in
   the five-card grid; it has one now.
6. LEAVE. Nothing running, No chats yet, No Claude folder found, five chats in a grid,
   waiting and finished lists: clear at both sizes. `now`, `now-quiet`, `now-nofolder`,
   `now-run5`, `now-waiting`.
7. LEAVE. With helpers out, the page scrolls (311 px at 900x600 with three chats and three
   helpers). The helper list is the content; hiding it would be worse.
8. FIX. The Waiting and Finished rows ended 4 px short of the cards above them (room kept
   for a scrollbar inside the column). The room now sits outside the column, so every right
   edge lines up. `now-run1/before-light-1180x780` against `now-run1/after-light-1180x780`.

## Redesigns (after Will widened the scope, 2026-11-09)

Each is its own commit. Pictures are in `docs/shots/fable-pass/` (local only).

1. BUILT. Dashboard, narrow window (sidebar open at 900 wide): Today and On a roll share a
   row under the hero instead of two full-width cards. Principle: density and proximity (a
   full-width card held one ring and two numbers; the two "how am I doing today" cards now
   read together). Scroll 769 to 653 px. Nothing changes at the other widths (399 px at 900
   with the sidebar closed, 0 at 1180x780, measured again).
   `dashboard/r1-before-*-900x600-expanded` against `dashboard/r1-after-*-900x600-expanded`.
2. BUILT. Now: a long file path keeps its file name. Principle: the last part of a path is
   the part that tells you what is happening; it was the part being cut.
   `now-run1/r2-before-*-stress` against `now-run1/r2-after-*-stress` (also `now-run3`).
   One test line changed (`Now.test.tsx`): the path is two spans now, so the test reads the
   whole line's text.
3. BUILT (a fix, not a redesign). Dashboard at 1600 wide: Recent sessions drew two columns
   inside the narrow right column and cut the titles; one column now.
   `dashboard/after-dark-1600x1000`.
4. LEFT. Recent sessions across the full width under everything, at every size. Tried on
   paper: at the default window it brings back about 250 px of scrolling where there is none
   now, and leaves a hole under On a roll.
5. LEFT. Getting Models and Projects onto the first screen at 900x600. They need 135 px more
   than the window has after the hero and Activity rows; the first screen already answers
   this week, today, the trend and the streak. Shrinking the chart to fit would cost the
   chart more than it gains.
6. LEFT. The crowded second line of a Recent sessions row in the narrow column: the row is
   the Sessions page's component and its order is Will's (2026-11-08). Shared request.

### Now, second round (2026-11-09)

What a person watching wants in two seconds: which chat, what it is doing now, how much, how
long. Every change below serves that order. Pictures use the `dn-` labels.

7. BUILT. Running cards line up down the list. The clock column was as wide as its own
   digits ("2:06" against "13:26"), so the doing block and the token figure started at a
   different x on every card. Fixed-width number columns. Principle: alignment (a column is
   only a column if it starts in one place). Measured: icon tile at 408 / 607 px on all
   three cards at 900 / 1180 wide (was 437, 430, 424 and 631, 631, 623).
   `now-run3/dn-r3-before-*` against `now-run3/dn-r3-after-*`.
8. BUILT. The small running card keeps its folder and model under the title. At the smallest
   window the card hid them, so the 88 px card held one line of text beside two-line blocks
   and three chats with similar titles could not be told apart. Same height, now three
   two-line blocks (title + folder and model, doing + target, tokens + caption) and the
   clock. Principle: density and hierarchy; the height earns its place, and a shorter card
   (72 or 80 px) cannot hold the title and the chips. The card stays taller than a helper
   row on purpose: a chat is the parent, a helper is its child.
   `now-run3/dn-r3-after-*-900x600` against `now-run3/dn-r4-after-*-900x600`.
9. BUILT. A helper's kind is never cut. At 900 wide a row read "General p..." beside a whole
   "Sonnet 5.5 - medium". The kind is what a row is read by (Will: easy to know which agent
   is which), so the name stays whole and the model label shortens from its end; the full
   label is on hover. A shrink of a fraction of a pixel was already costing two letters, so
   the name is capped, not shrunk. `now-run12/dn-many-before-*` against
   `now-run12/dn-many-after-*` (12 helpers; `-stress` for long goals).
10. BUILT. Helper rows read tokens, then the clock, like the chat cards above them and the
    lists below. They had the two the other way round. Principle: consistency; the clock
    owns the right edge at every width. `now-run3/dn-order-before-*` against
    `now-run3/dn-order-after-*`.
11. BUILT (polish). "No chats yet" and "No Claude folder found" each say what to do next in
    one plain line. "Nothing running" already had "Last chat ended ..."; "Waiting for you" is
    a list and needs none. `now/dn-empty-before-*` against `now/dn-empty-after-*`, same for
    `now-nofolder`.
12. BUILT (polish). The doing word ("Editing", "Running") kept losing the tails of g and y
    to its tight line box.
13. CHECKED, left as it is. Twelve helpers under one chat: each row is one line of name, one
    line of goal (cut with the full text on hover), then fixed columns. It reads as a table,
    not a wall of text; the avatar has its own 32 px first column in every row.
14. LEFT. Nested helpers (a helper started by a helper) cannot be drawn: the Now data has no
    parent for a helper. Needs the engine.
15. LEFT. A very long folder name takes the whole chips row of a small card, so the model
    chip drops out (never shaved). Only with 60-letter folder names.
16. BUILT (polish, from the shell audit). Dashboard first read: the line under the skeleton
    ("Reading your history. This runs once.") said what the banner above it already says
    ("Reading your sessions ... This happens once."). The line is gone; the banner says it
    once. `dash-indexing/dn-idx-before-*` against `dash-indexing/dn-idx-after-*`.
17. SHARED REQUEST (not mine to edit). Three cut texts in a Recent sessions row have no
    hover: the title and the project name. Both are in `SessionList.tsx` (`SessionLine`),
    the Sessions page's component. Exact change in the report.

## Suggestions for Will

1. Recent sessions on the Dashboard: in the narrow right column the second line of each row
   is too crowded to read. Show less there (project and time only), or give the list the
   full width under the cards at every size.
2. One wording for the first read: the banner and the skeleton line say the same thing in
   two ways. Keep the skeleton line, drop "This happens once." from the banner.
3. Built: see Redesigns 2.
4. The engine lists top projects and models by cost while the page shows tokens. The page
   now sorts what it gets, but the top four by cost are not always the top four by tokens.
