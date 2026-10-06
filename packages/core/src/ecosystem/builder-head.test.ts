import { describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/source-host/index.js', async () => {
  const { SourceHostUnavailable } = await import('../integrations/source-host/errors.js');
  return { resolveSourceHost: vi.fn(), SourceHostUnavailable };
});
vi.mock('../project-config/index.js', async () => {
  const source = await import('../project-config/source.js');
  return { readDeclaredSource: vi.fn(), parseRepository: source.parseRepository };
});
vi.mock('../runners/index.js', async () => {
  return { readCheckoutHead: vi.fn() };
});

const { resolveSourceHost } = await import('../integrations/source-host/index.js');
const { SourceHostUnavailable } = await import('../integrations/source-host/errors.js');
const { readDeclaredSource } = await import('../project-config/index.js');
const { readCheckoutHead } = await import('../runners/index.js');
const { owedTrigger } = await import('./builder-head.js');

const SHA = 'b'.repeat(40);
const P = '00000000-0000-4000-8000-000000000002';
const git = { type: 'repository' } as const;

function declare(repository: string) {
  vi.mocked(readDeclaredSource).mockResolvedValue({
    repository,
    defaultBranch: 'dev',
    setup: null,
  });
}
const fromRunner = {
  sha: SHA,
  ref: 'refs/heads/dev',
  readAt: '2026-10-05T10:00:01.000Z',
  via: 'runner-checkout' as const,
  deviceId: 'dev-1',
};

describe('owedTrigger: the head a joined builder run reads', () => {
  it('reads a hosted repository through its binding, and says so', async () => {
    declare('github.com/o/r');
    vi.mocked(resolveSourceHost).mockResolvedValue({
      branchHead: async () => SHA,
    } as never);
    const t = await owedTrigger({ projectId: P, kind: 'joined', source: git });
    expect(t.ok && t.value.sha).toBe(SHA);
    expect(t.ok && t.value.head?.via).toBe('source-host');
    expect(t.ok && t.value.head?.ref).toBe('refs/heads/dev');
  });

  it('with no source host binding, takes the head from the bound runner checkout', async () => {
    declare('git@gitlab.com:sidcorp-internal/webauto');
    vi.mocked(resolveSourceHost).mockRejectedValue(
      new SourceHostUnavailable('no_binding', 'this project has no active source host binding'),
    );
    vi.mocked(readCheckoutHead).mockResolvedValue({ ok: true, head: fromRunner });
    const t = await owedTrigger({ projectId: P, kind: 'joined', source: git });
    expect(t).toEqual({
      ok: true,
      value: {
        kind: 'joined',
        sha: SHA,
        head: { ref: 'refs/heads/dev', readAt: fromRunner.readAt, via: 'runner-checkout' },
      },
    });
  });

  it('reads a local-path repository only from the runner checkout, never a host', async () => {
    declare('/srv/git/epodsystem-core.git');
    vi.mocked(resolveSourceHost).mockClear();
    vi.mocked(readCheckoutHead).mockResolvedValue({ ok: true, head: fromRunner });
    const t = await owedTrigger({ projectId: P, kind: 'joined', source: git });
    expect(t.ok && t.value.head?.via).toBe('runner-checkout');
    expect(resolveSourceHost).not.toHaveBeenCalled();
    expect(readCheckoutHead).toHaveBeenLastCalledWith(P, 'dev', '/srv/git/epodsystem-core.git');
  });

  it('refuses by name when neither a binding nor a bound runner can answer, naming both ways out', async () => {
    declare('git@gitlab.com:sidcorp-internal/webauto');
    vi.mocked(resolveSourceHost).mockRejectedValue(
      new SourceHostUnavailable('no_binding', 'this project has no active source host binding'),
    );
    vi.mocked(readCheckoutHead).mockResolvedValue({
      ok: false,
      reason: 'no_runner_online',
      detail:
        "no runner holding a bound checkout is online — bind the repository's host on the project's Integrations page, or bring online a box holding a checkout of it (`forge-runner bind`)",
    });
    const t = await owedTrigger({ projectId: P, kind: 'joined', source: git });
    expect(t.ok).toBe(false);
    const r = !t.ok ? t.refusals[0] : undefined;
    expect(r?.code).toBe('BUILDER_RUN_HEAD_UNREADABLE');
    expect(r?.detail).toContain('no runner holding a bound checkout is online');
    expect(r?.detail).toContain('this project has no active source host binding');
    expect(r?.detail).toContain('Integrations');
    expect(r?.detail).toContain('forge-runner bind');
  });

  it('a binding that exists on the wrong host is its own refusal, never answered by the runner', async () => {
    declare('github.com/o/r');
    vi.mocked(readCheckoutHead).mockClear();
    vi.mocked(resolveSourceHost).mockRejectedValue(
      new SourceHostUnavailable('host_mismatch', 'the binding reaches gitlab.com'),
    );
    const t = await owedTrigger({ projectId: P, kind: 'joined', source: git });
    expect(!t.ok && t.refusals[0]?.detail).toContain('the binding reaches gitlab.com');
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });
});
