// When a release nobody named is named (REQ-40 BC-14): on its cut (`release.cut`, emitted in the
// cut's own transaction, so the auto-cut on entering the release gate owes it as any cut does), on
// every move of its run, and on a read of its page that finds it unnamed, drafts included. Each
// trigger asks; the release's own name decides whether anything is owed. A draft is single-flight,
// and one that was refused is kept with why, said on the page and tried again only after a while,
// so a release never reads as silently unnamed.

import { namingHasFacts } from '@forge/contracts/release-naming';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { background } from '../lib/background.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { consume } from '../outbox/index.js';
import { draftNaming, nameUnnamedRelease } from '../release-batch/index.js';
import { carriedRequirements } from './facts.js';
import { draftReleaseNaming, type NamingOutcome, namingFacts } from './naming-draft.js';
import { claim, clearRow, namingDraftStale, namingRow, settleFailed } from './naming-store.js';
import { releaseDetailOf } from './read.js';

export type NamingRefreshOutcome =
  | 'already_named'
  | 'not_a_release'
  | 'in_flight'
  | 'held'
  | 'nothing_to_say'
  | 'named'
  | Exclude<NamingOutcome['kind'], 'drafted'>;

type Drafter = typeof draftReleaseNaming;

/**
 * Names the release drafted or cut as `version` where nobody has: drafts its name and summary from
 * what it carries and writes them where a person's would go. A release carrying nothing a user sees
 * and no requirement is refused by name, as is a draft the model could not write; neither is ever
 * left as a silent null.
 */
export async function nameReleaseIfOwed(
  projectId: string,
  version: string,
  draft: Drafter = draftReleaseNaming,
): Promise<NamingRefreshOutcome> {
  if ((await draftNaming(projectId, version)) !== null) {
    await clearRow(projectId, version);
    return 'already_named';
  }
  const kept = await namingRow(projectId, version);
  if (kept && !namingDraftStale(kept)) return kept.state === 'failed' ? 'held' : 'in_flight';
  let detail: Awaited<ReturnType<typeof releaseDetailOf>>;
  try {
    detail = await releaseDetailOf(projectId, version, null);
  } catch (err) {
    if (isRefusal(err, 'RELEASE_PAGE_NOT_FOUND')) return 'not_a_release';
    throw err;
  }
  if (!(await claim(projectId, version))) {
    return (await namingRow(projectId, version))?.state === 'failed' ? 'held' : 'in_flight';
  }
  const facts = namingFacts(detail, await carriedRequirements(projectId, detail));
  if (!namingHasFacts(facts)) {
    await settleFailed(
      projectId,
      version,
      [
        {
          code: 'RELEASE_NAMING_NOTHING_TO_SAY',
          path: '',
          detail: `${version} carries no change its users see and advances no requirement, so nothing names it: a project admin names it (PUT /api/projects/${projectId}/releases/${version}/naming)`,
        },
      ],
      null,
    );
    return 'nothing_to_say';
  }
  const outcome = await draft(projectId, facts);
  if (outcome.kind === 'drafted') {
    try {
      const written = await nameUnnamedRelease(projectId, version, outcome.naming);
      await clearRow(projectId, version);
      return written;
    } catch (err) {
      // the draft's version went on under another number while it was drafted: nothing to name
      if (!isRefusal(err, 'RELEASE_VERSION_UNKNOWN')) throw err;
      await clearRow(projectId, version);
      return 'not_a_release';
    }
  }
  const refusals = outcome.kind === 'refused' ? outcome.refusals : [outcome.refusal];
  await settleFailed(projectId, version, refusals, outcome.model);
  return outcome.kind;
}

const namings = background();

/** Starts a naming no request waits on, for a page read that found its release unnamed. */
export function nameInBackground(release: { projectId: string; version: string }): void {
  namings.start(
    () => nameReleaseIfOwed(release.projectId, release.version),
    (err) => logger.warn({ err, ...release }, 'release-page: a release naming draft failed'),
  );
}

/** Settles every naming started in the background, for a caller that must not leave one running. */
export const backgroundNamingsSettled = (): Promise<void> => namings.settled();

async function versionOfRun(runId: string): Promise<string | null> {
  const [run] = await db
    .select({ version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run?.version ?? null;
}

export function registerReleaseNaming(): void {
  consume('release.cut', {
    name: 'release-naming',
    handle: async (p) => {
      await nameReleaseIfOwed(p.projectId, p.version);
    },
  });
  consume('run.transitioned', {
    name: 'release-naming',
    handle: async (p) => {
      const version = await versionOfRun(p.id);
      if (version) await nameReleaseIfOwed(p.projectId, version);
    },
  });
}
