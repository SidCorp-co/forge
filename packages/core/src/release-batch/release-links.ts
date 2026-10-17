// The pages a sentence about a release may send a reader to, instead of an API route (ISS-1421 r5).

import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

export interface ProjectPages {
  releaseRun(runId: string): string;
  issue(issueId: string): string;
  settings(query: string): string;
  /** Where a question asked on no issue waits for an answer. */
  attention: string;
}

function appBase(): string {
  return env.APP_BASE_URL.replace(/\/+$/, '');
}

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
