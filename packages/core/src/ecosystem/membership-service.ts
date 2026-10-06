import { db } from '../db/client.js';
import { loadOrgRole } from '../lib/authz.js';
import { jsonPointer as pointer } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { assertStewardAdmin, forbidden, notFound, readerProjects } from './access.js';
import { owedTrigger } from './builder-head.js';
import { type HeldEcosystem, loadEcosystem, storedAs } from './ecosystem-service.js';
import { loadGraph } from './graph.js';
import { readInterface } from './interface-store.js';
import type { BuilderRunWrite } from './link-schema.js';
import { openOwedRun, sourceOf } from './link-service.js';
import { type MembershipRow, type MembershipVerb, TRANSITIONS } from './membership-rules.js';
import {
  applyTransition,
  insertInvitation,
  membershipsWhere,
  openMembership,
  readMembership,
} from './membership-store.js';
import { visibleMembers } from './party.js';
import type { EcosystemRefusal } from './refusals.js';
import { type InterfaceDocument, interfaceDocumentSchema } from './schema.js';
import { lockKeys, projectsWhere } from './store.js';

export type MembershipOutcome =
  | { ok: true; membership: MembershipRow }
  | { ok: false; refusals: EcosystemRefusal[] };

export async function invite(input: {
  ecosystemId: string;
  projectId: string;
  userId: string;
}): Promise<MembershipOutcome> {
  const { ecosystemId, projectId, userId } = input;
  const eco = await loadEcosystem(ecosystemId);
  await assertStewardAdmin(eco.stewardOrgId, userId);
  const [project] = await projectsWhere(db, { ids: [projectId] });
  if (!project) {
    return {
      ok: false,
      refusals: [
        {
          code: 'REF_UNRESOLVED',
          path: '/project',
          detail: `no project has the id ${projectId}; an invitation names an existing project.`,
        },
      ],
    };
  }
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`membership:${ecosystemId}:${projectId}`]);
    const open = await openMembership(tx, ecosystemId, projectId);
    if (open) {
      return {
        ok: false,
        refusals: [
          {
            code: 'MEMBERSHIP_EXISTS',
            path: '/project',
            detail: `${project.slug} already has membership ${open.id} in ${eco.document.ecosystem.slug}, ${open.state}; a project is invited again only after its membership ended.`,
          },
        ],
      };
    }
    return { ok: true, membership: await insertInvitation(tx, input) };
  });
}

function namesEcosystem(doc: InterfaceDocument, ecosystemId: string): string[] {
  return [
    ...Object.entries(doc.publishes)
      .filter(([, p]) => p.ecosystems.includes(ecosystemId))
      .map(([slug]) => pointer(['publishes', slug, 'ecosystems'])),
    ...doc.consumes.flatMap((c, i) =>
      c.ecosystem === ecosystemId ? [pointer(['consumes', i, 'ecosystem'])] : [],
    ),
  ];
}

async function assertSide(
  row: MembershipRow,
  eco: HeldEcosystem,
  verb: MembershipVerb,
  userId: string,
) {
  if (TRANSITIONS[verb].side === 'steward') {
    await assertStewardAdmin(eco.stewardOrgId, userId);
    return;
  }
  await requireCan(actorFor(userId), 'project.admin', projectResource(row.projectId));
}

