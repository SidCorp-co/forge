import { broadcast, sendToDevice } from '../services/websocket';
import { sendWebhook } from '../services/webhook';
import { upsertEmbedding, removeEmbeddings, sanitizeContent } from '../services/embeddings';
import { enrichEntitiesWithLLM } from '../services/entity-index';
import { extractIssueEdges, syncRelationsToEdges } from '../services/knowledge-graph';
import { autoPopulateRelations, unblockDependents, syncInverseRelations } from './issue-relations';
import { DONE_ENOUGH_STATUSES } from '../services/pipeline-utils';
import { recomputeRollingStats } from '../services/rolling-summary';
import { onStatusChange as triggerPipelineStep } from '../services/pipeline-orchestrator';
import { embedSessionContext } from '../services/session-context-embedder';

const TRACKED_FIELDS = ['status', 'priority', 'title', 'category'] as const;

const ACTIVITY_UID = 'api::activity.activity' as any;

// Ordered forward progression — index determines rank.
const STATUS_ORDER: string[] = [
  'draft', 'open', 'confirmed', 'clarified', 'waiting', 'approved',
  'in_progress', 'developed', 'deploying', 'testing', 'staging', 'released', 'closed',
];

// These transitions are always allowed regardless of order.
const ALLOWED_BACKWARD: Record<string, string[]> = {
  reopen:    ['testing', 'staging', 'released', 'closed', 'developed'],
  needs_info: STATUS_ORDER,
  on_hold:   STATUS_ORDER,
  draft:     ['open'],
};

function isTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;
  // Special statuses that can be reached from anywhere
  if (ALLOWED_BACKWARD[to]?.includes(from)) return true;
  // Returning from special statuses is always allowed (e.g. needs_info → open)
  if (ALLOWED_BACKWARD[from] && !STATUS_ORDER.includes(from)) return true;
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return true;
  return toIdx >= fromIdx;
}

const FIELD_TO_ACTIVITY_TYPE: Record<string, string> = {
  status: 'status_change',
  priority: 'priority_change',
  title: 'title_change',
  category: 'category_change',
};

