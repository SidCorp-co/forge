// Which origin a body's href or src belongs to. One rule, called by both body
// renderers (`design/patterns/markdown.tsx` and `design/patterns/body-view.tsx`
// through `design/patterns/body-link.tsx`), because a body is written once and
// rendered two ways and the two must not drift.
//
// The split is `/api` against everything else, and it rests on a property of
// core rather than a guess about the web app: every file URL core emits is
// under `/api/`, and core mounts no file route outside it. So the complement of
// `/api` is the web origin's, which covers an app route and a static asset alike
// with no route list to keep in step with `src/app`.

// cm:edge contract -> packages/core/src/index.ts — core's non-`/api` mounts are the health routes, `/mcp`, `installRoutes`, `guideRoutes` and the `/pair` redirect, and none of them serves a file a body can reference. A file route added there outside `/api` makes `CORE_SEGMENT` below wrong, and a body link to it would render in-app instead of against the core.
import { coreFileUrl } from "./core-url";

/** The one segment that belongs to the core. */
const CORE_SEGMENT = "api";

/** Any base with a path root: only `pathname`, `search` and `hash` are read off
 *  the parse, so the host is never part of an answer. */
const PARSE_BASE = "https://body.invalid/";

/** Schemes a body may navigate to. `javascript:` and `data:` are deliberately
 *  absent — an href carrying either is refused rather than rendered. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type BodyHref =
  /** `#section` — the same page, same tab, no origin. */
  | { kind: "anchor"; href: string }
  /** A path the web app serves. Same tab, same origin as the page. */
  | { kind: "in-app"; href: string }
  /** A file on the core. New tab, resolved against the core origin. */
  | { kind: "core-file"; href: string }
  /** An absolute URL, or a `mailto:`/`tel:`. New tab, as written. */
  | { kind: "external"; href: string }
  /** Neither origin can be derived. Refused, loudly, with this reason. */
  | { kind: "unresolvable"; href: string; reason: string };

/** The path a browser would use, with the dot segments already resolved. Returns
 *  null where the parser refuses the href. */
function parsedPath(href: string): { path: string; rest: string } | null {
  try {
    const url = new URL(href, PARSE_BASE);
    return { path: url.pathname, rest: `${url.search}${url.hash}` };
  } catch {
    return null;
  }
}

/**
 * Which origin an href written inside a body belongs to.
 *
 * The order matters. Dot segments are resolved by the WHATWG parser before the
 * segment is read, because that is what the browser applies to the URL
 * `coreFileUrl` builds today: `coreFileUrl("./api/x/download")` yields
 * `{core}/./api/x/download`, which the browser collapses to a working core URL,
 * so a rule reading the first segment of the raw string would break a link that
 * works. The parser collapses `.`, `..`, `%2e` and `%2e%2e` alike and leaves
 * `%2f` encoded, so an escaped separator is never mistaken for one.
 *
 * Whether the href was WRITTEN root-relative is read off the original string,
 * before the parse, because `docs/guide` and `/docs/guide` normalize to one path
 * and only the second names an app route.
 */
export function classifyBodyHref(href: string): BodyHref {
  if (!href) return { kind: "unresolvable", href, reason: "the link has no target" };
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (href.startsWith("//")) return { kind: "external", href };

  const scheme = SCHEME.exec(href)?.[0];
  if (scheme) {
    return SAFE_SCHEMES.has(scheme.toLowerCase())
      ? { kind: "external", href }
      : { kind: "unresolvable", href, reason: `${scheme} links are not opened from a body` };
  }

  const parsed = parsedPath(href);
  if (!parsed) return { kind: "unresolvable", href, reason: "not a path a browser can resolve" };

  const resolved = `${parsed.path}${parsed.rest}`;
  const first = parsed.path.split("/")[1] ?? "";
  if (first === CORE_SEGMENT) return { kind: "core-file", href: coreFileUrl(resolved) };
  if (href.startsWith("/")) return { kind: "in-app", href: resolved };
  return {
    kind: "unresolvable",
    href,
    reason: "a relative path here belongs to neither the app nor the core",
  };
}
