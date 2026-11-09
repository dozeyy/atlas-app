# Releasing Atlas

## One-time setup
- Update signing key: `C:\Users\Will\.tauri\atlas-updater.key` (outside every repo, no password). Its public half is in `crates/app/tauri.conf.json` (`plugins.updater.pubkey`). Lose the private key and installed copies can never update again: back it up.
- The signing key is a secret of a GitHub **Environment** named `release`, never a repository secret: a branch with an edited workflow can read repository secrets, but the environment only hands its secrets to runs on a `v*` tag. Run once, from any folder (PowerShell; `dozeyy/atlas` is the repository):
  1. Make the environment, limited to tags named `v*`:
     ```
     '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/dozeyy/atlas/environments/release --input -
     gh api -X POST repos/dozeyy/atlas/environments/release/deployment-branch-policies -f name='v*' -f type=tag
     ```
  2. Put the key in it (the password is empty):
     ```
     gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < C:\Users\Will\.tauri\atlas-updater.key
     gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --body ""
     ```
     If `gh` refuses the empty password, leave that secret out: the workflow reads a missing one as empty.
  3. Remove the old repository-level copies (they are what a branch could read), if they were ever set:
     ```
     gh secret delete TAURI_SIGNING_PRIVATE_KEY
     gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD
     ```
  4. Optional, recommended: also ask for your approval before each release job starts. Get your id with `gh api user --jq .id`, then `'{"reviewers":[{"type":"User","id":<id>}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/dozeyy/atlas/environments/release --input -` (the same PUT again; it keeps the tag rule).
  5. Check: `gh api repos/dozeyy/atlas/environments/release --jq '.deployment_branch_policy'` and `gh api repos/dozeyy/atlas/environments/release/deployment-branch-policies --jq '.branch_policies[] | [.name,.type]'` should show `v*` / `tag`; `gh secret list --env release` shows the key.
- Update address: `https://github.com/dozeyy/atlas/releases/latest/download/latest.json`, built from the one constant `REPO` in `crates/app/src/update.rs` (change it there if the repository moves). The repository must be public for installed copies to reach it.

## Cut a release
1. Set the same version in `crates/app/tauri.conf.json`, `crates/app/Cargo.toml` (and the workspace crates) and `skill/.claude-plugin/plugin.json`. The workflow refuses a tag that disagrees with either file.
2. Optional: put the release notes in `docs/release-notes/X.Y.Z.md` (plain sentences; it becomes the tooltip text on the update icon). Each version has its own file, so an older release's notes never carry over; without a file for this version the notes read "Atlas X.Y.Z".
3. `git tag vX.Y.Z` on a commit that is on `main`, and push the tag. `.github/workflows/release.yml` builds Windows, macOS and the command-line tool, then publishes the Release and pins the skill checksums on `main`.

## Who gets the signing key, and what publishes
The `gate` job in `release.yml` decides once whether a run is official: a push of a `v*` tag whose commit is in `main`'s history. Only then does the Publish job run. The Windows and macOS jobs never see a secret: they always sign with a throwaway update key made on the runner. The Publish job is the only one in the `release` environment; it signs the two update bundles (`Atlas_X.Y.Z_x64-setup.exe`, `Atlas.app.tar.gz`) again with the real key, replacing the throwaway `.sig` files, before it writes `latest.json`. A manual run (`workflow_dispatch`) on any branch, or a tag cut from a branch, still builds everything and publishes nothing, and a branch workflow cannot read the key because the environment accepts only `v*` tags.
## When the checksums are not pinned
The last step writes to `main`, so it checks first and, if a check fails, prints a warning and leaves `main` alone (the Release is already out and stays out):
- the tagged commit is not in `main`'s history (the gate already refuses to publish such a tag; this is a second check);
- `main`'s `plugin.json` is not at this version any more;
- a newer version than this one is already in `checksums.txt`.

It always runs `tools/pin-skill-checksums.ps1` as it is on `main` (never the tag's copy) and never with `-Force`: a version already pinned with other hashes stops the step with an error. Pin by hand with the same script if a warning left you without the pin.

## What a release holds
`Atlas-Setup-Windows-x64.exe`, `Atlas-macOS.dmg`, `atlas-usage-windows-x64.exe`, `atlas-usage-macos-universal`, `atlas-usage-linux-x64`, `SHA256SUMS.txt`, `latest.json`, plus the update bundles with their `.sig` files (`Atlas_X.Y.Z_x64-setup.exe`, `Atlas.app.tar.gz`). The MSI is not published. Nothing is code signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first run.

## Build Atlas Setup locally
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-setup.ps1` builds everything and prints the path (`target\release\bundle\setup\Atlas-Setup-Windows-x64.exe`). It signs the update bundle when the key file above exists (on a release the workflow runs it with a throwaway key and signs the real bundles later, in the Publish job).

## Test an update on this machine
Build 0.1.0 with `-DevUpdate`, install it into a scratch folder, build 0.1.1 with `-DevUpdate -VersionOverride 0.1.1`, serve a `latest.json` plus the 0.1.1 installer from a loopback http server and start Atlas with `ATLAS_UPDATE_URL=http://127.0.0.1:<port>/latest.json`. Only builds made with the `dev-update` feature (and debug builds) read that variable; release builds ignore it.
