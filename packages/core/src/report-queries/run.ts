// Runs one registered query as the asker. The permission is checked before anything is read, the
// params are parsed strictly, and the frame is checked against what the descriptor declared, so a
// query that drifts from its own output fails here by name instead of drawing a wrong chart.

import type { ActorAgency } from '@forge/contracts/permissions';
import {
  type ReportFrame,
  ReportFrameSchema,
  type ReportRun,
} from '@forge/contracts/report-queries';
import type { ProjectAccess } from '../lib/authz.js';
import { requireHeld } from '../permissions/index.js';
import { statusViewerOf } from '../project-status/index.js';
import { getReportQuery } from './registry.js';

export interface ReportAsker {
  userId: string;
  agency: ActorAgency;
  access: ProjectAccess;
}

function assertDeclared(
  id: string,
  declared: readonly { name: string; type: string }[],
  frame: ReportFrame,
) {
  const got = frame.fields.map((f) => `${f.name}:${f.type}`).join(', ');
  const want = declared.map((f) => `${f.name}:${f.type}`).join(', ');
  if (got !== want) {
    throw new Error(
      `report query "${id}" returned fields (${got}) that differ from the output it declares (${want}); bump its version and declare what it returns`,
    );
  }
}

export async function runReportQuery(args: {
  projectId: string;
  queryId: string;
  params: unknown;
  asker: ReportAsker;
  now?: Date;
}): Promise<ReportRun> {
  const query = getReportQuery(args.queryId);
  requireHeld(args.asker.access, query.descriptor.permission, `run report query ${args.queryId}`);
  const now = args.now ?? new Date();
  const viewer = statusViewerOf(args.asker.access, args.asker.userId, args.asker.agency);
  const { params, frame } = await query.execute(
    { projectId: args.projectId, viewer, now },
    args.params,
  );
  const parsed = ReportFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(
      `report query "${args.queryId}" returned a frame that breaks the frame contract: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const checked = parsed.data;
  assertDeclared(args.queryId, query.descriptor.output, checked);
  return {
    runId: crypto.randomUUID(),
    queryId: query.descriptor.id,
    version: query.descriptor.version,
    params,
    projectId: args.projectId,
    actor: { kind: args.asker.agency, id: args.asker.userId },
    asOf: now.toISOString(),
    frame: checked,
  };
}
