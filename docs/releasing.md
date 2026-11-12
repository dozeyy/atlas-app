# Releasing Atlas

## One-time setup
- Update signing key: `C:\Users\Will\.tauri\atlas-updater.key` (outside every repo, no password). Its public half is in `crates/app/tauri.conf.json` (`plugins.updater.pubkey`). Lose the private key and installed copies can never update again: back it up.
- The signing key is a secret of a GitHub **Environment** named `release`, never a repository secret: a branch with an edited workflow can read repository secrets, but the environment only hands its secrets to runs on a `v*` tag. Run once, from any folder (PowerShell; `dozeyy/atlas-app` is this private source repository):
  1. Make the environment, limited to tags named `v*`:
     ```
     '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/dozeyy/atlas-app/environments/release --input -
     gh api -X POST repos/dozeyy/atlas-app/environments/release/deployment-branch-policies -f name='v*' -f type=tag
     ```
  2. Put the key in it (the password is empty):
     ```
     gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo dozeyy/atlas-app < C:\Users\Will\.tauri\atlas-updater.key
     gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo dozeyy/atlas-app --body ""
     ```
     If `gh` refuses the empty password, leave that secret out: the workflow reads a missing one as empty.
  3. Remove the old repository-level copies (they are what a branch could read), if they were ever set:
     ```
     gh secret delete TAURI_SIGNING_PRIVATE_KEY --repo dozeyy/atlas-app
     gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo dozeyy/atlas-app
     ```
  4. Not available on the free plan (GitHub answers 422 for required reviewers on a private repo, tried 2026-11-09; it needs a paid plan, so it is skipped: the key still only reaches runs on a `v*` tag). If the plan changes: ask for your approval before each release job starts. Get your id with `gh api user --jq .id`, then `'{"reviewers":[{"type":"User","id":<id>}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/dozeyy/atlas-app/environments/release --input -` (the same PUT again; it keeps the tag rule).
  5. Check: `gh api repos/dozeyy/atlas-app/environments/release --jq '.deployment_branch_policy'` and `gh api repos/dozeyy/atlas-app/environments/release/deployment-branch-policies --jq '.branch_policies[] | [.name,.type]'` should show `v*` / `tag`; `gh secret list --env release --repo dozeyy/atlas-app` shows the key.
- Update address: `https://github.com/dozeyy/atlas/releases/latest/download/latest.json`, built from the one constant `REPO` in `crates/app/src/update.rs` (change it there if the repository moves). It is the PUBLIC repo, so installed copies of any user can reach it; this source repo (`dozeyy/atlas-app`) is private.
- Publishing to the public repo needs no secret in GitHub: `tools/publish-public.ps1` runs on your PC with the `gh` sign-in you already have (check with `gh auth status`; it needs push access to `dozeyy/atlas`). Nothing else to set up.

## Two repositories
- `dozeyy/atlas-app` (private): the source, this workflow and its secrets. Tags `vX.Y.Z` are cut here. CI builds, signs and pins, then makes the release **here** as a prerelease titled "Atlas X.Y.Z (staging)", with the default job token. The staging release is never "latest" and nothing public points at it.
- `dozeyy/atlas` (public; local folder `Documents\Desktop Apps\Atlas-public`): the Releases (installers, `latest.json`, the six `atlas-usage-*` files, `SHA256SUMS.txt`), the plugin marketplace (`.claude-plugin/marketplace.json` and `skill/`), and the README and `docs/` people read. No source code, secrets or personal data ever goes there. The workflow never writes to it.
- The README and `docs/` in the public repo are edited by hand there (push to its `main`). Never edit `skill/` there: the next publish overwrites it from this repo. Edit `skill/` here.
- Trust model: the launcher downloads `atlas-usage-*` (for its own OS and CPU) from the release tagged `v<plugin version>` and runs it only if its SHA-256 equals the line pinned in the plugin's own `checksums.txt`. The publish script re-checks exactly that before anything goes public.

