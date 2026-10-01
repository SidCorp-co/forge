import type { Promotion } from './release-path.js';
import {
  type EnvironmentDeclaration,
  type ProjectDocument,
  projectDocumentSchema,
  SCHEMA_BASE,
} from './schema.js';

export const DOC_PROJECT = '33333333-3333-4333-8333-333333333333';
export const PROD_BINDING = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
export const DEV_BINDING = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60';

export const sourceProbe = (url = 'https://api.example.com/version', path = 'sourceCommit') => ({
  type: 'http' as const,
  url,
  path,
  identifies: 'source' as const,
});

export const deployedBy = (
  binding: string,
  trigger: 'on-land' | 'on-request' | 'provider' = 'on-request',
) => ({ binding, trigger });

/** A project-v1 document parsed by the real schema, so a fixture the schema refuses fails here. */
export function projectDoc(opts: {
  defaultBranch?: string;
  branches?: string[];
  environments?: Record<string, EnvironmentDeclaration>;
  promotions?: Promotion[];
  source?: 'git' | 'none';
}): ProjectDocument {
  const defaultBranch = opts.defaultBranch ?? 'main';
  const promotions = opts.promotions ?? [];
  const branches = [
    ...new Set([
      defaultBranch,
      ...(opts.branches ?? []),
      ...promotions.flatMap((p) => [p.from, p.to]),
    ]),
  ];
  return projectDocumentSchema.parse({
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: DOC_PROJECT, slug: 'fixture', name: 'Fixture' },
    source:
      opts.source === 'none'
        ? { type: 'none' }
        : {
            type: 'git',
            git: { repository: 'github.com/acme/fixture', defaultBranch, branches },
          },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: opts.environments ?? {},
    promotions,
    rollback: { strategy: 'none' },
    execution: {
      plugin: { source: 'acme/plugin', ref: '0123456789abcdef0123456789abcdef01234567' },
    },
  });
}

/** A production environment deploying `deploysFrom` through `binding`. */
export function production(
  over: Partial<EnvironmentDeclaration> & { binding?: string | null } = {},
): EnvironmentDeclaration {
  const { binding = PROD_BINDING, ...rest } = over;
  return {
    tier: 'production',
    deploysFrom: 'main',
    deployment: binding === null ? { mode: 'external' } : deployedBy(binding),
    ...rest,
  };
}
