// A person's release decision, recorded from his own message in a room (ISS-1206). The owner who says
// "approved", "release it" or "ship it", in any language, for a named release in his room has decided
// it: the room cites that message, and core decides the release's pending approval as him, never as
// the room's agent, after checking the message is that member's own in the thread named, and then
// what `release-decide-as.ts` checks: he is a Forge person holding releases.approve on the release's
// project, and the release names one cut version with an approval pending. The decision's reason
// quotes his message with its id and thread, so it is audited back to his words.
// The owner a binding names whose chat account is no Forge account yet (ISS-1313, FB-730) is not
// refused: his go or no is kept as his answers are (`kept-answers.ts`), the room is told it waits on
// his admins' setup step, and it is decided as his once they name his account. The word may be
// cited from the project's technical channel, where the release was put to him (ISS-1347).
// A speaker a project admin declared by chat identity for the release act (REQ-90 BC-15) needs no
// Forge account at all: their go or hold, in that project's own room, decides the release as that
// identity, at once (`release-decide-as.ts:decideAsDeclared`). An unmapped speaker it declares for no
// release, or does not declare, is refused by name, and the agent asks the owner once whether to
// declare them (BC-16): never to link, invite or make an account for them.

import type { SupportReleaseDecisionRequest } from '@forge/contracts/support-channel';
import { isRefusal } from '../lib/refusal.js';
import { listReleases, parseReleaseVersion } from '../release-batch/index.js';
import { memberMessage } from './channel-store.js';
import { actsWords, declarationAsk, declarationsOf } from './deciders.js';
import { grantsOf, isNamedOwner, supportConfigOf } from './grants.js';
import { keepOwnerGo, ownerSetupStep } from './kept-answers.js';
import { forgeUserOrSilence } from './ops-asker.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker } from './ops-writes.js';
import { no } from './outcome.js';
import { decideAs, decideAsDeclared, type Said } from './release-decide-as.js';
import { namingStep } from './setup-step.js';
import { insertAction, type RoomRow } from './store.js';
import { citableRoomOf } from './technical-thread-room.js';

/**
 * Keep the owner's go or no on a release he named, while his chat account is no Forge account: the
 * release is one the project lists, and what the agent may tell the room is that it is noted and
 * waits on his admins' setup step. Nothing is decided yet.
 */
async function keepGo(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  project: { id: string; slug: string },
  said: Said,
): Promise<OpsOutcome<unknown>> {
  const listed = await listReleases(project.id, null);
  if (!listed.releases.some((r) => r.version === input.version)) {
    return no(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
      '/version',
      `${input.version} names no release of ${project.slug}: read its releases and name the one he meant, by its whole version. Nothing was kept`,
    );
  }
  await keepOwnerGo(room, {
    projectId: project.id,
    project: project.slug,
    version: input.version,
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
    thread: input.thread,
    message: input.message,
    ownerKey: said.authorKey,
  });
  const word = input.decision === 'approve' ? 'go' : 'no';
  return {
    ok: true,
    value: {
      kept: true,
      decision: input.decision,
      version: input.version,
      project: project.slug,
      next: await ownerSetupStep(project.id, `his ${word} on ${project.slug} ${input.version}`),
    },
  };
}

/**
 * The member's message a release decision cites, from the rooms the agent may cite (`citableRoomOf`):
 * his own word in the thread named, or in the project's technical channel, where the release was put
 * to him (ISS-1347, FB-794), whichever thread the agent was handed it in.
 */
async function citedWord(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
): Promise<OpsOutcome<Said & { thread: string }>> {
  const where = await citableRoomOf(room, input.message);
  const said = where.ok ? await memberMessage(where.at.id, input.message) : null;
  if (!where.ok || !said || (!where.technical && said.thread !== input.thread)) {
    return no(
      'SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE',
      '/message',
      `${input.message} is ${said ? `a message in thread ${said.thread}, not ${input.thread}` : `no member's message this room or its project's technical channel received${!where.ok && where.elsewhere ? " (it is in the shared operations room, outside this project's own thread there)" : ''}`}: a release decision is the member's own word, so cite his own message in the thread you name (\`message\` in what you were handed). Nothing was decided`,
    );
  }
  return {
    ok: true,
    value: { ...said, ...(where.technical ? { rid: where.at.rid } : {}) },
  };
}

