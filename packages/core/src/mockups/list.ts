/** The mockups on one target (ISS-78), and the bytes of one, each read as the viewer may. */

import type { MockupListResponse } from '@forge/contracts/mockups';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { rowIn as feedbackRowIn } from '../feedback/read.js';
import { issueRefIn, requirementRefIn } from '../feedback/refs.js';
import { egressAs } from '../lib/data-egress.js';
import { getStorage } from '../storage/index.js';
import {
  type MockupActor,
  type MockupDoor,
  mockupKey,
  mockupRowsOn,
  mockupViews,
  rowIn,
} from './read.js';
import { requireCan } from '../permissions/index.js';

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

export async function listMockupsAs(
  viewer: MockupActor,
  projectId: string,
  query: {
    requirement?: string | undefined;
    feedback?: string | undefined;
    issue?: string | undefined;
  },
  door: MockupDoor = {},
): Promise<MockupListResponse> {
  await requireCan({ userId: viewer.userId }, 'project.read', projectId);
  const named = [query.requirement, query.feedback, query.issue].filter(Boolean);
  if (named.length !== 1) {
    throw badRequest(
      'invalid query: exactly one of requirement=REQ-n, feedback=FB-n or issue=ISS-n',
    );
  }
  let where: { requirementId?: string; feedbackId?: string; issueId?: string };
  if (query.requirement) {
    const req = await requirementRefIn(projectId, query.requirement, '/requirement');
    if ('code' in req) throw badRequest(req.detail);
    where = { requirementId: req.id };
  } else if (query.feedback) {
    where = { feedbackId: (await feedbackRowIn(db, projectId, query.feedback)).id };
  } else {
    const issue = await issueRefIn(projectId, query.issue ?? '', viewer.userId, '/issue');
    if ('code' in issue) throw badRequest(issue.detail);
    where = { issueId: issue.id };
  }
  const rows = await mockupRowsOn(projectId, where);
  const views = await mockupViews(projectId, rows, viewer, door);
  return {
    mockups: views,
    returned: views.length,
    open: views.filter((m) => m.status === 'proposed').length,
  };
}

export async function getMockupAs(
  viewer: MockupActor,
  projectId: string,
  ref: string,
  door: MockupDoor = {},
) {
  await requireCan({ userId: viewer.userId }, 'project.read', projectId);
  const [view] = await mockupViews(projectId, [await rowIn(db, projectId, ref)], viewer, door);
  return view;
}

// cm:guard a mockup's bytes pass the one egress rule as surface `mockup.content` (operational): an
// agent or the MCP door reading a no_egress project is refused CONTENT_EGRESS_FORBIDDEN by name
export async function mockupBytes(
  viewer: MockupActor,
  projectId: string,
  ref: string,
  door: MockupDoor = {},
) {
  await requireCan({ userId: viewer.userId }, 'project.read', projectId);
  const row = await rowIn(db, projectId, ref);
  const gate = await egressAs(
    { agency: viewer.agency, providerBound: door.providerBound },
    projectId,
    'mockup.content',
    null,
    `mockup ${mockupKey(row.mockupSeq)}`,
  );
  if (!gate.ok) return { ok: false as const, refusal: gate.refusal, row };
  return { ok: true as const, row, bytes: await getStorage().get(row.storagePath) };
}
