// Which release shipped each issue of a requirement, read off the release runs the pipeline owns
// (`pipeline/release-runs.ts:shippedReleasesOf`), so a requirement and its issues name the release
// that delivered them (FB-102).

import { type ShippedRelease, shippedReleasesOf } from '../pipeline/index.js';

export { type ShippedRelease, shippedReleasesOf };

/** Each release that shipped one of its issues, once, oldest ship first. */
export function releasesOf(shipped: ReadonlyMap<string, ShippedRelease>): ShippedRelease[] {
  const byVersion = new Map([...shipped.values()].map((r) => [r.version, r]));
  return [...byVersion.values()].sort((a, b) => a.at.localeCompare(b.at));
}
