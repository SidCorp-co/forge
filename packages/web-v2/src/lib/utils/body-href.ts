
import { CORE_URL, coreFileUrl } from "./core-url";

/** The one segment that belongs to the core. */
const CORE_SEGMENT = "api";

const PARSE_BASE = "https://body.invalid/";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type BodyHref =
  /** `#section` or `?tab=history` — the same page, same tab, no origin. */
  | { kind: "anchor"; href: string }
  /** A path the web app serves. Same tab, same origin as the page. */
  | { kind: "in-app"; href: string }
  /** A file on the core. New tab, resolved against the core origin; `path` is the core's own, for the API client. */
  | { kind: "core-file"; href: string; path: string }
  | { kind: "external"; href: string; scheme: string }
  /** Neither origin can be derived. Refused, loudly, with this reason. */
  | { kind: "unresolvable"; href: string; reason: string };

function parsedPath(href: string): { path: string; rest: string } | null {
  try {
    const url = new URL(href, PARSE_BASE);
    return { path: url.pathname, rest: `${url.search}${url.hash}` };
  } catch {
    return null;
  }
}

/** An absolute address on the core's own origin is the core's file, read like the path it names (ISS-1229 r55 review). */
function onTheCore(href: string): BodyHref | null {
  const base = /^https?:\/\//i.test(CORE_URL) ? CORE_URL : typeof window === "undefined" ? null : window.location.origin;
  if (!base) return null;
  try {
    const url = new URL(href, base);
    if (url.origin !== new URL(base).origin || url.pathname.split("/")[1] !== CORE_SEGMENT) return null;
    const path = `${url.pathname}${url.search}`;
    return { kind: "core-file", href: coreFileUrl(path), path };
  } catch {
    return null;
  }
}

export function classifyBodyHref(href: string): BodyHref {
  if (!href) return { kind: "unresolvable", href, reason: "the link has no target" };
  if (href.startsWith("#") || href.startsWith("?")) return { kind: "anchor", href };
  if (href.startsWith("//")) return onTheCore(href) ?? { kind: "external", href, scheme: "" };

  const scheme = SCHEME.exec(href)?.[0];
  if (scheme) {
    const lower = scheme.toLowerCase();
    if (!SAFE_SCHEMES.has(lower)) return { kind: "unresolvable", href, reason: `${scheme} links are not opened from a body` };
    return (FILE_SCHEMES.has(lower) ? onTheCore(href) : null) ?? { kind: "external", href, scheme: lower };
  }

  const parsed = parsedPath(href);
  if (!parsed) return { kind: "unresolvable", href, reason: "not a path a browser can resolve" };

  const resolved = `${parsed.path}${parsed.rest}`;
  const first = parsed.path.split("/")[1] ?? "";
  if (first === CORE_SEGMENT) return { kind: "core-file", href: coreFileUrl(resolved), path: resolved };
  if (href.startsWith("/")) return { kind: "in-app", href: resolved };
  return {
    kind: "unresolvable",
    href,
    reason: "a relative path here belongs to neither the app nor the core",
  };
}

/** Schemes that can address a file. A protocol-relative URL takes the page's,
 *  which is one of these. */
const FILE_SCHEMES = new Set(["", "http:", "https:"]);

export function addressesAFile(target: BodyHref): boolean {
  if (target.kind === "in-app" || target.kind === "core-file") return true;
  return target.kind === "external" && FILE_SCHEMES.has(target.scheme);
}
