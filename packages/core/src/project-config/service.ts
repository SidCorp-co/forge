import { parseSecretRef, secretRefOf } from '@forge/contracts/project-config';
import { parseVariableRef } from '@forge/contracts/variables';
import type { z } from 'zod';
import type { Tx } from '../db/client.js';
import { memoizedRead } from '../db/read-memo.js';
import { VARIABLE_SECRET_SCOPE } from '../db/schema-project-variables.js';
import {
  encryptSecret,
  getAdapter,
  isVaultConfigured,
  providerCanDeploy,
} from '../integrations/index.js';
import {
  type ApiRefusal,
  isRecord,
  parseVersionedDocument,
  pointer,
  staleBase,
} from './documents.js';
import {
  type PolicyDocument,
  policyDocumentSchema,
  type TestingProfile,
  testingProfileSchema,
} from './policy-schema.js';
import { projectConfigPorts } from './ports.js';
import { checkPolicy, checkProjectConfig, type ProjectConfigContext } from './rules.js';
import { type ProjectDocument, projectDocumentSchema } from './schema.js';
import {
  type CasResult,
  drizzleConfigStore,
  type SecretName,
  type StoredDocument,
} from './store.js';
import { keysHeld } from './variables-store.js';

export interface Held<T> {
  revision: number;
  document: T;
  /** Null only on a project document revision Forge wrote itself (REQ-76 BC-13). */
  updatedBy: string | null;
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
  return toHeld(stored, parsed.data);
}

