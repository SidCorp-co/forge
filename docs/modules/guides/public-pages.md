# The public guide pages

`/guides` and `/guides/<slug>` in `packages/web-v2` render the corpus
`packages/core/src/guides/registry.ts` holds. There is one source and two
renderings: the pages fetch `GET <core>/api/guides` at request time, and no
guide prose is stored in `web-v2`. Both surfaces are unauthenticated —
`guideRoutes` in `packages/core/src/guides/routes.ts` applies `requireAuth()`
only to its `/orgs` sub-tree — and the routes sit outside the `(workspace)`
group, whose layout redirects a signed-out visitor to `/login`.

The pages render per request rather than prerendered. A prerender would bake the
index into the image and make the image build fail wherever core is unreachable.

## Two things about Next that this shape is built around

Both were measured on the production standalone server the deploy runs
(`node .next/standalone/packages/web-v2/server.js`), against a core that delayed
every reply, during ISS-1124. Neither is inferable from the source.

**A `loading.tsx` is an ancestor Suspense boundary for every route beneath it,
and the shell it streams commits the HTTP status.** With the app's loading file
at `src/app/loading.tsx`, `/guides/<unknown-slug>` answered **200**: the shell
had gone out before the page awaited anything, so the later `notFound()` could
render a 404 page but not set a 404 status. Moving it to
`src/app/(workspace)/loading.tsx` — the routes that want it — makes the same
request answer **404**. Anything public added outside that group inherits this,
so a new boundary goes next to the routes that need one.

**`notFound()` raised in a dynamic route never server-renders its body.** Next
emits `<html id="__next_error__">` with an empty `<body>` and streams the
not-found UI as flight data, discarding the page's own `generateMetadata` with
it — the title and description come from the root layout. A browser renders the
page after hydration; curl, a crawler and a link preview get the status and
nothing else. Three shapes were tried and all three behaved the same: a client
`not-found.tsx` using `usePathname`, a synchronous server one, and `notFound()`
raised from `generateMetadata`. A middleware `rewrite` carrying `{ status: 404 }`
was also tried; the status is ignored and the response is 200.

## What answers an unknown slug

`src/middleware.ts`, because it is the only layer that can set a status and a
body together. Its `/guides` branch gates nobody; it refuses a slug
`isGuideSlug` rejects without asking core, asks core about the rest, and answers
a 404 with `missingGuideDocument` — a styleless HTML page naming the slug and
linking the index, with the slug escaped because it comes off the URL.

A client-side navigation is left alone: the router refetches the same URL with an
`RSC` header and would choke on an HTML document, and it has JavaScript by
definition, so `app/guides/[slug]/not-found.tsx` serves it. Both renderers read
one set of strings from `features/guides/missing.ts`.

`isGuideSlug` lives in `features/guides/requested-path.ts` and is read by the
middleware and by `features/guides/api.ts`. One test of what a slug is, because
two that disagree is a slug one passes and the other refuses:
`/guides/what-is-an-issue.md` was exactly that — core answers 200 for it, having
stripped the suffix, so it cleared the middleware and was then refused by the
page, landing back on the blank body.

The requested path reaches `not-found.tsx` on the `x-forge-guide-path` header the
middleware sets, because Next hands a not-found boundary no params and `headers()`
there carries only what the client sent.
