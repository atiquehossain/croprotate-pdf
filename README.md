# CropRotate PDF

**Annotate, visually sign, crop, rotate, merge and organize PDFs privately — this app does not upload your documents.**

CropRotate PDF is a free, browser-based PDF annotator and editor with visual signing, live previews, precise crop and rotation controls, auto-trim, batch editing, splitting, and a visual page organizer. It is a static web app: selected PDFs, annotations, and visual signatures are processed in a dedicated worker inside the current browser tab, with no document upload API, account, analytics, or server-side document copy.

## Features

- Live PDF preview with page thumbnails, zoom, pan, and page navigation
- Pen and highlighter drawing with adjustable color, width, and opacity
- Text and date placement plus check, cross, line, arrow, rectangle, and ellipse tools
- Drawn or typed visual signatures and initials, with move, resize, duplicate, and delete controls
- Annotation-specific undo and redo
- Rotate individual pages left or right
- Draw, move, and resize crops with eight handles and a rule-of-thirds guide
- Exact top/right/bottom/left margins in percent, points, millimetres, or inches
- Aspect-ratio presets and optional ratio-locked resizing
- Local auto-trim with sensitivity, padding, and annotation controls
- Batch crop/rotation for all, odd, even, or selected page ranges
- Merge multiple PDFs locally by adding their pages to the open document
- Split by ranges, every N pages, or one file per page into a local ZIP
- Select odd, even, inverted, or Shift-click page ranges
- Reorder individual pages or move a multi-page selection as one block
- Duplicate pages while keeping their crop and rotation edits
- Remove unwanted pages and extract selected pages as a separate PDF
- Undo and redo crop/rotation edits plus page-level merge, move, duplicate, and removal changes
- Background PDF and ZIP workers with visible progress and safe cancellation
- Password-protected PDF support, with the first PDF's encryption retained in combined outputs
- Installable offline app shell; the service worker caches application code and static assets only
- Responsive desktop and mobile layout
- No backend, database, API key, account, or paid hosting required

Crop and rotation history is separate from page-structure history. Merging, moving, duplicating, or removing pages keeps edits attached to the correct pages and creates a bounded, in-memory structural undo point. History is discarded when the tab closes or reloads.

Annotations created in CropRotate PDF are flattened into page content when a PDF is exported, while annotations already present in the original PDF are preserved as separate PDF annotations. A drawn or typed signature or set of initials is only a visual electronic mark: it is not certificate-backed, identity-verified, or a cryptographic digital signature. Editing or exporting can invalidate a digital signature already present in a PDF; keep the original when signature validation matters.

Typed text, dates, signatures, and initials use built-in PDF fonts. If those fonts cannot encode a character, export stops with guidance instead of silently losing glyphs. Use the pen or a drawn signature for unsupported scripts or characters.

Combined PDFs use the first PDF's encryption, open password, and permission settings. The app blocks a merge when the first PDF's settings would remove another PDF's encryption or required open password; open that protected PDF first. It cannot compare password strength or encryption algorithms, and settings from additional PDFs are not carried into the combined file.

PDF cropping changes each page's PDF `CropBox`; it does not reliably erase content outside the visible crop. Editing or reorganizing pages can invalidate existing digital signatures. Structural edits rebuild the working PDF, and document-level features such as bookmarks, attachments, page labels, JavaScript, or some form structures—especially from added PDFs—may not carry over. Keep the originals, and use a dedicated redaction tool when content must be permanently removed.

CropRotate PDF is an editor, not a malware scanner or PDF sanitizer. Active content, actions, attachments, and other data from an original PDF may remain in an exported file. Open only documents you trust and continue treating edited outputs as untrusted when their source was untrusted.

## Privacy model

PDF bytes, rendered previews, passwords, edits, annotations, visual signatures and initials, selections, and undo history are held only in the current browser tab's memory while the app is open. Merging, splitting, duplication, reordering, removal, extraction, annotation, and export also happen locally in memory. CropRotate PDF does not upload those files or details, write them to browser storage, run analytics, or keep a server-side copy. Reloading or closing the tab discards the working session. A new output file is saved only when the user explicitly downloads it; original files are not changed.

The user keeps ownership and control of opened documents and created outputs. The app does not claim rights to either.

The static host still receives ordinary web-request metadata, such as an IP address and user agent, when it serves the app. A browser or intermediary may cache the app's HTML, JavaScript, WebAssembly, fonts, icons, and styles, but the application does not send selected PDFs for that cache. Browser extensions, operating-system features, download locations, and cloud-synced folders are outside this app's control.

The installable app's service worker uses a build-generated allowlist for the app shell. It does not runtime-cache arbitrary requests, selected PDF bytes, blob URLs, generated downloads, passwords, previews, or editing state. Once the app shell has been installed successfully, it can start without a network connection; opening and saving documents remain explicit local actions.

## Offline installation and network policy

Supported browsers may offer **Install app** after the first successful load. On iPhone and iPad, installation uses Safari's **Share → Add to Home Screen** flow. The reusable `usePwa()` hook exposes install readiness, offline readiness, connectivity, and update availability so the interface can present those actions without browser-specific logic.

The main page uses a restrictive Content Security Policy: scripts, styles, workers, images, the manifest, and network connections are limited to the app's own origin. `connect-src 'self'` is required because MuPDF loads its WebAssembly file from the same GitHub Pages site; external connections remain blocked. GitHub Pages does not allow this repository to set arbitrary HTTP response headers, so this policy is delivered in HTML. Hosts that support response headers should also send CSP (including `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and an appropriate `Permissions-Policy` as HTTP headers.

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

The app targets current Chrome, Edge, Firefox, and Safari releases with WebAssembly and Web Workers enabled. For browser safety, it accepts files up to 75 MB each, a working set up to 100 MB, and documents up to 1,000 pages. Image-heavy or unusually complex files can still exceed a device's memory limit, especially on mobile devices; splitting the document first is the practical workaround. Restricted PDFs may require the owner password before editing, copying, or page assembly is permitted.

## License

This project and its MuPDF dependency are provided under the [GNU Affero General Public License v3 or later](LICENSE). Anyone who hosts a modified version must make its corresponding source available as required by the AGPL. Keep the in-app **Source** link working and publish your repository.

MuPDF is also available from Artifex under commercial terms if the AGPL is unsuitable for your use case. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency details.

## Useful references

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html)
- [Google JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
- [Google software-app structured data](https://developers.google.com/search/docs/appearance/structured-data/software-app)
- [MuPDF.js repository](https://github.com/ArtifexSoftware/mupdf.js)
