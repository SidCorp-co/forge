// A group's switch from the bot outside Forge that answers it to the project's channel agent (REQ-77
// BC-16..BC-19). A person plans it — the outside bot's chat account, the duties the agent must pass,
// the switch it waits on, whether the owner's word is needed — passes each duty with what they saw,
// and applies it. Applying removes the outside bot's account from the group on the chat server,
// clears its declaration on the channel record, and moves the group from `outsideRids` to the
// agent's `rids` through the binding door, which refuses that move by any other road
// (`agentSwitchRefusals`). OrbitInternal switches first, AdminHub's names OrbitInternal's switch as
// the one it waits on, and mail's needs the owner's word.

import type {
  ChannelSwitchOpen,
  ChannelSwitchPlan,
  ChannelSwitchView,
} from '@forge/contracts/support-channel';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportChannelSwitches, supportChannels } from '../db/schema-support.js';
import { listBindingsForProject } from '../integrations/index.js';
import {
  type AgentSwitchGate,
  kickFromGroup,
  resolveRoomPostAuth,
} from '../integrations/rocketchat/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import type { ApiRefusal } from '../project-config/index.js';
import { planBinding, readBinding, writeBinding } from '../project-config/index.js';
import { privateRefusal } from './channel.js';
import { answeredOutside, channelOf } from './channel-store.js';
import { no, type Outcome } from './outcome.js';

type SwitchRow = typeof supportChannelSwitches.$inferSelect;

interface DutyRecord {
  key: string;
  text: string;
  passedBy: string | null;
  passedAt: string | null;
  evidence: string | null;
}

/** How long a running switch lets its group through the binding door: the switch's own writes. */
const APPLYING_FOR_MS = 2 * 60_000;

const dutiesOf = (row: SwitchRow): DutyRecord[] => (row.duties ?? []) as DutyRecord[];

async function switchOf(projectId: string, rid: string): Promise<SwitchRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelSwitches)
    .where(
      and(eq(supportChannelSwitches.projectId, projectId), eq(supportChannelSwitches.rid, rid)),
    )
    .limit(1);
  return row ?? null;
}

async function switchById(id: string): Promise<SwitchRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelSwitches)
    .where(eq(supportChannelSwitches.id, id))
    .limit(1);
  return row ?? null;
}

/** What still stands before the switch: an unpassed duty, the earlier switch unproven, the owner's word. */
async function openOf(row: SwitchRow): Promise<ChannelSwitchOpen[]> {
  const open: ChannelSwitchOpen[] = dutiesOf(row)
    .filter((d) => !d.passedAt)
    .map((d) => ({ kind: 'duty' as const, key: d.key }));
  if (row.afterSwitchId) {
    const after = await switchById(row.afterSwitchId);
    if (!after?.provenAt) {
      open.push({ kind: 'after', switchId: row.afterSwitchId, rid: after?.rid ?? '?' });
    }
  }
  if (row.ownerWordNeeded && !row.ownerWord) open.push({ kind: 'owner_word' });
  return open;
}

const describeOpen = (open: ChannelSwitchOpen[]): string =>
  open
    .map((o) =>
      o.kind === 'duty'
        ? `duty ${o.key} is not passed`
        : o.kind === 'after'
          ? `the switch of group ${o.rid} it waits on is not proven yet`
          : "the owner's word is not given",
    )
    .join('; ');

async function viewOf(row: SwitchRow): Promise<ChannelSwitchView> {
  return {
    id: row.id,
    projectId: row.projectId,
    rid: row.rid,
    outsideBot: { userId: row.outsideBotUserId, username: row.outsideBotUsername },
    duties: dutiesOf(row).map((d) => ({ ...d })),
    after: row.afterSwitchId,
    ownerWordNeeded: row.ownerWordNeeded,
    ownerWord:
      row.ownerWord && row.ownerWordBy && row.ownerWordAt
        ? { words: row.ownerWord, by: row.ownerWordBy, at: row.ownerWordAt.toISOString() }
        : null,
    open: await openOf(row),
    switchedAt: row.switchedAt?.toISOString() ?? null,
    provenAt: row.provenAt?.toISOString() ?? null,
    provenNote: row.provenNote,
  };
}

