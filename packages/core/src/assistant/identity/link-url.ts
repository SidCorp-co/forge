import { env } from '../../config/env.js';

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
