import type { GateId } from '@forge/contracts/gate-profiles';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { readGateModes } from '../../src/project-config/gates.js';
import { type ProjectDocument, projectDocumentSchema } from '../../src/project-config/schema.js';
import { rows } from './factories.js';
import { seedProjectDocument } from './release-world.js';

/**
 * Controls a project declares in its document (REQ-79 r6: off unless declared): `gates` replaces
 * the gates block (profile standard unless named), `delivery` is merged in. Seeds a bare document where the project has none, and
 * a later `seedProjectDocument` keeps both.
 */
export async function declareControls(
  projectId: string,
  updatedBy: string,
  controls: {
    gates?: Partial<NonNullable<ProjectDocument['gates']>>;
    delivery?: ProjectDocument['delivery'];
  },
): Promise<void> {
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  // no source: a project that had no document keeps reading as hosting nothing
  if (!held) {
    await seedProjectDocument(projectId, updatedBy, { environments: {}, source: { type: 'none' } });
  }
  const [current] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  if (!current)
    throw new Error(`declareControls: project ${projectId} holds no document after seeding`);
  const document = {
    ...current.document,
    ...(controls.gates ? { gates: { profile: 'standard', ...controls.gates } } : {}),
    ...(controls.delivery
      ? { delivery: { ...current.document.delivery, ...controls.delivery } }
      : {}),
  };
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = ${JSON.stringify(projectDocumentSchema.parse(document))}::jsonb,
           revision = revision + 1
     WHERE project_id = ${projectId}
  `);
}

/**
 * Declares whether the project requires a person's release approval (`release.approval.required`),
 * seeding a bare document where it has none: where it does, the one rule keeps a release approval a
 * person's (`who-owes.ts:whoOwes`, ISS-1058), and an issue's standing waits on it.
 */
export async function requireReleaseApproval(
  projectId: string,
  updatedBy: string,
  required = true,
): Promise<void> {
  await declareControls(projectId, updatedBy, {});
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = jsonb_set(document, '{release}',
                                coalesce(document->'release', '{}'::jsonb)
                                  || jsonb_build_object('approval', jsonb_build_object('required', ${required}::boolean))),
           revision = revision + 1
     WHERE project_id = ${projectId}
  `);
}

/**
 * Runs `body` with the project strict (REQ-79 BC-12), where a decision its asker marks serious is a
 * person's (BC-13), and gives the project back the gates it held before.
 */
export async function underStrict<T>(
  projectId: string,
  updatedBy: string,
  body: () => Promise<T>,
): Promise<T> {
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  const before = held?.document.gates;
  await declareControls(projectId, updatedBy, { gates: { profile: 'strict' } });
  try {
    return await body();
  } finally {
    await declareControls(projectId, updatedBy, { gates: before ?? { profile: 'standard' } });
  }
}

const gatesHeld = async (projectId: string): Promise<ProjectDocument['gates'] | undefined> => {
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  return held?.document.gates;
};

/**
 * Enforces `ids` over the gates the project holds now. REQ-79 r6 (BC-11, BC-12, BC-17) turned a
 * person's paper off or to advice under standard; a test of what one of those gates refuses
 * declares it, as a project asking for that control does.
 */
export async function enforceGates(
  projectId: string,
  updatedBy: string,
  ids: readonly GateId[],
): Promise<void> {
  const held = await gatesHeld(projectId);
  const overrides = { ...held?.overrides, ...Object.fromEntries(ids.map((id) => [id, 'enforce'])) };
  await declareControls(projectId, updatedBy, { gates: { ...held, overrides } });
}

/**
 * Strict's issue-ready checklist (an agreed requirement, criteria traced to it: REQ-79 r6 BC-12) with
 * every other gate as the project holds it now: the profile is strict, each other gate overridden
 * back to the mode it reads today, and `ids` enforced.
 */
export async function strictChecklist(
  projectId: string,
  updatedBy: string,
  ids: readonly GateId[] = [],
): Promise<void> {
  const modes = Object.values(await readGateModes(projectId));
  const overrides = Object.fromEntries(
    modes
      .filter((g) => g.id !== 'issue_ready')
      .map((g) => [g.id, ids.includes(g.id) ? 'enforce' : g.mode]),
  );
  await declareControls(projectId, updatedBy, { gates: { profile: 'strict', overrides } });
}
