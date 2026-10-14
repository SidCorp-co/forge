import { z } from 'zod';

const RECONSTRUCTION_SOURCE = 'reconstructed_from_box';

/** Refused by name, with the one valid source, where a checkpoint declares anything else. */
export const checkpointSourceSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((source): boolean => source === RECONSTRUCTION_SOURCE, {
    error: (issue) =>
      `a checkpoint declares what it is in \`source\`, and the only valid source is \`${RECONSTRUCTION_SOURCE}\`; got ${JSON.stringify(issue.input)}`,
  });
