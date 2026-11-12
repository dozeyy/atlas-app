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

## Review round

Two reviewers looked at the merged build. The code review passed with six small findings; the
design review said "fix first" with seventeen. Three passes fixed their own pages, then one pass
merged them, put the shared parts on every page and fixed what a run in the real window showed.

**Code review**
- Helper kinds matched on parts of words ("docker-deployer" showed as Writing); the name rules pulled React into plain model code (`c14a88e`).
- Esc on a keyboard tooltip also left the page (`6a65b44`). Every loaded message had its own size watcher (`7c6c72b`).
- A model showed as two rows with one name (`a104a66`, Dashboard `ee6301d`). A hook line used a non-ASCII dot and split a matcher wrongly (`5f682f6`).
- Source comments named a person (`ec7c83c`).

**Design review**
- Four words for one thing: every string now says session (`66b83d7`; Settings "Read sessions again" `542a39c`).
- Now buried what waits for you, and changed layout at five sessions (`88a35a2`).
- The session page was the densest screen: one big figure on top, line items behind one row, plain words with the exact term on hover (`eb2b03b`, `9b39543`, `2334876`, `16f2207`).
- Toolkit put numbers above the type tiles; unused items were grey squares (`0869690`). Cards and sheets carried raw ids, "1 skills", a modal delete that said "whole folder" (`5f682f6`).
- Empty, no-match and error states came in four treatments: one shared part, errors calm (`56fe6dd`, on every page `58dbc0e`).
- Helper icons reused the warning and finished colours (`8c7eb46`).
- Code text read heavy and headings followed no rule: one code class, one heading rule (`43df22b`, `bc61e84`, `58dbc0e`).
- Library rows all looked alike, an installed row looked selected (`9eb19a9`).
- Clay on routine marks: the place chip, History dots and tiles, a star on helper tracks (`5f682f6`, `516a727`, `88a35a2`).
- Informational dialogs ended in a filled Close; three toasts hid a short window (`bc61e84`, `89edad5`).
- Team repeated one caption on six cards and wrapped dates (`314f798`). History rows cut names beside a wide panel (`516a727`).
- Small slips: axis ticks, a stray line, plain dates and units (`067bbb0`), the failed-save line and hour axis in Wrapped (`2aef79d`), the Sessions list edge and typed-word mark (`b3e3050`, `dfa939f`), a raw path on the helper page (`0b578ec`).
- Terms of service: left exactly as it is, as decided.

**From a run in the real window**
- Settings > Your data said "updated Jan 21, 1970": the engine sends seconds, the page counted milliseconds. Converted once, where the value comes over IPC (`d23c9b1`).
- One font face never loaded: the build inlined its small file as a data URL, which the app's content rule refuses. Every face now ships as a file (`8466100`).
- A finished session showed "-" for tokens: the engine has no total for a session that ended before launch, so that row shows no token figure (`65f92da`).
- The focus ring on "Where it went" was cut on the right (`88633b0`).
- A fourth finished row cut to a sliver on Now, and a History diff that scrolled sideways: both gone with the reworked pages (`88a35a2`, `516a727`), measured again at 900x600 and 1180x780.

**Left between pages**
- "usage data" is the one name for Atlas's own store (`de6815f`). The filled danger button is one shared variant (`563de57`).
- Model and effort read one way everywhere: "Opus 5.5, high effort" (`c141e6c`).
- The "Installed x. Undo" toast stays on its page; a toast that is the only Undo still follows (`27771f4`; a Toolkit tab counts as a page, `c85b5fa`). An unused helper removed (`aa939e8`).

## Redesigns

The review round's rows are at the end of the table. The helper avatar colours (`8c7eb46`) are
one commit that reverts alone.

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
| Review round: all pages | One noun, "session", in every string | `66b83d7`, `542a39c` |
| Review round: all pages | One empty, no-match and calm error state | `56fe6dd`, `58dbc0e` |
| Review round: all pages | One heading rule, one code-text class | `43df22b`, `bc61e84`, `58dbc0e` |
| Review round: all pages | Model and effort in plain words: "Opus 5.5, high effort" | `c141e6c` |
| Review round: helpers | Avatar colours from the chart tints only, a tile shape per family, two cues for a helper's helper (reverts alone) | `8c7eb46` |
| Review round: Now | What waits for you leads; one row per running session at every count; no dot trail | `88a35a2` |
| Review round: Now | A finished row with no total shows no token figure | `65f92da` |
| Review round: Sessions | The session page opens on one big figure and one plain line; one control in the tab row | `eb2b03b` |
| Review round: Sessions | Tokens tab: line items behind one row | `9b39543` |
| Review round: Sessions | Details tab and helper page say whose file, not its path | `2334876`, `0b578ec` |
| Review round: Sessions | The list lines up with the toolbar; a typed word is underlined | `b3e3050`, `dfa939f` |
| Review round: Toolkit | Type tiles before the numbers; unused items named; one cost unit per card | `0869690` |
| Review round: Toolkit | Plain words on cards and sheets, a quiet place chip, a delete that names what goes | `5f682f6` |
| Review round: Library | A row shows what it is about; installed has its own mark; uninstall asks on the row | `9eb19a9` |
| Review round: Team | The bars are explained once; effort is labelled | `314f798` |
| Review round: History | Quiet dots and tiles; clay only on the open change and today | `516a727` |
| Review round: Dashboard | Round axis ticks, a dated grid, one row per model name | `067bbb0`, `ee6301d` |
| Review round: Shell | The toast pile folds to its newest in a short window; outlined Close on dialogs that only inform | `89edad5`, `bc61e84` |
| Review round: Shell | The "Installed x. Undo" toast stays on its page and its Toolkit tab | `27771f4`, `c85b5fa` |
| Review round: Wrapped | A failed save is a mark and words; the hour axis is named to its end | `2aef79d` |

