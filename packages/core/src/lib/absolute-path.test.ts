// ISS-1229 r25, judge-72: a repository path that is not absolute was taken and then resolved against
// whatever directory the runner started in. The field now refuses it by name.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isAbsolutePath,
  parseRefusingRelativeRepoPath,
  REPO_PATH_NOT_ABSOLUTE,
  refusedRepoPath,
  repoPathField,
  repoPathRefusal,
  repoPathRefusalIn,
} from './absolute-path.js';

const body = z.object({
  repoPath: repoPathField.optional(),
  labels: z.array(z.string().min(1)).optional(),
});

describe('an absolute path', () => {
  it.each([
    '/home/forge/projects/app',
    '/',
    'C:\\projects\\app',
    'd:/work/app',
    '\\\\share\\repos\\app',
  ])('is %j', (path) => expect(isAbsolutePath(path)).toBe(true));

  it.each(['projects/app', './app', '../app', '~/app', 'app', 'C:app', ''])('is not %j', (path) =>
    expect(isAbsolutePath(path)).toBe(false),
  );
});

describe('the repository path field', () => {
  it('takes an absolute path, trimmed, and an empty one', () => {
    expect(body.parse({ repoPath: '  /srv/app  ' })).toEqual({ repoPath: '/srv/app' });
    expect(body.parse({ repoPath: '' })).toEqual({ repoPath: '' });
  });

  it('refuses a relative path by name, saying what shape is valid', () => {
    const parsed = body.safeParse({ repoPath: 'projects/app' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const refusal = refusedRepoPath(parsed.error);
    expect(refusal?.status).toBe(400);
    expect(refusal?.message).toBe(repoPathRefusal('projects/app'));
    expect(refusal?.message).toMatch(
      /is not an absolute path\. Give .*\/home\/forge\/projects\/app/,
    );
    expect(refusal?.cause).toMatchObject({ code: REPO_PATH_NOT_ABSOLUTE });
  });

  it('leaves every other wrong body to the refusal it already had', () => {
    const parsed = body.safeParse({ labels: [''] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(refusedRepoPath(parsed.error)).toBeNull();
  });

  it('refuses a path past 500 characters as too long, not as relative', () => {
    const parsed = body.safeParse({ repoPath: `/${'a'.repeat(500)}` });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(refusedRepoPath(parsed.error)).toBeNull();
  });
});

// ISS-1236 r6, judge-140: forge_projects stored a relative path REST refuses. Every door asks one rule.
describe('the refusal, found where the field sits', () => {
  const tool = z.object({ patch: z.object({ repoPath: repoPathField.nullable().optional() }) });
  const retired = z.object({ agentConfig: z.unknown() }).superRefine((_v, ctx) => {
    ctx.addIssue({ code: 'custom', path: ['agentConfig', 'repoPath'], message: 'retired' });
  });

  it("names a tool patch's relative repoPath by its whole path", () => {
    const parsed = tool.safeParse({ patch: { repoPath: 'relative/x' } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(repoPathRefusalIn(parsed.error, ['patch', 'repoPath'])).toBe(
      repoPathRefusal('relative/x'),
    );
    expect(repoPathRefusalIn(parsed.error)).toBeNull();
  });

  it('leaves agentConfig.repoPath, a retired key with its own sentence, to that sentence', () => {
    const parsed = retired.safeParse({ agentConfig: {} });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(repoPathRefusalIn(parsed.error)).toBeNull();
    expect(refusedRepoPath(parsed.error)).toBeNull();
  });

  it('refuses at a non-HTTP door by code and sentence, and passes any other refusal through', () => {
    expect(() => parseRefusingRelativeRepoPath(body, { repoPath: 'app' })).toThrow(
      `BAD_REQUEST: ${REPO_PATH_NOT_ABSOLUTE}: ${repoPathRefusal('app')}`,
    );
    expect(() => parseRefusingRelativeRepoPath(body, { labels: [''] })).toThrow(z.ZodError);
    expect(parseRefusingRelativeRepoPath(body, { repoPath: '/srv/app' })).toEqual({
      repoPath: '/srv/app',
    });
  });
});
