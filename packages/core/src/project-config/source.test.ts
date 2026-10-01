import { describe, expect, it, vi } from 'vitest';
import { projectDoc } from './release-path.fixture.js';

const documents = vi.fn();
vi.mock('./service.js', () => ({ readProjectDocument: documents }));

const { defaultBranchOf, remoteOf, repositoryOf, setupOf, webUrlOf, withDeclaredSource } =
  await import('./source.js');

describe('repositoryOf', () => {
  it('is source.git.repository on a git project', () => {
    expect(repositoryOf(projectDoc({}))).toBe('github.com/acme/fixture');
  });

  it('is null on a project with no git source, and with no document', () => {
    expect(repositoryOf(projectDoc({ source: 'none' }))).toBeNull();
    expect(repositoryOf(null)).toBeNull();
  });
});

describe('defaultBranchOf', () => {
  it('is source.git.defaultBranch, and null with no git source or no document', () => {
    expect(defaultBranchOf(projectDoc({ defaultBranch: 'dev' }))).toBe('dev');
    expect(defaultBranchOf(projectDoc({ source: 'none' }))).toBeNull();
    expect(defaultBranchOf(null)).toBeNull();
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
    expect(remoteOf('github.com/SidCorp-co/forge', 'ssh')).toBe(
      'git@github.com:SidCorp-co/forge.git',
    );
    expect(remoteOf('github.com/SidCorp-co/forge', 'https')).toBe(
      'https://github.com/SidCorp-co/forge.git',
    );
  });

  it('keeps a host that is not GitHub', () => {
    expect(remoteOf('gitlab.example.co/team/app', 'ssh')).toBe(
      'git@gitlab.example.co:team/app.git',
    );
  });
});

describe('webUrlOf', () => {
  it('is the page a person opens', () => {
    expect(webUrlOf('github.com/acme/app')).toBe('https://github.com/acme/app');
  });
});

describe('withDeclaredSource', () => {
  it("answers each row's baseBranch and workspaceSetup from its project document, read once per project", async () => {
    const doc = projectDoc({ defaultBranch: 'dev' });
    documents.mockImplementation(async (projectId: string) =>
      projectId === 'p-1'
        ? { document: { ...doc, workspace: { isolation: 'worktree', setup: 'pnpm install' } } }
        : null,
    );
    const out = await withDeclaredSource([
      { projectId: 'p-1', runnerId: 'r-1' },
      { projectId: 'p-1', runnerId: 'r-2' },
      { projectId: 'p-2', runnerId: 'r-3' },
    ]);
    expect(out.map((r) => [r.runnerId, r.workspaceSetup, r.baseBranch])).toEqual([
      ['r-1', 'pnpm install', 'dev'],
      ['r-2', 'pnpm install', 'dev'],
      ['r-3', null, null],
    ]);
    expect(documents.mock.calls.map(([id]) => id)).toEqual(['p-1', 'p-2']);
  });
});
