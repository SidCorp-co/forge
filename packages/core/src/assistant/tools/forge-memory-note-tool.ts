/**
 * ISS-1034 — `forge_memory.note`: remember something a person said in the room.
 *
 * The model brings the text; core stamps everything that says where it came
 * from — the project, the room, the person who spoke and the handle that
 * listened — so a note is always attributable and always deletable by its author.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertPrincipalIsMember, type ContextScopedMcpToolFactory } from '../../mcp/tools/lib.js';
import { runMemoryWrite } from '../../memory/write-service.js';
import { NOTE_TEXT_MAX } from './memory-note-gate.js';

export { NOTE_TEXT_MAX };

// cm:guard `text` and an optional `title`, and NOTHING else — no `source`, no `sourceRef`, no `metadata`: `forge_memory.write` takes all three and is not on the chat allowlist because a room that could pick its source could file under `knowledge` or `policy` and wear the trust those rows carry. The schema is `.strict()` so a call carrying one is refused whole (ISS-1034 criteria 24, 27).
const input = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(NOTE_TEXT_MAX)
      .describe("What to remember, in the person's words or yours; one fact or decision per note."),
    title: z.string().trim().min(1).max(200).optional().describe('A short label for the note.'),
  })
  .strict();

const DESCRIPTION = [
  'Remember something from this conversation for the project — a fact, a decision, a preference the',
  'person stated — when they ask you to remember it or it is plainly worth keeping.',
  'Give the text and, if useful, a title; where it came from and who said it is stamped for you.',
  'The person can see and delete their own notes from their account page.',
].join(' ');

export const forgeMemoryNoteTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_memory.note',
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const args = input.parse(raw);
    const turn = ctx.turn;
    const projectId = ctx.boundProjectId;
    if (!projectId || !turn?.conversationId) {
      throw new Error(
        'forge_memory.note stamps the project and the room it was written in, and this turn names no room',
      );
    }
    // cm:guard refused, not attributed to the principal: a note is written ON BEHALF of the person who spoke, and when the newest message is from nobody Forge knows there is nobody to write it for — the principal in a room is the org agent, and a note under its name would be the agent remembering things a stranger said as if they were its own (ISS-1034 criterion 26).
    if (!turn.speakerUserId) {
      throw new Error(
        'forge_memory.note is written on behalf of the linked person who spoke, and the newest message is from nobody Forge knows — nothing may be remembered on their behalf. They can link their account first.',
      );
    }
    await assertPrincipalIsMember(ctx.principal, projectId);
    // cm:guard a FRESH id per note rather than the message id the plan first named: `runMemoryWrite` upserts on (projectId, source, sourceRef), so two notes from one turn under the message's id would leave one — the second silently replacing the first (ISS-1034 criterion 25).
    const sourceRef = `conversation:${turn.conversationId}:${randomUUID()}`;
    const result = await runMemoryWrite({
      projectId,
      source: 'note',
      sourceRef,
      textContent: args.title ? `${args.title}\n\n${args.text}` : args.text,
      metadata: {
        conversationId: turn.conversationId,
        authorUserId: turn.speakerUserId,
        handleUserId: turn.handleUserId,
        ...(args.title ? { title: args.title } : {}),
      },
    });
    return {
      id: result.id,
      sourceRef,
      degraded: result.degraded,
      nearDuplicateOf: result.nearDuplicateOf ?? null,
    };
  },
});
