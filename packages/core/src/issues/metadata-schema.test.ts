import { describe, expect, it } from 'vitest';
import {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

describe('branchNameSchema', () => {
  it('accepts valid branch names', () => {
    for (const name of ['main', 'feat/x', 'release-1.2.3', 'feature/iss-200-foo']) {
      expect(branchNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects empty / whitespace-only', () => {
    expect(branchNameSchema.safeParse('').success).toBe(false);
    expect(branchNameSchema.safeParse('   ').success).toBe(false);
  });

  it('rejects names with shell-special chars or spaces', () => {
    for (const name of ['has space', 'feat;rm', 'feat$x', 'feat`x', 'feat|x']) {
      expect(branchNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('rejects names longer than 100 chars', () => {
    expect(branchNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

describe('branchConfigOverrideSchema', () => {
  it('accepts partial overrides', () => {
    expect(branchConfigOverrideSchema.safeParse({ baseBranch: 'feat/x' }).success).toBe(true);
    expect(branchConfigOverrideSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null fields (used to clear a single override)', () => {
    expect(
      branchConfigOverrideSchema.safeParse({ baseBranch: null, prodBranch: null }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(branchConfigOverrideSchema.safeParse({ otherBranch: 'x' }).success).toBe(false);
  });
});

describe('issueMetadataSchema', () => {
  it('accepts null (clears the column)', () => {
    expect(issueMetadataSchema.safeParse(null).success).toBe(true);
  });

  it('accepts branchConfig: null (clears just the branch override)', () => {
    expect(issueMetadataSchema.safeParse({ branchConfig: null }).success).toBe(true);
  });

  it('rejects unknown keys (strict, forward-compat is opt-in via migration)', () => {
    expect(issueMetadataSchema.safeParse({ skillKnobs: {} }).success).toBe(false);
  });
});

describe('isSelfReferentialBranch', () => {
  it('matches exact iss-<seq>', () => {
    expect(isSelfReferentialBranch('iss-137', 137)).toBe(true);
    expect(isSelfReferentialBranch('ISS-137', 137)).toBe(true);
  });

  it('matches iss-<seq>-<slug>', () => {
    expect(isSelfReferentialBranch('iss-137-foo', 137)).toBe(true);
    expect(isSelfReferentialBranch('ISS-137-Foo-Bar', 137)).toBe(true);
  });

  it('does not match other iss-N branches', () => {
    expect(isSelfReferentialBranch('iss-138', 137)).toBe(false);
    expect(isSelfReferentialBranch('iss-1370', 137)).toBe(false);
    expect(isSelfReferentialBranch('iss-13', 137)).toBe(false);
  });

  it('does not match unrelated branches', () => {
    expect(isSelfReferentialBranch('main', 137)).toBe(false);
    expect(isSelfReferentialBranch('feat/iss-137-foo', 137)).toBe(false);
  });
});
