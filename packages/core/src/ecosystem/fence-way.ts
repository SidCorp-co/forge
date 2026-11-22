// The door that works where a credential's fence refuses another project (ISS-1279): adminhub-api's
// master, fenced to its own project, was refused PAT_PROJECT_OUTSIDE_FENCE writing adminhub-fe's half
// of ISS-243, heard nothing of the channel, and handed the act to a person. The fence stands; its
// refusal names the channel's acts toward a project an ecosystem the credential's projects are in
// shows them: the handoff door for a finding (ISS-1286), and a change request where the two are
// counterparties; and who links them where no ecosystem shows it.
// It says nothing about the named project that its own projects cannot already read: a peer is named
// only where the ecosystem shows it to them (`party.ts:visibleMembers`), and the rest reads the same
// whether or not the named project exists.

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { heldEcosystem } from './ecosystem-service.js';
import { loadGraph } from './graph.js';
import { membershipsWhere } from './membership-store.js';
import { liveEdges, visibleMembers } from './party.js';
import { HANDOFF_KINDS } from './refusals.js';
import { projectsWhere, readEcosystems } from './store.js';

/** A shared ecosystem the named project is seen in from one of the fence's projects. */
export interface FenceWay {
  ecosystem: { id: string; slug: string };
  from: { id: string; slug: string };
  to: { id: string; slug: string };
  /** The contract the two share there, `<provider>/<contract>`; null where neither consumes from the other. */
  contract: string | null;
}

/** An ecosystem a fence's project is active in, and the organization whose admins invite into it. */
export interface FenceSteward {
  ecosystem: { id: string; slug: string };
  org: { id: string; name: string | null };
}

export interface FenceChannel {
  ways: FenceWay[];
  stewards: FenceSteward[];
  /** The sentence the refusal adds: the channel act, or why there is none and who links them. */
  said: string;
}

const GUIDE = 'GET /api/guides/ecosystem-inbox.md';

/** The handoff door (ISS-1286): a finding in the named project's part, filed at its intake. */
function handoffSaid(way: FenceWay): string {
  return (
    `a finding in ${way.to.slug}'s part (a defect, a question, an idea) goes to its intake by the ` +
    `handoff door, \`POST /api/projects/${way.from.id}/channel/handoffs\` { "to": "${way.to.id}", ` +
    `"item": <the ISS-n or FB-n of ${way.from.slug} it came from>, "kind": ${HANDOFF_KINDS}, "title", ` +
    '"whereSeen" }'
  );
}

function actSaid(way: FenceWay & { contract: string }): string {
  const own = `/api/projects/${way.from.id}/channel`;
  return (
    `${way.from.slug} and ${way.to.slug} are counterparties in ecosystem ${way.ecosystem.slug}, so ` +
    `the channel carries it instead, as ${way.from.slug}: ${handoffSaid(way)}; a part of the work ` +
    `for ${way.to.slug} to build goes as a change request, \`POST ${own}/drafts\` { "ecosystem": ` +
    `"${way.ecosystem.id}", "type": "change-request", "to": ["${way.to.id}"], "subject", "body": ` +
    `{ "contract": "${way.contract}", "need", "rationale", "impactIfDeclined", "urgency" } }, then ` +
    `\`POST ${own}/documents/<the draft's id>/submit\`. Either reaches ${way.to.slug} with no ` +
    `person carrying it (${GUIDE}).`
  );
}

function strangersSaid(way: FenceWay): string {
  return (
    `${way.from.slug} and ${way.to.slug} are both in ecosystem ${way.ecosystem.slug}, so ` +
    `${handoffSaid(way)}. A change request for its part of the work goes only between ` +
    `counterparties (RECIPIENT_NOT_COUNTERPARTY), and neither consumes from the other there: the ` +
    `consumer's interface naming the provider's contract under \`consumes\` ` +
    `(\`PUT /api/projects/<consumer>/interface\`) makes them counterparties (${GUIDE}).`
  );
}

