// Who a project may address in its ecosystem channel (ISS-1360, FB-774): epod's master, fenced to its
// own project, could not address its first change request to sid-desk, since `to` took only a uuid
// and no door it reached named its ecosystem's members. The members read here are those the
// ecosystem shows the project (`party.ts:visibleMembers`), id, slug and name and nothing else of
// them, so a hidden member reads the same as a project that does not exist.

import { db } from '../db/client.js';
import { refuse } from './channel-act.js';
import { UUID_PATTERN } from './channel-schema.js';
import { heldEcosystem } from './ecosystem-service.js';
import { loadGraph } from './graph.js';
import { membershipsWhere } from './membership-store.js';
import { visibleMembers } from './party.js';
import { projectsWhere, readEcosystems } from './store.js';

export interface ChannelMember {
  id: string;
  slug: string;
  name: string;
}

export interface ChannelMembersView {
  project: string;
  ecosystems: { ecosystem: { id: string; slug: string }; members: ChannelMember[] }[];
}

/** The members each of `ecosystemIds` shows `projectId`, itself left out: who it may address there. */
async function shownMembers(
  projectId: string,
  ecosystemIds: readonly string[],
): Promise<Map<string, ChannelMember[]>> {
  const graph = await loadGraph(ecosystemIds);
  const self = new Set([projectId]);
  const shown = new Map(
    ecosystemIds.map((e) => [
      e,
      [...visibleMembers(graph, self, e)].filter((p) => p !== projectId),
    ]),
  );
  const rows = await projectsWhere(db, { ids: [...new Set([...shown.values()].flat())] });
  const named = new Map(rows.map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
  return new Map(
    [...shown].map(([e, ids]) => [
      e,
      ids.flatMap((id) => named.get(id) ?? []).sort((a, b) => a.slug.localeCompare(b.slug)),
    ]),
  );
}

/** The `members` read of both doors: each ecosystem `projectId` is active in, and who it shows it. */
export async function readChannelMembers(projectId: string): Promise<ChannelMembersView> {
  const ecosystemIds = (await membershipsWhere({ projectIds: [projectId] }))
    .filter((m) => m.state === 'active')
    .map((m) => m.ecosystemId);
  const [ecos, members] = await Promise.all([
    readEcosystems(db, ecosystemIds),
    shownMembers(projectId, ecosystemIds),
  ]);
  const slugOf = new Map(ecos.map((e) => [e.id, heldEcosystem(e).document.ecosystem.slug]));
  return {
    project: projectId,
    ecosystems: ecosystemIds.map((id) => ({
      ecosystem: { id, slug: slugOf.get(id) ?? id },
      members: members.get(id) ?? [],
    })),
  };
}

const listed = (members: readonly ChannelMember[]) =>
  members.length === 0
    ? 'it shows this project no member to address'
    : `the members it may address are ${members.map((m) => `${m.slug} (${m.name})`).join(', ')}`;

/**
 * A draft's `to`, each entry a member's slug or uuid, as the uuids the document stores. A uuid of an
 * active member passes as it is, for the channel's own rules to decide (`channel-rules.ts:partyRefusals`);
 * a slug resolves only among the members the ecosystem shows the sender; anything else is refused
 * CHANNEL_TO_NOT_MEMBER, listing who it may address. A `to` that is not a list of strings is left to
 * the document schema.
 */
export async function recipientIds(args: {
  projectId: string;
  ecosystem: { id: string; slug: string };
  to: unknown;
}): Promise<unknown> {
  const { projectId, to } = args;
  const ecosystemId = args.ecosystem.id;
  if (!Array.isArray(to) || !to.every((t): t is string => typeof t === 'string')) return to;
  const graph = await loadGraph([ecosystemId]);
  const active = graph.active.get(ecosystemId) ?? new Set<string>();
  const members = (await shownMembers(projectId, [ecosystemId])).get(ecosystemId) ?? [];
  const bySlug = new Map(members.map((m) => [m.slug, m.id]));
  return to.map((value, i) => {
    const named = value.trim();
    if (UUID_PATTERN.test(named) && active.has(named.toLowerCase())) return named.toLowerCase();
    if (named.toLowerCase() === projectId) return projectId;
    const id = bySlug.get(named.toLowerCase());
    if (id) return id;
    return refuse(
      'CHANNEL_TO_NOT_MEMBER',
      `/to/${i}`,
      `to names ${named}, which is no member of ecosystem ${args.ecosystem.slug} this project may address; ` +
        `each entry is a member's slug or uuid, and ${listed(members)} ` +
        `(GET /api/projects/${projectId}/channel/members, or forge_channel action members).`,
    );
  });
}
