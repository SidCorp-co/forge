// Live theme discovery for a storefront. The stored connection config carries a
// theme id captured at healthcheck, which is the WRONG source for a draft: a
// draft is created mid-run by `customize_theme`, so anything cached is stale by
// construction and `draftThemeId` was consequently always null.
//
// Resolving live costs one round trip per call and is best-effort — a slow or
// down Epodsystem must degrade this to "unknown", never fail the tool.

import { logger } from '../../logger.js';
import { epodsystemGraphqlBase } from './endpoints.js';

const THEME_QUERY_TIMEOUT_MS = 5_000;
const VERSION_LIMIT = 5;

export type ThemeRole = 'main' | 'unpublished' | 'development';

export interface StorefrontTheme {
  id: string;
  name: string | null;
  role: ThemeRole | string | null;
  parentThemeId: string | null;
  publishedFilesVersionId: string | null;
}

export interface StorefrontThemeVersion {
  id: string;
  versionNumber: number | null;
  label: string | null;
  createdAt: string | null;
}

export interface StorefrontThemes {
  themes: StorefrontTheme[];
  /** The live theme (`role: 'main'`). */
  mainThemeId: string | null;
  /**
   * The reusable unpublished draft clone of the main theme. Null means no draft
   * exists yet — `customize_theme` has not run for this main.
   */
  draftThemeId: string | null;
  /** Recent snapshots of the main theme, newest first — the rollback inputs. */
  versions: StorefrontThemeVersion[];
}

const STORE_THEMES_QUERY = `query ForgeStoreThemes($sid: ID!) {
  storeThemes(store_id: $sid) { id name role parent_theme_id published_files_version_id }
}`;

const THEME_VERSIONS_QUERY = `query ForgeThemeVersions($tid: ID!, $limit: Int) {
  themeVersions(theme_id: $tid, limit: $limit) { id version_number label created_at }
}`;

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(epodsystemGraphqlBase(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(THEME_QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      logger.warn(
        { errors: body.errors.map((e) => e.message) },
        'epodsystem-themes: graphql returned errors',
      );
      return null;
    }
    return body.data ?? null;
  } catch (err) {
    logger.warn({ err }, 'epodsystem-themes: live theme query failed');
    return null;
  }
}

// cm:guard pick the draft by parent_theme_id pointing at the CURRENT main — a store can hold several `unpublished` themes (a demoted previous main is also `unpublished`, per publishDraftTheme), so role alone would hand back a backup and the caller would build on, or publish, the wrong theme
function pickDraft(themes: StorefrontTheme[], mainThemeId: string | null): string | null {
  if (!mainThemeId) return null;
  const clone = themes.find((t) => t.role === 'unpublished' && t.parentThemeId === mainThemeId);
  return clone?.id ?? null;
}

/**
 * Resolve a store's themes live. Returns null only when the query could not be
 * performed at all, so callers can fall back to their cached view and say so.
 */
export async function fetchStorefrontThemes(
  apiKey: string,
  storeId: string,
): Promise<StorefrontThemes | null> {
  const data = await gql<{
    storeThemes?: Array<{
      id?: string | number | null;
      name?: string | null;
      role?: string | null;
      parent_theme_id?: string | number | null;
      published_files_version_id?: string | number | null;
    }> | null;
  }>(apiKey, STORE_THEMES_QUERY, { sid: storeId });
  if (!data?.storeThemes) return null;

  const themes: StorefrontTheme[] = data.storeThemes
    .filter((t) => t.id !== null && t.id !== undefined)
    .map((t) => ({
      id: String(t.id),
      name: t.name ?? null,
      role: t.role ?? null,
      parentThemeId: t.parent_theme_id != null ? String(t.parent_theme_id) : null,
      publishedFilesVersionId:
        t.published_files_version_id != null ? String(t.published_files_version_id) : null,
    }));

  const mainThemeId = themes.find((t) => t.role === 'main')?.id ?? null;
  const draftThemeId = pickDraft(themes, mainThemeId);

  let versions: StorefrontThemeVersion[] = [];
  if (mainThemeId) {
    const v = await gql<{
      themeVersions?: Array<{
        id?: string | number | null;
        version_number?: number | null;
        label?: string | null;
        created_at?: string | null;
      }> | null;
    }>(apiKey, THEME_VERSIONS_QUERY, { tid: mainThemeId, limit: VERSION_LIMIT });
    versions = (v?.themeVersions ?? [])
      .filter((r) => r.id !== null && r.id !== undefined)
      .map((r) => ({
        id: String(r.id),
        versionNumber: r.version_number ?? null,
        label: r.label ?? null,
        createdAt: r.created_at ?? null,
      }));
  }

  return { themes, mainThemeId, draftThemeId, versions };
}
