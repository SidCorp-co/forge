import { describe, expect, it } from 'vitest';
import { versionNoticeBody } from './notify-ecosystem.js';

const approved = (classification: string) => ({
  projectId: 'provider-1',
  providerSlug: 'catalog-api',
  contractSlug: 'admin-rest-v1',
  version: '3.1.1',
  classification,
  consumerIds: ['consumer-1'],
  filer: { userId: 'u1', agency: 'human' as const },
});

describe('feedback-triage breaking: the bell for a version that is not breaking', () => {
  it('names the adopt act for a non-breaking version, never "nothing owed"', () => {
    const body = versionNoticeBody(approved('non-breaking'), 'consumer-1');
    expect(body).toContain('POST /api/projects/consumer-1/interface/adopt');
    expect(body).toContain('"catalog-api/admin-rest-v1"');
    expect(body).toContain('"3.1.1"');
    expect(body).not.toContain('nothing this project does is owed');
  });

  it('names the reasoned adopt for a version measured unknown, never "nothing owed" (REQ-5 BC-15)', () => {
    const body = versionNoticeBody(approved('unknown'), 'consumer-1');
    expect(body).toContain('POST /api/projects/consumer-1/interface/adopt');
    expect(body).toContain('acceptUnmeasured: { reason }');
    expect(body).not.toContain('nothing this project does is owed');
  });
});
