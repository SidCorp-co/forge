// A release decided as the person who said it (ISS-1206), once he is a Forge account: from his
// message in the turn that cites it (`release-decision.ts`), or from his kept go, applied once an
// admin names his account (ISS-1313, `kept-answers.ts`). Either way the same checks hold: he holds
// releases.approve on the release's project, the release names one cut version with an approval
// pending, and the reason quotes his message with its id and thread. Where he also holds
// project.admin, the approval stands for the production deploy the release plans.

import type { SupportReleaseDecisionRequest } from '@forge/contracts/support-channel';
import { outsideTokenScope } from '../credentials/pat-scope.js';
import type { RulingDeciderRead } from '../knowledge/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import {
  decideApprovalOfVersion,
  decideApprovalOfVersionBy,
  giveProdGoWithApproval,
  parseDecision,
  runCutAs,
} from '../release-batch/index.js';
import { memberMessage } from './channel-store.js';
import type { Asker } from './ops-asker.js';
import type { OpsOutcome } from './ops-types.js';
import { refusalsOf } from './ops-writes.js';
import { no } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { citableRoomOf } from './technical-thread-room.js';
import { senderAccount } from './temporary-account.js';
import { roomAuth } from './thread.js';

/** How much of his message the decision's reason quotes: the reason is at most 1000 characters. */
const QUOTE_MAX = 400;

/** His message as the room received it. */
export interface Said {
  author: string | null;
  authorKey: string;
  text: string | null;
  /** The room it was written in where that is not the deciding room: its technical channel (ISS-1347). */
  rid?: string;
}

/** Runs a check or a write as him: under the turn's token acting for him, or as his own account. */
export type AsHim = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The owner's go or no on a release, kept while his chat account is no Forge account (ISS-1313):
 * the release, his cited message, and his decision, decided as his once his account is named.
 */
export interface KeptGo {
  projectId: string;
  project: string;
  version: string;
  decision: SupportReleaseDecisionRequest['decision'];
  reason?: string;
  thread: string;
  message: string;
  ownerKey: string;
}

