// Per-org integration guides — the runtime-editable tier that `registry.ts`
// deliberately does not cover. Why a guide about an external service lives in a
// table and not in code: docs/modules/guides/where-a-page-lives.md.
//
// Precedence: org row (if any) shadows the code default for that provider.
// Same shape as a project skill shadowing a global template.
//
// Slug space is shared with the code registry via `integration-<provider>`, so the two can never
// collide (no code guide may use that prefix). `GET /api/projects/:id/guides/<slug>.md` reads a
// slug as the project's org shadows it; the public `GET /api/guides/<slug>.md` knows the code tier only.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationGuides } from '../db/schema.js';
import { getGuide as getCodeGuide } from './registry.js';
import type { ForgeGuide } from './types.js';

const INTEGRATION_GUIDE_SLUG_PREFIX = 'integration-';

/** `epodsystem` → `integration-epodsystem`. */
export function integrationGuideSlug(provider: string): string {
  return `${INTEGRATION_GUIDE_SLUG_PREFIX}${provider}`;
}

/** `integration-epodsystem` → `epodsystem`; null when the slug isn't one of ours. */
function providerFromGuideSlug(slug: string): string | null {
  if (!slug.startsWith(INTEGRATION_GUIDE_SLUG_PREFIX)) return null;
  const provider = slug.slice(INTEGRATION_GUIDE_SLUG_PREFIX.length);
  return provider.length > 0 ? provider : null;
}

interface IntegrationGuideRow {
  provider: string;
  title: string;
  summary: string;
  body: string;
  version: number;
  updatedAt: Date;
}

async function loadOrgGuide(orgId: string, provider: string): Promise<IntegrationGuideRow | null> {
  const [row] = await db
    .select({
      provider: integrationGuides.provider,
      title: integrationGuides.title,
      summary: integrationGuides.summary,
      body: integrationGuides.body,
      version: integrationGuides.version,
      updatedAt: integrationGuides.updatedAt,
    })
    .from(integrationGuides)
    .where(and(eq(integrationGuides.orgId, orgId), eq(integrationGuides.provider, provider)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve one guide for a caller, layering the org override over the code
 * registry. `orgId` null (public REST, no tenant context) → code tier only.
 */
export async function resolveGuide(
  slug: string,
  orgId: string | null,
): Promise<ForgeGuide | undefined> {
  const provider = providerFromGuideSlug(slug);
  if (provider && orgId) {
    const row = await loadOrgGuide(orgId, provider);
    if (row) {
      return {
        slug,
        audience: 'agent',
        title: row.title,
        summary: row.summary,
        version: row.version,
        body: row.body,
      };
    }
  }
  return getCodeGuide(slug);
}
/** Providers this org has a guide for — drives the "Full guide:" pointer. */
export async function loadOrgGuideProviders(orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ provider: integrationGuides.provider })
    .from(integrationGuides)
    .where(eq(integrationGuides.orgId, orgId));
  return new Set(rows.map((r) => r.provider));
}
