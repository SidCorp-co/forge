/**
 * The source host a cleanup report's base is checked against (ISS-912), planted per project: which
 * commits exist and which branches hold them. A suite mocks the resolver onto it:
 *
 *   vi.mock('../../src/integrations/source-host/index.js', async (original) =>
 *     (await import('../helpers/cleanup-source.js')).mockedSourceHost(await original()));
 *
 * A project nothing planted resolves as the real resolver does. The planted host answers only the two
 * reads a base is checked with; any other verb answers as an unbound project does (`no_binding`), so a
 * suite's other readers see the world they saw before a host was planted. Nothing calls a real host.
 */

import type { SourceHost } from '../../src/integrations/source-host/index.js';

interface PlantedProject {
  /** Each branch and the commits it holds. */
  branches: Map<string, Set<string>>;
  /** A read that fails as a host failing would, where set. */
  fail: Error | null;
}

const planted = new Map<string, PlantedProject>();

/** Plant `projectId`'s host: each branch named and the commits it holds. */
export function plantSource(
  projectId: string,
  branches: Record<string, readonly string[]>,
): PlantedProject {
  const project: PlantedProject = {
    branches: new Map(Object.entries(branches).map(([b, shas]) => [b, new Set(shas)])),
    fail: null,
  };
  planted.set(projectId, project);
  return project;
}

/** Forget every planted host. */
export function resetPlantedSources(): void {
  planted.clear();
}

type Unavailable = new (reason: 'no_binding', message: string) => Error;

function hostOf(projectId: string, project: PlantedProject, unavailable: Unavailable): SourceHost {
  const commits = () => new Set([...project.branches.values()].flatMap((s) => [...s]));
  const host = {
    provider: 'github',
    bindingId: `planted-${projectId}`,
    fullName: 'acme/planted',
    host: 'github.com',
    readCommit: async (ref: string) => {
      if (project.fail) throw project.fail;
      const sha = ref.toLowerCase();
      return commits().has(sha) ? { sha, message: 'planted', committedAt: null } : null;
    },
    branchContains: async (branch: string, sha: string) => {
      if (project.fail) throw project.fail;
      return project.branches.get(branch)?.has(sha.toLowerCase()) ?? false;
    },
  };
  return new Proxy(host, {
    get(target, key, receiver) {
      // `then` stays undefined: the host is awaited out of an async resolver and is no promise
      if (typeof key !== 'string' || key === 'then' || key in target) {
        return Reflect.get(target, key, receiver);
      }
      return async () => {
        throw new unavailable('no_binding', `the planted host answers no \`${key}\``);
      };
    },
  }) as unknown as SourceHost;
}

/** The source-host module with its resolver answering the planted host for a planted project. */
export function mockedSourceHost<
  M extends { resolveSourceHost: (...a: never[]) => unknown; SourceHostUnavailable: unknown },
>(original: M): M {
  const real = original.resolveSourceHost as (projectId: string, ...rest: unknown[]) => unknown;
  const unavailable = original.SourceHostUnavailable as Unavailable;
  return {
    ...original,
    resolveSourceHost: async (projectId: string, ...rest: unknown[]) => {
      const project = planted.get(projectId);
      return project ? hostOf(projectId, project, unavailable) : real(projectId, ...rest);
    },
  };
}
