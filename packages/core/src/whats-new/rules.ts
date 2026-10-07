import {
  digestWordCount,
  type PutWhatsNewDigestRequest,
  WHATS_NEW_DIGEST_WORDS_MAX,
} from '@forge/contracts/whats-new';
import type { Refusal } from '../lib/refusal.js';

/** A project route of What's new serves the platform project only. */
export function notPlatformRefusal(projectId: string, platformId: string): Refusal | null {
  return projectId === platformId
    ? null
    : {
        code: 'WHATS_NEW_NOT_PLATFORM_PROJECT',
        path: '',
        detail: `project ${projectId} is not Forge's own project; What's new reads and writes only the project FORGE_PLATFORM_PROJECT_ID names`,
      };
}

/** What a digest names that its week does not hold, its length, and a week not yet begun. */
export function digestRefusals(args: {
  week: string;
  from: Date;
  now: Date;
  request: PutWhatsNewDigestRequest;
  weekKeys: readonly string[];
}): Refusal[] {
  const { week, from, now, request, weekKeys } = args;
  const out: Refusal[] = [];
  if (from.getTime() > now.getTime()) {
    out.push({
      code: 'WHATS_NEW_WEEK_AHEAD',
      path: '',
      detail: `${week} starts ${from.toISOString()}, after now; a digest summarises a week that has begun`,
    });
  }
  const words = digestWordCount(request.body);
  if (words > WHATS_NEW_DIGEST_WORDS_MAX) {
    out.push({
      code: 'WHATS_NEW_DIGEST_TOO_LONG',
      path: '/body',
      detail: `the body is ${words} words; a digest is at most ${WHATS_NEW_DIGEST_WORDS_MAX}`,
    });
  }
  const held = new Set(weekKeys);
  const holds =
    weekKeys.length > 0
      ? `that week's entries are ${weekKeys.join(', ')}`
      : 'that week has no entries';
  request.entryKeys.forEach((key, i) => {
    if (!held.has(key)) {
      out.push({
        code: 'WHATS_NEW_DIGEST_FOREIGN_ENTRY',
        path: `/entryKeys/${i}`,
        detail: `${key} is not an entry of ${week}: ${holds}`,
      });
    }
  });
  return out;
}
