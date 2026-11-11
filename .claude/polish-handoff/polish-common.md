# Atlas polish pass: common brief for every area agent

You own ONE area of the final polish pass on Atlas (Tauri 2 + React/TS). Other agents own the
other areas at the same time, each in its own git worktree. Your prompt names your area, your
files and your dev-server port.

## Read first, in this order
1. `docs/specs/fable-polish-pass.md` in your worktree: Will's full brief. It is the law for this
   job (enhance, never redesign; readable in two seconds; long names; order; small windows;
   motion and icons; formatting; the Never list). Everything below only adds logistics.
2. `CLAUDE.md` (project), `docs/specs/fun-pass/DIRECTION.md` (Trail Map: wins over CLAUDE.md),
   `docs/specs/wrapped-redesign/DIRECTIONS.md` only if Wrapped is yours.
3. `src/styles/tokens.css` + `src/styles/tokens.test.ts`. Never hard-code a value a token covers.
4. `MEMORY.md`: grep it for each of your pages (never read it whole).
5. Load the `ui-ux-pro-max` skill before the first UI edit. Do not announce it.

CONTEXT: this unit runs on Fable (not the lane's sonnet) on Will's own instruction (2026-11-09: every agent on this pass is Fable), and the audit decisions are yours:
the brief gives criteria, not a fix list. Write your decisions down in the findings file.

## Rules that bite
- UI only. No Rust, no write path, no MCP server, updater, installer, release workflow. No new
  npm/cargo dependency. If a fix needs the backend, it goes in the report, not in code.
- No "Live" tag anywhere, no emoji, ASCII-only UI strings, no confetti/sound, no Anthropic or
  Claude marks, never Recursive for body/buttons/nav/inputs/tables/code, accent and semantic
  colours untouched, `tokens.test.ts` green.
- The repo is PUBLIC. Nothing personal in a committed file. Mock and fixture data only.
- Never commit `crates/setup/gen/schemas/*.json`, `verify-bin/`, `node_modules`. Never
  `--no-verify`, never push, never force anything. `docs/shots/` is gitignored: never force-add.
- Never work in or read from another agent's worktree or an "(old copy ...)" folder.
- **File ownership.** Edit only the files your prompt lists as yours. In the shared stylesheets
  (`src/styles/trail.css`, `screens.css`) touch only the rules that belong to your pages, and put
  any new rule right next to them, never at the end of the file (five branches get merged).
  Files your prompt does not list are read-only: if a fix needs one (a shared primitive, a
  formatter in `src/lib/usage.ts`, a token), put the exact change in your report under
  SHARED REQUESTS and work around it locally if you can. Do not edit `MEMORY.md` or `CLAUDE.md`.
- **SCOPE WIDENED by Will (2026-11-09, his words): "you also have complete freedom to redesign
  anything that you think doesn't follow professional UI UX design principles and could be
  better, as well as graphic design and placement of things. Really anything to make this truly
  a 10 out of 10 application."** This replaces the brief's "enhance, do not redesign" line. Inside
  your own pages you may now BUILD what you would have written down as a suggestion: regroup or
  move a section, change a card's or sheet's layout, replace a weak graphic, redraw a chart's
  framing, rework a toolbar. Build a redesign only when you can name the principle it fixes
  (hierarchy, proximity, scanning order, affordance, feedback, consistency, density) and your
  before/after pictures show it is clearly better; otherwise leave it.
  Still fixed: the Never list, UI only (no Rust, no backend field), no new dependency, file
  ownership, the tokens and their tests (accent, semantic colours, three themes), Recursive for
  display figures only, the Trail Map identity, and the sidebar destinations. A change that
  crosses into another agent's page goes under SHARED REQUESTS. Each redesign is its own commit
  (so Will can reject one without losing the polish), with before/after pictures at 900x600 and
  1180x780, and is listed in your report under REDESIGNS (what, why, pictures) for his approval.

## Seeing the app (browser preview with the mock backend)
- Start your own dev server from YOUR worktree root, in the background, on your port:
  `npm run dev -- --port <port> --strictPort`. It listens on 127.0.0.1: always use
  `http://127.0.0.1:<port>`, never `localhost` (that gave a blank page here).
  `node_modules` is not in a worktree; Node finds the main checkout's one by walking up. If Vite
  refuses files outside the worktree, make a junction instead (never commit it):
  `cmd /c mklink /J node_modules "C:\Users\Will\Documents\Desktop Apps\Atlas\node_modules"`.
  Stop your server (exact PID only) before you finish.
- Screenshot + layout-audit tool (headless Chrome over CDP, no dependencies). COPY both files
  into your own scratch folder first and edit only your copies:
  `C:\Users\Will\AppData\Local\Temp\claude\dd52382adf59a431\85cb71c0-1e57-4e2e-af5d-dad2b3904445\scratchpad\shoot.mjs` and `stops.mjs`.
  ```
  node shoot.mjs --base http://127.0.0.1:<port> --out "C:/Users/Will/Documents/Desktop Apps/Atlas/docs/shots/fable-pass" --label before --sizes 900x600,1180x780 --themes dark,light --stops <your stops>
  ```
  Options: `--side auto,collapsed,expanded`, `--themes dark,light,silver`, `--sizes ...,1600x1000`,
  `--reduced`, `--stress`, `--query update=0.2.0`, `--noshot` (audit only). It writes
  `<out>/<stop>/<label>-<theme>-<WxH>[-side][-stress][-reduced].png` (plus `-bottom` when the stop
  has `scroll: true`) and prints the audit: PAGE-HSCROLL / HSCROLL (sideways scroll), CUT-NO-TIP
  (ellipsis or clamp with no `title`/`data-tip` within 4 ancestors), CLIPPED-X, OFF-SCREEN,
  COVERED (a control hidden behind another), OVERLAP (two controls intersect). The audit is a
  lead, not a verdict: look at the picture. `stops.mjs` holds the stops (a JS snippet per stop,
  with helpers `t.go(n)` = Ctrl+n page jump, `t.waitFor`, `t.clickText`, `t.type`, `t.press`); add
  stops for your sheets, dialogs, empty/loading/error states. The mock has scenarios
  (`MockUsage.setScenario("empty" | "indexing" | "error")`) and similar switches in the other
  mock files: read your area's mock.
- Long names: in the page, `const b = (await import("/src/lib/ipc.ts")).getBackend()` is the live
  MockBackend, and its data is plain mutable objects (`b.usage.sessions`, `b.world`, `b.library`,
  `b.team`, `b.history`). Fill `STRESS` in your `stops.mjs` so `--stress` rewrites your area's
  names in place (60+ characters with no spaces, CJK text, an emoji in a chat title, a deep
  path), then walk your stops again. Stress data is never committed.
- Video clips (Will approves redesigns and motion from short clips): `record.mjs` in the same
  scratchpad folder as `shoot.mjs` (copy it too; `rec-wrapped-story.mjs` beside it is a worked
  example script). `node record.mjs --base http://127.0.0.1:<port> --out <file.mp4> --size 1180x780 --theme dark --script <file.mjs>`
  where the script's default export is a JS string run as an async body with `t`. Clips go to
  `C:/Users/Will/Documents/Desktop Apps/Atlas/docs/shots/fable-pass/for-will/<area>-<what>.mp4`,
  10 to 25 seconds each, one per redesign or per thing that moves. Pull 3 frames with ffmpeg and
  look at them before you report a clip.
- Read your screenshots with the Read tool. Every claim in your findings and report comes from a
  picture or a measurement you took, never from memory.
- Matrix: every page of yours at 900x600 (the minimum), 1180x780 (the default) and 1600x1000,
  sidebar expanded and collapsed, Light / Dark / Silver, once with reduced motion. Do not shoot
  the whole matrix as pictures: pictures at 900x600 + 1180x780 in Dark and Light, the rest as
  `--noshot` audits plus a few pictures where the audit or your eye says to look. One check per
  shared component, not per control.

## Work order
1. Audit your pages. Write `docs/specs/fable-polish/<area>.md` in your worktree: per page, a
   short findings list (hard to read / out of order / clips or overlaps / feels flat), each with
   the picture it came from. Mark each: FIX (polish, you do it), SUGGEST (for Will), LEAVE (why).
2. Fix page by page, smallest safe change first. Re-check only what the change touched.
3. Prove each page: `after` pictures at 900x600 and 1180x780, Dark and Light (same file names
   with `--label after`), the stress run, then `npx tsc --noEmit` and `npx vitest run` (all
   green; change a test only when the behaviour it checks changed on purpose, and say so).
4. Commit per page in your worktree branch, plain message ("History: filters wrap instead of
   hiding at small windows"), ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
   git runs from your worktree cwd (never `git -C`). Do not push, do not merge.

## Report (your final message, to the orchestrator)
STATUS (done / partial + why) Â· BRANCH + head SHA Â· CHANGED (one line per page, files) Â·
VERIFIED (what you ran and saw, with picture paths; tsc and vitest results as printed) Â·
NOT VERIFIED Â· SHARED REQUESTS (exact proposed changes to files you do not own, and number or
date formats you saw differ from other pages) Â· SUGGESTIONS for Will, ranked (what you saw, what
you propose, why it helps at a glance) Â· MEMORY ENTRY (dated lines: outcomes, root causes, dead
ends). Never invent a result: if you did not run it, say so.

TEMP HYGIENE (2026-11-10: 537 leftover Chrome profiles and a 12 GB cargo target filled Temp with 77 GB).
shoot.mjs and record.mjs now remove their own Chrome profile and keep at most 3 from crashed runs.
Any other headless Chrome you launch: use a profile folder you delete when you finish (one file at a
time, then the empty folders). For cargo, set CARGO_TARGET_DIR to the one fixed folder
`%LOCALAPPDATA%\Temp\atlas-cargo-target` and reuse it; never one folder per run. Never leave
`atlas-measure-*` or `atlas-shoot-*` folders behind.
