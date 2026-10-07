import type { PulseWorkBuckets } from "@forge/contracts/pulse";

export type * from "@forge/contracts/pulse";

/** The statuses each work bucket is drawn from — a bucket cell's destination. Core's
 *  `me/pulse-types.ts` PULSE_*_STATUSES and `PARK_STATUSES` decide the buckets; this is their copy. */
export const PULSE_BUCKET_STATUSES: Record<keyof PulseWorkBuckets, readonly string[]> = {
  open: ["open", "approved"],
  inProgress: ["in_progress", "reopen"],
  awaitingRelease: ["awaiting_release"],
  humanBlocked: ["needs_info", "on_hold"],
};
