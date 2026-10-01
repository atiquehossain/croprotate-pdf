import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const rawBasePath = process.env.VITE_BASE_PATH?.trim() ?? "";
const normalizedBasePath = rawBasePath.replace(/^\/+|\/+$/g, "");
const siteUrl = (process.env.VITE_SITE_URL?.trim() ?? "").replace(/\/+$/g, "");
const sourceUrl = (
  process.env.VITE_SOURCE_URL?.trim() || "https://github.com/"
).replace(/\/+$/g, "");

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function inlineScriptHashes(html: string): string {
  const hashes = Array.from(
    html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi),
    (match) =>
      `'sha256-${createHash("sha256").update(match[1] ?? "", "utf8").digest("base64")}'`,
  );
  return hashes.join(" ");
}

function seoAssetsPlugin(): Plugin {
  const publicSiteUrl = siteUrl || ".";

  return {
    name: "croprotate-pdf-seo-assets",
    transformIndexHtml(html) {
      const transformed = html
        .replaceAll("__SITE_URL__", publicSiteUrl)
        .replaceAll("__SOURCE_URL__", sourceUrl);
      return transformed.replaceAll("__CSP_SCRIPT_HASHES__", inlineScriptHashes(transformed));
    },
    generateBundle() {
      if (!siteUrl) return;

      const escapedSiteUrl = escapeXml(siteUrl);
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapedSiteUrl}/</loc>
  </url>
  <url>
    <loc>${escapedSiteUrl}/privacy.html</loc>
  </url>
</urlset>
`,
      });
    },
  };
}

function serviceWorkerPlugin(): Plugin {
  const publicAppShell = [
    "fallback.css",
    "icon.svg",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "privacy.css",
    "privacy.html",
    "site.webmanifest",
  ];

  return {
    name: "croprotate-pdf-service-worker",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      const generatedAppAssets = Object.keys(bundle).filter(
        (fileName) =>
          fileName === "index.html" ||
          (/^assets\//.test(fileName) && /\.(?:css|js|wasm)$/.test(fileName)),
      );
      const precacheFiles = Array.from(
        new Set(["index.html", ...generatedAppAssets, ...publicAppShell]),
      ).sort();
      const revisionHash = createHash("sha256").update(JSON.stringify(precacheFiles));
      for (const fileName of precacheFiles) {
        const output = bundle[fileName];
        if (output?.type === "chunk") {
          revisionHash.update(output.code);
        } else if (output?.type === "asset") {
          revisionHash.update(output.source);
        } else if (publicAppShell.includes(fileName)) {
          revisionHash.update(readFileSync(resolve(process.cwd(), "public", fileName)));
        }
      }
      const revision = revisionHash.digest("hex").slice(0, 16);
      const source = `/* Generated at build time. Cache app code only; never cache document requests. */
const CACHE_PREFIX = "croprotate-pdf-shell-";
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(revision)};
const PRECACHE_PATHS = ${JSON.stringify(precacheFiles, null, 2)};
const PRECACHE_URLS = PRECACHE_PATHS.map((path) => new URL(path, self.location.href).href);
const PRECACHE_SET = new Set(PRECACHE_URLS);
const APP_SHELL_URL = new URL("index.html", self.location.href).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        requestUrl.search = "";
        const cachedPage = PRECACHE_SET.has(requestUrl.href)
          ? await cache.match(requestUrl.href)
          : undefined;
        return cachedPage || cache.match(APP_SHELL_URL);
      }),
    );
    return;
  }

  requestUrl.search = "";
  if (!PRECACHE_SET.has(requestUrl.href)) return;

  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(requestUrl.href))
      .then((cached) => cached || fetch(request)),
  );
});
`;

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source,
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages supplies the repository subpath during CI. Relative assets
  // keep local builds and downloaded copies portable.
  base: normalizedBasePath ? `/${normalizedBasePath}/` : "./",
  plugins: [react(), seoAssetsPlugin(), serviceWorkerPlugin()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    // MuPDF uses top-level await in its WebAssembly module.
    format: "es",
  },
});
