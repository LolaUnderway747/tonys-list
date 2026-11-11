// Copies the fonts and Sortable out of node_modules into app/vendor so the PWA serves them itself (no CDN, works offline).
import { cpSync, mkdirSync, existsSync } from "node:fs";
const out = "app/vendor/fonts"; mkdirSync(out, { recursive: true });
const fonts = [
  ["bungee", [400]], ["barlow-semi-condensed", [400, 500, 600, 700]], ["share-tech-mono", [400]]
];
for (const [slug, weights] of fonts) for (const w of weights) {
  const f = `${slug}-latin-${w}-normal.woff2`, src = `node_modules/@fontsource/${slug}/files/${f}`;
  if (!existsSync(src)) throw new Error("Missing font file: " + src);
  cpSync(src, `${out}/${f}`);
}
cpSync("node_modules/sortablejs/Sortable.min.js", "app/vendor/Sortable.min.js");
console.log("vendor files copied");