const unknownSwitch = <T>(rid: string): Outcome<T> =>
  no('AGENT_SWITCH_UNKNOWN', '/rid', `no switch is planned for group ${rid} in this project`);

const done = <T>(row: SwitchRow): Outcome<T> =>
  no(
    'AGENT_SWITCH_DONE',
    '/rid',
    `group ${row.rid} switched to the channel agent at ${row.switchedAt?.toISOString()}; its plan and duties no longer change`,
  );

/** A project reader reads the switch. */
export async function readSwitch(
  viewer: string,
  projectId: string,
  rid: string,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const row = await switchOf(projectId, rid);
  return row ? { ok: true, value: await viewOf(row) } : unknownSwitch(rid);
}

/**
 * Plan a group's switch, or plan it again before it runs: a duty whose key and words stay keeps its
 * pass; one changed is passed again. Only a group a binding of the project names in `outsideRids`
 * has a bot outside Forge to switch from.
 */
export async function planSwitch(
  viewer: string,
  projectId: string,
  rid: string,
  plan: ChannelSwitchPlan,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.admin', projectResource(projectId));
  for (const [i, d] of plan.duties.entries()) {
    const refused = privateRefusal<ChannelSwitchView>(`/duties/${i}/text`, d.text);
    if (refused) return refused;
  }
  const held = await switchOf(projectId, rid);
  if (held?.switchedAt) return done(held);
  if (!(await answeredOutside(projectId, rid))) {
    return no(
      'SUPPORT_CHANNEL_NOT_OUTSIDE',
      '/rid',
      `no binding of this project names group ${rid} in \`outsideRids\`, so no bot outside Forge answers it and there is nothing to switch from`,
    );
  }
  if (plan.after) {
    const after = await switchById(plan.after);
    if (!after || after.id === held?.id) {
      return no(
        'AGENT_SWITCH_PLAN_REFUSED',
        '/after',
        `${plan.after} is no other group's switch; name the switch this one waits on by its id`,
      );
    }
    await requireCan(actorFor(viewer), 'project.read', projectResource(after.projectId));
  }
  const kept = new Map(held ? dutiesOf(held).map((d) => [d.key, d]) : []);
  const duties: DutyRecord[] = plan.duties.map((d) => {
    const before = kept.get(d.key);
    return before && before.text === d.text
      ? before
      : { key: d.key, text: d.text, passedBy: null, passedAt: null, evidence: null };
  });
  const values = {
    outsideBotUserId: plan.outsideBot.userId,
    outsideBotUsername: plan.outsideBot.username ?? null,
    duties,
    afterSwitchId: plan.after ?? null,
    ownerWordNeeded: plan.ownerWord ?? false,
    updatedAt: new Date(),
  };
  const [row] = held
    ? await db
        .update(supportChannelSwitches)
        .set(values)
        .where(eq(supportChannelSwitches.id, held.id))
        .returning()
    : await db
        .insert(supportChannelSwitches)
        .values({ projectId, rid, createdBy: viewer, ...values })
        .returning();
  if (!row) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(row) };
}

/** A person passes one duty, naming what they saw the agent do (BC-16). */
export async function passDuty(
  viewer: string,
  projectId: string,
  rid: string,
  key: string,
  evidence: string,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.write', projectResource(projectId));
  const refused = privateRefusal<ChannelSwitchView>('/evidence', evidence);
  if (refused) return refused;
  const row = await switchOf(projectId, rid);
  if (!row) return unknownSwitch(rid);
  if (row.switchedAt) return done(row);
  const duties = dutiesOf(row);
  const duty = duties.find((d) => d.key === key);
  if (!duty) {
    return no(
      'AGENT_SWITCH_PLAN_REFUSED',
      '/key',
      `group ${rid}'s switch names no duty ${key}; its duties are ${duties.map((d) => d.key).join(', ')}`,
    );
  }
  const at = new Date().toISOString();
  const next = duties.map((d) =>
    d.key === key ? { ...d, passedBy: viewer, passedAt: at, evidence } : d,
  );
  const [updated] = await db
    .update(supportChannelSwitches)
    .set({ duties: next, updatedAt: new Date() })
    .where(eq(supportChannelSwitches.id, row.id))
    .returning();
  if (!updated) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(updated) };
}

