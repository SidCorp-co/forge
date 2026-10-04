import {
  findTemplate,
  resolveProjectTemplates,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { peopleOf } from '../lib/people.js';
import { staleBase } from '../project-config/documents.js';
import { readProjectDocument } from '../project-config/service.js';
import {
  designApproverRefusal,
  designFingerprint,
  designStatusAfterWrite,
  designStatusAtCreate,
} from './design.js';
import { baseRefusals } from './design-bases.js';
import { designListReadingOf } from './design-standing.js';
import {
  checkWorkflow,
  duplicateWorkflowRefusal,
  type EvidenceSource,
  parseWorkflow,
  type WorkflowRefusal,
  workflowIdentityRefusals,
} from './rules.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';
import {
  insertDesign,
  insertWorkflow,
  lockWorkflows,
  readWorkflow,
  replaceWorkflow,
  returnReasonsOf,
  type StoredWorkflow,
  workflowHolding,
  workflowsOf,
} from './store.js';
import { type ProjectDesign, type ProjectDesigns, projectDesignOf } from './template-check.js';
import { permissionFactsOf, requireCan } from '../permissions/index.js';

export interface WorkflowWriter {
  userId: string;
  agency: ActorAgency;
}

export type WorkflowOutcome =
  | { ok: true; row: StoredWorkflow; document: WorkflowWrite; created: boolean }
  | { ok: false; refusals: WorkflowRefusal[] };

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export function storedWorkflow(row: StoredWorkflow): WorkflowWrite {
  const parsed = readStoredWorkflow(row.document);
  if (!parsed) {
    throw new Error(
      `workflows: stored workflow ${row.id} no longer parses at the version it names; the store holds a shape this core cannot read and it is not guessed at.`,
    );
  }
  return parsed;
}

/** What a write is checked against, from the project document: where its code lives (what an observation cites) and the templates it may draw in. */
export async function projectFactsOf(
  projectId: string,
): Promise<{ source: EvidenceSource; templates: WorkflowTemplate[] }> {
  const document = (await readProjectDocument(projectId))?.document;
  const source = document?.source;
  return {
    source:
      source?.type === 'storefront'
        ? { kind: 'storefront', provider: source.storefront.provider }
        : { kind: 'repo' },
    templates: resolveProjectTemplates(document?.workflows?.templates ?? []).templates,
  };
}

/** The templates a project may draw in: the built-ins, then its own. */
export async function templatesOf(projectId: string): Promise<{
  templates: WorkflowTemplate[];
  projectKeys: Set<string>;
}> {
  const document = (await readProjectDocument(projectId))?.document;
  const resolved = resolveProjectTemplates(document?.workflows?.templates ?? []);
  return { templates: resolved.templates, projectKeys: resolved.projectKeys };
}

/** The project's version 2 designs other than `flow`: what this one's refs resolve against, and what links to it. */
async function designsOf(
  tx: Tx,
  projectId: string,
  flow: string,
  templates: readonly WorkflowTemplate[],
): Promise<ProjectDesigns> {
  const rows = await workflowsOf(tx, projectId);
  const out = new Map<string, ProjectDesign>();
  for (const r of rows) {
    if (r.flow === flow) continue;
    const doc = readStoredWorkflow(r.document);
    const design = doc ? projectDesignOf(doc, templates) : null;
    if (design) out.set(r.flow, design);
  }
  return out;
}

const templateFor = (doc: WorkflowWrite, templates: readonly WorkflowTemplate[]) =>
  doc.version === 2 ? findTemplate(templates, doc.template) : null;

export async function assertWriter(writer: WorkflowWriter, projectId: string): Promise<void> {
  await requireCan(writer, 'workflow-designs.write', projectId, 'writing a workflow');
}

export async function createWorkflow(input: {
  projectId: string;
  writer: WorkflowWriter;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WorkflowOutcome> {
  const { projectId, writer, baseRevision, raw } = input;
  await assertWriter(writer, projectId);
  if (baseRevision !== null) {
    return {
      ok: false,
      refusals: [
        {
          code: 'STALE_BASE',
          path: '/baseRevision',
          detail: `this creates a workflow, which has no revision to base on; send baseRevision null, not ${baseRevision}.`,
        },
      ],
    };
  }
  const parsed = parseWorkflow(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const facts = await projectFactsOf(projectId);
  return db.transaction(async (tx) => {
    await lockWorkflows(tx, projectId);
    const refusals = [
      ...checkWorkflow(doc, {
        templates: facts.templates,
        designs: await designsOf(tx, projectId, doc.flow, facts.templates),
      }),
      ...baseRefusals(doc, await workflowsOf(tx, projectId)),
    ];
    if (refusals.length > 0) return { ok: false, refusals };
    const holding = await workflowHolding(tx, projectId, doc.flow);
    if (holding) return { ok: false, refusals: [duplicateWorkflowRefusal(doc.flow, holding)] };
    const row = await insertWorkflow(tx, doc, writer.userId, {
      designStatus: designStatusAtCreate(doc),
      designFingerprint: designFingerprint(doc, templateFor(doc, facts.templates)),
      approvedRevision: null,
    });
    return { ok: true, row, document: doc, created: true };
  });
}

export async function updateWorkflow(input: {
  projectId: string;
  id: string;
  writer: WorkflowWriter;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WorkflowOutcome> {
  const { projectId, id, writer, baseRevision, raw } = input;
  await assertWriter(writer, projectId);
  const parsed = parseWorkflow(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const facts = await projectFactsOf(projectId);
  return db.transaction(async (tx) => {
    await lockWorkflows(tx, projectId);
    const row = await readWorkflow(tx, id);
    if (!row || row.projectId !== projectId) {
      throw notFound(`project ${projectId} holds no workflow ${id}`);
    }
    if (row.revision !== baseRevision) {
      return { ok: false, refusals: [staleBase(baseRevision, row.revision)] };
    }
    const stored = storedWorkflow(row);
    const refusals = [
      ...workflowIdentityRefusals(stored, doc),
      ...checkWorkflow(doc, {
        templates: facts.templates,
        designs: await designsOf(tx, projectId, doc.flow, facts.templates),
      }),
      ...baseRefusals(doc, await workflowsOf(tx, projectId)),
    ];
    if (refusals.length > 0) return { ok: false, refusals };
    if (JSON.stringify(stored) === JSON.stringify(doc)) {
      return { ok: true, row, document: stored, created: false };
    }
    const fingerprint = designFingerprint(doc, templateFor(doc, facts.templates));
    const design = designStatusAfterWrite(row.designStatus, row.designFingerprint !== fingerprint);
    const next = await replaceWorkflow(tx, {
      id,
      revision: row.revision,
      doc,
      userId: writer.userId,
      design: {
        designStatus: design.status,
        designFingerprint: fingerprint,
        approvedRevision: row.approvedRevision,
      },
    });
    if (design.proposes) {
      await insertDesign(tx, {
        workflowId: id,
        revision: next.revision,
        document: doc,
        userId: writer.userId,
      });
    }
    return { ok: true, row: next, document: doc, created: false };
  });
}

export function workflowView(
  row: StoredWorkflow,
  document: WorkflowWrite,
  writerName?: string,
  returnReason?: string | null,
) {
  return {
    revision: row.revision,
    writer: row.writtenByUser,
    writerName: writerName ?? row.writtenByUser,
    design: {
      status: row.designStatus,
      approvedRevision: row.approvedRevision,
      ...(row.designStatus === 'returned' ? { returnReason: returnReason ?? null } : {}),
    },
    document: {
      ...document,
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

async function mayDecideDesigns(userId: string, projectId: string): Promise<boolean> {
  return designApproverRefusal(await permissionFactsOf(userId, projectId)) === null;
}

function listedView(
  row: StoredWorkflow,
  canDecide: boolean,
  writerName: string | undefined,
  returnReason?: string | null,
) {
  const view = workflowView(row, storedWorkflow(row), writerName, returnReason);
  const reading = designListReadingOf(
    {
      status: row.designStatus,
      proposedRevision: row.designStatus === 'proposed' ? row.revision : null,
      approvedRevision: row.approvedRevision,
      latest: { revision: row.revision, author: view.writerName },
      canDecide,
    },
    row.revision,
  );
  return { ...view, design: { ...view.design, ...reading } };
}

export async function listWorkflowsAs(userId: string, projectId: string) {
  await requireCan({ userId }, 'project.read', projectId);
  const rows = await workflowsOf(db, projectId);
  const [names, reasons, canDecide] = await Promise.all([
    writerNames(rows),
    returnReasonsOf(
      db,
      rows.filter((r) => r.designStatus === 'returned').map((r) => r.id),
    ),
    mayDecideDesigns(userId, projectId),
  ]);
  return rows.map((row) =>
    listedView(row, canDecide, names.get(row.writtenByUser), reasons.get(row.id)),
  );
}

export async function readWorkflowAs(userId: string, projectId: string, id: string) {
  await requireCan({ userId }, 'project.read', projectId);
  const row = await readWorkflow(db, id);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${id}`);
  }
  const [names, canDecide] = await Promise.all([
    writerNames([row]),
    mayDecideDesigns(userId, projectId),
  ]);
  return listedView(row, canDecide, names.get(row.writtenByUser));
}

async function writerNames(rows: readonly StoredWorkflow[]): Promise<Map<string, string>> {
  return userNames(rows.map((r) => r.writtenByUser));
}

export async function userNames(userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const people = await peopleOf(userIds);
  return new Map([...people].map(([id, p]) => [id, p.name]));
}
