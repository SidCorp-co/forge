// A connection's last health check and its provider's name, said to a person; core's sentences and
// the web's rows both read them here, so neither reads differently wherever it is shown (ISS-1421).

/**
 * Each provider as the Integrations page labels it. Core's refusals and the web's registry both
 * read this one map, so a sentence and the page cannot name a provider apart (ISS-1421 r30).
 */
export const PROVIDER_LABELS = {
  coolify: 'Coolify',
  postman: 'Postman',
  epodsystem: 'Epodsystem',
  sentry: 'Sentry',
  rocketchat: 'Rocket.Chat',
  github: 'GitHub',
  google: 'Google Sheets',
  agent: 'Agent release channel',
} as const;

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
