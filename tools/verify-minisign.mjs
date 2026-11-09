// Verifies a Tauri / minisign signature with Node's own crypto (no packages).
//   node tools/verify-minisign.mjs <public key (base64, as in tauri.conf.json)> <file> <signature file>
// Exit 0 and prints "ok" only when the Ed25519 signature is valid for exactly this file and was made
// by the key in the public key. Both minisign forms are handled: "Ed" (signs the file) and "ED"
// (signs the file's BLAKE2b-512 hash, what Tauri writes). The trusted-comment signature is checked
// too. Used by tools/publish-public.ps1; it reads three arguments and writes nothing.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

function fail(msg) {
  console.error("verify-minisign: " + msg);
  process.exit(1);
}

const [pubArg, filePath, sigPath] = process.argv.slice(2);
if (!pubArg || !filePath || !sigPath) fail("usage: <public key> <file> <signature file>");

function lines(b64) {
  return Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);
}

let key, keyId;
try {
  const raw = Buffer.from(lines(pubArg)[1].trim(), "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") fail("the public key is not a minisign Ed25519 key");
  keyId = raw.subarray(2, 10);
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  key = createPublicKey({ key: Buffer.concat([spkiPrefix, raw.subarray(10, 42)]), format: "der", type: "spki" });
} catch (e) {
  fail("cannot read the public key: " + e.message);
}

let sigLines, sig;
try {
  sigLines = lines(readFileSync(sigPath, "utf8"));
  sig = Buffer.from(sigLines[1].trim(), "base64");
} catch (e) {
  fail("cannot read the signature file: " + e.message);
}
if (sig.length !== 74) fail("the signature has the wrong length");
const alg = sig.toString("latin1", 0, 2);
if (alg !== "Ed" && alg !== "ED") fail("unknown signature algorithm");
if (!sig.subarray(2, 10).equals(keyId)) fail("the signature was made by a different key");

const data = readFileSync(filePath);
const signed = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
if (!verify(null, signed, key, sig.subarray(10, 74))) fail("the signature does not match this file");

// the trusted comment is signed over (signature + comment)
const tc = sigLines[2] || "";
const prefix = "trusted comment: ";
if (!tc.startsWith(prefix)) fail("no trusted comment");
let global;
try {
  global = Buffer.from((sigLines[3] || "").trim(), "base64");
} catch {
  fail("bad global signature");
}
if (global.length !== 64) fail("the global signature has the wrong length");
const gmsg = Buffer.concat([sig.subarray(10, 74), Buffer.from(tc.slice(prefix.length), "utf8")]);
if (!verify(null, gmsg, key, global)) fail("the trusted comment signature is not valid");

console.log("ok");
