/**
 * One structured line per call core makes to a GitLab host: which caller, what kind of path, the
 * status, and GitLab's own rate-limit answer (`RateLimit-*`, `Retry-After`). Core's egress address
 * is shared with every other app on its server, so a 429 has to be attributed to a caller from
 * these lines, not guessed (forge-core-61, 2026-10-30: 429s on the integration token from core while
 * the same token answered 200 from a box).
 */

import { logger } from '../../lib/logger.js';
import { rateLimitHeadersOf } from '../source-host/index.js';

/** A path with its identifiers folded, so lines group by kind: `/projects/:id/repository/commits/:sha`. */
export function gitlabPathKind(path: string): string {
  const [bare = ''] = path.split('?');
  return bare
    .replace(/^\/api\/v4/, '')
    .replace(/\/projects\/[^/]+/, '/projects/:id')
    .replace(/\/repository\/branches\/.+$/, '/repository/branches/:branch')
    .replace(/\/repository\/files\/[^/]+/, '/repository/files/:file')
    .replace(/\/[0-9a-f]{40}\b/g, '/:sha')
    .replace(/\/\d+\b/g, '/:n');
}

/** The first frame outside this integration's own plumbing: the code that asked for the call. */
export function gitlabCaller(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    const at = frame.match(
      /at (?:async )?(?:(\S+) \()?(?:file:\/\/)?[^()]*\/src\/([^():]+)\.[jt]s:\d+/,
    );
    if (!at) continue;
    const file = at[2] ?? '';
    if (file.startsWith('integrations/gitlab/') || file.startsWith('integrations/source-host/')) {
      continue;
    }
    return `${file}${at[1] ? `:${at[1]}` : ''}`;
  }
  return 'unknown';
}

/** Log one outbound GitLab call. A 429's body is kept (its first 300 characters), naming the limit. */
export function logGitLabCall(call: {
  caller: string;
  host: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  headers: Headers;
  body?: string;
}): void {
  logger.info(
    {
      gitlab: {
        caller: call.caller,
        host: call.host,
        method: call.method,
        kind: gitlabPathKind(call.path),
        status: call.status,
        ms: call.ms,
        ...rateLimitHeadersOf(call.headers),
        ...(call.body !== undefined ? { body: call.body.slice(0, 300) } : {}),
      },
    },
    'gitlab: call',
  );
}
