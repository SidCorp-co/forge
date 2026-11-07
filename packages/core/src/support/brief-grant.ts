// A room's brief and its grants say one thing about who agrees to an act (REQ-90 BC-11, the FB-566
// shape): a persona telling the agent that anyone's request for an act is to be done at once, while
// neither the grant nor a ruling lets any member agree to it, would have the agent ask the asker to
// confirm what they had just asked. Saving such a block is refused by name, naming both sources and
// the act. The rule is written once, as a ruling naming its deciders (member `*` for any member of
// the room), which the brief and the agree door both read (`deciders.ts`).
//
// The persona is read only for the two claims a sentence states plainly: that anyone's request for an
// act is to be acted on without asking, or that only a named member agrees to it. Anything else it
// says is the owner's prose, never interpreted.

import type { SupportProposalKind, SupportRoomConfig } from '@forge/contracts/support';
import { ANY_ROOM_MEMBER, CHANNEL_DECIDER_ACT_LABEL } from '@forge/contracts/support-channel';
import { rulingDecidersOf } from '../knowledge/index.js';

const ACT_WORDS: ReadonlyArray<[SupportProposalKind, RegExp]> = [
  ['filing', /\b(record(s|ed|ing)?|fil(e|es|ed|ing|ings)|log it)\b/i],
  ['deploy', /\bdeploy(s|ed|ing|ments?)?\b/i],
  ['build', /\bbuild(s|ing)?\b/i],
  ['command', /\b(host commands?|run commands?)\b/i],
];
const ANYONE = /\b(anyone|anybody|any member|everyone|every member)\b/i;
const AT_ONCE =
  /\b(at once|right away|immediately|is yours|without (asking|a confirmation|confirmation|approval)|no confirmation|never ask|never end with)\b/i;
const ONLY = /\bonly @?([A-Za-z0-9._-]{1,64})\b[^.;]*\b(agrees?|confirms?|decides?|approves?)\b/i;

type Claim = { act: SupportProposalKind; who: 'anyone' | string; sentence: string };

function claimsOf(persona: string): Claim[] {
  const out: Claim[] = [];
  for (const sentence of persona.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())) {
    const acts = ACT_WORDS.filter(([, re]) => re.test(sentence)).map(([act]) => act);
    if (acts.length === 0) continue;
    const only = ONLY.exec(sentence)?.[1];
    for (const act of acts) {
      if (ANYONE.test(sentence) && AT_ONCE.test(sentence))
        out.push({ act, who: 'anyone', sentence });
      else if (only) out.push({ act, who: only, sentence });
    }
  }
  return out;
}

/**
 * The refusals where `block`'s persona states who agrees to an act differently from its grants and
 * the project's rulings (REQ-90 BC-11); none where they agree or the persona states nothing of it.
 */
export async function briefGrantRefusals(args: {
  projectId: string;
  at: '/support' | '/agent';
  block: SupportRoomConfig;
}): Promise<{ path: string; detail: string }[]> {
  const claims = args.block.persona ? claimsOf(args.block.persona) : [];
  if (claims.length === 0) return [];
  const rulings = await rulingDecidersOf(args.projectId);
  const grants = args.block.grants;
  const confirmers = (grants?.confirmers ?? []).map((c) => c.toLowerCase());
  const out: { path: string; detail: string }[] = [];
  for (const claim of claims) {
    const deciders = rulings.filter((d) => d.acts.includes(claim.act));
    const anyone = deciders.some((d) => d.member === ANY_ROOM_MEMBER);
    const named = deciders
      .filter((d) => d.member !== ANY_ROOM_MEMBER)
      .map((d) => d.member.toLowerCase());
    const confirming = claim.act === 'filing' || claim.act === 'fix' ? [] : confirmers;
    const agrees =
      claim.who === 'anyone'
        ? anyone
        : !anyone && [...named, ...confirming].includes(claim.who.toLowerCase());
    if (agrees) continue;
    const act = CHANNEL_DECIDER_ACT_LABEL[claim.act];
    const said = claim.who === 'anyone' ? 'any member of the room' : `only @${claim.who}`;
    const held = [
      anyone ? 'any member of the room (a ruling naming `*`)' : null,
      ...deciders
        .filter((d) => d.member !== ANY_ROOM_MEMBER)
        .map((d) => `@${d.member} (ruling knowledge:${d.ruling})`),
      ...confirming.map((c) => `@${c} (grants.confirmers)`),
    ].filter((h): h is string => h !== null);
    out.push({
      path: `${args.at}/persona`,
      detail: `the persona says ${said} agrees to ${act} ("${claim.sentence.slice(0, 160)}"), and the grants and the project's rulings say ${held.length > 0 ? held.join(', ') : 'only the asker after a proposal, a named confirmer or the owner'}: one act, two rules. Write who agrees once, as a ruling naming its deciders (PUT /api/projects/${args.projectId}/knowledge/<slug>, metadata.deciders, member "*" for any member, targets for the projects it covers), which the brief and the agree door both read; or reword the persona. Nothing was saved.`,
    });
  }
  return out;
}
