// The steward's content question (REQ-48 BC-2, REQ-67 BC-4): one question about what a requirement
// says, with 2-4 options and the one it recommends, written as a question about the requirement
// (`POST /api/questions` with `about`), so it is listed on the requirement, owed by the project's
// master, holds the move into delivery while open, and its answer is recorded there as a decision. At most
// `STEWARD_OPEN_ASKS_MAX` stand open about one requirement: a fourth is said back to the turn by name.

import { STEWARD_OPEN_ASKS_MAX } from '@forge/contracts/delivery-check';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { heldStewardOf } from './account.js';
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

/** The prompts of the steward's own questions still open about a requirement of the project, oldest first. */
export async function openStewardAsks(projectId: string, requirement: string): Promise<string[]> {
  const steward = await heldStewardOf(projectId);
  if (!steward) return [];
  const rows = rowsOf<{ prompt: string | null }>(
    await db.execute(sql`
      SELECT q.steps -> -1 ->> 'prompt' AS prompt
        FROM agent_questions q
        JOIN requirements r
          ON r.project_id = q.project_id
         AND r.id::text = q.about ->> 'requirementId'
       WHERE q.project_id = ${projectId}
         AND q.status = 'open'
         AND q.asked_by = ${steward}
         AND q.about ->> 'kind' = 'requirement'
         AND 'REQ-' || r.req_seq = ${requirement.toUpperCase()}
       ORDER BY q.created_at, q.id`),
  );
  return rows.map((r) => r.prompt ?? '');
}

export const ASK: DoorSpec<z.infer<typeof askParams>> = {
  name: 'steward_ask',
  describe: `Ask one question about what a requirement says, with 2-4 options and the one you recommend: a question about the requirement, listed on it, owed by the project's master and holding its delivery until answered. At most ${STEWARD_OPEN_ASKS_MAX} of yours stand open about one requirement.`,
  params: askParams,
  write: true,
  async call(args, ctx) {
    const about = args.about.toUpperCase();
    const open = await openStewardAsks(ctx.projectId, about);
    if (open.length >= STEWARD_OPEN_ASKS_MAX) {
      return {
        correct: `STEWARD_ASK_LIMIT: ${open.length} of your questions about ${about} are still open (${open.map((p) => `"${p}"`).join('; ')}), and at most ${STEWARD_OPEN_ASKS_MAX} stand at once. Fold what else you would ask into the note, and ask it once one is answered.`,
      };
    }
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
