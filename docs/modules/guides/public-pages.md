# The public guide pages

`/guides` and `/guides/<slug>` in `packages/web-v2` are Forge's public documentation: one set of
pages from two homes, behind two doors named for the reader. Both homes are unauthenticated —
`guideRoutes` in `packages/core/src/guides/routes.ts` applies `requireAuth()` only to its `/orgs`
and `/projects` sub-trees, and the help pages are a static module bundled into the web build — and the routes sit
outside the `(workspace)` group, whose layout redirects a signed-out visitor to `/login`.

| Home | Audience | Read at |
|---|---|---|
| `packages/web-v2/content/help/*.md`, bundled as `HELP_DOCS` | `user` — each page's own front-matter | `/guides?path=<slug>` |
| `packages/core/src/guides/registry.ts`, fetched from `GET <core>/api/guides` | `agent` | `/guides/<slug>`, and as markdown at `<core>/api/guides/<slug>.md` |

These are two of Forge's four documentation homes; which page belongs in which is
`docs/modules/guides/where-a-page-lives.md`.

`buildCorpus` in `packages/web-v2/src/features/guides/corpus.ts` makes the two one list, and that
list is what the search, the doors and the reader all read. No guide prose is stored in `web-v2`;
the agent pages are fetched at request time, every body included (`fetchGuideCorpus` in
`packages/web-v2/src/features/guides/api.ts`) so the search reaches their words and not only their titles.
Each guide carries the `audience` core declared for it, which `fromGuide` reads and refuses where it
is not `agent`.

The addresses: `/guides` is the landing — the sentence saying the corpus is one, the search, the
two doors. `/guides?for=<audience>` is a door. `/guides?path=<slug>` is a help page, the same
`?path=` form help pages already link each other by, resolved there by `Markdown`'s `docRoute`.
`/guides/<slug>` is an agent guide at the address it always had. The reader is the in-app `/docs`
screen's own furniture, `packages/web-v2/src/features/docs/components/docs-reader.tsx`, not a second reading UI.

The pages render per request rather than prerendered. A prerender would bake the
index into the image and make the image build fail wherever core is unreachable.

## Two things about Next that this shape is built around

Both were measured on the production standalone server the deploy runs
(`node .next/standalone/packages/web-v2/server.js`), against a core that delayed
every reply, during ISS-1124. Neither is inferable from the source.

<!-- doc-citation: unchecked `loading.tsx` `src/app/loading.tsx` — Next's filename convention, and where the loading file USED to sit; this paragraph is about moving it away from there. -->
**A `loading.tsx` is an ancestor Suspense boundary for every route beneath it,
and the shell it streams commits the HTTP status.** With the app's loading file
at `src/app/loading.tsx`, `/guides/<unknown-slug>` answered **200**: the shell
had gone out before the page awaited anything, so the later `notFound()` could
render a 404 page but not set a 404 status. Moving it to
`packages/web-v2/src/app/(workspace)/loading.tsx` — the routes that want it — makes the same
request answer **404**. Anything public added outside that group inherits this,
so a new boundary goes next to the routes that need one.

**`notFound()` raised in a dynamic route never server-renders its body.** Next
emits `<html id="__next_error__">` with an empty `<body>` and streams the
not-found UI as flight data, discarding the page's own `generateMetadata` with
it — the title and description come from the root layout. A browser renders the
<!-- doc-citation: unchecked `not-found.tsx` — Next's filename convention, not one file. -->
page after hydration; curl, a crawler and a link preview get the status and
nothing else. Three shapes were tried and all three behaved the same: a client
`not-found.tsx` using `usePathname`, a synchronous server one, and `notFound()`
raised from `generateMetadata`. A middleware `rewrite` carrying `{ status: 404 }`
was also tried; the status is ignored and the response is 200.

## What answers an unknown slug, page or door

`packages/web-v2/src/middleware.ts`, because it is the only layer that can set a status and a
body together. Its `/guides` branch gates nobody. On `/guides` itself it reads the query with
`readPublicRequest` (`packages/web-v2/src/features/guides/requested-page.ts`): a `path` naming no help
page, a `for` naming no door, or an address carrying both, answers 404 with `refusalDocument`. It
learns the help slugs from `packages/web-v2/src/features/docs/help-slugs.generated.ts` rather than from `HELP_DOCS`, so the middleware
does not bundle every page body. The page reads the same function, so a client-side navigation to
the same address shows the same words in the content pane. On `/guides/<slug>` it refuses a slug
`GUIDE_SLUG` rejects without asking core, asks core about the rest, and answers
a 404 with `missingGuideDocument` — a styleless HTML page naming the slug and
linking the index, with the slug escaped because it comes off the URL. The price
of that shape is one extra core request per guide view on the happy path, paid so
that a reader without JavaScript gets the refusal instead of a blank document. It
ends when Next server-renders a `notFound()` body.

A client-side navigation is left alone: the router refetches the same URL with an
`RSC` header and would choke on an HTML document, and it has JavaScript by
definition, so `packages/web-v2/src/app/guides/[slug]/not-found.tsx` serves it. Both renderers read
one set of strings from `packages/web-v2/src/features/guides/missing.ts`.

`GUIDE_SLUG` lives in `packages/web-v2/src/features/guides/requested-path.ts` and is read by the
middleware and by `packages/web-v2/src/features/guides/api.ts`. One test of what a slug is, because
two that disagree is a slug one passes and the other refuses:
`/guides/what-is-an-issue.md` was exactly that — core answers 200 for it, having
stripped the suffix, so it cleared the middleware and was then refused by the
page, landing back on the blank body.

`slugFromGuidePath` returns the slug exactly as the page's own route param will
hold it, for the same reason: it does not trim, because `/guides/%20what-is-an-issue%20`
trimmed looks like a real guide to the middleware and does not to the page. A
suffix that will not decode is kept raw for `GUIDE_SLUG` to refuse, rather than
thrown over — `/guides/%ZZ` was a 500 from edge middleware before that.

<!-- doc-citation: unchecked `not-found.tsx` — Next's filename convention, not one file. -->
The requested path reaches `not-found.tsx` on the `x-forge-guide-path` header the
middleware sets, because Next hands a not-found boundary no params and `headers()`
there carries only what the client sent.

## The markdown address is absolute

The guide pages are served by web-v2 and the markdown by core, on two different origins. A bare
`/api/guides` in the page's own prose reads as the web host, where it answers 404 — measured
2026-09-21 against `forge-beta.sidcorp.co` (404) and `forge-beta-api.sidcorp.co` (200). The
footer in `packages/web-v2/src/features/guides/components/guide-shell.tsx`, the agent door and each agent
page's notice (`guideMarkdownUrl` in `packages/web-v2/src/features/guides/corpus.ts`), and `MISSING_GUIDE_BODY` in
`packages/web-v2/src/features/guides/missing.ts` build the address with `coreFileUrl`, the browser-facing helper in
`packages/web-v2/src/lib/utils/core-url.ts`. `resolveServerApiBase` is not that helper and says so: its origin is the
one the web server process sees, never the browser.

This is the same two-host confusion that pointed the GitHub App's webhook at the web host and cost
three days of silent 404s (ISS-1140).
