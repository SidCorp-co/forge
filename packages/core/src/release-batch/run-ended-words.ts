const STOPPED: Readonly<Record<string, string>> = {
  failed: 'failed',
  cancelled: 'was cancelled',
};

/** "The release run failed without finishing its release": never its stored status or its id. A
 *  release run completes only by finishing its release (a finish or a recorded release), so one
 *  that completed is said to have finished, never contradicted (ISS-1421 r43, judge-171). */
export function releaseRunStopped(status: string | null): string {
  if (status === 'completed') return 'The release finished but left this issue at Releasing';
  return `The release run ${(status && STOPPED[status]) ?? 'stopped'} without finishing its release`;
}
