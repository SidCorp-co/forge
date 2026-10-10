# Fonts

The UI face is **Inter Variable**, from the `@fontsource-variable/inter` package (tokens v2,
FB-36): `../globals.css` imports `@fontsource-variable/inter/wght.css`, whose `@font-face` rules
carry every subset Inter ships (latin, latin-ext, Vietnamese, Cyrillic, Greek) behind
`unicode-range`, so Vietnamese content draws in Inter rather than a system fallback. The package
is installed from the lockfile, never fetched while `next build` runs, so the rule below holds.

The mono face is committed here rather than fetched at build time. `next/font/google`
downloads the binaries while `next build` runs, so a font host that does not answer fails
the build — and one Coolify application builds `core` and `web-v2` together, which means a
web-only font fetch takes the **backend** deploy down with it. That happened on 2026-08-13
(deploy `zs4ocksc8sokkcw0g0g0w4s0`, exit 1; a core-only fix sat merged-but-not-live for
~90 minutes and needed a hand re-dispatch). ISS-854.

`../layout.tsx` declares JetBrains Mono through `next/font/local`.

## What these files are

This is the exact binary Google serves to `next/font/google` for the weights web-v2 uses — not a
re-export, not a re-subset. Google returns **one variable woff2 per family for the `latin`
subset**; every requested weight resolves to the same URL.

| File | Source URL | Bytes | `fvar` wght axis | `name` id 5 | Weights in use |
|---|---|---|---|---|---|
| `jetbrains-mono-latin-variable.woff2` | `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2` | 31,432 | 400 … 800 | Version 2.211 | 400, 500, 600, 700 |

JetBrains Mono's axis reads `400..800` rather than the family's full `100..800` because
Google axis-subsets the variable font to the span the request asks for. It covers every
weight web-v2 uses.

## Licence

<!-- doc-citation: unchecked `google/fonts/ofl/jetbrainsmono/OFL.txt` — a path in the google/fonts repository, not this tree -->
JetBrains Mono is SIL Open Font License 1.1, which permits redistribution in this repo provided
the licence travels with the file — `OFL-jetbrains-mono.txt`, verbatim from
`google/fonts/ofl/jetbrainsmono/OFL.txt`. The binary also carries `https://scripts.sil.org/OFL` in
its own `name` id 14. Inter (OFL 1.1) carries its licence in its package.

## Refreshing them

Ask Google for the CSS the build would have asked for, take the `/* latin */` block's URL,
and download it. The User-Agent decides the format — without a modern one you get TTF
instead of woff2.

```sh
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
curl -sS -A "$UA" \
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" \
  | awk '/\/\* latin \*\//{f=1} f&&/src: url/{print;exit}'
```

Refreshing means new binaries: re-check the axis range against the `weight` string in
`../layout.tsx` (an axis that no longer spans a weight in use renders that weight
synthesised), and update the table above.

## Verifying on a live page

A correct-looking CSS bundle has shipped a page drawing system sans before (ISS-306), so read the
computed family on the live page:

```js
getComputedStyle(document.body).fontFamily.startsWith('"Inter Variable"')
```
