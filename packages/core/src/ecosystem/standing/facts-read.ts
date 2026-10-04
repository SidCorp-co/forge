import type { FeedbackStatus } from '@forge/contracts/feedback';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { holds, permissionFactsOf } from '../../permissions/index.js';
import { versionsOf } from '../contract/store.js';
import type { StandingViewer, VersionFact } from './standing.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];

export const refOf = (providerSlug: string, slug: string) => `${providerSlug}/${slug}`;

export async function viewerOf(projectId: string, userId: string | null): Promise<StandingViewer> {
  if (!userId) return { decides: () => false, acts: false };
  const facts = await permissionFactsOf(userId, projectId);
  const decides = holds(facts, 'contracts.approve');
  return { decides: () => decides, acts: holds(facts, 'feedback.approve') };
}

export async function versionFacts(
  providerIds: readonly string[],
): Promise<Map<string, VersionRow[]>> {
  const out = new Map<string, VersionRow[]>();
  for (const v of await versionsOf(db, providerIds)) {
    const key = `${v.providerProjectId}/${v.contractSlug}`;
    out.set(key, [
      ...(out.get(key) ?? []),
      {
        version: v.version,
        recordedAt: v.recordedAt,
        classification: v.document.diff.classification,
        approval: v.approval,
        decidedAt: v.decidedAt,
        previous: v.document.previous ?? null,
        changes: v.document.diff.changes.map((c) => ({
          element: c.element,
          kind: c.kind,
          level: c.level,
          text: c.text,
        })),
        decisionReason: v.decisionReason,
      },
    ]);
  }
  return out;
}

export type VersionRow = VersionFact & {
  previous: string | null;
  changes: { element: string; kind: string; level: string; text: string }[];
  decisionReason: string | null;
};

// cm:why every consumer's item for one version carries the same due date (`contract/announce.ts:fileBreakingIn` computes it once per approval), so the latest one stands for the provider's window
export async function windowDues(providerId: string): Promise<Map<string, Date>> {
  const found = rowsOf<{ contract_slug: string; contract_version: string; due: string }>(
    await db.execute(sql`
      SELECT contract_slug, contract_version, max(due_at) AS due
        FROM feedback
       WHERE contract_provider_project_id = ${providerId} AND kind = 'contract_change'
         AND due_at IS NOT NULL
       GROUP BY contract_slug, contract_version`),
  );
  return new Map(found.map((r) => [`${r.contract_slug}@${r.contract_version}`, new Date(r.due)]));
}

export interface ChangeRow {
  key: string;
  title: string;
  status: FeedbackStatus;
  providerId: string;
  slug: string;
  version: string;
  dueAt: Date | null;
  createdAt: Date;
}

export const OPEN_CHANGE: readonly FeedbackStatus[] = ['new', 'triaged', 'reopened'];

export async function changeItems(projectId: string): Promise<ChangeRow[]> {
  const found = rowsOf<{
    fb_seq: number;
    title: string;
    status: FeedbackStatus;
    provider: string;
    contract_slug: string;
    contract_version: string;
    due_at: string | null;
    created_at: string;
  }>(
    await db.execute(sql`
      SELECT fb_seq, title, status, contract_provider_project_id AS provider, contract_slug,
             contract_version, due_at, created_at
        FROM feedback
       WHERE project_id = ${projectId} AND kind = 'contract_change'
       ORDER BY created_at DESC`),
  );
  return found.map((f) => ({
    key: `FB-${f.fb_seq}`,
    title: f.title,
    status: f.status,
    providerId: f.provider,
    slug: f.contract_slug,
    version: f.contract_version,
    dueAt: f.due_at ? new Date(f.due_at) : null,
    createdAt: new Date(f.created_at),
  }));
}
