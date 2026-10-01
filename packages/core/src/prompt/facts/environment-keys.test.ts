import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../../project-config/schema.js';
import { renderTestCreds } from './environment-keys.js';

const document = (testing: Record<string, string | undefined>) =>
  ({
    environments: Object.fromEntries(
      Object.entries(testing).map(([name, profile]) => [
        name,
        {
          tier: 'staging',
          deployment: { mode: 'external' },
          ...(profile ? { testing: profile } : {}),
        },
      ]),
    ),
  }) as unknown as ProjectDocument;

describe('{{project:test-creds}}', () => {
  it('names each profile and the one route a job reads its values with', () => {
    const text = renderTestCreds('p1', document({ staging: 'qa' })) ?? '';
    expect(text).toContain('- staging: testing profile `qa`');
    expect(text).toContain('GET /api/projects/p1/testing-profiles/qa');
    expect(text).toContain('GET /api/jobs/self/testing-profiles/<profile>/secrets');
    expect(text).toContain('Authorization: Bearer $FORGE_PAT');
  });

  it('says nothing where no environment names a profile', () => {
    expect(renderTestCreds('p1', document({ staging: undefined }))).toBeUndefined();
    expect(renderTestCreds('p1', null)).toBeUndefined();
  });
});
