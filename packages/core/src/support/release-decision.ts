// A person's release decision, recorded from his own message in a room (ISS-1206). The owner who says
// "approved", "release it" or "ship it", in any language, for a named release in his room has decided
// it: the room cites that message, and core decides the release's pending approval as him, never as the room's agent, after
// checking the message is that member's own in the thread named, that he is a Forge person holding
// releases.approve on the release's project, and that the release names one cut version with an
// approval pending (`release-batch/approvals.ts:decideApprovalOfVersion`). The decision's reason
// quotes his message with its id and thread, so it is audited back to his words. Where he also holds
// project.admin, the approval stands for the production deploy the release plans
// (`coolify-prod-gate.ts:giveProdGoWithApproval`): nobody asks him again for the same release.

import type { SupportReleaseDecisionRequest } from '@forge/contracts/support-channel';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import {
  decideApprovalOfVersion,
  giveProdGoWithApproval,
  parseDecision,
  parseReleaseVersion,
  runCutAs,
} from '../release-batch/index.js';
import { memberMessage } from './channel-store.js';
import { type Asker, forgeUserOfWriter } from './ops-asker.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker, refusalsOf } from './ops-writes.js';
import { no } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

/** How much of his message the decision's reason quotes: the reason is at most 1000 characters. */
const QUOTE_MAX = 400;

const quoted = (text: string | null): string => {
  const words = (text ?? '').replace(/\s+/g, ' ').trim();
  return words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1)}…` : words;
};

/** The decision's reason: his why where he gave one, then his message, cited by id and thread. */
function reasonOf(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
  said: { author: string | null; authorKey: string; text: string | null },
): string {
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const cite = `${who} decided it in the room, message ${input.message} in thread ${input.thread} of group ${room.rid}: "${quoted(said.text)}"`;
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
) {
  const run = await runCutAs(projectId, input.version);
  if (!run) return null;
  const notAdmin = await asAsker(person, projectId, () =>
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

async function decide(
  room: RoomRow,
  input: SupportReleaseDecisionRequest,
): Promise<OpsOutcome<unknown>> {
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread) {
    return no(
      'SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE',
      '/message',
      `${input.message} is ${said ? `a message in thread ${said.thread}, not ${input.thread}` : "no member's message this room received"}: a release decision is the member's own word, so cite his own message in the thread you name (\`message\` in what you were handed). Nothing was decided`,
    );
  }
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const person = await forgeUserOfWriter(
    room,
    { key: said.authorKey, label: said.author },
    'releases.approve',
  );
  if (!person.ok) return person;
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const denied = await asAsker(person.value, project.value.id, () =>
    permissionRefusalFor(
      actorFor(person.value.userId),
      'releases.approve',
      projectResource(project.value.id),
      'approving or returning a release',
    ),
  );
  if (denied) {
    return no(
      'SUPPORT_RELEASE_DECISION_NOT_PERMITTED',
      '/message',
      `${who} wrote ${input.message}, and holds no releases.approve on ${project.value.slug}, so their word decides no release there: a release approver of the project decides it, here in their own words or on its page. Nothing was decided`,
    );
  }
  if (!parseReleaseVersion(input.version)) {
    return no(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
      '/version',
      `${input.version} names no one release: a release is named by its whole version as its page shows it (MAJOR.MINOR.PATCH, e.g. 0.19.0), so read ${project.value.slug}'s releases and name the one he meant. Nothing was decided`,
    );
  }
  const decision = parseDecision({
    decision: input.decision,
    reason: reasonOf(room, input, said),
  });
  const decided = await refusalsOf(() =>
    asAsker(person.value, project.value.id, async () => ({
      ok: true as const,
      value: await decideApprovalOfVersion({
        projectId: project.value.id,
        version: input.version,
        userId: person.value.userId,
        decision,
      }),
    })),
  );
  if (!decided.ok) return decided;
  const deploy =
    input.decision === 'approve'
      ? await goToProduction(room, input, project.value.id, person.value)
      : null;
  return {
    ok: true,
    value: {
      decision: input.decision,
      version: input.version,
      project: project.value.slug,
      decidedBy: person.value.label ?? person.value.key,
      approval: decided.value,
      ...(deploy ? { productionDeploy: deploy } : {}),
    },
  };
}

/**
 * Record a person's release decision from his own message (ISS-1206): decided as him, or refused by
 * name with nothing decided. Either way the act is on the room's record beside his message.
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
