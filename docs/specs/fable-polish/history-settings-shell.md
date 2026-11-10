# Polish pass: History, Settings and the app shell

Area `history-settings-shell`. Pictures are in `docs/shots/fable-pass/<stop>/` (kept local, never
committed). `before-*` is the app as found, `after-*` is the same stop after the fixes.
Each finding is marked FIX (done in this pass), SUGGEST (for Will, not built) or LEAVE (with why).

Stops checked: `history`, `history-detail`, `history-filters`, `history-nomatch`,
`history-removed`, `history-empty`, `history-paused`, `settings`, `settings-folder`,
`settings-claude`, `settings-data`, `settings-history`, `settings-about`, `sandbox`, `dialog`,
`leave-guard`, `toast`, `update` (with `?update=0.2.0`), `menu`, `submenu`, `shortcuts`,
`help-about`, `help-guide`, `help-privacy`, `help-terms`, `help-report`, `index-progress`.
The five stops that existed (`history`, `history-detail`, `settings`, `menu`, `shortcuts`) land
where their names say.

## History

| # | Finding | Picture | Mark |
|---|---|---|---|
| H1 | A row cuts the item name and the summary with "..." and a hover says nothing ("Instruction file changed CLAUDE....", "Changed the model to opus. Allo..."). | `history/before-dark-900x600.png` | FIX: the row's hover gives the whole line, the path and the summary. |
| H2 | A long item name is cut at the end, so the part that tells two files apart (the ending) is the part that goes. | `history/before-dark-900x600-stress.png` | FIX: a long name keeps its ending; the middle gives way. |
| H3 | In the detail, a long name is cut to one line with no way to read it, and the path breaks in the middle of a word. | `history-removed/before-dark-900x600.png` | FIX: the name wraps, the path breaks at a slash first. |
| H4 | The big "changes seen" figure counts up. History is a calm zone. | `history/before-light-1180x780.png` | FIX: a plain number. |
| H5 | Ribbon dots grow with a spring on hover. | same | FIX: same growth, plain ease, short. |
| H6 | Row icons wiggle and their tile turns into a blob on hover. | same | FIX: rows answer with the row tint only. |
| H7 | A long project name is cut inside the picker with no hover. | `history-filters/before-dark-900x600-stress.png` | FIX on this page (hover names the chosen project); the picker itself is a shared request. |
| H8 | "History is paused while Sandbox Mode is on. Turn Sandbox Mode off in Settings": Settings has no row with that name (it is "Work on a copy", under Claude folder). | `history-paused/before-dark-900x600.png` | FIX: the sentence says where, and the Settings row carries both names (S3). |
| H9 | "Nothing matches that. Try another filter or search." leaves three controls to reset by hand. | `history-nomatch/before-light-900x600.png` | FIX: one "Show everything" button under the line. |
| H10 | The diff scrolls sideways when a line is long (audit: HSCROLL +154 at 900 px). | `history/before-dark-900x600.png` | LEAVE: it is a code view; wrapping would break the line numbers and the +/- column. |
| H11 | At 900 px the chips take one line and the picker with the search the next. | `history-filters/before-dark-900x600.png` | LEAVE: nothing hides (the fix from 7932bf4 holds at every size and sidebar state checked). |
| H12 | A removed file's last copy shows a lone line number. | `history-removed/before-dark-900x600.png` | LEAVE: the mock's file is empty; a real copy has lines. |

## Settings

| # | Finding | Picture | Mark |
|---|---|---|---|
| S1 | Paths break in the middle of a word ("C:/Users/you/AppDat" / "a/Local/atlas/cache.sqlite", "atlas-san" / "dbox-1"). | `settings-data/before-light-900x600.png`, `sandbox/before-light-900x600.png` | FIX: break at a slash or hyphen first, inside a word only when one piece is wider than the row. |
| S2 | Theme cards lift with a spring on hover. Settings is a calm zone. | `settings/before-dark-900x600.png` | FIX: border and press only, no lift. |
| S3 | Other screens say "Sandbox mode" (sidebar chip, History, the Claude Code section, Help) but the switch is labelled "Work on a copy" only. | `settings-folder/before-light-900x600.png` | FIX: the row keeps its plain label and says "Sandbox mode" under it. |
| S4 | Settings always opens on Appearance, even when you were just in another section. | `settings/before-dark-900x600.png` | FIX: it reopens on the section you left, kept like the Toolkit tab (`atlas.settings.section`). |
| S5 | Reaching a section: six names in a rail (a row of chips when narrow), one section on screen at a time, nothing below the fold at 900x600 except About's last rows. | `settings-about/before-light-900x600.png` | LEAVE: one click from anywhere, no hunting. |
| S6 | The switch thumb slides with a spring. | `settings/before-dark-900x600.png` | LEAVE: it is the shared switch (used on every page); controls keep their normal motion in calm zones. |
| S7 | A section slides in when picked (260 ms ease-out, no spring). | - | LEAVE: plain ease, and reduced motion turns it into a fade. |

## App shell

