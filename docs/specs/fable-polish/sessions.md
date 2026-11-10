# Polish pass: Sessions, session detail, helper detail, quick jump

Area `sessions` of the final polish pass (`docs/specs/fable-polish-pass.md`). Audited 2026-11-09 on
the mock data in a browser at 900x600, 1180x780 and 1600x1000, Dark, Light and Silver, sidebar open
and collapsed, plus a run with long names pushed into the mock (a 90 character title with no
spaces, a CJK title, a title with an emoji, a 70 character project name, deep file paths, long
helper names). Pictures are local only (`docs/shots/` is not committed); each finding names the
picture it came from, under `docs/shots/fable-pass/`.

Each finding is marked FIX (done in this pass), SUGGEST (bigger than polish, for Will to decide) or
LEAVE (with the reason).

## Sessions

| # | Finding | Picture | Mark |
|---|---|---|---|
| S1 | Changing the order to Most tokens and back to Newest first left rows behind: the list showed 60 rows under 38 day bands (7 days twice) while the footer said "Showing 50 of 80". Cause: while the new order loads, the old page stays on screen, and it was laid out by the new order, so day bands were drawn over a page sorted by tokens and the same day got two bands with the same key. | `sessions-resort/before-dark-1180x780.png` | FIX. The list is laid out by the order of the page that is on screen. A test covers it (`sessions.test.tsx`). |
| S2 | First-look item (a), confirmed: the strip in "Pick up where you left off" was a flat filled slab beside the title when the chat's steps were all alike, and a lone hairline when the chat was too short for a trace. | `sessions/before-dark-1180x780.png`, `sessions/before-light-1180x780.png` | FIX. The trace is drawn only when the steps differ; otherwise the space stays clear. With real, uneven data it is a proper shape (`sessions/after-dark-1180x780-stress.png`). The flat slab came from the preview data, see Shared requests. |
| S3 | A long project name pushed the tokens and the date off the pick-up card's meta line. | `sessions/before-dark-900x600-stress.png` | FIX. The project name gives way (ellipsis); tokens, helpers and date stay whole, as in the rows. |
| S4 | First-look item (b): one row carries title, project, tokens, bar, helpers, date, model and effort. The title wins (16 px bold against a 12 px quiet line) and nothing wraps or collides at any size. Two real faults: a cut title or project had no hover with the whole text, and a long project name cut the model to "Opus 5.5 - l..." while keeping most of itself. | `sessions/before-dark-900x600-stress.png` | FIX. Title and project carry the whole text (project: its folder) in the hover; a long project name shortens first, down to a short stub, before the model does. |
| S5 | "Showing 50 of 80" did not use the thousands separator the count beside the search box uses. | `sessions-end/before-dark-1180x780.png` | FIX. |
| S6 | With only a search typed and nothing found, the button said "Clear filters" and the line talked about "the search and filters you set". | `sessions-none/before-dark-900x600.png` | FIX. "Clear search", "Clear filters" or "Clear search and filters", and a line to match. `usage.test.tsx` updated for the new label. |
| S7 | Search results keep the day bands, so a search with one chat per day spends half its height on bands that repeat the row's own numbers (4 matches visible at 900x600). | `sessions-search/before-dark-900x600.png` | BUILT as a redesign (`08ed228`), see Redesigns. |
| S8 | The newest chat is both the pick-up card and the first row. | `sessions/before-dark-1180x780.png` | LEAVE. By design: the card is a shortcut, the list stays complete and countable. |
| S9 | Filter and Sort menus, the empty state, the first-index state and the error state. | `sessions-filter/`, `sessions-sort/`, `sessions-empty/`, `sessions-indexing/`, `sessions-error/` (`before-*`) | LEAVE. Clear, aligned, nothing clipped at any size. |
| S10 | Order: newest first by default, the search filters as you type with the best match at the top, the toolbar and the pick-up card stay put while the list scrolls. | `sessions-search/`, `sessions-end/` | LEAVE. Already right. |

