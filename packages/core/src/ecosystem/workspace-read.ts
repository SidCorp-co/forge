import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { ecosystems as ecosystemTable } from '../db/schema-ecosystem.js';
import { readerProjects } from './access.js';
import { type RegisterRow, registerRowsOver } from './channel-register.js';
import type { ChannelDocument } from './channel-schema.js';
import { documentsWhere } from './channel-store.js';
import { serveAll } from './channel-world.js';
import { heldEcosystem } from './ecosystem-service.js';
import type { EcosystemDocument } from './schema.js';
import { membershipsWhere, projectsWhere, readEcosystems } from './store.js';

export interface WorkspaceEcosystem {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  code: string;
  steward: { id: string; name: string | null; mine: boolean };
  visibility: EcosystemDocument['visibility']['members'];
  responseDays: EcosystemDocument['channel']['responseDays'];
  gate: EcosystemDocument['gate'];
  /** The reader's projects active in it. */
  members: string[];
}

export interface WorkspaceInvitation {
  membership: string;
  ecosystem: string;
  project: string;
  invitedAt: string;
}

/** A reply one of the reader's projects has not published yet, so a row can say who is writing it. */
export interface WorkspaceDraft {
  id: string;
  ecosystem: string;
  from: string;
  inReplyTo: string;
  type: ChannelDocument['type'];
  state: ChannelDocument['state'];
  authoredBy: ChannelDocument['authoredBy'];
  gate: ChannelDocument['gate'] | null;
}

export interface WorkspaceRead {
  ecosystems: WorkspaceEcosystem[];
  invitations: WorkspaceInvitation[];
  threads: (RegisterRow & { ecosystem: string })[];
  drafts: WorkspaceDraft[];
  projects: { id: string; slug: string; name: string }[];
  mine: string[];
}

async function orgsOf(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  return new Set(rows.map((r) => r.orgId));
}

// cm:why an ecosystem is the person's when one of their projects is invited to it or active in it, or their org stewards it — the same readers readableEcosystem admits — and every row is one a project of theirs sent or received, as in readRegister
export async function readWorkspace(userId: string): Promise<WorkspaceRead> {
  const mine = await readerProjects(userId);
  const orgs = await orgsOf(userId);
  const memberships = await membershipsWhere({ projectIds: [...mine] });
  const stewarded =
    orgs.size === 0
      ? []
      : await db
          .select({ id: ecosystemTable.id })
          .from(ecosystemTable)
          .where(inArray(ecosystemTable.stewardOrgId, [...orgs]));
  const ids = new Set([
    ...memberships
      .filter((m) => m.state === 'active' || m.state === 'invited')
      .map((m) => m.ecosystemId),
    ...stewarded.map((s) => s.id),
  ]);
  const held = (await readEcosystems(db, [...ids])).map(heldEcosystem);
  const stewards = new Map(
    held.length === 0
      ? []
      : (
          await db
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(inArray(organizations.id, [...new Set(held.map((h) => h.stewardOrgId))]))
        ).map((o) => [o.id, o.name]),
  );
  const activeIn = (eco: string) =>
    memberships
      .filter((m) => m.ecosystemId === eco && m.state === 'active')
      .map((m) => m.projectId);

  const threads: WorkspaceRead['threads'] = [];
  for (const h of held) {
    const stored = await documentsWhere(db, { ecosystem: h.id, published: true });
    for (const row of await registerRowsOver(stored)) {
      if (mine.has(row.from) || row.to.some((t) => mine.has(t)))
        threads.push({ ...row, ecosystem: h.id });
    }
  }
  threads.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  const senders = [...new Set(held.flatMap((h) => activeIn(h.id)))];
  const pending = (await Promise.all(senders.map((p) => documentsWhere(db, { from: p })))).flatMap(
    (rows) => rows.filter((r) => r.state !== 'published' && r.inReplyTo && ids.has(r.ecosystemId)),
  );
  const drafts = (await serveAll(db, pending)).map(({ id, document: d }) => ({
    id,
    ecosystem: d.ecosystem,
    from: d.from,
    inReplyTo: d.inReplyTo as string,
    type: d.type,
    state: d.state,
    authoredBy: d.authoredBy,
    gate: d.gate ?? null,
  }));

  const named = new Set([
    ...memberships.map((m) => m.projectId),
    ...threads.flatMap((t) => [t.from, ...t.to]),
  ]);
  return {
    ecosystems: held
      .map((h) => ({
        id: h.id,
        slug: h.document.ecosystem.slug,
        name: h.document.ecosystem.name,
        purpose: h.document.ecosystem.purpose ?? null,
        code: h.document.channel.code,
        steward: {
          id: h.stewardOrgId,
          name: stewards.get(h.stewardOrgId) ?? null,
          mine: orgs.has(h.stewardOrgId),
        },
        visibility: h.document.visibility.members,
        responseDays: h.document.channel.responseDays,
        gate: h.document.gate,
        members: activeIn(h.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    invitations: memberships
      .filter((m) => m.state === 'invited')
      .map((m) => ({
        membership: m.id,
        ecosystem: m.ecosystemId,
        project: m.projectId,
        invitedAt: m.invitedAt.toISOString(),
      })),
    threads,
    drafts,
    projects: await projectsWhere(db, { ids: [...named] }),
    mine: [...mine].filter((p) => memberships.some((m) => m.projectId === p)),
  };
}
