# Security policy

## Reporting a vulnerability

Please report suspected security vulnerabilities through this repository's private GitHub security-advisory form rather than a public issue. Include the affected version or commit, reproduction steps, impact, and any sample PDF needed to reproduce the problem. Remove personal or confidential information from samples whenever possible.

Please allow the maintainers time to investigate and publish a fix before disclosing an unresolved vulnerability publicly. General bugs and feature requests can use the public issue tracker.

## Supported version

Security fixes target the current code on the default branch and the currently deployed GitHub Pages build. Older clones, forks, and third-party deployments may not include those fixes.

## Security and privacy boundaries

CropRotate PDF is a static browser application. Selected PDF bytes, passwords, edits, annotations, drawn or typed signatures and initials, previews, and undo history remain in memory in the active browser tab. The application has no document upload API, account system, analytics, or server-side document storage. Its service worker caches an allowlisted app shell, not selected PDFs or editing state.

The static host still receives ordinary connection metadata when it serves the app. Browser extensions, browser and operating-system memory behavior, download history, synced download folders, modified forks, and software used to open exported files are outside the application's security boundary.

CropRotate PDF is not a malware scanner, sanitizer, or redaction tool. Cropping does not reliably erase hidden content, and active content or attachments from an original PDF may remain in an output. Open only documents you trust and keep originals when fidelity or signature validation matters.

Annotations created by the app are flattened into exported page content; original PDF annotations are preserved. Drawn and typed signatures and initials are visual marks only. They are not certificate-backed digital signatures, do not verify identity, and provide no cryptographic proof of document integrity. Editing or exporting may invalidate an existing digital signature.

Typed annotation and signature text uses built-in PDF fonts. Export stops if those fonts cannot represent a character; use the pen or a drawn signature for unsupported scripts or characters.