## Session detail

| # | Finding | Picture | Mark |
|---|---|---|---|
| D1 | Helper cards (Helpers, List) led with dollars ("$0.06") and their "N% of the session" was a share of dollars, so the same helper read 10% on its card and 7% on the receipt (Explore), 7% on its card and 8% on its own page (Review). The app's rule is tokens first, money in the hover (Will, 2026-11-08). | `detail-helpers-list/before-dark-1180x780.png` | FIX. The card leads with tokens (estimate in the hover), the share is of tokens, and the "Spend" order follows it. Cut helper names have a hover. |
| D2 | In the narrow slice beside the helper map, "81% of the chat" broke after "the". | `detail-helpers/before-dark-900x600.png` | FIX. The share drops to its own line whole. |
| D3 | The tab row wrapped to two lines on Helpers (List) and Details, so "Copy resume" and "Open folder" jumped between lines from tab to tab. | `detail-helpers-list/before-dark-1180x780.png`, `detail-details/before-dark-900x600.png` | FIX. Under 960 px of room the two buttons keep their icons and drop their words (still read out, still in the hover). Under 740 px (a small window with the sidebar open) a tab's own switches take a second line under the tabs, so the buttons on the right never move. |
| D4 | Details, Files: the list sat in one narrow column, so a deep path broke over three or four lines inside a 160 px box. | `detail-details-end/before-dark-1180x780-stress.png` | FIX. Files spans the full width, like Tools and skills. |
| D5 | Receipt, "Worth a look" and "Biggest line items": a deep path was cut at its end, hiding the file name, the one part that tells two paths apart. | `session-detail/before-dark-1180x780-stress.png` | FIX. The folders shorten and the file name stays (`EndLine`); the whole path is in the hover. |
| D6 | The helper map scrolls sideways inside its pane at 900x600 (111 px). | `detail-helpers/before-dark-900x600.png` | LEAVE. The canvas is wider than the pane on purpose so name plates fit; it opens centred on the main chat and every node is in view (`helperMap.test.ts`). |
| D7 | No key goes back from a chat to the list. | - | SUGGEST: Esc (or Alt+Left) goes back. A new shortcut, so not built in this pass. |
| D8 | Details, "Spend as it ran" reads in dollars while everything else on the page reads in tokens. | `detail-details/before-dark-1180x780.png` | SUGGEST: draw it in tokens with the estimate in the hover, or drop it, since "Tokens through the session" sits right under it. |
| D9 | Header, hero figure, split bars, stat tiles, "Through the session", Messages. | `session-detail/`, `detail-messages/`, `detail-details/` (`before-*`) | LEAVE, except Messages: a long message now shows six lines and "Show all" (`cc28de6`). |

## Helper detail

| # | Finding | Picture | Mark |
|---|---|---|---|
| A1 | The back button reads "Back to <chat name>" with no limit, so a long chat name made a button as wide as the page. | `agent-detail/before-dark-900x600-stress.png` | FIX. The name shortens inside the button (30 rem at most); the whole name is in the hover. |
| A2 | The "Tokens" tile repeats the hero figure. | `agent-detail/before-dark-1180x780.png` | BUILT as a redesign (`ff87d2b`): the four tiles are gone, see Redesigns. |
| A3 | "Through its run": the summit spark sits on the first bar when every bar is the same height. | `agent-detail/before-dark-1180x780-bottom.png` | Shared request (charts). |

## Quick jump (Ctrl+K)

| # | Finding | Picture | Mark |
|---|---|---|---|
| P1 | A long chat title or project is cut with no way to read the rest. | `palette-chat/before-dark-900x600-stress.png` | FIX. Chats, projects and skills carry the whole text in the hover; pages (short, fixed names) do not. |
| P2 | Unnamed chats read "Session in <project>"; "Nothing matches" when nothing does. | `palette-none/before-dark-1180x780.png` | LEAVE. Existing naming rule, clear as it is. |