const quoted = (text: string | null): string => {
  const words = (text ?? '').replace(/\s+/g, ' ').trim();
  return words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1)}…` : words;
};

/** The decision's reason: his why where he gave one, then his message, cited by id and thread. */
function reasonOf(room: RoomRow, input: SupportReleaseDecisionRequest, said: Said): string {
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const cite = `${who} decided it in the room, message ${input.message} in thread ${input.thread} of group ${said.rid ?? room.rid}: "${quoted(said.text)}"`;
  return input.reason ? `${input.reason.trim()}. ${cite}` : cite;
}

/**
 * His approval's go to production, standing for the deploy the release plans where he may press its
 * confirm (project.admin, the confirm door's permission), so nobody asks him again; where he may not,
 * what the deploy still waits on. Null where no run was cut (a draft decided, nothing deploys yet).
 */
async function goToProduction(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  projectId: string,
  person: Asker,
  asHim: AsHim,
) {
  const run = await runCutAs(projectId, input.version);
  if (!run) return null;
  const notAdmin = await asHim(() =>
    permissionRefusalFor(
      actorFor(person.userId),
      'project.admin',
      projectResource(projectId),
      'confirming a production deploy',
    ),
  );
  if (notAdmin) {
    return {
      standsFor: null,
      waitsOn:
        "a production deploy that waits on a confirm waits on a project admin's press; his approval does not stand for it",
    };
  }
  return giveProdGoWithApproval({
    runId: run.id,
    userId: person.userId,
    cited: { message: input.message, thread: input.thread, rid: room.rid },
  });
}

/**
 * Decide the release as `person`, who wrote `said`: refused by name where he holds no
 * releases.approve on its project, or the release decides nothing (not cut, none pending).
 */
export async function decideAs(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  project: { id: string; slug: string },
  person: Asker,
  said: Said,
  asHim: AsHim,
): Promise<OpsOutcome<unknown>> {
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const denied = await asHim(() =>
    permissionRefusalFor(
      actorFor(person.userId),
      'releases.approve',
      projectResource(project.id),
      'approving or returning a release',
    ),
  );
  if (denied) {
    return no(
      'SUPPORT_RELEASE_DECISION_NOT_PERMITTED',
      '/message',
      `${who} wrote ${input.message}, and holds no releases.approve on ${project.slug}, so their word decides no release there: a release approver of the project decides it, here in their own words or on its page. Nothing was decided`,
    );
  }
  const decision = parseDecision({ decision: input.decision, reason: reasonOf(room, input, said) });
  const decided = await refusalsOf(() =>
    asHim(async () => ({
      ok: true as const,
      value: await decideApprovalOfVersion({
        projectId: project.id,
        version: input.version,
        userId: person.userId,
        decision,
      }),
    })),
  );
  if (!decided.ok) return decided;
  const deploy =
    input.decision === 'approve'
      ? await goToProduction(room, input, project.id, person, asHim)
      : null;
  return {
    ok: true,
    value: {
      decision: input.decision,
      version: input.version,
      project: project.slug,
      decidedBy: person.label ?? person.key,
      approval: decided.value,
      ...(deploy ? { productionDeploy: deploy } : {}),
    },
  };
}

/**
 * Decide the release as a speaker a project admin declared by chat identity for the release act
 * (REQ-90 BC-15), who holds no Forge account: recorded as that identity (its account, the name the
 * room shows) with their message as the evidence, and the declaration cited, never as the owner or
 * the room's agent. A go approves it with no owner press; a hold (a return) is recorded as theirs.
 * The production deploy a confirm holds still waits on a project admin's press: a declaration lends
 * the release decision, not project.admin.
 */
export async function decideAsDeclared(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  project: { id: string; slug: string },
  said: Said,
  declaration: RulingDeciderRead,
): Promise<OpsOutcome<unknown>> {
  const { namespace } = await roomAuth(room);
  const account = await senderAccount(
    { source: 'rocketchat', namespace, externalId: said.authorKey, label: said.author },
    project.id,
  );
  if (account.kind !== 'temporary') {
    // a Forge account resolved after all: their own grants decide, as any person's word
    return no(
      'SUPPORT_RELEASE_DECISION_NOT_PERMITTED',
      '/message',
      `${said.author ? `@${said.author}` : `account ${said.authorKey}`} is a Forge account now: cite ${input.message} again, and it is decided by their own releases.approve. Nothing was decided`,
    );
  }
  const name = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const decision = parseDecision({
    decision: input.decision,
    reason:
      `${reasonOf(room, input, said)}; decided as ${name}, whom the project declares by chat identity to decide its releases [knowledge:${declaration.ruling}]`.slice(
        0,
        1000,
      ),
  });
  const decided = await refusalsOf(async () => ({
    ok: true as const,
    value: await decideApprovalOfVersionBy({
      projectId: project.id,
      version: input.version,
      by: { kind: 'chat', chatAccountId: account.temporaryAccountId, name },
      decision,
    }),
  }));
  if (!decided.ok) return decided;
  const deploy =
    input.decision === 'approve' && (await runCutAs(project.id, input.version))
      ? {
          standsFor: null,
          waitsOn:
            "a production deploy that waits on a confirm waits on a project admin's press; a declared decider's approval does not stand for it",
        }
      : null;
  return {
    ok: true,
    value: {
      decision: input.decision,
      version: input.version,
      project: project.slug,
      decidedBy: name,
      declaredBy: `knowledge:${declaration.ruling}`,
      approval: decided.value,
      ...(deploy ? { productionDeploy: deploy } : {}),
    },
  };
}

/**
 * Decide the owner's kept go as `userId`, the Forge account his chat account was just named (ISS-1313),
 * as his own account and never under the token of the request that named him: the same checks as his
 * word in a turn, so an account that may not decide the release is refused by name. The act is on the
 * room's record beside his message either way.
 */
export async function decideKeptGo(
  room: RoomRow,
  kept: KeptGo,
  userId: string,
): Promise<{ recorded: true; by: string } | { recorded: false; why: string }> {
  // his go may have been said in the project's technical channel (ISS-1347)
  const where = await citableRoomOf(room, kept.message);
  const found = where.ok ? await memberMessage(where.at.id, kept.message) : null;
  const said = found && where.ok && where.technical ? { ...found, rid: where.at.rid } : found;
  if (!said)
    return { recorded: false, why: `message ${kept.message} is no longer on the room's record` };
  const input: SupportReleaseDecisionRequest = {
    thread: kept.thread,
    message: kept.message,
    project: kept.project,
    version: kept.version,
    decision: kept.decision,
    ...(kept.reason ? { reason: kept.reason } : {}),
  };
  const person: Asker = { key: kept.ownerKey, label: said.author, userId, via: 'link' };
  let out: OpsOutcome<unknown>;
  try {
    out = await outsideTokenScope(() =>
      decideAs(room, input, { id: kept.projectId, slug: kept.project }, person, said, (fn) => fn()),
    );
  } catch (err) {
    // his go is already claimed: a fault says why it was not recorded, as an answer's does, and
    // the other kept rows are still told
    if (!isRefusal(err)) {
      logger.error(
        { err, version: kept.version, message: kept.message },
        'support: a kept owner go failed',
      );
      return { recorded: false, why: err instanceof Error ? err.message : String(err) };
    }
    out = { ok: false, refusals: [...err.refusals] };
  }
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: kept.thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'core',
    tool: 'release_decision',
    input,
    output: out.ok ? out.value : { refusals: out.refusals },
  });
  return out.ok
    ? { recorded: true, by: userId }
    : { recorded: false, why: out.refusals.map((r) => r.detail).join('; ') };
}
