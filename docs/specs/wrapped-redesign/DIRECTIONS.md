# Wrapped redesign: three directions (2026-11-09)

Mockups only. No app code changed. Pick one direction (or mix parts) before anything is built.

- Renders: 1280 x 800, the Atlas window with the sidebar, light and dark, in
  `a-summit/`, `b-patches/`, `c-departures/` (`sheet-light.png` / `sheet-dark.png` show all seven at once).
- Source: `mock/*.html` (shared window chrome in `mock/shell.css` + `shell.js`), rebuilt with
  `python docs/specs/wrapped-redesign/mock/render.py` (headless Chrome; needs `node_modules` for the Recursive font).
- Sample numbers are Will's own Wrapped walk (`docs/shots/wrapped-fun/round3`): 873M tokens, 74 of 124
  days, best run 15, 5 PM, biggest chat 110M = 47x a usual chat, general-purpose 474 calls in 25 sessions.
  The day-by-day and hour-by-hour **shapes** in the grids and bars are illustrative (`mock/data.js`, seeded);
  the built slides draw the real `dayTokens` and `hours`.
- Each direction shows 7 of the 15 slides: opener, totals, streak/days, time, comparison, a favorite
  (the slot of the old slides 8-10), end card.

## Rules every direction follows (from Will's feedback)

1. One idea per slide: one hero (number, name or graphic) and one short line. Readable in under 3 seconds.
2. No fact appears on two slides. The opener has **no stats** (only the date range). The old slide 2 (grand
   total) and slide 3 (novels) were the same fact twice: now one slide, the novels are its line.
   The end card is the one deliberate recap, because it is the picture you save and share.
3. No decorative shapes. Every mark is data or the progress marker. Nothing overlaps.
4. Hover only where it names the exact thing under the pointer (list below). No "Your busiest stretch",
   no guesses, no filler.
5. Atlas identity kept: terracotta, Recursive (CASL 0.4, 700-760) for figures, system font for lines,
   light + dark from `src/styles/tokens.css`. No Live tag, no Anthropic or Claude marks, ASCII-only strings.

## Shared story (all three directions; 15 slides, was 18)

| # | Slide | Says | Fed by (`wrappedModel.ts`) |
|---|---|---|---|
| 1 | Opener | "Your year in Claude Code", "Jul 9 to today" | `d.from` (`rangeLabel`) |
| 2 | Tokens | 873M tokens. "About 6,500 novels' worth of words." | `d.tokens`, `novelsOf(d.tokens)` |
| 3 | Days | 74 (of 124). "Best run: 15 days in a row." | `d.activeDays`, `d.spanDays`, `d.longestStreak`, `d.dayTokens` (grid) |
| 4 | Busiest day | Mon, Oct 19. "144M tokens over 18 sessions." | `d.busiest`, `spikeChart(d, ...)` |
| 5 | Weekday | Sunday. "37% of your week." | `weekdayAverages(d.from, d.dayTokens)` |
| 6 | Prime time | 5 PM. "Your busiest hour over the last 120 days." | `peakHour(d.hours)`, `d.hours`, `d.hoursDays` |
| 7 | Longest sitting | 10 d 15 h. "In medal michael, Jul 26." | `d.longest` |
| 8 | Biggest chat | 110M / 47x a usual chat, in Origin Client | `d.biggest`, `d.habits.chatTokens / d.habits.chats` |
| 9 | Top project | Origin Client. "60% of your tokens by project." | `d.projects[0]` |
| 10 | Top skill | away-mode. "Used 25 times in 25 sessions." | `d.skills[0]` |
| 11 | Go-to helper | general-purpose. "Called 474 times in 25 sessions." | `d.agents[0]` |
| 12 | Go-to tool | Bash. "Run 76,804 times in 263 sessions." | `d.tools[0]` |
| 13 | Main model | Opus 5.5. "49% of your tokens." | `d.models[0]`, `d.tokens` |
| 14 | Coder type | Delegator. Its one line. | `coderType(d)` |
| 15 | End card | The saveable recap + Save image | `buildCard(d, type)` |