| # | Finding | Picture | Mark |
|---|---|---|---|
| X1 | Sidebar folded + Sandbox mode on: the status chip is an empty tinted box (its dot is pushed out by the hidden label). | `sandbox/before-light-900x600.png` | FIX: the dot sits in the middle and the hover says "Sandbox mode". |
| X2 | A toast's action ("Undo") looks exactly like the message: same colour, same weight. | `toast/before-dark-1180x780.png` | FIX: accent colour and weight, as written. Root cause is X7. |
| X3 | Keyboard shortcuts: each group has its own key-column width, so the descriptions start at three different places. History's own keys are missing. | `shortcuts/before-dark-900x600.png` | FIX: one column width; a History group. |
| X4 | About says "Build release", Settings says "Build Release". | `help-about/before-dark-900x600.png` | FIX: "Release" in both. |
| X5 | "How to use Atlas" lists Dashboard, Sessions, Toolkit and Settings; History is not mentioned. | `help-guide/before-light-900x600.png` | FIX: one line for History. Now and Wrapped are a suggestion. |
| X6 | App menu and Help sub-menu, dialog, leave guard, update offer, index progress strip, the shared empty state. | `menu/`, `submenu/`, `dialog/`, `leave-guard/`, `update/`, `index-progress/`, `history-empty/` | LEAVE: checked at 900 and 1180, Dark and Light; nothing cut, covered or off screen. |
| X7 | `button { font: inherit; color: inherit }` in `index.css` sits outside every layer, so it beats every colour, weight and size written for a button in `trail.css`, `screens.css` or as a Tailwind class. Measured in the running app: sidebar labels are written 500 (600 when current) and show 400; every `.btn` label is written 600 and shows 400; icon buttons are written grey and show full ink; filter chips and the Settings rail are written 600 with an accent colour when picked and show 400 in ink. | probe output in the report | BUILT as a redesign once the scope widened (see Redesigns, 1): the reset moved into the base layer. |
| X8 | Icons in buttons are 14 px and in the sidebar and title bar 18 px across the whole app (54 and 17 uses), not on the 16 / 20 / 24 grid. | - | LEAVE here, SUGGEST app-wide: changing only these pages would make them the odd ones out. |
| X9 | Toasts hug their text, so three at once have three widths. | `toast/before-dark-900x600.png` | LEAVE: more than one at a time is rare, and a fixed width would leave short ones mostly empty. |

## Redesigns (scope widened by Will, 2026-11-09)

Pictures are under `docs/shots/fable-pass/<stop>/` (not in git), 900x600 and 1180x780, Dark and Light.

| # | What changed | Principle | Before / after |
|---|---|---|---|
| 1 | Shared primitive, `index.css`: the `button` reset moved into the base layer, so a button shows the colour, weight and size written for it. The current sidebar entry, a picked filter chip, the picked Settings section and the picked range are now in the accent; button labels are semibold. | Affordance and consistency: the picked state was written everywhere and shown nowhere. | `x7-before-*` / `x7-after-*`, 29 stops |
| 2 | Help: "How to use Atlas" and "Privacy" are an icon, a name and one line each. The guide uses each page's own sidebar icon and now covers Now and Wrapped. | Scanning order: a list read at a glance instead of five paragraphs. | `help-guide`, `help-privacy`: `r1-before-*` / `r1-after-*` |
| 3 | Settings: an icon on every rail entry; General (Keep running when closed, Shortcut on the desktop, Tell me when a chat finishes) apart from Appearance (theme, Launch animation, Show shortcuts); a small info mark on a row whose label has a hover; the connector sentence moved into that hover; the rebuild dialog is two short sentences. | Grouping and findability; a hover you can see is there. | `settings*`: `r2-before-*` / `r2-after-*` |
| 4 | Your data: the usage row lost its three-line cache path (it waits in the hover), both folder buttons read "Open folder", hints wrap without a stray last word; the unsaved-changes dialog is one sentence. | Density: one line of help per row. | `settings-data`: `r2-before-*` / `r3-after-*`; `leave-guard`, `dialog`: `r3-after-*` |

Privacy copy, for Will to read: the sheet used to say Atlas "makes no network connections". It looks for updates and the Library fetches the skills you pick, so it now says "Goes online: only to look for a new version and to fetch a skill you pick in the Library. None of your data is sent."

## Shared requests from the other areas

| Request | Outcome |
|---|---|
| Sheets and dialogs covered the title bar, window buttons included. | FIXED in one place (`index.css` + `trail.css`): every overlay put into `<body>` starts under the title bar, the bar is dimmed to match and the window buttons stay in reach. `tb-after-*` on `toolkit-item`, `library-sheet`, `team-sheet`, `dialog`, `leave-guard`, and `tb-mac-*`. |
| "This happens once." is said by the index banner and again by the Dashboard line under the skeletons. | Looked at together (`index-progress/after-light-900x600.png`). KEPT in the banner: it is the only place Sessions and Wrapped say it, and the Dashboard line ("Reading your history. This runs once.") repeats the banner's title as well. The line to drop is `src/pages/Dashboard.tsx:125`, which is the Dashboard area's file. |

## Tests changed on purpose

- `History.test.tsx`: the Sandbox wording ("History is paused while Sandbox mode is on").
- `AppMenu.test.tsx`: About shows "Release", not "release".
- `Settings.test.tsx`: the rail has General; the two switches that moved are found there.

## Icons (Will, 2026-11-09)

Checked every icon these pages own. Sidebar: seven different icons, each with its name beside it or in the hover when folded. History rows: nineteen kinds, nineteen different icons (`setup-model.ts`), and the row always says the kind in words. Settings rail: seven icons, always beside the name; the History entry reuses the sidebar's History icon because it is the same thing. About has the mountains, not the info circle, because the info circle is the mark for "hover for more". The app menu has no icons, only words.
