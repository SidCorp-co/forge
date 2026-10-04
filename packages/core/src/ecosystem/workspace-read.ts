import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { ecosystems as ecosystemTable } from '../db/schema-ecosystem.js';
import { readerProjects } from './access.js';
import { type RegisterRow, registerRowsOver } from './channel-register.js';
import type { ChannelDocument } from './channel-schema.js';
import { documentsWhere } from './channel-store.js';
import { serveAll } from './channel-world.js';
import { type HeldEcosystem, heldEcosystem } from './ecosystem-service.js';
import { membershipsWhere } from './membership-store.js';
import type { EcosystemDocument } from './schema.js';
import { projectsWhere, readEcosystems } from './store.js';

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

async function stewardedBy(orgs: ReadonlySet<string>): Promise<string[]> {
  if (orgs.size === 0) return [];
  const rows = await db
    .select({ id: ecosystemTable.id })
    .from(ecosystemTable)
    .where(inArray(ecosystemTable.stewardOrgId, [...orgs]));
  return rows.map((r) => r.id);
}

async function orgNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, [...new Set(ids)]));
  return new Map(rows.map((o) => [o.id, o.name]));
}

async function threadsOf(held: readonly HeldEcosystem[], mine: ReadonlySet<string>) {
  const threads: WorkspaceRead['threads'] = [];
  for (const h of held) {
    const stored = await documentsWhere(db, { ecosystem: h.id, published: true });
    for (const row of await registerRowsOver(stored)) {
      if (mine.has(row.from) || row.to.some((t) => mine.has(t)))
        threads.push({ ...row, ecosystem: h.id });
    }
  }
  return threads.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

async function draftsOf(
  senders: readonly string[],
  ids: ReadonlySet<string>,
): Promise<WorkspaceDraft[]> {
  const pending = (await Promise.all(senders.map((p) => documentsWhere(db, { from: p })))).flatMap(
    (rows) => rows.filter((r) => r.state !== 'published' && r.inReplyTo && ids.has(r.ecosystemId)),
  );
  return (await serveAll(db, pending)).map(({ id, document: d }) => ({
    id,
    ecosystem: d.ecosystem,
    from: d.from,
    inReplyTo: d.inReplyTo as string,
    type: d.type,
    state: d.state,
    authoredBy: d.authoredBy,
    gate: d.gate ?? null,
  }));
}

function ecosystemRow(
  h: HeldEcosystem,
  steward: WorkspaceEcosystem['steward'],
  members: string[],
): WorkspaceEcosystem {
  return {
    id: h.id,
    slug: h.document.ecosystem.slug,
    name: h.document.ecosystem.name,
    purpose: h.document.ecosystem.purpose ?? null,
    code: h.document.channel.code,
    steward,
    visibility: h.document.visibility.members,
    responseDays: h.document.channel.responseDays,
    gate: h.document.gate,
    members,
  };
}

// cm:why an ecosystem is the person's when one of their projects is invited to it or active in it, or their org stewards it — the same readers readableEcosystem admits — and every row is one a project of theirs sent or received, as in readRegister
export async function readWorkspace(userId: string): Promise<WorkspaceRead> {
  const mine = await readerProjects(userId);
  const orgs = await orgsOf(userId);
  const memberships = await membershipsWhere({ projectIds: [...mine] });
  const ids = new Set([
    ...memberships
      .filter((m) => m.state === 'active' || m.state === 'invited')
      .map((m) => m.ecosystemId),
    ...(await stewardedBy(orgs)),
  ]);
  const held = (await readEcosystems(db, [...ids])).map(heldEcosystem);
  const stewards = await orgNames(held.map((h) => h.stewardOrgId));
  const activeIn = (eco: string) =>
    memberships
      .filter((m) => m.ecosystemId === eco && m.state === 'active')
      .map((m) => m.projectId);
  const threads = await threadsOf(held, mine);
  const drafts = await draftsOf([...new Set(held.flatMap((h) => activeIn(h.id)))], ids);
  const named = new Set([
    ...memberships.map((m) => m.projectId),
    ...threads.flatMap((t) => [t.from, ...t.to]),
  ]);
  return {
    ecosystems: held
      .map((h) =>
        ecosystemRow(
          h,
          {
            id: h.stewardOrgId,
            name: stewards.get(h.stewardOrgId) ?? null,
            mine: orgs.has(h.stewardOrgId),
          },
          activeIn(h.id),
        ),
      )
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
