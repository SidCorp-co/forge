import type { SystemGraph, SystemGraphRefusalCode } from '@forge/contracts/system-graph';
import { findTemplate } from '@forge/contracts/workflow-templates';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { assertProjectAccess } from '../lib/authz.js';
import { readStoredWorkflow, type WorkflowWriteV2 } from './schema.js';
import { templatesOf } from './service.js';
import { designsOf, readWorkflow } from './store.js';
import { type GraphDoc, isSystemContext, systemGraphOf, withRemoved } from './system-graph.js';

export interface SystemGraphRefusal {
  code: SystemGraphRefusalCode;
  path: string;
  detail: string;
}

export type SystemGraphOutcome =
  | { ok: true; graph: SystemGraph }
  | { ok: false; refusals: SystemGraphRefusal[] };

/**
 * A system-context design read as its graph, at `revision` (the workflow's own, else one put in front
 * of the approver), with the steps `against` held and it removed drawn too.
 */
export async function readSystemGraphAs(input: {
  userId: string;
  projectId: string;
  workflowId: string;
  revision?: number | undefined;
  against?: number | undefined;
}): Promise<SystemGraphOutcome> {
  const { projectId, workflowId } = input;
  await assertProjectAccess(projectId, input.userId, 'viewer');
  const row = await readWorkflow(db, workflowId);
  if (!row || row.projectId !== projectId) {
    throw new HTTPException(404, {
      message: `project ${projectId} holds no workflow ${workflowId}`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  const designs = await designsOf(db, workflowId);
  const held = [...new Set([row.revision, ...designs.map((d) => d.revision)])].sort(
    (a, b) => a - b,
  );
  const at = (revision: number, path: string): WorkflowWriteV2 | SystemGraphRefusal => {
    const raw =
      revision === row.revision
        ? row.document
        : designs.find((d) => d.revision === revision)?.document;
    const doc = raw === undefined ? null : readStoredWorkflow(raw);
    if (doc?.version === 2) return doc;
    return {
      code: 'SYSTEM_GRAPH_REVISION_UNKNOWN',
      path,
      detail: `workflow ${row.flow} holds no revision ${revision} to read; its revisions are ${held.join(', ')}.`,
    };
  };
  const revision = input.revision ?? row.revision;
  const shown = at(revision, '/revision');
  if ('code' in shown) return { ok: false, refusals: [shown] };
  const template = findTemplate((await templatesOf(projectId)).templates, shown.template);
  if (!isSystemContext(template)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SYSTEM_GRAPH_NOT_SYSTEM_CONTEXT',
          path: '/workflow',
          detail: `workflow ${row.flow} is drawn in ${shown.template.id}@${shown.template.version}; a system graph is read only from a design drawn in system-context.`,
        },
      ],
    };
  }
  let doc: GraphDoc = shown;
  let removed = new Set<string>();
  if (input.against !== undefined) {
    const base = at(input.against, '/against');
    if ('code' in base) return { ok: false, refusals: [base] };
    const ids = new Set(shown.steps.map((s) => s.id));
    removed = new Set(base.steps.filter((s) => !ids.has(s.id)).map((s) => s.id));
    doc = withRemoved(shown, base);
  }
  return {
    ok: true,
    graph: {
      workflowId,
      revision,
      against: input.against ?? null,
      ...systemGraphOf(doc, template, removed),
    },
  };
}
