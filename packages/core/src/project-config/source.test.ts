import { describe, expect, it } from 'vitest';
import { gitRepository } from './schema.js';
import { hostOf, parseRepository, remoteOf, repositoryIdentity, webUrlOf } from './source.js';

const accepts = (r: string) => gitRepository().safeParse(r).success;

describe('source.git.repository: the three spellings a project document may declare', () => {
  it('accepts a hosted name, an SSH remote and an absolute local path', () => {
    expect(accepts('github.com/SidCorp-co/forge')).toBe(true);
    expect(accepts('git@gitlab.com:sidcorp-internal/webauto')).toBe(true);
    expect(accepts('git@gitlab.com:sidcorp-internal/webauto.git')).toBe(true);
    expect(accepts('/home/dev/forge/projects/eco-epod-catalog/remotes/epodsystem-core.git')).toBe(
      true,
    );
  });

  it('refuses what names no repository, naming the three valid shapes', () => {
    for (const bad of [
      'file:///home/dev/x.git',
      'localhost/eco/epod',
      'relative/path/repo',
      '/home/dev/../etc/repo',
      '/home/dev/./repo',
      'git@gitlab.com/owner/repo',
      'https://github.com/o/r',
      '/',
    ]) {
      const parsed = gitRepository().safeParse(bad);
      expect(parsed.success, bad).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('git@host.tld:owner/repo');
    }
  });

  it('reads each spelling as its kind, with the host a binding is matched against', () => {
    expect(parseRepository('github.com/o/r')).toEqual({
      kind: 'hosted',
      host: 'github.com',
      path: 'o/r',
    });
    expect(parseRepository('git@GitLab.com:o/r.git')).toEqual({
      kind: 'ssh',
      user: 'git',
      host: 'gitlab.com',
      path: 'o/r',
    });
    expect(parseRepository('/srv/git/r.git')).toEqual({ kind: 'local', path: '/srv/git/r.git' });
    expect(hostOf('/srv/git/r.git')).toBeNull();
    expect(hostOf('git@gitlab.com:o/r')).toBe('gitlab.com');
    expect(repositoryIdentity('git@gitlab.com:o/r.git')).toBe('gitlab.com/o/r');
    expect(repositoryIdentity('gitlab.com/O/R')).toBe('gitlab.com/o/r');
    expect(repositoryIdentity('/srv/git/r.git')).toBeNull();
  });

  it('clones each from where it lives: https for a hosted name, the remote or path as declared', () => {
    expect(remoteOf('github.com/o/r')).toBe('https://github.com/o/r.git');
    expect(remoteOf('git@gitlab.com:o/r')).toBe('git@gitlab.com:o/r');
    expect(remoteOf('/srv/git/r.git')).toBe('/srv/git/r.git');
    expect(webUrlOf('git@gitlab.com:o/r.git')).toBe('https://gitlab.com/o/r');
    expect(webUrlOf('/srv/git/r.git')).toBeNull();
  });
});
