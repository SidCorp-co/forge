/** A GitLab job or pipeline status in the projection's vocabulary: queued → in_progress → completed. */
export function checkStatusOf(status: string | undefined): string {
  if (status === 'running') return 'in_progress';
  if (
    status === 'success' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'skipped'
  ) {
    return 'completed';
  }
  return 'queued';
}

export function conclusionOf(status: string | undefined): string | null {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failure';
  if (status === 'canceled') return 'cancelled';
  if (status === 'skipped') return 'skipped';
  return null;
}