function toHeld<T>(stored: StoredDocument, document: T): Held<T> {
  return {
    revision: stored.revision,
    document,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}

async function writeDocument<T>(input: {
  current: StoredDocument | null;
  baseRevision: number | null;
  raw: unknown;
  schema: z.ZodType<T>;
  what: string;
  before?: ApiRefusal[];
  check(document: T): Promise<ApiRefusal[]> | ApiRefusal[];
  cas(document: T): Promise<CasResult>;
}): Promise<WriteOutcome<T>> {
  const { baseRevision } = input;
  const storedRevision = input.current?.revision ?? null;
  if (storedRevision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
  }
  const before = input.before ?? [];
  const parsed = parseVersionedDocument(input.schema, input.raw, input.what);
  if (!parsed.ok) return { ok: false, refusals: [...before, ...parsed.refusals] };
  if (before.length > 0) return { ok: false, refusals: before };
  const document = parsed.value;
  const refusals = await input.check(document);
  if (refusals.length > 0) return { ok: false, refusals };
  const result = await input.cas(document);
  if (!result.ok) {
    const refusal =
      'refusal' in result ? result.refusal : staleBase(baseRevision, result.storedRevision);
    return { ok: false, refusals: [refusal] };
  }
  return { ok: true, held: toHeld(result.stored, document), created: result.created };
}

export async function readProjectDocument(
  projectId: string,
): Promise<{ revision: number; document: ProjectDocument } | null> {
  const held = await readProjectConfig(projectId);
  return held ? { revision: held.revision, document: held.document } : null;
}

export function readProjectConfig(projectId: string): Promise<Held<ProjectDocument> | null> {
  return memoizedRead(`projectConfig:${projectId}`, async () => {
    const stored = await drizzleConfigStore.readProject(projectId);
    return stored
      ? reread(projectDocumentSchema, stored, `project document of ${projectId}`)
      : null;
  });
}

export function readPolicy(projectId: string): Promise<Held<PolicyDocument> | null> {
  return memoizedRead(`projectPolicy:${projectId}`, async () => {
    const stored = await drizzleConfigStore.readPolicy(projectId);
    return stored ? reread(policyDocumentSchema, stored, `policy of ${projectId}`) : null;
  });
}

export async function readTestingProfile(
  projectId: string,
  profileId: string,
): Promise<Held<TestingProfile> | null> {
  const stored = await drizzleConfigStore.readTestingProfile(projectId, profileId);
  return stored
    ? reread(testingProfileSchema, stored, `testing profile ${profileId} of ${projectId}`)
    : null;
}

export async function listTestingProfiles(
  projectId: string,
): Promise<(Held<TestingProfile> & { profileId: string })[]> {
  const rows = await drizzleConfigStore.listTestingProfiles(projectId);
  return rows.map((row) => ({
    profileId: row.profileId,
    ...reread<TestingProfile>(
      testingProfileSchema,
      row,
      `testing profile ${row.profileId} of ${projectId}`,
    ),
  }));
}

async function buildProjectConfigContext(projectId: string): Promise<ProjectConfigContext> {
  const [bindings, profiles, policy, templatesInUse] = await Promise.all([
    drizzleConfigStore.listActiveBindings(projectId),
    drizzleConfigStore.listTestingProfiles(projectId),
    readPolicy(projectId),
    drizzleConfigStore.workflowTemplatesInUse(projectId),
  ]);
  return {
    bindings: new Map(
      bindings.map((b) => [
        b.id,
        {
          role: b.role,
          provider: b.provider,
          canDeploy: providerCanDeploy(b.provider),
          readsHistory: getAdapter(b.provider)?.deploymentRecords !== undefined,
        },
      ]),
    ),
    testingProfileIds: new Set(profiles.map((p) => p.profileId)),
    workflowTemplatesInUse: templatesInUse,
    ...(policy ? { policy: policy.document } : {}),
  };
}

/** The project document's own door: every key but `gates`, which only its door changes. */
export function writeProjectConfig(input: {
  projectId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WriteOutcome<ProjectDocument>> {
  return writeProjectDocument(input);
}

const gatesJson = (doc: unknown): string =>
  JSON.stringify(isRecord(doc) && doc.gates !== undefined ? doc.gates : null);

/**
 * A project document write. Only the gates door (`gates.ts:writeGates`) passes `gates`, whose `also`
 * records the change in the write's transaction; any other write that changes `gates` is refused
 * GATES_WRITTEN_THROUGH_THEIR_DOOR, so no change to a project's gates goes unrecorded (REQ-76 BC-12).
 */
export async function writeProjectDocument(input: {
  projectId: string;
  /** Null is Forge itself. */
  userId: string | null;
  baseRevision: number | null;
  raw: unknown;
  gates?: { also: (tx: Tx, stored: StoredDocument) => Promise<void> };
}): Promise<WriteOutcome<ProjectDocument>> {
  const { projectId, userId, baseRevision, raw } = input;
  const claimedId = isRecord(raw) && isRecord(raw.project) ? raw.project.id : undefined;
  const current = await drizzleConfigStore.readProject(projectId);
  return writeDocument({
    current,
    baseRevision,
    raw,
    schema: projectDocumentSchema,
    what: 'project',
    before:
      typeof claimedId === 'string' && claimedId !== projectId
        ? [
            {
              code: 'PROJECT_ID_IMMUTABLE',
              path: '/project/id',
              detail: `project.id "${claimedId}" is not this project; the document at /api/projects/${projectId}/config names ${projectId}, which core assigned and never changes.`,
            },
          ]
        : [],
    async check(document) {
      const refusals: ApiRefusal[] = [];
      const unaddressable = projectConfigPorts().unaddressableSlug(document.project.slug);
      if (unaddressable) {
        refusals.push({
          code: 'PROJECT_SLUG_RESERVED',
          path: '/project/slug',
          detail: `slug "${document.project.slug}" is reserved: ${unaddressable}; pick another.`,
        });
      }
      const takenBy = await drizzleConfigStore.slugTakenBy(projectId, document.project.slug);
      if (takenBy) {
        refusals.push({
          code: 'SLUG_TAKEN',
          path: '/project/slug',
          detail: `slug "${document.project.slug}" is already project ${takenBy}'s; a slug is unique across the deployment.`,
        });
      }
      if (!input.gates && gatesJson(document) !== gatesJson(current?.document)) {
        refusals.push({
          code: 'GATES_WRITTEN_THROUGH_THEIR_DOOR',
          path: '/gates',
          detail: `this write changes the project's gates, which only PUT /api/projects/${projectId}/gates changes, with a reason, so the change is recorded with who made it and why; send /gates as it stands (${gatesJson(current?.document)}) and change it there.`,
        });
      }
      refusals.push(...checkProjectConfig(document, await buildProjectConfigContext(projectId)));
      return refusals;
    },
    cas: (document) =>
      drizzleConfigStore.casProject({
        projectId,
        baseRevision,
        document,
        userId,
        ...(input.gates ? { also: input.gates.also } : {}),
      }),
  });
}

export async function writePolicy(input: {
  projectId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WriteOutcome<PolicyDocument>> {
  const { projectId, userId, baseRevision, raw } = input;
  return writeDocument({
    current: await drizzleConfigStore.readPolicy(projectId),
    baseRevision,
    raw,
    schema: policyDocumentSchema,
    what: 'policy',
    check: checkPolicy,
    cas: (document) => drizzleConfigStore.casPolicy({ projectId, baseRevision, document, userId }),
  });
}

export function credentialRefs(profile: TestingProfile): { path: string; ref: string }[] {
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
  return writeDocument({
    current: await drizzleConfigStore.readTestingProfile(projectId, profileId),
    baseRevision,
    raw,
    schema: testingProfileSchema,
    what: 'testing profile',
    async check(profile) {
      const refusals: ApiRefusal[] = [];
      if (profile.id !== profileId) {
        refusals.push({
          code: 'TESTING_PROFILE_ID_MISMATCH',
          path: '/id',
          detail: `id "${profile.id}" is not the profile this URL writes ("${profileId}"); the document is stored under its URL id.`,
        });
      }
      const refs = credentialRefs(profile);
      const present = await drizzleConfigStore.secretValues(
        projectId,
        refs.map((r) => r.ref),
      );
      const variables = await keysHeld(
        projectId,
        refs.flatMap((r) => parseVariableRef(r.ref) ?? []),
      );
      for (const { path, ref } of refs) {
        const key = parseVariableRef(ref);
        if (key !== null) {
          if (!variables.has(key)) {
            refusals.push({
              code: 'VARIABLE_REF_UNKNOWN',
              path,
              detail: `${ref} names no variable of this project; add ${key} with POST /api/projects/${projectId}/variables first.`,
            });
          }
          continue;
        }
        if (parseSecretRef(ref)?.scope === VARIABLE_SECRET_SCOPE) {
          refusals.push({
            code: 'SECRET_SCOPE_RESERVED',
            path,
            detail: `${ref} is under \`${VARIABLE_SECRET_SCOPE}\`, the store of the project's variables, reached only by a variable's own key: name it var://<KEY>.`,
          });
          continue;
        }
        if (!present.has(ref)) {
          refusals.push({
            code: 'SECRET_NOT_FOUND',
            path,
            detail: `${ref} is not a secret of this project; PUT /api/projects/${projectId}/secrets/<scope>/<name> first.`,
          });
        }
      }
      return refusals;
    },
    cas: (document) =>
      drizzleConfigStore.casTestingProfile({
        projectId,
        profileId,
        baseRevision,
        document,
        userId,
      }),
  });
}

type DeleteOutcome =
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
  const deleted = await drizzleConfigStore.deleteTestingProfile(projectId, profileId);
  return deleted ? { ok: true } : { ok: false, notFound: true };
}

export const SECRET_VALUE_MAX = 16_384;

type SecretOutcome =
  | { ok: true; secret: SecretName & { ref: string } }
  | { ok: false; code: 'VAULT_NOT_CONFIGURED' };

export async function putSecret(input: {
  projectId: string;
  scope: string;
  name: string;
  value: string;
}): Promise<SecretOutcome> {
  if (!isVaultConfigured()) return { ok: false, code: 'VAULT_NOT_CONFIGURED' };
  const row = await drizzleConfigStore.putSecret({
    projectId: input.projectId,
    scope: input.scope,
    name: input.name,
    valueEnc: encryptSecret(input.value),
  });
  return { ok: true, secret: { ...row, ref: secretRefOf(row.scope, row.name) } };
}

export async function listSecretNames(projectId: string) {
  const rows = await drizzleConfigStore.listSecretNames(projectId);
  // the variables' values are listed as variables (REQ-80), never as secrets of their own
  return rows
    .filter((r) => r.scope !== VARIABLE_SECRET_SCOPE)
    .map((r) => ({ ...r, ref: secretRefOf(r.scope, r.name) }));
}
