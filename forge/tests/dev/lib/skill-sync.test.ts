import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri IPC + API client BEFORE importing the module under test, so
// the module-level imports resolve to the test doubles.
const invokeMock = vi.fn();
vi.mock('@/hooks/use-tauri-ipc', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const requestMock = vi.fn();
const resolveProjectIdMock = vi.fn();
vi.mock('@/lib/api/client', () => ({
  request: (...args: unknown[]) => requestMock(...args),
  resolveProjectId: (...args: unknown[]) => resolveProjectIdMock(...args),
}));

import { syncProjectSkills, syncAllProjectSkills } from '@/lib/skill-sync';
import type { AppConfig } from '@/lib/types';

beforeEach(() => {
  invokeMock.mockReset();
  requestMock.mockReset();
  resolveProjectIdMock.mockReset();
});

describe('syncProjectSkills', () => {
  it('skips skills whose contentHash matches the local hash', async () => {
    resolveProjectIdMock.mockResolvedValue('proj-1');
    requestMock.mockResolvedValue([
      { id: 's1', name: 'forge-code', target: 'dev', skillMd: '...', contentHash: 'h1' },
      { id: 's2', name: 'forge-fix', target: 'dev', skillMd: '...', contentHash: 'h2' },
    ]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_skill_hashes') return Promise.resolve({ 'forge-code': 'h1', 'forge-fix': 'h2' });
      return Promise.resolve();
    });

    const synced = await syncProjectSkills('demo', '/repos/demo');

    expect(synced).toBe(false);
    // No install_skill_from_strapi calls — both skills already up to date.
    expect(invokeMock).not.toHaveBeenCalledWith('install_skill_from_strapi', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('refresh_enabled_skills');
  });

  it('installs skills with stale or missing local hash and refreshes', async () => {
    resolveProjectIdMock.mockResolvedValue('proj-1');
    requestMock.mockResolvedValue([
      { id: 's1', name: 'forge-code', target: 'dev', skillMd: 'new', contentHash: 'h-new' },
    ]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_skill_hashes') return Promise.resolve({ 'forge-code': 'h-old' });
      return Promise.resolve();
    });

    const synced = await syncProjectSkills('demo', '/repos/demo');

    expect(synced).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      'install_skill_from_strapi',
      expect.objectContaining({ data: expect.objectContaining({ name: 'forge-code', skillMd: 'new' }) }),
    );
    expect(invokeMock).toHaveBeenCalledWith('refresh_enabled_skills');
  });

  it('routes cloud-target skills through install_skill_guide', async () => {
    resolveProjectIdMock.mockResolvedValue('proj-1');
    requestMock.mockResolvedValue([
      { id: 's1', name: 'cloud-skill', target: 'cloud', localGuide: 'guide', contentHash: 'h1' },
    ]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_skill_hashes') return Promise.resolve({});
      return Promise.resolve();
    });

    const synced = await syncProjectSkills('demo', '/repos/demo');

    expect(synced).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      'install_skill_guide',
      expect.objectContaining({ data: expect.objectContaining({ localGuide: 'guide' }) }),
    );
  });

  it('returns false when /effective fetch fails (per-project skip)', async () => {
    resolveProjectIdMock.mockResolvedValue('proj-1');
    requestMock.mockRejectedValue(new Error('500'));
    const synced = await syncProjectSkills('demo', '/repos/demo');
    expect(synced).toBe(false);
  });
});

describe('syncAllProjectSkills', () => {
  it('iterates configured projects and aggregates the synced flag', async () => {
    resolveProjectIdMock.mockImplementation((slug: string) => Promise.resolve(`id-${slug}`));
    // proj-a returns a stale skill, proj-b returns nothing → installed only for a.
    requestMock.mockImplementation((path: string) => {
      if (path.includes('id-a')) {
        return Promise.resolve([{ id: 's', name: 'sk', target: 'dev', contentHash: 'new', skillMd: '' }]);
      }
      return Promise.resolve([]);
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_skill_hashes') return Promise.resolve({});
      return Promise.resolve();
    });

    const config = {
      coreUrl: '',
      authToken: '',
      deviceId: '',
      projects: {
        a: { slug: 'a', repoPath: '/r/a' },
        b: { slug: 'b', repoPath: '/r/b' },
      },
    } as unknown as AppConfig;

    const synced = await syncAllProjectSkills(config);
    expect(synced).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('skips projects without a repoPath', async () => {
    requestMock.mockResolvedValue([]);
    invokeMock.mockResolvedValue({});
    const config = {
      coreUrl: '',
      authToken: '',
      deviceId: '',
      projects: {
        no: { slug: 'no' }, // no repoPath
      },
    } as unknown as AppConfig;
    const synced = await syncAllProjectSkills(config);
    expect(synced).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
