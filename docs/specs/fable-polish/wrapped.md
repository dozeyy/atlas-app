# Polish pass: Wrapped

Area agent: `wrapped`. Pages: the Summit story (15 slides), the trail, Save image, the keys, the
loading / empty / error states, the way in (gift button), the launch splash.

Pictures are local only (`docs/shots/` is gitignored): `docs/shots/fable-pass/wrapped-<n>/` for slide
`n` (1 opener ... 15 card), plus `wrapped-empty`, `wrapped-indexing`, `wrapped-error`. Names are
`<before|after>-<theme>-<size>[-expanded][-stress].png`. All data is the in-memory MockBackend.

Each finding is marked FIX (done in this pass), SUGGEST (for Will, not built) or LEAVE.

## Every slide

| # | Finding | Picture | Mark |
|---|---|---|---|
| 1 | A long name on a name slide (top project, top skill, go-to helper, go-to tool, main model) stayed on one line at the 56 px floor and ran off both edges of the sheet: no ellipsis, no hover. Seen with a 74 letter folder name, a 30 character CJK name and a long connector tool. | `wrapped-9..13/before-dark-900x600-expanded-stress.png` | FIX |
| 2 | A model id from a cloud provider (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) reached the slide raw, as the hero. | `wrapped-13/before-dark-900x600-expanded-stress.png` | FIX |
| 3 | A connector's tool was the hero in its raw form (`mcp__server__tool`). | `wrapped-12/before-dark-900x600-expanded-stress.png` | FIX |
| 4 | In the two-column slides the figure was measured as its 430 px column, not as its text, so the shrink-to-fit never ran there: "559k tokens" ran past its column to within a few pixels of the grey circle. | `wrapped-8/before-dark-1180x780.png` vs `after-dark-1180x780.png` | FIX |
| 5 | The frame is scaled to the sheet (about 0.6 at 900 x 600 with the sidebar open), so the kicker drew at about 9 px, chart captions at about 7 px, the opener's date line at about 12 px. | `wrapped-2/before-dark-900x600.png`, `wrapped-6/before-light-900x600-expanded.png` | FIX |
| 6 | The count under the sheet ("9 of 15") sat between Back and Start / Next / Replay with space-between, so it slid sideways when the right button changed width. | `wrapped-1` vs `wrapped-15/before-dark-1180x780.png` | FIX |
| 7 | The trail's waypoints are dots with no words and had no hover. | `wrapped-1/before-dark-1180x780.png` | FIX |
| 8 | Right, Left and Space page the story (checked in the browser: opener, tokens, days, back to tokens, on to days, back to the opener, and Left on the opener stays put). | audit note, no picture | LEAVE |
| 9 | Move between slides: cross-fade with a 24 px drift, the figure counts up inside a box that is already its final size, the spark walks. Checked frame by frame (16 frames, 40 ms apart, slide 1 to 2): nothing snaps or shifts. | scratch burst, not kept | LEAVE |

Decisions:

- Long names: the figure still shrinks on one line down to 56 px. If it is still too wide, it goes
  on two lines (no smaller than 40 px), is cut with "..." after the second, and the whole name is its
  hover. Words break anywhere, so a name with no spaces and CJK both wrap.
- Model ids: the story names the model inside a provider id ("Sonnet 4.5"). An id with no model in it
  is treated like any long name.
- Connector tools show the tool's own name (`read_page`); two tools that would then read the same
  keep the full id. A shortened skill, helper or tool name has its exact id as the figure's hover.
- Small print floors: kicker 12.5 px, chart captions 10 px, the opener's date line 13 px on screen,
  whatever the scale. Above a scale of about 0.8 nothing changes.

## Days (slide 3)

| Finding | Picture | Mark |
|---|---|---|
| With a short history (9 weeks in the mock) the heat grid was a 240 px patch pinned to the right edge, far from its words. | `wrapped-3/before-dark-1180x780.png` | FIX: cells grow up to 34 px for a short history; 18 weeks and more are unchanged |
| The graphics stay on the frame's right margin (48 px), as in the mockups, not centred in their half. | `wrapped-3/after-dark-1180x780.png` | LEAVE |

## The card (slide 15)

| Finding | Picture | Mark |
|---|---|---|
| At 900 x 600 the card was about 300 px wide (its labels about 9 px) with room to spare beside it, and Save image was scaled down with the frame (about 9 px text). | `wrapped-15/before-dark-900x600.png` | FIX |
| A long project name in a fact shrank to small print, then was cut. | `wrapped-15/before-dark-900x600-expanded-stress.png` | FIX |

Decisions: Save image and its status line are always the app's own size. In a small window (scale
under 0.8) the card takes the sheet's height and the button stands beside it; otherwise the card is
a little larger (500 px wide in the frame) with the button under it. The canvas, and so the saved
PNG, is unchanged (904 x 840). A fact's name steps down to 20 px at most, then "...". Save image was
pressed in the browser at both sizes: the mock backend received the PNG (about 88 kB) each time.

## Loading, empty, error

| Finding | Picture | Mark |
|---|---|---|
| While the chats are read, the placeholder was one short block that did not match the story (trail, sheet, Back / Next). | `wrapped-indexing/before-dark-1180x780.png` | FIX: a story-shaped placeholder |
| When the usage engine has failed, the red message was followed by a placeholder that never resolves, and had no "Try again" (Dashboard and Sessions have it). | `wrapped-error/before-dark-1180x780.png` | FIX |
| Empty ("Nothing to tell yet", topo backdrop). | `wrapped-empty/before-dark-1180x780.png` | LEAVE |

## The way in, and the splash

| Finding | Mark |
|---|---|
| There is no first-launch Christmas intro into Wrapped in the code: `src/lib/intro.ts` is only the main window's half of the launch splash. The only way in is the gift button in the title bar. | SUGGEST (Phase 7) |
| `splash.html` in a plain browser draws nothing (12 frames over 2.5 s were all blank): the animation is started and handed off by the Rust side. Not seen in this pass. | LEAVE, not verified |

## Suggestions for Will (not built)

1. A first-launch (or Christmas morning) invitation into Wrapped: the gift button is easy to miss.
2. `modelLabel` in `src/lib/usage.ts` could name the model inside a provider id everywhere, as the
   story now does.
3. The story could use the sheet's whole height at a small window by scaling the centred slides on
   their own, not the whole 1008 x 625 frame; bigger change than polish.

## After

Every stop has `after-<theme>-<size>.png` at 900 x 600 and 1180 x 780 in Dark and Light, plus
`after-dark-900x600-expanded.png` for all 15 slides and `after-dark-900x600-expanded-stress.png` for
the name slides and the card. Silver (1600 x 1000 and 900 x 600, sidebar open), reduced motion and
two more sets of awkward names (CJK, spaced, a known model id with a date) were run as audits with
no pictures: every slide is checked for a figure, line or graphic outside the sheet, a figure over
its graphic, and a kicker under 12 px on screen.