## Publish to the public repo (after the workflow finishes)
1. Wait for the release workflow to go green. The pin step (`Pin skill checksums for vX.Y.Z`, pushed to `main`) runs **before** the staging release is made, and a failed pin fails the job, so a green run means the pin is on `main` and the staging prerelease exists.
2. From the repo root, on your PC (needs `gh` signed in, `git`, `tar` and `node`):
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-public.ps1 -Version X.Y.Z -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-public.ps1 -Version X.Y.Z
   ```
   `-DryRun` does the download, every check and the read of the public repo for real, and only says what the write steps (create or fix the draft, clone, publish, push) would do. It changes nothing in either repo.
3. Trust: the staging release is only a transport, so nothing in it is believed on its own. CI signs `SHA256SUMS.txt` with the update key (`SHA256SUMS.txt.sig`); the script checks that with real Ed25519 (`tools/verify-minisign.mjs`, Node's own crypto) against the public key in `crates/app/tauri.conf.json` **on `origin/main`**, so replacing a file in the staging release cannot get past it without the private key. The second anchor is the six `atlas-usage-*` hashes pinned in the plugin's `checksums.txt` on `main`.
4. What the script does, in order: downloads the staging assets; reads `skill/`, `marketplace.json` and `tauri.conf.json` as committed on `origin/main` (never your working tree); then **refuses on any mismatch** of:
   - a required asset (15 files) missing or empty, or an unexpected file present;
   - the signature on `SHA256SUMS.txt`, then every file (installers, dmg, bundles, `.sig` files, `latest.json`, `atlas-usage-*`) against that signed list;
   - the six `atlas-usage-*` hashes against the pinned lines in `checksums.txt`;
   - each update bundle against its `.sig` (a bundle signed with a CI throwaway key or any other key fails);
   - `latest.json`: version, the four platform entries, each URL equal to `https://github.com/dozeyy/atlas/releases/download/vX.Y.Z/<file>`, each signature equal to its `.sig` file.
   Then it reads the public `vX.Y.Z` release and compares each asset there by state, size and sha256. A **draft** with a stale or unexpected asset gets it deleted and re-uploaded; a **published** release holding anything that is not the verified file makes the script stop (see Roll back). Next it creates the draft (or reuses it), uploads what is missing, clones `dozeyy/atlas` `main` fresh, replaces `skill/` and `.claude-plugin/marketplace.json`, adds the `CHANGELOG.md` entry after the first `<!-- releases -->` line (stopping if that line is missing), and commits locally. Then it **publishes the release, then pushes the plugin commit**: `latest.json` and the plugin never point at assets that are not there yet. The release notes are the ones inside `latest.json` (the notes in `docs/release-notes/X.Y.Z.md` at build time), so the release page, the update tooltip and the changelog agree.
5. The public tag points at `main` as it was when the release was published, which is just before the plugin commit lands, so browsing the tag on GitHub shows the previous `skill/`. Downloads are not affected (they use the release assets); the current plugin is always on `main`.
6. Rerun is safe: it does the plugin sync on every run, also when the release is already published, so a push that failed after publishing is finished by rerunning. A complete published release plus an up-to-date plugin changes nothing.
7. If it refuses, nothing was published (or, for a failed push, only the release is public and the message says to rerun); fix the cause and rerun.
8. The script prints no secrets, handles none, and opens no windows beyond its own console. It leaves no files behind (the temp folder is removed).
8. Test hooks, for trying the script without a real release: `-AssetsDir <folder>` and `-SourceTree <folder>` replace the download and the `origin/main` read; `-CloneUrl` clones the plugin repo from somewhere else.

## Roll back a published release
The script never edits a published release's files. If one was published wrong:
1. `gh release edit vX.Y.Z --repo dozeyy/atlas --draft` turns it back into a draft (installed apps stop seeing it; `latest.json` is no longer served).
2. Fix the cause (a bad pin, a rebuilt asset), re-run only the failed Publish job of that tag's run (not "Re-run all jobs": a rebuild makes new bytes, and the pin step stops on "pinned with other hashes") so the staging copy is correct, or simply delete the wrong asset: `gh release delete-asset vX.Y.Z <file> --repo dozeyy/atlas -y`.
3. Run `tools/publish-public.ps1 -Version X.Y.Z` again: it replaces the stale assets of the draft with the verified ones and publishes it.
4. A plugin commit that was already pushed is fixed the same way: edit `skill/` here, merge, and rerun the script (it syncs `skill/` every time). `git revert` on the public repo's `main` also works if the plugin itself must go back right now.
To pull a version entirely, delete the release (`gh release delete vX.Y.Z --repo dozeyy/atlas --yes`) and leave the tag; installed apps simply see no update.

