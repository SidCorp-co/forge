import { encryptSecret, isVaultConfigured } from '../integrations/vault.js';
import {
  type ApiRefusal,
  isRecord,
  parseVersionedDocument,
  pointer,
  secretRefOf,
  staleBase,
} from './documents.js';
import { checkPolicy, checkProjectConfig, type ProjectConfigContext } from './rules.js';
import {
  type PolicyDocument,
  type ProjectDocument,
  policyDocumentSchema,
  projectDocumentSchema,
  type TestingProfile,
  testingProfileSchema,
} from './schema.js';
import {
  type ConfigStore,
  drizzleConfigStore,
  type SecretName,
  type StoredDocument,
} from './store.js';

const store: ConfigStore = drizzleConfigStore;

export interface Held<T> {
  revision: number;
  document: T;
  updatedBy: string;
  updatedAt: Date;
}

export type WriteOutcome<T> =
  | { ok: true; held: Held<T>; created: boolean }
  | { ok: false; refusals: ApiRefusal[] };

function reread<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  stored: StoredDocument,
  what: string,
): Held<T> {
  const parsed = schema.safeParse(stored.document);
  if (!parsed.success) {
    throw new Error(
      `project-config: the stored ${what} at revision ${stored.revision} no longer parses as version 1; the store holds a shape this core cannot read and it is not guessed at.`,
    );
  }
  return {
    revision: stored.revision,
    document: parsed.data,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}

export async function readProjectDocument(
  projectId: string,
): Promise<{ revision: number; document: ProjectDocument } | null> {
  const held = await readProjectConfig(projectId);
  return held ? { revision: held.revision, document: held.document } : null;
}

export async function readProjectConfig(projectId: string): Promise<Held<ProjectDocument> | null> {
  const stored = await store.readProject(projectId);
  return stored ? reread(projectDocumentSchema, stored, `project document of ${projectId}`) : null;
}

export async function readProjectRevisions(projectId: string) {
  return store.listProjectRevisions(projectId);
}

export async function readPolicy(projectId: string): Promise<Held<PolicyDocument> | null> {
  const stored = await store.readPolicy(projectId);
  return stored ? reread(policyDocumentSchema, stored, `policy of ${projectId}`) : null;
}

export async function readTestingProfile(
  projectId: string,
  profileId: string,
): Promise<Held<TestingProfile> | null> {
  const stored = await store.readTestingProfile(projectId, profileId);
  return stored
    ? reread(testingProfileSchema, stored, `testing profile ${profileId} of ${projectId}`)
    : null;
}

export async function listTestingProfiles(
  projectId: string,
): Promise<(Held<TestingProfile> & { profileId: string })[]> {
  const rows = await store.listTestingProfiles(projectId);
  return rows.map((row) => ({
    profileId: row.profileId,
    ...reread<TestingProfile>(
      testingProfileSchema,
      row,
      `testing profile ${row.profileId} of ${projectId}`,
    ),
  }));
}

export async function buildProjectConfigContext(projectId: string): Promise<ProjectConfigContext> {
  const [bindings, profiles, policy] = await Promise.all([
    store.listActiveBindings(projectId),
    store.listTestingProfiles(projectId),
    readPolicy(projectId),
  ]);
  return {
    bindings: new Map(bindings.map((b) => [b.id, { role: b.role }])),
    testingProfileIds: new Set(profiles.map((p) => p.profileId)),
    ...(policy ? { policy: policy.document } : {}),
  };
}

function toHeld<T>(stored: StoredDocument, document: T): Held<T> {
  return {
    revision: stored.revision,
    document,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}

export async function writeProjectConfig(input: {
  projectId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WriteOutcome<ProjectDocument>> {
  const { projectId, userId, baseRevision, raw } = input;
  const current = await store.readProject(projectId);
  const storedRevision = current?.revision ?? null;
  if (storedRevision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
  }

  const refusals: ApiRefusal[] = [];
  const claimedId = isRecord(raw) && isRecord(raw.project) ? raw.project.id : undefined;
  if (typeof claimedId === 'string' && claimedId !== projectId) {
    refusals.push({
      code: 'PROJECT_ID_IMMUTABLE',
      path: '/project/id',
      detail: `project.id "${claimedId}" is not this project; the document at /api/projects/${projectId}/config names ${projectId}, which core assigned and never changes.`,
    });
  }
  const parsed = parseVersionedDocument(projectDocumentSchema, raw, 'project');
  if (!parsed.ok) return { ok: false, refusals: [...refusals, ...parsed.refusals] };
  if (refusals.length > 0) return { ok: false, refusals };

  const document = parsed.value;
  const takenBy = await store.slugTakenBy(projectId, document.project.slug);
  if (takenBy) {
    refusals.push({
      code: 'SLUG_TAKEN',
      path: '/project/slug',
      detail: `slug "${document.project.slug}" is already project ${takenBy}'s; a slug is unique across the deployment.`,
    });
  }
  refusals.push(...checkProjectConfig(document, await buildProjectConfigContext(projectId)));
  if (refusals.length > 0) return { ok: false, refusals };

  const result = await store.casProject({ projectId, baseRevision, document, userId });
  if (!result.ok) return { ok: false, refusals: [staleBase(baseRevision, result.storedRevision)] };
  return { ok: true, held: toHeld(result.stored, document), created: result.created };
}

export async function writePolicy(input: {
  projectId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WriteOutcome<PolicyDocument>> {
  const { projectId, userId, baseRevision, raw } = input;
  const current = await store.readPolicy(projectId);
  const storedRevision = current?.revision ?? null;
  if (storedRevision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
  }
  const parsed = parseVersionedDocument(policyDocumentSchema, raw, 'policy');
  if (!parsed.ok) return parsed;
  const refusals = checkPolicy(parsed.value);
  if (refusals.length > 0) return { ok: false, refusals };

  const result = await store.casPolicy({ projectId, baseRevision, document: parsed.value, userId });
  if (!result.ok) return { ok: false, refusals: [staleBase(baseRevision, result.storedRevision)] };
  return { ok: true, held: toHeld(result.stored, parsed.value), created: result.created };
}

function credentialRefs(profile: TestingProfile): { path: string; ref: string }[] {
  return [
    ...Object.entries(profile.actors).map(([name, actor]) => ({
      path: pointer(['actors', name, 'credential']),
      ref: actor.credential,
    })),
    ...Object.entries(profile.services).map(([name, service]) => ({
      path: pointer(['services', name, 'credential']),
      ref: service.credential,
    })),
  ];
}

export async function writeTestingProfile(input: {
  projectId: string;
  profileId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WriteOutcome<TestingProfile>> {
  const { projectId, profileId, userId, baseRevision, raw } = input;
  const current = await store.readTestingProfile(projectId, profileId);
  const storedRevision = current?.revision ?? null;
  if (storedRevision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
  }
  const parsed = parseVersionedDocument(testingProfileSchema, raw, 'testing profile');
  if (!parsed.ok) return parsed;
  const profile = parsed.value;

  const refusals: ApiRefusal[] = [];
  if (profile.id !== profileId) {
    refusals.push({
      code: 'TESTING_PROFILE_ID_MISMATCH',
      path: '/id',
      detail: `id "${profile.id}" is not the profile this URL writes ("${profileId}"); the document is stored under its URL id.`,
    });
  }
  const refs = credentialRefs(profile);
  const present = await store.existingSecretRefs(
    projectId,
    refs.map((r) => r.ref),
  );
  for (const { path, ref } of refs) {
    if (!present.has(ref)) {
      refusals.push({
        code: 'SECRET_NOT_FOUND',
        path,
        detail: `${ref} is not a secret of this project; PUT /api/projects/${projectId}/secrets/<scope>/<name> first.`,
      });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const result = await store.casTestingProfile({
    projectId,
    profileId,
    baseRevision,
    document: profile,
    userId,
  });
  if (!result.ok) return { ok: false, refusals: [staleBase(baseRevision, result.storedRevision)] };
  return { ok: true, held: toHeld(result.stored, profile), created: result.created };
}

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; refusals: ApiRefusal[] };

export async function deleteTestingProfile(
  projectId: string,
  profileId: string,
): Promise<DeleteOutcome> {
  const project = await readProjectConfig(projectId);
  const users = Object.entries(project?.document.environments ?? {}).filter(
    ([, env]) => env.testing === profileId,
  );
  if (users.length > 0) {
    return {
      ok: false,
      notFound: false,
      refusals: users.map(([name]) => ({
        code: 'TESTING_PROFILE_IN_USE',
        path: pointer(['environments', name, 'testing']),
        detail: `environment "${name}" names testing profile "${profileId}"; change the project document first, then delete it.`,
      })),
    };
  }
  const deleted = await store.deleteTestingProfile(projectId, profileId);
  return deleted ? { ok: true } : { ok: false, notFound: true };
}

export const SECRET_VALUE_MAX = 16_384;

export type SecretOutcome =
  | { ok: true; secret: SecretName & { ref: string } }
  | { ok: false; code: 'VAULT_NOT_CONFIGURED' };

export async function putSecret(input: {
  projectId: string;
  scope: string;
  name: string;
  value: string;
}): Promise<SecretOutcome> {
  if (!isVaultConfigured()) return { ok: false, code: 'VAULT_NOT_CONFIGURED' };
  const row = await store.putSecret({
    projectId: input.projectId,
    scope: input.scope,
    name: input.name,
    valueEnc: encryptSecret(input.value),
  });
  return { ok: true, secret: { ...row, ref: secretRefOf(row.scope, row.name) } };
}

export async function listSecretNames(projectId: string) {
  const rows = await store.listSecretNames(projectId);
  return rows.map((r) => ({ ...r, ref: secretRefOf(r.scope, r.name) }));
}

export async function readDeviceCheckout(projectId: string, deviceId: string) {
  return store.deviceCheckout(projectId, deviceId);
}

export async function listActiveBindings(projectId: string) {
  return store.listActiveBindings(projectId);
}
