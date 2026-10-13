# The public guide pages

`/guides` and `/guides/<slug>` in `packages/web-v2` are Forge's public documentation: one set of
pages from two homes, behind two doors named for the reader. Both homes are unauthenticated —
`guideRoutes` in `packages/core/src/guides/routes.ts` applies `requireAuth()` only to its
`/projects` sub-tree, and the help pages are a static module bundled into the web build — and the routes sit
outside the `_workspace` layout (`packages/web-v2/src/routes/_workspace/route.tsx`), which sends a
signed-out visitor to `/login`.

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
Each guide carries the `audience` core declared for it, which `coreAudience` (called by `fromGuide`)
reads and refuses where it is missing or not `agent`.

The addresses: `/guides` is the landing — the sentence saying the corpus is one, the search, the
two doors. `/guides?for=<audience>` is a door. `/guides?path=<slug>` is a help page, the same
`?path=` form help pages already link each other by, resolved there by `Markdown`'s `docRoute`.
`/guides/<slug>` is an agent guide at the address it always had. The reader is the in-app `/docs`
screen's own furniture, `packages/web-v2/src/features/docs/components/docs-reader.tsx`, not a second reading UI.

The pages are drawn in the browser: the web is a single-page app core serves, and the agent pages
are fetched by the route's loader when it is entered.

## What answers an unknown slug, page or door

A plain request (a reader opening the address, curl, a crawler, a link preview) is answered by core
before the web loads: `guidesGate` in `packages/core/src/web-host/gates.ts`, because a single-page
app's every address is the same 200 document and only the server can set a status and a body
together. It gates nobody. On `/guides` it reads the query with `readPublicRequest`
(`packages/contracts/src/guide-addresses.ts`): a `path` naming no help page, a `for` naming no door,
or an address carrying both, answers 404 with `refusalDocument`. It learns the help slugs from the
web build's `web-host.json` (written by `packages/web-v2/vite.config.ts` from
`packages/web-v2/src/features/docs/help-slugs.generated.json`), so core carries no help page. On
`/guides/<slug>` it refuses a slug `GUIDE_SLUG` rejects, looks the rest up in core's own guide
registry in-process, and answers a 404 with `refusalDocument` naming the slug — a styleless HTML page
linking the index, with the slug escaped because it comes off the URL.

A navigation inside the web never reaches core: the route's loader finds no guide and the page
shows `packages/web-v2/src/routes/guides/$slug/-not-found.tsx`, and `/guides` shows the refusal in
its content pane. Both renderers read one set of strings from
`packages/contracts/src/guide-addresses.ts`, which `packages/web-v2/src/features/guides/missing.ts`
re-exports.

`GUIDE_SLUG` is read by core's gate and by `packages/web-v2/src/features/guides/api.ts`. One test of
what a slug is, because two that disagree is a slug one passes and the other refuses:
`/guides/what-is-an-issue.md` was exactly that. An address whose last segment names a file
(`/guides/<slug>.md`) is never a page: core's web host passes it to core's own routes, which answer
the markdown.

`slugFromGuidePath` returns the slug exactly as the page's own route param will hold it, for the
same reason: it does not trim, because `/guides/%20what-is-an-issue%20` trimmed looks like a real
guide to the gate and does not to the page. A suffix that will not decode is kept raw for
`GUIDE_SLUG` to refuse, rather than thrown over.

## The markdown address

The guide pages and the markdown are served by the same core, so a bare `/api/guides` in the
page's own prose answers on the reader's origin. The footer in
`packages/web-v2/src/features/guides/components/guide-shell.tsx`, the agent door and each agent
page's notice (`guideMarkdownUrl` in `packages/web-v2/src/features/guides/corpus.ts`), and
`MISSING_GUIDE_BODY` in `packages/web-v2/src/features/guides/missing.ts` still build the address
with `coreFileUrl` (`packages/web-v2/src/lib/utils/core-url.ts`), which stays right if the web is
ever built to call a core on another origin (`VITE_API_URL`).
