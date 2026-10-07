import type {
  StorefrontPageReading,
  StorefrontRouteReading,
  StorefrontSettingReading,
  StorefrontTargetArgs,
  StorefrontThemeReading,
} from '../index.js';
import { autoflowLiveRead } from './live-read.js';
import type { AutoflowConfig } from './types.js';

// What an Autoflow store serves beyond its workflows, read as the storefront itself reads it: routes
// by `is_published` (`backendbuilder.graphql:BackendRoute`), pages by their published state
// (`page.graphql:StorePage`), the theme from the published surface the storefront renders
// (`theme_file.graphql:publicResolvedTheme`, migration 000157) with each file's sha-256
// (`domain.ChecksumOf`), and settings from the store row (`organization.graphql:Store.settings`).

const ROUTES_QUERY =
  'query ForgeAutoflowRoutes { backendRoutes { id method path workflow_code is_published } }';

const pagesQuery = (storeId: string) =>
  `query ForgeAutoflowPages { storePages(store_id: ${JSON.stringify(storeId)}) { id handle slug is_published published_at has_unpublished_changes } }`;

const themeQuery = (slug: string) =>
  `query ForgeAutoflowTheme { publicResolvedTheme(store_slug: ${JSON.stringify(slug)}) { theme { id published_files_version_id } files { path checksum } } }`;

const snapshotQuery = (id: string) =>
  `query ForgeAutoflowThemeSnapshot { themeVersion(id: ${JSON.stringify(id)}) { id created_at } }`;

const settingsQuery = (storeId: string) =>
  `query ForgeAutoflowSettings { store(id: ${JSON.stringify(storeId)}) { id settings } }`;

interface RouteRow {
  id?: string | number | null;
  method?: string | null;
  path?: string | null;
  workflow_code?: string | null;
  is_published?: boolean | null;
}

interface PageRow {
  id?: string | number | null;
  handle?: string | null;
  slug?: string | null;
  is_published?: boolean | null;
  published_at?: string | null;
  has_unpublished_changes?: boolean | null;
}

interface ResolvedThemeRow {
  theme?: { id?: string | number | null; published_files_version_id?: string | null } | null;
  files?: Array<{ path?: string | null; checksum?: string | null }> | null;
}

const unreadableAll = <R>(ids: readonly string[], detail: string) =>
  new Map<string, R>(ids.map((id) => [id, { kind: 'unreadable', detail } as R]));

/** Each route named: whether the store holds it, and whether it answers live traffic. */
export async function servedRoutes(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
  site: string,
  routeIds: readonly string[],
): Promise<Map<string, StorefrontRouteReading>> {
  if (routeIds.length === 0) return new Map();
  const read = await autoflowLiveRead(args, config, ROUTES_QUERY);
  if (!read.ok) return unreadableAll(routeIds, `${site} answered no backend route: ${read.reason}`);
  const rows = (read.data.backendRoutes as RouteRow[] | null) ?? [];
  return new Map(
    routeIds.map((id): [string, StorefrontRouteReading] => {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) {
        return [
          id,
          { kind: 'missing', detail: `${site} holds no backend route with id \`${id}\`` },
        ];
      }
      return [
        id,
        {
          kind: row.is_published ? 'published' : 'unpublished',
          method: row.method ?? '',
          path: row.path ?? '',
          workflowCode: row.workflow_code ?? '',
        },
      ];
    }),
  );
}