## Redesigns (after Will lifted "enhance, do not redesign", 2026-11-09)

Will's direction for these pages: easy to read once you are in the map and the helpers, never a big
word dump, and an icon per kind of helper that says what it is. Each redesign is its own commit, with
identically framed pictures before and after at 900x600 and 1180x780, Dark and Light.

| # | What changed | Principle | Commit | Pictures (`docs/shots/fable-pass/`) |
|---|---|---|---|---|
| R1 | Search results in Sessions are one flat list, best match first, no day bands. | Do not repeat information; show more answers per screen. | `08ed228` | `sessions-search/before-*` and `sessions-search/redesign-*` |
| R2 | Rows under a day band say the time only ("18:44"); the band says the day. | Say a thing once (proximity carries the day). | `389925a` | `sessions/before-*` and `sessions/redesign-*` |
| R3 | One icon per kind of helper, and a shape for where it sits: main chat = solid clay circle, helper = tinted rounded tile, a helper started by a helper = the same tile hollow (outline only, as on the map; `74f0d34`). Thirteen kinds, thirteen Phosphor duotone icons, tones from existing tokens, hover and accessible name on every avatar. | Recognition over recall; shape first, colour second; one sign for one thing on every page. | `4bd3b83`, widened in `d2c5478` | `for-will/helper-avatars-24-32-40-dark-light.png` |
| R4 | A helper in the list is one row (avatar, name, how it ended, kind, time, model, tokens and share), not a four-line card. About 8 helpers fit where 3.5 did. A nested row with a long name stays inside a narrow pane (`74f0d34`). | Scannability: one line per item, the same facts in the same place. | `afa990a` | `detail-helpers-list/hbefore-*` and `detail-helpers-list/hafter-*` |
| R5 | The helper map reads without pointing at it: nodes are the same avatars as the list, the 8 biggest helpers carry a short name and their tokens, a corner dot says how each ended, and the legend shows only the kinds that are present. The whole name is still on the plate on hover or focus; while the plate shows, the short name steps aside (`729b23f`). | Visibility of system status; no hover-only information. | `dc93d88` | `detail-helpers/hbefore-*` and `detail-helpers/hafter-*` |
| R6 | The slice beside the map leads with one figure: who (avatar, name, how it ended), tokens and share, model and time, "Open helper". Kinds of tokens and the biggest lines wait behind "Where it went". | Progressive disclosure: one figure first, detail on request. | `ea29aff` | same pictures as R5 |
| R7 | The helper's own page says who, how much and what it was asked on one screen: header with avatar, outcome and kind; one figure with its share and three facts beside it; the prompt clamped to three lines with "Show all". The dollar ridge and the four tiles that repeated the figure are gone. | One primary figure per block; no repeated fact; progressive disclosure. | `ff87d2b` | `agent-detail/hbefore-*`, `agent-detail/hafter-*`, `agent-detail-long/hafter-*` |
| R8 | A long message in Messages shows six lines and "Show all". | Progressive disclosure. | `cc28de6` | not seen with a long message in the preview (mock messages are short); covered by `detailParts.test.tsx` and by the same control in `agent-detail-long/hafter-*` |

Clips for Will (1180x780, Dark): `for-will/sessions-search-dark.mp4`, `for-will/session-detail-map-dark.mp4`.

### Words on the first screen

Counted by script: every visible word inside the page area at the first scroll position (a clamped
text counts in full, so the real drop is a little bigger). "Heavy" is the preview chat with 17
helpers and long names pushed in.

| Page | 1180x780 before | after | 1180x780 heavy before | after | 900x600 before | after | 900x600 heavy before | after |
|---|---|---|---|---|---|---|---|---|
| Session detail (Tokens) | 151 | 151 | 136 | 136 | 115 | 115 | 84 | 84 |
| Helpers, map | 103 | 63 | 103 | 69 | 83 | 63 | 81 | 69 |
| Helpers, list | 96 | 77 | 155 | 167 | 96 | 77 | 119 | 132 |
| Helper page | 85 | 64 | 87 | 66 | 82 | 64 | 65 | 66 |

