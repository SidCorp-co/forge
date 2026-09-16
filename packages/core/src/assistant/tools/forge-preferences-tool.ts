/**
 * ISS-1034 — `forge_preferences`: the assistant sets the speaking person's own
 * answer style or standing instructions, when they ask for it in the room.
 *
 * The tool names no user. Who it writes for is the turn's linked speaker,
 * stamped by core, so the model cannot be talked into restyling somebody else.
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
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const patch = input.parse(raw);
    const turn = ctx.turn;
    if (!turn?.speakerUserId) {
      throw new Error(
        'forge_preferences writes the preferences of the linked person who spoke, and the newest message is from nobody Forge knows — nothing may be set on their behalf. They can link their account or set it on their account page.',
      );
    }
    const written = await writeAssistantPreferences({
      userId: turn.speakerUserId,
      patch,
      actor: { kind: 'assistant', userId: turn.handleUserId },
      conversationId: turn.conversationId,
    });
    return {
      answerStyle: written.answerStyle,
      assistantInstructions: written.assistantInstructions,
    };
  },
});
