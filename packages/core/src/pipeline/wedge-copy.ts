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
