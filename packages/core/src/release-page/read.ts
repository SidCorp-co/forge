// One release as a reader reads it (REQ-40): a projection of the release record
// (`release-batch/release-read.ts:readRelease`) under one truth rule, plus the highlights the
// assistant drafted from it. The user view reads what changed for people; the developer view adds
// the technical notes (BC-9). The page is built from Forge's own records and nobody writes it (BC-12).

import {
  RELEASE_PAGE_REFUSAL_CODES,
  RELEASE_PAGE_VIEWS,
  type ReleaseHighlightFacts,
  type ReleaseHighlights,
  type ReleasePage,
  type ReleasePageRefusalCode,
  type ReleasePageViewKind,
  releaseEnded,
} from '@forge/contracts/release-page';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { HTTPException } from 'hono/http-exception';
import { listModulesForIssues, stallsOfRoster } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import {
  type ReleaseRecord,
  readRange,
  readReleaseRecord,
  readSurfaceMap,
  type ViewerFacts,
} from '../release-batch/index.js';
import {
  type ClaimReading,
  claimsOf,
  knownIssuesOf,
  mediaOf,
  requirementsOf,
  untracedOf,
} from './claims.js';
import { carriedRequirements, issueFiles, type RequirementText } from './facts.js';
import { digestOf, highlightFacts, highlightsRow, shownHighlights } from './highlights.js';
import { namingDraftStale, namingRow, namingStanding } from './naming-store.js';
import { releaseNamer } from './ports.js';
import { actionsOf, buildOf, changesOf, headerOf, technicalOf } from './sections.js';

export const refusePage = refuser<ReleasePageRefusalCode>(RELEASE_PAGE_REFUSAL_CODES[0]);

/** Who reads the page: the release record's viewer, and whether they may share it. */
export type PageViewer = (ViewerFacts & { mayShare: boolean }) | null;

/** The release record of `version`, or the page's own refusal where the project cut no such version. */
export async function releaseRecordOf(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseRecord> {
  try {
    return await readReleaseRecord(projectId, version, viewer);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      throw refusePage(
        'RELEASE_PAGE_NOT_FOUND',
        `project ${projectId} has no release ${version}: neither a version it cut nor the draft at its release gate`,
        '/version',
      );
    }
    throw err;
  }
}

export interface PageFacts {
  build: string | null;
  claims: ClaimReading[];
  requirements: RequirementText[];
  facts: ReleaseHighlightFacts;
  digest: string;
}

/**
 * Everything the page and its highlights read beyond the release record: its criteria as the record
 * weighed them (`claimsOf`), the count its header carries, and the files and requirement words.
 */
export async function pageFacts(projectId: string, record: ReleaseRecord): Promise<PageFacts> {
  const { detail } = record;
  const build = buildOf(detail);
  const claims = claimsOf(record.weighed);
  const [requirements, files] = await Promise.all([
    carriedRequirements(projectId, detail),
    issueFiles([...new Set(claims.map((c) => c.criterion.issueId))]),
  ]);
  const facts = highlightFacts(detail.version, requirements, claims, mediaOf(claims, files, build));
  return { build, claims, requirements, facts, digest: digestOf(facts) };
}

/** The highlights with the link a signed-in reader fetches each clip or picture by. */
function linked(highlights: ReleaseHighlights): ReleaseHighlights {
  if (highlights.state !== 'drafted') return highlights;
  return {
    ...highlights,
    highlights: highlights.highlights.map((h) =>
      h.media
        ? {
            ...h,
            media: {
              ...h.media,
              url: `/api/attachments/${h.media.attachmentId}/download`,
              ...(h.media.poster
                ? {
                    poster: {
                      ...h.media.poster,
                      url: `/api/attachments/${h.media.poster.attachmentId}/download`,
                    },
                  }
                : {}),
            },
          }
        : h,
    ),
  };
}

/**
 * What a known issue says to the reader of the view. The user view says the criterion's own wording
 * and its state; the verdict's reason, and the other build it was judged on, are QA's technical
 * words and belong to the developer view (BC-11).
 */
export function userKnownIssues(
  issues: ReleasePage['knownIssues'],
  view: ReleasePageViewKind,
): ReleasePage['knownIssues'] {
  if (view === 'developer') return issues;
  return issues.map((k) => ({ ...k, reason: null, elsewhere: null }));
}

