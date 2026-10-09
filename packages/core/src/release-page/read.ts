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
} from '@forge/contracts/release-page';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { HTTPException } from 'hono/http-exception';
import { refuser } from '../lib/refusal.js';
import { readRelease, type ViewerFacts } from '../release-batch/index.js';
import { type ClaimReading, knownIssuesOf, mediaOf, readClaims, requirementsOf } from './claims.js';
import { carriedCriteria, carriedRequirements, issueFiles, type RequirementText } from './facts.js';
import { digestOf, highlightFacts, highlightsRow, shownHighlights } from './highlights.js';
import { actionsOf, buildOf, changesOf, headerOf, technicalOf } from './sections.js';

export const refusePage = refuser<ReleasePageRefusalCode>(RELEASE_PAGE_REFUSAL_CODES[0]);

/** Who reads the page: the release record's viewer, and whether they may share it. */
export type PageViewer = (ViewerFacts & { mayShare: boolean }) | null;

/** The release record of `version`, or the page's own refusal where the project cut no such version. */
export async function releaseDetailOf(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseDetail> {
  try {
    return await readRelease(projectId, version, viewer);
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

/** Everything the page and its highlights read beyond the release record, under the truth rule at the release's build. */
export async function pageFacts(projectId: string, detail: ReleaseDetail): Promise<PageFacts> {
  const build = buildOf(detail);
  const [criteria, requirements, files] = await Promise.all([
    carriedCriteria(detail),
    carriedRequirements(projectId, detail),
    issueFiles(detail.issues.map((i) => i.id)),
  ]);
  const claims = readClaims(criteria, build);
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
        ? { ...h, media: { ...h.media, url: `/api/attachments/${h.media.attachmentId}/download` } }
        : h,
    ),
  };
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
}): Promise<ReleasePage> {
  const { projectId, version, view, viewer } = args;
  if (!isPageView(view)) {
    throw refusePage(
      'RELEASE_PAGE_VIEW_UNKNOWN',
      `"${view}" is not a release page view: it is one of ${RELEASE_PAGE_VIEWS.join(', ')}`,
      '/view',
    );
  }
  const detail = await releaseDetailOf(projectId, version, viewer);
  const page = await pageFacts(projectId, detail);
  const row = detail.runId ? await highlightsRow(detail.runId) : null;
  const shown = shownHighlights(row, page.facts, page.digest, page.build);
  if (shown.owed && detail.runId) args.onOwed?.({ projectId, runId: detail.runId });
  const changes = changesOf(detail.notes);
  return {
    view,
    projectId,
    header: headerOf(detail),
    highlights: linked(shown.highlights),
    requirements: requirementsOf(page.requirements, page.claims),
    improvements: changes.improvements,
    fixes: changes.fixes,
    withoutNotes: changes.withoutNotes,
    actionRequired: actionsOf(detail.changes),
    knownIssues: knownIssuesOf(page.claims),
    technical: view === 'developer' ? technicalOf(detail) : null,
    can: { share: viewer?.mayShare ?? false, export: true, approve: detail.can.decide },
  };
}