The heavy list has more words on screen after, because about 8 helpers fit where 3.5 did; each
helper takes roughly half the words it did. The Tokens tab of Session detail was not redesigned
(three columns of labelled figures, no prose); it is the densest screen left, see Suggestions.

### The helper icons (`src/components/usage/helperKit.tsx`)

The type name is lower-cased and the first rule that matches wins.

| Order | Words in the type name | Icon (Phosphor, duotone) | Tone | Label |
|---|---|---|---|---|
| 1 | bug, crash, debug, diagnos, troubleshoot, hunt, investigat | Bug | amber | Debug |
| 2 | perf, profil, optimis/optimiz, benchmark | Gauge | blue | Speed |
| 3 | test, verif, qa, valid | Flask | blue | Test |
| 4 | review, audit, critic, critique | Eye | green | Review |
| 5 | explor, search, research, find, fetch, lookup, scout, recon | Compass | slate | Explore |
| 6 | spec (at a word start) | MapTrifold | amber | Plan |
| 7 | doc, writ, guide, changelog, readme | PencilLine | slate | Writing |
| 8 | plan, architect, advis, strateg | MapTrifold | amber | Plan |
| 9 | releas, deploy, packag, publish, ops, infra | Package | green | Release |
| 10 | design, ui, ux, styl, brand, asset, visual, frontend | Palette | blue | Design |
| 11 | chore, mechanic, cleanup, tidy, format, lint, rename, housekeep | Broom | plain | Chores |
| 12 | general | Shapes | clay | General |
| 13 | code, coder, coding, build, dev, engineer, implement, refactor, program, mod, port | Hammer | clay | Build |
| - | anything else, or no type | HeadCircuit | plain | Other (hover: "Helper") |
| - | the main chat | ChatCircleText on a solid clay circle | accent | Main chat |

No helper icon is an icon the Toolkit uses for a kind of setup item (a test holds that against
`KINDS` in `src/lib/setup-model.ts`). Icon sizes follow the 16 / 20 / 24 grid: 16 under a 32 px
avatar, 20 from 32, 24 from 40.

## Shared requests (files this area does not own)

- `src/lib/mockUsage.ts`, `points()`: every message gets the same tokens, so every trace, ridge and
  bar chart in the browser preview is flat. Vary the tokens per message (for example by a seeded
  factor between 0.3 and 2.5) so the preview shows the shapes real data has.
- `src/components/charts/Bars.tsx`: the summit spark is planted on the tallest bar even when all
  bars are alike, where it lands on the first one. Plant it only on a clear peak (the rule the
  ridge already uses: `hasClearPeak` in `src/components/usage/timelineBars.ts`).
- Done for other areas, in files this area owns: `60efc35` (Dashboard: in the narrow "Recent
  sessions" column a row item drops out whole, never to a stub), `c7b8158` (`SelectField` carries the
  chosen option as its hover, for the cut "All projects" picker in History), and the Dashboard's
  request for hovers on the row title and project (already there since `03451d1`: the title has
  `title`, the project has its folder as `data-tip`).
- Toolkit agent cards and the Team page: use `AgentAvatar` / `agentLook` from `helperKit.tsx` so a
  helper wears the same icon on every page (`src/components/now/HelperTracker.tsx` already does and
  picks the new icons up as it is). The exported API did not change.
- Formats seen on these pages, for the cross-page check: tokens compact ("203k tokens", exact count
  in the hover), dates "Oct 30, 18:44" and "Today, 16:42", durations "1 h 11 min", shares as whole
  percentages, estimates as "$0.06" only inside hovers.

## Round two (2026-11-10)