export function subscribeIssueLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: ['api::issue.issue'],

    async afterCreate(event: any) {
      const { result } = event;
      broadcast('issue:created', { documentId: result.documentId, title: result.title });

      // Create "created" activity
      setImmediate(() => {
        createActivity(strapi, {
          type: 'created',
          issue: result.documentId,
          actor: getActor(strapi),
        });
      });

      setImmediate(() => {
        embedIssue(strapi, result).catch((err: any) =>
          strapi.log.warn(`[embed] issue create: ${err.message}`));
      });
      setImmediate(async () => {
        try {
          const issue = await strapi.documents('api::issue.issue').findOne({
            documentId: result.documentId,
            populate: ['project'],
          });
          if (issue?.project?.documentId) {
            await recomputeRollingStats(strapi, issue.project.documentId);
          }
        } catch (err: any) {
          strapi.log.warn(`[rolling-stats] afterCreate: ${err.message}`);
        }
      });

      // Pipeline: auto-trigger for newly created issues (e.g. triage on 'open')
      if (result.status) {
        setImmediate(() => {
          triggerPipelineStep(strapi, result.documentId, '', result.status).catch((err: any) =>
            strapi.log.warn(`[pipeline] afterCreate trigger failed for ${result.documentId}: ${err.message}`));
        });
      }
    },

    async beforeUpdate(event: any) {
      const id = event.params?.where?.id;
      if (!id) return;

      try {
        const current = await strapi.db.query('api::issue.issue').findOne({
          where: { id },
          select: ['id', 'documentId', 'changeHistory', 'relations', ...TRACKED_FIELDS],
        });
        event.state = { previous: current };

        const newStatus = event.params?.data?.status;
        if (newStatus && current?.status && newStatus !== current.status) {
          if (!isTransitionAllowed(current.status, newStatus)) {
            strapi.log.warn(`[lifecycle] ISS-${current.id}: blocked backward transition ${current.status} → ${newStatus}`);
            delete event.params.data.status;
          }
        }
      } catch (err: any) {
        strapi.log.error(`Issue beforeUpdate: failed to fetch previous state: ${err.message}`);
      }
    },

    async afterUpdate(event: any) {
      const { result } = event as any;
      broadcast('issue:updated', { documentId: result.documentId, status: result.status });

      if (result.status === 'confirmed') {
        broadcast('issue:confirmed', { documentId: result.documentId });
      }

      // Record change history
      const previous = (event.state as any)?.previous;
      if (!previous) return;

      // Skip if this update only touched changeHistory (avoid infinite loop)
      const dataKeys = new Set(Object.keys(event.params?.data || {}));
      if (dataKeys.size === 1 && dataKeys.has('changeHistory')) return;

      const now = new Date().toISOString();
      const by = getActor(strapi);

      // Only track changes for fields explicitly set in this update's data.
      // Prevents phantom change detection when concurrent updates (e.g. status + sessionContext)
      // cause beforeUpdate to fetch a stale previous state for fields not being updated.
      const newEntries: any[] = [];
      for (const field of TRACKED_FIELDS) {
        if (!dataKeys.has(field)) continue;
        if (result[field] !== undefined && String(result[field] ?? '') !== String(previous[field] ?? '')) {
          newEntries.push({
            field,
            from: previous[field] ?? null,
            to: result[field],
            at: now,
            by,
          });
        }
      }

      if (newEntries.length === 0) return;

      // Persist changeHistory JSON (backward compat)
      const existingHistory = Array.isArray(previous.changeHistory) ? previous.changeHistory : [];
      const updatedHistory = [...existingHistory, ...newEntries].slice(-200);

      const statusChange = newEntries.find((e) => e.field === 'status');

      // Defer change-history write + webhook dispatch into a single setImmediate
      setImmediate(async () => {
        const promises: Promise<void>[] = [
          strapi.db.query('api::issue.issue').update({
            where: { id: result.id },
            data: { changeHistory: updatedHistory },
          }).catch((err: any) => {
            strapi.log.error(`Issue afterUpdate: failed to persist changeHistory: ${err.message}`);
          }),
        ];
        if (statusChange) {
          promises.push(
            sendWebhook(strapi, result.documentId, statusChange).catch((err: any) => {
              strapi.log.error(`Webhook dispatch failed: ${err}`);
            }),
          );
        }
        await Promise.all(promises);
      });

      // Create activity records for each change
      const issueDocId = previous.documentId || result.documentId;
      const isAI = by === 'Pikachu';
      setImmediate(() => {
        for (const entry of newEntries) {
          createActivity(strapi, {
            type: FIELD_TO_ACTIVITY_TYPE[entry.field] || 'status_change',
            issue: issueDocId,
            actor: entry.by,
            isAI,
            field: entry.field,
            fromValue: entry.from != null ? String(entry.from) : null,
            toValue: String(entry.to),
          });
        }
      });

      // Track relation changes
      const prevRelations: any[] = Array.isArray(previous.relations) ? previous.relations : [];
      const newRelations: any[] = Array.isArray(result.relations) ? result.relations : [];
      const prevTargets = new Set(prevRelations.map((r: any) => r.targetDocumentId));
      const newTargets = new Set(newRelations.map((r: any) => r.targetDocumentId));

      // Bidirectional sync: mirror added/removed relations on target issues
      const relationsChanged = prevRelations.length !== newRelations.length ||
        [...prevTargets].some(t => !newTargets.has(t)) ||
        [...newTargets].some(t => !prevTargets.has(t));
      if (relationsChanged) {
        setImmediate(() => {
          syncInverseRelations(strapi, result.documentId, prevRelations, newRelations).catch((err: any) =>
            strapi.log.warn(`[relations] inverse sync failed: ${err.message}`));
        });

        // Sync relations to knowledge graph edges for unified multi-hop traversal
        setImmediate(async () => {
          try {
            const issue = await strapi.documents('api::issue.issue').findOne({
              documentId: result.documentId,
              populate: ['project'],
            });
            if (issue?.project?.documentId) {
              await syncRelationsToEdges(strapi, issue.project.documentId, result.documentId, newRelations);
            }
          } catch (err: any) {
            strapi.log.warn(`[knowledge-graph] relation sync failed: ${err.message}`);
          }
        });
      }

      setImmediate(async () => {
        // Resolve target documentIds to ISS-N for display
        const allTargetIds = [...new Set([
          ...newRelations.filter(r => !prevTargets.has(r.targetDocumentId)).map(r => r.targetDocumentId),
          ...prevRelations.filter(r => !newTargets.has(r.targetDocumentId)).map(r => r.targetDocumentId),
        ])];
        const targetMap = new Map<string, number>();
        if (allTargetIds.length > 0) {
          try {
            const targets = await strapi.db.query('api::issue.issue').findMany({
              where: { documentId: { $in: allTargetIds } },
              select: ['id', 'documentId'],
            });
            for (const t of targets) targetMap.set(t.documentId, t.id);
          } catch { /* ignore */ }
        }
        const label = (docId: string) => {
          const id = targetMap.get(docId);
          return id ? `ISS-${id}` : docId.slice(0, 8);
        };

        for (const rel of newRelations) {
          if (!prevTargets.has(rel.targetDocumentId)) {
            await createActivity(strapi, {
              type: 'relation_added',
              issue: issueDocId,
              actor: by,
              body: `Added ${rel.type?.replace(/_/g, ' ') || 'relation'} → ${label(rel.targetDocumentId)}`,
              metadata: { relationType: rel.type, targetDocumentId: rel.targetDocumentId, reason: rel.reason },
            });
          }
        }
        for (const rel of prevRelations) {
          if (!newTargets.has(rel.targetDocumentId)) {
            await createActivity(strapi, {
              type: 'relation_removed',
              issue: issueDocId,
              actor: by,
              body: `Removed ${rel.type?.replace(/_/g, ' ') || 'relation'} → ${label(rel.targetDocumentId)}`,
              metadata: { relationType: rel.type, targetDocumentId: rel.targetDocumentId },
            });
          }
        }
      });

      // Re-embed on update
      setImmediate(() => {
        embedIssue(strapi, result).catch((err: any) =>
          strapi.log.warn(`[embed] issue update: ${err.message}`));
      });

      // Recompute rolling stats
      setImmediate(async () => {
        try {
          const issue = await strapi.documents('api::issue.issue').findOne({
            documentId: result.documentId,
            populate: ['project'],
          });
          if (issue?.project?.documentId) {
            await recomputeRollingStats(strapi, issue.project.documentId);
          }
        } catch (err: any) {
          strapi.log.warn(`[rolling-stats] afterUpdate: ${err.message}`);
        }
      });

      // Status-dependent side effects (webhook already dispatched above with change-history)
      if (statusChange) {
        // Pipeline orchestrator: trigger agent step for the new status.
        // For 'confirmed', check if we should auto-skip to 'clarified' first —
        // if so, skip the pipeline trigger here. The status update to 'clarified'
        // will trigger the pipeline for forge-plan via its own lifecycle event.
        const newStatus = statusChange.to;
        if (newStatus === 'confirmed') {
          // Skip logic (Simple→clarified, autoClarify disabled) is handled by the
          // pipeline orchestrator's resolveStepForStatus + shouldSkipStep.
          const isManualRetrigger = statusChange.from === 'on_hold';
          setImmediate(() => {
            triggerPipelineStep(strapi, result.documentId, statusChange.from, newStatus, isManualRetrigger).catch((err: any) =>
              strapi.log.warn(`[pipeline] trigger failed for ${result.documentId}: ${err.message}`));
          });
        } else {
          // Treat transitions from on_hold as manual triggers — user is explicitly
          // re-triggering after pipeline stopped, so bypass MAX_FRESH_RETRIES.
          const isManualRetrigger = statusChange.from === 'on_hold';
          setImmediate(() => {
            triggerPipelineStep(strapi, result.documentId, statusChange.from, newStatus, isManualRetrigger).catch((err: any) =>
              strapi.log.warn(`[pipeline] trigger failed for ${result.documentId}: ${err.message}`));
          });
        }

        // Capture CI fix pattern when fix succeeds (reopen → developed)
        if (newStatus === 'developed' && statusChange.from === 'reopen') {
          setImmediate(async () => {
            try {
              const issue = await strapi.documents('api::issue.issue').findOne({
                documentId: result.documentId,
                populate: ['project'],
              });
              if (issue?.sessionContext?.ciFixContext && issue?.project?.documentId) {
                const { storeSuccessPattern } = await import('../services/ci-fix-loop');
                await storeSuccessPattern(strapi, issue.project.documentId, result.documentId);
              }
            } catch (err: any) {
              strapi.log.warn(`[ci-fix] pattern capture failed: ${err.message}`);
            }
          });
        }

        // Embed sessionContext in Qdrant when issue reaches developed or closed
        if (['developed', 'closed'].includes(newStatus) && result.sessionContext) {
          setImmediate(async () => {
            try {
              const issue = await strapi.documents('api::issue.issue').findOne({
                documentId: result.documentId,
                populate: ['project'],
              });
              if (issue?.project?.documentId) {
                await embedSessionContext(strapi, issue.project.documentId, result.documentId);
              }
            } catch (err: any) {
              strapi.log.warn(`[session-context] embed failed for ${result.documentId}: ${err.message}`);
            }
          });
        }

        // Auto-skip deploying → testing (staging is the sole test environment)
        if (newStatus === 'deploying') {
          setImmediate(async () => {
            try {
              strapi.log.info(`[lifecycle] ISS-${result.id}: auto-transitioning deploying → testing`);
              await strapi.documents('api::issue.issue').update({
                documentId: result.documentId,
                data: { status: 'testing' } as any,
              });
            } catch (err: any) {
              strapi.log.warn(`[lifecycle] deploying→testing check failed: ${err.message}`);
            }
          });
        }

        // Decomposition: cascade approval to children and auto-advance parent.
        //
        // 1) Parent waiting → approved: promote draft children to approved
        //    so forge-code starts on each. Children are created as draft by
        //    forge-plan's decomposition flow and sit inert until parent is approved.
        //
        // 2) Parent unblocked at approved (all children done-enough): auto-advance
        //    parent to deploying (which auto-skips to testing). forge-test runs
        //    integration QA on the parent's acceptance criteria. No forge-code
        //    needed — children already wrote all the code.
        if (newStatus === 'approved' && statusChange.from === 'waiting') {
          setImmediate(async () => {
            try {
              const relations: any[] = Array.isArray(result.relations) ? result.relations : [];
              const decompChildren = relations.filter(
                (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
              );
              if (decompChildren.length === 0) return;

              strapi.log.info(
                `[lifecycle] ISS-${result.id}: decomposed parent approved, cascading to ${decompChildren.length} children`
              );

              for (const rel of decompChildren) {
                const child = await strapi.documents('api::issue.issue').findOne({
                  documentId: rel.targetDocumentId,
                  fields: ['documentId', 'id', 'status'],
                });
                if (child && child.status === 'draft') {
                  strapi.log.info(
                    `[lifecycle] ISS-${child.id}: cascading approval from parent ISS-${result.id}`
                  );
                  await strapi.documents('api::issue.issue').update({
                    documentId: child.documentId,
                    data: { status: 'approved' } as any,
                  });
                }
              }
            } catch (err: any) {
              strapi.log.warn(`[lifecycle] decomposition cascade failed: ${err.message}`);
            }
          });
        }

        // Decomposition parent auto-advance is handled in pipeline-orchestrator's
        // onStatusChange (when unblockDependents re-triggers the parent at approved).

        // Unblock dependent issues: when an issue reaches a "done-enough" status,
        // find issues that are blocked_by this one and re-trigger their pipeline step.
        if (DONE_ENOUGH_STATUSES.has(newStatus)) {
          setImmediate(() => {
            unblockDependents(strapi, result.documentId).catch((err: any) =>
              strapi.log.warn(`[relations] unblock dependents failed: ${err.message}`));
          });
        }

        // Auto-populate relations when issue closes
        if (newStatus === 'closed') {
          setImmediate(() => {
            autoPopulateRelations(strapi, result.documentId).catch((err: any) =>
              strapi.log.warn(`[relations] auto-populate failed: ${err.message}`));
          });

          // Delete queued sessions — no point running them after the issue is closed
          setImmediate(async () => {
            try {
              const queuedSessions: any[] = await strapi.documents('api::agent-session.agent-session' as any).findMany({
                filters: {
                  issues: { documentId: { $eq: result.documentId } },
                  status: 'queued',
                },
                fields: ['documentId'],
                limit: 50,
              });
              for (const sess of queuedSessions) {
                await strapi.documents('api::agent-session.agent-session' as any).delete({ documentId: sess.documentId });
              }
              if (queuedSessions.length > 0) {
                strapi.log.info(`[lifecycle] ISS-${result.id}: deleted ${queuedSessions.length} queued session(s) on close`);
              }
            } catch (err: any) {
              strapi.log.warn(`[lifecycle] ISS-${result.id}: failed to clean queued sessions: ${err.message}`);
            }
          });

          // Decomposition: close all children when parent is closed.
          // Covers manual close, rejection, or normal pipeline completion.
          // Before force-closing a child, abort any in-flight session so the
          // running agent doesn't keep updating the child status in a loop.
          setImmediate(async () => {
            try {
              const relations: any[] = Array.isArray(result.relations) ? result.relations : [];
              const decompChildren = relations.filter(
                (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
              );
              if (decompChildren.length === 0) return;

              for (const rel of decompChildren) {
                const child = await strapi.documents('api::issue.issue').findOne({
                  documentId: rel.targetDocumentId,
                  fields: ['documentId', 'id', 'status'],
                });
                if (!child || child.status === 'closed') continue;

                // Abort any running/queued sessions for this child before closing.
                // Running sessions get an agent:abort WS to their device; queued
                // sessions are marked idle so the dispatcher ignores them.
                const activeSessions: any[] = await strapi.documents('api::agent-session.agent-session' as any).findMany({
                  filters: {
                    issues: { documentId: { $eq: child.documentId } },
                    status: { $in: ['running', 'queued'] },
                  },
                  populate: ['project', 'project.defaultDevice'],
                  limit: 10,
                });
                for (const sess of activeSessions) {
                  try {
                    await strapi.documents('api::agent-session.agent-session' as any).update({
                      documentId: sess.documentId,
                      data: { status: 'idle' } as any,
                    });
                    const deviceId = sess.metadata?.deviceId || sess.project?.defaultDevice?.deviceId;
                    if (deviceId && sess.status === 'running') {
                      sendToDevice(deviceId, 'agent:abort', { sessionId: sess.documentId });
                      strapi.log.info(
                        `[lifecycle] ISS-${child.id}: aborted session ${sess.documentId} on device ${deviceId} (cascade close)`
                      );
                    }
                  } catch (abortErr: any) {
                    strapi.log.warn(
                      `[lifecycle] ISS-${child.id}: failed to abort session ${sess.documentId}: ${abortErr.message}`
                    );
                  }
                }

                strapi.log.info(
                  `[lifecycle] ISS-${child.id}: closing decomposition child (parent ISS-${result.id} closed)`
                );
                await strapi.documents('api::issue.issue').update({
                  documentId: child.documentId,
                  data: { status: 'closed' } as any,
                });
              }
            } catch (err: any) {
              strapi.log.warn(`[lifecycle] decomposition cascade close failed: ${err.message}`);
            }
          });
        }
      }
    },

    async afterDelete(event: any) {
      const { result } = event;
      if (result?.documentId) {
        setImmediate(() => {
          removeEmbeddings('issue', result.documentId).catch((err: any) =>
            strapi.log.warn(`[embed] issue delete: ${err.message}`));
        });
      }
    },
  });
}

