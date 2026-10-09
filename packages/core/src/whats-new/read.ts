/**
 * What's new (REQ-40 BC-10): the release this instance serves, shown once per person. The release
 * is the one of the instance's own product project whose commit the running build is
 * (`serving.ts`); a person owes a look at it where it is newer than the one they last closed it on
 * in this environment (`whatsNewReleaseOwed`). What is read of it is its highlights and its lines:
 * the requirements it proves and its known issues stay on the release page of the people who may
 * read that project.
 */

import { WHATS_NEW_SEEN_KEY, type WhatsNewSeenValue } from '@forge/contracts/product-state';
import { type ReleasePage, whatsNewReleaseOwed } from '@forge/contracts/release-page';
import type { WhatsNewFeed, WhatsNewRelease, WhatsNewSummary } from '@forge/contracts/whats-new';
import { readProductState } from '../preferences/index.js';
import { readReleasePage, refreshInBackground, ticketedHighlights } from '../release-page/index.js';
import { requireServing, type ServingRelease } from './serving.js';

async function seenOf(userId: string): Promise<WhatsNewSeenValue['release'] | null> {
  const state = await readProductState(userId, WHATS_NEW_SEEN_KEY);
  return (state.value as WhatsNewSeenValue | null)?.release ?? null;
}

const owedOf = (
  seen: WhatsNewSeenValue['release'] | null,
  environment: string,
  release: ServingRelease | null,
) => whatsNewReleaseOwed(seen ?? null, release ? { environment, version: release.version } : null);

/** Whether this person owes a look at the serving release, without reading the release itself. */
export async function readWhatsNewSummary(args: { userId: string }): Promise<WhatsNewSummary> {
  const serving = await requireServing();
  const seen = await seenOf(args.userId);
  return {
    environment: serving.environment,
    release: serving.release
      ? {
          version: serving.release.version,
          owed: owedOf(seen, serving.environment, serving.release),
        }
      : null,
  };
}

function changesOf(page: ReleasePage): WhatsNewRelease['changes'] {
  return [...page.improvements, ...page.fixes].map((c) => ({ kind: c.kind, line: c.line }));
}

/** The serving release as one person reads it: its highlights, with each clip linked for them, and its lines. */
export async function readWhatsNew(args: { userId: string }): Promise<WhatsNewFeed> {
  const serving = await requireServing();
  const { release } = serving;
  if (!release) return { environment: serving.environment, release: null };
  const [seen, page] = await Promise.all([
    seenOf(args.userId),
    readReleasePage({
      projectId: release.projectId,
      version: release.version,
      view: 'user',
      viewer: null,
      onOwed: refreshInBackground,
    }),
  ]);
  return {
    environment: serving.environment,
    release: {
      version: release.version,
      releasedAt: page.header.releasedAt,
      owed: owedOf(seen, serving.environment, release),
      highlights: await ticketedHighlights(page.highlights, release.projectId, args.userId),
      changes: changesOf(page),
    },
  };
}
