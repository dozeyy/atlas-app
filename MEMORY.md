# Atlas - Memory Log

Append-only. Log real outcomes, decisions, and completed work only. Never rewrite
past entries. Timestamp every entry (YYYY-MM-DD). Newest at the bottom: append to
the end (the known-fix-lookup hook reads the tail; later entries win).

## 2026-11-08 - init
- Initialized from the global setup (~/.claude/templates). Idea: a premium Tauri 2 +
  Rust + React companion app for Claude Code (usage/cost dashboard, Setup manager, own
  MCP server, in-app assistant with diff approval, Wrapped, tray), a Christmas gift for
  Will's dad on macOS + Windows. Spec saved verbatim as BUILD-PROMPT.md (written as
  "Basecamp"; the app is Atlas). Generated ./CLAUDE.md with the roadmap (spec phases
  0-8) and a Design Identity (warm neutrals + terracotta; icon motif OPEN).
- Bootstrapped by a dispatched agent while Will was on Remote Control; no init
  interview (the spec answers it); open questions relayed through the main session.

## 2026-11-08 - Phase 0 recon (read-only on the real config)
- Findings and architecture in docs/phase0-recon.md. Headlines: transcripts dedup by
  message.id+requestId but must keep the LAST line per key (only output_tokens grows
  across the duplicate lines; first-seen undercounts); 80 % of transcripts are
  subagent files under <session>/subagents/; per-project "local" MCP servers live in
  ~/.claude.json projects[path].mcpServers; MCP on/off is per project
  (disabledMcpServers), hooks have no per-hook enabled flag; transcripts are swept
  after cleanupPeriodDays (default 30); with CLAUDE_CONFIG_DIR set, .claude.json moves
  inside it. Toolchain on Windows complete (Rust 1.97.1, Node 24.18, tauri-cli 2.11.4,
  VS Build Tools 2022, WebView2); no macOS target or Mac locally.
- Phase 1 waits for Will's OK.

## 2026-11-08 - Phase 1 foundation
- Built: Cargo workspace (core/app/mcp stub), Tauri 2 shell, React 19 + Tailwind 4 + Radix
  frontend, 6-page sidebar, tokens (one file, contrast-tested), System/Light/Dark switch,
  Mica/vibrancy config, fixtures, `--config-dir`, Sandbox Mode, CI matrix. Will chose the
  icon mid-phase (assets/brand/) and kept the terracotta accent.
- Root causes found by tests: proposal colors failed AA (warning, accent text on the nav
  wash) and danger sat 10 degrees from terracotta in hue, so danger moved to raspberry;
  Windows canonicalize leaked a verbatim path prefix into the sandbox path shown in the UI
  (stripped at the source); first-paint ms was unset in the boot payload (the app now emits
  it after first paint). Once, a launch right after killing another instance opened no
  window (harness timing; not reproduced with a 3 s gap).
- Measured (debug build, Windows 11): 370-470 ms to first paint; Sandbox of the real
  ~/.claude = 2468 files in 4.3 s on a background thread, real files untouched.

- CI: first run failed on macOS only: std::path::absolute keeps ".." on Unix, so the real-config write guard missed home/x/../.claude/a when x did not exist (guard hole, fixed in comparable()). Second run green on both OS (run 42498855503). macOS runtime (launch, vibrancy, traffic lights) still unverified: no Mac.

