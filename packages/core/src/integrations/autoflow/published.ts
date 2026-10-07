import type { StorefrontPublishedReading, StorefrontTargetArgs } from '../index.js';
import { autoflowDraftVersion } from './draft.js';
import { autoflowLiveRead } from './live-read.js';
import type { AutoflowConfig } from './types.js';

// Autoflow keeps `published` beside `draft` on each workflow and archives every graph a publish
// replaced, with when it went live (`backendbuilder.graphql:BackendWorkflowVersion`); both are
// marshalled from the one graph type a draft is, so a published graph reads in the draft's identity.
// It keeps no deployment and no commit, which is why a storefront release is proved here.

const PUBLISHED_QUERY =
  'query ForgeAutoflowPublished { backendWorkflows { id code version published_at published } }';

interface PublishedRow {
  id?: string | null;
  code?: string | null;
  version?: number | null;
  published_at?: string | null;
  published?: unknown;
}

interface VersionRow {
  graph?: unknown;
  published_at?: string | null;
}

const versionsQuery = (codes: readonly string[]) =>
  `query ForgeAutoflowVersions { ${codes
    .map(
      (code, i) =>
        `v${i}: backendWorkflowVersions(code: ${JSON.stringify(code)}) { graph published_at }`,
    )
    .join(' ')} }`;

const earliest = (times: readonly string[]) =>
  times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));

/**
 * What Autoflow publishes now of each workflow named: the live graph's identity, its version, and
 * the first time that graph went live, from one read of the workflows and one of their archives.
 */
export async function autoflowStorefrontPublished(
  args: StorefrontTargetArgs & { workflowIds: readonly string[] },
): Promise<Map<string, StorefrontPublishedReading>> {
  const config = args.config as AutoflowConfig;
  const site = `Autoflow site \`${config.shop ?? 'unnamed'}\``;
  const every = (detail: string) =>
    new Map<string, StorefrontPublishedReading>(
      args.workflowIds.map((id) => [id, { kind: 'unreadable', detail }]),
    );
  const read = await autoflowLiveRead(args, config, PUBLISHED_QUERY);
  if (!read.ok) return every(`${site} answered no published workflow: ${read.reason}`);
  const rows = (read.data.backendWorkflows as PublishedRow[] | null) ?? [];
  const named = args.workflowIds.map((id) => ({ id, row: rows.find((w) => w.id === id) }));
  const live = named.filter(
    (n): n is { id: string; row: PublishedRow } => n.row?.published != null && !!n.row.code,
  );
  let archives: Record<string, unknown> = {};
  if (live.length > 0) {
    const versions = await autoflowLiveRead(
      args,
      config,
      versionsQuery(live.map((n) => n.row.code as string)),
    );
    if (!versions.ok) {
      return every(`${site} answered no version history of its workflows: ${versions.reason}`);
    }
    archives = versions.data;
  }
  return new Map(
    named.map(({ id, row }): [string, StorefrontPublishedReading] => {
      if (!row) {
        return [
          id,
          {
            kind: 'missing',
            detail: `${site} holds no workflow with id \`${id}\` (it holds ${rows.length})`,
          },
        ];
      }
      const code = row.code ?? '';
      if (row.published == null) return [id, { kind: 'unpublished', workflowCode: code }];
      if (!row.published_at || typeof row.version !== 'number') {
        return [
          id,
          {
            kind: 'unreadable',
            detail: `${site} publishes workflow \`${id}\` (\`${code}\`) with no ${row.published_at ? 'version' : 'publish time'}, so nothing says when that graph went live`,
          },
        ];
      }
      const graphVersion = autoflowDraftVersion(row.published);
      const at = live.findIndex((n) => n.id === id);
      const archived = (archives[`v${at}`] as VersionRow[] | null | undefined) ?? [];
      const sameGraph = archived
        .filter((v) => v.published_at && autoflowDraftVersion(v.graph) === graphVersion)
        .map((v) => v.published_at as string);
      return [
        id,
        {
          kind: 'published',
          workflowCode: code,
          version: row.version,
          publishedAt: row.published_at,
          graphVersion,
          firstLiveAt: earliest([row.published_at, ...sameGraph]),
        },
      ];
    }),
  );
}