/** Each page named: live or not, published when, and whether an unpublished draft waits on it. */
export async function servedPages(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
  site: string,
  pageIds: readonly string[],
): Promise<Map<string, StorefrontPageReading>> {
  if (pageIds.length === 0) return new Map();
  if (!config.storeId) {
    return unreadableAll(
      pageIds,
      `the production binding of ${site} records no \`storeId\`, so its pages cannot be read`,
    );
  }
  const read = await autoflowLiveRead(args, config, pagesQuery(config.storeId));
  if (!read.ok) return unreadableAll(pageIds, `${site} answered no page: ${read.reason}`);
  const rows = (read.data.storePages as PageRow[] | null) ?? [];
  return new Map(
    pageIds.map((id): [string, StorefrontPageReading] => {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) {
        return [
          id,
          {
            kind: 'missing',
            detail: `${site} holds no page with id \`${id}\` on store ${config.storeId}`,
          },
        ];
      }
      const handle = row.handle ?? row.slug ?? '';
      if (!row.is_published) return [id, { kind: 'unpublished', handle }];
      return [
        id,
        {
          kind: 'published',
          handle,
          publishedAt: row.published_at ?? null,
          unpublishedChanges: row.has_unpublished_changes === true,
        },
      ];
    }),
  );
}

/**
 * The theme the storefront serves now, its published files by path, and when the snapshot that
 * surface points at was taken — one read of the live tree, one of its snapshot.
 */
export async function servedTheme(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
  site: string,
): Promise<StorefrontThemeReading> {
  const slug = config.storeSlug ?? config.shop;
  if (!slug) {
    return {
      kind: 'unreadable',
      detail: `the production binding of ${site} records no store slug, so the theme it serves cannot be read`,
    };
  }
  const read = await autoflowLiveRead(args, config, themeQuery(slug));
  if (!read.ok)
    return { kind: 'unreadable', detail: `${site} answered no served theme: ${read.reason}` };
  const resolved = read.data.publicResolvedTheme as ResolvedThemeRow | null | undefined;
  const themeId = resolved?.theme?.id;
  if (themeId == null) {
    return { kind: 'unreadable', detail: `${site} serves no theme on store \`${slug}\`` };
  }
  const files = new Map<string, string>();
  for (const f of resolved?.files ?? []) {
    if (f.path && f.checksum) files.set(f.path, f.checksum.toLowerCase());
  }
  const snapshot = resolved?.theme?.published_files_version_id;
  let publishedAt: string | null = null;
  if (snapshot) {
    const at = await autoflowLiveRead(args, config, snapshotQuery(String(snapshot)));
    if (!at.ok) {
      return {
        kind: 'unreadable',
        detail: `${site} answered no snapshot \`${snapshot}\` of served theme \`${themeId}\`: ${at.reason}`,
      };
    }
    const row = at.data.themeVersion as { created_at?: string | null } | null | undefined;
    publishedAt = row?.created_at ?? null;
  }
  return { kind: 'served', themeId: String(themeId), publishedAt, files };
}

/** A setting value written as JSON scalars are, so `false` and `"false"` read alike. */
function settingText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The store row's settings: a JSON object, sent as one or as its text; null where it is neither. */
function settingsObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Each store setting named, as the store row holds it now. */
export async function servedSettings(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
  site: string,
  keys: readonly string[],
): Promise<Map<string, StorefrontSettingReading>> {
  if (keys.length === 0) return new Map();
  if (!config.storeId) {
    return unreadableAll(
      keys,
      `the production binding of ${site} records no \`storeId\`, so its settings cannot be read`,
    );
  }
  const read = await autoflowLiveRead(args, config, settingsQuery(config.storeId));
  if (!read.ok) return unreadableAll(keys, `${site} answered no store settings: ${read.reason}`);
  const store = read.data.store as { settings?: unknown } | null | undefined;
  const settings = settingsObject(store?.settings);
  if (!settings) {
    return unreadableAll(
      keys,
      `store ${config.storeId} of ${site} answered settings that are not an object`,
    );
  }
  return new Map(
    keys.map((key): [string, StorefrontSettingReading] =>
      Object.hasOwn(settings, key)
        ? [key, { kind: 'value', value: settingText(settings[key]) }]
        : [
            key,
            {
              kind: 'missing',
              detail: `store ${config.storeId} of ${site} holds no setting \`${key}\``,
            },
          ],
    ),
  );
}