## Cut a release
1. Set the same version in `crates/app/tauri.conf.json`, `crates/app/Cargo.toml` (and the workspace crates) and `skill/.claude-plugin/plugin.json`. The workflow refuses a tag that disagrees with either file.
2. Optional: put the release notes in `docs/release-notes/X.Y.Z.md` (plain sentences; it becomes the tooltip text on the update icon). Each version has its own file, so an older release's notes never carry over; without a file for this version the notes read "Atlas X.Y.Z".
3. `git tag vX.Y.Z` on a commit that is on `main`, and push the tag. `.github/workflows/release.yml` builds Windows, macOS and the command-line tool, then makes the staging prerelease in this repo and pins the skill checksums on `main`. Then run `tools/publish-public.ps1` (section above) to publish it to `dozeyy/atlas`.

## Who gets the signing key, and what publishes
The `gate` job in `release.yml` decides once whether a run is official: a push of a `v*` tag whose commit is in `main`'s history. Only then does the Publish job run. The Windows and macOS jobs never see a secret: they always sign with a throwaway update key made on the runner. The Publish job is the only one in the `release` environment; it signs the two update bundles (`Atlas_X.Y.Z_x64-setup.exe`, `Atlas.app.tar.gz`) again with the real key, replacing the throwaway `.sig` files, before it writes `latest.json`. A manual run (`workflow_dispatch`) on any branch, or a tag cut from a branch, still builds everything and publishes nothing, and a branch workflow cannot read the key because the environment accepts only `v*` tags.
## When the checksums are not pinned
The pin step writes to `main`, so it checks first. Since nothing is staged before it succeeds, a failed check **fails the job** (no staging release, nothing to publish) instead of warning:
- the tagged commit is not in `main`'s history (the gate already refuses to publish such a tag; this is a second check);
- `main`'s `plugin.json` is not at this version any more;
- a newer version than this one is already in `checksums.txt`.

It always runs `tools/pin-skill-checksums.ps1` as it is on `main` (never the tag's copy) and never with `-Force`: a version already pinned with other hashes stops the step with an error. The step is safe to rerun (the same hashes change nothing), and so is the staging step after it (it replaces the files of an existing staging release). To recover, fix the cause (merge the release commit, set the plugin version) and rerun the failed workflow run, or pin by hand with the same script and push.

## What a release holds
`Atlas-Setup-Windows-x64.exe`, `Atlas-macOS.dmg`, `atlas-usage-windows-x64.exe`, `atlas-usage-macos-universal`, `atlas-usage-linux-x64`, `atlas-usage-linux-arm64`, `atlas-usage-linux-x64-musl` (static, for Alpine and Docker), `atlas-usage-windows-arm64.exe`, `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` (the list, signed with the update key), `latest.json`, plus the update bundles with their `.sig` files (`Atlas_X.Y.Z_x64-setup.exe`, `Atlas.app.tar.gz`). The MSI is not published. Nothing is code signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first run.

## Build Atlas Setup locally
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-setup.ps1` builds everything and prints the path (`target\release\bundle\setup\Atlas-Setup-Windows-x64.exe`). It signs the update bundle when the key file above exists (on a release the workflow runs it with a throwaway key and signs the real bundles later, in the Publish job).

## Test an update on this machine
Build 0.1.0 with `-DevUpdate`, install it into a scratch folder, build 0.1.1 with `-DevUpdate -VersionOverride 0.1.1`, serve a `latest.json` plus the 0.1.1 installer from a loopback http server and start Atlas with `ATLAS_UPDATE_URL=http://127.0.0.1:<port>/latest.json`. Only builds made with the `dev-update` feature (and debug builds) read that variable; release builds ignore it.
