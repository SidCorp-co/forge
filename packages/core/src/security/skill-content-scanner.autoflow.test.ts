import { describe, expect, it } from 'vitest';
import { scanSkillContent } from './skill-content-scanner.js';

// The platform mints `sat_`/`srt_` + base64url(32 bytes) = 43 characters (oauth/usecase:randomToken).
const minted = (prefix: string) => `${prefix}${'Ab3_-'.repeat(9).slice(0, 43)}`;

describe('an Autoflow OAuth token pasted into a skill', () => {
  it.each(['sat_', 'srt_'])('is found and masked: %s', (prefix) => {
    const findings = scanSkillContent({ skillMd: `use ${minted(prefix)} to connect` });
    const hit = findings.find((f) => f.rule === 'secret.autoflow-token');
    expect(hit).toBeDefined();
    expect(JSON.stringify(findings)).not.toContain(minted(prefix));
  });

  it('is not found in prose that merely names the prefix', () => {
    const findings = scanSkillContent({
      skillMd: 'the access token starts sat_ and lives 12 hours',
    });
    expect(findings.map((f) => f.rule)).not.toContain('secret.autoflow-token');
  });
});
