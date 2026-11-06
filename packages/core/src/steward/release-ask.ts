// The steward's ask about the act a release holds (ISS-1040). An issue owing nothing of its own (every
// criterion earned, on a project with production) waits on the release that carries it, and that
// release's own standing holds the act that ships it (a cut, an approval, a promotion) once for
// every issue it carries. So an ask about such an issue is raised on the release, once while the
// release's wait reads the same, of whoever takes its act: the master where its standing names the
// master (the cut included, which the master takes outside strict), else
// the holders of the permission the act asks, by name (FB-196's rule, `ask-addressee.ts:addresseeOfAct`),
// else nobody, said by name. A release run or gate check that is Forge's own is asked of nobody.
// adminhub-api, 2026-11-06: the steward asked the master per issue (ISS-41, ISS-65, ISS-66) to cut
// or approve 0.14.0, a master holding no releases.approve, while 0.14.0's own gate already named the
// promotion it waited on.

import type { WaitingOn } from '@forge/contracts/standing';
import type { StewardCite } from '@forge/contracts/steward';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { stewardActs } from '../db/schema-steward-runs.js';
import { emitNotification } from '../notifications/index.js';
import { heldStewardOf } from './account.js';
import {
  type ActAddressee,
  APPROVE_RELEASE,
  addresseeOfAct,
  type HeldAct,
  unreadLine,
} from './ask-addressee.js';
import { lockAsksOn, WAKE_DOOR } from './asks.js';
import type { DoorAnswer, DoorRequest } from './door-call.js';
import type { ActOf, DoorContext } from './door-kit.js';
import { type HoldingRelease, stewardPorts } from './ports.js';

/** Approving a release: what its page's approval waits name (`release-view.ts:approvalTurn`, `landedTurn`). */
const RELEASE_APPROVAL: HeldAct = {
  permission: APPROVE_RELEASE,
  what: 'release approval',
  door: 'NOTIFY release holders',
};

/** Cutting a release, where its page names its admins (the master does not take it): theirs. */
const RELEASE_CUT: HeldAct = {
  permission: 'project.admin',
  what: 'release cut',
  door: 'NOTIFY release cutters',
};

/** A gate act its page names an admin for (a target to declare, a runner to label): its admins'. */
const RELEASE_SETUP: HeldAct = {
  permission: 'project.admin',
  what: 'release setup',
  door: 'NOTIFY project admins',
};

const APPROVE_KEYS: ReadonlySet<string> = new Set([
  'standing.act.approve',
  'standing.act.approveOrReturn',
  'standing.act.reviewAndPromote',
]);

/** The act a release's wait names, read through `nobody holds it` and `and N more`. */
function actKey(act: WaitingOn['says']['act']): string {
  const inner = act.vars?.act;
  const wraps = act.key === 'standing.act.noHolder' || act.key === 'standing.act.andMore';
  return wraps && inner && typeof inner === 'object' && 'key' in inner
    ? actKey(inner as WaitingOn['says']['act'])
    : act.key;
}

/** Whom a release's act goes to: an act addressee, or Forge's own release run or gate check. */
export type ReleaseTaker = ActAddressee | { to: 'system' };

/**
 * Who takes the act a release's own wait names: the master where its page names the master, the cut
 * it takes outside strict included; Forge's release run or gate check where it is theirs; otherwise
 * the holders of the permission it asks, the master where it holds that, by name, or nobody.
 */
export async function releaseTakerOf(
  projectId: string,
  wait: Pick<WaitingOn, 'kind' | 'says'>,
  stewardId: string | null,
): Promise<ReleaseTaker> {
  if (wait.kind === 'system' || wait.says.who.key === 'standing.who.releaseRun') {
    return { to: 'system' };
  }
  // the page names the master for the cut it takes (`release-view.ts:draftTurn`, ISS-1043)
  if (wait.kind === 'agent') return { to: 'master' };
  const key = actKey(wait.says.act);
  const act = APPROVE_KEYS.has(key)
    ? RELEASE_APPROVAL
    : key === 'standing.act.cut'
      ? RELEASE_CUT
      : RELEASE_SETUP;
  return addresseeOfAct(projectId, act, stewardId);
}

