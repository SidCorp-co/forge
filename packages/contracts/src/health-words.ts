// A connection's last health check, said to a person; core's status rows and the web's connection
// rows both read it here, so a check reads the same wherever it is shown (ISS-1421).

const HEALTH_WORDS: Record<string, string> = {
  ok: 'The last check passed.',
  healthy: 'The last check passed.',
  success: 'The last check passed.',
  degraded: 'The last check found it degraded.',
  pending: 'A check is still running.',
  unknown: 'The last check could not tell.',
  error: 'The last check failed.',
  needs_reauth: 'It needs signing in again.',
  needs_scope: 'It needs more permissions.',
};

export const NOT_CHECKED = 'Not checked yet.';

export function healthWords(status: string): string {
  return HEALTH_WORDS[status.toLowerCase()] ?? 'The last check gave an answer Forge does not know.';
}

export function healthLine(status: string | null | undefined, checkedAgo?: string | null): string {
  if (!status) return NOT_CHECKED;
  return checkedAgo ? `${healthWords(status)} Checked ${checkedAgo}.` : healthWords(status);
}
