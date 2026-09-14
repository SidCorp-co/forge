import { describe, expect, it } from 'vitest';
import fixture from '../../messaging/legacy-verdicts.fixture.json' with { type: 'json' };
import { characterizeLegacyRules } from './legacy-characterize.js';

describe('the compatibility baseline ISS-997 migrates against', () => {
  it('holds the verdicts the original rule bodies actually produce, not ones written by hand', () => {
    expect(characterizeLegacyRules().rows).toEqual(fixture.rows);
  });

  it('names the source it froze and that source is unchanged', () => {
    const fresh = characterizeLegacyRules();
    expect(fresh.source).toBe('packages/core/src/integrations/rocketchat/reply-guard.ts');
    expect(fresh.sourceSha256).toBe(fixture.sourceSha256);
  });

  it('is a corpus that refuses things, so agreeing with it is not agreeing about nothing', () => {
    const refusing = fixture.rows.filter(
      (r) => typeof r.verdict === 'object' && r.verdict !== null && (r.verdict as { ok?: boolean }).ok === false,
    );
    expect(refusing.length).toBeGreaterThan(50);
  });
});
