# Third-party notices

CropRotate PDF includes the following open-source packages. Exact resolved versions are recorded in `package-lock.json`.

## MuPDF.js / MuPDF

- Package: `mupdf`
- Copyright: Artifex Software, Inc. and contributors
- License: GNU Affero General Public License v3 or later (`AGPL-3.0-or-later`)
- Source: <https://github.com/ArtifexSoftware/mupdf.js>
- Project: <https://mupdf.com/>

MuPDF performs PDF parsing, rendering, password authentication, page-box editing, and export in WebAssembly. Its license is the reason this complete application is distributed under the AGPL. Artifex also offers commercial licensing separately.

## React, React DOM, and Scheduler

- Packages: `react`, `react-dom`, `scheduler`
- Copyright: Meta Platforms, Inc. and affiliates
- License: MIT
- Source: <https://github.com/facebook/react>

> MIT License
>
> Copyright (c) Meta Platforms, Inc. and affiliates.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Lucide React

- Package: `lucide-react`
- Copyright: Lucide Contributors
- License: ISC, with MIT-licensed portions derived from Feather
- Source: <https://github.com/lucide-icons/lucide>

> ISC License
>
> Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2025.
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The Feather-derived portions are Copyright (c) 2013-2023 Cole Bemis and are licensed under the MIT License printed above.

## Vite and related build tooling

- Packages include `vite`, `@vitejs/plugin-react`, TypeScript, and Vitest
- Licenses: primarily MIT; see each package's bundled license and `package-lock.json`
- Sources: <https://github.com/vitejs/vite>, <https://github.com/microsoft/TypeScript>, <https://github.com/vitest-dev/vitest>

No third-party code is loaded from a CDN at runtime. Production assets are built into the static site.
