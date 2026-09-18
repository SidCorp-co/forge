// Where a person goes to confirm that a chat account is theirs.
//
// One builder, for every adapter: the page reads `source` and `externalId` off
// the query and asks the same project-scoped endpoints the refusal used to name,
// so adding a transport adds nothing here. Kept out of any one integration's
// module for that reason — `rocketchat/connection-manager.ts` has its own copy of
// the base-url read for its own links, and a second adapter must not have to
// import that one to be linkable.

import { env } from '../../config/env.js';

// cm:guard a function and not a const: read at module scope this validated the whole environment on
// import, which is the ISS-1067 shape `connection-manager.ts:webBaseUrl` already carries a note about.
let cached: string | undefined;
let read = false;
function appBaseUrl(): string | undefined {
  if (!read) {
    cached = env.CORS_ORIGINS.split(',')[0]?.trim().replace(/\/+$/, '') || undefined;
    read = true;
  }
  return cached;
}

/** Only for tests that change the environment between cases. */
export function resetAppBaseUrlCache(): void {
  read = false;
  cached = undefined;
}

export interface SpeakerLinkTarget {
  projectId: string;
  source: string;
  externalId: string;
}

/**
 * The confirm page for one speaker, or null where this deployment does not know
 * its own web address — in which case a caller says the rest without a link
 * rather than printing a broken one.
 */
export function speakerLinkUrl(target: SpeakerLinkTarget): string | null {
  const base = appBaseUrl();
  if (!base) return null;
  const q = new URLSearchParams({
    projectId: target.projectId,
    source: target.source,
    externalId: target.externalId,
  });
  return `${base}/link-chat?${q.toString()}`;
}
