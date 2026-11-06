// What a confirmer's agreement runs (REQ-75 r5 BC-27; ISS-845): a command that changes a host, a
// deploy of a bound target, or a build — committed and pushed by the box, its change request opened
// by core into the development branch. The grant is read again here, as it stands at the agreement: a
// host, a target or the ability itself taken away since the proposal runs nothing. What came of it
// goes back to the session as the act's answer; core posts nothing in the room.

import {
  changeRequestOpen,
  projectOpenedPullRequest,
  resolveSourceHost,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { dispatchCoolifyDeployDirect } from '../release-batch/index.js';
import { pushSupportBuild, runHostCommand } from '../runners/index.js';
import { scrubbedResult } from './ability-acts.js';
import { boxOfRoom } from './box.js';
import { buildBaseOf, buildKeyOf } from './build.js';
import { mayConfirmChange } from './confirm-role.js';
import { deciderFor } from './deciders.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import { threadLink } from './record.js';
import {
  builtChangeRequest,
  insertAction,
  type ProposalRow,
  type RoomRow,
  settleFixResult,
} from './store.js';

/** What a confirmed change came to, as the session is handed it to tell the thread. */
export interface Ran {
  state: 'ran' | 'failed';
  /** What happened, for the session: never posted by core. */
  what: string;
  result: unknown;
}

/** A change that could not run: its proposal settled failed, and the session handed why. */
async function failed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  why: string,
): Promise<Ran> {
  await settleFixResult(fix.id, 'failed', { refused: why });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: fix.thread,
    kind: 'fix_failed',
    actorKind: 'core',
    tool: fix.kind,
    input: fix.args,
    output: { refused: why },
    proposalId: fix.id,
  });
  return {
    state: 'failed',
    what: `The ${fix.kind} did not go ahead: ${why}`,
    result: { refused: why },
  };
}

async function ran(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  result: unknown,
  what: string,
  ok = true,
): Promise<Ran> {
  await settleFixResult(fix.id, ok ? 'ran' : 'failed', result);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: fix.thread,
    kind: ok ? 'fix_ran' : 'fix_failed',
    actorKind: 'core',
    tool: fix.kind,
    input: fix.args,
    output: result,
    proposalId: fix.id,
  });
  return { state: ok ? 'ran' : 'failed', what, result };
}

/** Who confirmed a change: the account the chat server signed, and its username. */
export type Writer = { key: string | null; label: string | null };

/**
 * Run a confirmed build, deploy or host change. The proposal was claimed `ran` before this starts,
 * so a throw on the way is settled `failed` and said in the thread: a confirmed change that broke
 * never reads as done.
 */
export async function runConfirmed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  confirmer: Writer,
): Promise<Ran> {
  try {
    return await runClaimed(room, fix, conversationId, confirmer);
  } catch (err) {
    logger.error({ err, roomId: room.id, code: fix.code }, 'support: a confirmed change threw');
    const why = err instanceof Error ? err.message : String(err);
    return failed(room, fix, conversationId, `it broke while running (${why})`);
  }
}

