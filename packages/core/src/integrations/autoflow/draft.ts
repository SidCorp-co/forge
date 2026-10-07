import { createHash } from 'node:crypto';
import { stableStringify } from '../../lib/canonical-json.js';
import type { StorefrontDraftReading, StorefrontTargetArgs } from '../index.js';
import { autoflowLiveRead } from './live-read.js';
import type { AutoflowConfig } from './types.js';

// Autoflow keeps one mutable `draft` graph per workflow and mints no id for it
// (`backend-go/internal/backendbuilder/delivery/graphql/schema/backendbuilder.graphql:BackendWorkflow`),
// so the draft version id is the sha-256 of the graph as core reads it, keys sorted: the same
// draft always reads as the same id, and any edit to it reads as another.
export function autoflowDraftVersion(draft: unknown): string {
  return createHash('sha256')
    .update(stableStringify(draft ?? null))
    .digest('hex');
}

const DRAFTS_QUERY = 'query ForgeAutoflowDrafts { backendWorkflows { id code draft } }';

interface DraftRow {
  id?: string | null;
  code?: string | null;
  draft?: unknown;
}

/** The draft Autoflow holds now of each workflow named, every one from a single read of the site. */
export async function autoflowStorefrontDrafts(
  args: StorefrontTargetArgs & { workflowIds: readonly string[] },
): Promise<Map<string, StorefrontDraftReading>> {
  const config = args.config as AutoflowConfig;
  const read = await autoflowLiveRead(args, config, DRAFTS_QUERY);
  if (!read.ok) {
    const refused: StorefrontDraftReading = {
      kind: 'unreadable',
      detail: `Autoflow site \`${config.shop ?? 'unnamed'}\` answered no draft: ${read.reason}`,
    };
    return new Map(args.workflowIds.map((id) => [id, refused]));
  }
  const rows = (read.data.backendWorkflows as DraftRow[] | null) ?? [];
  return new Map(
    args.workflowIds.map((workflowId): [string, StorefrontDraftReading] => {
      const row = rows.find((w) => w.id === workflowId);
      if (!row) {
        return [
          workflowId,
          {
            kind: 'missing',
            detail: `Autoflow site \`${config.shop ?? 'unnamed'}\` holds no workflow with id \`${workflowId}\` (it holds ${rows.length})`,
          },
        ];
      }
      return [
        workflowId,
        {
          kind: 'read',
          draftVersion: autoflowDraftVersion(row.draft),
          workflowCode: row.code ?? '',
        },
      ];
    }),
  );
}
