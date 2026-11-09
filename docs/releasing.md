# Releasing Atlas

## One-time setup
- Update signing key: `C:\Users\Will\.tauri\atlas-updater.key` (outside every repo, no password). Its public half is in `crates/app/tauri.conf.json` (`plugins.updater.pubkey`). Lose the private key and installed copies can never update again: back it up.
- Repository secrets (run once, from any folder):
  - `gh secret set TAURI_SIGNING_PRIVATE_KEY < C:\Users\Will\.tauri\atlas-updater.key`
  - `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""`
- Update address: `https://github.com/dozeyy/atlas/releases/latest/download/latest.json`, built from the one constant `REPO` in `crates/app/src/update.rs` (change it there if the repository moves). The repository must be public for installed copies to reach it.

## Cut a release
1. Set the same version in `crates/app/tauri.conf.json`, `crates/app/Cargo.toml` (and the workspace crates) and `skill/.claude-plugin/plugin.json`. The workflow refuses a tag that disagrees with either file.
2. Optional: put the release notes in `docs/release-notes/X.Y.Z.md` (plain sentences; it becomes the tooltip text on the update icon). Each version has its own file, so an older release's notes never carry over; without a file for this version the notes read "Atlas X.Y.Z".
3. `git tag vX.Y.Z` on a commit that is on `main`, and push the tag. `.github/workflows/release.yml` builds Windows, macOS and the command-line tool, then publishes the Release and pins the skill checksums on `main`.

## When the checksums are not pinned
The last step writes to `main`, so it checks first and, if a check fails, prints a warning and leaves `main` alone (the Release is already out and stays out):
- the tagged commit is not in `main`'s history (a tag cut from a branch);
- `main`'s `plugin.json` is not at this version any more;
- a newer version than this one is already in `checksums.txt`.

It always runs `tools/pin-skill-checksums.ps1` as it is on `main` (never the tag's copy) and never with `-Force`: a version already pinned with other hashes stops the step with an error. Pin by hand with the same script if a warning left you without the pin.

## What a release holds
`Atlas-Setup-Windows-x64.exe`, `Atlas-macOS.dmg`, `atlas-usage-windows-x64.exe`, `atlas-usage-macos-universal`, `atlas-usage-linux-x64`, `SHA256SUMS.txt`, `latest.json`, plus the update bundles with their `.sig` files (`Atlas_X.Y.Z_x64-setup.exe`, `Atlas.app.tar.gz`). The MSI is not published. Nothing is code signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first run.

## Build Atlas Setup locally
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-setup.ps1` builds everything and prints the path (`target\release\bundle\setup\Atlas-Setup-Windows-x64.exe`). It signs the update bundle when the key file above exists.

## Test an update on this machine
Build 0.1.0 with `-DevUpdate`, install it into a scratch folder, build 0.1.1 with `-DevUpdate -VersionOverride 0.1.1`, serve a `latest.json` plus the 0.1.1 installer from a loopback http server and start Atlas with `ATLAS_UPDATE_URL=http://127.0.0.1:<port>/latest.json`. Only builds made with the `dev-update` feature (and debug builds) read that variable; release builds ignore it.
