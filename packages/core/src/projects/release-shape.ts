import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { type PreviewShape, previewShapes, projects } from '../db/schema.js';
import { type NormalizedEnvironments, normalizeEnvironments } from './environments.js';

/**
 * The one PATCH field this rule judges, declared beside it rather than in the route.
 */
export const releaseShapePatchFields = {
  previewShape: z.enum(previewShapes).optional(),
} as const;

export const PREVIEW_IS_LIVE_HOST = 'PREVIEW_IS_LIVE_HOST';
export const PREVIEW_SHAPE_LOCAL_WITH_HOST = 'PREVIEW_SHAPE_LOCAL_WITH_HOST';
export const PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST = 'PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST';

/** A refusal ANSWERED rather than thrown, as `release-model.ts` does: the rule does not know it is
 *  serving HTTP. */
export interface ReleaseShapeGap {
  code: string;
  message: string;
}

/** The authority of a URL, lowercased, or null where the string is not one. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function hosts(...urls: (string | null)[]): string[] {
  return urls.map(hostOf).filter((h): h is string => h !== null);
}

/** Every host the preview side names, the labelled testing rows included. */
function previewHosts(env: NormalizedEnvironments): string[] {
  if (!env.preview) return [];
  return hosts(env.preview.url, env.preview.apiUrl, ...env.preview.urls.map((u) => u.url));
}

function liveHosts(env: NormalizedEnvironments): string[] {
  return hosts(env.live.url, env.live.apiUrl);
}

/** The first host both sides name, or null where they name none in common. */
export function sharedHost(env: NormalizedEnvironments): string | null {
  const live = new Set(liveHosts(env));
  return previewHosts(env).find((h) => live.has(h)) ?? null;
}

function collision(host: string): ReleaseShapeGap {
  return {
    code: PREVIEW_IS_LIVE_HOST,
    message: `\`environments.preview\` names \`${host}\`, which is also what \`environments.live\` names — so what this project calls its preview side IS its live side, and a run sent to "the preview" would be exercising production. That configuration is refused rather than stored; it was live on forge-dev until 2026-09-22 and every reader that asked whether the project had a preview was told yes by it. Clear the preview side and declare \`previewShape: "local"\` if work here is exercised on the run's own box, or point the preview side at a host live does not serve.`,
  };
}

const LOCAL_WITH_HOST: ReleaseShapeGap = {
  code: PREVIEW_SHAPE_LOCAL_WITH_HOST,
  message:
    '`previewShape: "local"` says work on this project is exercised on the run\'s own box, and `environments.preview` names a deployed host — the two cannot both be true, and a reader asking where to exercise a change would get one answer from the declaration and another from the blob. Send `previewShape: "deployed"` if that host is a real preview deployment, or clear `environments.preview` to null.',
};

const DEPLOYED_WITHOUT_HOST: ReleaseShapeGap = {
  code: PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST,
  message:
    '`previewShape: "deployed"` says a preview deployment is where work on this project is exercised, and `environments.preview` names no host to send anyone to. Give the preview side a `url` or an `apiUrl`, or declare `previewShape: "local"` — which is the normal shape for a one-box project, not a degraded one.',
};

/** What is wrong with this configuration, judged as one thing. The collision comes first because it
 *  is the line to delete: a preview side on live's host is wrong under either declaration. */
export function shapeGapOf(
  shape: PreviewShape,
  environments: NormalizedEnvironments,
): ReleaseShapeGap | null {
  const shared = sharedHost(environments);
  if (shared) return collision(shared);
  if (shape === 'local' && environments.preview) return LOCAL_WITH_HOST;
  if (shape === 'deployed' && !environments.preview) return DEPLOYED_WITHOUT_HOST;
  return null;
}

const SHAPE_KEYS = ['previewShape', 'environments'] as const;

/**
 * The rule applied to the configuration the write would LEAVE BEHIND, never to the body: a caller
 * may send either field alone, and judging the body lets a project reach a contradiction in two
 * legal writes. Read FOR UPDATE inside the caller's transaction, so the value judged is the value
 * overwritten — outside it, two writes touching one side each both pass against the row as it was.
 */
export async function releaseShapeGap(
  projectId: string,
  updates: Record<string, unknown>,
  tx: Tx = db,
): Promise<ReleaseShapeGap | null> {
  if (!SHAPE_KEYS.some((k) => k in updates)) return null;
  const [row] = await tx
    .select({ previewShape: projects.previewShape, environments: projects.environments })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!row) return null;
  const shape = (updates.previewShape as PreviewShape | undefined) ?? row.previewShape;
  const raw = 'environments' in updates ? updates.environments : row.environments;
  return shapeGapOf(shape, normalizeEnvironments(raw));
}

/** The same rule as a throw, for a writer whose caller has no place to put an answered refusal. */
export async function assertReleaseShape(
  projectId: string,
  updates: Record<string, unknown>,
  tx: Tx = db,
): Promise<void> {
  const gap = await releaseShapeGap(projectId, updates, tx);
  if (gap) throw new Error(`${gap.code}: ${gap.message}`);
}
