// `awaitsDesign` on a move into `needs_info`: one design revision a park waits on, or a list of them
// (ISS-569). A union of the two shapes answers a list it refuses with zod's bare "Invalid input"
// whenever the list's own fault aborts its branch, so a refusal is said from the shape that was sent.

import { z } from 'zod';
import { refuseNestedField } from '../middleware/zod-validator.js';

/** The most design revisions one park waits on. */
export const AWAITS_DESIGN_MAX = 20;

const AWAITS_DESIGN_SHAPE = `one { workflowId, revision }, or a list of 1 to ${AWAITS_DESIGN_MAX} of them naming each revision once`;

const awaitedDesignSchema = z
  .object({ workflowId: z.uuid(), revision: z.number().int().min(1) })
  .strict();

const countOf = (input: unknown) => (Array.isArray(input) ? input.length : 0);

/** One design revision a park waits on, or several — the park returns once every one is decided. */
export const awaitsDesignSchema = z
  .union([
    awaitedDesignSchema,
    z
      .array(awaitedDesignSchema)
      .min(1, { error: 'names no design; a park waits on at least one' })
      .max(AWAITS_DESIGN_MAX, {
        error: (iss) =>
          `names ${countOf(iss.input)} designs; a park waits on at most ${AWAITS_DESIGN_MAX}`,
      }),
  ])
  .superRefine((value, ctx) => {
    if (!Array.isArray(value)) return;
    const seen = new Set<string>();
    value.forEach((d, i) => {
      const key = `${d.workflowId}:${d.revision}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `workflow ${d.workflowId} revision ${d.revision} is named twice; name each revision the park waits on once`,
        });
      }
      seen.add(key);
    });
  });

type Issue = z.core.$ZodIssue;

// the branch of the union whose type the input had: an object sent is judged as one design, a
// list as a list; an input of neither type names both shapes
function sentShapeIssues(issue: Issue): Issue[] {
  if (issue.code !== 'invalid_union') return [issue];
  const matched = issue.errors.filter(
    (branch) => !branch.some((i) => i.code === 'invalid_type' && i.path.length === 0),
  );
  const [only] = matched;
  if (matched.length !== 1 || !only) {
    return [{ ...issue, message: 'is neither one design nor a list of designs' }];
  }
  return only.flatMap((i) => sentShapeIssues({ ...i, path: [...issue.path, ...i.path] } as Issue));
}

/**
 * Called from the transition validator's hook on a failed parse: a fault in `awaitsDesign` is
 * refused at its own path, naming what was wrong there and the shape the field takes; every other
 * failing field keeps its row in the same answer. A body whose `awaitsDesign` is sound returns.
 */
export function refuseAwaitsDesignShape(error: z.core.$ZodError | undefined): void {
  if (!error) return;
  refuseNestedField(
    error.issues.flatMap(sentShapeIssues),
    'awaitsDesign',
    'BAD_REQUEST',
    AWAITS_DESIGN_SHAPE,
  );
}
