// A Forge link a room agent gives a person opens the web app, never the API host (ISS-1250): the epod
// thread was handed https://forge-dev-api.sidcorp.co/projects/epod/requirements/REQ-11 on 16/11, a
// page the API host does not serve. The API's public origins are this core's (`PUBLIC_API_BASE_URL`,
// `OAUTH_REDIRECT_BASE`), less any the web app is served on; a post linking one is refused by name,
// naming the same path on the web app.

import { env } from '../lib/env.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** The hosts the web app is served on: its base and every origin it admits. */
function webHosts(): Set<string> {
  const origins = [env.APP_BASE_URL, ...env.CORS_ORIGINS.split(',').map((o) => o.trim())];
  return new Set(origins.map(hostOf).filter((h): h is string => h !== null));
}

/** The API's public hosts that are not also the web app's. */
export function apiHosts(): string[] {
  const web = webHosts();
  const api = [env.PUBLIC_API_BASE_URL, env.OAUTH_REDIRECT_BASE].map(hostOf);
  return [...new Set(api.filter((h): h is string => h !== null && !web.has(h)))];
}

const LINK = /https?:\/\/[^\s<>()"'`]+/giu;

/** The first link in `text` on one of `hosts`, or null where it holds none. */
export function apiHostLinkIn(text: string, hosts: readonly string[]): string | null {
  if (hosts.length === 0) return null;
  for (const [link] of text.matchAll(LINK)) {
    if (hosts.includes(hostOf(link) ?? '')) return link;
  }
  return null;
}

/** The same page on the web app: the link with its origin swapped for the web app's. */
export function onWeb(link: string, web: string): string {
  const url = new URL(link);
  return `${web}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Null where the post may go; otherwise the refusal, recorded on the thread with nothing posted,
 * naming the link and the web app's page in its place.
 */
export async function apiHostLinkRefusal(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  tool: string,
): Promise<Outcome<never> | null> {
  const link = apiHostLinkIn(text, apiHosts());
  if (!link) return null;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'refused',
    actorKind: 'session',
    tool,
    input: { text },
    output: { code: 'SUPPORT_API_HOST_LINK', link },
  });
  const web = webBaseUrl() ?? env.APP_BASE_URL.replace(/\/+$/, '');
  return no(
    'SUPPORT_API_HOST_LINK',
    '/text',
    `nothing was posted: ${link} is on Forge's API host, which serves no page to a person. Link the web app instead: ${onWeb(link, web)}.`,
  );
}
