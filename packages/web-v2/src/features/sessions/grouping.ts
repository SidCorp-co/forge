// Recency grouping shared by the ISS-465 conversation-history popover
// (`features/session/components/conversation-list.tsx`) and the ISS-698
// cross-project Conversations list (`features/conversations/`). Extracted so
// both surfaces agree on the exact bucket boundaries instead of drifting.
import type { SessionRow } from "./types";

export type BucketKey = "today" | "yesterday" | "week" | "older";

export interface Bucket {
  key: BucketKey;
  label: string;
  rows: SessionRow[];
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
  // "Today" / "Yesterday" honour the local calendar day so a chat from 11pm
  // last night reads as "Yesterday", not "1d ago today".
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (then >= todayStart.getTime()) return "today";
  if (then >= todayStart.getTime() - dayMs) return "yesterday";
  if (ageMs <= 7 * dayMs) return "week";
  return "older";
}

/** Partitions `rows` into recency buckets — does NOT reorder within a bucket,
 *  so callers relying on a pre-sorted `updatedAt DESC` input keep that order. */
export function groupByRecency(rows: SessionRow[], now = Date.now()): Bucket[] {
  const buckets: Record<BucketKey, Bucket> = {
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
