// How a wedge notification words the things an operator reads: a blocker's
// status and how long something has been waiting.
//
// Presentation only — no query, no state. Split out of sweeper.ts so the
// wording can change without touching a sweep pass.

// cm:guard ISS-619 — the fallback below is what keeps this map optional: a status added to the kernel renders title-cased instead of raw, so nobody has to remember to edit this file. Replacing it with a lookup that can miss puts an internal enum value in front of an operator.
const BLOCKER_STATUS_LABELS: Record<string, string> = {
  needs_info: 'Needs info',
  waiting: 'Waiting for review',
  on_hold: 'On hold',
  draft: 'Draft',
  reopen: 'Reopened',
};

export function blockerStatusLabel(status: string): string {
  return (
    BLOCKER_STATUS_LABELS[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
  );
}

export function humanizeDuration(mins: number): string {
  return mins < 60 ? `~${mins}m` : `~${Math.round(mins / 60)}h`;
}
