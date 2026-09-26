# Third-party notices

JustJPG includes the following third-party software.

## libheif / libheif-js

- Files: `extension/lib/libheif/libheif-bundle.mjs`
- Purpose: decoding HEIC/HEIF images locally in the browser
- Upstream: libheif by struktur AG – <https://github.com/strukturag/libheif>
- Distribution used: libheif-js 1.23.2 by Kiril Vatev – <https://github.com/catdad-experiments/libheif-js>
- License: **GNU Lesser General Public License v3.0** (LGPL-3.0)
- License texts: `extension/lib/libheif/LICENSE` (libheif-js) and `extension/lib/libheif/LICENSE.libheif` (libheif)

The library is included unmodified as a separate file. Its source code is available at the
links above. You may replace `libheif-bundle.mjs` with another compatible build of
libheif-js; the extension loads it only through its default export.
