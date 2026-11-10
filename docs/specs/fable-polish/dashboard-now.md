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

## Suggestions for Will

1. Recent sessions on the Dashboard: in the narrow right column the second line of each row
   is too crowded to read. Show less there (project and time only), or give the list the
   full width under the cards at every size.
2. One wording for the first read: the banner and the skeleton line say the same thing in
   two ways. Keep the skeleton line, drop "This happens once." from the banner.
3. Now: a long file path under "Editing" is cut at its end, which hides the file name.
   Cutting the start instead ("...widgets/ActivityHeatmap.tsx") would say more.
4. The engine lists top projects and models by cost while the page shows tokens. The page
   now sorts what it gets, but the top four by cost are not always the top four by tokens.
