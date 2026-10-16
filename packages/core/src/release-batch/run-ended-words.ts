const STOPPED: Readonly<Record<string, string>> = {
  failed: 'failed',
  cancelled: 'was cancelled',
  completed: 'completed',
};

/** "The release run failed without finishing its release" — naming the run where one is given. */
export function releaseRunStopped(status: string | null, runId?: string): string {
  const run = runId ? `Release run ${runId}` : 'The release run';
  return `${run} ${(status && STOPPED[status]) ?? 'stopped'} without finishing its release`;
}
