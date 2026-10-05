/**
 * Writing and reading the observed layer of a design. A write is held to the root, the approved
 * revision, the landed commit and the citation rule; it touches neither project_workflows nor
 * project_workflow_designs, and its permission (workflow-observations.write) writes nothing else.
 */

import type {
  ObservationSource,
  ObservationSummaryView,
  ObservationView,
} from '@forge/contracts/workflow-health';
import { and, desc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projectWorkflowObservations, projectWorkflows } from '../db/schema-workflows.js';
import { peopleOf } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import {
  citedFiles,
  commitOffBranchRefusal,
  missingCitationRefusals,
  type ObservationRefusal,
  observationRefusals,
  revisionRefusal,
  sourceUnreadableRefusal,
} from './observation-rules.js';
import {
  type ObservationDocument,
  observationDocumentSchema,
  type WriteObservation,
} from './observation-schema.js';
import { type ObservedRepository, repositoryOf } from './ports.js';
import { rootedOf, unrootedRefusal } from './rooted.js';
import { readStoredWorkflow } from './schema.js';
import { projectFactsOf, type WorkflowWriter } from './service.js';
import { designsOf, lockWorkflows } from './store.js';

type ObservationOutcome =
  | { ok: true; observation: ObservationView; created: boolean }
  | { ok: false; refusals: ObservationRefusal[] };

type Row = typeof projectWorkflowObservations.$inferSelect;

/** A workflow of `projectId` by uuid or flow; 404 naming the ref otherwise. */
async function workflowRowIn(executor: Tx | typeof db, projectId: string, ref: string) {
  const uuid = /^[0-9a-f-]{36}$/i.test(ref);
  const [row] = await executor
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      revision: projectWorkflows.revision,
      approvedRevision: projectWorkflows.approvedRevision,
      document: projectWorkflows.document,
    })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        uuid ? eq(projectWorkflows.id, ref) : eq(projectWorkflows.flow, ref.trim()),
      ),
    );
  if (!row) throw notFound(`project ${projectId} holds no workflow ${ref}`);
  return row;
}

/** The steps of revision `n` of a workflow: the stored proposal of that revision, or the head. */
async function plannedStepsAt(
  tx: Tx,
  wf: Awaited<ReturnType<typeof workflowRowIn>>,
  n: number,
): Promise<Set<string> | null> {
  const stored =
    n === wf.revision
      ? wf.document
      : (await designsOf(tx, wf.id)).find((d) => d.revision === n)?.document;
  if (stored === undefined) return null;
  const doc = readStoredWorkflow(stored);
  return new Set((doc?.steps ?? []).map((s) => s.id));
}

function documentOf(row: Row): ObservationDocument {
  const parsed = observationDocumentSchema.safeParse(row.document);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    const field = `/${(first?.path ?? []).map(String).join('/')}`;
    throw new Error(
      `observation ${row.id} holds ${field}, which no longer parses as an observation document (${first?.message ?? 'unknown'}); the stored row is repaired, never guessed at.`,
    );
  }
  return parsed.data;
}