/**
 * The unmapped writer's go, by the project's declaration of their chat identity (REQ-90 BC-15):
 * decided as that identity where a declaration of the release's project covers the release act on
 * it and the word was said in that project's own room; otherwise refused by name, saying which acts
 * it covers or that none is declared, with the one yes or no the agent may ask (BC-16).
 */
async function byDeclaration(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  project: { id: string; slug: string },
  said: Said,
): Promise<OpsOutcome<unknown>> {
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const declared = await declarationsOf(project.id, said.authorKey);
  const covering = declared.find(
    (d) => d.acts.includes('release') && (!d.targets || d.targets.includes(project.slug)),
  );
  if (!covering) {
    if (declared.length > 0) {
      const acts = [...new Set(declared.flatMap((d) => d.acts))];
      return no(
        'SUPPORT_DECIDER_ACT_NOT_DECLARED',
        '/message',
        `${who} is declared on ${project.slug} by chat identity to decide ${actsWords(acts)} [knowledge:${declared[0]?.ruling}], not ${actsWords(['release'])}${declared.some((d) => d.targets) ? ` on ${project.slug}` : ''}: a declaration lends the acts it names and no other. ${await declarationAsk(project.id, who, ['release'])}. Nothing was decided`,
      );
    }
    return no(
      'SUPPORT_DECIDER_NOT_DECLARED',
      '/message',
      `${who} holds no Forge account and is not declared to decide ${project.slug}'s releases, so their word decides none. ${await declarationAsk(project.id, who, ['release'])}. Nothing was decided`,
    );
  }
  // the declaration is the project's own: it lends the act to the speaker's word in that project's
  // room (or its technical channel), never in another project's room that follows it
  if (room.projectId !== project.id) {
    return no(
      'SUPPORT_DECIDER_OUTSIDE_PROJECT_ROOM',
      '/message',
      `${who} is declared to decide ${project.slug}'s releases in ${project.slug}'s own room, and ${input.message} was said in a room of another project: their go there decides nothing. Cite their word in ${project.slug}'s room. Nothing was decided`,
    );
  }
  return decideAsDeclared(room, input, project, said, covering);
}

async function decide(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
): Promise<OpsOutcome<unknown>> {
  const cited = await citedWord(room, input);
  if (!cited.ok) return cited;
  const said = cited.value;
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  if (!parseReleaseVersion(input.version)) {
    return no(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
      '/version',
      `${input.version} names no one release: a release is named by its whole version as its page shows it (MAJOR.MINOR.PATCH, e.g. 0.19.0), so read ${project.value.slug}'s releases and name the one he meant. Nothing was decided`,
    );
  }
  // an account his admins named in this project resolves here too, as his answers do (ISS-1313)
  const { person, silent } = await forgeUserOrSilence(
    room,
    { key: said.authorKey, label: said.author },
    'releases.approve',
    project.value.id,
  );
  if (!person.ok) {
    // the owner the binding names keeps his go until his account is named (ISS-1313); anyone else
    // decides by the project's declaration of their chat identity, or not at all (REQ-90 BC-15)
    if (!isNamedOwner(grantsOf(await supportConfigOf(room)), said.authorKey)) {
      return byDeclaration(room, input, project.value, said);
    }
    // kept only where unmapped: a writer the chat server would not name just now may be one Forge
    // already knows, whose kept go no admin's naming would ever come to decide
    if (silent) {
      return no(
        'OPS_ASKER_UNMAPPED',
        '/message',
        `the chat server would not say who ${said.author ? `@${said.author}` : `account ${said.authorKey}`} is just now, so this word can be neither decided nor kept: cite message ${input.message} again in a moment. Where it never says, the account is named once: ${await namingStep(project.value.id, 'his')}. Nothing was decided`,
      );
    }
    return keepGo(room, input, project.value, said);
  }
  return decideAs(room, input, project.value, person.value, said, (fn) =>
    asAsker(person.value, project.value.id, fn),
  );
}

/**
 * Record a person's release decision from his own message (ISS-1206): decided as him, as a decider
 * declared by chat identity (REQ-90 BC-15), kept as the unlinked owner's (ISS-1313), or refused by
 * name with nothing decided. Either way the act is on the
 * room's record beside his message.
 */
export async function decideReleaseFromMessage(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
): Promise<OpsOutcome<unknown>> {
  let out: OpsOutcome<unknown>;
  try {
    out = await decide(room, input);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    out = { ok: false, refusals: [...err.refusals] };
  }
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: input.thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'session',
    tool: 'release_decision',
    input,
    output: out.ok ? out.value : { refusals: out.refusals },
  });
  return out;
}
