import { describe, expect, it } from 'vitest';
import { releaseBlockerError } from './blocker-errors.js';
import { blocker } from './blocker-kit.js';
import { ContractProviderNotLiveError } from './errors.js';

const waits = [
  {
    issueId: 'i',
    issue: 'HOP-12',
    contract: 'autoflow/book-follow-up',
    needed: '2.0.0',
    live: '1.4.0',
  },
];

describe('CONTRACT_PROVIDER_NOT_LIVE refuses a consumer production release by name (E4)', () => {
  it('names the contract, the version needed and the provider’s live version', () => {
    const b = blocker('CONTRACT_PROVIDER_NOT_LIVE', {
      issueIds: ['i'],
      displayIds: ['HOP-12'],
      waits,
    });
    expect(b.httpStatus).toBe(409);
    expect(b.message).toContain('`HOP-12` needs autoflow/book-follow-up >= 2.0.0');
    expect(b.message).toContain("its provider's production serves 1.4.0");
  });

  it('is thrown under its own name, carrying the issues it holds', () => {
    const b = blocker('CONTRACT_PROVIDER_NOT_LIVE', {
      issueIds: ['i'],
      displayIds: ['HOP-12'],
      waits,
    });
    const err = releaseBlockerError({
      projectId: 'p',
      projectExists: true,
      declaration: null,
      channels: [],
      blockers: [b],
      warnings: [],
    });
    expect(err).toBeInstanceOf(ContractProviderNotLiveError);
    expect((err as ContractProviderNotLiveError).issueIds).toEqual(['i']);
  });
});