/**
 * The screen each carried issue's change is met on, by issue key: its module, primary first
 * (ISS-1001). No record says which screen a change is on, and an issue's module is the smallest one
 * that does; an issue with none is left out, and its change reads with no screen.
 */
async function screensOf(detail: ReleaseDetail): Promise<Map<string, string>> {
  const modules = await listModulesForIssues(detail.issues.map((i) => i.id));
  return new Map(
    detail.issues.flatMap((i) => {
      const first = modules.get(i.id)?.[0];
      return first ? [[i.key, first.name] as const] : [];
    }),
  );
}

function withScreens<
  T extends { improvements: ReleasePage['improvements']; fixes: ReleasePage['fixes'] },
>(changes: T, screens: ReadonlyMap<string, string>): T {
  const on = (c: ReleasePage['improvements'][number]) => ({
    ...c,
    screen: screens.get(c.issueKey) ?? null,
  });
  return { ...changes, improvements: changes.improvements.map(on), fixes: changes.fixes.map(on) };
}

export function isPageView(view: string): view is ReleasePageViewKind {
  return (RELEASE_PAGE_VIEWS as readonly string[]).includes(view);
}

/**
 * The page of one release in one view. Where no stored draft answers today's facts, `onOwed` is
 * handed the release run so a refresh can be started; the page itself never waits on a model.
 */
export async function readReleasePage(args: {
  projectId: string;
  version: string;
  view: string;
  viewer: PageViewer;
  onOwed?: (run: { projectId: string; runId: string }) => void;
  /** Handed the release where nobody named it and no draft of its name is in flight or held (BC-14). */
  onNamingOwed?: (release: { projectId: string; version: string }) => void;
}): Promise<ReleasePage> {
  const { projectId, version, view, viewer } = args;
  if (!isPageView(view)) {
    throw refusePage(
      'RELEASE_PAGE_VIEW_UNKNOWN',
      `"${view}" is not a release page view: it is one of ${RELEASE_PAGE_VIEWS.join(', ')}`,
      '/view',
    );
  }
  const record = await releaseRecordOf(projectId, version, viewer);
  const { detail } = record;
  const page = await pageFacts(projectId, record);
  const row = detail.runId ? await highlightsRow(detail.runId) : null;
  const shown = shownHighlights(
    row,
    page.facts,
    page.digest,
    page.build,
    new Date(),
    releaseEnded(detail.state),
  );
  if (shown.owed && detail.runId) args.onOwed?.({ projectId, runId: detail.runId });
  const named = detail.name !== null && detail.summary !== null;
  const drafting = named ? null : await namingRow(projectId, detail.version);
  const naming = namingStanding(named, drafting);
  // naming takes project.admin, so the page says who that is while the release waits on it (ISS-590)
  const namer = named ? null : await releaseNamer(projectId);
  if (!named && (drafting === null || namingDraftStale(drafting)))
    args.onNamingOwed?.({ projectId, version: detail.version });
  const changes = withScreens(changesOf(detail, view), await screensOf(detail));
  const range = await readRange(projectId, detail.version, page.build, detail.runId);
  const { shipped } = range;
  const map = view === 'developer' && range.changed ? await readSurfaceMap(projectId) : null;
  return {
    view,
    projectId,
    header: {
      ...headerOf(detail),
      naming,
      ...(namer ? { namer } : {}),
    },
    highlights: linked(shown.highlights),
    requirements: requirementsOf(page.requirements, page.claims),
    untraced: untracedOf(page.requirements, page.claims),
    improvements: changes.improvements,
    fixes: changes.fixes,
    internal: changes.internal,
    withoutNotes: changes.withoutNotes,
    actionRequired: actionsOf(detail.changes, shipped, detail.notes),
    shipped,
    knownIssues: userKnownIssues(knownIssuesOf(page.claims), view),
    technical: view === 'developer' ? technicalOf(detail, range, map) : null,
    stalls: await stallsOfRoster(
      projectId,
      detail.issues.map((i) => i.id),
      detail.releasedAt,
    ),
    can: { share: viewer?.mayShare ?? false, export: true, approve: detail.can.decide },
  };
}
