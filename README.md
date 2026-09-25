# CropRotate PDF

**Crop and rotate PDFs privately — this app does not upload your document.**

CropRotate PDF is a free, browser-based PDF crop and rotation editor with live previews, precise controls, auto-trim, and batch editing. It is a static web app: the selected PDF is processed in the current browser tab, with no document upload API, account, analytics, or server-side document copy.

## Features

- Live PDF preview with page thumbnails, zoom, pan, and page navigation
- Rotate individual pages left or right
- Draw, move, and resize crops with eight handles and a rule-of-thirds guide
- Exact top/right/bottom/left margins in percent, points, millimetres, or inches
- Aspect-ratio presets and optional ratio-locked resizing
- Local auto-trim with sensitivity, padding, and annotation controls
- Batch crop/rotation for all, odd, even, or selected page ranges
- Document-wide undo and redo
- Password-protected PDF support, with original encryption retained on export
- Responsive desktop and mobile layout
- No backend, database, API key, account, or paid hosting required

PDF cropping changes each page's PDF `CropBox`; it does not reliably erase content outside the visible crop. Editing can also invalidate existing digital signatures. Use a dedicated redaction tool when content must be permanently removed.

## Privacy model

PDF bytes, rendered previews, passwords, edits, and undo history are held only in the current browser tab's memory while the app is open. CropRotate PDF does not upload them, write them to browser storage, or keep a server-side copy. Reloading or closing the tab discards the working session. A new output file is saved only when the user explicitly downloads it; the original file is not changed.

The user keeps ownership and control of opened documents and created outputs. The app does not claim rights to either.

The static host still receives ordinary web-request metadata, such as an IP address and user agent, when it serves the app. A browser or intermediary may cache the app's HTML, JavaScript, WebAssembly, fonts, icons, and styles, but the application does not send the selected PDF for that cache. Browser extensions, operating-system features, download locations, and cloud-synced folders are outside this app's control.

This description applies to the code in this repository. If you modify the project, add analytics, or add a backend, update the visible privacy notice before publishing.

## Publish on GitHub Pages

The included GitHub Actions workflow builds and deploys the site automatically.

1. Create a **public** GitHub repository, for example `croprotate-pdf`.
2. Extract the clean release ZIP and upload its contents to the repository root. Keep the `.github` folder. Do not upload generated `node_modules/` or `dist/` folders.
3. Open **Settings → Pages** in the repository.
4. Under **Build and deployment**, select **GitHub Actions** as the source.
5. Push to the `main` branch and watch the **Actions** tab. The site will normally appear at `https://atiquehossain.github.io/croprotate-pdf/`.

The workflow reads GitHub Pages' exact base path, so repository project sites, `username.github.io` sites, and custom domains receive correct asset URLs. It also provides the public site URL for canonical and social metadata, and injects the repository URL into the app's **Source** link.

To publish with Git from this folder:

```bash
git init
git add .
git commit -m "Launch CropRotate PDF"
git branch -M main
git remote add origin https://github.com/atiquehossain/croprotate-pdf.git
git push -u origin main
```

### Custom domain and site name

GitHub project Pages live below a shared `github.io` hostname. Search engines generally choose site names at the domain or subdomain level rather than for individual subdirectories, so a custom domain gives **CropRotate PDF** a clearer, independent site identity. The app still works without one. See Google's [site-name guidance](https://developers.google.com/search/docs/appearance/site-names) and GitHub's [custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).

Project naming and exact-name searches are preliminary only; they are not legal or trademark clearance. Check the name in the markets where you plan to operate before a commercial launch.

## SEO and share previews

The project includes:

- A descriptive page title, meta description, robots directive, canonical URL, and semantic fallback content
- Open Graph and Twitter card metadata
- `WebApplication` structured data without invented ratings or endorsements
- A web app manifest, app icon, and social preview image
- A crawlable standalone privacy page
- A sitemap generated at build time when the public site URL is available

The deployment workflow supplies the canonical GitHub Pages URL automatically. For another host, set these build-time variables:

```bash
VITE_BASE_PATH=/optional-subdirectory/
VITE_SITE_URL=https://example.com/optional-subdirectory
VITE_SOURCE_URL=https://github.com/atiquehossain/croprotate-pdf
npm run build
```

Use the final public URL for `VITE_SITE_URL`, without a trailing slash. Search visibility is never guaranteed; after deployment, submit the sitemap in the relevant search-engine webmaster tools and keep the page copy accurate.

## Run locally

Install [Node.js 24](https://nodejs.org/) and run:

```bash
npm install
npm run dev
```

Vite prints a local address such as `http://localhost:5173`. For a full production check:

```bash
npm run check
npm run preview
```

The optimized static site is written to `dist/`. Serve it over HTTP or HTTPS; WebAssembly workers may not function if `index.html` is opened directly with `file://`.

The app targets current Chrome, Edge, Firefox, and Safari releases with WebAssembly and Web Workers enabled. Exceptionally large or image-heavy PDFs may exceed a browser's memory limit, especially on mobile devices; splitting the document first is the practical workaround. Restricted PDFs may require the owner password before editing is permitted.

## License

This project and its MuPDF dependency are provided under the [GNU Affero General Public License v3 or later](LICENSE). Anyone who hosts a modified version must make its corresponding source available as required by the AGPL. Keep the in-app **Source** link working and publish your repository.

MuPDF is also available from Artifex under commercial terms if the AGPL is unsuitable for your use case. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency details.

## Useful references

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html)
- [Google JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
- [Google software-app structured data](https://developers.google.com/search/docs/appearance/structured-data/software-app)
- [MuPDF.js repository](https://github.com/ArtifexSoftware/mupdf.js)
