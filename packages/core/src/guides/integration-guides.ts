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
import type { IntegrationProvider } from '../integrations/index.js';
import { type ForgeGuide, getGuide as getCodeGuide, listGuides } from './registry.js';

export const INTEGRATION_GUIDE_SLUG_PREFIX = 'integration-';

/** `epodsystem` → `integration-epodsystem`. */
export function integrationGuideSlug(provider: string): string {
  return `${INTEGRATION_GUIDE_SLUG_PREFIX}${provider}`;
}

/** `integration-epodsystem` → `epodsystem`; null when the slug isn't one of ours. */
export function providerFromGuideSlug(slug: string): string | null {
  if (!slug.startsWith(INTEGRATION_GUIDE_SLUG_PREFIX)) return null;
  const provider = slug.slice(INTEGRATION_GUIDE_SLUG_PREFIX.length);
  return provider.length > 0 ? provider : null;
}

export interface IntegrationGuideRow {
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

/**
 * Body-free index for a caller: the code tier plus every integration guide the
 * org has authored. An org row for a provider that also has a code default
 * replaces that entry rather than appearing twice.
 */
export async function resolveGuideIndex(
  orgId: string | null,
): Promise<Array<Omit<ForgeGuide, 'body'>>> {
  const code = listGuides();
  if (!orgId) return code;

  const rows = await db
    .select({
      provider: integrationGuides.provider,
      title: integrationGuides.title,
      summary: integrationGuides.summary,
      version: integrationGuides.version,
    })
    .from(integrationGuides)
    .where(eq(integrationGuides.orgId, orgId));
  if (rows.length === 0) return code;

  const overrides = new Map(
    rows.map((r) => [
      integrationGuideSlug(r.provider),
      {
        slug: integrationGuideSlug(r.provider),
        audience: 'agent' as const,
        title: r.title,
        summary: r.summary,
        version: r.version,
      },
    ]),
  );
  const merged = code.map((g) => overrides.get(g.slug) ?? g);
  const seen = new Set(merged.map((g) => g.slug));
  for (const [slug, entry] of overrides) {
    if (!seen.has(slug)) merged.push(entry);
  }
  return merged;
}

/** Providers this org has a guide for — drives the "Full guide:" pointer. */
export async function loadOrgGuideProviders(orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ provider: integrationGuides.provider })
    .from(integrationGuides)
    .where(eq(integrationGuides.orgId, orgId));
  return new Set(rows.map((r) => r.provider));
}

export interface UpsertIntegrationGuideArgs {
  orgId: string;
  provider: IntegrationProvider;
  title: string;
  summary: string;
  body: string;
  updatedBy: string | null;
  /** Omit to auto-increment the stored version (or start at 1). */
  version?: number;
}

export async function upsertIntegrationGuide(
  args: UpsertIntegrationGuideArgs,
): Promise<IntegrationGuideRow> {
  const existing = await loadOrgGuide(args.orgId, args.provider);
  const version = args.version ?? (existing ? existing.version + 1 : 1);
  const now = new Date();

  const [row] = await db
    .insert(integrationGuides)
    .values({
      orgId: args.orgId,
      provider: args.provider,
      title: args.title,
      summary: args.summary,
      body: args.body,
      version,
      updatedBy: args.updatedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrationGuides.orgId, integrationGuides.provider],
      set: {
        title: args.title,
        summary: args.summary,
        body: args.body,
        version,
        updatedBy: args.updatedBy,
        updatedAt: now,
      },
    })
    .returning({
      provider: integrationGuides.provider,
      title: integrationGuides.title,
      summary: integrationGuides.summary,
      body: integrationGuides.body,
      version: integrationGuides.version,
      updatedAt: integrationGuides.updatedAt,
    });
  if (!row) throw new Error('integration_guides: upsert returned no row');
  return row;
}