/** The owner's word for a switch that needs it (BC-19), in their words, by a project admin. */
export async function giveOwnerWord(
  viewer: string,
  projectId: string,
  rid: string,
  words: string,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.admin', projectResource(projectId));
  const row = await switchOf(projectId, rid);
  if (!row) return unknownSwitch(rid);
  if (row.switchedAt) return done(row);
  if (!row.ownerWordNeeded) {
    return no(
      'AGENT_SWITCH_PLAN_REFUSED',
      '/words',
      `group ${rid}'s switch waits on no owner's word; plan it with \`ownerWord: true\` first`,
    );
  }
  const [updated] = await db
    .update(supportChannelSwitches)
    .set({ ownerWord: words, ownerWordBy: viewer, ownerWordAt: new Date(), updatedAt: new Date() })
    .where(eq(supportChannelSwitches.id, row.id))
    .returning();
  if (!updated) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(updated) };
}

/** A person marks a switched group answered as well as its outside bot answered it (BC-18). */
export async function markProven(
  viewer: string,
  projectId: string,
  rid: string,
  note: string,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.write', projectResource(projectId));
  const row = await switchOf(projectId, rid);
  if (!row) return unknownSwitch(rid);
  if (!row.switchedAt) {
    return no(
      'AGENT_SWITCH_NOT_SWITCHED',
      '/rid',
      `group ${rid} has not switched to the channel agent yet, so nothing of the agent's there can be proven`,
    );
  }
  const [updated] = await db
    .update(supportChannelSwitches)
    .set({ provenAt: new Date(), provenBy: viewer, provenNote: note, updatedAt: new Date() })
    .where(eq(supportChannelSwitches.id, row.id))
    .returning();
  if (!updated) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(updated) };
}

/** The project's rocketchat binding that carries the channel agent and names `rid` in `outsideRids`. */
async function switchingBinding(projectId: string, rid: string) {
  const pairs = (await listBindingsForProject(projectId)).filter(
    (p) => p.binding.provider === 'rocketchat',
  );
  return (
    pairs.find((p) => {
      const c = (p.binding.config ?? {}) as { agent?: unknown; outsideRids?: unknown };
      return Boolean(c.agent) && Array.isArray(c.outsideRids) && c.outsideRids.includes(rid);
    }) ?? null
  );
}

type ApplyOutcome =
  | { ok: true; value: ChannelSwitchView }
  | { ok: false; refusals: (ApiRefusal | { code: string; path: string; detail: string })[] };

async function stopApplying(id: string): Promise<void> {
  await db
    .update(supportChannelSwitches)
    .set({ applyingAt: null })
    .where(eq(supportChannelSwitches.id, id));
}

/**
 * Run the switch (BC-16): nothing stands before it, the outside bot's account leaves the group on
 * the chat server, its declaration leaves the channel record, and the group moves from
 * `outsideRids` to the agent's `rids` through the binding door. The binding is planned before the
 * outside bot is removed, so a write the door would refuse removes nobody.
 */