Cut: "Oldest chat still here" (its date is the opener's range), "In book terms" (now the line on 2),
"Most helpers in one chat" (a second helper fact; can come back as its own slide if wanted).
Slides 10-13 show **only the winner**: no podium, lollipop or treemap lists (old slides 8-10).
Each slide keeps at most one comparison line, still deduped by `comparer()`, and drops it when the
slide already has a line.

Hovers kept (each names the element under the pointer): a grid cell (its date, tokens, sessions);
an hour bar (that hour, average tokens a day); the hero figure on 2 and 8 (the exact token count,
`exact()`). Everything else: no hover.

---

## A. Summit (calm, Apple-keynote quiet)

**Idea.** The year is a trail and each slide is one waypoint on it. The progress bar becomes that trail:
a dotted line across the top, filled clay behind you, and the clay spark marks where you are. The slides
themselves are quiet: a white sheet, one huge Recursive figure, one plain sentence, and at most one small
clay graphic beside it. Nothing is a poster any more; it reads like an Apple keynote slide in Atlas colours.

**Slides (rendered).** `01` opener: 2026 in clay, the title, the range. `02` 873M centred, the novels line.
`03` 74 of 124 + heat grid (today bottom-right, the 15-day run ringed in clay, month labels). `06` 5 PM +
24 hour bars, the peak bar clay with the spark on it. `08` 110M + two circles to scale (a usual chat vs this
one, areas 1 : 47). `11` general-purpose set big, one line. `15` a small share card (figure, year ridge,
four facts) with Save image under it.

**Type / colour / motion.** Figures Recursive 760 at 150-236 px; kicker system 16/600 in text-2; line system
22/31. Sheet `--surface` on `--bg`, accent only on the one mark that matters. Motion: figure counts up in a
fixed box, the one graphic draws once (bars rise, rings trace), slides cross-fade with a 24 px drift in the
trail's direction, the spark walks to the next waypoint. Reduced motion: fades.

**Why it fixes the feedback.** Same layout every slide, so the eye always lands on the number first (3
seconds). No shapes at all except data. The clock is gone (no notch to look clipped): time is a row of
hour bars. The opener has nothing to repeat.
Risk: the calmest of the three; could read as plain if the motion is cut.

## B. Patches (playful, a gift you collect)

**Idea.** Every slide earns an embroidered trail patch, like a scout or national-park patch: flat clay,
slate or sand fill, a darker merrowed edge, a dashed stitch line, the number stitched inside. The shape
says what kind of fact it is (circle = amount, calendar square = days, clock = time, shield = who you
work with, hexagon = project, scalloped badge = coder type). The progress bar is the sash: each slide sews
its patch on, and the end card is the whole collection.

**Slides (rendered).** `01` the year patch "2026" + "Your year, in patches. Jul 9 to today. Thirteen to
earn." `02` circle patch 873M + novels line. `03` calendar patch 74 + "Out of 124. Best run: 15 days in a
row." `06` clock patch (hour dots only, one hand on 5) with a separate "5 PM" tab sewn under it. `08` a
110M patch beside a tiny grey "usual chat" patch, to scale. `11` shield patch "general-purpose". `15`
"2026, all earned": all 13 patches with their numbers + Save image.

**Type / colour / motion.** Patch figures Recursive 760 in cream ink; slide titles Recursive 720/44;
lines system 22 in text-2. Patches keep their colours in both themes (they are objects); only the canvas
(`--raised`, dark `#262625`) changes. Motion: the patch drops in from 1.1x with a 2 degree settle, the
stitch line runs around it once, then it flies up into its slot on the sash. Reduced motion: fades.

**Why it fixes the feedback.** The opener has one object and no stats; the shapes are the content, not
decoration, and none overlap. The clock has no 12 o'clock tick and no text inside it, so nothing reads as
clipped. The end card pays off the whole story instead of repeating a poster.
Risk: the most "cute"; long names need two lines inside a patch.

## C. Departures (kinetic, a split-flap board)

**Idea.** Wrapped is a departures board for your year. Every fact flips in on split-flap tiles set in
Recursive Mono (CASL 0.4): label flaps in grey, the hero in big flaps, the word that matters in clay flaps.
Time is a flip clock, the calendar is a grid of tiny flaps, and the end card is the board of your year.

**Slides (rendered).** `01` "ATLAS WRAPPED / YOUR 2026 / FROM JUL 9 / TO TODAY / STATUS BOARDING".
`02` 873M flaps (M in clay) + novels line. `03` 74 + a flap calendar (active days flipped to clay, the run
outlined, Today bottom-right). `06` flip clock 5:00 PM. `08` 47x (the comparison is the hero) with two
board rows THIS CHAT 110M / A USUAL CHAT 2.3M. `11` GENERAL-PURPOSE across the board. `15` the year
board: tokens, active days, prime time, top project, go-to helper, coder type + Save image.

**Type / colour / motion.** Flaps Recursive Mono 720; lines system 22. Light: cream flaps on a warm board
(`#ebe5dd`); dark: graphite flaps (`#353533`) on `#181817`; clay flaps from the accent. Progress is a row
of small flaps that flip to clay. Motion: each flap riffles through a few characters and lands, left to
right, 40-60 ms apart (the signature); nothing else moves. Reduced motion: values appear, no riffle.

**Why it fixes the feedback.** Every slide is literally one line on a board: label, value, done. No shapes
outside the tiles. The clock is a flip clock, so there is no dial or notch. Comparisons become a two-row
table plus one big ratio that reads in a second.
Risk: the furthest from today's Atlas look; caps everywhere (labels and values) must stay short.

---

## Open questions for Will
1. Which direction (A, B, C, or a mix such as B's end card on A)?
2. Keep the cut "Most helpers in one chat" slide out, or bring it back as its own slide?
3. The end card repeats headline facts on purpose (it is the shareable picture). OK, or make it only the
   coder type + save?