function summaryOf(
  row: Row,
  flow: string,
  names: Map<string, { name: string | null }>,
): ObservationSummaryView {
  const doc = documentOf(row);
  return {
    id: row.id,
    workflowId: row.workflowId,
    flow,
    atSha: row.atSha,
    revision: row.revision,
    source: row.source as ObservationSource,
    stepCount: doc.steps.length,
    edgeCount: doc.edges.length,
    matched: doc.steps.filter((s) => s.matches !== null).length,
    writtenBy: row.writtenBy,
    writtenByName: names.get(row.writtenBy)?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function viewOf(row: Row, flow: string): Promise<ObservationView> {
  const names = await peopleOf([row.writtenBy]);
  return { ...summaryOf(row, flow, names), document: documentOf(row) };
}

/** Each cited file at the commit, read once; a read the host fails is the whole check's refusal. */
async function citedTexts(
  repo: ObservedRepository,
  sha: string,
  files: readonly string[],
): Promise<Map<string, string | { missing: string }> | ObservationRefusal> {
  const texts = new Map<string, string | { missing: string }>();
  try {
    for (const file of files) texts.set(file, await repo.readFile(file, sha));
  } catch (err) {
    return sourceUnreadableRefusal(
      `reading the cited files at ${sha.slice(0, 12)} failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return texts;
}

/** Whether the commit landed and every repo citation names a file and symbol it holds. */
async function commitRefusals(
  projectId: string,
  write: WriteObservation,
): Promise<ObservationRefusal[]> {
  const repo = await repositoryOf(projectId);
  if ('unreadable' in repo) return [sourceUnreadableRefusal(repo.unreadable)];
  let landed: boolean;
  try {
    landed = await repo.contains(write.atSha);
  } catch (err) {
    return [
      sourceUnreadableRefusal(
        `asking whether ${repo.branch} holds ${write.atSha.slice(0, 12)} failed (${err instanceof Error ? err.message : String(err)})`,
      ),
    ];
  }
  if (!landed) return [commitOffBranchRefusal(write.atSha, repo.branch)];
  const texts = await citedTexts(repo, write.atSha, citedFiles(write));
  if (!(texts instanceof Map)) return [texts];
  return missingCitationRefusals(write, texts);
}

/**
 * Store an observation of the approved revision of a rooted design (design-reconciliation `cited`,
 * `observation`). Every refusal is answered by name and nothing of a refused observation is kept.
 */
export async function writeObservation(input: {
  projectId: string;
  workflow: string;
  writer: WorkflowWriter;
  write: WriteObservation;
  source?: ObservationSource;
}): Promise<ObservationOutcome> {
  const { projectId, writer, write } = input;
  const who = await permissionRefusalFor(
    actorFor(writer.userId, writer.agency),
    'workflow-observations.write',
    projectResource(projectId),
    'writing an observation',
  );
  if (who) return { ok: false, refusals: [who] };
  const facts = await projectFactsOf(projectId);
  const read = await db.transaction(async (tx) => {
    const wf = await workflowRowIn(tx, projectId, input.workflow);
    const rooted = await rootedOf(tx, wf);
    const unrooted = unrootedRefusal(wf.flow, rooted);
    if (unrooted || wf.approvedRevision === null) {
      return { wf, refusals: unrooted ? [unrooted] : [] };
    }
    const revision = wf.approvedRevision;
    const notApproved = revisionRefusal(wf.flow, write.revision, revision);
    if (notApproved) return { wf, refusals: [notApproved] };
    const planned = await plannedStepsAt(tx, wf, revision);
    if (!planned) {
      return {
        wf,
        refusals: [
          {
            code: 'WORKFLOW_OBSERVATION_REVISION_UNKNOWN' as const,
            path: '/revision',
            detail: `${wf.flow} holds no stored document for its approved revision ${revision}; the stored design is repaired, never guessed at.`,
          },
        ],
      };
    }
    return {
      wf,
      revision,
      refusals: observationRefusals({
        write,
        planned,
        revision,
        flow: wf.flow,
        source: facts.source,
      }),
    };
  });
  if (read.refusals.length) return { ok: false, refusals: read.refusals };
  const revision = read.revision as number;
  if (facts.source.kind === 'repo') {
    const remote = await commitRefusals(projectId, write);
    if (remote.length) return { ok: false, refusals: remote };
  }
  let written: Row | null = null;
  let created = true;
  const flow = read.wf.flow;
  const refusals = await db.transaction(async (tx): Promise<ObservationRefusal[]> => {
    await lockWorkflows(tx, projectId);
    const wf = await workflowRowIn(tx, projectId, input.workflow);
    if (wf.approvedRevision !== revision) {
      return [
        {
          code: 'WORKFLOW_OBSERVATION_REVISION_NOT_APPROVED',
          path: '/revision',
          detail: `${flow} r${revision} was approved when the observation was checked and r${wf.approvedRevision ?? 'none'} is approved now; observe the approved revision again.`,
        },
      ];
    }
    const document: ObservationDocument = {
      ...(write.summary ? { summary: write.summary } : {}),
      steps: write.steps,
      edges: write.edges ?? [],
      drift: write.drift ?? null,
    };
    const [before] = await tx
      .select({ id: projectWorkflowObservations.id })
      .from(projectWorkflowObservations)
      .where(
        and(
          eq(projectWorkflowObservations.workflowId, wf.id),
          eq(projectWorkflowObservations.atSha, write.atSha),
        ),
      );
    created = !before;
    const values = {
      projectId,
      workflowId: wf.id,
      atSha: write.atSha,
      revision,
      document,
      source: input.source ?? 'observer',
      writtenBy: writer.userId,
      writtenByAgency: writer.agency,
    };
    const [row] = await tx
      .insert(projectWorkflowObservations)
      .values(values)
      .onConflictDoUpdate({
        target: [projectWorkflowObservations.workflowId, projectWorkflowObservations.atSha],
        set: { ...values, createdAt: new Date() },
      })
      .returning();
    written = row ?? null;
    return [];
  });
  if (refusals.length) return { ok: false, refusals };
  if (!written) throw new Error('workflows: the observation write returned no row');
  return { ok: true, observation: await viewOf(written, flow), created };
}

export async function listObservations(
  projectId: string,
  workflow: string,
  limit = 20,
): Promise<{ observations: ObservationSummaryView[] }> {
  const wf = await workflowRowIn(db, projectId, workflow);
  const rows = await db
    .select()
    .from(projectWorkflowObservations)
    .where(eq(projectWorkflowObservations.workflowId, wf.id))
    .orderBy(desc(projectWorkflowObservations.createdAt))
    .limit(limit);
  const names = await peopleOf(rows.map((r) => r.writtenBy));
  return { observations: rows.map((r) => summaryOf(r, wf.flow, names)) };
}

/** The latest observation of a workflow, or the one read at `at` (a sha or an observation id). */
async function readObservation(
  executor: Tx | typeof db,
  workflowId: string,
  at: 'latest' | string = 'latest',
): Promise<Row | null> {
  const where =
    at === 'latest'
      ? eq(projectWorkflowObservations.workflowId, workflowId)
      : and(
          eq(projectWorkflowObservations.workflowId, workflowId),
          /^[0-9a-f]{40}$/.test(at)
            ? eq(projectWorkflowObservations.atSha, at)
            : eq(projectWorkflowObservations.id, at),
        );
  const [row] = await executor
    .select()
    .from(projectWorkflowObservations)
    .where(where)
    .orderBy(desc(projectWorkflowObservations.createdAt))
    .limit(1);
  return row ?? null;
}

export async function observationAs(
  projectId: string,
  workflow: string,
  at: string,
): Promise<ObservationView> {
  const wf = await workflowRowIn(db, projectId, workflow);
  const row = await readObservation(db, wf.id, at);
  if (!row) throw notFound(`workflow ${wf.flow} holds no observation ${at}`);
  return viewOf(row, wf.flow);
}
