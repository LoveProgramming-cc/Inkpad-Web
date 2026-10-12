# Third-party notices

Inkpad Web is free software under the GNU General Public License, version 3 or (at your option) any
later version (see `LICENSE`). It contains or loads the following software, each under its own licence.

## Lucide icons

The toolbar icons in `src/data/icons.js` are path data from the Lucide icon set (https://lucide.dev),
used under the ISC License:

> ISC License
>
> Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
> Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with
> or without fee is hereby granted, provided that the above copyright notice and this
> permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO
> THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO
> EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
> DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER
> IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
> CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## pdf.js (Apache-2.0)

`src/vendor/pdfjs/` is pdfjs-dist 4.10.38 (https://mozilla.github.io/pdf.js/), Copyright Mozilla
Foundation and contributors, licensed under the Apache License 2.0; its licence text is in
`src/vendor/pdfjs/LICENSE`. It renders and searches PDF pages. The CMap and standard-font data in
that folder are part of the same package.

## pdf-lib (MIT)

`src/vendor/pdf-lib/` is pdf-lib 1.17.1 (https://pdf-lib.js.org/), Copyright Andrew Dillon, MIT
licence (`src/vendor/pdf-lib/LICENSE.md`). It writes the exported PDF.

## @pdf-lib/fontkit (MIT)

`src/vendor/fontkit/` is @pdf-lib/fontkit 1.1.1 (https://github.com/Hopding/fontkit), a fork of
fontkit by Devon Govett, MIT licence. It reads the font chosen for exported text and cuts out the
subset that goes into the PDF.

## Goodnotes

Inkpad is not affiliated with, endorsed by or connected to Goodnotes. "Goodnotes" is a trademark of
its owner and is used here only to say which files can be imported. The importer was written by
studying files, for interoperability, and contains no Goodnotes code or assets.

## Fonts in exported PDFs

Text in an exported PDF is set in a font the user chooses. Font files have licence terms of their
own; whether a font may be embedded in a document is for the user to check.