Four small items on Session detail, each its own commit. Pictures: `s2-before-*` and `s2-after-*`
under `docs/shots/fable-pass/{session-detail,detail-helpers,detail-helpers-key,detail-details,detail-helpers-list}/`,
900x600 and 1180x780, Dark and Light, plain and with 17 helpers (`-stress`). Clip:
`docs/shots/fable-pass/for-will/session-detail-tokens-dark.mp4` (12 s).

| # | What changed | Principle | Commit |
|---|---|---|---|
| T1 | Tokens tab, "Who used it": every row wears the 24 px avatar the map and the list give that thread (main chat circle, helper tile, hollow tile for a helper's helper, the stack for "N other helpers"). | One icon per kind of helper, on every page. | `69a65a6` |
| T2 | Tokens tab, "Biggest line items": the Total row is gone, and so is the total-minus-items "Everything else". The `~` figures are sizes the engine reads off each result (its length in bytes over four, `receipt_scan.rs`), added up per line; they are not shares of the chat's tokens and can add up to more than the total (the mock chat: about 488k of items against a 203k total). One note says so: "~ is a rough size from the length of each result, not a share of the total." Items the column has no room for show as "N smaller items" with their own summed size. | Never show a sum that is not one; say what a figure is. | `69a65a6` |
| T3 | Escape and Alt+Left go back one level: a helper's page to its session, the session to the list. They stand down while a dialog, sheet, menu or list popup is open, while focus is in a text field, and when something else took the key (a focused chart clearing its readout). With shortcut hints on, the back button's hover names the key. | An escape route from every level; keyboard first. | `36c0076` |
| T4 | The map's key is one line. It is laid out whole and measured against its room: when it fits (a 3-helper chat at 900x600) nothing changes; when it does not (17 helpers took three lines and the map lost that height) the kinds fold behind "Key" and how the helpers ended stays in view. Opened, the kinds sit in a row of their own above the line, in the key's room, never on the map. | Progressive disclosure; the legend never competes with the chart. | `de3f3b3` |
| T5 | Details tab: "Spend as it ran" (a dollar ridge) is gone. In tokens it would be "Tokens through the session" again, which stays, moves up beside the token breakdown, and keeps each bar's dollar estimate in its hover. The helper list's order choice reads "Tokens" (it always sorted by tokens; it said "Spend"). | Tokens everywhere, money on hover; say a thing once. | `26a82ac` |

Words on the first screen, 1180x780, before -> after: Tokens tab 151 -> 165 (plain; the note under the
line items, 14 words, replaces "Total 203k tokens"), 136 -> 151 (17 helpers; adds "1 smaller item");
map 63 -> 63 (plain), 69 -> 55 (17 helpers, key folded).

Left as it is, on purpose:
- With "Key" open at 900x600 and 17 helpers the layout check still reports two nodes "covered" by the
  kinds row. They are scrolled out of the map's pane (the tree is bigger than the pane and scrolls,
  as before); the key has its own room under the pane and is not drawn over the map.
- `spendRidge` and `hasClearPeak` in `src/components/usage/timelineBars.ts` have no caller now. That
  file is shared (Pick up, helper page), so they are left for the integration pass to remove.
- The shortcuts list (`src/lib/appMenu.ts`, shared) has no "Sessions" group yet: "Escape or Alt+Left:
  back to the list" and "Alt+Up / Alt+Down: previous and next session" belong there.
- `src/lib/mockReceipt.ts` (read-only here): the mock line items add up to more than twice the chat's
  tokens. Real results are written into the chat once, so the sum is normally under the total;
  scaling the mock items down would make the preview closer to a real chat.

## Suggestions for Will, ranked

1. Session detail, Tokens tab: it is still the densest screen (165 words at 1180x780). Lead with the
   split bar and the one flag, and put "Biggest line items" behind a "Where it went" switch like the
   slice beside the map.
2. Remember whether "Key" was left open, per person, so a reader who wants the icons named sees
   them on every big map.
3. Built in round two: the back keys (T3), the one-line key (T4), the dollar chart gone (T5).