/** Who links `fromSlugs` to a project they share no ecosystem with: the steward's invite and its accept. */
export function whoLinksSaid(fromSlugs: string[], stewards: FenceSteward[]): string {
  return stewards.length > 0
    ? `an admin of the organization stewarding an ecosystem ${fromSlugs.join(' or ')} is in (${stewards
        .map((s) => `${s.org.name ?? s.org.id} for ${s.ecosystem.slug}, ${s.ecosystem.id}`)
        .join('; ')}) invites that project (\`POST /api/ecosystems/<ecosystem>/invitations\` ` +
        `{ "project": <its uuid> }) and an admin of that project accepts ` +
        '(`POST /api/memberships/<membership>/accept`)'
    : `${fromSlugs.join(' and ')} ${fromSlugs.length === 1 ? 'is' : 'are'} in no ecosystem: an org admin creates one ` +
        '(`POST /api/ecosystems`) and invites both projects, each accepting as its own admin';
}

function unlinkedSaid(fromSlugs: string[], named: string, stewards: FenceSteward[]): string {
  const who = whoLinksSaid(fromSlugs, stewards);
  return (
    `No ecosystem channel carries a document from ${fromSlugs.join(' or ')} to project ${named}: ` +
    'the channel carries one only between counterparties in an ecosystem both are active in. ' +
    `To link them, ${who}; a consumes entry on the consumer's interface then makes them ` +
    `counterparties (${GUIDE}).`
  );
}

async function orgNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, [...new Set(ids)]));
  return new Map(rows.map((o) => [o.id, o.name]));
}

/**
 * What the ecosystem channel offers the fence's projects toward `named` (a project id, or null where
 * the name resolved to none): each shared ecosystem it is seen in, the contract the two share there,
 * and the stewards of the ecosystems the fence's projects are in.
 */
export async function fenceChannelWay(
  fence: readonly string[],
  named: { id: string | null; ref: string },
): Promise<FenceChannel> {
  const memberships = (await membershipsWhere({ projectIds: fence })).filter(
    (m) => m.state === 'active',
  );
  const ecosystemIds = [...new Set(memberships.map((m) => m.ecosystemId))];
  const [graph, ecoRows] = await Promise.all([
    loadGraph(ecosystemIds),
    readEcosystems(db, ecosystemIds),
  ]);
  const ecos = new Map(ecoRows.map((r) => [r.id, heldEcosystem(r)]));
  const found: {
    ecosystemId: string;
    from: string;
    edge: { provider: string; contract: string } | null;
  }[] = [];
  const target = named.id?.toLowerCase() ?? null;
  for (const m of memberships) {
    if (!target || m.projectId === target) continue;
    if (!graph.active.get(m.ecosystemId)?.has(target)) continue;
    if (!visibleMembers(graph, new Set([m.projectId]), m.ecosystemId).has(target)) continue;
    const edge = liveEdges(graph).find(
      (e) =>
        e.ecosystemId === m.ecosystemId &&
        ((e.consumerProjectId === m.projectId && e.providerProjectId === target) ||
          (e.consumerProjectId === target && e.providerProjectId === m.projectId)),
    );
    found.push({
      ecosystemId: m.ecosystemId,
      from: m.projectId,
      edge: edge ? { provider: edge.providerProjectId, contract: edge.contractSlug } : null,
    });
  }
  const slugIds = [...new Set([...fence, ...(target && found.length > 0 ? [target] : [])])];
  const [projects, orgs] = await Promise.all([
    projectsWhere(db, { ids: slugIds }),
    orgNames([...ecos.values()].map((e) => e.stewardOrgId)),
  ]);
  const slug = new Map(projects.map((p) => [p.id, p.slug]));
  const ecoOf = (id: string) => ({ id, slug: ecos.get(id)?.document.ecosystem.slug ?? id });
  const ways: FenceWay[] = found.map((f) => ({
    ecosystem: ecoOf(f.ecosystemId),
    from: { id: f.from, slug: slug.get(f.from) ?? f.from },
    to: { id: target ?? named.ref, slug: (target && slug.get(target)) ?? named.ref },
    contract: f.edge ? `${slug.get(f.edge.provider) ?? f.edge.provider}/${f.edge.contract}` : null,
  }));
  const stewards: FenceSteward[] = ecosystemIds.map((id) => {
    const orgId = ecos.get(id)?.stewardOrgId ?? '';
    return { ecosystem: ecoOf(id), org: { id: orgId, name: orgs.get(orgId) ?? null } };
  });
  const act = ways.find((w): w is FenceWay & { contract: string } => w.contract !== null);
  const said = act
    ? actSaid(act)
    : ways[0]
      ? strangersSaid(ways[0])
      : unlinkedSaid(
          fence.map((id) => slug.get(id) ?? id),
          named.ref,
          stewards,
        );
  return { ways, stewards, said };
}
