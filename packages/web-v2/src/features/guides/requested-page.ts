// What an address on `/guides` asks for. The middleware and the page both read it, so a plain
// request and a client-side navigation refuse the same addresses in the same words:
// docs/modules/guides/public-pages.md.
import { type Audience, isAudience } from "./audience";
import { missingDoor, missingPage, PAGE_AND_DOOR, type Refusal } from "./missing";

export type PublicRequest =
  | { kind: "landing" }
  | { kind: "door"; audience: Audience }
  | { kind: "page"; slug: string }
  | { kind: "refused"; refusal: Refusal };

export function readPublicRequest(
  params: URLSearchParams,
  helpSlugs: readonly string[],
): PublicRequest {
  const path = params.get("path");
  const door = params.get("for");
  if (path !== null && door !== null) return { kind: "refused", refusal: PAGE_AND_DOOR };
  if (path !== null) {
    return helpSlugs.includes(path)
      ? { kind: "page", slug: path }
      : { kind: "refused", refusal: missingPage(path) };
  }
  if (door !== null) {
    return isAudience(door)
      ? { kind: "door", audience: door }
      : { kind: "refused", refusal: missingDoor(door) };
  }
  return { kind: "landing" };
}

/** Next's `searchParams` prop as the `URLSearchParams` the middleware reads, repeated keys kept
 *  in order so both take the first. */
export function toSearchParams(
  record: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  return params;
}