/** When the release's act was last asked on its wait as it reads now, or null where it was not. */
async function askedOnRelease(
  tx: Tx,
  projectId: string,
  version: string,
  line: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: stewardActs.at })
    .from(stewardActs)
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        isNull(stewardActs.undoneAt),
        sql`${stewardActs.wrote} ->> 'kind' = 'release'`,
        sql`${stewardActs.wrote} ->> 'ref' = ${version}`,
        sql`position(${line} in ${stewardActs.did}) > 0`,
      ),
    )
    .orderBy(desc(stewardActs.at))
    .limit(1);
  return row?.at ?? null;
}

const answered = (json: Record<string, unknown>): DoorAnswer => ({
  status: 200,
  ok: true,
  json,
  text: JSON.stringify(json),
});

type ReleaseAskAnswer =
  | { correct: string }
  | { request: DoorRequest; answer: DoorAnswer; act: ActOf };

/**
 * The ask about `about`, an issue the release carries, raised on the release instead: once while its
 * wait reads the same, under the release's own ask lock, so three issues' runs ask once between them.
 */
export async function askOnRelease(
  ask: string,
  ctx: Pick<DoorContext, 'projectId'>,
  about: string,
  release: HoldingRelease,
  tx: Tx,
): Promise<ReleaseAskAnswer> {
  await lockAsksOn(tx, ctx.projectId, `release ${release.version}`);
  const { line } = release;
  const ships = `${about} ships with ${line}, since ${release.since}: that release's own standing holds the act that ships it, once for every issue it carries, so nothing is asked on ${about}`;
  const before = await askedOnRelease(tx, ctx.projectId, release.version, line);
  if (before) {
    return {
      correct: `${ships}, and the release's act was raised on it on this wait (${before.toISOString()}). Ask nothing more; write the note naming the release.`,
    };
  }
  const to = await releaseTakerOf(
    ctx.projectId,
    release.waitingOn,
    await heldStewardOf(ctx.projectId),
  );
  if (to.to === 'system') {
    return {
      correct: `${ships}, and Forge's own release run or gate check takes that act. Ask nothing; write the note naming the release.`,
    };
  }
  if (to.to === 'nobody') {
    return { correct: `${ships}, and ${to.why}. Ask nothing; write the note saying so.` };
  }
  const cite: StewardCite = { kind: 'release', ref: release.version };
  const said = `Release ${release.version}: ${line}, for every issue it carries (${about} among them). ${ask}`;
  if (to.to === 'holders') {
    const names = to.holders.map((h) => h.name).join(', ');
    const notice = await emitNotification({
      recipients: to.holders.map((h) => h.id),
      projectId: ctx.projectId,
      type: 'steward_ask',
      title: `Release ${release.version}: ${to.act.what} asked`,
      body: said,
      issueId: null,
      dedupeKey: `steward-ask:release:${ctx.projectId}:${release.version}:${line}`,
    });
    return {
      request: { method: 'POST', path: '/notify/steward_ask' },
      answer: answered({
        askedOf: to.act.permission,
        holders: names,
        release: release.version,
        ...notice,
      }),
      act: {
        door: to.act.door,
        did: `Asked the ${to.act.permission} holders (${names}) about ${line}, carrying ${about}: ${ask}${to.unread.length > 0 ? ` (${unreadLine(to.unread)})` : ''}`,
        wrote: cite,
        undo: null,
      },
    };
  }
  const woke = await stewardPorts().wakeMasters({
    projectId: ctx.projectId,
    subjectKey: `release ${release.version}`,
    ask: said,
  });
  return {
    request: { method: 'POST', path: '/ws/master.wake/steward' },
    answer: answered({ askedOf: 'master', release: release.version, ...woke }),
    act: {
      door: WAKE_DOOR,
      did: `Asked the master about ${line}, carrying ${about}: ${ask}`,
      wrote: cite,
      undo: null,
      // keyed on the issue it carries, so a decision recorded there answers it on the master's nudge
      masterAsk: `${about}: ${said}`,
    },
  };
}
