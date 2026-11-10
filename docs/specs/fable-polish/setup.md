# Fable polish pass: Toolkit > Your setup

Area `setup`. Pictures are in `docs/shots/fable-pass/<stop>/` (gitignored, local only), named
`before-<theme>-<WxH>[-stress].png` and `after-...`. Stops used: `toolkit`, `toolkit-skills`,
`toolkit-item`, `toolkit-mcpServer`, `toolkit-hook`, `toolkit-instructions`, `toolkit-permission`,
`toolkit-agent`, `toolkit-more`, `toolkit-plugin`, `toolkit-autoMemory`, `toolkit-nomatch`,
`toolkit-search`, `toolkit-filters`, `toolkit-delete`, `toolkit-mcp-item`, `toolkit-locked-item`,
`toolkit-item-bottom`, `toolkit-edit`, `toolkit-dup`, `toolkit-create`, `toolkit-create-edit`,
`toolkit-create-hook`, `toolkit-empty`, `toolkit-checklist`, `toolkit-nousage`, `toolkit-loading`,
`toolkit-error`. The three stops that existed (`toolkit`, `toolkit-skills`, `toolkit-item`) land
where their names say.

Marks: FIX (polish, done in this pass), SUGGEST (for Will), LEAVE (why).

## Order inside a type (the decision)

Chosen: **by place, then by name**, the same in every type. Places run yours first, shared
after: Global, claude.ai, plugins, then each project by name. Inside a place, names are A to Z
(case ignored, numbers in number order). Permissions keep their three buckets (Blocked, Asks
first, Allowed) and are A to Z inside each.

Why not most used or most recent: these are lookup lists. A person comes here to find one thing
by name, so its position must not move after it is used or edited. "Most used" already has its
own panel on the first page, and "changed" is the time on each card. The code already sorted
this way (`compareItems` in `src/lib/setup-model.ts`); nothing had to change, and the tests in
`setup-model.test.ts` cover it.

## First page (panels, tiles)

1. FIX. The type tiles are the way in to everything, and they sit under two full-width panels:
   at 900x600 no tile is on screen (page scrolls 399 px), at 1180x780 two rows of four (scrolls
   150 px). `toolkit/before-dark-900x600.png`, `toolkit/before-light-1180x780.png`. The panels
   only went side by side at a 1240 px window. Now they go side by side whenever the page column
   is 720 px or wider (a container query, so the sidebar state counts), and the usage panel
   stacks its two halves when it is the narrow one.
2. FIX. "last 30 days" starts lower-case next to a sentence-case title; the ring says "1 of 8"
   without saying of what. `toolkit/before-light-1180x780.png`.
3. FIX. "Projects no longer on disk" is in the display face at 20 px, louder than the panel
   titles above it, for the least important thing on the page. `toolkit/before-dark-1180x780-bottom.png`.
4. FIX. A missing project's path is cut at the right end, which is the part that says which
   folder it was. `toolkit/before-dark-1180x780-stress-bottom.png`.
5. FIX. The loading skeleton does not match the page: tiles 84 px (real 72 px) and a block of
   four cards the first page never has, so the page jumps when it lands. `toolkit-loading/before-dark-900x600.png`.
6. LEAVE. Checklist first, then the panels, then the tiles: Will's decided layout.
   `toolkit-checklist/before-dark-1180x780.png`.
7. LEAVE. Dust squares are in file order, not A to Z: they are anonymous until hovered, an
   order would not be seen.
8. LEAVE. "Nothing has been used yet." when usage is empty reads fine. `toolkit-nousage/before-dark-1180x780.png`.

## An open type (toolbar, groups, cards, rows)

9. FIX. The search box says "Search mcp servers" and, on the More tile, "Search more".
   `toolkit-mcpServer/before-dark-900x600.png`, `toolkit-more/before-dark-1180x780.png`.
10. FIX. Long names and descriptions are cut with no way to read them: card name, card
    description, row name (audit CUT-NO-TIP, 15 lines). `toolkit-skills/before-dark-900x600-stress.png`,
    `toolkit-permission/before-dark-900x600-stress.png`.
11. FIX. Hook script rows say the same thing twice: "Used by 1 hook  Used by 1", "Not referenced
    Not used". `toolkit-more/before-dark-1180x780.png`.
12. FIX. Two count styles on the same kind of small heading: "Global 1" for places, "Blocked (1)"
    for permission buckets. `toolkit-permission/before-dark-1180x780.png`.
