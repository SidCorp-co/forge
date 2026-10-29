// A group's switch as it is held and read (REQ-77 BC-16..BC-19): its row, what still stands before
// it, and the view every switch route answers with. `switches.ts` writes it; `switch-outside.ts`
// records the stop of an outside bot on the binding's own account (ISS-775).

import type { ChannelSwitchOpen, ChannelSwitchView } from '@forge/contracts/support-channel';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportChannelSwitches } from '../db/schema-support.js';
import { no, type Outcome } from './outcome.js';

export type SwitchRow = typeof supportChannelSwitches.$inferSelect;

export interface DutyRecord {
  key: string;
  text: string;
  passedBy: string | null;
  passedAt: string | null;
  evidence: string | null;
}

export const dutiesOf = (row: SwitchRow): DutyRecord[] => (row.duties ?? []) as DutyRecord[];

export async function switchOf(projectId: string, rid: string): Promise<SwitchRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelSwitches)
    .where(
      and(eq(supportChannelSwitches.projectId, projectId), eq(supportChannelSwitches.rid, rid)),
    )
    .limit(1);
  return row ?? null;
}

export async function switchById(id: string): Promise<SwitchRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelSwitches)
    .where(eq(supportChannelSwitches.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * What still stands before the switch: an unpassed duty, the earlier switch unproven, the owner's
 * word, and for an outside bot on the binding's own account, the record that its process is stopped.
 */
export async function openOf(row: SwitchRow): Promise<ChannelSwitchOpen[]> {
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
  if (row.outsideIsSelf && !row.outsideStoppedAt) open.push({ kind: 'outside_running' });
  return open;
}

export const describeOpen = (open: ChannelSwitchOpen[]): string =>
  open
    .map((o) =>
      o.kind === 'duty'
        ? `duty ${o.key} is not passed`
        : o.kind === 'after'
          ? `the switch of group ${o.rid} it waits on is not proven yet`
          : o.kind === 'owner_word'
            ? "the owner's word is not given"
            : "the outside bot answers as the binding's own chat account, and its process is not recorded stopped",
    )
    .join('; ');

export async function viewOf(row: SwitchRow): Promise<ChannelSwitchView> {
  return {
    id: row.id,
    projectId: row.projectId,
    rid: row.rid,
    outsideBot: { userId: row.outsideBotUserId, username: row.outsideBotUsername },
    outsideIsSelf: row.outsideIsSelf,
    outsideStopped:
      row.outsideStoppedNote && row.outsideStoppedBy && row.outsideStoppedAt
        ? {
            note: row.outsideStoppedNote,
            by: row.outsideStoppedBy,
            at: row.outsideStoppedAt.toISOString(),
          }
        : null,
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

export const unknownSwitch = <T>(rid: string): Outcome<T> =>
  no('AGENT_SWITCH_UNKNOWN', '/rid', `no switch is planned for group ${rid} in this project`);

export const done = <T>(row: SwitchRow): Outcome<T> =>
  no(
    'AGENT_SWITCH_DONE',
    '/rid',
    `group ${row.rid} switched to the channel agent at ${row.switchedAt?.toISOString()}; its plan and duties no longer change`,
  );
