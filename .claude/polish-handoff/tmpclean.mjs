// Temp hygiene for the headless-Chrome scripts here (shoot.mjs, record.mjs).
// Each run makes a throwaway Chrome profile (~230 MB) under the Windows Temp folder.
// 537 of them once filled 60 GB. Rule: a run removes its own profile when it ends, and
// anything it left behind from an earlier crash is trimmed to the newest KEEP folders.
// Deletes one file at a time, then the empty folders: recursive deletes are blocked on this PC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP = 3;

/** Remove a folder tree file by file, deepest folders last. Never throws. Returns true when gone. */
export function removeTree(dir) {
  const folders = [dir];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { folders.push(p); stack.push(p); }
      else { try { fs.unlinkSync(p); } catch { /* locked: retried by the caller */ } }
    }
  }
  for (const f of folders.reverse()) { try { fs.rmdirSync(f); } catch { /* not empty yet */ } }
  return !fs.existsSync(dir);
}

/** After chrome.kill(): wait for the process to exit, then delete the profile (Chrome's helpers release locks a moment later). */
export async function dropProfile(chrome, profile) {
  if (chrome && chrome.exitCode === null) {
    await new Promise((res) => { chrome.once("exit", res); setTimeout(res, 3000); });
  }
  for (let i = 0; i < 10; i++) {
    if (removeTree(profile)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.error(`profile not fully removed (a file is still locked): ${profile}`);
  return false;
}

/** Trim leftovers of earlier crashed runs: keep only the newest KEEP folders that start with prefix. */
export function pruneOld(prefix, keep = KEEP) {
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp).filter((n) => n.startsWith(prefix)); } catch { return; }
  const dated = names
    .map((n) => { try { return { p: path.join(tmp, n), t: fs.statSync(path.join(tmp, n)).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t);
  // Skip anything touched in the last 10 minutes: another run may be using it right now.
  for (const d of dated.slice(keep)) if (Date.now() - d.t > 10 * 60 * 1000) removeTree(d.p);
}
