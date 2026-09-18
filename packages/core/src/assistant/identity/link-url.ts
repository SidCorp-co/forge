// Where a person goes to confirm that a chat account is theirs.
//
// One builder, for every adapter: the page reads `source` and `externalId` off
// the query and asks the same project-scoped endpoints the refusal used to name,
// so adding a transport adds nothing here. Kept out of any one integration's
// module for that reason — `rocketchat/connection-manager.ts` has its own copy of
// the base-url read for its own links, and a second adapter must not have to
// import that one to be linkable.

import { env } from '../../config/env.js';

// cm:guard `APP_BASE_URL` and NOT the first `CORS_ORIGINS` entry, which this read before it was
// corrected: CORS is a list of origins allowed to CALL the API, in whatever order a deployment
// happened to write them — a desktop `tauri://localhost` sitting first would have put a link nobody
// can open in front of every unlinked speaker. `APP_BASE_URL` is the one variable that names the web
// frontend, and `projects/invitation-email.ts:invitationUrl` builds its accept link off the same one.
// cm:guard a function and not a const: read at module scope this validated the whole environment on
// import, which is the ISS-1067 shape `connection-manager.ts:webBaseUrl` already carries a note about.
function appBaseUrl(): string {
  return env.APP_BASE_URL.replace(/\/+$/, '');
}

export interface SpeakerLinkTarget {
  projectId: string;
  source: string;
  externalId: string;
}

/** The confirm page for one speaker, on this deployment's own web frontend. */
export function speakerLinkUrl(target: SpeakerLinkTarget): string {
  const q = new URLSearchParams({
    projectId: target.projectId,
    source: target.source,
    externalId: target.externalId,
  });
  return `${appBaseUrl()}/link-chat?${q.toString()}`;
}
