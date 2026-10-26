import { describe, expect, it } from 'vitest';
import { healthLine, healthWords, NOT_CHECKED, PROVIDER_LABELS } from './health-words.js';

describe('a health check in words (ISS-1421 r4 repair 1)', () => {
  it.each(['ok', 'degraded', 'error', 'needs_reauth', 'needs_scope', 'pending', 'unknown', 'new'])(
    'says %s as a capitalised sentence with no field word',
    (status) => {
      expect(healthWords(status)).toMatch(/^[A-Z][^_]*\.$/);
    },
  );

  it('says when it was checked, and that it never was', () => {
    expect(healthLine('ok', '3 hours ago')).toBe('The last check passed. Checked 3 hours ago.');
    expect(healthLine('ok')).toBe('The last check passed.');
    expect(healthLine(null, '3 hours ago')).toBe(NOT_CHECKED);
  });
});

// ISS-1421 r30, judge-122 on 337: core said "No agent can use Agent" where the Integrations page says
// "Agent release channel", and "Github" where it says "GitHub": two lists of labels that disagreed.
describe('one label per provider, for core and the web alike', () => {
  it('labels each provider as the Integrations page shows it', () => {
    expect(PROVIDER_LABELS).toEqual({
      coolify: 'Coolify',
      postman: 'Postman',
      epodsystem: 'Epodsystem',
      sentry: 'Sentry',
      rocketchat: 'Rocket.Chat',
      github: 'GitHub',
      google: 'Google Sheets',
      agent: 'Agent release channel',
    });
  });
});