## 2026-11-08 - Launch intro (branch launch-intro)
- Built: transparent splash window over the main window's rect (DWM extended frame bounds, corner radius 8 on Win11), burst + simultaneous fill + swirl + boom + flat clay, clay halves slide apart while the app lands from scale .96 (transform only, no crossfade). Skip on click/key, reduced motion = 150 ms fade, Settings toggle "Launch animation", `tauri-plugin-single-instance` (second launch focuses/restores, no intro).
- Mark trace: potracer traces the FALSE cells (inverted) and the mark touches the canvas edge, so the bitmap is inverted and padded 32 px; 4x-supersampled overlay mismatch 678 px = 0.198% of the mark.
- Root causes found: window-state restored/saved the splash too (denylist it); the 1 us ffmpeg timebase made `-t` end the capture instantly (use absolute `-to` with `-copyts`) and made decode duplicate to 30000 fps (11 GB raw: decode with `-fps_mode passthrough`); never pipe the capture script into another command (atlas.exe inherits the pipe and hangs it); rAF runs ~480 Hz on this 500 Hz display so "frames over 20 ms" is a weak test here (worst 10 ms).
- Measured (release build, Windows 11, real screen capture): splash window shown 605 ms after launch, first logo pixels 694 ms, first logo pixel to settled app 2.03 s, clay screen 1.54 s after first logo pixel; 0 rAF frames over 20 ms in every run since the fixes, worst frame 10.0 to 18.1 ms (one early debug run had a 29.8 ms frame). Cost split (log): 180 ms process + Tauri init, 316 ms first WebView2 window (the floor for a WebView splash), 45 ms page, ~60 ms waiting for the main rect, ~90 ms show to first pixels. The ~200 ms first-frame target is NOT met; a native-painted first frame would be the next step.
- Not verified: macOS (config only), real reduced-motion OS setting (forced with ATLAS_REDUCE_MOTION=1), Mica look after handoff beyond the capture frames.

## 2026-11-08 - Launch intro v3: spin trails, ripple, circular wipe (branch launch-intro)
- Supersedes the swirl / boom / sliding-halves animation above (kept burst + fill exactly). Will: "as soon as the logo starts to spin, it should leave behind a trail of orange ... turn the entire thing into an orange circle ... in a gradient way ... expand the circle in a ripple effect"; then "I don't want it to slideshow open with curtains ... undo that circle ... wipe it away into the UI".
- Design: 28 time-lagged copies of the solid mark at alpha 0.12 give the trail (dense at the arm, thin at the tail; they close the 72 degree gaps as the spin speeds up); a solid disc fades in under them and a lighter copy of the mark keeps the spin readable; 4 nested feathered discs in distinct clay tones scale out from the disc rim, the top one is flat clay; then the hole: one canvas, radial gradient with a 30 px feather and a lighter ring, curve = the ripple's bezier reversed (`EASE_WIPE`), app lands from 0.98. Everything else is WAAPI transform/opacity. Total designed 2.23 s.
- Root causes: (1) the splash page loaded at a 480x320 placeholder, so the mark was laid out for the wrong size (logo top-left): `splash_ready` now returns the physical size and the page waits for the viewport before `build()`. (2) rAF hitches of 22-40 ms came from the first raster of layers that were invisible (opacity 0 / scale 0) until the timeline reached them: fixed by painting every layer for 3 frames at 1 % stage opacity before the timeline starts; what is left is the gap between the first two frames (nothing visible moves yet), reported apart as `start gap`. (3) taskkill by image name kills other agents' atlas.exe: the tools now kill only their own exe path. (4) ffmpeg `fps=` filter after `select` stretched the clip (203 frames for 2.5 s): resample with output `-r 60 -fps_mode cfr` instead.
- Measured (release build, Windows 11, real capture, other agents building in the background): splash shown 233-277 ms after launch, first logo pixels 402 ms after launch, first logo to flat clay 1.59 s, to settled 2.12 s, intro done 2.43-2.48 s after launch (splash run 2.17 s first frame to done); rAF over 10 plain runs + 1 recorded run: 0 frames over 20 ms, worst 6.0-12.0 ms (frames 1040-1075), start gap 2-32 ms. Display is ~500 Hz so rAF is ~480 Hz: the 20 ms test is weak here but is the stated rule. Reduced motion: clay at 402 ms, done 583 ms. Skip at 1.1 s lands on the app. Second launch exits code 0 in ~100 ms, one process stays, no second intro.
- Evidence: `docs/shots/intro/` (18 frames + contact sheet, `intro.mp4` 60 fps 1342x972, `timing.txt`).
- Not verified: macOS (config only), real OS reduced-motion setting (forced with ATLAS_REDUCE_MOTION=1), the ~200 ms first-frame target (WebView2 window creation is the floor; first logo pixels land ~400 ms after launch), a user's own wallpaper other than the black one used here.
