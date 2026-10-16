const STOPPED: Readonly<Record<string, string>> = {
  failed: 'failed',
  cancelled: 'was cancelled',
  completed: 'completed',
};

/** "The release run failed without finishing its release": never its stored status or its id. */
export function releaseRunStopped(status: string | null): string {
  return `The release run ${(status && STOPPED[status]) ?? 'stopped'} without finishing its release`;
}
