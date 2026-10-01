/**
 * ISS-1034 — `forge_preferences`: the assistant sets the speaking person's own
 * answer style or standing instructions, when they ask for it in the room.
 *
 * The tool names no user. Who it writes for is the turn's linked speaker,
 * stamped by core, so the model cannot be talked into restyling somebody else.
 * The change is credited to that person — the turn runs as them (ISS-17) — and
 * `changedBy: 'assistant'` says it was made through a room.
 */
import { z } from 'zod';
import { writeAssistantPreferences } from '../../auth/preference-changes.js';
import { answerStyles } from '../../db/schema.js';
import type { ContextScopedMcpToolFactory } from '../../mcp/tools/lib.js';

export const ASSISTANT_INSTRUCTIONS_MAX = 2000;

const input = z
  .object({
    answerStyle: z
      .enum(answerStyles)
      .optional()
      .describe(
        'How long or short their replies should be: default, concise, detailed or bullets.',
      ),
    assistantInstructions: z
      .string()
      .trim()
      .max(ASSISTANT_INSTRUCTIONS_MAX)
      .nullable()
      .optional()
      .describe('Standing instructions for every reply to this person; null clears them.'),
  })
  .strict()
  .refine((v) => v.answerStyle !== undefined || v.assistantInstructions !== undefined, {
    message: 'name at least one of answerStyle, assistantInstructions',
  });

const DESCRIPTION = [
  'Set how the person you are answering wants to be answered, when THEY ask for it:',
  'their reply style (concise, detailed, bullets, default) or standing instructions every reply follows.',
  'It always writes for the person whose message you are answering — there is no way to name anyone else.',
  'Tell them what you set; they can undo it from their account page.',
].join(' ');

export const forgePreferencesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_preferences',
  grant: 'account:write',
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const patch = input.parse(raw);
    const turn = ctx.turn;
    if (!turn?.speakerUserId || turn.speakerUserId !== ctx.principal.userId) {
      throw new Error(
        'forge_preferences writes the preferences of the linked person who spoke, and this turn does not run as them — nothing may be set on their behalf. They can link their account or set it on their account page.',
      );
    }
    const written = await writeAssistantPreferences({
      userId: ctx.principal.userId,
      patch,
      actor: { kind: 'assistant', userId: ctx.principal.userId },
      conversationId: turn.conversationId,
    });
    return {
      answerStyle: written.answerStyle,
      assistantInstructions: written.assistantInstructions,
    };
  },
});
