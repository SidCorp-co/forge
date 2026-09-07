import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, knowledgeEntries, labels } from '../db/schema.js';
import { logger } from '../logger.js';
import { type Actor, safeRecordActivity } from '../pipeline/activity.js';

/**
 * ISS-948 (Tier 3a of ISS-587) — the module knowledge refresh loop.
 *
 * When work lands against an issue, the knowledge node of that issue's primary module is brought
 * up to date without anyone remembering to, and the modules it also touched are marked as
 * touched. The asymmetry is the epic's: the primary gets the full refresh because there is exactly
 * one of it and therefore never a question about which node to update; secondaries get an append
 * and nothing else.
 *
 * anhome wires this same loop inside its own skill body. That is the per-project convention this
 * makes engine behaviour, and the reason nothing here reads a `module-<slug>` name: the node is
 * resolved through `labels.knowledge_entry_id`, which is the column ISS-947 added to replace the
 * name-prefix convention.
 */

/**
 * The claim `metadata.moduleFlow` makes, in one sentence: *as of the node body that hashes to
 * `bodyHash`, the stored flow is behind the work of `staleByIssueId`, and has been since
 * `staleSince`.*
 */
export interface ModuleFlowRecord {
  staleSince: string;
  staleByIssueId: string;
  bodyHash: string;
}

export interface ModuleKnowledgeRefreshInput {
  issueId: string;
  projectId: string;
  actor: Actor;
}

interface AttributedModule {
  labelId: string;
  slug: string | null;
  knowledgeEntryId: string | null;
  isPrimary: boolean;
}

export function moduleNodeBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// cm:guard the hash comparison IS the idempotency and IS the self-clearing, in one branch — the same issue landing twice reads the same body and returns `prev` untouched, and an author who redraws the flow changes the body so the next landing re-arms against it. Replace it with an unconditional re-stamp and the record starts moving on every replay; drop the re-arm and a redrawn flow stays marked behind forever.
// cm:why nothing ever clears this record and nothing needs to: a reader treats it as live ONLY while the node's CURRENT body still hashes to `bodyHash`, so a redrawn flow reads as current without a second writer having to notice. A `staleUntilCleared` boolean would need that writer, and there is none.
/**
 * The record this landing leaves on the primary's node.
 *
 * `prev` survives when the body has not changed since it was written — that is the same issue
 * landing again, or a second issue landing against a flow already known to be behind, and
 * `staleByIssueId` keeps naming the landing that first got there.
 */
export function nextModuleFlowRecord(
  prev: ModuleFlowRecord | null,
  bodyHash: string,
  issueId: string,
  now: Date,
): ModuleFlowRecord {
  if (prev && prev.bodyHash === bodyHash) return prev;
  return { staleSince: now.toISOString(), staleByIssueId: issueId, bodyHash };
}

function readFlowRecord(metadata: unknown): ModuleFlowRecord | null {
  const flow = (metadata as { moduleFlow?: unknown } | null)?.moduleFlow as
    | Partial<ModuleFlowRecord>
    | undefined;
  if (
    typeof flow?.staleSince !== 'string' ||
    typeof flow.staleByIssueId !== 'string' ||
    typeof flow.bodyHash !== 'string'
  ) {
    return null;
  }
  return {
    staleSince: flow.staleSince,
    staleByIssueId: flow.staleByIssueId,
    bodyHash: flow.bodyHash,
  };
}

async function loadAttributedModules(issueId: string): Promise<AttributedModule[]> {
  return db
    .select({
      labelId: labels.id,
      slug: labels.slug,
      knowledgeEntryId: labels.knowledgeEntryId,
      isPrimary: issueLabels.isPrimary,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(and(eq(issueLabels.issueId, issueId), eq(labels.kind, 'module')));
}

/** Append the issue to the node's related issues, and say whether it was already there. */
async function appendRelatedIssue(
  nodeId: string,
  projectId: string,
  issueId: string,
): Promise<{ nodeId: string; appended: boolean } | null> {
  const [node] = await db
    .select({ relatedIssueIds: knowledgeEntries.relatedIssueIds })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, nodeId), eq(knowledgeEntries.projectId, projectId)))
    .limit(1);
  if (!node) return null;

  const related = (Array.isArray(node.relatedIssueIds) ? node.relatedIssueIds : []) as string[];
  if (related.includes(issueId)) return { nodeId, appended: false };

  await db
    .update(knowledgeEntries)
    .set({ relatedIssueIds: [...related, issueId], updatedAt: new Date() })
    .where(eq(knowledgeEntries.id, nodeId));
  return { nodeId, appended: true };
}

