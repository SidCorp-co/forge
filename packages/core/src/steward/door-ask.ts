// The steward's content question (REQ-48 BC-2, REQ-67 BC-4): one question about what a requirement
// says, with 2-4 options and the one it recommends, written as a question about the requirement
// (`POST /api/questions` with `about`), so it is listed on the requirement, owed by the project's
// master, holds the move into delivery while open, and its answer is recorded there as a decision. It
// asks the questions the gaps need: no count holds it (REQ-67 r2 BC-4).

import { z } from 'zod';
import { doorName } from './door-call.js';
import { cite, type DoorSpec, key, send } from './door-kit.js';

const optionsParam = z
  .array(
    z.strictObject({
      id: z.string().trim().min(1).max(40),
      label: z.string().trim().min(1).max(200),
    }),
  )
  .min(2)
  .max(4);

/**
 * What a content question may be about: a requirement. A stuck item's question, an issue's, a
 * requirement's or a feedback item's, is a decision with Forge's own options: `steward_decide`'s.
 */
const askAbout = key
  .superRefine((value, ctx) => {
    if (/^REQ-\d+$/i.test(value)) return;
    ctx.addIssue({
      code: 'custom',
      message: /^FB-\d+$/i.test(value)
        ? `${value} is a feedback item: its question is a decision with Forge's own options, asked with steward_decide about ${value.toUpperCase()} (keep or decline it while nobody triages it; verify, reopen or keep a shipped fix).`
        : `${value} is no requirement: a question about an issue is a decision with Forge's own options, asked with steward_decide.`,
    });
  })
  .describe('REQ-n: the requirement the question is about');

const askParams = z.strictObject({
  about: askAbout,
  prompt: z.string().trim().min(10).max(2000),
  options: optionsParam,
  recommended: z.string().trim().min(1).max(40).describe('the id of the option you recommend'),
});

export const ASK: DoorSpec<z.infer<typeof askParams>> = {
  name: 'steward_ask',
  describe: `Ask one question about what a requirement says, with 2-4 options and the one you recommend: a question about the requirement, listed on it, owed by the project's master and holding its delivery until answered.`,
  params: askParams,
  write: true,
  async call(args, ctx) {
    const about = args.about.toUpperCase();
    if (!args.options.some((o) => o.id === args.recommended)) {
      return {
        correct: `recommended is ${args.recommended}, which is none of the options (${args.options.map((o) => o.id).join(', ')}): recommend one of them.`,
      };
    }
    const sent = await send(
      {
        method: 'POST',
        path: '/api/questions',
        body: {
          projectId: ctx.projectId,
          about: { requirement: about },
          // owner ruling 2026-10-31 (decision-authority): the project's master answers it; a person
          // is asked only on a strict project for a serious decision, which a check gap is not
          blockerKind: 'master_or_peer',
          prompt: args.prompt,
          options: args.options.map((o) => ({
            id: o.id,
            label: o.label,
            authority: 'writer',
            // a business answer binds no call: it is recorded on the requirement as a decision and
            // the master acts on it (`QUESTION_REFUSED` names a this_call option with no fingerprint)
            bindsTo: 'session',
            executedBy: 'agent',
          })),
          recommendedOptionId: args.recommended,
        },
      },
      ctx,
    );
    const id = sent.answer.json?.id;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Asked on ${about}: ${args.prompt}`,
        wrote: cite('question', id),
        undo:
          typeof id === 'string'
            ? {
                door: `POST /api/questions/${id}/void`,
                body: { reason: "A person undid the steward's question, so it needs no answer." },
              }
            : null,
      },
    };
  },
};
