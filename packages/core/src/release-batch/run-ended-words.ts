const STOPPED: Readonly<Record<string, string>> = {
  failed: 'failed',
  cancelled: 'was cancelled',
};

/** "The release run failed without finishing its release": never its stored status or its id. */
export function releaseRunStopped(status: string | null): string {
  if (status === 'completed') return 'The release finished but left this issue at Releasing';
  return `The release run ${(status && STOPPED[status]) ?? 'stopped'} without finishing its release`;
}
