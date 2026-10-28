// What a confirmer's `confirm <code>` runs (REQ-75 r5 BC-27): a command that changes a host, a
// deploy of a bound target, or a build — committed and pushed by the box, its change request opened
// by core into the development branch. The grant is read again here, as it stands at the confirm: a
// host, a target or the ability itself taken away since the proposal runs nothing.

import {
  changeRequestOpen,
  projectOpenedPullRequest,
  resolveSourceHost,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { dispatchCoolifyDeployDirect } from '../release-batch/index.js';
import { pushSupportBuild, runHostCommand } from '../runners/index.js';
import { commandLine, scrubbedResult } from './ability-acts.js';
import { boxOfRoom } from './box.js';
import { buildBaseOf } from './build.js';
import { abilityRefusal, grantsOf, isConfirmer, supportConfigOf } from './grants.js';
import { threadLink } from './record.js';
import {
  builtChangeRequest,
  insertAction,
  type ProposalRow,
  type RoomRow,
  settleFixResult,
} from './store.js';
import { postInThread } from './thread.js';

type Tell = (note: string) => Promise<void>;
type Ran = 'ran' | 'failed';

/** A change that could not run: its proposal settled failed, the thread and the session told why. */
async function failed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  tell: Tell,
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
  await postInThread({ room, thread: fix.thread, text: `It did not go ahead: ${why}` });
  await tell(`${fix.kind} ${fix.code} was confirmed and did not go ahead: ${why}`);
  return 'failed';
}

async function ran(
  room: RoomRow,
  fix: ProposalRow,
  result: unknown,
  line: string,
  tell: Tell,
  note: string,
  ok = true,
): Promise<Ran> {
  await settleFixResult(fix.id, ok ? 'ran' : 'failed', result);
  const posted = await postInThread({ room, thread: fix.thread, text: line });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: fix.thread,
    kind: ok ? 'fix_ran' : 'fix_failed',
    actorKind: 'core',
    tool: fix.kind,
    input: fix.args,
    output: result,
    externalId: posted.messageId,
    proposalId: fix.id,
  });
  await tell(note);
  return ok ? 'ran' : 'failed';
}

/**
 * Run a confirmed build, deploy or host change. The proposal was claimed `ran` before this starts,
 * so a throw on the way is settled `failed` and said in the thread: a confirmed change that broke
 * never reads as done.
 */
export async function runConfirmed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  tell: Tell,
  confirmer: string | null,
): Promise<Ran> {
  try {
    return await runClaimed(room, fix, conversationId, tell, confirmer);
  } catch (err) {
    logger.error({ err, roomId: room.id, code: fix.code }, 'support: a confirmed change threw');
    const why = err instanceof Error ? err.message : String(err);
    return failed(room, fix, conversationId, tell, `it broke while running (${why})`);
  }
}

async function runClaimed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  tell: Tell,
  confirmer: string | null,
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
    return failed(
      room,
      fix,
      conversationId,
      tell,
      still.refusals[0]?.detail ?? 'no longer granted',
    );
  }
  if (!isConfirmer(grants, confirmer)) {
    return failed(
      room,
      fix,
      conversationId,
      tell,
      `@${confirmer ?? 'the confirmer'} is no longer a confirmer this room names`,
    );
  }

  if (fix.kind === 'command') {
    const box = await boxOfRoom(room, 'commands');
    if (!box.ok) return failed(room, fix, conversationId, tell, box.refusals[0]?.detail ?? '');
    const out = await runHostCommand({
      deviceId: box.value,
      projectId: room.projectId,
      host: args.host ?? '',
      command: args.command ?? '',
    });
    if (!out.ok) return failed(room, fix, conversationId, tell, out.why);
    const result = await scrubbedResult(room, out.value);
    return ran(
      room,
      fix,
      result,
      commandLine(args.host ?? '', args.command ?? '', result),
      tell,
      `The command ${fix.code} ran after a confirmer confirmed it. What came back: ${JSON.stringify(result).slice(0, 6000)}`,
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
        out,
        `${args.label} reaches production, so the deploy now waits for its approver in Forge. Nothing has changed yet.`,
        tell,
        `The deploy ${fix.code} of ${args.label} waits for its production approver; nothing is deployed yet.`,
      );
    }
    if (!out.dispatched) {
      return failed(
        room,
        fix,
        conversationId,
        tell,
        `the deploy of ${args.label} was not dispatched (${out.reason ?? 'no reason given'})`,
      );
    }
    return ran(
      room,
      fix,
      out,
      `Deploying ${args.label} now.`,
      tell,
      `The deploy ${fix.code} of ${args.label} was dispatched after a confirmer confirmed it.`,
    );
  }

  return runBuild(room, fix, args, conversationId, tell, confirmer);
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
  tell: Tell,
  confirmer: string | null,
): Promise<Ran> {
  const base = await buildBaseOf(room.projectId, args.branch ?? '');
  if (!base.ok) return failed(room, fix, conversationId, tell, base.refusals[0]?.detail ?? '');
  const box = await boxOfRoom(room, 'build');
  if (!box.ok) return failed(room, fix, conversationId, tell, box.refusals[0]?.detail ?? '');
  const branch = args.branch ?? '';
  const link = await threadLink(room, fix.thread);
  const body = `${args.summary ?? ''}\n\nAsked in ${link}; confirmed by @${confirmer ?? 'a confirmer'}.`;
  const pushed = await pushSupportBuild({
    deviceId: box.value,
    projectId: room.projectId,
    buildKey: room.id,
    base: base.value.base,
    branch,
    title: args.title ?? branch,
    body,
  });
  if (!pushed.ok) return failed(room, fix, conversationId, tell, pushed.why);
  // a second build on a branch still under review adds to the change request it opened; once that
  // one is merged or closed, the push opens a new one
  const open = await stillOpen(await builtChangeRequest(room.id, branch));
  if (open) {
    return ran(
      room,
      fix,
      { ...pushed.value, changeRequest: open },
      `Pushed ${pushed.value.sha.slice(0, 8)} to ${branch}; it updates the open change request ${open.url ?? `#${open.number}`}.`,
      tell,
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
      { ...pushed.value, changeRequest },
      `Pushed ${branch} (${pushed.value.files.length} files) and opened a change request into ${base.value.base}: ${opened.url ?? `#${opened.number}`}. It merges through review, never from here.`,
      tell,
      `The build ${fix.code} pushed ${pushed.value.sha} to ${branch} and opened change request ${opened.url ?? opened.number} into ${base.value.base}.`,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return failed(
      room,
      fix,
      conversationId,
      tell,
      `${branch} was pushed (${pushed.value.sha.slice(0, 8)}) and the change request could not be opened: ${why}`,
    );
  }
}
