import { pointer } from './documents.js';
import type { PolicyDocument, ProjectDocument } from './schema.js';
import {
  type Held,
  listActiveBindings,
  listTestingProfiles,
  readDeviceCheckout,
  readPolicy,
  readProjectConfig,
} from './service.js';

export type EffectiveLayer =
  | 'project'
  | 'policy'
  | 'testing-profile'
  | 'device-binding'
  | 'binding';

export interface EffectiveValue {
  value: unknown;
  from: EffectiveLayer;
  revision?: number;
}

export type EffectiveConfig =
  | { declared: false; revision: null }
  | {
      declared: true;
      revision: number;
      device: string | null;
      undeclared: EffectiveLayer[];
      values: Record<string, EffectiveValue>;
    };

const PROJECT_KEYS = [
  'project',
  'source',
  'workspace',
  'validation',
  'environments',
  'promotions',
  'rollback',
  'execution',
] as const satisfies readonly (keyof ProjectDocument)[];

const POLICY_KEYS = ['qa', 'intake', 'permissions', 'states'] as const;

function bindingIdsOf(doc: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  if (doc.source.type === 'storefront') ids.add(doc.source.storefront.binding);
  for (const env of Object.values(doc.environments)) {
    if ('binding' in env.deployment) ids.add(env.deployment.binding);
  }
  return ids;
}

/**
 * The policy layer of the effective config, on its own: dispatch needs it where a project has no
 * project document yet, and reading it here keeps one read behind both answers.
 */
export async function readEffectivePolicy(projectId: string): Promise<Held<PolicyDocument> | null> {
  return readPolicy(projectId);
}

export async function buildEffectiveConfig(input: {
  projectId: string;
  deviceId: string | null;
}): Promise<EffectiveConfig> {
  const project = await readProjectConfig(input.projectId);
  if (!project) return { declared: false, revision: null };

  const [policy, profiles, bindings, checkout] = await Promise.all([
    readEffectivePolicy(input.projectId),
    listTestingProfiles(input.projectId),
    listActiveBindings(input.projectId),
    input.deviceId ? readDeviceCheckout(input.projectId, input.deviceId) : Promise.resolve(null),
  ]);

  const values: Record<string, EffectiveValue> = {};
  const undeclared: EffectiveLayer[] = [];

  if (policy) {
    for (const key of POLICY_KEYS) {
      values[pointer([key])] = {
        value: policy.document[key],
        from: 'policy',
        revision: policy.revision,
      };
    }
  } else {
    undeclared.push('policy');
  }

  for (const key of PROJECT_KEYS) {
    values[pointer([key])] = {
      value: project.document[key],
      from: 'project',
      revision: project.revision,
    };
  }

  if (profiles.length === 0) undeclared.push('testing-profile');
  for (const profile of profiles) {
    values[pointer(['testing', profile.profileId])] = {
      value: profile.document,
      from: 'testing-profile',
      revision: profile.revision,
    };
  }

  const referenced = bindingIdsOf(project.document);
  for (const binding of bindings.filter((b) => referenced.has(b.id))) {
    values[pointer(['bindings', binding.id])] = {
      value: {
        id: binding.id,
        role: binding.role,
        provider: binding.provider,
        stages: binding.stages,
        label: binding.label,
      },
      from: 'binding',
    };
  }

  if (checkout) {
    values[pointer(['checkout'])] = {
      value: { deviceId: checkout.deviceId, repoPath: checkout.repoPath, branch: checkout.branch },
      from: 'device-binding',
    };
  } else {
    undeclared.push('device-binding');
  }

  return {
    declared: true,
    revision: project.revision,
    device: input.deviceId,
    undeclared,
    values,
  };
}