async function runClaimed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  confirmer: Writer,
): Promise<Ran> {
  const args = (fix.args ?? {}) as Record<string, string>;
  const grants = grantsOf(await supportConfigOf(room));
  const ability =
    fix.kind === 'command' ? 'run_commands' : fix.kind === 'deploy' ? 'deploy' : 'build';
  const reach =
    fix.kind === 'command'
      ? { host: args.host ?? '' }
      : fix.kind === 'deploy'
        ? { target: args.target ?? '' }
        : undefined;
  const still = await abilityRefusal(room, grants, ability, reach);
  if (still && !still.ok) {
    return failed(room, fix, conversationId, still.refusals[0]?.detail ?? 'no longer granted');
  }
  // the member the project's rulings name as the one who decides this act agrees to it (ISS-1042)
  const decides = (await deciderFor(room, fix.kind, confirmer)) !== null;
  if (!decides && !(await mayConfirmChange(room, grants, confirmer))) {
    return failed(
      room,
      fix,
      conversationId,
      `@${confirmer.label ?? 'the confirmer'} may no longer confirm a change in this room`,
    );
  }

  if (fix.kind === 'command') {
    const box = await boxOfRoom(room, 'commands');
    if (!box.ok) return failed(room, fix, conversationId, box.refusals[0]?.detail ?? '');
    const out = await runHostCommand({
      deviceId: box.value,
      projectId: room.projectId,
      host: args.host ?? '',
      command: args.command ?? '',
    });
    if (!out.ok) return failed(room, fix, conversationId, out.why);
    const result = await scrubbedResult(room, out.value);
    return ran(
      room,
      fix,
      conversationId,
      result,
      `The command ran on ${args.host} after it was agreed to. What came back: ${JSON.stringify(result).slice(0, 6000)}`,
      result.exitCode === 0,
    );
  }

  if (fix.kind === 'deploy') {
    const out = await dispatchCoolifyDeployDirect({
      projectId: room.projectId,
      integrationId: args.target ?? '',
    });
    if (out.pendingHumanConfirm) {
      return ran(
        room,
        fix,
        conversationId,
        out,
        `The deploy ${fix.code} of ${args.label} waits for its production approver; nothing is deployed yet.`,
      );
    }
    if (!out.dispatched) {
      return failed(
        room,
        fix,
        conversationId,
        `the deploy of ${args.label} was not dispatched (${out.reason ?? 'no reason given'})`,
      );
    }
    return ran(
      room,
      fix,
      conversationId,
      out,
      `The deploy ${fix.code} of ${args.label} was dispatched after a confirmer confirmed it.`,
    );
  }

  return runBuild(room, fix, args, conversationId, confirmer);
}

/** The change request a build opened, while its projection does not say it was merged or closed. */
async function stillOpen<T extends { number: number; bindingId: string | null }>(
  cr: T | null,
): Promise<T | null> {
  if (!cr?.bindingId) return cr;
  return (await changeRequestOpen(cr.bindingId, cr.number)) === false ? null : cr;
}

async function runBuild(
  room: RoomRow,
  fix: ProposalRow,
  args: Record<string, string>,
  conversationId: string,
  confirmer: Writer,
): Promise<Ran> {
  const base = await buildBaseOf(room.projectId, args.branch ?? '');
  if (!base.ok) return failed(room, fix, conversationId, base.refusals[0]?.detail ?? '');
  const box = await boxOfRoom(room, 'build');
  if (!box.ok) return failed(room, fix, conversationId, box.refusals[0]?.detail ?? '');
  const branch = args.branch ?? '';
  const link = await threadLink(room, fix.thread);
  const body = `${args.summary ?? ''}\n\nAsked in ${link}; confirmed by @${confirmer.label ?? 'a confirmer'}.`;
  const pushed = await pushSupportBuild({
    deviceId: box.value,
    projectId: room.projectId,
    buildKey: buildKeyOf(room),
    base: base.value.base,
    branch,
    title: args.title ?? branch,
    body,
  });
  if (!pushed.ok) return failed(room, fix, conversationId, pushed.why);
  // a second build on a branch still under review adds to the change request it opened; once that
  // one is merged or closed, the push opens a new one
  const open = await stillOpen(await builtChangeRequest(room.id, branch));
  if (open) {
    return ran(
      room,
      fix,
      conversationId,
      { ...pushed.value, changeRequest: open },
      `The build ${fix.code} pushed ${pushed.value.sha} to ${branch}, under the change request already open (${open.url ?? open.number}).`,
    );
  }
  try {
    const host = await resolveSourceHost(room.projectId, 'agent');
    const opened = await host.openChangeRequest({
      head: branch,
      base: base.value.base,
      title: args.title ?? branch,
      body,
    });
    await projectOpenedPullRequest({
      projectId: room.projectId,
      bindingId: host.bindingId,
      host: host.provider,
      repository: host.fullName,
      opened,
      description: body,
    }).catch((err) =>
      logger.error(
        { err, roomId: room.id },
        'support: the opened change request was not projected',
      ),
    );
    const changeRequest = { number: opened.number, url: opened.url, bindingId: host.bindingId };
    return ran(
      room,
      fix,
      conversationId,
      { ...pushed.value, changeRequest },
      `The build ${fix.code} pushed ${pushed.value.sha} to ${branch} and opened change request ${opened.url ?? opened.number} into ${base.value.base}.`,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return failed(
      room,
      fix,
      conversationId,
      `${branch} was pushed (${pushed.value.sha.slice(0, 8)}) and the change request could not be opened: ${why}`,
    );
  }
}
