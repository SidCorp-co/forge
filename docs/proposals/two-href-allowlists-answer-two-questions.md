# Two href allowlists, and the four hrefs they disagree about

ISS-1052 made one rule decide which origin a body's href belongs to, so that a markdown body and a
`format: html` body get the same answer. Walking that on beta at `63a54a44` turned up a second
allowlist upstream of both, and the two do not agree. This is the record of what they disagree
about and what a decision would have to settle. Nothing here is a regression — every case below
behaved the same way before ISS-1052 — and nothing here is broken enough to change without
deciding first.

## The two rules

**Core's**, `packages/core/src/body/plain-tags.ts:SAFE_URL`, applied by
`packages/core/src/body/validate.ts:cleanPlainAttrs` when a `format: html` body is stored. It admits
`https?://`, `/`, `./`, `#` and `mailto:`, and **drops the attribute** for anything else, with a
warning on the write. Its question is *is this markup safe to store*.

**The web's**, `packages/web-v2/src/lib/utils/body-href.ts:classifyBodyHref`, applied by both body
renderers at draw time. Its question is *which origin serves this*, and it answers `anchor`,
`in-app`, `core-file`, `external` or `unresolvable`.

A markdown body never meets the first rule: it is stored as bytes and parsed in the browser. A
`format: html` body meets both.

## What they disagree about

Measured with a fourteen-shape fixture comment posted to ISS-1052 in each format, read back off the
stored nodes and off the rendered DOM.

| Written | Core stores | The renderer draws, from what it got |
|---|---|---|
| `?tab=history` | href dropped | markdown: a same-tab link · html: `link not shown: (empty)` |
| `docs/guide` | href dropped | markdown: `link not shown: docs/guide` · html: `link not shown: (empty)` |
| `javascript:alert(1)` | href dropped | markdown: `link not shown: javascript:…` · html: `link not shown: (empty)` |
| `tel:+441234567890` | href dropped | markdown: a link · html: `link not shown: (empty)` |

Every other shape agrees: an app route, `/api/…`, `./api/…`, an absolute URL, `#anchor`, an
api-lookalike path, and all four image shapes render identically from both formats.

Three of the four end in a refusal either way and differ only in whether the reader is told *which*
href was refused. `tel:` is the one where the two rules reach opposite answers.

## What a decision has to settle

1. **Is `tel:` markup a stored body may carry?** It is navigable and it is not a fetch, so it is
   safe by the same reasoning that admits `mailto:`. Adding it to `SAFE_URL` is one alternation. The
   question is whether the stored-body allowlist is meant to be the set of schemes that are *safe*
   or the smaller set that is *used*.
2. **Should core drop an href it will not admit, or store it and let the renderer refuse it by
   name?** Dropping loses the one thing the reader needs — what the link pointed at. Core's own
   comment says a rewritten URL is a guess at what the author meant; keeping the bytes and refusing
   at draw time is neither a rewrite nor a guess, and it is what the markdown path already does.
3. **Should a relative-to-the-page href (`?…`, `docs/guide`) be storable at all?** Core cannot
   resolve one and neither can the renderer without knowing the page. Refusing it is defensible;
   refusing it *silently on the write* is the part worth revisiting, because the author learns only
   from a warning on a response nobody reads.

Settling 2 alone would remove three of the four disagreements without widening what is safe.
