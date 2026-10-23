// The steward's run stops guessing about a lesson and reports it (REQ-50 BC-4, BC-5): two lessons in
// its prompt conflict, one contradicts the requirement or design it reads, it cannot tell how one
// applies, or it finds one wrongly applied to an output. The confusion holds the lesson until the
// steward's lessons pass settles it (`lessons-review.ts`), and that settlement is the override: a
// reported confusion has no inverse door, and no person is asked to decide it.

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
    'Report a confusion about a lesson in your prompt instead of guessing: kind conflict (other.lesson), contradicts (other.ref, a REQ key or a design), unclear, or wrongly_applied (other.ref, the output it was applied to); each side in one sentence, and the resolution you recommend (keep, edit with the new sentence, or retire). The lesson is held until the lessons pass settles it.',
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
        did: `Reported a ${body.kind} confusion about L-${lesson}, which is held until the lessons pass settles it`,
        wrote: null,
        undo: null,
      },
    };
  },
};