export async function transition(input: {
  membershipId: string;
  verb: MembershipVerb;
  userId: string;
  reason: string | null;
}): Promise<MembershipOutcome> {
  const { membershipId, verb, userId, reason } = input;
  const row = await readMembership(db, membershipId);
  if (!row) throw notFound(`membership ${membershipId} does not exist`);
  const eco = await loadEcosystem(row.ecosystemId);
  await assertSide(row, eco, verb, userId);
  const rule = TRANSITIONS[verb];
  const notAllowed = (state: string): MembershipOutcome => ({
    ok: false,
    refusals: [
      {
        code: 'MEMBERSHIP_TRANSITION_NOT_ALLOWED',
        path: '/state',
        detail: `${verb} moves a membership ${rule.from} -> ${rule.to}, and membership ${membershipId} is ${state}; invited -> active | declined, active -> left | removed, and nothing leaves declined, left or removed.`,
      },
    ],
  });
  if (row.state !== rule.from) return notAllowed(row.state);
  // the head is read before anything moves: a join whose run cannot name the commit it reads is refused whole, never accepted with a stand-in sha
  let joined: BuilderRunWrite['trigger'] | null = null;
  if (verb === 'accept') {
    const trigger = await owedTrigger({
      projectId: row.projectId,
      kind: 'joined',
      source: await sourceOf(row.projectId),
    });
    if (!trigger.ok) return trigger;
    joined = trigger.value;
  }
  return db.transaction(async (tx): Promise<MembershipOutcome> => {
    await lockKeys(tx, [
      `project:${row.projectId}`,
      `membership:${row.ecosystemId}:${row.projectId}`,
    ]);
    if (verb === 'leave') {
      const stored = await readInterface(tx, row.projectId);
      const doc = stored
        ? storedAs(interfaceDocumentSchema, stored.document, `interface of ${row.projectId}`)
        : null;
      const naming = doc ? namesEcosystem(doc, row.ecosystemId) : [];
      if (naming.length > 0) {
        return {
          ok: false,
          refusals: naming.map((path) => ({
            code: 'MEMBERSHIP_IN_USE' as const,
            path,
            detail: `this project's interface still names ecosystem ${eco.document.ecosystem.slug} at ${path}; take it out of the interface first, then leave.`,
          })),
        };
      }
    }
    const moved = await applyTransition(tx, { row, verb, to: rule.to, userId, reason });
    if (!moved) {
      const now = await readMembership(tx, membershipId);
      return notAllowed(now?.state ?? 'gone');
    }
    if (joined) {
      await openOwedRun(tx, {
        ecosystemId: row.ecosystemId,
        projectId: row.projectId,
        trigger: joined,
        userId,
      });
      await emitEvent(tx, 'ecosystem.buildOwed', { projectId: row.projectId });
    }
    return { ok: true, membership: moved } as MembershipOutcome;
  });
}

export async function readableMembership(userId: string, membershipId: string) {
  const row = await readMembership(db, membershipId);
  if (!row) throw notFound(`membership ${membershipId} does not exist`);
  const eco = await loadEcosystem(row.ecosystemId);
  if (await loadOrgRole(eco.stewardOrgId, userId)) return row;
  if ((await readerProjects(userId)).has(row.projectId)) return row;
  throw forbidden(`membership ${membershipId} is readable by its steward org and its project`);
}

export async function readableEcosystem(userId: string, ecosystemId: string) {
  const eco = await loadEcosystem(ecosystemId);
  if (await loadOrgRole(eco.stewardOrgId, userId)) return { eco, steward: true };
  const mine = await readerProjects(userId);
  const open = await membershipsWhere({ ecosystemIds: [ecosystemId], projectIds: [...mine] });
  if (open.some((m) => m.state === 'invited' || m.state === 'active'))
    return { eco, steward: false };
  throw forbidden(
    `ecosystem ${ecosystemId} is readable by its steward org and by projects invited to it or active in it`,
  );
}

export async function visibleMemberships(userId: string, ecosystemId: string) {
  const { eco, steward } = await readableEcosystem(userId, ecosystemId);
  const all = await membershipsWhere({ ecosystemIds: [ecosystemId] });
  if (steward) return { eco, memberships: all };
  const mine = await readerProjects(userId);
  const seen = visibleMembers(await loadGraph([ecosystemId]), mine, ecosystemId);
  return {
    eco,
    memberships: all.filter(
      (m) => mine.has(m.projectId) || (m.state === 'active' && seen.has(m.projectId)),
    ),
  };
}
