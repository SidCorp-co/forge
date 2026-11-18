// The attach door (ISS-1322): an agent on a box's own device takes the mode's native endpoint and
// drives the box with a tool it already uses (Playwright `connectOverCDP`, chrome-devtools-mcp
// `--browserUrl`), on the same browser the person watches. The device serves it through its CDP
// proxy, which refuses an attached session's writes while a person holds the box and reports each
// write; core writes those into the act feed `via: cdp`, beside the act door's acts and the person's
// input, so one feed says what reached the box. The act door stays the default.

import type { BoxReport } from '@forge/contracts/box-wire';
import { BOX_RUNNING_STATES, type BoxAttachAnswer } from '@forge/contracts/boxes';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, boxActs, boxes } from '../db/schema-boxes.js';
import { type BoxActor, refuse, tellChanged } from './access.js';
import { lockedRow } from './acts.js';
import { boxRecord } from './read.js';
import { attachFault } from './rules.js';
import { ownedRow } from './service.js';

/** One feed line an attached session owes: `attach` itself, or a CDP method it called. */
interface CdpLine {
  kind: 'read' | 'write';
  command: string[];
  refused: boolean;
}

/** Write `lines` into the box's feed `via: cdp`, in order, as `actor`; the room learns of them. */
async function feedLines(
  boxId: string,
  lines: CdpLine[],
  actor: (row: BoxRow) => { key: string; userId: string | null },
): Promise<BoxRow> {
  return db.transaction(async (tx) => {
    const row = await lockedRow(tx, boxId);
    if (!(BOX_RUNNING_STATES as readonly string[]).includes(row.state)) {
      throw refuse(
        'BOX_CLOSED',
        `the box is ${row.state}: what attached sessions do is not recorded on it`,
      );
    }
    const who = actor(row);
    const now = new Date();
    const seq = row.actSeq + lines.length;
    await tx.update(boxes).set({ actSeq: seq }).where(eq(boxes.id, row.id));
    await tx.insert(boxActs).values(
      lines.map((l, i) => ({
        boxId: row.id,
        seq: row.actSeq + i + 1,
        by: 'agent' as const,
        actor: who.key,
        actorUserId: who.userId,
        kind: l.kind,
        via: 'cdp' as const,
        command: l.command,
        state: l.refused ? ('refused' as const) : ('done' as const),
        refusal: l.refused ? 'BOX_HELD_BY_PERSON' : null,
        doneAt: now,
      })),
    );
    await tellChanged(tx, { ...row, actSeq: seq });
    return { ...row, actSeq: seq };
  });
}

/**
 * The box's native endpoint for an agent calling from `callerDevice` (the device its credential is
 * bound to), recorded in the feed as an `attach` line so the person sees a tool attached. Refused
 * `BOX_ATTACH_REMOTE` from anywhere else and `BOX_ATTACH_UNAVAILABLE` where the mode's endpoint
 * cannot be taken back on a take (`attachFault`).
 */
export async function attachBox(
  actor: BoxActor,
  callerDevice: string | null,
  boxId: string,
  runId?: string,
): Promise<BoxAttachAnswer> {
  const row = await ownedRow(boxId, actor, 'attach to a box');
  const fault = attachFault(row, callerDevice);
  if (fault) throw refuse(fault.code, fault.detail);
  const cdp = row.attach?.cdp;
  if (!cdp) throw new Error('boxes: attachFault passed a box with no endpoint');
  const after = await feedLines(
    boxId,
    [{ kind: 'read', command: ['attach'], refused: false }],
    (r) => ({
      key: `agent:${runId ?? r.runId ?? 'unnamed'}`,
      userId: actor.userId,
    }),
  );
  return { box: await boxRecord(after), attach: { mode: 'browser', cdp } };
}

/** What attached sessions did, as the device reported it: each method a line `via: cdp`. */
export async function recordCdpActs(
  row: BoxRow,
  report: Extract<BoxReport, { kind: 'cdp' }>,
): Promise<void> {
  const lines = report.acts.map((a) => ({
    kind: 'write' as const,
    command: a.count > 1 ? [a.method, `×${a.count}`] : [a.method],
    refused: a.refused,
  }));
  await feedLines(row.id, lines, (r) => ({ key: `agent:${r.runId ?? 'unnamed'}`, userId: null }));
}
