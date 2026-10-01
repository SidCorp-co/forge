import { describe, expect, it } from 'vitest';
import { projectDoc } from './release-path.fixture.js';
import { remoteOf, repositoryOf, setupOf, webUrlOf } from './source.js';

describe('repositoryOf', () => {
  it('is source.git.repository on a git project', () => {
    expect(repositoryOf(projectDoc({}))).toBe('github.com/acme/fixture');
  });

  it('is null on a project with no git source, and with no document', () => {
    expect(repositoryOf(projectDoc({ source: 'none' }))).toBeNull();
    expect(repositoryOf(null)).toBeNull();
  });
});

describe('setupOf', () => {
  it('is workspace.setup, and null where the document names none', () => {
    const doc = projectDoc({});
    expect(setupOf(doc)).toBeNull();
    expect(setupOf({ ...doc, workspace: { isolation: 'worktree', setup: 'pnpm i' } })).toBe(
      'pnpm i',
    );
  });
});

describe('remoteOf', () => {
  it('derives the SSH and the HTTPS remote of one repository', () => {
    expect(remoteOf('github.com/SidCorp-co/forge', 'ssh')).toBe('git@github.com:SidCorp-co/forge.git');
    expect(remoteOf('github.com/SidCorp-co/forge', 'https')).toBe(
      'https://github.com/SidCorp-co/forge.git',
    );
  });

  it('keeps a host that is not GitHub', () => {
    expect(remoteOf('gitlab.example.co/team/app', 'ssh')).toBe('git@gitlab.example.co:team/app.git');
  });
});

describe('webUrlOf', () => {
  it('is the page a person opens', () => {
    expect(webUrlOf('github.com/acme/app')).toBe('https://github.com/acme/app');
  });
});
