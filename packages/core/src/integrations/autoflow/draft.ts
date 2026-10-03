import { createHash } from 'node:crypto';
import type { StorefrontDraftReading, StorefrontTargetArgs } from '../types.js';
import { autoflowLiveRead } from './live-read.js';
import type { AutoflowConfig } from './types.js';

// cm:why Autoflow keeps one mutable `draft` graph per workflow and mints no id for it
// (`backend-go/internal/backendbuilder/delivery/graphql/schema/backendbuilder.graphql:BackendWorkflow`),
// so the draft version id is the sha-256 of the graph as core reads it, keys sorted: the same
// draft always reads as the same id, and any edit to it reads as another.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function autoflowDraftVersion(draft: unknown): string {
  return createHash('sha256').update(canonical(draft)).digest('hex');
}

const DRAFTS_QUERY = 'query ForgeAutoflowDrafts { backendWorkflows { id code draft } }';

interface DraftRow {
  id?: string | null;
  code?: string | null;
  draft?: unknown;
}

export async function autoflowStorefrontDraft(
  args: StorefrontTargetArgs & { workflowId: string },
): Promise<StorefrontDraftReading> {
  const config = args.config as AutoflowConfig;
  const read = await autoflowLiveRead(args, config, DRAFTS_QUERY);
  if (!read.ok) {
    return {
      kind: 'unreadable',
      detail: `Autoflow site \`${config.shop ?? 'unnamed'}\` answered no draft: ${read.reason}`,
    };
  }
  const rows = (read.data.backendWorkflows as DraftRow[] | null) ?? [];
  const row = rows.find((w) => w.id === args.workflowId);
  if (!row) {
    return {
      kind: 'missing',
      detail: `Autoflow site \`${config.shop ?? 'unnamed'}\` holds no workflow with id \`${args.workflowId}\` (it holds ${rows.length})`,
    };
  }
  return {
    kind: 'read',
    draftVersion: autoflowDraftVersion(row.draft),
    workflowCode: row.code ?? '',
  };
}
