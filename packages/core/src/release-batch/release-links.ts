// The addresses of a project's pages that a sentence about a release may carry, so a reader is sent
// to a page and a button they have rather than to an API route (ISS-1421 r5). One builder, so the
// paths here cannot drift from the web's routes one sentence at a time.

import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

export interface ProjectPages {
  /** `/projects/<slug>/releases/<runId>`: what the release is doing, and what it did. */
  releaseRun(runId: string): string;
  /** `/projects/<slug>/issues/<issueId>`: where its open questions are answered. */
  issue(issueId: string): string;
  /** `/projects/<slug>/settings?<query>`. */
  settings(query: string): string;
  /** `/attention`: where a question asked on no issue waits for an answer. */
  attention: string;
}

function appBase(): string {
  return env.APP_BASE_URL.replace(/\/+$/, '');
}

/** The pages of a project, or `null` where its slug cannot be read: a sentence then carries none. */
export async function projectPages(projectId: string): Promise<ProjectPages | null> {
  try {
    const [row] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.slug) return null;
    const base = appBase();
    const project = `${base}/projects/${encodeURIComponent(row.slug)}`;
    return {
      releaseRun: (runId) => `${project}/releases/${encodeURIComponent(runId)}`,
      issue: (issueId) => `${project}/issues/${encodeURIComponent(issueId)}`,
      settings: (query) => `${project}/settings?${query}`,
      attention: `${base}/attention`,
    };
  } catch {
    return null;
  }
}
