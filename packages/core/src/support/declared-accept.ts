// A requirement revision's acceptance said in a project's room by a speaker other than the owner the
// room's binding names (in an operations room, one Forge cannot name): a project admin declares such
// a speaker by chat identity with the acts they decide (REQ-90 BC-15, ISS-1432), and `accept` among
// them is honoured here (ISS-1436). Where the declaration covers it, the revision is accepted through
// the one acceptance service (`requirements/declared-accept.ts`), recorded under their chat identity
// with their message and thread quoted as its reason, and moved to their user once they link an
// account (`speaker-link.ts:tellLinked`). Otherwise it is refused by name, with the one yes or no the
// agent may ask the owner on declaring them (BC-16): never a link, an invite or an account to make.

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { HTTPException } from 'hono/http-exception';
import { currentPatScope } from '../credentials/pat-scope.js';
import { acceptAsDeclared, type DeclaredAccepter } from '../requirements/index.js';
import { memberMessage } from './channel-store.js';
import { actsWords, declarationAsk, declarationsOf, type RulingDeciderRead } from './deciders.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { forgeUserOrSilence } from './ops-asker.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';
import { senderAccount } from './temporary-account.js';
import { roomAuth } from './thread.js';

/** The message an act cites, as the chat server recorded who wrote it. */
export type SaidBy = NonNullable<Awaited<ReturnType<typeof memberMessage>>>;

/**
 * Whether `said`'s writer accepts by the project's declaration rather than as the owner: anyone but
 * the owner the binding names, or in an operations room, where each writer acts as himself, one Forge
 * cannot name (and not just because the chat server was silent: they may be one it knows).
 */
async function speaksByDeclaration(room: RoomRow, said: SaidBy): Promise<boolean> {
  if (room.kind === 'operations') {
    const { person, silent } = await forgeUserOrSilence(room, {
      key: said.authorKey,
      label: said.author,
    });
    return !person.ok && !silent;
  }
  return said.authorKey !== grantsOf(await supportConfigOf(room)).owner;
}

/** The refusal of a speaker no declaration of `project` lends `accept`, with the one ask (BC-16). */
async function notDeclared(
  who: string,
  project: { id: string; slug: string },
  declared: readonly RulingDeciderRead[],
): Promise<OpsOutcome<never>> {
  const ask = await declarationAsk(project.id, who, ['accept']);
  if (declared.length > 0) {
    const acts = [...new Set(declared.flatMap((d) => d.acts))];
    return no(
      'SUPPORT_DECIDER_ACT_NOT_DECLARED',
      '/message',
      `${who} is declared on ${project.slug} by chat identity to decide ${actsWords(acts)} [knowledge:${declared[0]?.ruling}], not ${actsWords(['accept'])}${declared.some((d) => d.targets) ? ` on ${project.slug}` : ''}: a declaration lends the acts it names and no other. ${ask}. Nothing was accepted`,
    );
  }
  return no(
    'SUPPORT_DECIDER_NOT_DECLARED',
    '/message',
    `${who} is not the owner this room's binding names and is not declared to decide ${actsWords(['accept'])} on ${project.slug}, so their word accepts nothing. ${ask}. Nothing was accepted`,
  );
}

/** Who accepts, as the project knows the chat identity: its account, and its user where linked. */
async function accepterOf(room: RoomRow, said: SaidBy, projectId: string, name: string) {
  const { namespace } = await roomAuth(room);
  const account = await senderAccount(
    { source: 'rocketchat', namespace, externalId: said.authorKey, label: said.author },
    projectId,
  );
  return {
    chatAccountId: account.temporaryAccountId,
    name,
    userId: account.kind === 'forge' ? account.userId : null,
  } satisfies DeclaredAccepter;
}

/**
 * The acceptance a speaker other than the owner states in the room (`input.act` requirement.accept):
 * accepted as their chat identity where the project declares them for `accept` and they said it in
 * that project's own room, else refused by name with nothing accepted. Null where the writer is the
 * owner (or an operations room's named writer), whose act is theirs by the owner's path, or where the
 * message is no member's own in the thread named, which that path refuses by name.
 */
export async function declaredAccept(
  room: RoomRow,
  input: SupportForgeActRequest,
  reasonOf: (said: SaidBy) => string | undefined,
): Promise<OpsOutcome<unknown> | null> {
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread) return null;
  if (!(await speaksByDeclaration(room, said))) return null;
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const { id, slug } = project.value;
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const declared = await declarationsOf(id, said.authorKey);
  const covering = declared.find(
    (d) => d.acts.includes('accept') && (!d.targets || d.targets.includes(slug)),
  );
  if (!covering) return notDeclared(who, project.value, declared);
  // the declaration is the project's own: it lends the act in that project's room, never another's
  if (room.projectId !== id) {
    return no(
      'SUPPORT_DECIDER_OUTSIDE_PROJECT_ROOM',
      '/message',
      `${who} is declared to accept ${slug}'s requirements in ${slug}'s own room, and ${input.message} was said in a room of another project: their word there accepts nothing. Cite their word in ${slug}'s room. Nothing was accepted`,
    );
  }
  const session = currentPatScope();
  if (!session?.userId)
    throw new Error('support: a declared accept ran with no session to make it');
  const declaredBy = `knowledge:${covering.ruling}`;
  const reason = `${reasonOf(said) ?? ''}; accepted as ${who}, whom the project declares by chat identity to decide ${actsWords(['accept'])} [${declaredBy}]`;
  const accepted = await acceptAsDeclared({
    projectId: id,
    ref: input.item,
    actor: { userId: session.userId, agency: 'agent' },
    reason,
    declared: await accepterOf(room, said, id, who),
  }).catch((err: unknown) => {
    if (err instanceof HTTPException && err.status === 404) return null;
    throw err;
  });
  if (!accepted) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ITEM_ACT_UNKNOWN_ITEM',
          path: '/item',
          detail: `${input.item} names no requirement of ${slug}. Nothing was done`,
        },
      ],
    };
  }
  if (!accepted.ok) {
    // the acceptance service's own refusal, passed on by its own code
    return {
      ok: false,
      refusals: accepted.refusals.map((r) => ({
        code: r.code,
        path: '/act',
        detail: `${r.detail} Nothing was done`,
      })),
    };
  }
  const key = accepted.requirement.key;
  return {
    ok: true,
    value: {
      act: input.act,
      key,
      project: slug,
      madeBy: who,
      declaredBy,
      recorded: `accepts the proposed revision ${accepted.revision} on ${key}, recorded as ${who}`,
    },
  };
}
