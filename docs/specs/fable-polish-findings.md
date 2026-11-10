# Fable polish pass: findings

One page. What was hard to read, out of order, clipped or flat, and what was done about it.
Short SHAs are commits on the polish branch. The longer notes per area are in
`docs/specs/fable-polish/`. All pictures and numbers come from the mock preview, never a real folder.

## What was wrong and what was done

**Dashboard**
- Small window: cards stacked into a long scroll, axis labels did not end on Today. Laid out again, lists sorted by tokens (`e2830c2`, `68f0f01`).
- Recent sessions broke into two columns inside their card (`08d43cd`). The first-read banner said "this happens once" twice (`b327f88`).

**Now**
- Helper names were cut, chips shaved, edges ragged; running cards did not line up down the list (`32e781a`, `58f2a13`).
- A long path lost its file name; a helper's kind was cut before its model (`91fef7f`, `6b02cec`). Empty states said nothing to do next (`1a6e113`).

**Sessions, a chat, a helper**
- Rows repeated the day under a day band; search results were grouped twice (`389925a`, `08ed228`). A narrow row cut items to stubs (`60efc35`).
- A helper was a four-line card, the map only made sense when pointed at, the slice was a word block (`afa990a`, `dc93d88`, `ea29aff`).
- The helper page hid who, how much and the ask below the fold (`ff87d2b`). The run over time was drawn twice, once in dollars (`26a82ac`).
- No way back by keyboard (`36c0076`).

**Toolkit > Your setup**
- The type tiles fell off screen behind the panels; the checklist could not be put away (`eafb6d0`, `469a822`).
- Hook cards repeated their title in settings words (`dcfd117`, `394e22f`). The sheet opened on file facts, not on what the item is (`7149960`, `9f221bd`).
- Paths overflowed, Save left the screen in a small window (`76a2e16`).

**Library and Team**
- What you already have was mixed into the catalog; the install sheet buried "is it safe" (`cda15c3`, `7f733fb`).
- Without Claude Code's command every row said the same warning (`2c2270f`). A search with no result was a dead end (`994df54`).
- A scorecard was a wall of equal numbers; review themes were long sentences (`528a958`, `f9a01bc`, `b887f2f`).

**History, Settings, shell**
- History rows shouted, long names lost their ending, an empty filter had no way out (`aa5066f`).
- Settings sections looked alike; Your data and the leave guard were paragraphs (`b902a92`, `7810fff`, `9ff62a1`).
- A sheet covered Minimize, Maximize and Close (`4cb20f7`). Buttons ignored their own styles (`2e9f4f0`). Raw paths sat on the surface (`26772b6`).
- Privacy now says exactly what the code does (`b3b168a`).

**Wrapped**
- Long names ran out of the sheet at a small window (`2c90839`). The recap card shared its sheet and was soft on a 2x screen (`1042ba5`, `94a5282`).

**Across pages (the integration pass)**
- A helper had a different icon on different pages: one avatar kit everywhere (`dae6199`).
- "Ui builder", "Qa": UI, QA, API, MCP, CI and PR in capitals, one rule (`e8bc91f`, `5116d01`).
- A model inside a provider's id showed as a raw id on some pages (`f98d9c9`).
- Three clocks and three Today/Yesterday rules: one clock that follows the system (12 h or 24 h) and one day rule (`8a70cb4`).
- Sizes and counts were formatted four ways, some in brackets (`f08a60f`).
- The search box had no clear button on some pages; the peak mark sat on level bars; a toast covered the last row (`c5da056`).
- The Sessions keys were missing from Keyboard shortcuts (`eaf9ef9`). Mock data used names that looked real, and mock runs were flat (`e3e4c34`).
- Wrapped showed a helper's type id ("general-purpose"); it now reads "General purpose" like Team and Sessions (`19c0d82`).
- In a 900x600 window, a long skill name plus a two-line check message pushed Cancel and Save under the edit sheet's bottom gap, which took their clicks (`6f0d39e`).

## Redesigns