13. FIX. At 900x600 the first card starts at 284 px of 600: tab row, Back row, search, count,
    then the list. Two gaps are larger than the grid needs. `toolkit-skills/before-dark-900x600.png`.
14. FIX. The empty state of a type is a dashed box with one grey sentence, unlike every other
    empty state in the app, and the action is a button far away in the corner.
    `toolkit-empty/before-dark-900x600.png`.
15. FIX. The time on a card ("8 h ago") does not say what happened then.
    `toolkit-agent/before-light-1180x780.png`.
16. LEAVE. A single card leaves half a row empty (hooks, plugins): the grid is right for two or
    more, and a full-width card would change shape as soon as a second one exists.
17. LEAVE. The X delete appears on hover or focus only, with a confirm: decided layout.
    `toolkit-delete/before-dark-900x600.png`.
18. LEAVE. CJK names and descriptions cut and wrap cleanly. `toolkit-skills/before-dark-900x600-stress.png`.

## Detail sheet, editor

19. FIX. The kind chip is lower-case ("skill", "backup copy", "agent worktree") beside
    "Global" and "On". `toolkit-item/before-dark-900x600.png`.
20. FIX. Paths break in the middle of a word ("website-redes / ign"). `toolkit-item/before-dark-900x600-stress.png`,
    `toolkit-delete/before-dark-900x600-stress.png`.
21. FIX. In an MCP server's per-project list a long project name is cut with no hover.
    `toolkit-mcp-item/before-dark-900x600-stress.png` (audit CUT-NO-TIP).
22. FIX. Editor at 900x600 with a long name and a two-line check message: Cancel and Save are
    pushed under the bottom edge. `toolkit-edit/before-dark-900x600-stress.png`.
23. LEAVE. Calm zone checked: the sheet, viewer, editor, create, duplicate and delete have no
    icon motion, no springs, no count-up; only the plain press feedback every control has.
24. LEAVE. The raw text box runs to the bottom of the sheet with empty lines for a short file:
    it reads as a page, and a short box would leave a blank sheet under it. `toolkit-item-bottom/before-dark-1180x780.png`.
25. Not mine (shared request). The sheet and every dialog start at the very top of the window, over
    the title bar: the window's Minimize / Maximize / Close are covered and the sheet's own X
    sits where the window's Close was. Same in the Library and Team sheets and the shared Dialog.
    `toolkit-item/before-dark-900x600.png` (audit OVERLAP caption-close <> Close).

## Create, duplicate, delete

26. LEAVE. Create (ask, then the starting text), duplicate and delete read clearly at both sizes
    and wrap a 72-character name. `toolkit-create/before-light-900x600.png`,
    `toolkit-create-edit/before-dark-900x600.png`, `toolkit-create-hook/before-dark-900x600.png`,
    `toolkit-dup/before-dark-900x600.png`, `toolkit-delete/before-dark-900x600-stress.png`.

## States

27. LEAVE. Error, no matches, read-only (locked) item: plain words, one action, nothing cut.
    `toolkit-error/before-dark-900x600.png`, `toolkit-nomatch/before-dark-900x600.png`,
    `toolkit-locked-item/before-light-900x600.png`.

## What changed (every FIX above is done)

| Item | Change | Where |
|---|---|---|
| 1 | Usage and cost panels side by side from a 720 px page column (22rem cost column, 24rem from 960 px); the usage panel's two halves go side by side only when it is 560 px wide inside | `TopSlot.tsx`, `UsagePanel.tsx` |
| 2 | "Last 30 days"; the ring reads "1 of 8 used" | `UsagePanel.tsx` |
| 3 | Heading in the same face and size as the panel titles | `Setup.tsx` |
| 4 | The path wraps after slashes, nothing is cut | `Setup.tsx`, `parts.tsx` (`PathText`) |
| 5 | Skeleton tiles are the real grid (72 px rows, 44 px icon); the card block is gone | `states.tsx` |
| 9 | "Search MCP servers", "Search everything else" | `setup-model.ts` (`searchPlaceholder`), `CollectionView.tsx` |
| 10 | Full name and description on hover for cards and rows | `ItemViews.tsx` |
| 11 | One phrase: "Used by 1 hook" / "Not used by any hook" | `ItemViews.tsx` |
| 12 | "Blocked 1", same as "Global 1" | `GroupSection.tsx` |
| 13 | Back row gap 20 to 8 px, toolbar gap 24 to 16 px: the first card starts 20 px higher | `CollectionView.tsx`, `Toolbar.tsx` |
| 14 | The app's empty state (contours, the type's icon, "No rules yet", what the type is, a New button) | `CollectionView.tsx` |
| 15 | Hover on the time: "Last changed Nov 9, 2026, 8:58 PM" | `ItemViews.tsx` |
| 19 | "Skill", "Backup copy", "Agent worktree" | `DetailSheet.tsx`, `parts.tsx` (`sentenceCase`) |
| 20 | Paths break after a slash (sheet File / Linked to / files list, delete confirm, create "Goes in") | `DetailSheet.tsx`, `ConfirmDelete.tsx`, `CreateFlow.tsx` |
| 21 | Hover on the project name | `DetailSheet.tsx` |
| 22 | The editor box can shrink to 200 px (was 260) before the buttons leave the window | `TextEditor.tsx` |

