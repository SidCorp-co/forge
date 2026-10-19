/**
 * The Sentry projects a token can see, for the settings form's target picker (ISS-1380).
 *
 * Sentry cannot scope a token to one project, so what this lists is everything the token reads and
 * the per-project boundary is Forge's: a project's binding holds the targets it picked, and nothing
 * else is reachable through it. The listing answers metadata only — never the token.
 *
 * A failure is a refusal that names its cause. An empty list is an answer ("this token reads no
 * project"), and returning one for a rejected token, an unreachable host or a body that is not a
 * list would be the same sentence for four different facts.
 */

import { attemptSentryCall, SentryAnswerNotJson, type SentryAttempt } from './call.js';
import { sentryOrganizationsUrl, sentryOrgProjectsUrl } from './endpoints.js';
import { nextSentryCursor } from './listing.js';
import { SentryRefusal } from './refusals.js';

/** The most organizations one listing walks. */
export const SENTRY_PROJECTS_MAX_ORGS = 20;
/** The most pages one organization's listing walks (Sentry answers up to 100 projects a page). */
export const SENTRY_PROJECTS_MAX_PAGES = 10;
/** The most projects one answer carries; the picker is a list for a person, not an export. */
export const SENTRY_PROJECTS_MAX = 500;

export interface SentryProjectChoice {
  organizationSlug: string;
  slug: string;
  name: string | null;
  platform: string | null;
}

export interface SentryProjectListing {
  projects: SentryProjectChoice[];
  /** True where Sentry held more than this answer carries, at one of the bounds above. */
  truncated: boolean;
}

export interface SentryProjectsAuth {
  host: string;
  authToken: string;
  /** The retained token of a rotation still inside its overlap window, tried once on a 401. */
  previousAuthToken?: string;
}

interface Page {
  body: unknown;
  link: string | null;
}

function scrubbedOf(message: string, auth: SentryProjectsAuth): string {
  let out = message;
  for (const secret of [auth.authToken, auth.previousAuthToken]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

async function readPage(url: string, auth: SentryProjectsAuth): Promise<Page> {
  let res: SentryAttempt;
  try {
    res = await attemptSentryCall(url, auth.authToken, 'GET');
    if (res.kind === 'refused' && res.status === 401 && auth.previousAuthToken) {
      res = await attemptSentryCall(url, auth.previousAuthToken, 'GET');
    }
  } catch (err) {
    if (err instanceof SentryAnswerNotJson) {
      throw new SentryRefusal('unreadable_answer', `sentry: GET ${url} — ${err.message}`, {
        httpStatus: err.status,
      });
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new SentryRefusal(
      'sentry_unreachable',
      scrubbedOf(`sentry: could not reach Sentry — GET ${url} — ${reason}`, auth),
    );
  }
  if (res.kind !== 'ok') {
    throw new SentryRefusal(res.refusal, `sentry: GET ${url} — ${res.reason}`, {
      httpStatus: res.status,
    });
  }
  return { body: res.body, link: res.link };
}

function listOf(page: Page, url: string): unknown[] {
  if (Array.isArray(page.body)) return page.body;
  throw new SentryRefusal(
    'unreadable_answer',
    `sentry: GET ${url} answered ${page.body === null ? 'null' : typeof page.body}, and this listing has to be an array`,
  );
}

function slugOf(
  entry: unknown,
  url: string,
  what: string,
): Record<string, unknown> & { slug: string } {
  const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
  if (!row || typeof row.slug !== 'string' || row.slug === '') {
    throw new SentryRefusal(
      'unreadable_answer',
      `sentry: GET ${url} answered a ${what} with no slug, so it cannot be offered as a target`,
    );
  }
  return row as Record<string, unknown> & { slug: string };
}

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

async function organizationsOf(
  auth: SentryProjectsAuth,
): Promise<{ slugs: string[]; truncated: boolean }> {
  const url = sentryOrganizationsUrl(auth.host);
  const page = await readPage(url, auth);
  const slugs = listOf(page, url).map((o) => slugOf(o, url, 'organization').slug);
  if (slugs.length === 0) {
    throw new SentryRefusal(
      'no_organization',
      `sentry: the token reads no organization on ${auth.host}, so there is no project to list — check the token's organization membership`,
    );
  }
  return {
    slugs: slugs.slice(0, SENTRY_PROJECTS_MAX_ORGS),
    truncated: slugs.length > SENTRY_PROJECTS_MAX_ORGS || nextSentryCursor(page.link) !== null,
  };
}

/**
 * The projects of one organization when `organizationSlug` names it, else of every organization the
 * token lists, each answered beside the organization it belongs to — a target needs both.
 */
export async function listSentryProjects(
  auth: SentryProjectsAuth,
  organizationSlug?: string,
): Promise<SentryProjectListing> {
  const orgs = organizationSlug
    ? { slugs: [organizationSlug], truncated: false }
    : await organizationsOf(auth);
  const projects: SentryProjectChoice[] = [];
  let truncated = orgs.truncated;

  for (const org of orgs.slugs) {
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      const url = sentryOrgProjectsUrl(auth.host, org, cursor);
      const page = await readPage(url, auth);
      for (const entry of listOf(page, url)) {
        const row = slugOf(entry, url, 'project');
        if (projects.length >= SENTRY_PROJECTS_MAX) return { projects, truncated: true };
        projects.push({
          organizationSlug: org,
          slug: row.slug,
          name: textOrNull(row.name),
          platform: textOrNull(row.platform),
        });
      }
      const next = nextSentryCursor(page.link);
      if (next === null) break;
      if (pages + 1 >= SENTRY_PROJECTS_MAX_PAGES) {
        truncated = true;
        break;
      }
      cursor = next;
    }
  }
  return { projects, truncated };
}