| Area | Redesign | Commit |
|---|---|---|
| Sessions | One icon per kind of helper, a shape for where it sits | `4bd3b83` |
| Sessions | A helper is one row | `afa990a` |
| Sessions | The helper map reads without pointing; its key is one line | `dc93d88`, `de3f3b3` |
| Sessions | The slice beside the map leads with one figure | `ea29aff` |
| Sessions | The helper page: who, how much, what it was asked | `ff87d2b` |
| Sessions | Search results are one flat list; rows under a day say the time only | `08ed228`, `389925a` |
| Dashboard | Today and On a roll share a row in a narrow window | `68f0f01` |
| Now | Running cards line up; folder and model stay under the title | `58f2a13`, `a4cae82` |
| Now | Helper rows put tokens before the clock | `7ec29cc` |
| Toolkit | Agents wear their avatar; every kind icon says what it is on hover | `421651c` |
| Toolkit | Hooks lead with plain words | `394e22f` |
| Toolkit | The sheet opens on what the item is; file details behind one row | `7149960` |
| Toolkit | One count form, never in brackets | `9c80e42` |
| Library | What you have first; tiles that show state | `cda15c3` |
| Library | The install sheet: what it is, what is inside, is it safe, Install | `7f733fb` |
| Library | The Installed source says when a plugin changed | `d16b9b9` |
| Team | A scorecard leads with use and whether the work passes review | `528a958` |
| Team | Caught in review shows helpers as avatars, short lines | `f9a01bc` |
| Settings | Sections you can tell at a glance; Your data says less | `b902a92`, `7810fff` |
| Shell | Help reads at a glance; sheets open under the title bar | `cf3cd89`, `4cb20f7` |
| Shell | Toasts sit in the page pane and the page ends above them | `c5da056` |
| Wrapped | The recap card stands alone, Save image is the primary button | `1042ba5` |

## Suggestions, not built (ranked, backend first)

1. **Library popularity.** Read `unique_installs` from Claude Code's plugin cache and sort by it; send the first page in catalog order so the first rows do not reshuffle.
2. **Library "update available".** No such state in the data; with a version check the Installed rail gets a dot and the row an Update button.
3. **Library contents counts per entry** (skills, agents, hooks inside), so a row can say what it holds before the sheet opens.
4. **`humanize_type` writes "Ui".** The pages now fix known short words where they know a name came from a type; the map, the Tokens tab and Now do not get that hint, so a name source on those rows (or the fix in the backend) would finish it.
5. **Top lists ordered by cost.** The page shows tokens and sorts what it gets, but the top four by cost are not always the top four by tokens.
6. **`NowHelper` has no parent field**, so Now cannot nest a helper under the helper that started it.
7. **First-launch intro into Wrapped** needs three settings fields Will deferred (2026-11-09): the message, a shown-once flag, and the start view.
8. **A sort choice for skills and agents** (Name, Last changed, Most used).
9. **Tokens tab** is still the densest screen: put "Biggest line items" behind a switch like the slice beside the map.
10. **Remember "Key" open** on the helper map.
11. **Wrapped at a small window** could scale the centred slides on their own instead of the whole frame.
12. **One money format.** The rounded hover estimate (`fmtUsd`) and the exact figure (`formatUsd`) are two helpers; left because they answer different questions.
13. **macOS title bar.** With the sidebar open, the sidebar button's box and the Wrapped gift's box overlap by 5 px (the glyphs do not, and each glyph still reaches its own button). `padding-left: 78px` in `src/styles/trail.css` (the macOS `.titlebar-left` rule) clears it, but it moves both buttons toward the traffic lights, so it wants a look on a real Mac first.
14. **Edit sheet in a short window.** With a long name and a two-line check message at 900x600, Cancel and Save start a few pixels below the fold and the sheet scrolls to them with no gap under them. The editor already gives up height down to eight lines; a smaller floor at this size would keep them in view.
15. **History rows with very long names.** The change label ("Settings file changed") is cut before the file name gives up its last characters; the whole line is on the row's hover. Let the name shrink to nothing first.
