import type {
  BindingRow,
  CasInput,
  ConfigStore,
  DeviceCheckout,
  SecretName,
  StoredDocument,
  StoredProfile,
  StoredRevision,
} from './store.js';

export const PROJECT = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
export const OTHER_PROJECT = '0b6f3a2c-1d4e-4f5a-8b6c-7d8e9f0a1b2c';
export const ADMIN = '11111111-1111-4111-8111-111111111111';
export const VIEWER = '22222222-2222-4222-8222-222222222222';
export const DEVICE = '33333333-3333-4333-8333-333333333333';
export const DEPLOY_BINDING = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
export const SECRET_VALUE = 'correct-horse-battery-staple-9f2c';

export const mem = {
  project: new Map<string, StoredDocument>(),
  revisions: new Map<string, StoredRevision[]>(),
  policy: new Map<string, StoredDocument>(),
  profiles: new Map<string, StoredDocument>(),
  secrets: new Map<string, { scope: string; name: string; valueEnc: Buffer; updatedAt: Date }>(),
  bindings: [] as BindingRow[],
  checkouts: [] as (DeviceCheckout & { projectId: string })[],
  roles: new Map<string, 'admin' | 'viewer'>(),
};

function cas(
  table: Map<string, StoredDocument>,
  key: string,
  { baseRevision, document, userId }: CasInput,
) {
  const current = table.get(key);
  const storedRevision = current?.revision ?? null;
  if (storedRevision !== baseRevision) return { ok: false as const, storedRevision };
  const stored = {
    revision: (storedRevision ?? 0) + 1,
    document,
    updatedBy: userId,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  table.set(key, stored);
  return { ok: true as const, stored, created: true };
}

export const memoryStore: ConfigStore = {
  async readProject(projectId) {
    return mem.project.get(projectId) ?? null;
  },
  async listProjectRevisions(projectId) {
    return [...(mem.revisions.get(projectId) ?? [])].reverse();
  },
  async casProject(input) {
    const result = cas(mem.project, input.projectId, input);
    if (result.ok) {
      const list = mem.revisions.get(input.projectId) ?? [];
      list.push({
        revision: result.stored.revision,
        document: result.stored.document,
        writtenBy: input.userId,
        writtenAt: result.stored.updatedAt,
      });
      mem.revisions.set(input.projectId, list);
    }
    return result;
  },
  async readPolicy(projectId) {
    return mem.policy.get(projectId) ?? null;
  },
  async casPolicy(input) {
    return cas(mem.policy, input.projectId, input);
  },
  async listTestingProfiles(projectId) {
    const out: StoredProfile[] = [];
    for (const [key, row] of mem.profiles) {
      const [pid, profileId] = key.split('|');
      if (pid === projectId && profileId) out.push({ ...row, profileId });
    }
    return out;
  },
  async readTestingProfile(projectId, profileId) {
    return mem.profiles.get(`${projectId}|${profileId}`) ?? null;
  },
  async casTestingProfile(input) {
    return cas(mem.profiles, `${input.projectId}|${input.profileId}`, input);
  },
  async deleteTestingProfile(projectId, profileId) {
    return mem.profiles.delete(`${projectId}|${profileId}`);
  },
  async listActiveBindings() {
    return mem.bindings;
  },
  async slugTakenBy(_projectId, slug) {
    return slug === 'taken-slug' ? OTHER_PROJECT : null;
  },
  async listSecretNames(projectId) {
    const out: SecretName[] = [];
    for (const [key, s] of mem.secrets) {
      if (key.startsWith(`${projectId}|`)) {
        out.push({ scope: s.scope, name: s.name, updatedAt: s.updatedAt });
      }
    }
    return out;
  },
  async existingSecretRefs(projectId, refs) {
    return new Set(
      refs.filter((ref) => {
        const [, scope, name] = /^secret:\/\/([^/]+)\/(.+)$/.exec(ref) ?? [];
        return mem.secrets.has(`${projectId}|${scope}|${name}`);
      }),
    );
  },
  async putSecret({ projectId, scope, name, valueEnc }) {
    const row = { scope, name, valueEnc, updatedAt: new Date('2026-10-01T00:00:00Z') };
    mem.secrets.set(`${projectId}|${scope}|${name}`, row);
    return { scope, name, updatedAt: row.updatedAt };
  },
  async readSecret(projectId, scope, name) {
    return mem.secrets.get(`${projectId}|${scope}|${name}`)?.valueEnc ?? null;
  },
  async deviceCheckout(projectId, deviceId) {
    return mem.checkouts.find((c) => c.projectId === projectId && c.deviceId === deviceId) ?? null;
  },
};
