# The public guide pages

`/guides` and `/guides/<slug>` in `packages/web-v2` are Forge's public documentation: one set of
pages from two homes, behind three doors named for the reader. Both homes are unauthenticated —
`guideRoutes` in `packages/core/src/guides/routes.ts` applies `requireAuth()` only to its `/orgs`
sub-tree, and the help pages are a static module bundled into the web build — and the routes sit
outside the `(workspace)` group, whose layout redirects a signed-out visitor to `/login`.

| Home | Audience | Read at |
|---|---|---|
| `packages/web-v2/content/help/*.md`, bundled as `HELP_DOCS` | `user`, `assistant-setup` — each page's own front-matter | `/guides?path=<slug>` |
| `packages/core/src/guides/content/*.md`, listed in `packages/core/src/guides/registry.ts` and fetched from `GET <core>/api/guides` | `agent` | `/guides/<slug>`, and as markdown at `<core>/api/guides/<slug>.md` |

These are two of Forge's four documentation homes; which page belongs in which is
`docs/modules/guides/where-a-page-lives.md`.

`buildCorpus` in `packages/web-v2/src/features/guides/corpus.ts` makes the two one list, and that
list is what the search, the doors and the reader all read. No guide prose is stored in `web-v2`;
the agent pages are fetched at request time, every body included (`fetchGuideCorpus` in
`packages/web-v2/src/features/guides/api.ts`) so the search reaches their words and not only their titles.
Each guide carries the `audience` core declared for it, which `fromGuide` reads and refuses where it
is not `agent`.

The agent door's count is not the whole corpus, and the page says so: `fetchGuideScope` reads the
`corpus` statement from the same index response and `PublicLanding` and the agent door print it
beside the count. Core's words are never copied into `web-v2`, and an index that carries no such
statement is refused by name rather than rendered as if complete.

The addresses: `/guides` is the landing — the sentence saying the corpus is one, the search, the
three doors. `/guides?for=<audience>` is a door. `/guides?path=<slug>` is a help page, the same
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

**`notFound()` raised in a dynamic route never server-renders its body.** On a
plain request Next emits `<html id="__next_error__">` with an empty `<body>` and
streams the not-found UI as flight data, discarding the page's own
`generateMetadata` with it — the title and description come from the root layout.
A client-side navigation is the other way round: its flight answer carries the
page's own `generateMetadata` beside the not-found UI, so a guide's names the
missing-guide refusal rather than returning nothing and leaving the tab at the
root layout's bare `Forge` (measured on 16.3.8 with `next dev`). A browser renders the
<!-- doc-citation: unchecked `not-found.tsx` — Next's filename convention, not one file. -->
page after hydration; curl, a crawler and a link preview get the status and
nothing else. Three shapes were tried and all three behaved the same: a client
`not-found.tsx` using `usePathname`, a synchronous server one, and `notFound()`
raised from `generateMetadata`. A middleware `rewrite` carrying `{ status: 404 }`
was also tried; the status is ignored and the response is 200.

## The search, and the tab's title

`searchDocs` in `packages/web-v2/src/features/docs/reader.ts` is a substring match over title,
summary and body, listing the pages whose title holds the words ahead of the rest, and each result
shows `matchExcerpt` of that page: the section heading the first matching block sits under and the
words around it. The in-app `/docs` screen reads the same two functions.

Both read a body as a reader meets it (`readBlocks`): a paragraph, list item or quote with its source
wraps joined, so a shown line starts where its sentence does and a cut is marked `…`; a line of code
kept as written, angle brackets included; emphasis, code and link marks left out of prose. A title is
matched in the form it is shown (`plainText`, its code marks left out). The page's own heading — an
`#` heading on its first line, or any heading repeating its title — is never a section, and is a
match only where the title does not already hold the words: every help page opens with an `#` that
is not always its title word for word, and every agent guide with a `##` repeating its title.

A title carrying code is shown with it as code and never with its backticks (`DocTitle` in
`packages/web-v2/src/features/docs/components/docs-reader.tsx`, from `titleParts`), and the tab names it with the marks left out. What was typed
into the search is kept in the address as `q`, replacing the history entry rather than adding one,
so Back from a result returns to the search and a reload opens on it.

The tab's title is set by the reader as well as by `generateMetadata`, both through
`documentTitle` in `packages/web-v2/src/features/guides/audience.ts`. A client-side navigation between
`/guides` addresses kept the title of an earlier one: measured on forge-beta, going from an agent
page to `/guides?for=user` and on to a help page left every tab reading the agent door's title.

## What answers an unknown slug, page or door