Test changed on purpose: `src/pages/Setup.test.tsx` looks for the two new search placeholders
(item 9). No other test changed.

## Proof

- `after` pictures for every stop at 900x600 and 1180x780, Dark and Light, and the stress set
  (72-character names, CJK, a deep project path, long descriptions) at both sizes.
- Layout audit with no pictures at 1600x1000 (Dark, Light), Silver at both sizes, sidebar
  collapsed and expanded at both sizes, reduced motion at 1180x780, and 900x600 with the sidebar
  open plus the stress data: no horizontal scroll, nothing cut without a hover, nothing clipped
  or off screen. The only lines left are a sheet or dialog lying over the page behind it, and
  item 25.
- First page scroll: 399 to 216 px at 900x600, 150 to 0 px at 1180x780. With the sidebar forced
  open at 900x600 the column is under 720 px, so the panels stack as before (399 px).
- `npx tsc --noEmit` clean; `npx vitest run` 64 files, 884 tests passed.

## Redesigns (after the scope was widened; each is its own commit)

Before pictures are the polish `after-...` pictures of the same stop; after pictures are named
`r1-after-...`, `r2-after-...`, `r3-after-...`.

- R1. **The checklist can be put away.** It had no way out: one step a person never wants (an
  output style, say) kept a 280 px card at the top for good, and with it open the page scrolled
  261 px at 1180x780 with no full tile row on screen. Principle: user control, and keeping the
  way in (the tiles) on screen. A caret in the card's corner folds it to one line (title, the
  bar, "4 of 7"), remembered on this device; the open card is unchanged apart from the caret,
  so the decided layout (checklist first) stands. Folded: 36 px of scroll at 1180x780 (the mock
  has a missing-projects row at the bottom), all twelve tiles on screen.
  Before `toolkit-checklist/after-*.png`; after `toolkit-checklist/r1-after-*.png` (open) and
  `toolkit-checklist-folded/r1-after-*.png` (put away). Files: `Checklist.tsx`, a test in
  `Setup.test.tsx`.
- R2. **Hook cards say when the hook runs.** The card's chips were the event and the type
  ("PreToolUse", "command"), both already in its title and first line. Principle: no repeated
  fact, plain words over jargon. One chip now, in the words the create flow already uses
  ("Before a tool runs"); an event Atlas has no words for shows no chip.
  Before `toolkit-hook/after-*.png`; after `toolkit-hook/r2-after-*.png`. File: `ItemViews.tsx`.
- R3. **An empty type steps back.** "0 Hooks" was as loud as "6 Skills". Principle: hierarchy,
  the figure that means "nothing here" should not compete. Same tile and size, the 0 in the
  secondary ink. Before `toolkit-checklist-folded/r1-after-*.png`; after
  `toolkit-checklist-folded/r3-after-*.png`. File: `TypeTiles.tsx`.

Looked at again and left:

- A title on an open type ("Skills"): "no page headers" is a standing review rule of Will's;
  the search box, the New button and the Back button name the type.
- Tiles above the two panels: at the default window both fit with no scroll either way, and
  after the polish six tiles show at 900x600; moving them changes what Will has approved for a
  gain only at the smallest window.
- Three card columns at the default window, or a card with one line less: cards would drop to
  about 300 px wide and cut names and chips; equal cards are the decided look.
- The X delete showing on hover only: decided, and Delete is also in the sheet.

## Suggestions for Will (not built)

