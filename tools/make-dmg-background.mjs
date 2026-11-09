// The picture behind the Atlas disk image window (macOS): the Trail Map look. Cream paper, the
// same contour lines as the app (src/lib/topo.ts), a dashed clay trail from the app to the
// Applications folder with the summit spark at its end, and one plain line of instruction.
//
//   npm install --no-save playwright@1.64.1 && npx playwright install webkit   (Windows: uses Edge)
//   node tools/make-dmg-background.mjs
//
// Writes crates/app/icons/dmg-background.png: 1320x800 pixels marked 144 dpi, so Finder shows it
// at the window's 660x400 points and sharp on a Retina screen. The icon spots match
// bundle.macOS.dmg in crates/app/tauri.macos.conf.json (app 180,170; Applications 480,170).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium, webkit } from "playwright";
import { contourPath } from "../src/lib/topo.ts";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "crates", "app", "icons", "dmg-background.png");
const W = 660;
const H = 400;
const font = path.join(root, "node_modules", "@fontsource-variable", "recursive", "files", "recursive-latin-casl-normal.woff2");
const fontUrl = fs.existsSync(font) ? `data:font/woff2;base64,${fs.readFileSync(font).toString("base64")}` : null;
const topo = contourPath({ width: W, height: H, seed: 11, levels: 12 });

const html = `<!doctype html><html><head><style>
${fontUrl ? `@font-face { font-family: "Recursive"; src: url(${fontUrl}) format("woff2"); font-weight: 300 1000; }` : ""}
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #FAF8F5; }
.t { position: absolute; left: 0; right: 0; top: 300px; text-align: center; font-family: "Recursive", sans-serif;
     font-variation-settings: "CASL" 0.4; font-weight: 640; font-size: 17px; letter-spacing: 0.01em; color: #6B655C; }
</style></head><body>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;inset:0">
  <defs>
    <radialGradient id="g" cx="50%" cy="44%" r="70%">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.15"/>
    </radialGradient>
    <mask id="m"><rect width="${W}" height="${H}" fill="url(#g)"/></mask>
  </defs>
  <path d="${topo}" mask="url(#m)" fill="none" stroke="#C96442" stroke-opacity="0.2" stroke-width="1" stroke-linecap="round"/>
  <path d="M262 176 C 318 132, 362 132, 404 166" fill="none" stroke="#C96442" stroke-width="3"
        stroke-linecap="round" stroke-dasharray="1 9"/>
  <path d="M402.7 156.4 L406 168 L394 167.2" fill="none" stroke="#C96442" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
<div class="t">Drag Atlas into Applications</div>
</body></html>`;

// WebKit on macOS draws it like Finder would. Playwright's Windows WebKit ignores variable-font axes
// (every weight comes out as the thin default), so on Windows the installed Edge draws it instead.
const browser = process.platform === "win32" ? await chromium.launch({ channel: "msedge" }) : await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: "png" });
await browser.close();

/** Marks the PNG as 144 dpi (a pHYs chunk right after IHDR), so 2x pixels show at 1x points. */
function withDpi(buf, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data.writeUInt8(1, 8);
  const type = Buffer.from("pHYs");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(9);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([buf.subarray(0, ihdrEnd), len, type, data, crc, buf.subarray(ihdrEnd)]);
}

fs.writeFileSync(out, withDpi(png, 144));
console.log(`wrote ${path.relative(root, out)} (${W * 2}x${H * 2} px at 144 dpi)`);
