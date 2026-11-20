/* global document */
// Renders Hearth's installable-app icons, favicon, and header mark (PNG) from the brand artwork
// in docs/brand/hearth-logo-source.png, and a trimmed copy of the full logo for the sign-in and
// welcome pages. Run: node scripts/render-icons.mjs   (uses the Playwright browser installed
// for tests). The mark is cut from the artwork on its own dark background, and the cut's edges
// are faded into the tile so no square seam shows.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps", "web", "public");
const source = await readFile(path.join(root, "docs", "brand", "hearth-logo-source.png"));
const dataUrl = `data:image/png;base64,${source.toString("base64")}`;

// Where the mark sits in the 2170 x 725 artwork: a 640 px square with room for its glow.
const MARK = { x: 157, y: 25, size: 640 };
// The full logo, trimmed to the artwork's content.
const LOGO = { x: 150, y: 40, w: 1880, h: 650 };
const TILE = "#08090b"; // the artwork's own background

const icons = [
  // file, size, mark scale, corner radius (share of size; 0 = square, full bleed)
  { file: "icon-192.png", size: 192, scale: 1, radius: 0.22 },
  { file: "icon-512.png", size: 512, scale: 1, radius: 0.22 },
  // Maskable: the platform crops to a circle or squircle, so the mark sits in the safe zone.
  { file: "icon-maskable-512.png", size: 512, scale: 0.78, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, scale: 1, radius: 0 },
  { file: "favicon.png", size: 64, scale: 1.08, radius: 0.2 },
  { file: "brand/hearth-mark.png", size: 160, scale: 1.04, radius: 0.24 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<img id="art" src="${dataUrl}">`);
await page.waitForFunction(() => document.getElementById("art").complete);

for (const icon of icons) {
  const png = await page.evaluate(
    ({ icon, MARK, TILE }) => {
      const img = document.getElementById("art");
      const { size, scale, radius } = icon;
      // The mark, with its edges faded so it melts into the tile.
      const n = MARK.size;
      const cut = document.createElement("canvas");
      cut.width = cut.height = n;
      const c = cut.getContext("2d");
      c.drawImage(img, MARK.x, MARK.y, n, n, 0, 0, n, n);
      const fade = document.createElement("canvas");
      fade.width = fade.height = n;
      const f = fade.getContext("2d");
      f.filter = `blur(${n * 0.06}px)`;
      f.beginPath();
      f.roundRect(n * 0.1, n * 0.1, n * 0.8, n * 0.8, n * 0.25);
      f.fill();
      c.globalCompositeOperation = "destination-in";
      c.drawImage(fade, 0, 0);
      // The tile.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      if (radius) ctx.roundRect(0, 0, size, size, size * radius);
      else ctx.rect(0, 0, size, size);
      ctx.clip();
      ctx.fillStyle = TILE;
      ctx.fillRect(0, 0, size, size);
      const s = size * scale;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cut, (size - s) / 2, (size - s) / 2, s, s);
      return canvas.toDataURL("image/png");
    },
    { icon, MARK, TILE },
  );
  const { writeFile, mkdir } = await import("node:fs/promises");
  const file = path.join(out, icon.file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(png.split(",")[1], "base64"));
  console.log(icon.file);
}

// Ember's default picture: the owner's approved flame (docs/brand/ember-flame-source.png, a
// transparent PNG), centred on the Midnight background so it reads the same in any circle.
const flame = await readFile(path.join(root, "docs", "brand", "ember-flame-source.png"));
await page.setContent(`<img id="flame" src="data:image/png;base64,${flame.toString("base64")}">`);
await page.waitForFunction(() => document.getElementById("flame").complete);
const ember = await page.evaluate(() => {
  const img = document.getElementById("flame");
  const n = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, n, n);
  // A little room around it, so the tips aren't clipped by a round frame.
  const s = n * 0.86;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (n - s) / 2, (n - s) / 2, s, s);
  return canvas.toDataURL("image/webp", 0.9);
});
{
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(out, "avatars", "ember.webp"),
    Buffer.from(ember.split(",")[1], "base64"),
  );
  console.log("avatars/ember.webp");
}
await page.setContent(`<img id="art" src="${dataUrl}">`);
await page.waitForFunction(() => document.getElementById("art").complete);

// The full logo for the sign-in and welcome pages.
const logo = await page.evaluate(
  ({ LOGO }) => {
    const img = document.getElementById("art");
    const canvas = document.createElement("canvas");
    canvas.width = LOGO.w;
    canvas.height = LOGO.h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, LOGO.x, LOGO.y, LOGO.w, LOGO.h, 0, 0, LOGO.w, LOGO.h);
    // Fade the edges to transparent, so the artwork's own dark background melts into any page.
    const fade = document.createElement("canvas");
    fade.width = LOGO.w;
    fade.height = LOGO.h;
    const f = fade.getContext("2d");
    const m = LOGO.h * 0.12;
    f.filter = `blur(${m * 0.6}px)`;
    f.fillRect(m, m, LOGO.w - 2 * m, LOGO.h - 2 * m);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(fade, 0, 0);
    return canvas.toDataURL("image/webp", 0.88);
  },
  { LOGO },
);
const { writeFile } = await import("node:fs/promises");
await writeFile(
  path.join(out, "brand", "hearth-logo.webp"),
  Buffer.from(logo.split(",")[1], "base64"),
);
console.log("brand/hearth-logo.webp");
await browser.close();