`packages/web-v2/src/middleware.ts`, because it is the only layer that can set a status and a
body together. Its `/guides` branch gates nobody. On `/guides` itself it reads the query with
`readPublicRequest` (`packages/web-v2/src/features/guides/requested-page.ts`): a `path` naming no help
page, a `for` naming no door, or an address carrying both, answers 404 with `refusalDocument`. It
learns the help slugs from `packages/web-v2/src/features/docs/help-slugs.generated.ts` rather than from `HELP_DOCS`, so the middleware
does not bundle every page body. The page reads the same function, so a client-side navigation to
the same address shows the same words in the content pane. On `/guides/<slug>` it refuses a slug
`GUIDE_SLUG` rejects without asking core, asks core about the rest, and answers
a 404 with `missingGuideDocument`, an HTML page naming the slug, with the slug escaped because it
comes off the URL. Both documents
(`refusalDocument` is the other) are written to look like the pages around them: the header
`GuideShell` prints, the name `SITE_NAME` gives the surface, the type scale of the refusal the reader shows, and
every door as the way on while the guide index answers. The middleware cannot render React or name the app's hashed stylesheet,
so the CSS is inline, and the colours it paints with are `DOCUMENT_TOKENS`, each held by
`packages/web-v2/src/features/guides/missing-document.test.ts` to the value `packages/web-v2/src/styles/tokens.css` resolves it to.
The font is the app's own, copied to `packages/web-v2/public/fonts/` because the one `next/font`
serves has a hashed address; the test holds the copy to `packages/web-v2/src/app/fonts/`, byte for byte.
The price
of that shape is one extra core request per guide view on the happy path, paid so
that a reader without JavaScript gets the refusal instead of a blank document. It
ends when Next server-renders a `notFound()` body.

The same request decides the outage. The landing, a help page, and a door whose pages are all help
pages (`BUNDLED_AUDIENCES` in `packages/web-v2/src/features/guides/audience.ts`), are bundled, so the
middleware passes them without asking core and the page renders them from `HELP_DOCS` alone while the
index is unreadable: a page or door with the sidebar saying its search covers those pages only
(`HELP_ONLY_SEARCH`), the landing saying why (`LANDING_WHILE_DOWN`), each offering only the doors that
still open and without the footer that points at core's markdown. Which doors those are is `openDoors` in
`packages/web-v2/src/features/guides/audience.ts`, and every
sentence saying what the docs cover is built from it: the header's line (`siteCaption`), the search
field's name and the sidebar's placeholder (`searchLabel`), and both outage sentences, so a page
rendered while the index is down never says it searches every page or names agents as a reader. A plain request for the agents'
door or a guide asks core first (`coreStatus` in the middleware: the index for `/guides`; for `/guides/<slug>`
the guide, then the index its page is also built from), and where core cannot be reached or answers anything but success (or, for a
guide, 404) the middleware answers **503** with `Retry-After` and `unavailableDocument`: the same
header as the 404s, and as the way on the landing and the bundled doors (`BUNDLED_WAYS_IN`), the
agents' door needing the index too. Core unreachable is never a 404: that would tell a reader a guide
does not exist on no evidence. The price is one core request per plain agents' door view, and a second per guide view.

**The page reads the index live, never from the fetch cache** (`readJson`'s `live` in
`packages/web-v2/src/features/guides/api.ts`); a guide's body is still cached for 300 seconds. With the
index cached too, a help page rendered in the five minutes after core dropped was built from the stale
copy: no outage said, and the agents' door, the landing and three agent guides in its search offered,
each a 503 on a direct load (measured on a production build with core on a closed port). A guide page
reads the index before the guide for the same reason. The price is one uncached core request per
docs page rendered.

A refusal stays a 404 while core is down, but the middleware asks for the index before writing one
(`refuse` in the middleware), because every address but a bundled one then answers 503. With the
index unreadable the refusal says `saidWhileDown` (each `Refusal`'s `bodyWhileDown` in place of a
body that points at the index, then `SEARCH_UNAVAILABLE` and `BUNDLED_WAYS_IN`), links only the
bundled doors; the site name in its header links the landing, which opens while core is down.
`PublicRefusal` says the same words. The price is one more core request per refused plain request.

A client-side navigation is left alone: the router fetches the same URL for flight data and would
choke on an HTML document, and it has JavaScript by definition, so the page serves it inside the docs
shell: a door or page as a `refused` view of `PublicReader`, which offers the docs' search and every
door in the sidebar a door page has, and
`packages/web-v2/src/app/guides/[slug]/not-found.tsx` for a guide. The search needs the guide
index, so with core unreachable `PublicRefusal` keeps the refusal, says there is no search
(`SEARCH_UNAVAILABLE`) and offers the bundled doors. The agents' door and a guide are built
from that index, so on a client-side navigation with it unreadable (`GuideFetchError`, caught by `orUnreadable` in
`packages/web-v2/src/features/guides/unreadable.ts`) both pages render `PublicRefusal` with
`GUIDES_UNAVAILABLE` in the docs' shell instead, and log why; any other error is still thrown. Every renderer reads one set of strings
from `packages/web-v2/src/features/guides/missing.ts`.

The middleware cannot tell the two apart by the `RSC` header: Next 16's middleware adapter
(`next/dist/server/web/adapter.js`, `FLIGHT_HEADERS`) deletes it, and `_rsc`, before middleware
runs. `isFlightRequest` in `packages/web-v2/src/features/guides/flight-request.ts` reads `Next-Url`
and `Sec-Fetch-Dest: empty`, which do reach it (measured on 16.3.8 in a browser: the flight fetch
arrives with both and no `rsc`). The 404 it does send carries `Vary` on them.

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
