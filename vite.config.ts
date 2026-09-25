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

function seoAssetsPlugin(): Plugin {
  const publicSiteUrl = siteUrl || ".";

  return {
    name: "croprotate-pdf-seo-assets",
    transformIndexHtml(html) {
      return html
        .replaceAll("__SITE_URL__", publicSiteUrl)
        .replaceAll("__SOURCE_URL__", sourceUrl);
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

export default defineConfig({
  // GitHub Pages supplies the repository subpath during CI. Relative assets
  // keep local builds and downloaded copies portable.
  base: normalizedBasePath ? `/${normalizedBasePath}/` : "./",
  plugins: [react(), seoAssetsPlugin()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    // MuPDF uses top-level await in its WebAssembly module.
    format: "es",
  },
});