## Suggestions, not built (ranked, backend first)

Engine and data (Rust):
1. **`last_indexed_at` is in seconds, every other time stamp is in milliseconds.** The page now converts it where it comes over IPC (`src/lib/ipc.ts`, `indexedAtMs`). Send milliseconds, or name the field for its unit, and drop the conversion.
2. **Engine strings still say "chat" and "usage cache".** The pages say "session" and "usage data"; text written in Rust does not: `crates/core/src/usage/receipt.rs`, `crates/core/src/usage/debrief_text.rs`, `crates/core/src/setup/cost.rs`, `crates/core/src/search/mod.rs`, `crates/core/src/habits/mod.rs`, `crates/core/src/usage/mod.rs` (the error lines), `crates/app/src/usage.rs`, `crates/cli/src/render.rs`. The pages reword the names they know about on the way in (`src/lib/sessionWords.ts`).
3. **A finished session has no token total when it ended before Atlas started** (`tokens: None` in the Now tracker). Now leaves the figure out for that row; the usage data has the total, so the tracker could fill it.
4. **`review_rule::rule_slug` cuts a rule's name in the middle of a word.** Cut at a word end.
5. **The scan writes "1 skills" and "Shadowed".** The pages fix both on the way in ("1 skill", plain words for the state); the scan should count and name them right.
6. **`humanize_type` writes "Ui".** The pages fix known short words where they know a name came from a type; the map, the Tokens tab and Now do not get that hint, so a name source on those rows (or the fix in the backend) would finish it.
7. **Library popularity.** (Built: `crates/core/src/library/popularity.rs`, spec section 9 in `skill-library.md`.) Read `unique_installs` from Claude Code's plugin cache and sort by it; send the first page in catalog order so the first rows do not reshuffle.
8. **Library "update available".** No such state in the data; with a version check the Installed rail gets a dot and the row an Update button.
9. **Library contents counts per entry** (skills, agents, hooks inside), so a row can say what it holds before the sheet opens.
10. **Top lists ordered by cost.** The page shows tokens and sorts what it gets, but the top four by cost are not always the top four by tokens.
11. **`NowHelper` has no parent field**, so Now cannot nest a helper under the helper that started it.
12. **First-launch intro into Wrapped** needs three settings fields that were deferred (2026-11-09): the message, a shown-once flag, and the start view.

Pages:
13. **History has no Undo button.** A change can be copied or saved by hand there, but the only one-press Undo for a delete, a removed plugin or a saved rule is its toast. An Undo on the History detail would let every such toast stay on its page.
14. **History rows with very long names.** At 900x600 with a 50-character file name the change label is cut ("Settings file chan..."); the whole line is on the row's hover. The name already gives way first but keeps its last ten characters; shorter labels or a shorter kept ending would finish it.
15. **A sort choice for skills and agents** (Name, Last changed, Most used).
16. **Remember "Key" open** on the helper map.
17. **Wrapped at a small window** could scale the centred slides on their own instead of the whole frame.
18. **One money format.** The rounded hover estimate (`fmtUsd`) and the exact figure (`formatUsd`) are two helpers; left because they answer different questions.
19. **macOS title bar.** With the sidebar open, the sidebar button's box and the Wrapped gift's box overlap by 5 px (the glyphs do not, and each glyph still reaches its own button). `padding-left: 78px` in `src/styles/trail.css` (the macOS `.titlebar-left` rule) clears it, but it moves both buttons toward the traffic lights, so it wants a look on a real Mac first.
20. **Edit sheet in a short window.** With a long name and a two-line check message at 900x600, Cancel and Save start a few pixels below the fold and the sheet scrolls to them with no gap under them. The editor already gives up height down to eight lines; a smaller floor at this size would keep them in view.

Not verified in this pass: everything above was checked in the mock preview. The real window
(the built app on a real folder) was not run here.
