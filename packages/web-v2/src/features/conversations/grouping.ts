// Recency grouping for the conversation list.
//
// It moved here from `features/sessions/` with ISS-1004 step 5: it was shared
// with the chat-history popover, that popover read `agent_sessions`, and both
// it and the session row this took went with the port.


export type BucketKey = "today" | "yesterday" | "week" | "older";

// cm:guard generic over the one field it reads, so the list row may carry whatever the screen needs beside it — the project it came from, today — without this module knowing about any of it.
export interface Bucket<Row extends { updatedAt: string }> {
  key: BucketKey;
  label: string;
  rows: Row[];
}

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  older: "Older",
};

export function bucketFor(iso: string, now: number): BucketKey {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "older";
  const ageMs = now - then;
  const dayMs = 24 * 60 * 60 * 1000;
  // cm:why the two nearest buckets are cut on the local CALENDAR day and not on elapsed hours, so a room last spoken in at 11pm reads as "Yesterday" rather than as today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (then >= todayStart.getTime()) return "today";
  if (then >= todayStart.getTime() - dayMs) return "yesterday";
  if (ageMs <= 7 * dayMs) return "week";
  return "older";
}

/** Partitions `rows` into recency buckets — does NOT reorder within a bucket,
 *  so callers relying on a pre-sorted `updatedAt DESC` input keep that order. */
export function groupByRecency<Row extends { updatedAt: string }>(
  rows: Row[],
  now = Date.now(),
): Array<Bucket<Row>> {
  const buckets: Record<BucketKey, Bucket<Row>> = {
    today: { key: "today", label: BUCKET_LABEL.today, rows: [] },
    yesterday: { key: "yesterday", label: BUCKET_LABEL.yesterday, rows: [] },
    week: { key: "week", label: BUCKET_LABEL.week, rows: [] },
    older: { key: "older", label: BUCKET_LABEL.older, rows: [] },
  };
  for (const r of rows) {
    const k = bucketFor(r.updatedAt, now);
    buckets[k].rows.push(r);
  }
  return [buckets.today, buckets.yesterday, buckets.week, buckets.older].filter(
    (b) => b.rows.length > 0,
  );
}
