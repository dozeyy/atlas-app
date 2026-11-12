// Test-only signer for the launcher tests: makes a throwaway Ed25519 key and signs files the way
// Tauri does ("ED" minisign form: Ed25519 over the file's BLAKE2b-512, plus the trusted-comment
// signature), with Node's own crypto. Never touches the real Atlas update key.
//   node sign-minisign.mjs keygen <dir>          writes <dir>/test.key, prints the public key
//                                                 in the tauri.conf.json form
//   node sign-minisign.mjs sign <dir> <file> [comment]   writes <file>.sig
//   node sign-minisign.mjs sums <dir> <folder>   writes <folder>/SHA256SUMS.txt for every other
//                                                 file there (sha256sum format) and signs it
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [cmd, dir, a, b] = process.argv.slice(2);
const b64 = (buf) => Buffer.from(buf).toString("base64");

function loadKey() {
  const key = createPrivateKey(readFileSync(join(dir, "test.key"), "utf8"));
  const id = readFileSync(join(dir, "test.id"));
  return { key, id };
}

function signFile(file, comment) {
  const { key, id } = loadKey();
  const hash = createHash("blake2b512").update(readFileSync(file)).digest();
  const sig = sign(null, hash, key);
  const tc = comment ?? `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(file)}`;
  const glob = sign(null, Buffer.concat([sig, Buffer.from(tc, "utf8")]), key);
  const text =
    "untrusted comment: signature from tauri secret key\n" +
    b64(Buffer.concat([Buffer.from("ED"), id, sig])) + "\n" +
    "trusted comment: " + tc + "\n" +
    b64(glob) + "\n";
  writeFileSync(file + ".sig", b64(Buffer.from(text, "utf8")));
}

if (cmd === "keygen") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  writeFileSync(join(dir, "test.key"), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(dir, "test.id"), id);
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const text =
    "untrusted comment: minisign public key: " + Buffer.from(id).reverse().toString("hex").toUpperCase() + "\n" +
    b64(Buffer.concat([Buffer.from("Ed"), id, raw])) + "\n";
  process.stdout.write(b64(Buffer.from(text, "utf8")));
} else if (cmd === "sign") {
  signFile(a, b);
} else if (cmd === "sums") {
  const names = readdirSync(a)
    .filter((n) => !n.startsWith("SHA256SUMS.txt") && statSync(join(a, n)).isFile())
    .sort();
  const lines = names.map((n) => createHash("sha256").update(readFileSync(join(a, n))).digest("hex") + "  " + n + "\n");
  writeFileSync(join(a, "SHA256SUMS.txt"), lines.join(""));
  signFile(join(a, "SHA256SUMS.txt"));
} else {
  console.error("usage: keygen <dir> | sign <dir> <file> [comment] | sums <dir> <folder>");
  process.exit(2);
}
