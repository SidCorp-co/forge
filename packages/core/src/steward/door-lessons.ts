// The steward stops guessing about a lesson and asks (REQ-50 BC-5): two lessons in its prompt
// conflict, one contradicts the requirement or design it reads, or it cannot tell how one applies.
// The confusion holds the lesson until a person decides it, and that decision is the override: a
// raised confusion has no inverse the steward may run, since deciding it is a person's act.

import { raiseConfusionRequestSchema } from '@forge/contracts/lessons';
import { z } from 'zod';
import { doorName } from './door-call.js';
import { type DoorSpec, send } from './door-kit.js';

const confusionParams = raiseConfusionRequestSchema.extend({
  lesson: z.number().int().min(1),
});

export const LESSON_CONFUSION: DoorSpec<z.infer<typeof confusionParams>> = {
  name: 'steward_raise_lesson_confusion',
  describe:
    'Raise a confusion about a lesson in your prompt instead of guessing: kind conflict (other.lesson), contradicts (other.ref, a REQ key or a design) or unclear; each side in one sentence, and the resolution you recommend (keep, edit with the new sentence, or retire). The lesson is held until a person decides.',
  params: confusionParams,
  write: true,
  async call({ lesson, ...body }, ctx) {
    const sent = await send(
      {
        method: 'POST',
        path: `/api/projects/${ctx.projectId}/lessons/${lesson}/confusions`,
        body,
      },
      ctx,
    );
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Raised a ${body.kind} confusion about L-${lesson}, which is held until a person decides`,
        wrote: null,
        undo: null,
      },
    };
  },
};
