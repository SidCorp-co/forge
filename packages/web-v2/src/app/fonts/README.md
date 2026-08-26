# Vendored fonts

Both families are committed here rather than fetched at build time. `next/font/google`
downloads the binaries while `next build` runs, so a font host that does not answer fails
the build — and one Coolify application builds `core` and `web-v2` together, which means a
web-only font fetch takes the **backend** deploy down with it. That happened on 2026-08-13
(deploy `zs4ocksc8sokkcw0g0g0w4s0`, exit 1; a core-only fix sat merged-but-not-live for
~90 minutes and needed a hand re-dispatch). ISS-854.

`../layout.tsx` declares them through `next/font/local`, and `../fonts.test.ts` fails if the
`next/font/google` import comes back.

## What these files are

These are the exact binaries Google serves to `next/font/google` for the weights web-v2
uses — not a re-export, not a re-subset. Google returns **one variable woff2 per family for
the `latin` subset**; every requested weight resolves to the same URL.

| File | Source URL | Bytes | `fvar` wght axis | `name` id 5 | Weights in use |
|---|---|---|---|---|---|
| `hanken-grotesk-latin-variable.woff2` | `https://fonts.gstatic.com/s/hankengrotesk/v12/ieVn2YZDLWuGJpnzaiwFXS9tYtpd59A.woff2` | 34,704 | 100 … 900 | Version 3.013 | 400, 500, 600, 700, 800 |
| `jetbrains-mono-latin-variable.woff2` | `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2` | 31,432 | 400 … 800 | Version 2.211 | 400, 500, 600, 700 |

JetBrains Mono's axis reads `400..800` rather than the family's full `100..800` because
Google axis-subsets the variable font to the span the request asks for. It covers every
weight web-v2 uses.

## Licence

Both are SIL Open Font License 1.1, which permits redistribution in this repo provided the
licence travels with the files — `OFL-hanken-grotesk.txt` and `OFL-jetbrains-mono.txt`,
verbatim from `google/fonts/ofl/<family>/OFL.txt`. Each binary also carries
`https://scripts.sil.org/OFL` in its own `name` id 14.

## Refreshing them

Ask Google for the CSS the build would have asked for, take the `/* latin */` block's URL,
and download it. The User-Agent decides the format — without a modern one you get TTF
instead of woff2.

```sh
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
curl -sS -A "$UA" \
  "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" \
  | awk '/\/\* latin \*\//{f=1} f&&/src: url/{print;exit}'
```

Refreshing means new binaries: re-check the axis range against the `weight` string in
`../layout.tsx` (an axis that no longer spans a weight in use renders that weight
synthesised), and update the table above.

## Verifying on a live page

The generated `font-family` names changed with the move to `next/font/local`. They are derived
from the **variable name in `../layout.tsx`**, not the family name, so the compiled CSS now says
`font-family: hanken` and `font-family: jetbrainsMono` where it used to say
`__Hanken_Grotesk_<hash>` and `__JetBrains_Mono_<hash>`.

ISS-306 left a live check behind — `getComputedStyle(document.body).fontFamily` must start with
the next/font family — and it is still the right check, because a correct-looking compiled CSS
bundle has already shipped a live page rendering system sans once. Only the expected string
moved:

```js
getComputedStyle(document.body).fontFamily.startsWith('hanken')   // was '__Hanken_Grotesk_'
```

Reading the old string as a regression is the mistake this section exists to prevent.