export async function applySwitch(
  viewer: string,
  projectId: string,
  rid: string,
): Promise<ApplyOutcome> {
  await requireCan(actorFor(viewer), 'project.admin', projectResource(projectId));
  const row = await switchOf(projectId, rid);
  if (!row) return unknownSwitch(rid);
  if (row.switchedAt) return done(row);
  const open = await openOf(row);
  if (open.length > 0) {
    return no(
      'AGENT_SWITCH_NOT_READY',
      '/rid',
      `group ${rid} does not switch yet: ${describeOpen(open)}; nothing was changed`,
    );
  }
  const pair = await switchingBinding(projectId, rid);
  if (!pair) {
    return no(
      'AGENT_SWITCH_NO_AGENT',
      '/rid',
      `no rocketchat binding of this project carries a channel agent (\`agent\`) and names group ${rid} in \`outsideRids\`; add the agent block to the binding that names it`,
    );
  }
  const read = await readBinding(projectId, pair.binding.id);
  if (!read?.ok)
    throw new Error(`support: binding ${pair.binding.id} cannot be read as a document`);
  const target = read.held.document.target as Record<string, unknown>;
  const outside = ((target.outsideRids as string[] | undefined) ?? []).filter((r) => r !== rid);
  const nextTarget: Record<string, unknown> = {
    ...target,
    rids: [...((target.rids as string[] | undefined) ?? []), rid],
  };
  if (outside.length > 0) nextTarget.outsideRids = outside;
  else delete nextTarget.outsideRids;
  const raw = { ...read.held.document, target: nextTarget };
  const write = { projectId, bindingId: pair.binding.id, userId: viewer, raw };

  await db
    .update(supportChannelSwitches)
    .set({ applyingAt: new Date() })
    .where(eq(supportChannelSwitches.id, row.id));
  const planned = await planBinding({ ...write, baseRevision: read.held.revision });
  if (!planned.ok) {
    await stopApplying(row.id);
    return planned;
  }
  const auth = await resolveRoomPostAuth(pair.binding.connectionId, { roomId: row.id });
  const kicked = auth
    ? await kickFromGroup(auth, rid, row.outsideBotUserId)
    : ({ state: 'refused', status: 0, why: 'the binding holds no usable bot credential' } as const);
  if (kicked.state !== 'removed' && kicked.state !== 'not-member') {
    await stopApplying(row.id);
    return no(
      'AGENT_SWITCH_BOT_NOT_REMOVED',
      '/rid',
      `the chat server did not remove the outside bot ${row.outsideBotUsername ?? row.outsideBotUserId} from group ${rid} (${kicked.why}); the group still answers as before and nothing was switched. Give the binding's bot the right to remove members of the group, then run the switch again`,
    );
  }
  const written = await writeBinding({ ...write, baseRevision: read.held.revision });
  if (!written.ok) {
    await stopApplying(row.id);
    return {
      ok: false,
      refusals: written.refusals.map((r) => ({
        ...r,
        detail: `${r.detail} — the outside bot was already removed from group ${rid}, so nobody answers it until the switch is run again`,
      })),
    };
  }
  const now = new Date();
  const [updated] = await db
    .update(supportChannelSwitches)
    .set({ applyingAt: null, switchedAt: now, switchedBy: viewer, updatedAt: now })
    .where(eq(supportChannelSwitches.id, row.id))
    .returning();
  // the outside bot no longer answers here: its address leaves the registry (BC-42)
  await db
    .update(supportChannels)
    .set({
      agentRole: null,
      agentBox: null,
      agentAddress: null,
      agentDeclaredAt: null,
      agentDeclaredBy: null,
    })
    .where(and(eq(supportChannels.projectId, projectId), eq(supportChannels.rid, rid)));
  if (!updated) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(updated) };
}

/**
 * The binding door's question (BC-16): which of the groups a write adds to the channel agent may not
 * join it. A group with a switch planned joins only while that switch runs; a group the binding held
 * in `outsideRids`, or whose record names an agent outside Forge, joins only through a switch. Any
 * other group — never answered outside Forge — joins freely.
 */
export const agentSwitchGate: AgentSwitchGate = {
  async refusals({ projectId, joining, heldOutside }) {
    if (joining.length === 0) return [];
    const rids = joining.map((j) => j.rid);
    const switches = await db
      .select()
      .from(supportChannelSwitches)
      .where(
        and(
          eq(supportChannelSwitches.projectId, projectId),
          inArray(supportChannelSwitches.rid, rids),
        ),
      );
    const out: { path: string; detail: string }[] = [];
    for (const { rid, i } of joining) {
      const path = `/rids/${i}`;
      const planned = switches.find((s) => s.rid === rid);
      if (planned) {
        if (planned.switchedAt) continue;
        const running =
          planned.applyingAt && Date.now() - planned.applyingAt.getTime() < APPLYING_FOR_MS;
        if (running) continue;
        const open = await openOf(planned);
        out.push({
          path,
          detail: `group ${rid} is answered by a bot outside Forge and joins the channel agent only through its switch: ${open.length ? `${describeOpen(open)}; ` : ''}run it with POST /api/projects/${projectId}/support/channels/${rid}/switch/apply`,
        });
        continue;
      }
      const declared = (await channelOf(projectId, rid))?.agentAddress;
      if (heldOutside.includes(rid) || declared) {
        out.push({
          path,
          detail: `group ${rid} is answered by a bot outside Forge, and no switch is planned for it: plan one with PUT /api/projects/${projectId}/support/channels/${rid}/switch, pass its duties, then run it`,
        });
      }
    }
    return out;
  },
};