function getActor(strapi: any): string {
  const reqCtx = strapi.requestContext?.get?.();
  return (reqCtx as any)?.state?.user?.username || 'Pikachu';
}

export async function createActivity(strapi: any, data: {
  type: string;
  issue: string;
  actor: string;
  body?: string;
  isAI?: boolean;
  field?: string;
  fromValue?: string | null;
  toValue?: string;
  metadata?: any;
}) {
  try {
    await strapi.documents(ACTIVITY_UID).create({
      data: {
        type: data.type,
        issue: data.issue,
        actor: data.actor,
        body: data.body,
        isAI: data.isAI || false,
        field: data.field,
        fromValue: data.fromValue,
        toValue: data.toValue,
        metadata: data.metadata,
      },
    });
  } catch (err: any) {
    strapi.log.warn(`[activity] Failed to create activity: ${err.message}`);
  }
}

async function embedIssue(strapi: any, result: any) {
  if (!result?.documentId) return;
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: result.documentId,
    populate: ['project'],
  });
  if (!issue?.project?.documentId) return;

  const text = [issue.title, issue.description, issue.acceptanceCriteria]
    .filter(Boolean).join('\n\n');

  const sanitized = sanitizeContent(text);

  await upsertEmbedding({
    project_id: issue.project.documentId,
    source_type: 'issue',
    source_id: issue.documentId,
    text: sanitized,
    metadata: {
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      category: issue.category,
      issueId: issue.id,
      hasAC: !!issue.acceptanceCriteria,
      suggestedSolution: issue.suggestedSolution ? String(issue.suggestedSolution).slice(0, 400) : undefined,
      acceptanceCriteria: issue.acceptanceCriteria ? String(issue.acceptanceCriteria).slice(0, 200) : undefined,
      updatedAt: new Date().toISOString(),
    },
    contextual: true,
  });

  setImmediate(() => {
    enrichEntitiesWithLLM(issue.project.documentId, 'issue', issue.documentId, sanitized)
      .catch((err: any) => strapi.log.warn(`[entity-llm] issue enrichment: ${err.message}`));
  });

  setImmediate(() => {
    extractIssueEdges(strapi, issue.project.documentId, {
      documentId: issue.documentId,
      title: issue.title,
      description: issue.description,
      category: issue.category,
      acceptanceCriteria: issue.acceptanceCriteria,
    }).catch((err: any) => strapi.log.warn(`[knowledge-graph] issue edge extraction: ${err.message}`));
  });
}