async function refreshPrimaryNode(
  nodeId: string,
  projectId: string,
  issueId: string,
  now: Date,
): Promise<{ nodeId: string; appended: boolean; flow: ModuleFlowRecord } | null> {
  const [node] = await db
    .select({
      body: knowledgeEntries.body,
      metadata: knowledgeEntries.metadata,
      relatedIssueIds: knowledgeEntries.relatedIssueIds,
    })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, nodeId), eq(knowledgeEntries.projectId, projectId)))
    .limit(1);
  if (!node) return null;

  const related = (Array.isArray(node.relatedIssueIds) ? node.relatedIssueIds : []) as string[];
  const appended = !related.includes(issueId);
  const flow = nextModuleFlowRecord(
    readFlowRecord(node.metadata),
    moduleNodeBodyHash(node.body),
    issueId,
    now,
  );
  const metadata = { ...((node.metadata as Record<string, unknown> | null) ?? {}) };
  metadata.moduleFlow = flow;

  await db
    .update(knowledgeEntries)
    .set({
      ...(appended ? { relatedIssueIds: [...related, issueId] } : {}),
      metadata,
      updatedAt: now,
    })
    .where(eq(knowledgeEntries.id, nodeId));
  return { nodeId, appended, flow };
}

// cm:guard NEVER insert a `knowledge_entries` row from here — a module with no binding is the legal state "no node written yet" (`labels_knowledge_entry_chk`, ISS-947), and creating one under a guessed name is the failure `labels.slug` exists to remove, so the loop declines and says so in the issue's activity feed, which is where an operator reads it.
// cm:guard never throws and never rethrows: a refresh that fails must not fail the issue's own pipeline, and the caller (`pipeline/issue-context-store.ts`) has already committed the handoff by the time this runs. Reported through the log AND the activity feed, never swallowed.
/**
 * Refresh the knowledge of the modules this issue is attributed to.
 *
 * An issue with no primary module refreshes nothing and is not an error — an unattributed issue is
 * legal at every status, and this loop must not make it illegal by the back door.
 */
export async function refreshModuleKnowledgeForIssue(
  input: ModuleKnowledgeRefreshInput,
): Promise<void> {
  const { issueId, projectId, actor } = input;
  try {
    const attributed = await loadAttributedModules(issueId);
    const primary = attributed.find((m) => m.isPrimary);
    if (!primary) return;

    const now = new Date();
    const skipped: Array<{ slug: string | null; reason: string }> = [];
    let primaryResult: { nodeId: string; appended: boolean; flow: ModuleFlowRecord } | null = null;

    if (primary.knowledgeEntryId === null) {
      skipped.push({ slug: primary.slug, reason: 'no_knowledge_node' });
    } else {
      primaryResult = await refreshPrimaryNode(primary.knowledgeEntryId, projectId, issueId, now);
      if (!primaryResult) skipped.push({ slug: primary.slug, reason: 'node_not_in_project' });
    }

    const touched: Array<{ slug: string | null; nodeId: string; appended: boolean }> = [];
    for (const secondary of attributed.filter((m) => !m.isPrimary)) {
      if (secondary.knowledgeEntryId === null) {
        skipped.push({ slug: secondary.slug, reason: 'no_knowledge_node' });
        continue;
      }
      const result = await appendRelatedIssue(secondary.knowledgeEntryId, projectId, issueId);
      if (!result) {
        skipped.push({ slug: secondary.slug, reason: 'node_not_in_project' });
        continue;
      }
      touched.push({ slug: secondary.slug, ...result });
    }

    await safeRecordActivity({
      issueId,
      actor,
      action: 'module_knowledge_refreshed',
      payload: {
        primary: {
          slug: primary.slug,
          nodeId: primaryResult?.nodeId ?? null,
          appended: primaryResult?.appended ?? false,
          flowStaleSince: primaryResult?.flow.staleSince ?? null,
        },
        touched,
        skipped,
      },
    });
  } catch (err) {
    logger.error({ err, issueId, projectId }, 'module knowledge refresh failed');
    await safeRecordActivity({
      issueId,
      actor,
      action: 'module_knowledge_refresh_failed',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