- A. Built as R1 in a smaller form (fold the checklist instead of hiding the panels).
- B. Sheets and dialogs should start below the title bar so the window can still be moved,
  minimised and closed while one is open (item 25; four files, three of them not this area's).
- C. A sort choice in the Filters menu (Name / Last changed / Most used) for skills and agents,
  if dozens of them make A to Z slow to scan. Name stays the default.

## Round two: easy to read, icons that say what they are

Will, 2026-11-09: no big word dumps, and an icon has to say what it stands for. Four redesigns,
one commit each. Pictures: `<stop>/b2-before-*.png` and `<stop>/b2-after-*.png` at 900x600 and
1180x780, Dark and Light. Clip: `for-will/setup-walk-dark.mp4` (1180x780, 18.6 s).

- R4. Agents wear their avatar (`421651c`). Principle: one face per agent kind everywhere.
  An agent's card, its sheet and its rows in the two panels use `AgentAvatar` from
  `helperKit.tsx` as exported (no second mapping). Every other kind keeps its icon, now with
  its name on hover ("Skill", "Hook", "Agent: Review"); panel rows carry a small kind icon.
  Stops `toolkit-agent`, `toolkit-agent-item`, `toolkit`. Files: `parts.tsx`, `ItemViews.tsx`,
  `DetailSheet.tsx`, `CostPanel.tsx`, `UsagePanel.tsx`.
- R5. Hooks lead with plain words (`394e22f`). Principle: recognition before recall. The card
  and sheet read "Before a tool runs · Bash" and "Runs fmt.sh --check"; the settings name
  ("PreToolUse · Bash") is in the card's hover, the sheet's "In settings" row and search, so
  typing the real name still finds it. Stops `toolkit-hook`, `toolkit-hook-item`. Files:
  `setup-model.ts`, `ItemViews.tsx`, `DetailSheet.tsx`, `ConfirmDelete.tsx`, `ItemEditor.tsx`.
- R6. The sheet opens on what the item is (`7149960`, order fix `9f221bd`). Principle:
  progressive disclosure. Order: actions, a two-line lead ("Show all" when cut), cost, the
  short facts, then the text as it reads. Path, size, date, header settings and raw text sit
  behind one "File details" row, closed by default and remembered. Chips that repeated a fact
  row are gone; the "Where" row went (the scope chip says it). Stops `toolkit-item`,
  `toolkit-agent-item`, `toolkit-agent-file` (the row open). File: `DetailSheet.tsx`.
- R7. One count form (`9c80e42`). Principle: consistency. A count is the number after the
  label in the secondary ink ("Global 3", "Worktrees 3", "Other connected tools 19"), never
  in brackets. Stops `toolkit-filters`, `toolkit`. Files: `Toolbar.tsx`, `CostPanel.tsx`,
  `setup-cost.ts`, `DetailSheet.tsx`.

Words on the first screen of the sheet at 1180x780 (all visible words / words above the text
viewer), counted in the browser on the mock data:

| Sheet | Before | After |
|---|---|---|
| Agent, mock description | 83 / 72 | 50 / 39 |
| Agent, 80-word description | 153 / 152 | 78 / 67 |
| Skill, mock description | 91 / 76 | 72 / 55 |
| Skill, 80-word description | 153 / 152 | 94 / 77 |
| Hook | 45 / 44 | 33 / 26 |

The agent's whole sheet now fits 780 px with no scroll; its text starts at y 330, was 631.

Also shortened: the create flow's note, the editor's secrets gate, the hidden-values note.

Tests changed on purpose: `Setup.test.tsx` (path, date, model and tools are read after
opening File details), `CostPanel.test.tsx` (count without brackets), `setup-model.test.ts`
(three new tests for the plain hook names).

Left as it is: the count pill beside a section title (group headers, "Projects no longer on
disk") is the section-level form; the checklist's reasons are hover text already; the
editor's conflict dialog (a destructive choice, the words are the safety).

For other areas:

- `helperKit.tsx`: the "General purpose" look is a lightning bolt in the accent tint, the same
  glyph as the Skills kind icon. One of the two should change so they never sit side by side
  meaning different things.
- `helperKit.tsx`: agent names such as "bug-hunter" or "lane-agent" fall to the grey "Other
  helper" robot. A wider name match (hunt, debug, fix; build, lane) would give more agents a
  face of their own, on every page at once.
- Sheets still cover the title bar (suggestion B above).
