# Launcher signature check

The skill's launchers (`skill/skills/atlas/bin/atlas-usage.sh` and `.ps1`) download atlas-usage from the GitHub release when no good copy is on the computer. The pinned SHA-256 in `checksums.txt` is the trust root. A download that doesn't match its pin is deleted and never runs, and nothing the release says can change that.

The signature check only adds a second gate. On a fresh download the launcher also fetches `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` from the same tag, with the same retries and the same route (curl, then gh). It then checks three things:

1. The `.sig` is a minisign "ED" signature (Ed25519 over the file's BLAKE2b-512) by the Atlas update key, the same key `crates/app/tauri.conf.json` embeds. The key id must match.
2. The trusted-comment signature (over signature + comment) is valid too. This logic is copied from `tools/verify-minisign.mjs`.
3. The list names the asset, and every line for it carries the pinned hash.

If any step fails, the download is deleted, the program does not run, and the launcher prints one line with the fix: try again later, or update the plugin. A missing list or `.sig` counts as a failed download, so the launcher falls back to an older saved copy or exits 3.

Verifiers: the `.ps1` compiles a small C# Ed25519 + BLAKE2b-512 verifier with Add-Type, so it works on PowerShell 5.1 and 7 with nothing installed. The `.sh` uses openssl 1.1.1 or later (`dgst -blake2b512`, `pkeyutl -verify -rawin`). Before trusting openssl it runs a known-answer test against a fixed key and signature, so a broken or LibreSSL openssl counts as no verifier.

With no verifier, the launcher runs on the pin alone and says nothing at run time. `launcher-doctor` reports it. Each saved copy gets a `signature` file next to it with `checked` or `unchecked`, and doctor shows it.

Test key: `ATLAS_USAGE_TEST_PUBKEY` replaces the embedded key only while `ATLAS_USAGE_TEST_SOURCE` points to a local folder or a loopback http URL. That is safe for three reasons. The stand-in release is already local and chosen by whoever sets the environment. The pin still applies. Anyone who can set those variables can already point `ATLAS_USAGE_BIN` at any program. The real GitHub route always uses the embedded key.

Proof: the tests sign their stand-in release with a throwaway key made at test time (`tests/launcher/sign-minisign.mjs`). The real v0.1.8 `SHA256SUMS.txt` and `.sig` are accepted, and a one-byte change to either is rejected, under sh/openssl, PowerShell 5.1, pwsh 7 and node.
