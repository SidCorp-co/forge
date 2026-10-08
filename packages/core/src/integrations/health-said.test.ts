import { saidDisagreements, sayEn, verbatim } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { reauthDetail } from './autoflow/refresh.js';
import {
  CoolifyApiError,
  coolifyForbiddenSaid,
  describeCoolifyForbidden,
} from './deploy/coolify/client.js';
import { healthOf, thrownSaid } from './health-said.js';

// A healthcheck's sentence is said: the adapter's own by key, so the connection card and the test
// result read in the reader's language, and a provider's or a throw's words verbatim. `message`
// stays its English, the field the plugin reads.

describe("a healthcheck's sentence", () => {
  it('carries its English as message beside the said form, and agrees with it', () => {
    const result = healthOf(
      'needs_reauth',
      reauthDetail('refresh_refused:invalid_grant', 'https://a.example'),
    );
    expect(result.says?.message.key).toBe('integrations.health.autoflow.refreshRefused');
    expect(result.message).toBe(sayEn(result.says?.message ?? verbatim('')));
    expect(result.message).toContain('https://a.example');
    expect(saidDisagreements(result)).toEqual([]);
  });

  it('says nothing, and claims no message, when the adapter had no sentence', () => {
    expect(healthOf('ok')).toEqual({ status: 'ok' });
  });

  it("carries a provider's refusal as the provider wrote it", () => {
    const said = thrownSaid(new Error('ECONNRESET at 10.0.0.1'));
    expect(said).toEqual(verbatim('ECONNRESET at 10.0.0.1'));
    expect(thrownSaid('plain')).toEqual(verbatim('plain'));
    expect(thrownSaid(42, true).key).toBe('integrations.health.unknownError');
  });

  it("words Coolify's 403 by key, its English unchanged for the plugin", () => {
    const err = new CoolifyApiError(403, 'forbidden', undefined, 'GET /api/v1/deploy');
    const said = coolifyForbiddenSaid(err);
    expect(said.key).toBe('integrations.health.coolify.forbidden');
    expect(describeCoolifyForbidden(err)).toBe(sayEn(said));
    expect(describeCoolifyForbidden(err)).toMatch(
      /^Coolify recognised the API token but refused GET \/api\/v1\/deploy \(HTTP 403\): the token is missing /,
    );
  });
});
