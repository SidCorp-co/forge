// ISS-1229 r25, judge-72: a repository path that is not absolute was taken and then resolved against
// whatever directory the runner started in. The field now refuses it by name.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isAbsolutePath,
  REPO_PATH_NOT_ABSOLUTE,
  refusedRepoPath,
  repoPathField,
  repoPathRefusal,
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
