import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readText(fileName) {
  return readFileSync(resolve(dist, fileName), "utf8");
}

const index = readText("index.html");
assert(!index.includes("__CSP_"), "The built index still contains a CSP placeholder.");
assert(index.includes("connect-src 'self'"), "The app CSP must limit connections to its origin.");
assert(index.includes("worker-src 'self'"), "The app CSP must allow only same-origin workers.");
assert(index.includes("object-src 'none'"), "The app CSP must disable embedded objects.");
assert(index.includes("form-action 'none'"), "The app CSP must disable form submissions.");

const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] ?? "";
for (const match of index.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  const hash = `'sha256-${createHash("sha256").update(match[1] ?? "", "utf8").digest("base64")}'`;
  assert(csp.includes(hash), `The CSP is missing the inline-script hash ${hash}.`);
}

const manifest = JSON.parse(readText("site.webmanifest"));
assert(manifest.display === "standalone", "The manifest must use standalone display mode.");
assert(manifest.start_url === "./" && manifest.scope === "./", "Manifest URLs must remain subpath-safe.");

for (const icon of manifest.icons) {
  const iconPath = icon.src.replace(/^\.\//, "");
  assert(existsSync(resolve(dist, iconPath)), `Manifest icon is missing: ${iconPath}`);
}

for (const [fileName, expectedSize] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
]) {
  const png = readFileSync(resolve(dist, fileName));
  assert(png.toString("ascii", 1, 4) === "PNG", `${fileName} is not a PNG.`);
  assert(
    png.readUInt32BE(16) === expectedSize && png.readUInt32BE(20) === expectedSize,
    `${fileName} must be ${expectedSize}×${expectedSize}.`,
  );
}

const worker = readText("sw.js");
const precacheSource = worker.match(/const PRECACHE_PATHS = (\[[\s\S]*?\]);/)?.[1];
assert(precacheSource, "The service worker does not contain a static precache list.");
const precachePaths = JSON.parse(precacheSource);

assert(precachePaths.includes("index.html"), "The service worker must cache the app shell.");
assert(
  precachePaths.some((path) => path.endsWith(".wasm")),
  "The service worker must cache MuPDF WebAssembly for offline editing.",
);
assert(
  precachePaths.every((path) => !path.endsWith(".map") && !path.endsWith(".pdf")),
  "Source maps and PDF documents must not be precached.",
);
assert(
  worker.includes("if (!PRECACHE_SET.has(requestUrl.href)) return;"),
  "The service worker must ignore requests outside its generated allowlist.",
);
assert(!worker.includes("cache.put("), "The service worker must not runtime-cache arbitrary responses.");

for (const fileName of precachePaths) {
  assert(existsSync(resolve(dist, fileName)), `Precached file is missing from the build: ${fileName}`);
}

const privacy = readText("privacy.html");
assert(
  privacy.includes("connect-src 'none'") && privacy.includes("script-src 'none'"),
  "The static privacy page must not allow scripts or network connections.",
);

console.log(`Verified offline app shell (${precachePaths.length} files) and privacy CSP.`);
